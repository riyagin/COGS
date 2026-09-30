// Save every table to a JSON file in backend/backups/ (git-ignored).
//   npm run db:backup
// Supabase's free plan has no automatic backups: run this before bulk changes.
require('../env');
const fs = require('fs');
const path = require('path');
const db = require('../db');

(async () => {
  // Whatever tables exist, so a backup taken before a migration (old layout) works too
  const tables = (await db.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `)).map(r => r.table_name);

  const data = { taken_at: new Date().toISOString(), tables: {} };
  for (const t of tables) {
    // Password hashes are left out: a backup file should never hold credentials
    const cols = t === 'users' ? 'id, username, name, role, active, created_at' : '*';
    data.tables[t] = await db.query(`SELECT ${cols} FROM "${t}" ORDER BY id`);
  }

  const dir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `backup-${data.taken_at.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));

  console.log(`Saved ${path.relative(process.cwd(), file)}`);
  for (const [t, rows] of Object.entries(data.tables)) console.log(`  ${t}: ${rows.length}`);
  await db.close();
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});
