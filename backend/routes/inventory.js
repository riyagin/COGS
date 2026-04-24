const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', (req, res) => {
  try {
    const items = db.prepare(`
      SELECT
        i.*,
        p.name AS product_name,
        p.unit_type,
        ROUND(i.price / i.amount, 6) AS unit_price
      FROM inventory_items i
      JOIN products p ON i.product_id = p.id
      ORDER BY i.date_of_purchase DESC, i.created_at DESC
    `).all();
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stock summary per product (for dropdowns / production preview)
router.get('/stock', (req, res) => {
  try {
    const stock = db.prepare(`
      SELECT
        p.id,
        p.name,
        p.unit_type,
        COALESCE(SUM(i.remaining), 0) AS total_remaining,
        CASE
          WHEN SUM(i.remaining) > 0
          THEN ROUND(SUM(i.remaining * (i.price / i.amount)) / SUM(i.remaining), 6)
          ELSE 0
        END AS avg_unit_price
      FROM products p
      LEFT JOIN inventory_items i ON p.id = i.product_id AND i.remaining > 0
      GROUP BY p.id, p.name, p.unit_type
      ORDER BY p.name
    `).all();
    res.json(stock);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', (req, res) => {
  const { product_id, amount, price, date_of_purchase } = req.body;
  if (!product_id || !amount || !price || !date_of_purchase) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  if (Number(amount) <= 0 || Number(price) <= 0) {
    return res.status(400).json({ error: 'Amount and price must be positive' });
  }
  try {
    const result = db.prepare(`
      INSERT INTO inventory_items (product_id, amount, remaining, price, date_of_purchase, source)
      VALUES (?, ?, ?, ?, ?, 'purchase')
    `).run(product_id, amount, amount, price, date_of_purchase);

    const item = db.prepare(`
      SELECT i.*, p.name AS product_name, p.unit_type,
             ROUND(i.price / i.amount, 6) AS unit_price
      FROM inventory_items i
      JOIN products p ON i.product_id = p.id
      WHERE i.id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const result = db.prepare('DELETE FROM inventory_items WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Inventory item not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
