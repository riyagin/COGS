const express = require('express');
const router = express.Router();
const db = require('../db');

// GET adjustment history (most recent first)
router.get('/', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT a.*, p.name AS product_name, p.unit_type
      FROM stock_adjustments a
      JOIN products p ON a.product_id = p.id
      ORDER BY a.date DESC, a.created_at DESC
      LIMIT 200
    `).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET current stock for all products
router.get('/stock', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT
        p.id,
        p.name,
        p.unit_type,
        COALESCE(SUM(i.remaining), 0) AS total_remaining
      FROM products p
      LEFT JOIN inventory_items i ON p.id = i.product_id AND i.remaining > 0
      GROUP BY p.id, p.name, p.unit_type
      ORDER BY p.name
    `).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST apply a manual adjustment
router.post('/', (req, res) => {
  const { product_id, quantity, note, date } = req.body;
  if (!product_id || quantity === undefined || quantity === null || !date) {
    return res.status(400).json({ error: 'product_id, quantity, and date are required' });
  }

  const qty = parseFloat(quantity);
  if (isNaN(qty) || qty === 0) {
    return res.status(400).json({ error: 'quantity must be a non-zero number' });
  }

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(product_id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  try {
    if (qty > 0) {
      // Positive adjustment: add a zero-cost inventory entry
      db.transaction(() => {
        db.prepare(`
          INSERT INTO inventory_items (product_id, amount, remaining, price, date_of_purchase, source, note)
          VALUES (?, ?, ?, 0, ?, 'adjustment', ?)
        `).run(product_id, qty, qty, date, note || null);

        db.prepare(`
          INSERT INTO stock_adjustments (product_id, quantity, note, date)
          VALUES (?, ?, ?, ?)
        `).run(product_id, qty, note || null, date);
      })();
    } else {
      // Negative adjustment: FIFO consume from existing inventory
      const absQty = Math.abs(qty);

      const invRows = db.prepare(`
        SELECT id, remaining
        FROM inventory_items
        WHERE product_id = ? AND remaining > 0
        ORDER BY date_of_purchase ASC, created_at ASC
      `).all(product_id);

      const totalStock = invRows.reduce((s, r) => s + r.remaining, 0);
      if (totalStock < absQty - 0.0001) {
        return res.status(400).json({
          error: `Insufficient stock. Need ${absQty}, have ${totalStock.toFixed(4)} ${product.unit_type}`,
        });
      }

      db.transaction(() => {
        let toConsume = absQty;
        for (const row of invRows) {
          if (toConsume <= 0.0001) break;
          const take = Math.min(toConsume, row.remaining);
          db.prepare('UPDATE inventory_items SET remaining = remaining - ? WHERE id = ?').run(take, row.id);
          toConsume -= take;
        }

        db.prepare(`
          INSERT INTO stock_adjustments (product_id, quantity, note, date)
          VALUES (?, ?, ?, ?)
        `).run(product_id, qty, note || null, date);
      })();
    }

    const adjustment = db.prepare(`
      SELECT a.*, p.name AS product_name, p.unit_type
      FROM stock_adjustments a
      JOIN products p ON a.product_id = p.id
      WHERE a.id = (SELECT MAX(id) FROM stock_adjustments WHERE product_id = ?)
    `).get(product_id);

    res.status(201).json(adjustment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST apply a stock opname (physical count) — overwrites stock to the counted amount
router.post('/opname', (req, res) => {
  const { product_id, counted_quantity, date, note, unit_price } = req.body;
  if (!product_id || counted_quantity === undefined || counted_quantity === null || !date) {
    return res.status(400).json({ error: 'product_id, counted_quantity, and date are required' });
  }

  const counted = parseFloat(counted_quantity);
  if (isNaN(counted) || counted < 0) {
    return res.status(400).json({ error: 'counted_quantity must be a non-negative number' });
  }

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(product_id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  try {
    const { total_remaining } = db.prepare(`
      SELECT COALESCE(SUM(remaining), 0) AS total_remaining
      FROM inventory_items WHERE product_id = ?
    `).get(product_id);

    const delta = counted - total_remaining;

    if (Math.abs(delta) < 0.0001) {
      return res.json({
        product_id, product_name: product.name, unit_type: product.unit_type,
        previous_quantity: total_remaining, counted_quantity: counted, delta: 0,
        message: 'No change — counted quantity matches current stock',
      });
    }

    const opnameNote = note || `Stock opname: set to ${counted}`;

    db.transaction(() => {
      if (delta > 0) {
        // Use an explicit price if given, otherwise fall back to this product's
        // historical weighted-average unit price so costing stays accurate.
        let price;
        if (unit_price !== undefined && unit_price !== null && unit_price !== '') {
          price = parseFloat(unit_price);
        } else {
          const hist = db.prepare(`
            SELECT SUM(price) AS total_price, SUM(amount) AS total_amount
            FROM inventory_items WHERE product_id = ? AND amount > 0
          `).get(product_id);
          price = hist.total_amount > 0 ? hist.total_price / hist.total_amount : 0;
        }

        db.prepare(`
          INSERT INTO inventory_items (product_id, amount, remaining, price, date_of_purchase, source, note)
          VALUES (?, ?, ?, ?, ?, 'opname', ?)
        `).run(product_id, delta, delta, price * delta, date, opnameNote);
      } else {
        // Negative delta can never exceed total_remaining, so this always succeeds
        let toConsume = Math.abs(delta);
        const invRows = db.prepare(`
          SELECT id, remaining FROM inventory_items
          WHERE product_id = ? AND remaining > 0
          ORDER BY date_of_purchase ASC, created_at ASC
        `).all(product_id);

        for (const row of invRows) {
          if (toConsume <= 0.0001) break;
          const take = Math.min(toConsume, row.remaining);
          db.prepare('UPDATE inventory_items SET remaining = remaining - ? WHERE id = ?').run(take, row.id);
          toConsume -= take;
        }
      }

      db.prepare(`
        INSERT INTO stock_adjustments (product_id, quantity, note, date, type)
        VALUES (?, ?, ?, ?, 'opname')
      `).run(product_id, delta, opnameNote, date);
    })();

    res.status(201).json({
      product_id, product_name: product.name, unit_type: product.unit_type,
      previous_quantity: total_remaining, counted_quantity: counted, delta,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
