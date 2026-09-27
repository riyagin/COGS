// Local development server. On Vercel the app is served by api/index.js instead.
require('./env');
const app = require('./app');

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`COGS Backend running on http://localhost:${PORT}`);
  console.log(process.env.DATABASE_URL ? 'Database: Postgres (DATABASE_URL)' : 'Database: local PGlite (backend/.pgdata)');
});
