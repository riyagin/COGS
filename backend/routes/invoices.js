// Sales. Each line sells a product (or is free text); selling a product takes its component
// items out of stock FIFO and records which lots it drew from, so every sale has a true
// cost. Posts revenue and cost of goods sold to the journal.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { ah, HttpError } = require('../http');
const { lockItems, consumeFifo } = require('../fifo');
const ledger = require('../ledger');

// Invoices from the old POS store MM/DD/YYYY; everything else is YYYY-MM-DD
function isoDate(d) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return d;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d || '');
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  return null;
}

// GET /api/invoices — all invoices with their lines and the cost of what was sold
router.get('/', ah(async (req, res) => {
  const invoices = await db.query(`
    SELECT inv.*, a.name AS payment_account_name, COALESCE(u.name, u.username) AS created_by_name
    FROM invoices inv
    LEFT JOIN accounts a ON a.id = inv.payment_account_id
    LEFT JOIN users u ON u.id = inv.created_by
    ORDER BY inv.created_at DESC, inv.id DESC
  `);
  const items = await db.query(`
    SELECT ii.*, p.name AS product_name, p.unit,
           (SELECT SUM(c.quantity * l.price / l.amount)
            FROM invoice_item_consumptions c
            JOIN inventory_items l ON l.id = c.inventory_item_id AND l.amount > 0
            WHERE c.invoice_item_id = ii.id) AS cogs
    FROM invoice_items ii
    LEFT JOIN products p ON p.id = ii.product_id
    ORDER BY ii.id
  `);

  const byInvoice = new Map(invoices.map(inv => [inv.id, { ...inv, items: [], cogs: null }]));
  for (const item of items) {
    const inv = byInvoice.get(item.invoice_id);
    if (!inv) continue;
    inv.items.push(item);
    if (item.cogs != null) inv.cogs = (inv.cogs || 0) + item.cogs;
  }

  res.json([...byInvoice.values()]);
}));

// POST /api/invoices — record a sale
// { invoice_num, customer_name, date, note, discount_pct?, discount?, tax_rate?, tax?,
//   payment: 'cash' | 'bank' | 'receivable', items: [{ product_id?, description, qty, unit_price }] }
router.post('/', ah(async (req, res) => {
  const { invoice_num, customer_name, note, tax_rate } = req.body;
  const payment = req.body.payment || 'cash';
  if (!['cash', 'bank', 'receivable'].includes(payment)) throw new HttpError(400, 'payment must be cash, bank or receivable');
  const date = req.body.date ? isoDate(req.body.date) : new Date().toLocaleDateString('en-CA');
  if (!date) throw new HttpError(400, 'date must be YYYY-MM-DD');

  const lines = (req.body.items || []).map((i, n) => {
    const qty = Number(i.qty);
    const unitPrice = Number(i.unit_price);
    if (!(qty > 0) || !(unitPrice >= 0)) throw new HttpError(400, `Line ${n + 1}: quantity must be positive and price zero or more`);
    return { product_id: i.product_id ? Number(i.product_id) : null, description: i.description, qty, unit_price: unitPrice, subtotal: qty * unitPrice };
  });
  if (lines.length === 0) throw new HttpError(400, 'Add at least one line');

  // Totals are worked out here so the books always balance
  const subtotal = lines.reduce((s, l) => s + l.subtotal, 0);
  const discountPct = Number(req.body.discount_pct) || 0;
  const discount = req.body.discount != null && req.body.discount !== '' ? Number(req.body.discount) : subtotal * discountPct / 100;
  const tax = Number(req.body.tax) || 0;
  if (!(discount >= 0 && discount <= subtotal) || !(tax >= 0)) throw new HttpError(400, 'Discount and tax must be sensible amounts');
  const total = subtotal - discount + tax;

  const id = await db.tx(async t => {
    const productIds = [...new Set(lines.filter(l => l.product_id).map(l => l.product_id))];
    const components = await t.query(`
      SELECT pc.product_id, pc.item_id, pc.quantity, i.name AS item_name, i.unit_type, i.tier
      FROM product_components pc JOIN items i ON i.id = pc.item_id
      WHERE pc.product_id = ANY($1::int[])
    `, [productIds]);
    const products = new Map((await t.query('SELECT * FROM products WHERE id = ANY($1::int[])', [productIds])).map(p => [p.id, p]));
    for (const pid of productIds) {
      if (!products.has(pid)) throw new HttpError(404, `Product not found (id ${pid})`);
    }

    await lockItems(t, components.map(c => c.item_id));

    const invoice = await t.one(`
      INSERT INTO invoices
        (invoice_num, customer_name, date, note,
         subtotal, discount_pct, discount, tax_rate, tax, total, payment_account_id, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, (SELECT id FROM accounts WHERE system_key = $11), $12)
      RETURNING id
    `, [invoice_num || null, customer_name || null, date, note || null,
        subtotal, discountPct, discount, tax_rate ?? null, tax, total, payment, req.user.id]);

    const cogsCredits = [];
    for (const line of lines) {
      const product = line.product_id ? products.get(line.product_id) : null;
      const { id: itemId } = await t.one(`
        INSERT INTO invoice_items (invoice_id, description, product_id, qty, unit_price, subtotal)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `, [invoice.id, line.description || product?.name || '', line.product_id, line.qty, line.unit_price, line.subtotal]);

      if (!product) continue;
      for (const comp of components.filter(c => c.product_id === product.id)) {
        const needed = comp.quantity * line.qty;
        const { ok, available, takes } = await consumeFifo(t, comp.item_id, needed);
        if (!ok) {
          throw new HttpError(400,
            `Not enough "${comp.item_name}" for ${product.name}: need ${needed.toFixed(2)}, have ${available.toFixed(2)} ${comp.unit_type}`);
        }
        for (const take of takes) {
          await t.query(
            'INSERT INTO invoice_item_consumptions (invoice_item_id, inventory_item_id, quantity) VALUES ($1, $2, $3)',
            [itemId, take.inventory_item_id, take.quantity]
          );
          cogsCredits.push({ account: ledger.inventoryAccount(comp.tier), credit: take.cost });
        }
      }
    }

    const cogs = cogsCredits.reduce((s, c) => s + c.credit, 0);
    await ledger.post(t, {
      date,
      memo: `Sale${invoice_num ? ` ${invoice_num}` : ''}${customer_name ? ` to ${customer_name}` : ''}`,
      source_type: 'invoice',
      source_id: invoice.id,
      created_by: req.user.id,
      lines: [
        { account: ledger.PAYMENT_ACCOUNTS[payment], debit: total },
        { account: 'sales_discounts', debit: discount },
        { account: 'sales', credit: subtotal },
        { account: 'tax_payable', credit: tax },
        { account: 'cogs', debit: cogs },
        ...cogsCredits,
      ],
    });

    return invoice.id;
  });

  res.status(201).json({ id });
}));

// DELETE /api/invoices/:id — puts the sold stock back, removes the sale from the books
router.delete('/:id', ah(async (req, res) => {
  await db.tx(async t => {
    const consumptions = await t.query(`
      SELECT c.inventory_item_id, c.quantity, l.item_id
      FROM invoice_item_consumptions c
      JOIN invoice_items ii ON ii.id = c.invoice_item_id
      JOIN inventory_items l ON l.id = c.inventory_item_id
      WHERE ii.invoice_id = $1
    `, [req.params.id]);

    await lockItems(t, consumptions.map(c => c.item_id));

    for (const { inventory_item_id, quantity } of consumptions) {
      await t.query('UPDATE inventory_items SET remaining = remaining + $1 WHERE id = $2', [quantity, inventory_item_id]);
    }

    await ledger.unpost(t, 'invoice', Number(req.params.id));
    const rows = await t.query('DELETE FROM invoices WHERE id = $1 RETURNING id', [req.params.id]);
    if (rows.length === 0) throw new HttpError(404, 'Invoice not found');
  });
  res.json({ ok: true });
}));

module.exports = router;
