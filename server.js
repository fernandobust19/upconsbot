require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const OpenAI = require('openai');

let morgan;
try {
  morgan = require('morgan');
} catch {
  console.warn('morgan no está instalado; los logs HTTP serán básicos.');
}

const app = express();
const port = process.env.PORT || 3000;
app.set('trust proxy', true);

app.use(express.static('public'));
app.use(express.json());
if (morgan) app.use(morgan('combined'));

// ------------------
// Cache de productos
// ------------------
const CACHE_TTL_MS = Number(process.env.PRODUCTS_CACHE_TTL_MS || 10 * 60 * 1000); // 10 minutos
let productsCache = { data: null, fetchedAt: 0 };

const isCacheFresh = () => productsCache.data && Date.now() - productsCache.fetchedAt < CACHE_TTL_MS;

async function fetchProductsAndCache() {
  const filePath = path.join(__dirname, 'productos_completos.json');
  const started = Date.now();
  try {
    const fileContent = await fs.readFile(filePath, 'utf-8');
    const jsonData = JSON.parse(fileContent);
    const data = Array.isArray(jsonData)
      ? jsonData.map((p) => ({ nombre: p.producto, precio: p.precio }))
      : [];

    productsCache = { data: data, fetchedAt: Date.now() };
    console.info(`Productos cargados desde archivo: ${data.length} ítems en ${Date.now() - started}ms.`);
    return productsCache.data;
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`❌ Error Crítico: El archivo de productos "${filePath}" no fue encontrado.`);
    } else {
      console.error(`❌ Error al leer o parsear "${filePath}":`, err.message);
    }
    productsCache = { data: [], fetchedAt: Date.now() }; // Cache vacío en caso de error
    return [];
  }
}

function refreshProductsInBackground() {
  fetchProductsAndCache().catch(() => {});
}

async function getProducts() {
  if (isCacheFresh()) return productsCache.data;
  if (productsCache.data) {
    refreshProductsInBackground();
    return productsCache.data;
  }
  try {
    return await fetchProductsAndCache();
  } catch {
    return [];
  }
}

// ------------------
// Memoria por usuario
// ------------------
const userProfiles = new Map(); // key -> { nombre, updatedAt }
const USER_TTL_MS = Number(process.env.USER_TTL_MS || 30 * 60 * 1000); // 30 minutos
function getUserKey(req) {
  return req.ip || 'anon';
}
function getUserProfile(req) {
  const key = getUserKey(req);
  const now = Date.now();
  const existing = userProfiles.get(key);
  if (existing && now - existing.updatedAt < USER_TTL_MS) return existing;
  const fresh = { nombre: null, proforma: [], updatedAt: now };
  userProfiles.set(key, fresh);
  return fresh;
}
function updateUserProfile(req, patch) {
  const key = getUserKey(req);
  const current = getUserProfile(req);
  const next = { ...current, ...patch, updatedAt: Date.now() };
  userProfiles.set(key, next);
  return next;
}

// ------------------
// Utilidades de búsqueda
// ------------------
const STOP_WORDS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'con', 'para', 'en', 'y', 'o', 'a']);

const normalize = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s.#\-]/g, ' ') // quita símbolos no deseados
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w)) // quita palabras comunes
    .join(' ');

const tokenize = (s) => normalize(s).split(/\s+/).filter(Boolean);
const toSingularish = (w) => (w.endsWith('es') ? w.slice(0, -2) : w.endsWith('s') ? w.slice(0, -1) : w);
function queryTokens(q) {
  const base = tokenize(q).map(toSingularish);
  return Array.from(new Set(base));
}
function productText(p) {
  const text = [p?.nombre, p?.categoria, p?.descripcion, p?.medida, p?.medidas, p?.marca, p?.precio].filter(Boolean).join(' ');
  // Expandir abreviaturas comunes para mejorar la búsqueda
  const expandedText = text
    .replace(/\bcua\b/gi, 'cuadrado')
    .replace(/\brectang\b/gi, 'rectangular')
    .replace(/\bneg\b/gi, 'negro')
    .replace(/\bgalv\b/gi, 'galvanizado');
  return normalize(expandedText);
}

// ------------------
// Rutas básicas
// ------------------
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  const age = productsCache.fetchedAt ? Date.now() - productsCache.fetchedAt : null;
  res.json({ status: 'ok', productsCached: productsCache.data?.length || 0, cacheAgeMs: age });
});

app.post('/admin/refresh-products', async (req, res) => {
  const auth = req.get('authorization') || '';
  const expected = process.env.ADMIN_TOKEN ? `Bearer ${process.env.ADMIN_TOKEN}` : null;
  if (!expected || auth !== expected) return res.status(401).json({ error: 'No autorizado' });
  try {
    const before = productsCache.data?.length || 0;
    await fetchProductsAndCache();
    const after = productsCache.data?.length || 0;
    res.json({ ok: true, before, after, fetchedAt: productsCache.fetchedAt });
  } catch (e) {
    res.status(502).json({ error: 'No se pudo refrescar', detalle: e?.message || String(e) });
  }
});

app.get('/proforma', (req, res) => {
  const profile = getUserProfile(req);
  if (!profile || profile.proforma.length === 0) {
    return res.status(404).send('<h1>No hay productos en la proforma.</h1>');
  }

  let total = 0;
  const itemsHtml = profile.proforma
    .map((item) => {
      const subtotal = (item.cantidad || 0) * (item.precio || 0);
      total += subtotal;
      return `<tr>
        <td>${item.cantidad}</td>
        <td>${item.nombre}</td>
        <td>$${item.precio.toFixed(2)}</td>
        <td>$${subtotal.toFixed(2)}</td>
      </tr>`;
    })
    .join('');

  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Proforma UPCONS</title><style>body{font-family:sans-serif;padding:2em}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background-color:#f2f2f2}tfoot{font-weight:bold}</style></head><body><h1>Proforma - UPCONS Importador</h1><p>Cliente: ${profile.nombre || 'N/A'}</p><table><thead><tr><th>Cantidad</th><th>Producto</th><th>P. Unitario</th><th>Subtotal</th></tr></thead><tbody>${itemsHtml}</tbody><tfoot><tr><td colspan="3">Total</td><td>$${total.toFixed(2)}</td></tr></tfoot></table></body></html>`;
  res.send(html);
});

// ------------------
// IA: extracción de nombre
// ------------------
async function validarYExtraerNombre(textoUsuario) {
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const prompt = `
        Tu tarea es analizar el siguiente texto y determinar si contiene un nombre de persona.
        Texto: "${textoUsuario}"
        Si el texto contiene un nombre, extráelo y devuélvelo. Por ejemplo, de "mi nombre es Juan", devuelve "Juan".
        Si el texto es solo un nombre, como "Ana", devuélvelo.
        Si el texto es una pregunta o una frase que claramente no es un nombre (como "cuánto cuestan las tejas" o "dónde están ubicados"), responde con "NULL".
        Responde únicamente con el nombre extraído o con la palabra "NULL".`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4-turbo',
      messages: [{ role: 'system', content: prompt }],
      temperature: 0.0,
      max_tokens: 8,
    });

    const respuesta = completion.choices?.[0]?.message?.content?.trim();
    if (!respuesta) return null;
    if (respuesta.toUpperCase() === 'NULL' || respuesta.length > 20) return null;
    return respuesta;
  } catch (error) {
    console.error('Error al validar nombre con IA:', error?.response?.status || '', error?.message || error);
    return null;
  }
}

// ------------------
// Chat principal
// ------------------
app.post('/chat', async (req, res) => {
  const userMessage = req.body?.message;
  if (!userMessage || typeof userMessage !== 'string') {
    return res.status(400).json({ error: 'El mensaje no puede estar vacío.' });
  }

  const isValidOpenAIKey = (key) => typeof key === 'string' && key.startsWith('sk-') && key.length > 25;
  const hasOpenAI = isValidOpenAIKey(process.env.OPENAI_API_KEY);

  const profile = getUserProfile(req);
  if (!profile.nombre) {
    if (/^(hola|buenos dias|buenos días|buenas tardes|buenas noches)/i.test(userMessage)) {
      return res.json({ reply: '¡Hola! Soy ConstructoBot. ¿Cuál es tu nombre?' });
    }
    if (hasOpenAI) {
      const nombreDetectado = await validarYExtraerNombre(userMessage);
      if (nombreDetectado) {
        updateUserProfile(req, { nombre: nombreDetectado });
        return res.json({ reply: `¡Hola ${nombreDetectado}! Un gusto. Puedo ayudarte a crear una proforma. ¿Qué materiales necesitas?` });
      }
    }
  }

  try {
    const products = await getProducts();
    let foundProducts = [];

    // Búsqueda mejorada por tokens en múltiples campos
    const tokens = queryTokens(userMessage);
    if (tokens.length >= 1 && products.length > 0) {
      foundProducts = products.filter((p) => {
        const haystack = productText(p);
        return tokens.some((t) => haystack.includes(t));
      });
    }

    // Usamos los productos encontrados en la búsqueda local o el catálogo completo si no hay coincidencias.
    const productsForContext = foundProducts.length > 0 ? foundProducts : products;
    const productsJson = JSON.stringify(productsForContext.slice(0, 50)); // Limitar para no exceder el contexto

    const nombreTexto = profile.nombre
      ? `Hablas con ${profile.nombre}, un cliente interesado en materiales de construcción.`
      : '';
    
    const proformaActualJson = JSON.stringify(profile.proforma);

    const systemPrompt = `
Eres ConstructoBot, un asistente técnico experto de UPCONS Importador, con conocimientos de arquitectura e ingeniería. Tu tono es profesional, preciso y orientado a soluciones. Responde siempre en español.
${nombreTexto}

Tu objetivo principal es ser un GESTOR DE PROFORMAS. Ayuda al cliente a construir una cotización. El cliente puede agregar productos, ver la proforma, o quitar ítems.

La proforma actual del cliente es: ${proformaActualJson}
 
Interpretación de Términos (para tu conocimiento interno):
- **Abreviaturas**: 'cua' = cuadrado, 'rectang' = rectangular, 'neg' = negro, 'galv' = galvanizado, 'm' = metros.
- **Calidad**: 'primera' es de alta calidad, 'segunda' o 'especial' son opciones más económicas.
- **Dimensiones de Tubos**: Un formato como "25x50x2mm" significa un tubo de 25mm (2.5 cm) por 50mm (5 cm) con un espesor de 2mm. Explícalo de forma sencilla si es necesario.
- **Dimensiones de Planchas**: Un formato como "1.22 X 2.44 / 0.40 ESPESOR" se refiere a una plancha de 1.22m por 2.44m con 0.40mm de espesor.

Instrucciones de respuesta:
- **Gestión de Proforma**:
  - Si el cliente pide agregar productos (ej: "5 tubos de 20x20"), actualiza la proforma. Si un producto ya existe, suma la nueva cantidad.
  - Si el cliente pide "ver mi proforma" o "cómo va la cuenta", muéstrale la tabla y el total.
  - Si pide "quitar las tejas", elimínalas de la proforma.
  - Si pide "empezar de nuevo" o "limpiar", vacía la proforma.
- **Formato de Tabla**: Cuando muestres la proforma o una lista de productos, SIEMPRE usa una tabla Markdown.
- **Ofrecer Enlace a Proforma**: Cuando la proforma tenga productos, finaliza tu respuesta ofreciendo un enlace para verla en una página separada: "Puedes ver tu proforma detallada aquí: /proforma".
- **Precisión y Búsqueda**: Basa TODAS tus respuestas sobre productos y precios estrictamente en el catálogo JSON. Si no encuentras un producto exacto, ofrece las alternativas más cercanas del catálogo.
- **Precisión ante todo**: Basa TODAS tus respuestas sobre productos y precios estrictamente en el catálogo JSON. No inventes productos, medidas, ni precios. Si un producto no está en la lista, indícalo claramente y ofrece la mejor alternativa técnica que sí tengas.
- **Preguntas Clave**: Si el cliente es ambiguo, haz 1 o 2 preguntas técnicas para aclarar (ej. "¿Para qué tipo de estructura necesita el tubo?" o "¿Busca un acabado brillante o mate para el anticorrosivo?").
- **Información de Contacto**: Ofrece los datos de contacto (WhatsApp, sucursales) solo cuando sea lógico, como para confirmar stock de grandes cantidades, coordinar una visita o si el cliente lo solicita explícitamente.

Contexto de UPCONS:
- Sucursal Sur Quito: Avenida Martín Santiago Icaza.
- Sucursal Sucre: Avenida Mariscal Sucre y Arturo Tipanguano.
- Teléfonos: 099 598 6366 / 0983 801 298.
- WhatsApp: +593 99 598 6366.
- Sitio web: www.conupcons.com
- Horario: Lunes a sábado de 8:00 a 18:00.

Catálogo JSON (para grounding, no lo repitas completo):
${productsJson}

RESPUESTA FINAL: Tu respuesta DEBE ser un objeto JSON con dos claves: "reply" (tu respuesta conversacional en texto para el cliente) y "proforma" (un array de objetos JSON con la lista de productos actualizada de la proforma, con los campos "nombre", "cantidad" y "precio"). Si no hay cambios en la proforma, devuelve el array original.
Ejemplo de formato de respuesta:
{
  "reply": "¡Claro! He añadido 10 tubos a tu proforma. El total actual es $64.00. ¿Necesitas algo más?",
  "proforma": [
    { "nombre": "TUBO CUA NEG PRIMERA 20X20 1.5MM", "cantidad": 10, "precio": 6.40 }
  ]
}`;

    const fallbackReply = () => {
      if (products.length > 0) {
        const sugerencias = products
          .slice(0, 10)
          .map((p) => `- ${p.nombre}: ${p.precio}`)
          .join('\n');
        return `Por ahora no puedo generar una respuesta avanzada, pero estas opciones están disponibles:\n\n${sugerencias}\n\n¿Te interesa alguno? Puedes indicarme medida, calibre o cantidad.`;
      }
      return 'No puedo acceder a la IA ni a la lista de productos por ahora. ¿Podrías decirme más detalles (producto, medida, cantidad, color)?';
    };

    if (!hasOpenAI) {
      console.warn('OPENAI_API_KEY ausente o inválida; devolviendo respaldo.');
      return res.json({ reply: fallbackReply() });
    }

    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const completion = await openai.chat.completions.create({
        model: 'gpt-4-turbo-2024-04-09',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.6,
        max_tokens: 800,
      });
      const botResponseRaw = completion.choices?.[0]?.message?.content;

      if (!botResponseRaw) {
        return res.json({ reply: fallbackReply() });
      }

      const botResponseJson = JSON.parse(botResponseRaw);
      const botResponse = botResponseJson.reply;
      const newProforma = botResponseJson.proforma;

      if (Array.isArray(newProforma)) {
        updateUserProfile(req, { proforma: newProforma });
      }

      return res.json({ reply: botResponse || fallbackReply() });
    } catch (oaErr) {
      console.error('Error al consultar OpenAI:', oaErr?.response?.status || '', oaErr?.message || oaErr);
      return res.json({ reply: fallbackReply() });
    }
  } catch (error) {
    console.error('Error no controlado en /chat:', error);
    return res.status(500).json({ error: 'Error interno del servidor. Revisa los logs para más detalles.' });
  }
});

app.listen(port, () => {
  console.log(`Servidor del bot escuchando en http://localhost:${port}`);
});
