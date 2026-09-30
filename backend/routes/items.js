// Items: everything we stock, in three tiers.
//   raw           bought, never made here (flour, milk, smoke beef, boxes)
//   preprocessed  made here by a recipe and used in other recipes (white sauce, kulit)
//   final         made here and sold through products (Risoles Smoke Beef Mayo)
const express = require('express');
const router = express.Router();
const db = require('../db');
const { ah, HttpError, isUniqueViolation } = require('../http');

const TIERS = ['raw', 'preprocessed', 'final'];

// Each item with stock on hand and its last known unit price: the most recent purchase,
// or for items that are only ever produced, the most recent production run. Read from lot
// history, so it survives stock being reset to zero and follows every new purchase.
router.get('/', ah(async (req, res) => {
  res.json(await db.query(`
    SELECT i.*,
           COALESCE(s.qty, 0)   AS stock_qty,
           COALESCE(s.value, 0) AS stock_value,
           lp.unit_price        AS last_unit_price,
           lp.date_of_purchase  AS last_price_date,
           lp.source            AS last_price_source,
           (SELECT COUNT(*) FROM recipes r WHERE r.output_item_id = i.id)::int      AS recipe_count,
           (SELECT COUNT(DISTINCT ri.recipe_id) FROM recipe_items ri
            JOIN recipes r ON r.current_version_id = ri.version_id
            WHERE ri.item_id = i.id)::int AS used_in_count
    FROM items i
    LEFT JOIN (
      SELECT item_id, SUM(remaining) AS qty,
             SUM(CASE WHEN amount > 0 THEN remaining * price / amount ELSE 0 END) AS value
      FROM inventory_items WHERE remaining > 0
      GROUP BY item_id
    ) s ON s.item_id = i.id
    LEFT JOIN LATERAL (
      SELECT l.price / l.amount AS unit_price, l.date_of_purchase, l.source
      FROM inventory_items l
      WHERE l.item_id = i.id AND l.amount > 0 AND l.source IN ('purchase', 'production')
      ORDER BY (l.source = 'purchase') DESC, l.date_of_purchase DESC, l.created_at DESC, l.id DESC
      LIMIT 1
    ) lp ON true
    ORDER BY CASE i.tier WHEN 'raw' THEN 0 WHEN 'preprocessed' THEN 1 ELSE 2 END, i.name
  `));
}));

function validTier(tier) {
  if (!TIERS.includes(tier)) throw new HttpError(400, `tier must be one of ${TIERS.join(', ')}`);
  return tier;
}

router.post('/', ah(async (req, res) => {
  const { name, unit_type } = req.body;
  const tier = validTier(req.body.tier || 'raw');
  if (!name?.trim() || !unit_type?.trim()) {
    return res.status(400).json({ error: 'Name and unit type are required' });
  }
  try {
    res.status(201).json(await db.one(
      'INSERT INTO items (name, unit_type, tier) VALUES ($1, $2, $3) RETURNING *',
      [name.trim(), unit_type.trim(), tier]
    ));
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: 'An item with this name already exists' });
    throw err;
  }
}));

// Rename, re-tier or change the unit. Tiers must agree with the recipes; the unit is fixed
// once stock was recorded, since every quantity on record is in that unit.
router.patch('/:id', ah(async (req, res) => {
  const item = await db.one('SELECT * FROM items WHERE id = $1', [req.params.id]);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const name = req.body.name?.trim() || item.name;
  const unit = req.body.unit_type?.trim() || item.unit_type;
  const tier = req.body.tier ? validTier(req.body.tier) : item.tier;

  if (tier !== item.tier) {
    if (tier === 'raw') {
      const made = await db.one('SELECT name FROM recipes WHERE output_item_id = $1 LIMIT 1', [item.id]);
      if (made) throw new HttpError(400, `"${item.name}" is made by the recipe "${made.name}", so it can't be a raw material`);
    }
    if (tier === 'final') {
      const used = await db.one(`
        SELECT r.name FROM recipe_items ri JOIN recipes r ON r.current_version_id = ri.version_id
        WHERE ri.item_id = $1 LIMIT 1
      `, [item.id]);
      if (used) throw new HttpError(400, `"${item.name}" is an ingredient of "${used.name}"; a final good can't be an ingredient. Use preprocessed.`);
    }
  }
  if (unit !== item.unit_type) {
    const lot = await db.one('SELECT 1 FROM inventory_items WHERE item_id = $1 LIMIT 1', [item.id]);
    if (lot) throw new HttpError(400, 'The unit can\'t change once stock has been recorded in it');
  }

  try {
    res.json(await db.one(
      'UPDATE items SET name = $2, unit_type = $3, tier = $4 WHERE id = $1 RETURNING *',
      [item.id, name, unit, tier]
    ));
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: 'An item with this name already exists' });
    throw err;
  }
}));

router.delete('/:id', ah(async (req, res) => {
  const rows = await db.query('DELETE FROM items WHERE id = $1 RETURNING id', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Item not found' });
  res.json({ success: true });
}));

module.exports = router;
module.exports.TIERS = TIERS;
