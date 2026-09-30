// Stock corrections. Manual adjustments add or remove a quantity; opname sets stock to a
// physical count. Either way the difference is booked to "Inventory adjustments & waste":
// removed stock at its FIFO cost, found stock at the given or last known unit cost.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { ah, HttpError } = require('../http');
const { lockItems, consumeFifo, fallbackUnitCost } = require('../fifo');
const ledger = require('../ledger');

const ADJUSTMENT_SELECT = `
  SELECT a.*, i.name AS item_name, i.unit_type, i.tier, COALESCE(u.name, u.username) AS created_by_name
  FROM stock_adjustments a
  JOIN items i ON a.item_id = i.id
  LEFT JOIN users u ON u.id = a.created_by
`;

// GET adjustment history (most recent first)
router.get('/', ah(async (req, res) => {
  res.json(await db.query(`${ADJUSTMENT_SELECT} ORDER BY a.date DESC, a.created_at DESC, a.id DESC LIMIT 200`));
}));

// GET current stock for all items
router.get('/stock', ah(async (req, res) => {
  res.json(await db.query(`
    SELECT i.id, i.name, i.unit_type, i.tier, COALESCE(SUM(l.remaining), 0) AS total_remaining
    FROM items i
    LEFT JOIN inventory_items l ON i.id = l.item_id AND l.remaining > 0
    GROUP BY i.id, i.name, i.unit_type, i.tier
    ORDER BY CASE i.tier WHEN 'raw' THEN 0 WHEN 'preprocessed' THEN 1 ELSE 2 END, i.name
  `));
}));

// Move `delta` of an item in or out of stock and book it. Caller holds the item lock.
// Returns the adjustment id.
async function applyDelta(t, { item, delta, unitPrice, date, note, type, userId }) {
  let value;
  if (delta > 0) {
    const price = unitPrice ?? await fallbackUnitCost(t, item.id);
    value = price * delta;
    await t.query(`
      INSERT INTO inventory_items (item_id, amount, remaining, price, date_of_purchase, source, note, created_by)
      VALUES ($1, $2, $2, $3, $4, $5, $6, $7)
    `, [item.id, delta, value, date, type === 'opname' ? 'opname' : 'adjustment', note, userId]);
  } else {
    const { ok, available, cost } = await consumeFifo(t, item.id, -delta);
    if (!ok) {
      throw new HttpError(400, `Insufficient stock. Need ${-delta}, have ${available.toFixed(4)} ${item.unit_type}`);
    }
    value = -cost;
  }

  const { id } = await t.one(`
    INSERT INTO stock_adjustments (item_id, quantity, note, date, type, created_by)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
  `, [item.id, delta, note, date, type, userId]);

  // value > 0: stock found (a gain), value < 0: stock lost
  await ledger.post(t, {
    date,
    memo: `${type === 'opname' ? 'Stock count' : 'Stock adjustment'}: ${item.name} ${delta > 0 ? '+' : ''}${delta} ${item.unit_type}${note ? ` (${note})` : ''}`,
    source_type: 'adjustment',
    source_id: id,
    created_by: userId,
    lines: [
      { account: ledger.inventoryAccount(item.tier), debit: Math.max(value, 0), credit: Math.max(-value, 0) },
      { account: 'inventory_adjustments', debit: Math.max(-value, 0), credit: Math.max(value, 0) },
    ],
  });
  return id;
}

function optionalPrice(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(v);
  if (isNaN(n) || n < 0) throw new HttpError(400, 'unit_price must be zero or more');
  return n;
}

// POST apply a manual adjustment
router.post('/', ah(async (req, res) => {
  const { item_id, quantity, note, date } = req.body;
  if (!item_id || quantity === undefined || quantity === null || !date) {
    return res.status(400).json({ error: 'item_id, quantity, and date are required' });
  }

  const qty = parseFloat(quantity);
  if (isNaN(qty) || qty === 0) {
    return res.status(400).json({ error: 'quantity must be a non-zero number' });
  }

  const item = await db.one('SELECT * FROM items WHERE id = $1', [item_id]);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const adjustmentId = await db.tx(async t => {
    await lockItems(t, [item.id]);
    return applyDelta(t, {
      item, delta: qty, unitPrice: optionalPrice(req.body.unit_price),
      date, note: note || null, type: 'manual', userId: req.user.id,
    });
  });

  res.status(201).json(await db.one(`${ADJUSTMENT_SELECT} WHERE a.id = $1`, [adjustmentId]));
}));

// POST apply a stock opname (physical count) — overwrites stock to the counted amount
router.post('/opname', ah(async (req, res) => {
  const { item_id, counted_quantity, date, note } = req.body;
  if (!item_id || counted_quantity === undefined || counted_quantity === null || !date) {
    return res.status(400).json({ error: 'item_id, counted_quantity, and date are required' });
  }

  const counted = parseFloat(counted_quantity);
  if (isNaN(counted) || counted < 0) {
    return res.status(400).json({ error: 'counted_quantity must be a non-negative number' });
  }

  const item = await db.one('SELECT * FROM items WHERE id = $1', [item_id]);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const opnameNote = note || `Stock opname: set to ${counted}`;
  const unitPrice = optionalPrice(req.body.unit_price);

  const result = await db.tx(async t => {
    // Lock before reading the total so the delta can't go stale under concurrent writes
    await lockItems(t, [item.id]);

    const { total_remaining } = await t.one(`
      SELECT COALESCE(SUM(remaining), 0) AS total_remaining
      FROM inventory_items WHERE item_id = $1
    `, [item.id]);

    const delta = counted - total_remaining;
    if (Math.abs(delta) < 0.0001) return { total_remaining, delta: 0 };

    await applyDelta(t, { item, delta, unitPrice, date, note: opnameNote, type: 'opname', userId: req.user.id });
    return { total_remaining, delta };
  });

  const body = {
    item_id: item.id, item_name: item.name, unit_type: item.unit_type,
    previous_quantity: result.total_remaining, counted_quantity: counted, delta: result.delta,
  };
  if (result.delta === 0) {
    return res.json({ ...body, message: 'No change — counted quantity matches current stock' });
  }
  res.status(201).json(body);
}));

module.exports = router;
