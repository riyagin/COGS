// Apply backend/schema.sql to the configured database (idempotent).
//   npm run db:migrate
require('../env');
const db = require('../db');

(async () => {
  await db.migrate();
  console.log(`Schema applied to ${process.env.DATABASE_URL ? 'Postgres (DATABASE_URL)' : 'local PGlite'}`);
  await db.close();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
