const express = require('express');
const cors = require('cors');
const { errorHandler } = require('./http');
const { authenticate, requireWriteAccess, requireAdmin, publicUser } = require('./auth');
const { login, changePassword } = require('./routes/auth');

const app = express();

app.use(cors());
app.use(express.json());

// Public
app.post('/api/auth/login', login);

// Everything else under /api requires a signed-in user
app.use('/api', authenticate);

app.get('/api/me', (req, res) => res.json(publicUser(req.user)));
app.post('/api/auth/change-password', changePassword);
app.use('/api/users', requireAdmin, require('./routes/users'));

app.use('/api', requireWriteAccess);
app.use('/api/products', require('./routes/products'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/recipes', require('./routes/recipes'));
app.use('/api/production', require('./routes/production'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/adjustments', require('./routes/adjustments'));

app.use(errorHandler);

module.exports = app;
