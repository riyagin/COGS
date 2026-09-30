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

// Remove the entries a record posted (e.g. when a purchase or invoice is deleted)
async function unpost(t, source_type, source_id) {
  await t.query('DELETE FROM journal_entries WHERE source_type = $1 AND source_id = $2', [source_type, source_id]);
}

module.exports = { post, unpost, inventoryAccount, PAYMENT_ACCOUNTS, EPS };
