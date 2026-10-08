// Other expenses: money spent that isn't stock (rent, wages, electricity, marketing...).
// Paid now from cash or bank, or left unpaid and settled later with /:id/pay, like purchases.
// Each expense and payment posts to the journal; editing one rewrites its entries.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { ah, HttpError } = require('../http');
const { dateParam } = require('../periods');
const ledger = require('../ledger');

const SELECT = `
  SELECT x.*, a.code AS account_code, a.name AS account_name,
         pa.name AS paid_from_name, pa.system_key AS paid_from_key, COALESCE(u.name, u.username) AS created_by_name
  FROM expenses x
  JOIN accounts a ON a.id = x.account_id
  LEFT JOIN accounts pa ON pa.id = x.paid_from_account_id
  LEFT JOIN users u ON u.id = x.created_by
`;

// ?from&to&account_id&status=unpaid — newest first
router.get('/', ah(async (req, res) => {
  const from = dateParam(req.query.from, 'from');
  const to = dateParam(req.query.to, 'to');
  const accountId = req.query.account_id ? Number(req.query.account_id) : null;
  const unpaid = req.query.status === 'unpaid';
  res.json(await db.query(`
    ${SELECT}
    WHERE ($1::text IS NULL OR x.date >= $1)
      AND ($2::text IS NULL OR x.date <= $2)
      AND ($3::int IS NULL OR x.account_id = $3)
      AND (NOT $4::boolean OR x.paid_date IS NULL)
    ORDER BY x.date DESC, x.id DESC
    LIMIT 1000
  `, [from, to, accountId, unpaid]));
}));

// Payees typed before, for autocomplete
router.get('/payees', ah(async (req, res) => {
  const rows = await db.query(`
    SELECT payee FROM expenses WHERE payee IS NOT NULL AND payee <> ''
    GROUP BY payee ORDER BY MAX(date) DESC LIMIT 200
  `);
  res.json(rows.map(r => r.payee));
}));

// { date, account_id, amount, payment: cash | bank | unpaid, payee?, description?, reference? }
function parse(body) {
  const date = dateParam(body.date, 'date');
  if (!date) throw new HttpError(400, 'Date is required');
  const amount = Number(body.amount);
  if (!(amount > 0)) throw new HttpError(400, 'Amount must be more than zero');
  if (!body.account_id) throw new HttpError(400, 'Choose what the expense was for');
  if (!['cash', 'bank', 'unpaid'].includes(body.payment)) throw new HttpError(400, 'payment must be cash, bank or unpaid');
  const text = v => (typeof v === 'string' && v.trim()) || null;
  return {
    date, amount, account_id: Number(body.account_id), payment: body.payment,
    payee: text(body.payee), description: text(body.description), reference: text(body.reference),
  };
}

async function expenseAccount(t, id) {
  const a = await t.one('SELECT * FROM accounts WHERE id = $1', [id]);
  if (!a || !a.active || !['expense', 'cogs'].includes(a.type)) {
    throw new HttpError(400, 'Choose an active expense account');
  }
  return a;
}

const memoOf = x => [x.description || 'Expense', x.payee && `to ${x.payee}`, x.reference && `(${x.reference})`]
  .filter(Boolean).join(' ');

// Write the expense's journal entries: the expense itself, and its payment if paid later
async function postEntries(t, x, userId) {
  await ledger.post(t, {
    date: x.date,
    memo: memoOf(x),
    source_type: 'expense',
    source_id: x.id,
    created_by: userId,
    lines: [
      { account: x.account_id, debit: x.amount },
      { account: x.paid_from_account_id && x.paid_date === x.date ? x.paid_from_account_id : 'payable', credit: x.amount },
    ],
  });
  if (x.paid_date && x.paid_date !== x.date) {
    await ledger.post(t, {
      date: x.paid_date,
      memo: `Payment: ${memoOf(x)}`,
      source_type: 'expense_payment',
      source_id: x.id,
      created_by: userId,
      lines: [{ account: 'payable', debit: x.amount }, { account: x.paid_from_account_id, credit: x.amount }],
    });
  }
}

async function unpostEntries(t, id) {
  await ledger.unpost(t, 'expense', id);
  await ledger.unpost(t, 'expense_payment', id);
}

const paidFromId = async (t, payment) =>
  payment === 'unpaid' ? null : (await t.one('SELECT id FROM accounts WHERE system_key = $1', [payment])).id;

router.post('/', ah(async (req, res) => {
  const x = parse(req.body);
  const id = await db.tx(async t => {
    await expenseAccount(t, x.account_id);
    const paidFrom = await paidFromId(t, x.payment);
    const row = await t.one(`
      INSERT INTO expenses (date, account_id, amount, payee, description, reference, paid_date, paid_from_account_id, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *
    `, [x.date, x.account_id, x.amount, x.payee, x.description, x.reference,
        paidFrom ? x.date : null, paidFrom, req.user.id]);
    await postEntries(t, row, req.user.id);
    return row.id;
  });
  res.status(201).json(await db.one(`${SELECT} WHERE x.id = $1`, [id]));
}));

// Correct an expense (same body as POST)
router.put('/:id', ah(async (req, res) => {
  const x = parse(req.body);
  await db.tx(async t => {
    const old = await t.one('SELECT * FROM expenses WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!old) throw new HttpError(404, 'Expense not found');
    await expenseAccount(t, x.account_id);

    // Paid on a later day: keep that day, unless the expense now comes after it
    const paidFrom = await paidFromId(t, x.payment);
    const paidLater = old.paid_date && old.paid_date !== old.date && old.paid_date >= x.date;
    const paidDate = !paidFrom ? null : paidLater ? old.paid_date : x.date;

    await unpostEntries(t, old.id);
    const row = await t.one(`
      UPDATE expenses SET date = $2, account_id = $3, amount = $4, payee = $5, description = $6, reference = $7,
                          paid_date = $8, paid_from_account_id = $9
      WHERE id = $1 RETURNING *
    `, [old.id, x.date, x.account_id, x.amount, x.payee, x.description, x.reference, paidDate, paidFrom]);
    await postEntries(t, row, req.user.id);
  });
  res.json(await db.one(`${SELECT} WHERE x.id = $1`, [req.params.id]));
}));

// Settle an unpaid expense: { date, payment: 'cash' | 'bank' }
router.post('/:id/pay', ah(async (req, res) => {
  const date = dateParam(req.body.date, 'date');
  if (!date) throw new HttpError(400, 'Payment date is required');
  if (!['cash', 'bank'].includes(req.body.payment)) throw new HttpError(400, 'payment must be cash or bank');

  await db.tx(async t => {
    const x = await t.one('SELECT * FROM expenses WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!x) throw new HttpError(404, 'Expense not found');
    if (x.paid_date) throw new HttpError(400, 'This expense is already paid');
    if (date < x.date) throw new HttpError(400, 'The payment can\'t be before the expense');
    const paidFrom = await paidFromId(t, req.body.payment);
    const row = await t.one(
      'UPDATE expenses SET paid_date = $2, paid_from_account_id = $3 WHERE id = $1 RETURNING *', [x.id, date, paidFrom]
    );
    await unpostEntries(t, x.id);
    await postEntries(t, row, req.user.id);
  });
  res.json(await db.one(`${SELECT} WHERE x.id = $1`, [req.params.id]));
}));

router.delete('/:id', ah(async (req, res) => {
  await db.tx(async t => {
    const x = await t.one('SELECT id FROM expenses WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!x) throw new HttpError(404, 'Expense not found');
    await unpostEntries(t, x.id);
    await t.query('DELETE FROM expenses WHERE id = $1', [x.id]);
  });
  res.json({ success: true });
}));

module.exports = router;
