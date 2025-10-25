
document.addEventListener('DOMContentLoaded', () => {
    const chatBox = document.getElementById('chat-box');
    const userInput = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');

    const addMessage = (text, sender) => {
        const messageElement = document.createElement('div');
        messageElement.classList.add('message', `${sender}-message`);
        
        // Renderizar Markdown (simplificado para tablas y enlaces)
        const p = document.createElement('div');
        p.innerHTML = text
            .replace(/\|(.+)\|(.+)\|/g, '<table><tr><th>$1</th><th>$2</th></tr>')
            .replace(/\|(.+)\|/g, '<tr><td>$1</td></tr>')
            .replace(/<\/tr><table>/g, '</table>')
            .replace(/(\/proforma)/g, '<a href="$1" target="_blank">$1</a>');

        messageElement.appendChild(p);
        
        chatBox.appendChild(messageElement);
        chatBox.scrollTop = chatBox.scrollHeight;
    };

    const handleSendMessage = async () => {
        const message = userInput.value.trim();
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
