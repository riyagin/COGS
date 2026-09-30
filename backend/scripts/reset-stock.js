// Set all stock to zero while keeping lot history (so last purchase prices remain).
//   npm run stock:reset                          preview only, changes nothing
//   npm run stock:reset -- --confirm --by <username> [--date YYYY-MM-DD]
//
// Every lot's `remaining` becomes 0; each item that had stock gets one stock_adjustments
// row of type 'reset' for the removed quantity, recorded as made by --by, and the stock's
// value is booked out to "Inventory adjustments & waste" in one journal entry.
// Run `npm run db:backup` first.
require('../env');
const db = require('../db');
const { lockItems } = require('../fifo');
const ledger = require('../ledger');

const arg = name => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const confirm = process.argv.includes('--confirm');
const by = arg('--by');
const date = arg('--date') || new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time
const NOTE = 'Inventory reset to zero (last prices kept)';

const rp = n => 'Rp ' + Math.round(n).toLocaleString('id-ID');

(async () => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date must be YYYY-MM-DD');

  const stock = await db.query(`
    SELECT it.id, it.name, it.unit_type,
           SUM(l.remaining) AS qty,
           SUM(l.remaining * l.price / l.amount) AS value
    FROM inventory_items l JOIN items it ON it.id = l.item_id
    WHERE l.remaining > 0 AND l.amount > 0
    GROUP BY it.id, it.name, it.unit_type
    ORDER BY it.name
  `);

  const total = stock.reduce((s, r) => s + r.value, 0);
  console.log(`${stock.length} items have stock, total value ${rp(total)}:`);
  for (const r of stock) console.log(`  ${r.name}: ${r.qty} ${r.unit_type} (${rp(r.value)})`);

  if (!confirm) {
    console.log('\nPreview only. Re-run with --confirm --by <username> to reset.');
    return db.close();
  }

  const user = by && await db.one('SELECT id, username FROM users WHERE username = $1', [by.toLowerCase()]);
  if (!user) throw new Error('--by <username> is required and must be an existing user');

  const result = await db.tx(async t => {
    // Hold every affected item's stock lock so no sale or production lands mid-reset
    await lockItems(t, stock.map(r => r.id));

    // Re-read under the lock; quantities may have moved since the preview
    const current = await t.query(`
      SELECT l.item_id, it.tier, SUM(l.remaining) AS qty,
             SUM(CASE WHEN l.amount > 0 THEN l.remaining * l.price / l.amount ELSE 0 END) AS value
      FROM inventory_items l JOIN items it ON it.id = l.item_id
      WHERE l.remaining > 0
      GROUP BY l.item_id, it.tier
    `);
    for (const r of current) {
      await t.query(`
        INSERT INTO stock_adjustments (item_id, quantity, note, date, type, created_by)
        VALUES ($1, $2, $3, $4, 'reset', $5)
      `, [r.item_id, -r.qty, NOTE, date, user.id]);
    }
    const lots = await t.query('UPDATE inventory_items SET remaining = 0 WHERE remaining > 0 RETURNING id');

    const value = current.reduce((s, r) => s + r.value, 0);
    await ledger.post(t, {
      date,
      memo: NOTE,
      source_type: 'reset',
      created_by: user.id,
      lines: [
        ...current.map(r => ({ account: ledger.inventoryAccount(r.tier), credit: r.value })),
        { account: 'inventory_adjustments', debit: value },
      ],
    });
    return { items: current.length, lots: lots.length, value };
  });

  console.log(`\nReset done by ${user.username} on ${date}: ${result.lots} lots emptied, ${result.items} adjustment entries logged, ${rp(result.value)} written off.`);
  await db.close();
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});
