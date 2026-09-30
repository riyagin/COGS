// Products: what we sell. Each is made of one or more stocked items per unit sold,
// e.g. "Risoles SMB box of 10" = 10 x Risoles Smoke Beef Mayo + 1 x Box.
// Selling a product (see invoices.js) takes its components out of stock FIFO.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { ah, HttpError, isUniqueViolation } = require('../http');
const { loadBook, loadLastPrices, standardCosts } = require('../bom');

async function withComponents(q, products) {
  const components = await q.query(`
    SELECT pc.*, i.name AS item_name, i.unit_type, i.tier
    FROM product_components pc JOIN items i ON i.id = pc.item_id
    WHERE pc.product_id = ANY($1::int[])
    ORDER BY i.name
  `, [products.map(p => p.id)]);

  // Expected cost per unit sold, from current recipes and last prices
  const costOf = standardCosts(await loadBook(q), await loadLastPrices(q));

  return products.map(p => {
    const comps = components.filter(c => c.product_id === p.id).map(c => {
      const cost = costOf(c.item_id);
      return { ...c, unit_cost: cost.unit_cost, cost: c.quantity * cost.unit_cost, price_missing: cost.missing.length > 0 };
    });
    const est = comps.reduce((s, c) => s + c.cost, 0);
    return { ...p, components: comps, est_cost: est, price_missing: comps.some(c => c.price_missing) };
  });
}

router.get('/', ah(async (req, res) => {
  const products = await db.query('SELECT * FROM products ORDER BY active DESC, name');
  res.json(await withComponents(db, products));
}));

function parseBody(body) {
  const name = body.name?.trim();
  const unit = body.unit?.trim() || 'pcs';
  const sellPrice = body.sell_price === '' || body.sell_price == null ? null : Number(body.sell_price);
  const components = (body.components || []).map(c => ({ item_id: Number(c.item_id), quantity: Number(c.quantity) }));
  if (!name) throw new HttpError(400, 'Name is required');
  if (sellPrice !== null && !(sellPrice >= 0)) throw new HttpError(400, 'Selling price must be zero or more');
  if (components.length === 0) throw new HttpError(400, 'Add at least one item the product is made of');
  if (components.some(c => !c.item_id || !(c.quantity > 0))) throw new HttpError(400, 'Every component needs an item and a positive quantity');
  if (new Set(components.map(c => c.item_id)).size !== components.length) throw new HttpError(400, 'Each item can appear only once');
  return { name, unit, sellPrice, components, active: body.active !== false };
}

async function save(t, id, p) {
  await t.query('DELETE FROM product_components WHERE product_id = $1', [id]);
  for (const c of p.components) {
    await t.query('INSERT INTO product_components (product_id, item_id, quantity) VALUES ($1, $2, $3)', [id, c.item_id, c.quantity]);
  }
  const [product] = await withComponents(t, [await t.one('SELECT * FROM products WHERE id = $1', [id])]);
  return product;
}

const conflict = err => {
  if (isUniqueViolation(err)) throw new HttpError(409, 'A product with this name already exists');
  throw err;
};

router.post('/', ah(async (req, res) => {
  const p = parseBody(req.body);
  const product = await db.tx(async t => {
    const { id } = await t.one(
      'INSERT INTO products (name, unit, sell_price, active) VALUES ($1, $2, $3, $4) RETURNING id',
      [p.name, p.unit, p.sellPrice, p.active]
    );
    return save(t, id, p);
  }).catch(conflict);
  res.status(201).json(product);
}));

router.put('/:id', ah(async (req, res) => {
  const p = parseBody(req.body);
  const product = await db.tx(async t => {
    const rows = await t.query(
      'UPDATE products SET name = $2, unit = $3, sell_price = $4, active = $5 WHERE id = $1 RETURNING id',
      [req.params.id, p.name, p.unit, p.sellPrice, p.active]
    );
    if (rows.length === 0) throw new HttpError(404, 'Product not found');
    return save(t, rows[0].id, p);
  }).catch(conflict);
  res.json(product);
}));

router.delete('/:id', ah(async (req, res) => {
  const sold = await db.one('SELECT 1 FROM invoice_items WHERE product_id = $1 LIMIT 1', [req.params.id]);
  if (sold) throw new HttpError(409, 'This product has been sold; deactivate it instead of deleting');
  const rows = await db.query('DELETE FROM products WHERE id = $1 RETURNING id', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Product not found' });
  res.json({ success: true });
}));

module.exports = router;
