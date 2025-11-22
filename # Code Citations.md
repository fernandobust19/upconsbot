# Code Citations

## License: desconocido
https://github.com/Marost/webpperu/tree/9ae5864972f358f95cde4cb8554023b2cdabdbe9/noticia.php

```html
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Noticias - WebPeru</title>
</head>
<body>
    <!-- Contenido de noticias -->
</body>
</html>
```

---

## 🤖 ANÁLISIS COMPLETO DEL CHATBOT UPCONSBOT

### 📊 Estado Actual (Enero 2025)

**URL Producción:** https://www.conupcons.com  
**Backend:** Render (Node.js + Express)  
**Frontend:** HTML/CSS/JS estático  
**IA:** OpenAI API (llamadas directas)

---

## 🔴 PROBLEMAS CRÍTICOS DETECTADOS

### 1. **Lógica de Conversación Rota**
```
❌ Usuario: "quiero 5 tejas"
❌ Bot: "Lo siento, no puedo responder en este momento"
```

**Causa raíz:**
- El flujo local (sin IA) NO está procesando cantidades correctamente
- Falta bandera `awaitingQuantity` en respuestas JSON
- OpenAI se invoca antes del procesamiento local de productos
- Fallback genérico activado por error de API

### 2. **Arquitectura del "Cerebro" (script.js/server.js)**

**Problema:** El bot NO tiene lógica local robusta antes de OpenAI

```javascript
// ❌ ACTUAL: Todo va directo a OpenAI
fetch('/chat', { userMessage }) → OpenAI → Respuesta genérica

// ✅ DEBE SER: Procesamiento local primero
1. Detectar intención (agregar/ver/eliminar)
2. Procesar con catálogo local
3. Solo usar OpenAI para dudas/saludos
```

### 3. **Flujo de Cantidad NO Funciona**
- `awaitingQuantityFor` definido pero NO procesado
- `pendingMaterialOptions` no respeta selección numérica
- Placeholder NO cambia dinámicamente
- Clic en tabla NO envía número de opción

---

## 🧠 CÓMO DEBERÍA FUNCIONAR EL "CEREBRO"

### **Arquitectura Correcta de Respuestas:**

```
ENTRADA USUARIO
     ↓
┌─────────────────────────┐
│ 1. Análisis de Intención│  ← Regex/Keywords locales
│    - ¿Agregar producto? │
│    - ¿Ver proforma?     │
│    - ¿Eliminar/editar?  │
└─────────────────────────┘
     ↓
┌─────────────────────────┐
│ 2. Procesamiento Local │  ← SIN OpenAI
│    - Buscar en catálogo │
│    - Validar cantidad   │
│    - Actualizar carrito │
│    - Generar tabla      │
└─────────────────────────┘
     ↓
┌─────────────────────────┐
│ 3. Respuesta Directa    │  ← JSON con awaitingQuantity
│    awaitingQuantity:    │
│    true/false           │
└─────────────────────────┘
     ↓
Solo si NO es operación → OpenAI (saludos, dudas)
```

---

## 🛠️ SOLUCIÓN PASO A PASO

### **PATCH 1: server.js - Flujo Local Robusto**

**Antes de llamar OpenAI, agregar:**

```javascript
// filepath: server.js (dentro de POST /chat)

// 1. Detectar si está esperando cantidad
if (profile.awaitingQuantityFor && /^\d+$/.test(userMessage)) {
  const qty = parseInt(userMessage);
  const product = profile.awaitingQuantityFor;
  
  // Agregar a proforma
  const current = profile.proforma || [];
  current.push({ 
    nombre: product.nombre, 
    cantidad: qty, 
    precio: product.precio 
  });
  
  updateUserProfile(req, { 
    proforma: current, 
    awaitingQuantityFor: null 
  });
  
  return res.json({
    reply: `✅ Agregado: ${qty} x ${product.nombre}\n\n` +
           formatProformaMarkdown(current).table,
    proforma: current,
    awaitingQuantity: false
  });
}

// 2. Detectar selección numérica de opciones
if (profile.pendingMaterialOptions?.length > 0 && /^\d+$/.test(userMessage)) {
  const idx = parseInt(userMessage) - 1;
  const selected = profile.pendingMaterialOptions[idx];
  
  if (selected) {
    updateUserProfile(req, { 
      awaitingQuantityFor: selected,
      pendingMaterialOptions: []
    });
    
    return res.json({
      reply: `¿Cuántas unidades de ${selected.nombre} necesitas?`,
      proforma: profile.proforma,
      awaitingQuantity: true
    });
  }
}

// 3. Detectar agregar con cantidad incluida
const addMatch = userMessage.match(/(\d+)\s*(teja|tubo|plancha)/i);
if (addMatch) {
  const qty = parseInt(addMatch[1]);
  const tipo = addMatch[2];
  
  // Buscar producto en catálogo
  const producto = findBestProductByMessage(userMessage, products);
  
  if (producto) {
    const current = profile.proforma || [];
    current.push({ 
      nombre: producto.nombre, 
      cantidad: qty, 
      precio: producto.precio 
    });
    
    updateUserProfile(req, { proforma: current });
    
    return res.json({
      reply: `✅ ${qty} x ${producto.nombre} agregado\n\n` +
             formatProformaMarkdown(current).table,
      proforma: current,
      awaitingQuantity: false
    });
  }
}

// ...resto del código, solo llamar OpenAI si no se procesó arriba
```

### **PATCH 2: public/script.js - Placeholder Dinámico**

```javascript
// filepath: public/script.js

async function handleSendMessage(message) {
  // ...existing code...
  
  const response = await fetch('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  });
  
  const data = await response.json();
  
  // Actualizar placeholder según estado
  if (data.awaitingQuantity) {
    userInput.placeholder = '🔢 Escribe la cantidad (ej: 5)';
    userInput.style.borderColor = '#4CAF50';
  } else {
    userInput.placeholder = '💬 Escribe tu pregunta...';
    userInput.style.borderColor = '#ddd';
  }
  
  // ...existing code...
}

// Clic en tabla = enviar número de opción
chatBox.addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-product-name]');
  if (row) {
    const idx = Array.from(row.parentElement.children).indexOf(row) + 1;
    handleSendMessage(String(idx));
  }
});
```

---

## 📈 MEJORAS ADICIONALES RECOMENDADAS

### **1. Respuestas Más Naturales (Sin IA)**

```javascript
// Reemplazar mensajes genéricos:
❌ "¿Qué tipo de tubo necesitas?"
✅ "Tenemos tubos cuadrados, rectangulares y redondos. ¿Cuál prefieres?"

❌ "¿Cuántas unidades necesitas?"
✅ "¡Perfecto! ¿Cuántas Tejas Españolas Eternit quieres llevar?"
```

### **2. Validaciones Inteligentes**

```javascript
// Rechazar cantidades absurdas
if (qty > 10000) {
  return { 
    reply: '🤔 Esa cantidad es muy alta. ¿Confirmas que necesitas ' + qty + ' unidades?',
    awaitingQuantity: true 
  };
}
```

### **3. Sugerencias Proactivas**

```javascript
// Cuando carrito está vacío
if (proforma.length === 0) {
  reply += '\n\n💡 Productos populares:\n' +
           '- Tejas españolas\n' +
           '- Tubos cuadrados\n' +
           '- Planchas onduladas';
}
```

---

## 🎯 CHECKLIST DE IMPLEMENTACIÓN

- [ ] Aplicar PATCH 1 en `server.js`
- [ ] Aplicar PATCH 2 en `public/script.js`
- [ ] Probar flujo: "quiero 5 tejas" → debe agregar sin error
- [ ] Probar opciones: "tejas" → mostrar 3 opciones → clic = pedir cantidad
- [ ] Verificar placeholder cambia a "🔢 Escribe cantidad"
- [ ] Confirmar NO llama OpenAI para operaciones simples
- [ ] Desplegar en Render
- [ ] Probar en producción (www.conupcons.com)

---

## 🚨 ERRORES A IGNORAR

```
Access to fetch at 'https://play.google.com/log?...' CORS
→ Es de Google Analytics, NO afecta el chat
→ Solución: Eliminar scripts de Google del HTML si molesta
```

---

## 📝 PRÓXIMOS PASOS

1. **Aplicar parches completos** (te los envío en siguiente mensaje)
2. **Eliminar dependencia de OpenAI para operaciones básicas**
3. **Agregar respuestas pregrabadas naturales**
4. **Implementar memoria de contexto (última conversación)**
5. **A/B testing de frases más coloquiales**

---

**Última actualización:** Enero 2025  
**Estado:** Pendiente de aplicar mejoras críticas

