// Stock views. Stock comes in through purchases (routes/purchases.js), production and
// adjustments, and goes out through production, sales and adjustments; nothing is
// written here directly, so every movement is also in the books.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { ah } = require('../http');

router.get('/', ah(async (req, res) => {
  res.json(await db.query(`
    SELECT
      l.*,
      i.name AS item_name,
      i.unit_type,
      i.tier,
      CASE WHEN l.amount > 0 THEN ROUND((l.price / l.amount)::numeric, 6)::float8 ELSE 0 END AS unit_price,
      pl.purchase_id,
      COALESCE(u.name, u.username) AS created_by_name
    FROM inventory_items l
    JOIN items i ON l.item_id = i.id
    LEFT JOIN purchase_lines pl ON pl.id = l.purchase_line_id
    LEFT JOIN users u ON u.id = l.created_by
    ORDER BY l.date_of_purchase DESC, l.created_at DESC, l.id DESC
  `));
}));

// Stock summary per item (for dropdowns, the stock page and production)
router.get('/stock', ah(async (req, res) => {
  res.json(await db.query(`
    SELECT
      i.id,
      i.name,
      i.unit_type,
      i.tier,
      COALESCE(SUM(l.remaining), 0) AS total_remaining,
      COALESCE(SUM(CASE WHEN l.amount > 0 THEN l.remaining * l.price / l.amount ELSE 0 END), 0) AS total_value,
      CASE
        WHEN SUM(l.remaining) > 0
        THEN ROUND((SUM(CASE WHEN l.amount > 0 THEN l.remaining * l.price / l.amount ELSE 0 END) / SUM(l.remaining))::numeric, 6)::float8
        ELSE 0
      END AS avg_unit_price
    FROM items i
    LEFT JOIN inventory_items l ON i.id = l.item_id AND l.remaining > 0
    GROUP BY i.id, i.name, i.unit_type, i.tier
    ORDER BY CASE i.tier WHEN 'raw' THEN 0 WHEN 'preprocessed' THEN 1 ELSE 2 END, i.name
  `));
}));

module.exports = router;
