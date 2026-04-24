const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', (req, res) => {
  try {
    const recipes = db.prepare(`
      SELECT r.*, p.name AS output_product_name, p.unit_type
      FROM recipes r
      JOIN products p ON r.output_product_id = p.id
      ORDER BY r.name
    `).all();
    res.json(recipes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const recipe = db.prepare(`
      SELECT r.*, p.name AS output_product_name, p.unit_type
      FROM recipes r
      JOIN products p ON r.output_product_id = p.id
      WHERE r.id = ?
    `).get(req.params.id);
    if (!recipe) return res.status(404).json({ error: 'Recipe not found' });

    const items = db.prepare(`
      SELECT ri.*, p.name AS product_name, p.unit_type
      FROM recipe_items ri
      JOIN products p ON ri.product_id = p.id
      WHERE ri.recipe_id = ?
      ORDER BY p.name
    `).all(req.params.id);

    res.json({ ...recipe, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', (req, res) => {
  const { name, output_product_id, items_per_batch, items } = req.body;
  if (!name || !output_product_id || !items_per_batch || !items || items.length === 0) {
    return res.status(400).json({ error: 'All fields are required and at least one ingredient is needed' });
  }

  try {
    const recipeId = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO recipes (name, output_product_id, items_per_batch) VALUES (?, ?, ?)
      `).run(name.trim(), output_product_id, items_per_batch);

      const id = result.lastInsertRowid;
      const insertItem = db.prepare(`
        INSERT INTO recipe_items (recipe_id, product_id, quantity_per_batch) VALUES (?, ?, ?)
      `);
      for (const item of items) {
        insertItem.run(id, item.product_id, item.quantity_per_batch);
      }
      return id;
    })();

    const recipe = db.prepare(`
      SELECT r.*, p.name AS output_product_name, p.unit_type
      FROM recipes r JOIN products p ON r.output_product_id = p.id
      WHERE r.id = ?
    `).get(recipeId);
    const recipeItems = db.prepare(`
      SELECT ri.*, p.name AS product_name, p.unit_type
      FROM recipe_items ri JOIN products p ON ri.product_id = p.id
      WHERE ri.recipe_id = ?
    `).all(recipeId);

    res.status(201).json({ ...recipe, items: recipeItems });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'A recipe with this name already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', (req, res) => {
  const { name, output_product_id, items_per_batch, items } = req.body;
  if (!name || !output_product_id || !items_per_batch || !items || items.length === 0) {
    return res.status(400).json({ error: 'All fields are required and at least one ingredient is needed' });
  }

  try {
    db.transaction(() => {
      db.prepare(`
        UPDATE recipes SET name = ?, output_product_id = ?, items_per_batch = ? WHERE id = ?
      `).run(name.trim(), output_product_id, items_per_batch, req.params.id);

      db.prepare('DELETE FROM recipe_items WHERE recipe_id = ?').run(req.params.id);

      const insertItem = db.prepare(`
        INSERT INTO recipe_items (recipe_id, product_id, quantity_per_batch) VALUES (?, ?, ?)
      `);
      for (const item of items) {
        insertItem.run(req.params.id, item.product_id, item.quantity_per_batch);
      }
    })();

    const recipe = db.prepare(`
      SELECT r.*, p.name AS output_product_name, p.unit_type
      FROM recipes r JOIN products p ON r.output_product_id = p.id
      WHERE r.id = ?
    `).get(req.params.id);
    const recipeItems = db.prepare(`
      SELECT ri.*, p.name AS product_name, p.unit_type
      FROM recipe_items ri JOIN products p ON ri.product_id = p.id
      WHERE ri.recipe_id = ?
    `).all(req.params.id);

    res.json({ ...recipe, items: recipeItems });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'A recipe with this name already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const result = db.prepare('DELETE FROM recipes WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Recipe not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
