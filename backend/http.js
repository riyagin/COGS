// Error with an HTTP status. Throwing one inside db.tx() also rolls the transaction back.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Postgres unique_violation
const isUniqueViolation = err => err && err.code === '23505';

// Express 4 doesn't catch async rejections; route them to the error handler.
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  // Postgres foreign_key_violation, e.g. deleting a product or recipe that history still uses
  if (err.code === '23503') {
    return res.status(409).json({ error: 'This record is still used by other data (inventory, recipes, productions or invoices) and cannot be deleted.' });
  }
  console.error(err);
  res.status(500).json({ error: err.message });
}

module.exports = { HttpError, isUniqueViolation, ah, errorHandler };
