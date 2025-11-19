const corsOptions = {
  origin: [
    'https://fernandobust19.github.io',
    'https://www.conupcons.com' // agrega cualquier otro dominio que necesites
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
};

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
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

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // responde las preflight
app.use(express.static('public'));
app.use(express.json());
if (morgan) app.use(morgan('combined'));

// ------------------
// Config empresa
// ------------------

const COMPANY = {
  name: process.env.COMPANY_NAME || 'UP-CONS',
  address: process.env.COMPANY_ADDRESS || 'Av. Principal 123, Ciudad, País',
  phone: process.env.COMPANY_PHONE || '+593999999999',
  website: process.env.COMPANY_WEBSITE || 'https://upcons.example.com',
  branches: (process.env.COMPANY_BRANCHES || 'Matriz - Ciudad|Sucursal Norte - Ciudad|Sucursal Sur - Ciudad').split('|'),
};
const COMPANY_TEL_LINK = 'tel:' + String(COMPANY.phone).replace(/[^+\d]/g, '');

// ------------------
// Imagenes de productos (map.json: [{ match: string|[string], image: url }])
// ------------------
let IMAGE_MAP = [];
try {
  IMAGE_MAP = require(path.join(__dirname, 'public', 'images', 'map.json'));
  if (!Array.isArray(IMAGE_MAP)) IMAGE_MAP = [];
} catch {
  IMAGE_MAP = [];
}
let IMAGES_INDEX = [];
function indexLocalImages() {
  try {
    const dir = path.join(__dirname, 'public', 'images');
    const files = fsSync.readdirSync(dir);
    IMAGES_INDEX = files
      .filter((f) => /\.(webp|jpg|jpeg|png|svg)$/i.test(f))
      .map((f) => ({ file: f, norm: normalize(f.replace(/\.[^.]+$/, '')) }));
  } catch {
    IMAGES_INDEX = [];
  }
}
indexLocalImages();
function getProductImageURL(name) {
  if (!name) return null;
  const n = normalize(name);
  for (const entry of IMAGE_MAP) {
    if (!entry) continue;
    const patterns = Array.isArray(entry.match) ? entry.match : [entry.match];
    for (const pat of patterns) {
      if (!pat) continue;
      const np = normalize(pat);
      if (np && n.includes(np)) {
        const raw = entry.image || null;
        if (raw && /^\/images\/[^.]+$/i.test(raw)) {
          // Resolver extensión automáticamente por stem
          const stem = raw.replace(/^\/images\//i, '');
          const stemNorm = normalize(stem);
          const found = IMAGES_INDEX.find((it) => it.norm === stemNorm || it.norm.includes(stemNorm) || stemNorm.includes(it.norm));
          if (found) return encodeURI(`/images/${found.file}`);
        }
        return raw ? encodeURI(raw) : null;
      }
    }
  }
  // Fallback: intentar adivinar por nombre de archivo local usando score simple
  try {
    const tokens = queryTokens(n);
    let best = null;
    let bestScore = 0;
    for (const it of IMAGES_INDEX) {
      let s = 0;
      for (const t of tokens) if (it.norm.includes(t)) s += 1;
      if (n.includes('teja') && it.norm.includes('teja')) s += 2; // boost de categoría
      if (s > bestScore) {
        best = it;
        bestScore = s;
      }
    }
    if (best && bestScore >= 2) return encodeURI(`/images/${best.file}`);
  } catch {}
  return null;
}

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
  const fresh = { nombre: null, proforma: [], history: [], updatedAt: now };
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

// Correcciones comunes de escritura y sinónimos básicos para mejorar búsqueda
const COMMON_CORRECTIONS = new Map([
  // Errores frecuentes
  ['autopoerforante', 'autoperforante'],
  ['autopoerforantes', 'autoperforante'],
  ['autoperforantes', 'autoperforante'], // normalizar a singular
  ['capuchón', 'capuchon'],
  ['española', 'espanola'],
]);

const SYNONYM_MAP = new Map([
  // tornillo(s) → autoperforante, perno (como categoría relacionada)
  ['tornillo', ['autoperforante', 'perno']],
  ['tornillos', ['autoperforante', 'perno']],
  // perno(s)
  ['perno', ['perno', 'autoperforante']],
  ['pernos', ['perno', 'autoperforante']],
  // teja española
  ['teja', ['teja']],
  ['espanola', ['espanola']],
  // capuchón
  ['capuchon', ['capuchon']]
]);

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
    .replace(/\bgalv\b/gi, 'galvanizado')
    .replace(/\bmts\b/gi, 'm') // Normalizar metros
    // Redondear medidas decimales para que coincidan con búsquedas de enteros (ej: 6.14m -> 6m)
    .replace(/(\d+)\.\d+\s*m/g, (match, number) => {
      return `${Math.round(parseFloat(match))}m`;
    });
  return normalize(expandedText);
}

function expandQueryTokens(rawQuery) {
  // 1) tokenizar y singularizar
  const base = queryTokens(rawQuery);
  const out = new Set();
  for (let tok of base) {
    // 2) correcciones comunes
    if (COMMON_CORRECTIONS.has(tok)) tok = COMMON_CORRECTIONS.get(tok);
    out.add(tok);
    // 3) sinónimos
    const syns = SYNONYM_MAP.get(tok);
    if (syns && syns.length) syns.forEach((s) => out.add(toSingularish(s)));
  }
  return Array.from(out);
}

// ------------------
// Utilidades de proforma y NLU local
// ------------------
function formatProformaMarkdown(items) {
  let total = 0;
  const rows = (items || []).map((it) => {
    const sub = (it.cantidad || 0) * (it.precio || 0);
    total += sub;
    const img = getProductImageURL(it.nombre);
    const nameCell = img
      ? `<img src="${img}" alt="" style="height:24px;width:auto;vertical-align:middle;margin-right:6px;"> ${it.nombre}`
      : it.nombre;
    return `| ${nameCell} | ${it.cantidad} | $${Number(it.precio || 0).toFixed(2)} | $${sub.toFixed(2)} |`;
  });
  const header = `| Nombre | Cantidad | Precio unitario | Subtotal |\n| --- | ---: | ---: | ---: |`;
  return { table: `${header}\n${rows.join('\n')}`, total };
}

function extractQuantityFromMessage(textRaw) {
  const text = String(textRaw).toLowerCase();
  // 1) número seguido de pista de cantidad
  const qtyHints = /\b(unidades|unds?|u\b|pzas?|piezas|pallets?|cajas?)\b/i;
  const m1 = Array.from(text.matchAll(/\b(\d{1,6})\s*(unidades|unds?|u\b|pzas?|piezas|pallets?|cajas?)\b/gi));
  if (m1.length) return parseInt(m1[m1.length - 1][1], 10);
  // 2) verbo de acción + número no seguido de mm/m/x
  const verb = /\b(agrega|añade|añadir|pon|poner|quiero|necesito|comprar|deme|dame|sumar)\b/i;
  const m2 = Array.from(text.matchAll(new RegExp(`${verb.source}[^\n\r\d]{0,20}?(\\d{1,6})(?!\s*(?:mm|m\b|x|×))`, 'gi')));
  if (m2.length) return parseInt(m2[m2.length - 1][1], 10);
  // 3) número + nombre de producto plural común (ej: 12 tejas, 5 tubos, 200 tornillos)
  const m3 = Array.from(text.matchAll(/\b(\d{1,6})\s*(tubos|tejas|tornillos|pernos|planchas|electrodos|autoperforantes|capuchones)\b/gi));
  if (m3.length) return parseInt(m3[m3.length - 1][1], 10);
  return null;
}

function parseOrderInfo(msg) {
  const text = String(msg).toLowerCase();
  // dimensions like 100 x 100, 100x100, 100 × 100
  const dimMatch = text.match(/(\d{2,4})\s*[x×]\s*(\d{2,4})/i);
  const dims = dimMatch ? [parseInt(dimMatch[1], 10), parseInt(dimMatch[2], 10)] : null;
  // thickness like 2 mm, 1.5mm, 2mm
  const thickMatch = text.match(/(\d+(?:\.\d+)?)\s*mm\b/i);
  const thicknessMm = thickMatch ? thickMatch[1].replace(/\.0+$/, '') : null;

  // quantity: SOLO si está explícita, no usar fallback por últimos números
  const quantity = extractQuantityFromMessage(text);
  return { dims, thicknessMm, quantity };
}

function findBestProductByMessage(message, products) {
  const tokens = expandQueryTokens(message);

  // Si el mensaje solo contiene intenciones, números o palabras de cantidad, no intentar adivinar.
  const meaningfulTokens = tokens.filter(token => {
    if (!isNaN(token)) return false; // No es un número
    if (['unidade', 'pieza', 'caja', 'pallet', 'metro'].includes(token)) return false; // No es palabra de cantidad/medida
    if (/^(agrega|añade|añadir|sumar|pon|poner|quiero|comprar|deme|dame|necesito)$/i.test(token)) return false; // No es un verbo de intención
    return true;
  });

  if (meaningfulTokens.length === 0) {
    return null;
  }
  const { dims, thicknessMm } = parseOrderInfo(message);
  if (!products?.length) return null;

  const expectedDim = dims ? `${dims[0]}x${dims[1]}` : null;
  const expectedThick = thicknessMm ? `${thicknessMm}mm` : null;

  let best = null;
  let bestScore = -Infinity;
  for (const p of products) {
    const hay = productText(p);
    let s = 0;
    // base token matches
    for (const t of tokens) if (hay.includes(t)) s += 1;
    // category boosts
    if (/\btubo\b/.test(hay)) s += 2;
    if (/\bcua\w*/.test(hay)) s += 1; // cuadrado/cua

    // dimension boost and gate
    if (expectedDim) {
      if (hay.includes(expectedDim)) s += 6; else s -= 4; // penalize if requested dim not present
    }
    // thickness boost and gate
    if (expectedThick) {
      if (hay.includes(expectedThick)) s += 4; else s -= 2;
    }

    // prefer primera over segunda when dims+thickness match ties
    if (/\bprimera\b/.test(hay)) s += 0.5;

    if (s > bestScore) {
      best = p;
      bestScore = s;
    }
  }
  return bestScore > 0 ? best : null;
}

// Clasificación y candidatos para tubos (cuadrado/rectangular/redondo)
function detectTubeTypeFromMessage(msg) {
  const t = normalize(msg);
  if (/\bcuadrad/.test(t) || /\bcua\b/.test(t)) return 'cuadrado';
  if (/\brectang/.test(t)) return 'rectangular';
  if (/\bredond?o?\b/.test(t) || /\bredon\b/.test(t)) return 'redondo';
  return null;
}
function inferTubeTypeFromDims(dims) {
  if (!dims) return null;
  return dims[0] === dims[1] ? 'cuadrado' : 'rectangular';
}
function extractThicknessFromName(name) {
  const m = String(name).match(/(\d+(?:\.\d+)?)mm/i);
  return m ? m[1] : null;
}
function qualityPreferenceFromMessage(msg) {
  const t = normalize(msg);
  if (/\bespecial\b/.test(t)) return 'especial';
  if (/\bsegunda\b/.test(t)) return 'segunda';
  if (/\bprimera\b/.test(t)) return 'primera';
  return null;
}
function filterTubeCandidates(products, dims, type) {
  const dimStr = dims ? `${dims[0]}x${dims[1]}` : null;
  return (products || []).filter((p) => {
    const h = productText(p);
    if (!/\btubo\b/.test(h)) return false;
    if (type === 'cuadrado' && !/\bcua\b/.test(h)) return false;
    if (type === 'rectangular' && !/\brectang\b/.test(h)) return false;
    if (type === 'redondo' && !/\bredon\b/.test(h)) return false;
    if (dimStr && !h.includes(dimStr)) return false;
    return true;
  });
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

  if (String(req.query.download || '') === '1') {
    res.setHeader('Content-Disposition', 'attachment; filename="Proforma-UPCONS.html"');
  }

  const styles = `body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:2em;color:#222}header{margin-bottom:1em}h1{margin:0 0 .25em}small, .muted{color:#666}table{width:100%;border-collapse:collapse;margin-top:1em}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background-color:#f7f7f7}tfoot{font-weight:bold}footer{margin-top:2em;font-size:.95em;border-top:1px solid #eee;padding-top:1em}ul{margin:.25em 0 .5em 1.25em}`;
  const branchesHtml = COMPANY.branches.map((b) => `<li>${b}</li>`).join('');
  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Proforma ${COMPANY.name}</title><meta name="viewport" content="width=device-width, initial-scale=1"/><style>${styles}</style></head><body>
  <header>
    <h1>Proforma - ${COMPANY.name}</h1>
    <div class="muted">Cliente: ${profile.nombre || 'N/A'}</div>
    <div class="muted">Fecha: ${new Date().toLocaleString()}</div>
    <div style="margin-top:.5em">
      <strong>Dirección:</strong> ${COMPANY.address} · 
      <strong>Teléfono:</strong> <a href="${COMPANY_TEL_LINK}">${COMPANY.phone}</a> · 
      <strong>Web:</strong> <a href="${COMPANY.website}" target="_blank">${COMPANY.website}</a>
    </div>
  </header>

  <table><thead><tr><th>Cantidad</th><th>Producto</th><th>P. Unitario</th><th>Subtotal</th></tr></thead><tbody>${itemsHtml}</tbody><tfoot><tr><td colspan="3">Total</td><td>$${total.toFixed(2)}</td></tr></tfoot></table>

  <div style="margin-top:1em">
    <a href="/proforma?download=1">Descargar HTML</a> · 
    <a href="/proforma.pdf">Descargar PDF</a> · 
    <a href="${COMPANY_TEL_LINK}">Llamar ahora</a>
  </div>

  <footer>
    <div><strong>Sucursales:</strong></div>
    <ul>${branchesHtml}</ul>
    <div class="muted">Gracias por su confianza.</div>
  </footer>
  </body></html>`;
  res.send(html);
});

// ------------------
// Proforma PDF
// ------------------
app.get('/proforma.pdf', (req, res) => {
  const profile = getUserProfile(req);
  if (!profile || profile.proforma.length === 0) {
    return res.status(404).send('No hay productos en la proforma.');
  }
  let PDFDocument;
  try {
    PDFDocument = require('pdfkit');
  } catch {
    // Fallback si no está instalada la dependencia
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res
      .status(501)
      .send('<h1>Generador PDF no disponible</h1><p>Instala la dependencia en el servidor: <code>npm install pdfkit</code>. Mientras tanto, puedes descargar la versión HTML desde <a href="/proforma?download=1">/proforma?download=1</a>.</p>');
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="Proforma-UPCONS.pdf"');

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(res);

  // Encabezado empresa
  doc.fontSize(18).text(`Proforma - ${COMPANY.name}`);
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#555').text(`Cliente: ${profile.nombre || 'N/A'}`);
  doc.text(`Fecha: ${new Date().toLocaleString()}`);
  doc.text(`Dirección: ${COMPANY.address}`);
  doc.text(`Teléfono: ${COMPANY.phone}`);
  doc.text(`Web: ${COMPANY.website}`);
  doc.moveDown(0.8);
  doc.fillColor('#000');

  // Tabla
  const tableTop = doc.y;
  const col = {
    qty: 40,
    name: 260,
    price: 80,
    sub: 80,
  };
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const x = doc.page.margins.left;
  const y = tableTop;

  function drawHeader() {
    doc.fontSize(11).text('Cantidad', x, doc.y, { width: col.qty });
    doc.text('Producto', x + col.qty + 8, doc.y, { width: col.name });
    doc.text('P. Unitario', x + col.qty + 8 + col.name + 8, doc.y, { width: col.price, align: 'right' });
    doc.text('Subtotal', x + col.qty + 8 + col.name + 8 + col.price + 8, doc.y, { width: col.sub, align: 'right' });
    doc.moveDown(0.5);
    doc.moveTo(x, doc.y).lineTo(x + pageWidth, doc.y).strokeColor('#ddd').stroke().strokeColor('#000');
  }
  function drawRow(item) {
    const startY = doc.y + 4;
    const subtotal = (item.cantidad || 0) * (item.precio || 0);
    doc.fontSize(10);
    doc.text(String(item.cantidad || 0), x, startY, { width: col.qty });
    doc.text(String(item.nombre || ''), x + col.qty + 8, startY, { width: col.name });
    doc.text(`$${Number(item.precio || 0).toFixed(2)}`, x + col.qty + 8 + col.name + 8, startY, { width: col.price, align: 'right' });
    doc.text(`$${subtotal.toFixed(2)}`, x + col.qty + 8 + col.name + 8 + col.price + 8, startY, { width: col.sub, align: 'right' });
    doc.moveDown(1.2);
  }

  drawHeader();
  let total = 0;
  for (const it of profile.proforma) {
    drawRow(it);
    total += (it.cantidad || 0) * (it.precio || 0);
  }

  doc.moveTo(x, doc.y).lineTo(x + pageWidth, doc.y).strokeColor('#ddd').stroke().strokeColor('#000');
  doc.moveDown(0.4);
  doc.fontSize(12).text(`Total: $${total.toFixed(2)}`, x + col.qty + 8 + col.name + 8 + col.price + 8, doc.y, { width: col.sub, align: 'right' });

  // Sucursales
  doc.moveDown(1);
  doc.fontSize(10).fillColor('#555').text('Sucursales:');
  COMPANY.branches.forEach((b) => doc.text(`• ${b}`));
  doc.fillColor('#000');

  doc.end();
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
  // Limitar el historial a los últimos 10 intercambios (user + bot) para no exceder el contexto
  const conversationHistory = profile.history?.slice(-10) || [];


  // --- Lógica de captura de nombre REESTRUCTURADA ---
  if (!profile.nombre) { // Solo se ejecuta si no conocemos el nombre del usuario.
    if (hasOpenAI) {
      const nombreDetectado = await validarYExtraerNombre(userMessage);
      if (nombreDetectado) {
        // Si la IA detecta un nombre, lo guardamos y saludamos.
        const reply = `¡Excelente, ${nombreDetectado}! Un gusto. Puedo ayudarte a crear una proforma. ¿Qué materiales necesitas?`;
        const newHistory = [...conversationHistory, { role: 'user', content: userMessage }, { role: 'assistant', content: reply }];
        updateUserProfile(req, { nombre: nombreDetectado, history: newHistory });
        return res.json({ reply: reply });
      }
    }
    // Si NO se detectó un nombre, verificamos si es un saludo simple para pedirlo.
    if (/^(hola|buenos dias|buenos días|buenas tardes|buenas noches)$/i.test(userMessage.trim())) {
      return res.json({ reply: '¡Hola! Soy un asesor de ventas con inteligencia artificial. Para darte una atención más personalizada, ¿cuál es tu nombre?' });
    }
    // Si no es un saludo simple y no hay nombre, la conversación continúa para que la IA maneje la consulta.
  }

  try {
    const products = await getProducts();
    let foundProducts = [];

    // Búsqueda mejorada con correcciones, sinónimos y scoring parcial
    const tokens = expandQueryTokens(userMessage);
    if (tokens.length >= 1 && products.length > 0) {
      const scored = products.map((p) => {
        const haystack = productText(p);
        let score = 0;
        for (const t of tokens) {
          if (haystack.includes(t)) score += 1;
        }
        return { p, score };
      });
      // Mantener solo coincidencias relevantes (score >= 1) y ordenar por score desc
      foundProducts = scored
        .filter((x) => x.score >= 1)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.p);
    }

    // Usamos los productos encontrados en la búsqueda local o el catálogo completo si no hay coincidencias.
    const productsForContext = foundProducts.length > 0 ? foundProducts : products;
    const productsJson = JSON.stringify(productsForContext.slice(0, 50)); // Limitar para no exceder el contexto

    const nombreTexto = profile.nombre
      ? `Hablas con ${profile.nombre}, un cliente interesado en materiales de construcción.`
      : '';
    
    const proformaActualJson = JSON.stringify(profile.proforma);

    const telLink = `${COMPANY_TEL_LINK}`;
    const systemPrompt = `
Eres un asesor de ventas con inteligencia artificial de UP-CONS, con conocimientos de arquitectura e ingeniería. Tu tono es profesional, preciso y muy amable. Responde siempre en español.
${nombreTexto}

Tu objetivo principal es ser un GESTOR DE PROFORMAS. Ayuda al cliente a construir una cotización. El cliente puede agregar productos, ver la proforma, o quitar ítems.

La proforma actual del cliente es: ${proformaActualJson}
 
Interpretación de Términos (para tu conocimiento interno):
- **Abreviaturas**: 'cua' = cuadrado, 'rectang' = rectangular, 'neg' = negro, 'galv' = galvanizado, 'm' = metros.
- **Calidad**: 'primera' es de alta calidad, 'segunda' o 'especial' son opciones más económicas.
- **Dimensiones de Tubos**: Un formato como "25x50x2mm" significa un tubo de 25mm (2.5 cm) por 50mm (5 cm) con un espesor de 2mm. Explícalo de forma sencilla si es necesario.
- **Dimensiones de Planchas**: Un formato como "1.22 X 2.44 / 0.40 ESPESOR" se refiere a una plancha de 1.22m por 2.44m con 0.40mm de espesor.
- **Tolerancia en Medidas**: Sé flexible. Si un cliente pide "teja de 6m", y en el catálogo tienes "Teja española 6.14 m.", asume que se refiere a esa. Sin embargo, si pide "teja de 3m", NO ofrezcas la de "3.70m" como si fuera la misma, sino como una alternativa cercana. Usa tu juicio para medidas similares.

Instrucciones de respuesta:
- **Mantener Contexto**: Si el cliente ya ha preguntado por un producto (ej: "tejas"), y luego proporciona más detalles (ej: "de 3 metros"), asume que los detalles son para el producto que se está discutiendo. No vuelvas a preguntar por el producto.
- **Proactividad**: Cuando un cliente pregunte por un producto (ej: "necesito tejas"), busca en el catálogo los productos que coincidan con la búsqueda. Si encuentras resultados, presenta las opciones al cliente en una tabla Markdown con nombre y precio. Si no encuentras resultados, pide más detalles de forma amigable.
- **Ejemplo con Tejas**: Si el cliente pregunta por "teja española", y en el catálogo tienes "Teja Española Fondo Naranja 3.70 M" y "Teja Española Fondo Terracota 6.14 M", tu respuesta debería ser algo como: "¡Claro! Tenemos estas opciones de teja española: | Producto | Precio | | --- | --- | | Teja Española Fondo Naranja 3.70 M | $10.00 | | Teja Española Fondo Terracota 6.14 M | $15.00 | ¿Cuál te gustaría agregar a tu proforma?".
- **Gestión de Proforma**:
  - Si el cliente pide agregar productos (ej: "5 tubos de 20x20"), actualiza la proforma. Si un producto ya existe, suma la nueva cantidad.
  - Si el cliente pide "ver mi proforma" o "cómo va la cuenta", muéstrale la tabla y el total.
  - Si pide "quitar las tejas", elimínalas de la proforma.
  - Si pide "empezar de nuevo" o "limpiar", vacía la proforma.
- **Tono y Formato**: Sé siempre amable y halaga al cliente (ej. "¡Excelente elección!"). Usa saltos de línea (\n) para separar párrafos y antes de mostrar una tabla para que la respuesta no se vea amontonada.
 - **Formato de Tabla**: Cuando muestres la proforma o una lista de productos, SIEMPRE usa una tabla Markdown.
 - **Ofrecer Enlace a Proforma**: Cuando la proforma tenga productos, finaliza tu respuesta ofreciendo:
   - Un enlace para verla en una página separada: "Puedes ver tu proforma detallada aquí: /proforma".
   - Un enlace de descarga en PDF: "Descarga tu proforma aquí: /proforma.pdf".
   - Un enlace de llamada directa para negociar la compra: "Puedes llamarnos aquí: ${telLink}".
 - **Cierre de Conversación**: Si el cliente indica que ya terminó, cierra con un resumen final, incluye ambos enlaces (ver y descargar proforma) y el enlace de llamada directa.

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
      const base = productsForContext.length > 0 ? productsForContext : products;
      if (base.length > 0) {
        const top = base.slice(0, 5);
        const lines = top
          .map((p) => {
            const img = getProductImageURL(p.nombre);
            const tag = img ? `<img src="${img}" alt="${p.nombre}" style="height:48px;width:auto;vertical-align:middle;margin-right:6px;border-radius:3px;">` : '';
            return `${tag}${p.nombre}: $${p.precio}`;
          })
          .join('\n');
        return `Por ahora no puedo generar una respuesta avanzada, pero estas opciones están disponibles:\n\n${lines}\n\n¿Te interesa alguno? Puedes indicarme medida, calibre o cantidad.\n\nPuedes ver tu proforma aquí: /proforma\nDescarga tu proforma aquí: /proforma.pdf\nLlámanos: ${COMPANY_TEL_LINK}`;
      }
      return `No puedo acceder a la IA ni a la lista de productos por ahora. ¿Podrías decirme más detalles (producto, medida, cantidad, color)?\n\nLlámanos: ${COMPANY_TEL_LINK}`;
    };

    // --- Intentos locales para no depender de IA ---
    const msg = userMessage.toLowerCase();
    const wantsView = /(\bver (mi )?proforma\b|\bc(?:o|ó)mo va la cuenta\b|\bmi proforma\b)/i.test(userMessage);
    const addIntent = /(agrega|añade|añadir|sumar|pon|poner|quiero|comprar|deme|dame|necesito)/i.test(userMessage);
    const removeIntent = /(quita|elimina|remueve|borra)/i.test(userMessage);
    const updateIntent = /(ajusta|cambia|actualiza|solo|deja)/i.test(userMessage);
    const order = parseOrderInfo(userMessage);
    const quantity = order.quantity;

    const ensureOfficialPrice = (name) => {
      const map = new Map(products.map((p) => [p.nombre, p.precio]));
      return map.get(name);
    };

    const renderAndReturn = (leadText) => {
      const { table, total } = formatProformaMarkdown(getUserProfile(req).proforma);
      const tailLinks = `\n\nPuedes ver tu proforma detallada aquí: /proforma\nDescarga tu proforma aquí: /proforma?download=1\nPuedes llamarnos aquí: ${COMPANY_TEL_LINK}`;
      return res.json({ reply: `${leadText}\n\n${table}\n\nTotal: $${total.toFixed(2)}${tailLinks}` });
    };

    if (wantsView) {
      if (!profile.proforma?.length) {
        return res.json({ reply: 'Aún no has agregado productos. ¿Qué deseas cotizar?' });
      }
      return renderAndReturn('Aquí tienes tu proforma actual:');
    }

    // Operaciones de agregar
    // if (addIntent && quantity) {
    //   const { dims, thicknessMm } = order;
    //   const requestedType = detectTubeTypeFromMessage(userMessage);
    //   const inferredType = inferTubeTypeFromDims(dims);
    //   const finalType = requestedType || inferredType;

    //   // Si se trata de tubos y hay ambigüedad en el tipo, preguntar
    //   const mentionsTube = /\btubo\b/i.test(userMessage) || requestedType || inferredType;
    //   if (mentionsTube && !finalType) {
    //     return res.json({ reply: '¿Qué tipo de tubo necesitas: cuadrado, rectangular o redondo?' });
    //   }

    //   // Si hay contradicción entre dimensiones y tipo pedido, confirmar
    //   if (requestedType && inferredType && requestedType !== inferredType) {
    //     return res.json({ reply: `Mencionas la medida ${dims[0]}x${dims[1]}, que suele ser ${inferredType}. ¿Confirmas que lo quieres ${requestedType} o mejor ${inferredType}?` });
    //   }

    //   // Intentar candidatos de tubo si aplica
    //   let best = null;
    //   if (mentionsTube && finalType) {
    //     let candidates = filterTubeCandidates(products, dims, finalType);

    //     if (candidates.length === 0 && dims) {
    //       // Si no hay coincidencia exacta, intentar invertir dims (por si catálogo usa otro orden) p.ej 50x100 vs 100x50
    //       const invCandidates = filterTubeCandidates(products, [dims[1], dims[0]], finalType);
    //       if (invCandidates.length > 0) candidates = invCandidates;
    //     }

    //     if (candidates.length > 0) {
    //       // Selección por espesor
    //       if (thicknessMm) {
    //         const tStr = `${thicknessMm}mm`;
    //         const byThick = candidates.filter((c) => productText(c).includes(tStr));
    //         if (byThick.length > 0) candidates = byThick;
    //       } else {
    //         // Si faltó espesor y hay múltiples opciones, preguntar opciones
    //         const options = Array.from(new Set(candidates.map((c) => extractThicknessFromName(c.nombre)).filter(Boolean)));
    //         if (options.length > 1) {
    //           return res.json({ reply: `¿Qué espesor prefieres para ${dims ? dims.join('x') : 'el tubo'} ${finalType}? Opciones: ${options.join(', ')}.` });
    //         }
    //       }

    //       // Preferir calidad solicitada o 'primera'
    //       const qPref = qualityPreferenceFromMessage(userMessage) || 'primera';
    //       const byQuality = candidates.filter((c) => new RegExp(`\\b${qPref}\\b`, 'i').test(c.nombre));
    //       if (byQuality.length > 0) candidates = byQuality;

    //       // Si quedan múltiples, usar mayor score por tokens generales
    //       best = candidates.reduce((acc, cur) => {
    //         const score = expandQueryTokens(userMessage).reduce((s, t) => s + (productText(cur).includes(t) ? 1 : 0), 0);
    //         return !acc || score > acc.score ? { item: cur, score } : acc;
    //       }, null)?.item;
    //     }
    //   }

    //   // Fallback a búsqueda general si no hubo candidato de tubos
    //   if (!best) best = findBestProductByMessage(userMessage, products);

    //   if (best) {
    //     const price = ensureOfficialPrice(best.nombre) ?? best.precio ?? 0;
    //     const current = getUserProfile(req).proforma || [];
    //     const idx = current.findIndex((it) => it.nombre === best.nombre);
    //     if (idx >= 0) current[idx].cantidad = Number(current[idx].cantidad || 0) + quantity;
    //     else current.push({ nombre: best.nombre, cantidad: quantity, precio: price });
    //     updateUserProfile(req, { proforma: current, history: [...conversationHistory, { role: 'user', content: userMessage }] });

    //     // Si es teja española, ofrecer ver la imagen antes/después de agregar
    //     let extraPreview = '';
    //     if (/\bteja\b/i.test(best.nombre)) {
    //       const imgUrl = getProductImageURL(best.nombre) || getProductImageURL('teja espanola');
    //       if (imgUrl) {
    //         extraPreview = `\n\nVista: <a href="${imgUrl}" target="_blank">Ver imagen</a>`;
    //       }
    //     }

    //     return renderAndReturn(`¡Excelente elección! He añadido ${quantity} de ${best.nombre} a tu proforma.${extraPreview}`);
    //   }
    // }

    // Operaciones de quitar (con cantidad específica)
    if (removeIntent) {
      const currentList = getUserProfile(req).proforma || [];
      if (!currentList.length) {
        return res.json({ reply: 'Tu proforma está vacía. ¿Qué deseas quitar?' });
      }

      const best = findBestProductByMessage(userMessage, products);
      // Si no podemos determinar el producto, pedir que lo aclare listando opciones
      if (!best) {
        const nombres = currentList.map((it) => `- ${it.nombre} (cant: ${it.cantidad})`).join('\n');
        return res.json({ reply: `No identifiqué el producto a quitar. Indícame el nombre exacto o la medida.\n\nActualmente en tu proforma:\n${nombres}` });
      }

      const name = typeof best === 'string' ? best : best.nombre;
      const removeQty = extractQuantityFromMessage(userMessage);
      if (!removeQty) {
        return res.json({ reply: `¿Cuántas unidades deseas quitar de ${name}?` });
      }

      const next = currentList.map((it) =>
        it.nombre === name ? { ...it, cantidad: Math.max(0, Number(it.cantidad || 0) - removeQty) } : it
      ).filter((it) => (it.cantidad || 0) > 0);

      updateUserProfile(req, { proforma: next, history: [...conversationHistory, { role: 'user', content: userMessage }] });
      return renderAndReturn(`He quitado ${removeQty} unidades de ${name}.`);
    }

    // Operaciones de actualizar cantidad
    if (updateIntent && quantity) {
      const best = findBestProductByMessage(userMessage, products) || profile.proforma?.[profile.proforma?.length - 1];
      if (best) {
        const name = typeof best === 'string' ? best : best.nombre;
        const current = (getUserProfile(req).proforma || []).map((it) => (it.nombre === name ? { ...it, cantidad: quantity } : it));
        updateUserProfile(req, { proforma: current, history: [...conversationHistory, { role: 'user', content: userMessage }] });
        return renderAndReturn(`He ajustado ${name} a ${quantity} unidades.`);
      }
    }

    if (!hasOpenAI) {
      console.warn('OPENAI_API_KEY ausente o inválida; devolviendo respaldo.');
      return res.json({ reply: fallbackReply() });
    }

    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const completion = await openai.chat.completions.create({
        model: 'gpt-4-turbo-2024-04-09',
        response_format: { type: 'json_object' },
        messages: [ // Construir el historial completo para la IA
          { role: 'system', content: systemPrompt },
          ...conversationHistory,
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
      let botResponse = botResponseJson.reply;
      let newProforma = botResponseJson.proforma;

      const userMessageNormalized = normalize(userMessage);
      if (userMessageNormalized.includes('teja') && userMessageNormalized.includes('espanola')) {
        const imageUrl = getProductImageURL(userMessage);
        if (imageUrl) {
          botResponse += `\n\nPuedes ver una imagen de referencia:<br><img src="${imageUrl}" alt="Imagen de Teja Española" style="width: 100%; max-width: 200px; height: auto; border-radius: 8px; margin-top: 8px;">`;
        }
      }

      const newHistory = [...conversationHistory, { role: 'user', content: userMessage }, { role: 'assistant', content: botResponse }];

      if (Array.isArray(newProforma)) {
        // --- VERIFICACIÓN DE PRECIOS ---
        // Nunca confiar en el precio que devuelve la IA. Siempre usar el del catálogo oficial.
        const productList = await getProducts();
        const productMap = new Map(productList.map(p => [p.nombre, p.precio]));

        const verifiedProforma = newProforma.map(item => {
          const officialPrice = productMap.get(item.nombre);
          if (officialPrice !== undefined) {
            // Si el producto existe, nos aseguramos de que el precio sea el correcto.
            return { ...item, precio: officialPrice };
          }
          return null; // Si la IA alucinó un producto que no existe, lo descartamos.
        }).filter(Boolean); // Limpiar los nulos

        updateUserProfile(req, { proforma: verifiedProforma, history: newHistory });
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
