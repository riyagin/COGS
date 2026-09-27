const express = require('express');
const cors = require('cors');
const { errorHandler } = require('./http');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/products', require('./routes/products'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/recipes', require('./routes/recipes'));
app.use('/api/production', require('./routes/production'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/adjustments', require('./routes/adjustments'));

app.use(errorHandler);

module.exports = app;
