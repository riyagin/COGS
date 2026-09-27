// Load backend/.env into process.env for local scripts (Vercel injects env vars itself).
// Uses Node's built-in loader (Node >= 20.12); a missing file is fine.
try {
  process.loadEnvFile(require('path').join(__dirname, '.env'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}
