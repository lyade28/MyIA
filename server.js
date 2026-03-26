const express = require('express');
const app = express();
app.use(express.static('./'));

app.listen(3000, () => {
  console.log('Serveur démarré sur le port 3000');
});