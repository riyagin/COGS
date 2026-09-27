const express = require('express');
const router = express.Router();
const db = require('../db');
const { ah, isUniqueViolation } = require('../http');

router.get('/', ah(async (req, res) => {
  res.json(await db.query('SELECT * FROM products ORDER BY name'));
}));

router.post('/', ah(async (req, res) => {
  const { name, unit_type } = req.body;
  if (!name || !unit_type) {
    return res.status(400).json({ error: 'Name and unit type are required' });
  }
  try {
    const product = await db.one(
      'INSERT INTO products (name, unit_type) VALUES ($1, $2) RETURNING *',
      [name.trim(), unit_type.trim()]
    );
    res.status(201).json(product);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: 'A product with this name already exists' });
    }
    throw err;
  }
}));

router.delete('/:id', ah(async (req, res) => {
  const rows = await db.query('DELETE FROM products WHERE id = $1 RETURNING id', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Product not found' });
  res.json({ success: true });
}));

module.exports = router;
