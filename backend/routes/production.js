const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', (req, res) => {
  try {
    const productions = db.prepare(`
      SELECT pr.*, r.name AS recipe_name, p.name AS output_product_name, p.unit_type
      FROM productions pr
      JOIN recipes r ON pr.recipe_id = r.id
      JOIN products p ON r.output_product_id = p.id
      ORDER BY pr.date_produced DESC, pr.created_at DESC
    `).all();
    res.json(productions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Preview: calculate costs without consuming inventory
router.get('/preview', (req, res) => {
  const { recipe_id, batches } = req.query;
  if (!recipe_id || !batches) {
    return res.status(400).json({ error: 'recipe_id and batches are required' });
  }

  const batchCount = parseFloat(batches);
  if (isNaN(batchCount) || batchCount <= 0) {
    return res.status(400).json({ error: 'batches must be a positive number' });
  }

  try {
    const recipe = db.prepare(`
      SELECT r.*, p.name AS output_product_name, p.unit_type
      FROM recipes r
      JOIN products p ON r.output_product_id = p.id
      WHERE r.id = ?
    `).get(recipe_id);
    if (!recipe) return res.status(404).json({ error: 'Recipe not found' });

    const recipeItems = db.prepare(`
      SELECT ri.*, p.name AS product_name, p.unit_type
      FROM recipe_items ri
      JOIN products p ON ri.product_id = p.id
      WHERE ri.recipe_id = ?
    `).all(recipe_id);

    let totalCost = 0;
    const ingredients = recipeItems.map(item => {
      const quantityNeeded = item.quantity_per_batch * batchCount;

      // Weighted average price of remaining stock only
      const stock = db.prepare(`
        SELECT
          COALESCE(SUM(remaining), 0) AS total_remaining,
          CASE
            WHEN SUM(remaining) > 0
            THEN SUM(remaining * (price / amount)) / SUM(remaining)
            ELSE 0
          END AS avg_unit_price
        FROM inventory_items
        WHERE product_id = ? AND remaining > 0
      `).get(item.product_id);

      const sufficient = stock.total_remaining >= quantityNeeded - 0.0001;
      const itemCost = quantityNeeded * stock.avg_unit_price;
      totalCost += itemCost;

      return {
        product_id: item.product_id,
        product_name: item.product_name,
        unit_type: item.unit_type,
        quantity_per_batch: item.quantity_per_batch,
        quantity_needed: quantityNeeded,
        total_remaining: stock.total_remaining,
        avg_unit_price: stock.avg_unit_price,
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Record a production run (FIFO consumption + add output to inventory)
router.post('/', (req, res) => {
  const { recipe_id, batches, date_produced } = req.body;
  if (!recipe_id || !batches || !date_produced) {
    return res.status(400).json({ error: 'recipe_id, batches, and date_produced are required' });
  }

  const batchCount = parseFloat(batches);
  if (isNaN(batchCount) || batchCount <= 0) {
    return res.status(400).json({ error: 'batches must be a positive number' });
  }

  try {
    const recipe = db.prepare(`
      SELECT r.*, p.name AS output_product_name
      FROM recipes r
      JOIN products p ON r.output_product_id = p.id
      WHERE r.id = ?
    `).get(recipe_id);
    if (!recipe) return res.status(404).json({ error: 'Recipe not found' });

    const recipeItems = db.prepare(`
      SELECT ri.*, p.name AS product_name
      FROM recipe_items ri
      JOIN products p ON ri.product_id = p.id
      WHERE ri.recipe_id = ?
    `).all(recipe_id);

    // Validate stock and plan FIFO consumptions
    let totalCost = 0;
    const consumptions = []; // { id, consume }

    for (const item of recipeItems) {
      const quantityNeeded = item.quantity_per_batch * batchCount;

      const invRows = db.prepare(`
        SELECT id, remaining, price, amount
        FROM inventory_items
        WHERE product_id = ? AND remaining > 0
        ORDER BY date_of_purchase ASC, created_at ASC
      `).all(item.product_id);

      let toConsume = quantityNeeded;
      let itemCost = 0;

      for (const inv of invRows) {
        if (toConsume <= 0.0001) break;
        const take = Math.min(toConsume, inv.remaining);
        itemCost += take * (inv.price / inv.amount);
        consumptions.push({ id: inv.id, consume: take });
        toConsume -= take;
      }

      if (toConsume > 0.0001) {
        return res.status(400).json({
          error: `Insufficient stock for "${item.product_name}". Need ${quantityNeeded.toFixed(4)}, available ${(quantityNeeded - toConsume).toFixed(4)}`,
        });
      }

      totalCost += itemCost;
    }

    const itemsProduced = recipe.items_per_batch * batchCount;
    const unitCost = itemsProduced > 0 ? totalCost / itemsProduced : 0;

    const productionId = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO productions (recipe_id, batches, items_produced, total_cost, unit_cost, date_produced)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(recipe_id, batchCount, itemsProduced, totalCost, unitCost, date_produced);

      const pid = result.lastInsertRowid;

      // Consume inventory (FIFO)
      const updateRemaining = db.prepare(`
        UPDATE inventory_items SET remaining = remaining - ? WHERE id = ?
      `);
      for (const { id, consume } of consumptions) {
        updateRemaining.run(consume, id);
      }

      // Add produced items back into inventory
      db.prepare(`
        INSERT INTO inventory_items (product_id, amount, remaining, price, date_of_purchase, source, production_id)
        VALUES (?, ?, ?, ?, ?, 'production', ?)
      `).run(recipe.output_product_id, itemsProduced, itemsProduced, totalCost, date_produced, pid);

      return pid;
    })();

    const production = db.prepare(`
      SELECT pr.*, r.name AS recipe_name, p.name AS output_product_name, p.unit_type
      FROM productions pr
      JOIN recipes r ON pr.recipe_id = r.id
      JOIN products p ON r.output_product_id = p.id
      WHERE pr.id = ?
    `).get(productionId);

    res.status(201).json(production);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
