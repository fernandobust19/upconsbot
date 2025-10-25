require('dotenv').config();
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');

const app = express();
const port = process.env.PORT || 3000;

// Verificación de variables de entorno
if (!process.env.OPENAI_API_KEY || !process.env.PRODUCTS_API_URL) {
    console.error("❌ Faltan variables de entorno (OPENAI_API_KEY o PRODUCTS_API_URL)");
    process.exit(1);
}

// Inicialización del cliente OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

app.use(express.json());
app.use(express.static('public'));

let nombreUsuario = null;

// Endpoint principal del chat
app.post('/chat', async (req, res) => {
    const userMessage = req.body.message;

    if (!userMessage) {
        return res.status(400).json({ error: 'El mensaje no puede estar vacío.' });
    }

    // Detecta si el usuario ya dio su nombre
    if (!nombreUsuario) {
        const nombreMatch = userMessage.match(/(?:me llamo|soy|mi nombre es)\s+([a-záéíóúñ\s]+)/i);
        if (nombreMatch) {
            nombreUsuario = nombreMatch[1].trim();
        } else if (/^(hola|buenos días|buenas tardes|buenas noches)$/i.test(userMessage.trim())) {
            return res.json({ reply: '¡Hola! ¿Cuál es tu nombre?' });
        }
    }

    try {
        // Siempre lee los productos actualizados desde Google Apps Script
        const response = await axios.get(process.env.PRODUCTS_API_URL);
        const products = response.data;
        const productsJson = JSON.stringify(products);

        // Prompt con toda la lógica y productos actualizados
        const nombreTexto = nombreUsuario ? `Hablas con ${nombreUsuario}, un cliente interesado en materiales de construcción.` : '';
        const systemPrompt = `
Eres **ConstructoBot**, el asistente oficial de ventas de **UPCONS Importador** 🏗️.
${nombreTexto}

Tu función es atender clientes interesados en **tejas españolas, tubos estructurales,
plancha galvanizada, zinc, megatecho, anticorrosivos y productos de construcción**.

Responde directamente a lo que el cliente pregunta usando la lista de productos que tienes abajo.
Si el cliente pregunta por un producto, busca coincidencias en la lista y responde con el precio y detalles.
Si no existe, ofrece opciones similares y ayuda a encontrar lo que necesita.

### 🏢 Información oficial de UPCONS:
- **Sucursal Sur Quito:** Avenida Martín Santiago Icaza.
- **Sucursal Sucre:** Avenida Mariscal Sucre y Arturo Tipanguano.
- **Teléfonos:** 099 598 6366 / 0983 801 298.
- **WhatsApp:** +593 99 598 6366.
- **Sitio web:** www.conupcons.com
- **Horario:** Lunes a sábado de 8:00 a 18:00.

### 📦 Productos disponibles:
${productsJson}

Recuerda:
- No inventes productos.
- Responde de forma amable y directa.
- Usa el nombre del cliente (${nombreUsuario || 'cliente'}) en las respuestas si lo tienes.
`;

        const completion = await openai.chat.completions.create({
            model: "gpt-4-turbo",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userMessage }
            ],
            temperature: 0.9,
        });

        const botResponse = completion.choices[0].message.content;
        res.json({ reply: botResponse });

    } catch (error) {
        console.error('❌ Error procesando el mensaje:', error);
        if (error.response) {
            console.error('❌ Error respuesta:', error.response.data);
            res.status(500).json({ error: 'Error en la respuesta del servidor: ' + JSON.stringify(error.response.data) });
        } else {
            res.status(500).json({ error: 'Error interno del servidor: ' + error.message });
        }
    }
});

// Iniciar servidor
app.listen(port, () => {
    console.log(`🚀 Bot UPCONS listo en http://localhost:${port}`);
});