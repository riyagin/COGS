// Database access. Two backends behind one small async API:
//   - DATABASE_URL set  -> real Postgres via `pg` (Supabase in production)
//   - otherwise         -> PGlite, an embedded Postgres stored in backend/.pgdata (local dev)
//
// API:
//   await db.query(sql, params)  -> rows[]
//   await db.one(sql, params)    -> first row or undefined
//   await db.tx(async t => ...)  -> runs fn in a transaction; t has query/one. Throw to roll back.
const fs = require('fs');
const path = require('path');

const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

let backendPromise = null;

function wrap(run) {
  const query = async (sql, params = []) => (await run(sql, params)).rows;
  const one = async (sql, params = []) => (await run(sql, params)).rows[0];
  return { query, one };
}

async function createPgBackend(url) {
  const { Pool } = require('pg');
  const parsed = new URL(url);
  const isLocal = ['localhost', '127.0.0.1'].includes(parsed.hostname);
  // Supabase certs are not in Node's default CA store; encrypt but don't verify the chain.
  // sslmode in the URL would override this object, so strip it.
  parsed.searchParams.delete('sslmode');
  const pool = new Pool({
    connectionString: parsed.toString(),
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX || 3), // serverless: keep per-instance pools small
    idleTimeoutMillis: 10_000,
  });

  return {
    ...wrap((sql, params) => pool.query(sql, params)),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap((sql, params) => client.query(sql, params)));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    migrate: () => pool.query(SCHEMA),
    close: () => pool.end(),
  };
}

async function createPgliteBackend(dir) {
  // Non-literal specifier: keeps Vercel's bundler from tracing this dev-only dependency
  const pgliteModule = '@electric-sql/pglite';
  const { PGlite } = await import(pgliteModule);
  const pg = new PGlite(dir);
  await pg.exec(SCHEMA);

  // PGlite is a single connection; serialize transactions so they can't interleave.
  let chain = Promise.resolve();
  return {
    ...wrap((sql, params) => pg.query(sql, params)),
    tx(fn) {
      const run = chain.then(() => pg.transaction(t => fn(wrap((sql, params) => t.query(sql, params)))));
      chain = run.catch(() => {});
      return run;
    },
    migrate: () => pg.exec(SCHEMA),
    close: () => pg.close(),
  };
}

function backend() {
  if (!backendPromise) {
    backendPromise = process.env.DATABASE_URL
      ? createPgBackend(process.env.DATABASE_URL)
      : createPgliteBackend(process.env.PGLITE_DIR || path.join(__dirname, '.pgdata'));
  }
  return backendPromise;
}

module.exports = {
  query: async (sql, params) => (await backend()).query(sql, params),
  one: async (sql, params) => (await backend()).one(sql, params),
  tx: async fn => (await backend()).tx(fn),
  migrate: async () => (await backend()).migrate(),
  close: async () => (await backend()).close(),
};
