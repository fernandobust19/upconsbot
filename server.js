const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Endpoint raíz para verificar funcionamiento
app.get('/', (req, res) => {
    res.send(`
        <h2>Servidor UPCONS funcionando correctamente.</h2>
        <p>Para conversar con el bot, usa el endpoint <b>/chat</b> enviando un mensaje por POST.<br>
        Ejemplo: <code>POST /chat</code> con <code>{ "message": "hola" }</code></p>
    `);
});

// Endpoint para chat con OpenAI y productos
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
            return res.json({ reply: `¡Hola ${nombreUsuario}! ¿En qué puedo ayudarte?` });
        } else if (/^(hola|buenos días|buenas tardes|buenas noches)$/i.test(userMessage.trim())) {
            return res.json({ reply: '¡Hola! ¿Cuál es tu nombre?' });
        } else {
            // Asume que la respuesta es el nombre
            nombreUsuario = userMessage.trim();
            return res.json({ reply: `¡Hola ${nombreUsuario}! ¿En qué puedo ayudarte?` });
        }
    }

    try {
        console.log('Consultando productos desde:', process.env.PRODUCTS_API_URL);
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
        if (error.response && error.response.data) {
            res.status(500).json({ error: 'Error en la respuesta del servidor: ' + JSON.stringify(error.response.data) });
        } else {
            res.status(500).json({ error: 'Error interno del servidor: ' + error.message });
        }
    }
});

// Endpoint para consultar productos "bottt" y "Bot de Productos"
app.get('/producto-bot', async (req, res) => {
    try {
        console.log('Consultando productos desde:', process.env.PRODUCTS_API_URL);
        const response = await axios.get(process.env.PRODUCTS_API_URL);
        const productos = response.data;

        const bottt = productos.find(p =>
            (p.nombre || p.producto || '').toLowerCase().includes('bottt')
        );
        const botDeProductos = productos.find(p =>
            (p.nombre || p.producto || '').toLowerCase().includes('bot de productos')
        );

        console.log('Producto encontrado (bottt):', bottt);
        console.log('Producto encontrado (Bot de Productos):', botDeProductos);

        if (bottt) {
            res.json({ producto: bottt, tipo: 'bottt' });
        } else if (botDeProductos) {
            res.json({ producto: botDeProductos, tipo: 'Bot de Productos' });
        } else {
            res.json({ mensaje: 'Ninguno de los productos está registrado en el sistema.' });
        }
    } catch (error) {
        console.error('Error consultando productos:', error.message);
        res.status(500).json({ error: 'No se pudo consultar los productos.' });
    }
});

app.listen(port, () => {
    console.log(`Servidor del bot escuchando en http://localhost:${port}`);
});