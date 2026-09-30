// Purchasing: one purchase = one receipt from a supplier.
// Lines are stock (item_id + quantity: adds a lot at the price paid) or a straight expense
// (account_id, e.g. gas or delivery). Paid now from cash or bank, or left unpaid and
// settled later with /:id/pay. Every purchase and payment posts to the journal.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { ah, HttpError } = require('../http');
const { lockItems } = require('../fifo');
const ledger = require('../ledger');

const EPS = 0.0001;

async function withLines(q, purchases) {
  const lines = await q.query(`
    SELECT pl.*, i.name AS item_name, i.unit_type, i.tier,
           a.code AS account_code, a.name AS account_name,
           l.id AS lot_id, l.remaining AS lot_remaining
    FROM purchase_lines pl
    LEFT JOIN items i ON i.id = pl.item_id
    LEFT JOIN accounts a ON a.id = pl.account_id
    LEFT JOIN inventory_items l ON l.purchase_line_id = pl.id
    WHERE pl.purchase_id = ANY($1::int[])
    ORDER BY pl.id
  `, [purchases.map(p => p.id)]);
  return purchases.map(p => {
    const own = lines.filter(l => l.purchase_id === p.id);
    return {
      ...p,
      lines: own,
      // Once any of its stock has been used, a purchase can no longer be deleted
      stock_used: own.some(l => l.lot_id && l.lot_remaining < l.quantity - EPS),
    };
  });
}

const PURCHASE_SELECT = `
  SELECT p.*, a.name AS paid_from_name, COALESCE(u.name, u.username) AS created_by_name
  FROM purchases p
  LEFT JOIN accounts a ON a.id = p.paid_from_account_id
  LEFT JOIN users u ON u.id = p.created_by
`;

router.get('/', ah(async (req, res) => {
  const where = req.query.status === 'unpaid' ? 'WHERE p.paid_date IS NULL' : '';
  const purchases = await db.query(`${PURCHASE_SELECT} ${where} ORDER BY p.date DESC, p.id DESC LIMIT 500`);
  res.json(await withLines(db, purchases));
}));

// Previously used supplier names, for autocomplete
router.get('/suppliers', ah(async (req, res) => {
  const rows = await db.query(`
    SELECT supplier, MAX(date) AS last_date FROM purchases
    WHERE supplier IS NOT NULL AND supplier <> ''
    GROUP BY supplier ORDER BY MAX(date) DESC
  `);
  res.json(rows.map(r => r.supplier));
}));

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Accounts a purchase line may be booked to directly: expenses, and asset accounts the
// user added (e.g. equipment). Stock goes through items instead.
async function expenseAccount(t, id) {
  const a = await t.one('SELECT * FROM accounts WHERE id = $1', [id]);
  const ok = a && a.active && (['expense', 'cogs'].includes(a.type) || (a.type === 'asset' && !a.system_key));
  if (!ok) throw new HttpError(400, 'Expense lines must use an active expense account');
  return a;
}

router.post('/', ah(async (req, res) => {
  const { date, supplier, reference, note, payment } = req.body;
  const lines = req.body.lines || [];
  if (!ISO_DATE.test(date || '')) throw new HttpError(400, 'Date is required (YYYY-MM-DD)');
  if (!['cash', 'bank', 'unpaid'].includes(payment)) throw new HttpError(400, 'payment must be cash, bank or unpaid');
  if (lines.length === 0) throw new HttpError(400, 'Add at least one line');

  const parsed = lines.map((l, i) => {
    const amount = Number(l.amount);
    if (!(amount > 0)) throw new HttpError(400, `Line ${i + 1}: price must be positive`);
    if (l.item_id) {
      const quantity = Number(l.quantity);
      if (!(quantity > 0)) throw new HttpError(400, `Line ${i + 1}: quantity must be positive`);
      return { item_id: Number(l.item_id), quantity, amount, description: l.description?.trim() || null };
    }
    if (l.account_id) {
      return { account_id: Number(l.account_id), amount, description: l.description?.trim() || null, quantity: null };
    }
    throw new HttpError(400, `Line ${i + 1}: choose an item or an expense account`);
  });
  const total = parsed.reduce((s, l) => s + l.amount, 0);

  const id = await db.tx(async t => {
    const paidFrom = payment === 'unpaid'
      ? null
      : (await t.one('SELECT id FROM accounts WHERE system_key = $1', [payment])).id;

    const purchase = await t.one(`
      INSERT INTO purchases (date, supplier, reference, note, total, paid_date, paid_from_account_id, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id
    `, [date, supplier?.trim() || null, reference?.trim() || null, note?.trim() || null, total,
        payment === 'unpaid' ? null : date, paidFrom, req.user.id]);

    const debits = [];
    for (const l of parsed) {
      if (l.item_id) {
        const item = await t.one('SELECT * FROM items WHERE id = $1', [l.item_id]);
        if (!item) throw new HttpError(404, `Item not found (id ${l.item_id})`);
        const line = await t.one(`
          INSERT INTO purchase_lines (purchase_id, item_id, description, quantity, amount)
          VALUES ($1, $2, $3, $4, $5) RETURNING id
        `, [purchase.id, item.id, l.description, l.quantity, l.amount]);
        await t.query(`
          INSERT INTO inventory_items
            (item_id, amount, remaining, price, date_of_purchase, source, purchase_line_id, note, created_by)
          VALUES ($1, $2, $2, $3, $4, 'purchase', $5, $6, $7)
        `, [item.id, l.quantity, l.amount, date, line.id, supplier?.trim() || null, req.user.id]);
        debits.push({ account: ledger.inventoryAccount(item.tier), debit: l.amount });
      } else {
        const account = await expenseAccount(t, l.account_id);
        await t.query(`
          INSERT INTO purchase_lines (purchase_id, account_id, description, amount)
          VALUES ($1, $2, $3, $4)
        `, [purchase.id, account.id, l.description, l.amount]);
        debits.push({ account: account.id, debit: l.amount });
      }
    }

    await ledger.post(t, {
      date,
      memo: `Purchase${supplier?.trim() ? ` from ${supplier.trim()}` : ''}${reference?.trim() ? ` (${reference.trim()})` : ''}`,
      source_type: 'purchase',
      source_id: purchase.id,
      created_by: req.user.id,
      lines: [...debits, { account: ledger.PAYMENT_ACCOUNTS[payment], credit: total }],
    });
    return purchase.id;
  });

  const [purchase] = await withLines(db, await db.query(`${PURCHASE_SELECT} WHERE p.id = $1`, [id]));
  res.status(201).json(purchase);
}));

// Settle an unpaid purchase: { date, payment: 'cash' | 'bank' }
router.post('/:id/pay', ah(async (req, res) => {
  const { date, payment } = req.body;
  if (!ISO_DATE.test(date || '')) throw new HttpError(400, 'Payment date is required (YYYY-MM-DD)');
  if (!['cash', 'bank'].includes(payment)) throw new HttpError(400, 'payment must be cash or bank');

  await db.tx(async t => {
    const purchase = await t.one('SELECT * FROM purchases WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!purchase) throw new HttpError(404, 'Purchase not found');
    if (purchase.paid_date) throw new HttpError(400, 'This purchase is already paid');

    const { id: accountId } = await t.one('SELECT id FROM accounts WHERE system_key = $1', [payment]);
    await t.query('UPDATE purchases SET paid_date = $2, paid_from_account_id = $3 WHERE id = $1', [purchase.id, date, accountId]);
    await ledger.post(t, {
      date,
      memo: `Payment for purchase${purchase.supplier ? ` from ${purchase.supplier}` : ''}${purchase.reference ? ` (${purchase.reference})` : ''}`,
      source_type: 'purchase_payment',
      source_id: purchase.id,
      created_by: req.user.id,
      lines: [{ account: 'payable', debit: purchase.total }, { account: payment, credit: purchase.total }],
    });
  });

  const [purchase] = await withLines(db, await db.query(`${PURCHASE_SELECT} WHERE p.id = $1`, [req.params.id]));
  res.json(purchase);
}));

// Undo a purchase entered by mistake: only while none of its stock has been used
router.delete('/:id', ah(async (req, res) => {
  await db.tx(async t => {
    const purchase = await t.one('SELECT * FROM purchases WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!purchase) throw new HttpError(404, 'Purchase not found');

    const lots = await t.query(`
      SELECT l.id, l.item_id, l.amount, l.remaining
      FROM inventory_items l JOIN purchase_lines pl ON pl.id = l.purchase_line_id
      WHERE pl.purchase_id = $1
    `, [purchase.id]);
    await lockItems(t, lots.map(l => l.item_id));
    const fresh = await t.query('SELECT id, amount, remaining FROM inventory_items WHERE id = ANY($1::int[])', [lots.map(l => l.id)]);
    if (fresh.some(l => l.remaining < l.amount - EPS)) {
      throw new HttpError(409, 'Some stock from this purchase has already been used, so it can\'t be deleted. Correct it with a stock adjustment instead.');
    }

    await t.query('DELETE FROM inventory_items WHERE id = ANY($1::int[])', [lots.map(l => l.id)]);
    await ledger.unpost(t, 'purchase', purchase.id);
    await ledger.unpost(t, 'purchase_payment', purchase.id);
    await t.query('DELETE FROM purchases WHERE id = $1', [purchase.id]);
  });
  res.json({ success: true });
}));

module.exports = router;
