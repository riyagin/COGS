const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /api/invoices — list all invoices with their items
router.get('/', (req, res) => {
  try {
    const invoices = db.prepare(`
      SELECT * FROM invoices ORDER BY created_at DESC
    `).all();

    const getItems = db.prepare(`
      SELECT ii.*, p.name as product_name, p.unit_type
      FROM invoice_items ii
      LEFT JOIN products p ON p.id = ii.product_id
      WHERE ii.invoice_id = ?
    `);

    const result = invoices.map(inv => ({
      ...inv,
      items: getItems.all(inv.id),
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/invoices — save a new invoice
router.post('/', (req, res) => {
  const { invoice_num, customer_name, date, note,
          subtotal, discount_pct, discount, tax_rate,
          tax, total, items } = req.body;

  const insertInvoice = db.prepare(`
    INSERT INTO invoices
      (invoice_num, customer_name, date, note,
       subtotal, discount_pct, discount, tax_rate, tax, total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertItem = db.prepare(`
    INSERT INTO invoice_items
      (invoice_id, description, product_id, qty, unit_price, subtotal)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const run = db.transaction(() => {
    const { lastInsertRowid } = insertInvoice.run(
      invoice_num, customer_name, date, note,
      subtotal, discount_pct, discount, tax_rate, tax, total
    );
    for (const item of items || []) {
      insertItem.run(
        lastInsertRowid,
        item.description,
        item.product_id ?? null,
        item.qty,
        item.unit_price,
        item.subtotal
      );
    }
    return lastInsertRowid;
  });

  try {
    const id = run();
    res.status(201).json({ id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/invoices/:id
router.delete('/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM invoices WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
