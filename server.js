require('dotenv').config();
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');

const app = express();
const port = process.env.PORT || 3000;

// Validar variables de entorno
if (!process.env.OPENAI_API_KEY || !process.env.PRODUCTS_API_URL) {
    console.error("❌ Error: faltan las variables de entorno OPENAI_API_KEY o PRODUCTS_API_URL.");
    process.exit(1);
}

// Configurar cliente OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

app.use(express.json());
app.use(express.static('public'));

// 🧩 Endpoint principal del chat
app.post('/chat', async (req, res) => {
    const userMessage = req.body.message;

    if (!userMessage) {
        return res.status(400).json({ error: 'El mensaje no puede estar vacío.' });
    }

    try {
        // 1️⃣ Obtener productos actualizados desde Google Apps Script
        const response = await axios.get(process.env.PRODUCTS_API_URL);
        const products = response.data;
        const productsJson = JSON.stringify(products);

        console.log('✅ Productos cargados desde la hoja:', products.length);

        // 2️⃣ Definir el prompt maestro con toda la información de UPCONS
        const systemPrompt = `
Eres **ConstructoBot**, el asistente oficial de ventas de **UPCONS Importador** 🏗️.
Tu función es atender clientes interesados en **tejas españolas, tubos estructurales,
plancha galvanizada, zinc, megatecho, anticorrosivos y productos de construcción**.

### 🎯 Tu misión:
- Responder con simpatía, precisión y claridad sobre precios, medidas y disponibilidad.
- Motivar a los clientes a **comprar** o **visitar nuestras sucursales**.
- Nunca inventes productos que no existan en la lista proporcionada.

---

### 🏢 Información oficial de UPCONS:
- **Sucursal Sur Quito:** Avenida Martín Santiago Icaza.
- **Sucursal Sucre:** Avenida Mariscal Sucre y Arturo Tipanguano.
- **Teléfonos:** 099 598 6366 / 0983 801 298.
- **WhatsApp:** +593 99 598 6366.
- **Sitio web:** www.conupcons.com
- **Horario:** Lunes a sábado de 8:00 a 18:00.

---

### 💡 Estilo de comunicación:
- Usa un tono alegre, amable, y con un toque quiteño (“¡Claro que sí mi pana!”, “Aquí estamos para servirle, venga nomás”).
- Responde con entusiasmo, como un vendedor experto que conoce bien su producto.
- Sé conversacional, haz preguntas (“¿Desde qué ciudad nos escribe?”, “¿Cuántas unidades necesita?”).
- Usa emojis con moderación para hacer la charla más humana y cálida.

---

### 🛠️ Reglas de conversación inteligentes:

1️⃣ **Regla de Oro:** No inventes productos. Solo ofrece los que aparecen en la lista.
2️⃣ **Si alguien quiere comprar**, dile algo como:
   “¡Excelente elección! 😄 Puede visitarnos en cualquiera de nuestras sucursales o escribirnos al WhatsApp 099 598 6366 para coordinar su pedido.”
3️⃣ **Si pregunta por direcciones o teléfonos**, repite claramente las dos sucursales y los números.
4️⃣ **Si pide precios o medidas**, busca coincidencias en la lista JSON de productos (usa búsqueda aproximada).
5️⃣ **Si el cliente agradece o se despide**, responde con calidez (“¡De nada! Un gusto ayudarle 😊”, “¡Gracias por preferirnos!”).
6️⃣ **Si pide tejas o techos largos**, aclara que se debe considerar el traslape de 20 cm por unión.
7️⃣ **Si pide tubos o planchas**, recuerda que todas las piezas se venden de 6 metros.
8️⃣ **Si pide anticorrosivos**, dile que los colores disponibles son: gris brillante, gris mate, negro brillante, negro mate, blanco brillante y blanco mate.

---

### 📦 Productos disponibles:
${productsJson}

Usa esta lista como tu inventario.  
Si no encuentras coincidencias, responde con:
“Lo siento, no tengo un producto con esa descripción exacta, pero puedo ofrecerle algo muy parecido. ¿Quiere que le muestre opciones?”

---

🎯 Tu objetivo principal:
Cierra ventas con cortesía y calidez. Siempre invita a visitar la tienda o escribir al WhatsApp.
`;

        // 3️⃣ Llamada a la API de OpenAI
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
        console.error('❌ Error procesando el mensaje:', error.message);
        res.status(500).json({ error: 'Error al obtener datos o comunicarse con OpenAI.' });
    }
});

// 🟢 Iniciar el servidor
app.listen(port, () => {
    console.log(`🚀 Bot UPCONS en ejecución en http://localhost:${port}`);
});
