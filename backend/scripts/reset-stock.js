// Set all stock to zero while keeping lot history (so last purchase prices remain).
//   npm run stock:reset                          preview only, changes nothing
//   npm run stock:reset -- --confirm --by <username> [--date YYYY-MM-DD]
//
// Every lot's `remaining` becomes 0; each product that had stock gets one stock_adjustments
// row of type 'reset' for the removed quantity, recorded as made by --by.
// Run `npm run db:backup` first.
require('../env');
const db = require('../db');
const { lockProducts } = require('../fifo');

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
    SELECT p.id, p.name, p.unit_type,
           SUM(i.remaining) AS qty,
           SUM(i.remaining * i.price / i.amount) AS value
    FROM inventory_items i JOIN products p ON p.id = i.product_id
    WHERE i.remaining > 0 AND i.amount > 0
    GROUP BY p.id, p.name, p.unit_type
    ORDER BY p.name
  `);

  const total = stock.reduce((s, r) => s + r.value, 0);
  console.log(`${stock.length} products have stock, total value ${rp(total)}:`);
  for (const r of stock) console.log(`  ${r.name}: ${r.qty} ${r.unit_type} (${rp(r.value)})`);

  if (!confirm) {
    console.log('\nPreview only. Re-run with --confirm --by <username> to reset.');
    return db.close();
  }

  const user = by && await db.one('SELECT id, username FROM users WHERE username = $1', [by.toLowerCase()]);
  if (!user) throw new Error('--by <username> is required and must be an existing user');

  const result = await db.tx(async t => {
    // Hold every affected product's stock lock so no sale or production lands mid-reset
    await lockProducts(t, stock.map(r => r.id));

    // Re-read under the lock; quantities may have moved since the preview
    const current = await t.query(`
      SELECT product_id, SUM(remaining) AS qty
      FROM inventory_items WHERE remaining > 0
      GROUP BY product_id
    `);
    for (const r of current) {
      await t.query(`
        INSERT INTO stock_adjustments (product_id, quantity, note, date, type, created_by)
        VALUES ($1, $2, $3, $4, 'reset', $5)
      `, [r.product_id, -r.qty, NOTE, date, user.id]);
    }
    const lots = await t.query('UPDATE inventory_items SET remaining = 0 WHERE remaining > 0 RETURNING id');
    return { products: current.length, lots: lots.length };
  });

  console.log(`\nReset done by ${user.username} on ${date}: ${result.lots} lots emptied, ${result.products} adjustment entries logged.`);
  await db.close();
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});
