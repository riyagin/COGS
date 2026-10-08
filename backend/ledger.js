// Double-entry bookkeeping. Stock and money movements post journal entries here inside
// the same transaction as the movement itself, so the books can't drift from the stock.
//
// Accounts are referred to by their system_key ('cash', 'inventory_raw', ...; see the
// seed in schema.sql) or by numeric id.
const { HttpError } = require('./http');

// Money is DOUBLE PRECISION; anything below this is float noise, not a real amount
const EPS = 0.005;

const inventoryAccount = tier => `inventory_${tier}`;

// Payment choices offered on purchases and sales
const PAYMENT_ACCOUNTS = { cash: 'cash', bank: 'bank', unpaid: 'payable', receivable: 'receivable' };

async function resolveAccounts(t, refs) {
  const keys = [...new Set(refs.filter(r => typeof r === 'string'))];
  const ids = [...new Set(refs.filter(r => typeof r !== 'string').map(Number))];
  const rows = await t.query(
    'SELECT id, system_key, active FROM accounts WHERE system_key = ANY($1::text[]) OR id = ANY($2::int[])',
    [keys, ids]
  );
  const byKey = new Map(rows.filter(r => r.system_key).map(r => [r.system_key, r.id]));
  const byId = new Map(rows.map(r => [r.id, r]));
  return ref => {
    const id = typeof ref === 'string' ? byKey.get(ref) : (byId.has(Number(ref)) ? Number(ref) : undefined);
    if (id === undefined) throw new HttpError(400, `Unknown account: ${ref}`);
    return id;
  };
}

// Write one balanced entry. lines: [{ account, debit?, credit?, memo? }].
// merge (default, for app-made entries) nets each account to a single line and drops zeros;
// manual entries keep their lines as typed. Returns the entry id, or null if nothing moved.
async function post(t, { date, memo, source_type = 'manual', source_id = null, created_by = null, lines, merge = true }) {
  const resolve = await resolveAccounts(t, lines.map(l => l.account));

  let rows = lines.map(l => ({
    account_id: resolve(l.account),
    debit: Number(l.debit) || 0,
    credit: Number(l.credit) || 0,
    memo: l.memo || null,
  }));
  if (rows.some(r => !Number.isFinite(r.debit) || !Number.isFinite(r.credit) || r.debit < 0 || r.credit < 0)) {
    throw new HttpError(400, 'Journal amounts must be positive numbers');
  }

  if (merge) {
    const net = new Map();
    for (const r of rows) net.set(r.account_id, (net.get(r.account_id) || 0) + r.debit - r.credit);
    rows = [...net].map(([account_id, n]) => ({
      account_id, debit: n > 0 ? n : 0, credit: n < 0 ? -n : 0, memo: null,
    }));
  }
  rows = rows.filter(r => r.debit >= EPS || r.credit >= EPS);
  if (rows.length === 0) return null;

  const debits = rows.reduce((s, r) => s + r.debit, 0);
  const credits = rows.reduce((s, r) => s + r.credit, 0);
  if (Math.abs(debits - credits) >= EPS) {
    throw new HttpError(400, `Entry does not balance: debits ${debits.toFixed(2)} vs credits ${credits.toFixed(2)}`);
  }

  const { id } = await t.one(`
    INSERT INTO journal_entries (date, memo, source_type, source_id, created_by)
    VALUES ($1, $2, $3, $4, $5) RETURNING id
  `, [date, memo || null, source_type, source_id, created_by]);
  for (const r of rows) {
    await t.query(
      'INSERT INTO journal_lines (entry_id, account_id, debit, credit, memo) VALUES ($1, $2, $3, $4, $5)',
      [id, r.account_id, r.debit, r.credit, r.memo]
    );
  }
  return id;
}

// Many app-made entries at once, in three queries however many there are (bulk imports
// over a slow link). entries: [{ date, memo, source_type, source_id, created_by, lines }];
// each entry's lines are netted per account like post()'s merge. One entry per source_id.
async function postMany(t, entries) {
  if (entries.length === 0) return;
  const resolve = await resolveAccounts(t, entries.flatMap(e => e.lines.map(l => l.account)));

  const prepared = entries.map(e => {
    const net = new Map();
    for (const l of e.lines) {
      const id = resolve(l.account);
      net.set(id, (net.get(id) || 0) + (Number(l.debit) || 0) - (Number(l.credit) || 0));
    }
    const rows = [...net]
      .filter(([, n]) => Math.abs(n) >= EPS)
      .map(([account_id, n]) => ({ account_id, debit: n > 0 ? n : 0, credit: n < 0 ? -n : 0 }));
    const off = rows.reduce((s, r) => s + r.debit - r.credit, 0);
    if (!rows.every(r => Number.isFinite(r.debit) && Number.isFinite(r.credit)) || Math.abs(off) >= EPS) {
      throw new HttpError(400, `Entry "${e.memo}" does not balance (off by ${off.toFixed(2)})`);
    }
    return { ...e, rows };
  }).filter(e => e.rows.length > 0);
  if (prepared.length === 0) return;

  const created = await t.query(`
    INSERT INTO journal_entries (date, memo, source_type, source_id, created_by)
    SELECT date, memo, source_type, source_id, created_by
    FROM jsonb_to_recordset($1::jsonb) AS r(date text, memo text, source_type text, source_id int, created_by int)
    RETURNING id, source_type, source_id
  `, [JSON.stringify(prepared.map(({ date, memo, source_type, source_id, created_by }) =>
    ({ date, memo: memo || null, source_type, source_id, created_by: created_by ?? null })))]);

  const entryId = new Map(created.map(c => [`${c.source_type}:${c.source_id}`, c.id]));
  const lines = prepared.flatMap(e => e.rows.map(r => ({ entry_id: entryId.get(`${e.source_type}:${e.source_id}`), ...r })));
  await t.query(`
    INSERT INTO journal_lines (entry_id, account_id, debit, credit)
    SELECT entry_id, account_id, debit, credit
    FROM jsonb_to_recordset($1::jsonb) AS r(entry_id int, account_id int, debit float8, credit float8)
  `, [JSON.stringify(lines)]);
}

// Chart of accounts numbering: 6 digits, the first one is the type
const TYPE_PREFIX = { asset: 1, liability: 2, equity: 3, revenue: 4, cogs: 5, expense: 6 };
const ACCOUNT_CODE = /^[0-9]{6}$/;

// The next free code for a new account of `type`: the roundest one still free, so new
// accounts land on 660000, 670000, ... before 601000, 602000, ... before 600100, ...
async function nextAccountCode(t, type) {
  const prefix = TYPE_PREFIX[type];
  if (!prefix) throw new HttpError(400, `Unknown account type: ${type}`);
  const base = prefix * 100000;
  const used = new Set((await t.query(
    'SELECT code FROM accounts WHERE code >= $1 AND code <= $2', [String(base), String(base + 99999)]
  )).map(r => Number(r.code)));
  for (const step of [10000, 1000, 100, 10, 1]) {
    for (let code = base + step; code <= base + 99999; code += step) {
      if (!used.has(code)) return String(code);
    }
  }
  throw new HttpError(409, `No free account codes left for ${type} accounts`);
}

// Remove the entries a record posted (e.g. when a purchase or invoice is deleted)
async function unpost(t, source_type, source_id) {
  await t.query('DELETE FROM journal_entries WHERE source_type = $1 AND source_id = $2', [source_type, source_id]);
}

module.exports = { post, postMany, unpost, inventoryAccount, nextAccountCode, PAYMENT_ACCOUNTS, TYPE_PREFIX, ACCOUNT_CODE, EPS };
