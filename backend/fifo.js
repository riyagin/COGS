// FIFO stock consumption shared by production, invoices, adjustments and opname.
// Every function takes a transaction handle `t` from db.tx().

// Namespace for pg_advisory_xact_lock(ns, product_id), so product locks can't
// collide with any other advisory locks on the same database.
const PRODUCT_LOCK_NS = 7001;

// Serialize all stock movements per product. Call once at the start of a transaction
// with every product it will consume; locks are taken in sorted order to avoid deadlocks
// between e.g. a production run and an invoice touching the same products.
async function lockProducts(t, productIds) {
  const ids = [...new Set(productIds.map(Number))].sort((a, b) => a - b);
  for (const id of ids) {
    await t.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [PRODUCT_LOCK_NS, id]);
  }
}

// Take `quantity` of a product from its oldest open lots. The caller must hold the
// product lock. Returns { ok, available, cost, takes }; on !ok nothing is written.
async function consumeFifo(t, productId, quantity) {
  const lots = await t.query(`
    SELECT id, remaining, price, amount
    FROM inventory_items
    WHERE product_id = $1 AND remaining > 0
    ORDER BY date_of_purchase ASC, created_at ASC, id ASC
    FOR UPDATE
  `, [productId]);

  const available = lots.reduce((s, l) => s + l.remaining, 0);
  if (available < quantity - 0.0001) {
    return { ok: false, available, cost: 0, takes: [] };
  }

  let toConsume = quantity;
  let cost = 0;
  const takes = [];
  for (const lot of lots) {
    if (toConsume <= 0.0001) break;
    const take = Math.min(toConsume, lot.remaining);
    cost += take * (lot.price / lot.amount);
    takes.push({ inventory_item_id: lot.id, quantity: take });
    toConsume -= take;
  }

  for (const { inventory_item_id, quantity: take } of takes) {
    await t.query('UPDATE inventory_items SET remaining = remaining - $1 WHERE id = $2', [take, inventory_item_id]);
  }

  return { ok: true, available, cost, takes };
}

module.exports = { lockProducts, consumeFifo };
