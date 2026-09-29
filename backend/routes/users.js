// Admin-only management of the sign-in allowlist.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { ah, isUniqueViolation } = require('../http');
const { ROLES } = require('../auth');

const COLUMNS = 'id, email, name, role, active, last_login_at, created_at';

router.get('/', ah(async (req, res) => {
  res.json(await db.query(`SELECT ${COLUMNS} FROM users ORDER BY active DESC, role, email`));
}));

router.post('/', ah(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const role = req.body.role || 'staff';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required' });
  }
  if (!ROLES.includes(role)) return res.status(400).json({ error: `role must be one of ${ROLES.join(', ')}` });

  try {
    const user = await db.one(
      `INSERT INTO users (email, name, role) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
      [email, req.body.name?.trim() || null, role]
    );
    res.status(201).json(user);
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: 'This email is already on the list' });
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
        name   = COALESCE($4, name)
    WHERE id = $1
    RETURNING ${COLUMNS}
  `, [req.params.id, role ?? null, active ?? null, name?.trim() || null]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
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
