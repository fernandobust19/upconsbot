require('dotenv').config();
const express = require('express');
const path = require('path');
const axios = require('axios');
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
  if (!process.env.PRODUCTS_API_URL) {
    console.warn('PRODUCTS_API_URL no está configurada.');
    productsCache = { data: [], fetchedAt: Date.now() };
    return productsCache.data;
  }
  const started = Date.now();
  try {
    const response = await axios.get(process.env.PRODUCTS_API_URL, { timeout: 15000 });
    const data = Array.isArray(response.data) ? response.data : [];
    productsCache = { data, fetchedAt: Date.now() };
    console.info(`Productos actualizados: ${data.length} ítems en ${Date.now() - started}ms.`);
    return data;
  } catch (err) {
    console.error('Error al actualizar productos:', err?.response?.status || '', err?.message || err);
    throw err;
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
  const fresh = { nombre: null, updatedAt: now };
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
  return normalize([p?.nombre, p?.categoria, p?.descripcion, p?.medida, p?.medidas, p?.marca].filter(Boolean).join(' '));
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
        return res.json({ reply: `¡Hola ${nombreDetectado}! Un gusto. ¿En qué puedo ayudarte hoy?` });
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
    const systemPrompt = `
Eres ConstructoBot, un asistente técnico experto de UPCONS Importador, con conocimientos de arquitectura e ingeniería. Tu tono es profesional, preciso y orientado a soluciones. Responde siempre en español.
${nombreTexto}

Objetivo: Asesorar al cliente para que encuentre la mejor solución técnica para su proyecto usando el catálogo de productos provisto. Tu meta es ser un recurso confiable, no solo un vendedor.

Instrucciones de respuesta:
- **Manejo de Consultas**: Si el cliente pide un producto con una especificación (medida, color) que no tienes, NO digas simplemente "no tenemos". En su lugar, busca el producto base en el catálogo y responde informando sobre las variantes que SÍ tienes. Ejemplo: "No disponemos de teja española de 6 metros, pero puedo ofrecerte teja española en medidas de 3.60m y 4.20m. ¿Alguna de estas se ajusta a tu proyecto?".
- **Precisión ante todo**: Basa TODAS tus respuestas sobre productos y precios estrictamente en el catálogo JSON. No inventes productos, medidas, ni precios. Si un producto no está en la lista, indícalo claramente y ofrece la mejor alternativa técnica que sí tengas.
- **Preguntas Clave**: Si el cliente es ambiguo, haz 1 o 2 preguntas técnicas para aclarar (ej. "¿Para qué tipo de estructura necesita el tubo?" o "¿Busca un acabado brillante o mate para el anticorrosivo?").
- **Brevedad y Claridad**: Sé conciso (3-6 líneas). Usa viñetas para listar productos o especificaciones, facilitando la lectura.
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

Recuerda, eres un experto. Usa el nombre del cliente (${profile.nombre || 'cliente'}) para personalizar la conversación.`;

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
        model: 'gpt-4-turbo',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.6,
        max_tokens: 400,
      });
      const botResponse = completion.choices?.[0]?.message?.content?.trim();
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
