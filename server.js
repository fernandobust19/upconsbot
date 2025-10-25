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
const normalize = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s.#\-]/g, ' ');
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

    // Búsqueda mejorada por tokens en múltiples campos
    const tokens = queryTokens(userMessage);
    if (tokens.length >= 1 && products.length > 0) {
      const foundProducts = products.filter((p) => {
        const haystack = productText(p);
        return tokens.every((t) => haystack.includes(t));
      });
      if (foundProducts.length > 0) {
        const top = foundProducts.slice(0, 12);
        let reply = `He encontrado ${foundProducts.length} productos que coinciden con tu búsqueda:\n\n`;
        top.forEach((product) => {
          reply += `- ${product.nombre}: ${product.precio}\n`;
        });
        if (foundProducts.length > top.length) {
          reply += `\n…y ${foundProducts.length - top.length} más. Puedes ser más específico (medida, calibre, material, marca).`;
        }
        return res.json({ reply });
      }
    }

    const productsJson = JSON.stringify(products);
    const nombreTexto = profile.nombre
      ? `Hablas con ${profile.nombre}, un cliente interesado en materiales de construcción.`
      : '';
    const systemPrompt = `
Eres ConstructoBot, el asistente oficial de ventas de UPCONS Importador. Responde en español, con tono profesional y cercano.
${nombreTexto}

Objetivo: ayudar al cliente a encontrar el producto adecuado (tejas españolas, tubos estructurales, plancha galvanizada, zinc, megatecho, anticorrosivos y otros materiales de construcción), usando la lista de productos provista más abajo.

Instrucciones de respuesta:
- Responde directo a la intención del cliente. Si pregunta precios o stock, indica lo disponible según la lista; si no está, ofrece alternativas parecidas.
- Si faltan datos clave (medida, calibre, espesor, color, cantidad, marca), pide 1–2 preguntas de aclaración, no más.
- No inventes productos ni precios. Si algo no está en la lista, dilo y sugiere opciones.
- Sé breve (3–6 líneas) y claro. Usa viñetas cuando enumeres opciones.
- Si corresponde, incluye contacto: WhatsApp +593 99 598 6366 y horarios (L-S 8:00–18:00).

Contexto de UPCONS:
- Sucursal Sur Quito: Avenida Martín Santiago Icaza.
- Sucursal Sucre: Avenida Mariscal Sucre y Arturo Tipanguano.
- Teléfonos: 099 598 6366 / 0983 801 298.
- WhatsApp: +593 99 598 6366.
- Sitio web: www.conupcons.com
- Horario: Lunes a sábado de 8:00 a 18:00.

Catálogo JSON (para grounding, no lo repitas completo):
${productsJson}

Recuerda nunca inventar datos y usar el nombre del cliente (${profile.nombre || 'cliente'}) si está disponible.`;

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

