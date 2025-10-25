
document.addEventListener('DOMContentLoaded', () => {
    const chatBox = document.getElementById('chat-box');
    const userInput = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');

    const renderInteractiveProductTable = (markdown) => {
        const lines = markdown.split('\n').filter(line => line.trim().startsWith('|') && !line.includes('---'));
        const headerLine = lines.find(line => line.includes('Producto') && line.includes('Precio')) || lines.shift();
        if (!headerLine) return markdown; // Fallback to old rendering

        const headers = headerLine.split('|').map(h => h.trim()).filter(Boolean);

        let tableHtml = `<table><thead><tr><th>${headers.join('</th><th>')}</th><th>Cantidad</th><th></th></tr></thead><tbody>`;

        lines.forEach((line, index) => {
            const parts = line.split('|').map(s => s.trim()).filter(Boolean);
            if (parts.length >= 2) {
                const productName = parts[0];
                const productPrice = parts[1];
                tableHtml += `
                    <tr>
                        <td>${productName}</td>
                        <td>${productPrice}</td>
                        <td>
                            <input type="number" class="quantity-input" id="qty-input-${index}" min="1" value="1" style="width: 60px;">
                        </td>
                        <td>
                            <button class="add-to-proforma-btn" data-product-name="${productName}" data-input-id="qty-input-${index}">Añadir</button>
                        </td>
                    </tr>
                `;
            }
        });

        tableHtml += '</tbody></table>';
        return tableHtml;
    };

    const renderMarkdownTable = (markdown) => {
        const lines = markdown.split('\n').filter(line => line.trim().startsWith('|'));
        if (lines.length < 2) return markdown;

        let tableHtml = '<table>';
        const headerLine = lines.shift();
        const headers = headerLine.split('|').map(h => h.trim()).filter(Boolean);
        tableHtml += `<thead><tr><th>${headers.join('</th><th>')}</th></tr></thead>`;

        if (lines[0] && lines[0].includes('---')) lines.shift();

        tableHtml += '<tbody>';
        lines.forEach(line => {
            const cells = line.split('|').map(c => c.trim()).filter(Boolean);
            if (cells.length > 0) {
                tableHtml += `<tr><td>${cells.join('</td><td>')}</td></tr>`;
            }
        });
        tableHtml += '</tbody></table>';
        return markdown.substring(0, markdown.indexOf('|')) + tableHtml;
    };

    const addMessage = (text, sender) => {
        const messageElement = document.createElement('div');
        messageElement.classList.add('message', `${sender}-message`);
        
        const p = document.createElement('div');

        // Determinar el tipo de tabla para renderizar
        const isProductList = sender === 'bot' && text.includes('| Producto') && text.includes('| Precio');
        const isProformaTable = sender === 'bot' && text.includes('| Cantidad') && text.includes('| Total');

        if (isProductList) {
            p.innerHTML = renderInteractiveProductTable(text);
        } else if (isProformaTable) {
            p.innerHTML = renderMarkdownTable(text);
        } else {
            // Renderizado normal para texto y enlaces
            p.innerHTML = text.replace(/(\/proforma)/g, '<a href="$1" target="_blank">Ver Proforma en nueva pestaña</a>');
        }

        messageElement.appendChild(p);
        
        chatBox.appendChild(messageElement);
        chatBox.scrollTop = chatBox.scrollHeight;
    };

    const handleSendMessage = async () => {
        const message = userInput.value.trim(); // Keep this for user-typed messages
        if (message === '') return;

        addMessage(message, 'user');
        userInput.value = '';

        try {
            const response = await fetch('/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ message: message }),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Error en la respuesta del servidor.');
            }

            const data = await response.json();
            addMessage(data.reply || 'No se recibió una respuesta válida.', 'bot');

        } catch (error) {
            console.error('Error al enviar mensaje:', error);
            addMessage('Lo siento, no puedo responder en este momento.', 'bot');
        }
    };

    // Event delegation for dynamically added buttons
    chatBox.addEventListener('click', (e) => {
        if (e.target && e.target.classList.contains('add-to-proforma-btn')) {
            const productName = e.target.getAttribute('data-product-name');
            const inputId = e.target.getAttribute('data-input-id');
            const quantityInput = document.getElementById(inputId);
            const quantity = quantityInput.value;

            if (productName && quantity) {
                const message = `Añadir ${quantity} de ${productName}`;
                userInput.value = message;
                handleSendMessage();
            }
        }
    });

    sendBtn.addEventListener('click', handleSendMessage);
    userInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            handleSendMessage();
        }
    });
});
