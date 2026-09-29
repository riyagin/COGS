const express = require('express');
const cors = require('cors');
const { errorHandler } = require('./http');
const { authenticate, requireWriteAccess, requireAdmin, authEnabled } = require('./auth');

const app = express();

app.use(cors());
app.use(express.json());

// Everything under /api requires a signed-in, allowlisted user
app.use('/api', authenticate);

app.get('/api/me', (req, res) => {
  const { id, email, name, role, dev } = req.user;
  res.json({ id, email, name, role, dev: !!dev, auth_enabled: authEnabled });
});
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
