// Bookkeeping: chart of accounts, the journal, and the reports built from it.
// Most entries are posted automatically by purchases, production, sales and stock
// adjustments (see ledger.js); manual entries cover the rest (rent, wages, capital, ...).
const express = require('express');
const router = express.Router();
const db = require('../db');
const { ah, HttpError, isUniqueViolation } = require('../http');
const ledger = require('../ledger');

const TYPES = ['asset', 'liability', 'equity', 'revenue', 'cogs', 'expense'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Natural sign per type: assets and costs grow with debits, the rest with credits
const DEBIT_NORMAL = new Set(['asset', 'cogs', 'expense']);
const signed = (type, debit, credit) => (DEBIT_NORMAL.has(type) ? debit - credit : credit - debit);

function dateParam(v, name) {
  if (v === undefined || v === '') return null;
  if (!ISO_DATE.test(v)) throw new HttpError(400, `${name} must be YYYY-MM-DD`);
  return v;
}

// ── Accounts ─────────────────────────────────────────────────────────────────

router.get('/accounts', ah(async (req, res) => {
  const rows = await db.query(`
    SELECT a.*, COALESCE(SUM(l.debit), 0) AS debit, COALESCE(SUM(l.credit), 0) AS credit
    FROM accounts a
    LEFT JOIN journal_lines l ON l.account_id = a.id
    GROUP BY a.id
    ORDER BY a.code
  `);
  res.json(rows.map(a => ({ ...a, balance: signed(a.type, a.debit, a.credit) })));
}));

router.post('/accounts', ah(async (req, res) => {
  const code = req.body.code?.trim();
  const name = req.body.name?.trim();
  const { type } = req.body;
  if (!code || !name) throw new HttpError(400, 'Code and name are required');
  if (!TYPES.includes(type)) throw new HttpError(400, `type must be one of ${TYPES.join(', ')}`);
  try {
    res.status(201).json(await db.one(
      'INSERT INTO accounts (code, name, type) VALUES ($1, $2, $3) RETURNING *', [code, name, type]
    ));
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, 'That account code is already used');
    throw err;
  }
}));

// Rename / renumber / (de)activate. The app's own accounts stay active and keep their type.
router.patch('/accounts/:id', ah(async (req, res) => {
  const account = await db.one('SELECT * FROM accounts WHERE id = $1', [req.params.id]);
  if (!account) throw new HttpError(404, 'Account not found');
  if (account.system_key && req.body.active === false) {
    throw new HttpError(400, 'This account is used automatically by the app and can\'t be deactivated');
  }
  try {
    res.json(await db.one(`
      UPDATE accounts SET code = COALESCE($2, code), name = COALESCE($3, name), active = COALESCE($4, active)
      WHERE id = $1 RETURNING *
    `, [account.id, req.body.code?.trim() || null, req.body.name?.trim() || null, req.body.active ?? null]));
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, 'That account code is already used');
    throw err;
  }
}));

// ── Journal ──────────────────────────────────────────────────────────────────

// ?from&to&account_id&source_type — newest first, capped
router.get('/journal', ah(async (req, res) => {
  const from = dateParam(req.query.from, 'from');
  const to = dateParam(req.query.to, 'to');
  const accountId = req.query.account_id ? Number(req.query.account_id) : null;
  const sourceType = req.query.source_type || null;

  const entries = await db.query(`
    SELECT e.*, COALESCE(u.name, u.username) AS created_by_name
    FROM journal_entries e
    LEFT JOIN users u ON u.id = e.created_by
    WHERE ($1::text IS NULL OR e.date >= $1)
      AND ($2::text IS NULL OR e.date <= $2)
      AND ($3::int IS NULL OR EXISTS (SELECT 1 FROM journal_lines x WHERE x.entry_id = e.id AND x.account_id = $3))
      AND ($4::text IS NULL OR e.source_type = $4)
    ORDER BY e.date DESC, e.id DESC
    LIMIT 500
  `, [from, to, accountId, sourceType]);

  const lines = await db.query(`
    SELECT l.*, a.code AS account_code, a.name AS account_name, a.type AS account_type
    FROM journal_lines l JOIN accounts a ON a.id = l.account_id
    WHERE l.entry_id = ANY($1::int[])
    ORDER BY l.entry_id, (l.debit > 0) DESC, l.id
  `, [entries.map(e => e.id)]);

  const byEntry = new Map(entries.map(e => [e.id, { ...e, lines: [] }]));
  for (const l of lines) byEntry.get(l.entry_id).lines.push(l);
  res.json([...byEntry.values()]);
}));

// Manual entry: { date, memo, lines: [{ account_id, debit, credit, memo }] }
router.post('/journal', ah(async (req, res) => {
  const date = dateParam(req.body.date, 'date');
  if (!date) throw new HttpError(400, 'date is required');
  const lines = (req.body.lines || []).filter(l => Number(l.debit) || Number(l.credit));
  if (lines.length < 2) throw new HttpError(400, 'An entry needs at least two lines');
  if (lines.some(l => Number(l.debit) && Number(l.credit))) {
    throw new HttpError(400, 'A line is either a debit or a credit, not both');
  }

  const id = await db.tx(async t => {
    const accounts = await t.query('SELECT id, active FROM accounts WHERE id = ANY($1::int[])', [lines.map(l => Number(l.account_id))]);
    const active = new Map(accounts.map(a => [a.id, a.active]));
    if (lines.some(l => !active.get(Number(l.account_id)))) throw new HttpError(400, 'Every line needs an active account');

    return ledger.post(t, {
      date,
      memo: req.body.memo?.trim() || null,
      source_type: 'manual',
      created_by: req.user.id,
      merge: false,
      lines: lines.map(l => ({ account: Number(l.account_id), debit: l.debit, credit: l.credit, memo: l.memo?.trim() })),
    });
  });
  res.status(201).json({ id });
}));

// Only manual entries; the others belong to the record that posted them
router.delete('/journal/:id', ah(async (req, res) => {
  const entry = await db.one('SELECT * FROM journal_entries WHERE id = $1', [req.params.id]);
  if (!entry) throw new HttpError(404, 'Entry not found');
  if (entry.source_type !== 'manual') {
    throw new HttpError(400, 'This entry was made by the app; delete or correct the purchase, sale or adjustment it came from');
  }
  await db.query('DELETE FROM journal_entries WHERE id = $1', [entry.id]);
  res.json({ success: true });
}));

// ── Reports ──────────────────────────────────────────────────────────────────

// Every YYYY-MM from `from` to `to`
function monthsBetween(from, to) {
  const months = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ty, tm] = to.slice(0, 7).split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) { m = 1; y++; }
  }
  return months;
}

// Profit & loss for ?from&to (default: this month), per account and per month.
//   Revenue - Cost of goods sold = Gross profit;  Gross profit - Expenses = Net profit
router.get('/pnl', ah(async (req, res) => {
  const today = new Date().toLocaleDateString('en-CA');
  const from = dateParam(req.query.from, 'from') || `${today.slice(0, 7)}-01`;
  const to = dateParam(req.query.to, 'to') || today;
  if (from > to) throw new HttpError(400, '"from" must be before "to"');

  const rows = await db.query(`
    SELECT a.id, a.code, a.name, a.type, substr(e.date, 1, 7) AS month,
           SUM(l.debit) AS debit, SUM(l.credit) AS credit
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id
    JOIN accounts a ON a.id = l.account_id
    WHERE a.type IN ('revenue', 'cogs', 'expense') AND e.date >= $1 AND e.date <= $2
    GROUP BY a.id, a.code, a.name, a.type, month
    ORDER BY a.code
  `, [from, to]);

  const months = monthsBetween(from, to);
  const sections = { revenue: [], cogs: [], expense: [] };
  const byId = new Map();
  for (const r of rows) {
    if (!byId.has(r.id)) {
      const acc = { id: r.id, code: r.code, name: r.name, type: r.type, total: 0, by_month: {} };
      byId.set(r.id, acc);
      sections[r.type].push(acc);
    }
    const acc = byId.get(r.id);
    const amount = signed(r.type, r.debit, r.credit);
    acc.total += amount;
    acc.by_month[r.month] = (acc.by_month[r.month] || 0) + amount;
  }

  const sum = (list, month) => list.reduce((s, a) => s + (month ? a.by_month[month] || 0 : a.total), 0);
  const totalsFor = month => {
    const revenue = sum(sections.revenue, month);
    const cogs = sum(sections.cogs, month);
    const expense = sum(sections.expense, month);
    return { revenue, cogs, gross_profit: revenue - cogs, expense, net_profit: revenue - cogs - expense };
  };

  res.json({
    from, to, months, sections,
    totals: { ...totalsFor(null), by_month: Object.fromEntries(months.map(m => [m, totalsFor(m)])) },
  });
}));

// Balance sheet as of ?date (default today). Profit not yet moved to equity shows as
// "Retained earnings" so assets = liabilities + equity.
router.get('/balance-sheet', ah(async (req, res) => {
  const date = dateParam(req.query.date, 'date') || new Date().toLocaleDateString('en-CA');
  const rows = await db.query(`
    SELECT a.id, a.code, a.name, a.type, a.system_key,
           COALESCE(SUM(l.debit), 0) AS debit, COALESCE(SUM(l.credit), 0) AS credit
    FROM accounts a
    LEFT JOIN journal_lines l ON l.account_id = a.id
      AND l.entry_id IN (SELECT id FROM journal_entries WHERE date <= $1)
    GROUP BY a.id
    ORDER BY a.code
  `, [date]);

  const sections = { asset: [], liability: [], equity: [] };
  let earnings = 0;
  for (const r of rows) {
    const balance = signed(r.type, r.debit, r.credit);
    if (sections[r.type]) {
      if (Math.abs(balance) >= ledger.EPS || r.system_key) sections[r.type].push({ id: r.id, code: r.code, name: r.name, balance });
    } else {
      earnings += r.type === 'revenue' ? balance : -balance;
    }
  }
  sections.equity.push({ id: null, code: '', name: 'Retained earnings (profit to date)', balance: earnings });

  const total = list => list.reduce((s, a) => s + a.balance, 0);
  const assets = total(sections.asset);
  const liabilities = total(sections.liability);
  const equity = total(sections.equity);
  res.json({
    date, sections,
    totals: { assets, liabilities, equity, liabilities_and_equity: liabilities + equity, balanced: Math.abs(assets - liabilities - equity) < 1 },
  });
}));

module.exports = router;
