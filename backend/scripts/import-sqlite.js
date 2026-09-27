// One-off copy of the legacy SQLite database into Postgres, preserving ids.
//   npm run db:import-sqlite [-- path/to/cogs.db]
// Target is DATABASE_URL (or local PGlite if unset). Refuses to run if the target already has products.
require('../env');
const path = require('path');
const Database = require('better-sqlite3');
const db = require('../db');

// Parents before children so foreign keys hold
const TABLES = [
  'products',
  'recipes',
  'recipe_items',
  'productions',
  'inventory_items',
  'invoices',
  'invoice_items',
  'invoice_item_consumptions',
  'stock_adjustments',
];

// SQLite CURRENT_TIMESTAMP is UTC 'YYYY-MM-DD HH:MM:SS' with no zone marker
const toUtc = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) ? `${v}Z` : v);

(async () => {
  const file = process.argv[2] || path.join(__dirname, '..', 'cogs.db');
  const src = new Database(file, { readonly: true, fileMustExist: true });

  await db.migrate();
  const existing = await db.one('SELECT COUNT(*)::int AS n FROM products');
  if (existing.n > 0) {
    throw new Error('Target database already has products; refusing to import over existing data.');
  }

  await db.tx(async t => {
    for (const table of TABLES) {
      const targetCols = (await t.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1
      `, [table])).map(r => r.column_name);

      const exists = src.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      const rows = exists ? src.prepare(`SELECT * FROM ${table} ORDER BY id`).all() : [];
      if (rows.length === 0) {
        console.log(`${table}: 0 rows`);
        continue;
      }

      // Only copy columns both sides know about; older SQLite files may lack later columns
      const cols = Object.keys(rows[0]).filter(c => targetCols.includes(c));
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
      for (const row of rows) {
        await t.query(sql, cols.map(c => (c === 'created_at' ? toUtc(row[c]) : row[c])));
      }

      // Continue SERIAL ids after the imported ones
      await t.query(`SELECT setval(pg_get_serial_sequence($1, 'id'), (SELECT MAX(id) FROM ${table}))`, [table]);
      console.log(`${table}: ${rows.length} rows`);
    }
  });

  src.close();
  await db.close();
  console.log('Import complete.');
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});
