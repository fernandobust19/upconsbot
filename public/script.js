document.addEventListener('DOMContentLoaded', () => {
    const chatBox = document.getElementById('chat-box');
    const userInput = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');
    const proformaItems = document.getElementById('proforma-items');
    const proformaTotal = document.getElementById('proforma-total');
    const API_BASE = 'https://upconsbot.onrender.com';

    // --- Lógica de la Proforma ---
    const updateProforma = (proforma) => {
        if (!proformaItems || !proformaTotal) return;

        proformaItems.innerHTML = ''; // Limpiar antes de renderizar
        let total = 0;

        if (proforma && proforma.length > 0) {
            proforma.forEach(item => {
                const itemElement = document.createElement('div');
                itemElement.classList.add('proforma-item');

                const name = document.createElement('span');
                name.classList.add('proforma-item-name');
                name.textContent = item.nombre;

                const qty = document.createElement('span');
                qty.classList.add('proforma-item-qty');
                qty.textContent = `Cant: ${item.cantidad}`;
                
                const price = document.createElement('span');
                price.classList.add('proforma-item-price');
                const subtotal = (item.cantidad || 0) * (item.precio || 0);
                price.textContent = `$${subtotal.toFixed(2)}`;

                itemElement.appendChild(name);
                itemElement.appendChild(qty);
                itemElement.appendChild(price);
                proformaItems.appendChild(itemElement);

                total += subtotal;
            });
        }

        proformaTotal.innerHTML = `<strong>Total: $${total.toFixed(2)}</strong>`;
    };

    // --- Lógica del Chat ---

    const renderInteractiveProductTable = (products) => {
        let tableHtml = `<table><thead><tr><th>Producto</th><th>Precio</th></tr></thead><tbody>`;
        products.forEach(product => {
            // Guardamos el nombre del producto en un atributo de datos para la selección
            tableHtml += `
                <tr data-product-name="${product.nombre}">
                    <td>${product.nombre}</td>
                    <td>$${product.precio.toFixed(2)}</td>
                </tr>
            `;
        });
        tableHtml += '</tbody></table>';
        return tableHtml;
    };
    
    const renderMarkdownTable = (markdown) => {
        const tableRegex = /(?:^|\n)(\|.*?\|\s*\n\| *--- *\|.*(?:\n\|.*?\|.*)*)/;
        const match = markdown.match(tableRegex);

        if (!match) return markdown;

        const tableMarkdown = match[1].trim();
        const lines = tableMarkdown.split('\n').filter(line => line.trim().startsWith('|'));
        
        if (lines.length < 2) return markdown;

        let tableHtml = '<table style="width: 100%; border-collapse: collapse;">';
        const headerLine = lines.shift();
        const headers = headerLine.split('|').map(h => h.trim()).filter(Boolean);
        tableHtml += `<thead><tr><th style="border: 1px solid #ddd; padding: 8px; text-align: left;">${headers.join('</th><th style="border: 1px solid #ddd; padding: 8px; text-align: left;">')}</th></tr></thead>`;

        if (lines[0] && lines[0].includes('---')) lines.shift();

        tableHtml += '<tbody>';
        lines.forEach(line => {
            const cells = line.split('|').map(c => c.trim()).filter(Boolean);
            if (cells.length > 0) {
                tableHtml += `<tr><td style="border: 1px solid #ddd; padding: 8px;">${cells.join('</td><td style="border: 1px solid #ddd; padding: 8px;">')}</td></tr>`;
            }
        });
        tableHtml += '</tbody></table>';
        
        return markdown.substring(0, markdown.indexOf('|')) + tableHtml;
    };

    const normalizeLinks = (text) => {
        let html = text.replace(/\n/g, '<br>');
        html = html.replace(/(\/proforma\?download=1)/g, `<a href="${API_BASE}$1" download>Descargar Proforma (HTML)</a>`);
        html = html.replace(/(\/proforma\.pdf)/g, `<a href="${API_BASE}$1" download>Descargar Proforma (PDF)</a>`);
        html = html.replace(/(\/proforma)\b/g, `<a href="${API_BASE}$1" target="_blank">Ver Proforma</a>`);
        html = html.replace(/(tel:[+\d][+\d\-\s()]*)/g, '<a href="$1">Llamar ahora</a>');
        return html;
    };

    const addMessage = (data, sender) => {
        const messageElement = document.createElement('div');
        messageElement.classList.add('message', `${sender}-message`);
        
        const contentDiv = document.createElement('div');

        if (sender === 'bot' && data.products && data.products.length > 0) {
            contentDiv.innerHTML = renderInteractiveProductTable(data.products);
        } else if (sender === 'bot' && data.isProforma) {
            contentDiv.innerHTML = renderMarkdownTable(data.text);
        } else {
            const text = (typeof data === 'string') ? data : data.text;
            contentDiv.innerHTML = normalizeLinks(text);
        }

        messageElement.appendChild(contentDiv);
        chatBox.appendChild(messageElement);
        chatBox.scrollTop = chatBox.scrollHeight;
    };

    const handleSendMessage = async (messageOverride = null) => {
        const message = messageOverride || userInput.value.trim();
        if (message === '') return;

        addMessage(message, 'user');
        if (!messageOverride) {
            userInput.value = '';
        }

        try {
            const response = await fetch(`${API_BASE}/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: message }),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Error en la respuesta del servidor.');
            }

            const data = await response.json();
            
            // La IA ahora puede devolver una lista de productos o una tabla de proforma
            const botReply = {
                text: data.reply || 'No se recibió una respuesta válida.',
                products: data.products, // Array de productos para la tabla interactiva
                isProforma: data.isProforma, // Booleano si es una tabla de proforma
            };

            addMessage(botReply, 'bot');

            // Actualizar la vista de la proforma con los datos del servidor
            if (data.proforma) {
                updateProforma(data.proforma);
            }

        } catch (error) {
            console.error('Error al enviar mensaje:', error);
            addMessage('Lo siento, no puedo responder en este momento.', 'bot');
        }
    };

    // --- Event Listeners ---
    sendBtn.addEventListener('click', () => handleSendMessage());
    userInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            handleSendMessage();
        }
    });

    // Delegación de eventos para seleccionar productos de la tabla
    chatBox.addEventListener('click', (e) => {
        const row = e.target.closest('tr[data-product-name]');
        if (row) {
            const productName = row.dataset.productName;
            const message = `Seleccioné este producto: ${productName}`;
            handleSendMessage(message);
        }
    });

    // Mensaje inicial del asistente
    addMessage('¡Hola! Bienvenido a UP CONS, su aliado en construcción. Soy su asistente virtual. Para ofrecerle una atención personalizada, ¿podría indicarme su nombre?', 'bot');
});
