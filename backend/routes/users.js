// Admin-only management of user accounts.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { ah, isUniqueViolation } = require('../http');
const { ROLES } = require('../auth');
const { hashPassword, generatePassword } = require('../passwords');
const { normalizeUsername } = require('./auth');

const COLUMNS = 'id, username, name, role, active, must_change_password, last_login_at, locked_until, created_at';
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

router.get('/', ah(async (req, res) => {
  res.json(await db.query(`SELECT ${COLUMNS} FROM users ORDER BY active DESC, role, username`));
}));

// Creates the account with a one-time temporary password, returned only in this response
router.post('/', ah(async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const role = req.body.role || 'staff';
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-32 characters: letters, numbers, dot, dash or underscore' });
  }
  if (!ROLES.includes(role)) return res.status(400).json({ error: `role must be one of ${ROLES.join(', ')}` });

  const temporaryPassword = generatePassword();
  try {
    const user = await db.one(`
      INSERT INTO users (username, name, role, password_hash, must_change_password)
      VALUES ($1, $2, $3, $4, true)
      RETURNING ${COLUMNS}
    `, [username, req.body.name?.trim() || null, role, await hashPassword(temporaryPassword)]);
    res.status(201).json({ ...user, temporary_password: temporaryPassword });
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: 'That username is taken' });
    throw err;
  }
}));

router.patch('/:id', ah(async (req, res) => {
  const { role, active, name } = req.body;
  if (role !== undefined && !ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of ${ROLES.join(', ')}` });
  }
  // Prevent an admin from locking themselves out
  if (Number(req.params.id) === req.user.id && ((role !== undefined && role !== 'admin') || active === false)) {
    return res.status(400).json({ error: 'You cannot remove your own admin access' });
  }

  const user = await db.one(`
    UPDATE users
    SET role   = COALESCE($2, role),
        active = COALESCE($3, active),
        name   = COALESCE($4, name),
        -- Deactivating ends the user's sessions right away
        token_version = token_version + CASE WHEN $3 = false THEN 1 ELSE 0 END
    WHERE id = $1
    RETURNING ${COLUMNS}
  `, [req.params.id, role ?? null, active ?? null, name?.trim() || null]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
}));

// New temporary password; signs the user out everywhere and clears any lockout
router.post('/:id/reset-password', ah(async (req, res) => {
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'Use "Change password" for your own account' });
  }
  const temporaryPassword = generatePassword();
  const user = await db.one(`
    UPDATE users
    SET password_hash = $2, must_change_password = true, token_version = token_version + 1,
        failed_logins = 0, locked_until = NULL
    WHERE id = $1
    RETURNING ${COLUMNS}
  `, [req.params.id, await hashPassword(temporaryPassword)]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ ...user, temporary_password: temporaryPassword });
}));

router.delete('/:id', ah(async (req, res) => {
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'You cannot remove yourself' });
  }
  // Users who recorded stock movements stay referenced by created_by; deactivate those instead
  const rows = await db.query('DELETE FROM users WHERE id = $1 RETURNING id', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ success: true });
}));

module.exports = router;
