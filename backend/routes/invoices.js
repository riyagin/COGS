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

// POST /api/invoices — save a new invoice (FIFO-consumes inventory lots for sold products)
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

  const insertConsumption = db.prepare(`
    INSERT INTO invoice_item_consumptions (invoice_item_id, inventory_item_id, quantity)
    VALUES (?, ?, ?)
  `);

  const updateRemaining = db.prepare(`
    UPDATE inventory_items SET remaining = remaining - ? WHERE id = ?
  `);

  try {
    // Validate stock and plan FIFO consumptions per line item before writing anything
    const plans = [];
    for (const item of items || []) {
      if (!item.product_id) continue;

      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
      if (!product) return res.status(404).json({ error: `Product not found (id ${item.product_id})` });

      const invRows = db.prepare(`
        SELECT id, remaining
        FROM inventory_items
        WHERE product_id = ? AND remaining > 0
        ORDER BY date_of_purchase ASC, created_at ASC
      `).all(item.product_id);

      let toConsume = Number(item.qty);
      const consumptions = [];
      for (const inv of invRows) {
        if (toConsume <= 0.0001) break;
        const take = Math.min(toConsume, inv.remaining);
        consumptions.push({ inventory_item_id: inv.id, quantity: take });
        toConsume -= take;
      }

      if (toConsume > 0.0001) {
        return res.status(400).json({
          error: `Insufficient stock for "${product.name}". Need ${Number(item.qty).toFixed(4)}, short by ${toConsume.toFixed(4)} ${product.unit_type}`,
        });
      }

      plans.push({ item, consumptions });
    }

    const run = db.transaction(() => {
      const { lastInsertRowid } = insertInvoice.run(
        invoice_num, customer_name, date, note,
        subtotal, discount_pct, discount, tax_rate, tax, total
      );

      for (const item of items || []) {
        const { lastInsertRowid: itemId } = insertItem.run(
          lastInsertRowid,
          item.description,
          item.product_id ?? null,
          item.qty,
          item.unit_price,
          item.subtotal
        );

        const plan = plans.find(p => p.item === item);
        if (plan) {
          for (const { inventory_item_id, quantity } of plan.consumptions) {
            updateRemaining.run(quantity, inventory_item_id);
            insertConsumption.run(itemId, inventory_item_id, quantity);
          }
        }
      }

      return lastInsertRowid;
    });

    const id = run();
    res.status(201).json({ id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/invoices/:id — restores FIFO-consumed inventory before removing the invoice
router.delete('/:id', (req, res) => {
  try {
    const run = db.transaction(() => {
      const consumptions = db.prepare(`
        SELECT c.inventory_item_id, c.quantity
        FROM invoice_item_consumptions c
        JOIN invoice_items ii ON ii.id = c.invoice_item_id
        WHERE ii.invoice_id = ?
      `).all(req.params.id);

      const restoreRemaining = db.prepare(`
        UPDATE inventory_items SET remaining = remaining + ? WHERE id = ?
      `);
      for (const { inventory_item_id, quantity } of consumptions) {
        restoreRemaining.run(quantity, inventory_item_id);
      }

      db.prepare('DELETE FROM invoices WHERE id = ?').run(req.params.id);
    });
    run();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
