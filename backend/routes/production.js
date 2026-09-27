const express = require('express');
const router = express.Router();
const db = require('../db');
const { ah, HttpError } = require('../http');
const { lockProducts, consumeFifo } = require('../fifo');

const PRODUCTION_SELECT = `
  SELECT pr.*, r.name AS recipe_name, p.name AS output_product_name, p.unit_type
  FROM productions pr
  JOIN recipes r ON pr.recipe_id = r.id
  JOIN products p ON r.output_product_id = p.id
`;

router.get('/', ah(async (req, res) => {
  res.json(await db.query(`${PRODUCTION_SELECT} ORDER BY pr.date_produced DESC, pr.created_at DESC, pr.id DESC`));
}));

// Preview: calculate costs without consuming inventory
router.get('/preview', ah(async (req, res) => {
  const { recipe_id, batches } = req.query;
  if (!recipe_id || !batches) {
    return res.status(400).json({ error: 'recipe_id and batches are required' });
  }

  const batchCount = parseFloat(batches);
  if (isNaN(batchCount) || batchCount <= 0) {
    return res.status(400).json({ error: 'batches must be a positive number' });
  }

  const recipe = await db.one(`
    SELECT r.*, p.name AS output_product_name, p.unit_type
    FROM recipes r
    JOIN products p ON r.output_product_id = p.id
    WHERE r.id = $1
  `, [recipe_id]);
  if (!recipe) return res.status(404).json({ error: 'Recipe not found' });

  // Weighted average price of remaining stock only
  const recipeItems = await db.query(`
    SELECT ri.*, p.name AS product_name, p.unit_type,
           COALESCE(s.total_remaining, 0) AS total_remaining,
           COALESCE(s.avg_unit_price, 0) AS avg_unit_price
    FROM recipe_items ri
    JOIN products p ON ri.product_id = p.id
    LEFT JOIN (
      SELECT product_id,
             SUM(remaining) AS total_remaining,
             SUM(remaining * (price / amount)) / SUM(remaining) AS avg_unit_price
      FROM inventory_items
      WHERE remaining > 0
      GROUP BY product_id
    ) s ON s.product_id = ri.product_id
    WHERE ri.recipe_id = $1
    ORDER BY ri.id
  `, [recipe_id]);

  let totalCost = 0;
  const ingredients = recipeItems.map(item => {
    const quantityNeeded = item.quantity_per_batch * batchCount;
    const sufficient = item.total_remaining >= quantityNeeded - 0.0001;
    const itemCost = quantityNeeded * item.avg_unit_price;
    totalCost += itemCost;

    return {
      product_id: item.product_id,
      product_name: item.product_name,
      unit_type: item.unit_type,
      quantity_per_batch: item.quantity_per_batch,
      quantity_needed: quantityNeeded,
      total_remaining: item.total_remaining,
      avg_unit_price: item.avg_unit_price,
      item_cost: itemCost,
      sufficient,
    };
  });

  const itemsProduced = recipe.items_per_batch * batchCount;

  res.json({
    recipe,
    batches: batchCount,
    items_produced: itemsProduced,
    ingredients,
    total_cost: totalCost,
    unit_cost: itemsProduced > 0 ? totalCost / itemsProduced : 0,
  });
}));

// Record a production run (FIFO consumption + add output to inventory)
router.post('/', ah(async (req, res) => {
  const { recipe_id, batches, date_produced } = req.body;
  if (!recipe_id || !batches || !date_produced) {
    return res.status(400).json({ error: 'recipe_id, batches, and date_produced are required' });
  }

  const batchCount = parseFloat(batches);
  if (isNaN(batchCount) || batchCount <= 0) {
    return res.status(400).json({ error: 'batches must be a positive number' });
  }

  const productionId = await db.tx(async t => {
    const recipe = await t.one('SELECT * FROM recipes WHERE id = $1', [recipe_id]);
    if (!recipe) throw new HttpError(404, 'Recipe not found');

    const recipeItems = await t.query(`
      SELECT ri.*, p.name AS product_name
      FROM recipe_items ri
      JOIN products p ON ri.product_id = p.id
      WHERE ri.recipe_id = $1
    `, [recipe_id]);

    await lockProducts(t, recipeItems.map(i => i.product_id));

    let totalCost = 0;
    for (const item of recipeItems) {
      const quantityNeeded = item.quantity_per_batch * batchCount;
      const { ok, available, cost } = await consumeFifo(t, item.product_id, quantityNeeded);
      if (!ok) {
        throw new HttpError(400,
          `Insufficient stock for "${item.product_name}". Need ${quantityNeeded.toFixed(4)}, available ${available.toFixed(4)}`);
      }
      totalCost += cost;
    }

    const itemsProduced = recipe.items_per_batch * batchCount;
    const unitCost = itemsProduced > 0 ? totalCost / itemsProduced : 0;

    const { id } = await t.one(`
      INSERT INTO productions (recipe_id, batches, items_produced, total_cost, unit_cost, date_produced)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `, [recipe_id, batchCount, itemsProduced, totalCost, unitCost, date_produced]);

    // Add produced items back into inventory
    await t.query(`
      INSERT INTO inventory_items (product_id, amount, remaining, price, date_of_purchase, source, production_id)
      VALUES ($1, $2, $2, $3, $4, 'production', $5)
    `, [recipe.output_product_id, itemsProduced, totalCost, date_produced, id]);

    return id;
  });

  res.status(201).json(await db.one(`${PRODUCTION_SELECT} WHERE pr.id = $1`, [productionId]));
}));

module.exports = router;
