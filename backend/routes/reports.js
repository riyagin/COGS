// Financial reports for any range, split by day, week or month:
//   /pnl       profit & loss from the journal
//   /sales     sales from the café POS (pos_sales) and invoices, by period, product and payment
//   /expenses  expenses and cost of goods sold from the journal, plus stock bought
// Every report takes ?from&to&group (group: day | week | month | total) and ?format=csv.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { ah } = require('../http');
const { rangeParams, periodKey, periodsBetween } = require('../periods');

// Natural sign per type: costs grow with debits, revenue with credits
const DEBIT_NORMAL = new Set(['asset', 'cogs', 'expense']);
const signed = (type, debit, credit) => (DEBIT_NORMAL.has(type) ? debit - credit : credit - debit);

const sumBy = (list, f) => list.reduce((s, x) => s + f(x), 0);

// ── CSV ──────────────────────────────────────────────────────────────────────
// Plain numbers (no thousands dots) so spreadsheets read them as numbers

function sendCsv(res, name, rows) {
  const cell = v => {
    if (v == null) return '';
    if (typeof v === 'number') return String(Math.round(v * 100) / 100);
    const s = String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
  // BOM so Excel opens UTF-8 (é, Rp) correctly
  res.send('﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n'));
}

const periodHeader = periods => periods.length > 1 ? [...periods.map(p => p.key), 'Total'] : ['Total'];
const periodCells = (periods, byPeriod, total) =>
  periods.length > 1 ? [...periods.map(p => byPeriod[p.key] || 0), total] : [total];

// Journal amounts per account and period for the given account types
async function accountTotals(types, from, to, group) {
  const rows = await db.query(`
    SELECT a.id, a.code, a.name, a.type, e.date, SUM(l.debit) AS debit, SUM(l.credit) AS credit
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id
    JOIN accounts a ON a.id = l.account_id
    WHERE a.type = ANY($1::text[]) AND e.date >= $2 AND e.date <= $3
    GROUP BY a.id, a.code, a.name, a.type, e.date
    ORDER BY a.code
  `, [types, from, to]);

  const sections = Object.fromEntries(types.map(t => [t, []]));
  const byId = new Map();
  for (const r of rows) {
    if (!byId.has(r.id)) {
      const acc = { id: r.id, code: r.code, name: r.name, type: r.type, total: 0, by_period: {} };
      byId.set(r.id, acc);
      sections[r.type].push(acc);
    }
    const acc = byId.get(r.id);
    const amount = signed(r.type, r.debit, r.credit);
    const key = periodKey(r.date, group);
    acc.total += amount;
    acc.by_period[key] = (acc.by_period[key] || 0) + amount;
  }
  return sections;
}

const sectionSum = (list, key) => sumBy(list, a => (key ? a.by_period[key] || 0 : a.total));

// ── Profit & loss ────────────────────────────────────────────────────────────
//   Revenue - Cost of goods sold = Gross profit;  Gross profit - Expenses = Net profit

async function pnl(req, res) {
  const { from, to, group } = rangeParams(req.query);
  const periods = periodsBetween(from, to, group);
  const sections = await accountTotals(['revenue', 'cogs', 'expense'], from, to, group);

  const totalsFor = key => {
    const revenue = sectionSum(sections.revenue, key);
    const cogs = sectionSum(sections.cogs, key);
    const expense = sectionSum(sections.expense, key);
    return { revenue, cogs, gross_profit: revenue - cogs, expense, net_profit: revenue - cogs - expense };
  };
  const totals = { ...totalsFor(null), by_period: Object.fromEntries(periods.map(p => [p.key, totalsFor(p.key)])) };

  if (req.query.format === 'csv') {
    const rows = [['Profit & Loss', `${from} to ${to}`], [], ['Code', 'Account', ...periodHeader(periods)]];
    const block = (label, list, key, totalLabel) => {
      rows.push([label]);
      for (const a of list) rows.push([a.code, a.name, ...periodCells(periods, a.by_period, a.total)]);
      rows.push(['', totalLabel, ...periodCells(periods, Object.fromEntries(periods.map(p => [p.key, totals.by_period[p.key][key]])), totals[key])]);
    };
    const line = (label, key) => rows.push(['', label, ...periodCells(periods, Object.fromEntries(periods.map(p => [p.key, totals.by_period[p.key][key]])), totals[key])]);
    block('Revenue', sections.revenue, 'revenue', 'Total revenue');
    block('Cost of goods sold', sections.cogs, 'cogs', 'Total cost of goods sold');
    line('Gross profit', 'gross_profit');
    block('Expenses', sections.expense, 'expense', 'Total expenses');
    line('Net profit', 'net_profit');
    return sendCsv(res, `profit-loss_${from}_${to}`, rows);
  }

  // months/by_month: the shape app builds from before 2026-10 read
  const monthly = group === 'month';
  if (monthly) {
    for (const list of Object.values(sections)) for (const a of list) a.by_month = a.by_period;
    totals.by_month = totals.by_period;
  }
  res.json({ from, to, group, periods, sections, totals, months: monthly ? periods.map(p => p.key) : [] });
}

router.get('/pnl', ah(pnl));

// ── Sales ────────────────────────────────────────────────────────────────────
// Net sales = what customers paid, less tax. Matches revenue on the P&L.

router.get('/sales', ah(async (req, res) => {
  const { from, to, group } = rangeParams(req.query, 'day');
  const periods = periodsBetween(from, to, group);

  const [posSales, posLines, invoices, invoiceLines, posStatus] = await Promise.all([
    db.query(`
      SELECT id, business_day AS date, gross, discount, tax, total, payments
      FROM pos_sales WHERE status = 'PAID' AND business_day >= $1 AND business_day <= $2
    `, [from, to]),
    db.query(`
      SELECT l.product_name AS name, l.category, SUM(l.qty) AS qty, SUM(l.line_total) AS amount
      FROM pos_sale_lines l JOIN pos_sales s ON s.id = l.pos_sale_id
      WHERE s.status = 'PAID' AND s.business_day >= $1 AND s.business_day <= $2
      GROUP BY l.product_name, l.category
    `, [from, to]),
    db.query(`
      SELECT inv.id, inv.date, inv.subtotal AS gross, inv.discount, inv.tax, inv.total, a.name AS payment
      FROM invoices inv LEFT JOIN accounts a ON a.id = inv.payment_account_id
      WHERE inv.date >= $1 AND inv.date <= $2
    `, [from, to]),
    db.query(`
      SELECT COALESCE(p.name, ii.description) AS name, SUM(ii.qty) AS qty, SUM(ii.subtotal) AS amount
      FROM invoice_items ii
      JOIN invoices inv ON inv.id = ii.invoice_id
      LEFT JOIN products p ON p.id = ii.product_id
      WHERE inv.date >= $1 AND inv.date <= $2
      GROUP BY COALESCE(p.name, ii.description)
    `, [from, to]),
    db.one(`
      SELECT COUNT(*)::int AS count, MAX(synced_at) AS last_synced_at, MAX(business_day) AS last_business_day
      FROM pos_sales
    `),
  ]);

  const empty = () => ({ count: 0, gross: 0, discount: 0, tax: 0, total: 0, net: 0 });
  const add = (acc, s) => {
    acc.count += 1;
    acc.gross += s.gross;
    acc.discount += s.discount;
    acc.tax += s.tax;
    acc.total += s.total;
    acc.net += s.total - s.tax;
  };

  const byPeriod = Object.fromEntries(periods.map(p => [p.key, empty()]));
  const bySource = { pos: empty(), invoice: empty() };
  const totals = empty();
  const payments = new Map();
  const addPayment = (method, amount) => {
    const p = payments.get(method) || { method, amount: 0, count: 0 };
    p.amount += amount;
    p.count += 1;
    payments.set(method, p);
  };

  for (const s of posSales) {
    add(byPeriod[periodKey(s.date, group)], s);
    add(bySource.pos, s);
    add(totals, s);
    const paid = Array.isArray(s.payments) ? s.payments : [];
    if (paid.length === 0) addPayment('Cash', s.total);
    for (const p of paid) addPayment(p.method || 'Other', Number(p.amount) || 0);
  }
  for (const s of invoices) {
    add(byPeriod[periodKey(s.date, group)], s);
    add(bySource.invoice, s);
    add(totals, s);
    addPayment(s.payment || 'Not recorded', s.total);
  }

  const products = new Map();
  for (const [source, rows] of [['pos', posLines], ['invoice', invoiceLines]]) {
    for (const r of rows) {
      const key = `${source}:${r.name}`;
      products.set(key, { name: r.name, category: r.category || null, source, qty: r.qty, amount: r.amount });
    }
  }
  const byProduct = [...products.values()].sort((a, b) => b.amount - a.amount);
  const byPayment = [...payments.values()].sort((a, b) => b.amount - a.amount);

  if (req.query.format === 'csv') {
    const rows = [
      ['Sales', `${from} to ${to}`], [],
      ['Period', 'From', 'To', 'Sales', 'Gross', 'Discounts', 'Tax', 'Total paid', 'Net sales'],
      ...periods.map(p => {
        const v = byPeriod[p.key];
        return [p.key, p.from, p.to, v.count, v.gross, v.discount, v.tax, v.total, v.net];
      }),
      ['Total', from, to, totals.count, totals.gross, totals.discount, totals.tax, totals.total, totals.net],
      [], ['Product', 'Category', 'Source', 'Qty', 'Amount'],
      ...byProduct.map(p => [p.name, p.category, p.source === 'pos' ? 'Café POS' : 'Invoice', p.qty, p.amount]),
      [], ['Payment method', 'Payments', 'Amount'],
      ...byPayment.map(p => [p.method, p.count, p.amount]),
    ];
    return sendCsv(res, `sales_${from}_${to}`, rows);
  }

  res.json({
    from, to, group,
    periods: periods.map(p => ({ ...p, ...byPeriod[p.key] })),
    totals, by_source: bySource, by_product: byProduct, by_payment: byPayment,
    pos_status: posStatus,
  });
}));

// ── Expenses ─────────────────────────────────────────────────────────────────
// Operating expenses and cost of goods sold, per account. Stock bought is shown on its own:
// it is not a cost until the stock is used.

router.get('/expenses', ah(async (req, res) => {
  const { from, to, group } = rangeParams(req.query);
  const periods = periodsBetween(from, to, group);
  const [sections, stockRows] = await Promise.all([
    accountTotals(['expense', 'cogs'], from, to, group),
    db.query(`
      SELECT p.date, SUM(pl.amount) AS amount
      FROM purchase_lines pl JOIN purchases p ON p.id = pl.purchase_id
      WHERE pl.item_id IS NOT NULL AND p.date >= $1 AND p.date <= $2
      GROUP BY p.date
    `, [from, to]),
  ]);

  const stock = { total: 0, by_period: {} };
  for (const r of stockRows) {
    const key = periodKey(r.date, group);
    stock.total += r.amount;
    stock.by_period[key] = (stock.by_period[key] || 0) + r.amount;
  }

  const totalsFor = key => {
    const expense = sectionSum(sections.expense, key);
    const cogs = sectionSum(sections.cogs, key);
    return { expense, cogs, total: expense + cogs };
  };
  const totals = { ...totalsFor(null), by_period: Object.fromEntries(periods.map(p => [p.key, totalsFor(p.key)])) };

  if (req.query.format === 'csv') {
    const total = key => Object.fromEntries(periods.map(p => [p.key, totals.by_period[p.key][key]]));
    const rows = [['Expenses', `${from} to ${to}`], [], ['Code', 'Account', ...periodHeader(periods)], ['Operating expenses']];
    for (const a of sections.expense) rows.push([a.code, a.name, ...periodCells(periods, a.by_period, a.total)]);
    rows.push(['', 'Total operating expenses', ...periodCells(periods, total('expense'), totals.expense)], ['Cost of goods sold']);
    for (const a of sections.cogs) rows.push([a.code, a.name, ...periodCells(periods, a.by_period, a.total)]);
    rows.push(
      ['', 'Total cost of goods sold', ...periodCells(periods, total('cogs'), totals.cogs)],
      ['', 'Total costs', ...periodCells(periods, total('total'), totals.total)],
      [],
      ['', 'Stock bought (not a cost until used)', ...periodCells(periods, stock.by_period, stock.total)],
    );
    return sendCsv(res, `expenses_${from}_${to}`, rows);
  }

  res.json({ from, to, group, periods, sections, totals, stock_bought: stock });
}));

module.exports = router;
module.exports.pnl = pnl;
