// Sign-in endpoints. `login` is public; `changePassword` runs after authenticate.
const db = require('../db');
const { ah } = require('../http');
const { signToken, publicUser, authEnabled, configProblem } = require('../auth');
const { hashPassword, verifyPassword, getDummyHash, passwordProblem } = require('../passwords');

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

const normalizeUsername = u => String(u || '').trim().toLowerCase();

// POST /api/auth/login { username, password } -> { token, user }
const login = ah(async (req, res) => {
  const problem = configProblem();
  if (problem) return res.status(500).json({ error: problem });
  if (!authEnabled) return res.status(400).json({ error: 'Sign-in is not enabled on this server' });

  const username = normalizeUsername(req.body.username);
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

  const user = await db.one('SELECT * FROM users WHERE username = $1', [username]);

  if (user?.locked_until && new Date(user.locked_until) > new Date()) {
    const minutes = Math.ceil((new Date(user.locked_until) - Date.now()) / 60_000);
    return res.status(429).json({ error: `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or ask an admin to reset it.` });
  }

  // Always run one scrypt check so response time doesn't reveal whether the username exists
  const ok = user
    ? await verifyPassword(password, user.password_hash)
    : (await verifyPassword(password, await getDummyHash()), false);

  if (!ok) {
    if (user) {
      // A lock that has already expired starts the count again
      const lockExpired = user.locked_until && new Date(user.locked_until) <= new Date();
      const failed = (lockExpired ? 0 : user.failed_logins) + 1;
      await db.query(`
        UPDATE users
        SET failed_logins = $2::int,
            locked_until = CASE WHEN $3::boolean THEN now() + make_interval(mins => $4::int) ELSE NULL END
        WHERE id = $1
      `, [user.id, failed, failed >= MAX_FAILED, LOCK_MINUTES]);
    }
    return res.status(401).json({ error: 'Wrong username or password' });
  }

  if (!user.active) return res.status(403).json({ error: 'This account has been deactivated. Ask an admin.' });

  const updated = await db.one(`
    UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now()
    WHERE id = $1 RETURNING *
  `, [user.id]);

  res.json({ token: await signToken(updated), user: publicUser(updated) });
});

// POST /api/auth/change-password { current_password, new_password } -> { token, user }
// Ends every other session (token_version bump) and hands back a fresh token.
const changePassword = ah(async (req, res) => {
  if (req.user.dev) return res.status(400).json({ error: 'Sign-in is not enabled on this server' });

  const { current_password, new_password } = req.body;
  const problem = passwordProblem(new_password);
  if (problem) return res.status(400).json({ error: problem });
  if (!(await verifyPassword(String(current_password || ''), req.user.password_hash))) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  if (await verifyPassword(new_password, req.user.password_hash)) {
    return res.status(400).json({ error: 'New password must be different from the current one' });
  }

  const updated = await db.one(`
    UPDATE users
    SET password_hash = $2, must_change_password = false, token_version = token_version + 1
    WHERE id = $1 RETURNING *
  `, [req.user.id, await hashPassword(new_password)]);

  res.json({ token: await signToken(updated), user: publicUser(updated) });
});

module.exports = { login, changePassword, normalizeUsername };
