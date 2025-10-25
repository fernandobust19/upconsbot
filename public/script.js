
document.addEventListener('DOMContentLoaded', () => {
    const chatBox = document.getElementById('chat-box');
    const userInput = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');

    const renderInteractiveProductTable = (markdown) => {
        const lines = markdown.split('\n').filter(line => line.trim().startsWith('|') && !line.includes('---'));
        const headerLine = lines.shift();
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

    const addMessage = (text, sender) => {
        const messageElement = document.createElement('div');
        messageElement.classList.add('message', `${sender}-message`);
        
        const p = document.createElement('div');

        if (sender === 'bot' && text.includes('| Producto ') && text.includes('| Precio ')) {
            p.innerHTML = renderInteractiveProductTable(text);
        } else {
            // Renderizado normal para otros mensajes y tablas (como proformas)
            p.innerHTML = text.replace(/(\/proforma)/g, '<a href="$1" target="_blank">$1</a>');
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
