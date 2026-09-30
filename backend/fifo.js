// FIFO stock consumption shared by production, invoices, adjustments and opname.
// Every function takes a transaction handle `t` from db.tx().

// Namespace for pg_advisory_xact_lock(ns, item_id), so item locks can't
// collide with any other advisory locks on the same database.
const ITEM_LOCK_NS = 7001;

// Serialize all stock movements per item. Call once at the start of a transaction
// with every item it will consume; locks are taken in sorted order to avoid deadlocks
// between e.g. a production run and an invoice touching the same items.
async function lockItems(t, itemIds) {
  const ids = [...new Set(itemIds.map(Number))].sort((a, b) => a - b);
  for (const id of ids) {
    await t.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [ITEM_LOCK_NS, id]);
  }
}

// Take `quantity` of an item from its oldest open lots. The caller must hold the
// item lock. Returns { ok, available, cost, takes }; on !ok nothing is written.
// Each take is { inventory_item_id, quantity, cost }.
async function consumeFifo(t, itemId, quantity) {
  const lots = await t.query(`
    SELECT id, remaining, price, amount
    FROM inventory_items
    WHERE item_id = $1 AND remaining > 0
    ORDER BY date_of_purchase ASC, created_at ASC, id ASC
    FOR UPDATE
  `, [itemId]);

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
    const takeCost = lot.amount > 0 ? take * (lot.price / lot.amount) : 0;
    cost += takeCost;
    takes.push({ inventory_item_id: lot.id, quantity: take, cost: takeCost });
    toConsume -= take;
  }

  for (const { inventory_item_id, quantity: take } of takes) {
    await t.query('UPDATE inventory_items SET remaining = remaining - $1 WHERE id = $2', [take, inventory_item_id]);
  }

  return { ok: true, available, cost, takes };
}

// Unit cost for stock that appears without a purchase (positive adjustments, opname):
// the last purchase price, else the last production cost, else the historical average.
async function fallbackUnitCost(t, itemId) {
  const last = await t.one(`
    SELECT price / amount AS unit_price
    FROM inventory_items
    WHERE item_id = $1 AND amount > 0 AND source IN ('purchase', 'production')
    ORDER BY (source = 'purchase') DESC, date_of_purchase DESC, created_at DESC, id DESC
    LIMIT 1
  `, [itemId]);
  if (last) return last.unit_price;
  const hist = await t.one(`
    SELECT SUM(price) AS total_price, SUM(amount) AS total_amount
    FROM inventory_items WHERE item_id = $1 AND amount > 0
  `, [itemId]);
  return hist.total_amount > 0 ? hist.total_price / hist.total_amount : 0;
}

module.exports = { lockItems, consumeFifo, fallbackUnitCost };
