const express = require('express');
const router = express.Router();
const db = require('../db');
const { ah, HttpError } = require('../http');
const { lockProducts, consumeFifo } = require('../fifo');

// GET adjustment history (most recent first)
router.get('/', ah(async (req, res) => {
  res.json(await db.query(`
    SELECT a.*, p.name AS product_name, p.unit_type, COALESCE(u.name, u.username) AS created_by_name
    FROM stock_adjustments a
    JOIN products p ON a.product_id = p.id
    LEFT JOIN users u ON u.id = a.created_by
    ORDER BY a.date DESC, a.created_at DESC, a.id DESC
    LIMIT 200
  `));
}));

// GET current stock for all products
router.get('/stock', ah(async (req, res) => {
  res.json(await db.query(`
    SELECT
      p.id,
      p.name,
      p.unit_type,
      COALESCE(SUM(i.remaining), 0) AS total_remaining
    FROM products p
    LEFT JOIN inventory_items i ON p.id = i.product_id AND i.remaining > 0
    GROUP BY p.id, p.name, p.unit_type
    ORDER BY p.name
  `));
}));

// POST apply a manual adjustment
router.post('/', ah(async (req, res) => {
  const { product_id, quantity, note, date } = req.body;
  if (!product_id || quantity === undefined || quantity === null || !date) {
    return res.status(400).json({ error: 'product_id, quantity, and date are required' });
  }

  const qty = parseFloat(quantity);
  if (isNaN(qty) || qty === 0) {
    return res.status(400).json({ error: 'quantity must be a non-zero number' });
  }

  const product = await db.one('SELECT * FROM products WHERE id = $1', [product_id]);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const adjustmentId = await db.tx(async t => {
    if (qty > 0) {
      // Positive adjustment: add a zero-cost inventory entry
      await t.query(`
        INSERT INTO inventory_items (product_id, amount, remaining, price, date_of_purchase, source, note, created_by)
        VALUES ($1, $2, $2, 0, $3, 'adjustment', $4, $5)
      `, [product_id, qty, date, note || null, req.user.id]);
    } else {
      // Negative adjustment: FIFO consume from existing inventory
      const absQty = Math.abs(qty);
      await lockProducts(t, [product_id]);
      const { ok, available } = await consumeFifo(t, product_id, absQty);
      if (!ok) {
        throw new HttpError(400,
          `Insufficient stock. Need ${absQty}, have ${available.toFixed(4)} ${product.unit_type}`);
      }
    }

    const { id } = await t.one(`
      INSERT INTO stock_adjustments (product_id, quantity, note, date, created_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `, [product_id, qty, note || null, date, req.user.id]);
    return id;
  });

  res.status(201).json(await db.one(`
    SELECT a.*, p.name AS product_name, p.unit_type, COALESCE(u.name, u.username) AS created_by_name
    FROM stock_adjustments a
    JOIN products p ON a.product_id = p.id
    LEFT JOIN users u ON u.id = a.created_by
    WHERE a.id = $1
  `, [adjustmentId]));
}));

// POST apply a stock opname (physical count) — overwrites stock to the counted amount
router.post('/opname', ah(async (req, res) => {
  const { product_id, counted_quantity, date, note, unit_price } = req.body;
  if (!product_id || counted_quantity === undefined || counted_quantity === null || !date) {
    return res.status(400).json({ error: 'product_id, counted_quantity, and date are required' });
  }

  const counted = parseFloat(counted_quantity);
  if (isNaN(counted) || counted < 0) {
    return res.status(400).json({ error: 'counted_quantity must be a non-negative number' });
  }

  const product = await db.one('SELECT * FROM products WHERE id = $1', [product_id]);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const opnameNote = note || `Stock opname: set to ${counted}`;

  const result = await db.tx(async t => {
    // Lock before reading the total so the delta can't go stale under concurrent writes
    await lockProducts(t, [product_id]);

    const { total_remaining } = await t.one(`
      SELECT COALESCE(SUM(remaining), 0) AS total_remaining
      FROM inventory_items WHERE product_id = $1
    `, [product_id]);

    const delta = counted - total_remaining;
    if (Math.abs(delta) < 0.0001) return { total_remaining, delta: 0 };

    if (delta > 0) {
      // Use an explicit price if given, otherwise fall back to this product's
      // historical weighted-average unit price so costing stays accurate.
      let price;
      if (unit_price !== undefined && unit_price !== null && unit_price !== '') {
        price = parseFloat(unit_price);
      } else {
        const hist = await t.one(`
          SELECT SUM(price) AS total_price, SUM(amount) AS total_amount
          FROM inventory_items WHERE product_id = $1 AND amount > 0
        `, [product_id]);
        price = hist.total_amount > 0 ? hist.total_price / hist.total_amount : 0;
      }

      await t.query(`
        INSERT INTO inventory_items (product_id, amount, remaining, price, date_of_purchase, source, note, created_by)
        VALUES ($1, $2, $2, $3, $4, 'opname', $5, $6)
      `, [product_id, delta, price * delta, date, opnameNote, req.user.id]);
    } else {
      // Negative delta can never exceed total_remaining, so this always succeeds
      await consumeFifo(t, product_id, Math.abs(delta));
    }

    await t.query(`
      INSERT INTO stock_adjustments (product_id, quantity, note, date, type, created_by)
      VALUES ($1, $2, $3, $4, 'opname', $5)
    `, [product_id, delta, opnameNote, date, req.user.id]);

    return { total_remaining, delta };
  });

  const body = {
    product_id, product_name: product.name, unit_type: product.unit_type,
    previous_quantity: result.total_remaining, counted_quantity: counted, delta: result.delta,
  };
  if (result.delta === 0) {
    return res.json({ ...body, message: 'No change — counted quantity matches current stock' });
  }
  res.status(201).json(body);
}));

module.exports = router;
