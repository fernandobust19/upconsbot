require('dotenv').config();
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');

const app = express();
const port = 3000;

// Validar que las variables de entorno estén presentes
if (!process.env.OPENAI_API_KEY || !process.env.PRODUCTS_API_URL) {
    console.error("Error: Las variables de entorno OPENAI_API_KEY y PRODUCTS_API_URL son obligatorias.");
    console.log("Por favor, crea un archivo .env y añade tus claves. Mira .env.example para un ejemplo.");
    process.exit(1);
}

// Configurar cliente de OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

app.use(express.json());
app.use(express.static('public'));

// Consumir el endpoint de Google Apps Script
async function obtenerProductos() {
    try {
        const response = await axios.get(process.env.PRODUCTS_API_URL);
        console.log('URL usada:', process.env.PRODUCTS_API_URL);
        console.log('Productos recibidos:', response.data);
    } catch (error) {
        console.error('Error al consumir el endpoint:', error);
    }
}

// Llama a la función al iniciar el servidor
obtenerProductos();

// Función para normalizar texto (quita espacios, pasa a minúsculas, elimina puntos y unidades)
function normalizar(texto) {
    return texto
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[.,]/g, '')
        .replace(/metros|ms|m\b/g, 'm')
        .trim();
}

// Detecta ciudad en la consulta
function obtenerCiudad(texto) {
    const textoNorm = texto.toLowerCase();
    if (textoNorm.includes('quito')) return 'quito';
    // Puedes agregar más ciudades si lo necesitas
    return textoNorm.match(/desde ([a-záéíóúñ]+)/)?.[1] || null;
}

// Endpoint para el chat
app.post('/chat', async (req, res) => {
    const userMessage = req.body.message;

    if (!userMessage) {
        return res.status(400).json({ error: 'El mensaje no puede estar vacío.' });
    }

    try {
        // 1. Obtener productos desde tu Google Apps Script
        const response = await axios.get(process.env.PRODUCTS_API_URL);
        console.log('URL usada:', process.env.PRODUCTS_API_URL);
        console.log('Respuesta de Google Script:', response.data);
        const products = response.data;
        const productsJson = JSON.stringify(products);

        // **DEBUGGING: Log para ver los productos recibidos**
        console.log('Productos recibidos:', productsJson);

        // 2. Crear el prompt para OpenAI con el contexto de los productos
        const systemPrompt = `Eres 'ConstructoBot', un asistente de ventas para una ferretería. Tu misión es responder usando **exclusivamente** la lista de productos proporcionada.\n\n**REGLAS CRÍTICAS:**\n\n1. **NO INVENTES PRODUCTOS (REGLA DE ORO):** Tu conocimiento se limita **estrictamente** a la lista JSON de abajo. Nunca menciones un producto (como 'martillo') si no existe en esa lista. Inventar productos está prohibido.\n\n2. **SÉ FLEXIBLE AL BUSCAR, PERO ESTRICTO CON LA RESPUESTA:** Un cliente puede escribir el nombre de un producto de forma incompleta o aproximada (ej. 'teja de 6m'). Tu trabajo es buscar en la lista JSON el producto que **más se parezca**.\n   - Si encuentras uno o más productos que coinciden razonablemente (ej. el cliente pide 'teja de 6m' y tú encuentras 'Teja española 6.14 m.'), **considera que es una coincidencia** y presenta esos productos.\n   - Si no encuentras ninguna coincidencia razonable, **entonces y solo entonces**, debes responder: 'Lo siento, no tengo un producto que coincida con esa descripción en mi inventario. ¿Puedo ayudarte con algo más?\'\n\n3. **PREGUNTAR LA CIUDAD:** Antes de cotizar, siempre pregunta primero: '¿Desde qué ciudad nos escribe?\'.\n\n4. **PRECISIÓN DEL PRECIO:** Cuando respondas con un producto de la lista, asegúrate de dar el nombre completo y el precio exacto que aparece en la lista para evitar confusiones.\n\n**Lista de Productos (Inventario Exclusivo):**\n${productsJson}`;

        // 3. Llamar a la API de OpenAI
        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userMessage }
            ],
        });

        const botResponse = completion.choices[0].message.content;
        res.json({ reply: botResponse });

    } catch (error) {
        console.error('Error procesando el mensaje:', error);
        res.status(500).json({ error: 'Hubo un error al contactar al bot o al obtener los datos de los productos.' });
    }
});

// Endpoint para responder a los clientes con coincidencias flexibles
app.post('/consulta-producto', async (req, res) => {
    const consulta = req.body.consulta || '';
    const ciudad = obtenerCiudad(consulta);

    try {
        const response = await axios.get(process.env.PRODUCTS_API_URL);
        const productos = response.data;

        const consultaNorm = normalizar(consulta);

        const coincidencias = productos.filter(p => {
            const nombreNorm = normalizar(p.nombre || p.producto || '');
            return nombreNorm.includes(consultaNorm);
        });

        if (!ciudad) {
            res.json({ mensaje: '¿Desde qué ciudad nos escribe? Necesitamos saber tu ubicación para darte precios y opciones de envío.' });
            return;
        }

        if (ciudad === 'quito') {
            if (coincidencias.length > 0) {
                res.json({ resultados: coincidencias, mensaje: 'Estos son los precios para Quito. ¿Te gustaría cotizar o hacer un pedido?' });
            } else {
                res.json({ mensaje: 'Lo siento, no tengo un producto que coincida con esa descripción en mi inventario para Quito.' });
            }
        } else {
            res.json({ mensaje: `¡Gracias por tu interés! Actualmente solo enviamos productos a Quito. El envío fuera de Quito puede ser costoso o no disponible. ¿Quieres consultar precios para Quito o necesitas ayuda con otra ciudad?` });
        }
    } catch (error) {
        res.status(500).json({ error: 'No se pudieron obtener los productos.' });
    }
});

app.listen(port, () => {
    console.log(`Servidor del bot escuchando en http://localhost:${port}`);
});

// Google Apps Script code to be used in the Apps Script editor
function doGet() {
  try {
    // Cambia el ID por el de tu hoja real
    const hoja = SpreadsheetApp.openById("16L2f32IZ3zOACxJnA512tthrb7xBrhOS2MnNQws0mbZI").getSheetByName("Productos");
    if (!hoja) {
      Logger.log("No se encontró la hoja 'Productos'");
      return ContentService.createTextOutput(JSON.stringify({ error: "No se encontró la hoja 'Productos'" })).setMimeType(ContentService.MimeType.JSON);
    }
    const datos = hoja.getDataRange().getValues();
    Logger.log("Datos leídos de la hoja:", datos);

    // Validación: asegúrate que hay datos y que el formato es correcto
    if (datos.length < 2) {
      Logger.log("No hay productos en la hoja");
      return ContentService.createTextOutput(JSON.stringify([])).setMimeType(ContentService.MimeType.JSON);
    }

    // Convierte los datos en objetos
    const productos = datos.slice(1).map(fila => ({
      nombre: fila[0],
      precio: fila[1]
    }));

    Logger.log("Productos procesados:", productos);

    return ContentService.createTextOutput(JSON.stringify(productos)).setMimeType(ContentService.MimeType.JSON);
  } catch (e) {
    Logger.log("Error en doGet: " + e);
    return ContentService.createTextOutput(JSON.stringify({ error: e.toString() })).setMimeType(ContentService.MimeType.JSON);
  }
}
