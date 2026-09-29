const express = require('express');
const router = express.Router();
const db = require('../db');
const { ah, isUniqueViolation } = require('../http');

// Each product with its last known unit price: the most recent purchase, or for products
// that are only ever produced, the most recent production run. Read from lot history,
// so it survives stock being reset to zero and follows every new purchase.
router.get('/', ah(async (req, res) => {
  res.json(await db.query(`
    SELECT p.*,
           lp.unit_price       AS last_unit_price,
           lp.date_of_purchase AS last_price_date,
           lp.source           AS last_price_source
    FROM products p
    LEFT JOIN LATERAL (
      SELECT i.price / i.amount AS unit_price, i.date_of_purchase, i.source
      FROM inventory_items i
      WHERE i.product_id = p.id AND i.amount > 0 AND i.source IN ('purchase', 'production')
      ORDER BY (i.source = 'purchase') DESC, i.date_of_purchase DESC, i.created_at DESC, i.id DESC
      LIMIT 1
    ) lp ON true
    ORDER BY p.name
  `));
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
