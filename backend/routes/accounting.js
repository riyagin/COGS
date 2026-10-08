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

// { name, type, code? }: the code is assigned (ledger.nextAccountCode) unless one is given.
// Retries a few times in case two people add an account of the same type at once.
router.post('/accounts', ah(async (req, res) => {
  const name = req.body.name?.trim();
  const { type } = req.body;
  if (!name) throw new HttpError(400, 'Name is required');
  if (!TYPES.includes(type)) throw new HttpError(400, `type must be one of ${TYPES.join(', ')}`);
  const wanted = req.body.code ? checkCode(String(req.body.code).trim(), type) : null;

  for (let attempt = 0; ; attempt++) {
    try {
      const code = wanted || await ledger.nextAccountCode(db, type);
      return res.status(201).json(await db.one(
        'INSERT INTO accounts (code, name, type) VALUES ($1, $2, $3) RETURNING *', [code, name, type]
      ));
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      if (wanted || attempt >= 3) throw new HttpError(409, 'That account code is already used');
    }
  }
}));

function checkCode(code, type) {
  if (!ledger.ACCOUNT_CODE.test(code)) throw new HttpError(400, 'Account codes are 6 digits');
  if (Number(code[0]) !== ledger.TYPE_PREFIX[type]) {
    throw new HttpError(400, `${type[0].toUpperCase() + type.slice(1)} account codes start with ${ledger.TYPE_PREFIX[type]}`);
  }
  return code;
}

// Rename / renumber / (de)activate. The app's own accounts stay active and keep their type.
router.patch('/accounts/:id', ah(async (req, res) => {
  const account = await db.one('SELECT * FROM accounts WHERE id = $1', [req.params.id]);
  if (!account) throw new HttpError(404, 'Account not found');
  if (account.system_key && req.body.active === false) {
    throw new HttpError(400, 'This account is used automatically by the app and can\'t be deactivated');
  }
  const code = req.body.code ? checkCode(String(req.body.code).trim(), account.type) : null;
  try {
    res.json(await db.one(`
      UPDATE accounts SET code = COALESCE($2, code), name = COALESCE($3, name), active = COALESCE($4, active)
      WHERE id = $1 RETURNING *
    `, [account.id, code, req.body.name?.trim() || null, req.body.active ?? null]));
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

// Profit & loss lives with the other reports (routes/reports.js); this path is kept for
// app builds that call it here
router.get('/pnl', ah(require('./reports').pnl));

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
