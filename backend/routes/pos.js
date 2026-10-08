// Café sales from the KSK POS. KSK Desktop reads its mirror of the counter tablet and pushes
// closed sales here; the server keeps them (pos_sales) and books each paid one:
//
//   Dr Cash (Tunai) / Bank (QRIS, transfer)   what was paid
//   Dr Sales discounts                        line + order discounts
//      Cr Sales - café                        the rest, less tax (rounding lands here)
//      Cr Tax payable                         tax included in the price
//
// Pushing is idempotent: a sale is keyed by its sale number, and re-sending one only
// rewrites it when its content changed (a void, for instance).
const crypto = require('node:crypto');
const express = require('express');
const router = express.Router();
const db = require('../db');
const { ah, HttpError } = require('../http');
const { ISO_DATE, dateParam } = require('../periods');
const ledger = require('../ledger');

const MAX_BATCH = 500;
const SOURCES = ['ksk'];

const money = (v, what) => {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) throw new HttpError(400, `${what} must be a number`);
  return n;
};
const text = v => (typeof v === 'string' && v.trim()) || null;

// One sale from the request into the row we store, with gross and discount worked out here
function normalize(s, i) {
  const where = `Sale ${s?.sale_number || s?.external_id || i + 1}`;
  if (!s || !text(String(s.external_id ?? ''))) throw new HttpError(400, `${where}: external_id is required`);
  if (!['PAID', 'VOID'].includes(s.status)) throw new HttpError(400, `${where}: status must be PAID or VOID`);
  if (!ISO_DATE.test(s.business_day || '')) throw new HttpError(400, `${where}: business_day must be YYYY-MM-DD`);

  const lines = (s.lines || []).map((l, n) => ({
    line_no: Number(l.line_no) || n + 1,
    product_code: text(l.product_code),
    product_name: text(l.product_name) || '(no name)',
    category: text(l.category),
    qty: money(l.qty, `${where} line ${n + 1} qty`),
    unit_price: money(l.unit_price, `${where} line ${n + 1} price`),
    discount: money(l.discount, `${where} line ${n + 1} discount`),
    line_total: money(l.line_total, `${where} line ${n + 1} total`),
    note: text(l.note),
  }));
  const payments = (s.payments || []).map((p, n) => ({
    method: text(p.method) || 'Tunai',
    kind: p.kind === 'CASH' ? 'CASH' : 'NON_CASH',
    amount: money(p.amount, `${where} payment ${n + 1}`),
  }));

  const sale = {
    external_id: String(s.external_id).trim(),
    sale_number: text(s.sale_number),
    business_day: s.business_day,
    closed_at_ms: s.closed_at ? money(s.closed_at, `${where} closed_at`) : null,
    status: s.status,
    gross: lines.reduce((sum, l) => sum + l.unit_price * l.qty, 0),
    discount: lines.reduce((sum, l) => sum + l.discount, 0) + money(s.order_discount, `${where} order discount`),
    rounding: money(s.rounding, `${where} rounding`),
    tax: money(s.tax, `${where} tax`),
    total: money(s.total, `${where} total`),
    payments,
    note: text(s.note),
    void_reason: text(s.void_reason),
    source_updated_at: Math.trunc(money(s.updated_at, `${where} updated_at`)),
    lines,
  };
  sale.content_hash = crypto.createHash('sha256').update(JSON.stringify(sale)).digest('hex').slice(0, 32);
  return sale;
}

function journalLines(sale) {
  const lines = [];
  const paid = sale.payments.filter(p => p.amount);
  if (paid.length === 0) lines.push({ account: 'cash', debit: sale.total });
  for (const p of paid) lines.push({ account: p.kind === 'CASH' ? 'cash' : 'bank', debit: p.amount });
  // Payments should add up to the total; if they don't, the first one takes the difference
  const diff = sale.total - paid.reduce((s, p) => s + p.amount, 0);
  if (paid.length > 0 && Math.abs(diff) >= ledger.EPS) {
    lines.push({ account: lines[0].account, debit: Math.max(diff, 0), credit: Math.max(-diff, 0) });
  }
  lines.push(
    { account: 'sales_discounts', debit: sale.discount },
    { account: 'sales_pos', credit: sale.total + sale.discount - sale.tax },
    { account: 'tax_payable', credit: sale.tax },
  );
  return lines;
}

// POST /api/pos/sync  { source: 'ksk', sales: [...] }  -> { received, created, updated, unchanged }
router.post('/sync', ah(async (req, res) => {
  const source = req.body.source || 'ksk';
  if (!SOURCES.includes(source)) throw new HttpError(400, `Unknown source: ${source}`);
  const incoming = req.body.sales;
  if (!Array.isArray(incoming)) throw new HttpError(400, 'sales must be a list');
  if (incoming.length > MAX_BATCH) throw new HttpError(413, `Send at most ${MAX_BATCH} sales at a time`);

  // Last copy wins if a batch repeats a sale
  const sales = [...new Map(incoming.map((s, i) => normalize(s, i)).map(s => [s.external_id, s])).values()];
  const result = { received: incoming.length, created: 0, updated: 0, unchanged: 0 };
  if (sales.length === 0) return res.json(result);

  await db.tx(async t => {
    // One sync at a time, so two PCs pushing the same sale can't double-book it
    await t.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pos_sync:${source}`]);

    const existing = new Map((await t.query(
      'SELECT id, external_id, content_hash FROM pos_sales WHERE source = $1 AND external_id = ANY($2::text[])',
      [source, sales.map(s => s.external_id)]
    )).map(r => [r.external_id, r]));

    const changed = sales.filter(s => existing.get(s.external_id)?.content_hash !== s.content_hash);
    result.unchanged = sales.length - changed.length;
    result.updated = changed.filter(s => existing.has(s.external_id)).length;
    result.created = changed.length - result.updated;
    if (changed.length === 0) return;

    const saved = await t.query(`
      INSERT INTO pos_sales (source, external_id, sale_number, business_day, closed_at, status, gross, discount,
                             rounding, tax, total, payments, note, void_reason, source_updated_at, content_hash,
                             synced_at, synced_by)
      SELECT $2, external_id, sale_number, business_day,
             CASE WHEN closed_at_ms IS NULL THEN NULL ELSE to_timestamp(closed_at_ms / 1000.0) END,
             status, gross, discount, rounding, tax, total, payments, note, void_reason, source_updated_at,
             content_hash, now(), $3
      FROM jsonb_to_recordset($1::jsonb) AS r(
        external_id text, sale_number text, business_day text, closed_at_ms float8, status text, gross float8,
        discount float8, rounding float8, tax float8, total float8, payments jsonb, note text, void_reason text,
        source_updated_at bigint, content_hash text)
      ON CONFLICT (source, external_id) DO UPDATE SET
        sale_number = EXCLUDED.sale_number, business_day = EXCLUDED.business_day, closed_at = EXCLUDED.closed_at,
        status = EXCLUDED.status, gross = EXCLUDED.gross, discount = EXCLUDED.discount,
        rounding = EXCLUDED.rounding, tax = EXCLUDED.tax, total = EXCLUDED.total, payments = EXCLUDED.payments,
        note = EXCLUDED.note, void_reason = EXCLUDED.void_reason, source_updated_at = EXCLUDED.source_updated_at,
        content_hash = EXCLUDED.content_hash, synced_at = now(), synced_by = EXCLUDED.synced_by
      RETURNING id, external_id
    `, [JSON.stringify(changed.map(({ lines, ...s }) => s)), source, req.user.id]);

    const idOf = new Map(saved.map(r => [r.external_id, r.id]));
    const ids = saved.map(r => r.id);
    await t.query('DELETE FROM pos_sale_lines WHERE pos_sale_id = ANY($1::int[])', [ids]);
    await t.query("DELETE FROM journal_entries WHERE source_type = 'pos_sale' AND source_id = ANY($1::int[])", [ids]);

    await t.query(`
      INSERT INTO pos_sale_lines (pos_sale_id, line_no, product_code, product_name, category, qty, unit_price,
                                  discount, line_total, note)
      SELECT pos_sale_id, line_no, product_code, product_name, category, qty, unit_price, discount, line_total, note
      FROM jsonb_to_recordset($1::jsonb) AS r(
        pos_sale_id int, line_no int, product_code text, product_name text, category text, qty float8,
        unit_price float8, discount float8, line_total float8, note text)
    `, [JSON.stringify(changed.flatMap(s => s.lines.map(l => ({ pos_sale_id: idOf.get(s.external_id), ...l }))))]);

    await ledger.postMany(t, changed.filter(s => s.status === 'PAID').map(s => ({
      date: s.business_day,
      memo: `Café sale ${s.sale_number || s.external_id}`,
      source_type: 'pos_sale',
      source_id: idOf.get(s.external_id),
      created_by: req.user.id,
      lines: journalLines(s),
    })));
  });

  res.json(result);
}));

// Where the server is up to: KSK Desktop sends sales changed since `watermark` (tablet
// updatedAt, epoch ms)
router.get('/status', ah(async (req, res) => {
  const source = req.query.source || 'ksk';
  res.json(await db.one(`
    SELECT COUNT(*)::int AS count,
           COUNT(*) FILTER (WHERE status = 'PAID')::int AS paid_count,
           COALESCE(SUM(total) FILTER (WHERE status = 'PAID'), 0) AS paid_total,
           COALESCE(MAX(source_updated_at), 0)::float8 AS watermark,
           MAX(business_day) AS last_business_day,
           MAX(synced_at) AS last_synced_at
    FROM pos_sales WHERE source = $1
  `, [source]));
}));

// ?from&to (business days) — the synced sales with their lines, newest first
router.get('/sales', ah(async (req, res) => {
  const from = dateParam(req.query.from, 'from');
  const to = dateParam(req.query.to, 'to');
  const sales = await db.query(`
    SELECT * FROM pos_sales
    WHERE ($1::text IS NULL OR business_day >= $1) AND ($2::text IS NULL OR business_day <= $2)
    ORDER BY business_day DESC, closed_at DESC NULLS LAST, id DESC
    LIMIT 1000
  `, [from, to]);
  const lines = await db.query(
    'SELECT * FROM pos_sale_lines WHERE pos_sale_id = ANY($1::int[]) ORDER BY pos_sale_id, line_no', [sales.map(s => s.id)]
  );
  const bySale = new Map(sales.map(s => [s.id, { ...s, lines: [] }]));
  for (const l of lines) bySale.get(l.pos_sale_id).lines.push(l);
  res.json([...bySale.values()]);
}));

module.exports = router;
