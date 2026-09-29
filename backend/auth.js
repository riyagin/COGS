// Authentication and authorization for /api.
//
// Users sign in with username + password (routes/auth.js) and receive a signed session
// token, sent back as `Authorization: Bearer <token>`. Every request re-reads the user,
// so deactivating someone or resetting their password (which bumps token_version)
// ends their sessions immediately.
//
// Env:
//   AUTH_SECRET  random string, 32+ chars, signs session tokens.
//                Unset = sign-in off (local dev only; deployments refuse to run).
const db = require('./db');

const SECRET = process.env.AUTH_SECRET || '';
const ISSUER = 'cogs';
const TOKEN_TTL = '14d';

const ROLES = ['admin', 'staff', 'viewer'];
const DEV_USER = { id: null, username: 'dev', name: 'Local dev', role: 'admin', dev: true, must_change_password: false };

// Requests allowed while the user still has to replace a temporary password
const ALLOWED_BEFORE_PASSWORD_CHANGE = ['/me', '/auth/change-password'];

const authEnabled = !!SECRET;
const secretKey = () => new TextEncoder().encode(SECRET);

function configProblem() {
  if (!SECRET) {
    return (process.env.VERCEL || process.env.NODE_ENV === 'production')
      ? 'Sign-in is not configured (AUTH_SECRET missing)'
      : null;
  }
  return SECRET.length < 32 ? 'AUTH_SECRET must be at least 32 characters' : null;
}

async function signToken(user) {
  const { SignJWT } = await import('jose');
  return new SignJWT({ ver: user.token_version })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(user.id))
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(secretKey());
}

async function userFromToken(token) {
  const { jwtVerify } = await import('jose');
  let payload;
  try {
    ({ payload } = await jwtVerify(token, secretKey(), { issuer: ISSUER, algorithms: ['HS256'] }));
  } catch {
    return null;
  }
  const user = await db.one('SELECT * FROM users WHERE id = $1', [Number(payload.sub)]);
  if (!user || !user.active || user.token_version !== payload.ver) return null;
  return user;
}

// Fields safe to send to the browser
function publicUser(u) {
  const { id, username, name, role, must_change_password, dev } = u;
  return { id, username, name, role, must_change_password: !!must_change_password, dev: !!dev };
}

// Attaches req.user or rejects with 401 (not signed in / session ended).
async function authenticate(req, res, next) {
  try {
    const problem = configProblem();
    if (problem) return res.status(500).json({ error: problem });
    if (!authEnabled) {
      req.user = DEV_USER;
      return next();
    }

    const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const user = match && await userFromToken(match[1]);
    if (!user) return res.status(401).json({ error: 'Please sign in', code: 'signed_out' });

    req.user = user;
    if (user.must_change_password && !ALLOWED_BEFORE_PASSWORD_CHANGE.includes(req.path)) {
      return res.status(403).json({ error: 'Please choose a new password first', code: 'must_change_password' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Viewers may only read; staff and admins may write.
function requireWriteAccess(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || ['admin', 'staff'].includes(req.user.role)) return next();
  res.status(403).json({ error: 'Your role is read-only' });
}

function requireAdmin(req, res, next) {
  if (req.user.role === 'admin') return next();
  res.status(403).json({ error: 'Admins only' });
}

module.exports = {
  authenticate, requireWriteAccess, requireAdmin, signToken, publicUser, configProblem,
  ROLES, authEnabled,
};
