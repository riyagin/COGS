const express = require('express');
const router = express.Router();
const db = require('../db');
const { ah } = require('../http');

const LOT_SELECT = `
  SELECT
    i.*,
    p.name AS product_name,
    p.unit_type,
    ROUND((i.price / i.amount)::numeric, 6)::float8 AS unit_price
  FROM inventory_items i
  JOIN products p ON i.product_id = p.id
`;

router.get('/', ah(async (req, res) => {
  res.json(await db.query(`${LOT_SELECT} ORDER BY i.date_of_purchase DESC, i.created_at DESC, i.id DESC`));
}));

// Stock summary per product (for dropdowns / production preview)
router.get('/stock', ah(async (req, res) => {
  res.json(await db.query(`
    SELECT
      p.id,
      p.name,
      p.unit_type,
      COALESCE(SUM(i.remaining), 0) AS total_remaining,
      CASE
        WHEN SUM(i.remaining) > 0
        THEN ROUND((SUM(i.remaining * (i.price / i.amount)) / SUM(i.remaining))::numeric, 6)::float8
        ELSE 0
      END AS avg_unit_price
    FROM products p
    LEFT JOIN inventory_items i ON p.id = i.product_id AND i.remaining > 0
    GROUP BY p.id, p.name, p.unit_type
    ORDER BY p.name
  `));
}));

router.post('/', ah(async (req, res) => {
  const { product_id, amount, price, date_of_purchase } = req.body;
  if (!product_id || !amount || !price || !date_of_purchase) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  if (Number(amount) <= 0 || Number(price) <= 0) {
    return res.status(400).json({ error: 'Amount and price must be positive' });
  }
  const { id } = await db.one(`
    INSERT INTO inventory_items (product_id, amount, remaining, price, date_of_purchase, source)
    VALUES ($1, $2, $2, $3, $4, 'purchase')
    RETURNING id
  `, [product_id, amount, price, date_of_purchase]);

  res.status(201).json(await db.one(`${LOT_SELECT} WHERE i.id = $1`, [id]));
}));

router.delete('/:id', ah(async (req, res) => {
  const rows = await db.query('DELETE FROM inventory_items WHERE id = $1 RETURNING id', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Inventory item not found' });
  res.json({ success: true });
}));

module.exports = router;
