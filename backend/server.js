const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

app.use('/api/products', require('./routes/products'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/recipes', require('./routes/recipes'));
app.use('/api/production', require('./routes/production'));
app.use('/api/invoices', require('./routes/invoices'));

app.listen(PORT, () => {
  console.log(`COGS Backend running on http://localhost:${PORT}`);
});
