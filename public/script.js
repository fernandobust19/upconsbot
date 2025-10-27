
document.addEventListener('DOMContentLoaded', () => {
    const chatBox = document.getElementById('chat-box');
    const userInput = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');

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
        
        const p = document.createElement('p');

        // Si la respuesta del bot contiene una tabla Markdown, la renderiza como HTML.
        if (sender === 'bot' && text.includes('|')) {
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

    sendBtn.addEventListener('click', handleSendMessage);
    userInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            handleSendMessage();
        }
    });
});
