const express = require('express');
const router = express.Router();
const db = require('../db');
const { ah, HttpError } = require('../http');
const { lockProducts, consumeFifo } = require('../fifo');

// GET /api/invoices — list all invoices with their items
router.get('/', ah(async (req, res) => {
  const invoices = await db.query(`
    SELECT inv.*, COALESCE(u.name, u.email) AS created_by_name
    FROM invoices inv
    LEFT JOIN users u ON u.id = inv.created_by
    ORDER BY inv.created_at DESC, inv.id DESC
  `);
  const items = await db.query(`
    SELECT ii.*, p.name AS product_name, p.unit_type
    FROM invoice_items ii
    LEFT JOIN products p ON p.id = ii.product_id
    ORDER BY ii.id
  `);

  const byInvoice = new Map(invoices.map(inv => [inv.id, { ...inv, items: [] }]));
  for (const item of items) byInvoice.get(item.invoice_id)?.items.push(item);

  res.json([...byInvoice.values()]);
}));

// POST /api/invoices — save a new invoice (FIFO-consumes inventory lots for sold products)
router.post('/', ah(async (req, res) => {
  const { invoice_num, customer_name, date, note,
          subtotal, discount_pct, discount, tax_rate,
          tax, total } = req.body;
  const items = req.body.items || [];

  const id = await db.tx(async t => {
    await lockProducts(t, items.filter(i => i.product_id).map(i => i.product_id));

    const invoice = await t.one(`
      INSERT INTO invoices
        (invoice_num, customer_name, date, note,
         subtotal, discount_pct, discount, tax_rate, tax, total, created_by)
      VALUES ($1, $2, $3, $4, COALESCE($5, 0), COALESCE($6, 0), COALESCE($7, 0), $8, COALESCE($9, 0), COALESCE($10, 0), $11)
      RETURNING id
    `, [invoice_num, customer_name, date, note,
        subtotal, discount_pct, discount, tax_rate, tax, total, req.user.id]);

    for (const item of items) {
      if (item.product_id) {
        const product = await t.one('SELECT * FROM products WHERE id = $1', [item.product_id]);
        if (!product) throw new HttpError(404, `Product not found (id ${item.product_id})`);
      }

      const { id: itemId } = await t.one(`
        INSERT INTO invoice_items
          (invoice_id, description, product_id, qty, unit_price, subtotal)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `, [invoice.id, item.description, item.product_id ?? null, item.qty, item.unit_price, item.subtotal]);

      if (!item.product_id) continue;

      const qty = Number(item.qty);
      const { ok, available, takes } = await consumeFifo(t, item.product_id, qty);
      if (!ok) {
        const product = await t.one('SELECT name, unit_type FROM products WHERE id = $1', [item.product_id]);
        throw new HttpError(400,
          `Insufficient stock for "${product.name}". Need ${qty.toFixed(4)}, short by ${(qty - available).toFixed(4)} ${product.unit_type}`);
      }

      for (const { inventory_item_id, quantity } of takes) {
        await t.query(
          'INSERT INTO invoice_item_consumptions (invoice_item_id, inventory_item_id, quantity) VALUES ($1, $2, $3)',
          [itemId, inventory_item_id, quantity]
        );
      }
    }

    return invoice.id;
  });

  res.status(201).json({ id });
}));

// DELETE /api/invoices/:id — restores FIFO-consumed inventory before removing the invoice
router.delete('/:id', ah(async (req, res) => {
  await db.tx(async t => {
    const consumptions = await t.query(`
      SELECT c.inventory_item_id, c.quantity, i.product_id
      FROM invoice_item_consumptions c
      JOIN invoice_items ii ON ii.id = c.invoice_item_id
      JOIN inventory_items i ON i.id = c.inventory_item_id
      WHERE ii.invoice_id = $1
    `, [req.params.id]);

    await lockProducts(t, consumptions.map(c => c.product_id));

    for (const { inventory_item_id, quantity } of consumptions) {
      await t.query('UPDATE inventory_items SET remaining = remaining + $1 WHERE id = $2', [quantity, inventory_item_id]);
    }

    await t.query('DELETE FROM invoices WHERE id = $1', [req.params.id]);
  });
  res.json({ ok: true });
}));

module.exports = router;
