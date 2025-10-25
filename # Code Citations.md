# Code Citations

## License: desconocido
https://github.com/Sushree-01/backend/tree/2b388edbf5124fdada8807bed5cfbcc2ca0469be/index.js

```javascript
const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Ejemplo de endpoint funcional
app.get('/', (req, res) => {
    res.send('Servidor Express funcionando correctamente.');
});

app.listen(port, () => {
    console.log(`Servidor escuchando en http://localhost:${port}`);
});
```

