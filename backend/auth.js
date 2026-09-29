// Authentication and authorization for /api.
//
// The frontend signs in with Google through Supabase Auth and sends the Supabase access
// token as `Authorization: Bearer <jwt>`. We verify the token, then look the email up in
// our own `users` allowlist, which decides access and role.
//
// Env:
//   SUPABASE_URL         https://<project-ref>.supabase.co   (unset = auth off, local dev only)
//   SUPABASE_JWT_SECRET  only for projects still on the legacy HS256 JWT secret
//   ADMIN_EMAILS         comma-separated; these emails are created as admins on first sign-in
//   AUTH_PROVIDERS       accepted sign-in providers, default "google"
const db = require('./db');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// Sign-in methods whose email we trust. Checked against app_metadata.providers, which only
// Supabase can set (user_metadata is user-editable and must never drive authorization).
const ALLOWED_PROVIDERS = (process.env.AUTH_PROVIDERS || 'google')
  .split(',').map(p => p.trim().toLowerCase()).filter(Boolean);

const ROLES = ['admin', 'staff', 'viewer'];
const DEV_USER = { id: null, email: 'dev@localhost', name: 'Local dev', role: 'admin', dev: true };

let jwks = null;

async function verifyToken(token) {
  const { jwtVerify, createRemoteJWKSet, decodeProtectedHeader } = await import('jose');
  const opts = { issuer: ISSUER, audience: 'authenticated' };

  if (decodeProtectedHeader(token).alg === 'HS256') {
    if (!process.env.SUPABASE_JWT_SECRET) throw new Error('HS256 token but SUPABASE_JWT_SECRET is not set');
    const secret = new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET);
    return (await jwtVerify(token, secret, opts)).payload;
  }

  // Asymmetric signing keys (current Supabase default), cached and refreshed by jose
  jwks ??= createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
  return (await jwtVerify(token, jwks, opts)).payload;
}

async function findOrBootstrapUser(email, claims) {
  let user = await db.one('SELECT * FROM users WHERE email = $1', [email]);
  if (!user && ADMIN_EMAILS.includes(email)) {
    user = await db.one(`
      INSERT INTO users (email, name, role) VALUES ($1, $2, 'admin')
      ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
      RETURNING *
    `, [email, claims.user_metadata?.full_name || null]);
  }
  if (!user) return null;

  // Record sign-in details, at most every few minutes so each request isn't a write
  if (!user.last_login_at || Date.now() - new Date(user.last_login_at).getTime() > 5 * 60_000) {
    user = await db.one(`
      UPDATE users
      SET last_login_at = now(),
          auth_user_id = COALESCE(auth_user_id, $2),
          name = COALESCE(name, $3)
      WHERE id = $1
      RETURNING *
    `, [user.id, claims.sub, claims.user_metadata?.full_name || null]);
  }
  return user;
}

// Attaches req.user or rejects with 401 (not signed in) / 403 (not on the allowlist).
async function authenticate(req, res, next) {
  try {
    if (!SUPABASE_URL) {
      // Never run open on a deployment; fail closed if auth was forgotten there
      if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
        return res.status(500).json({ error: 'Authentication is not configured (SUPABASE_URL missing)' });
      }
      req.user = DEV_USER;
      return next();
    }

    const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!match) return res.status(401).json({ error: 'Not signed in' });

    let claims;
    try {
      claims = await verifyToken(match[1]);
    } catch {
      return res.status(401).json({ error: 'Session expired or invalid, please sign in again' });
    }

    const providers = claims.app_metadata?.providers || [claims.app_metadata?.provider];
    if (!providers.some(p => ALLOWED_PROVIDERS.includes(p))) {
      return res.status(403).json({ error: `Please sign in with ${ALLOWED_PROVIDERS.join(' or ')}`, code: 'no_access' });
    }

    const email = String(claims.email || '').toLowerCase();
    const user = email && await findOrBootstrapUser(email, claims);
    if (!user || !user.active) {
      return res.status(403).json({ error: `${email || 'This account'} does not have access. Ask an admin to add you.`, code: 'no_access' });
    }

    req.user = user;
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

module.exports = { authenticate, requireWriteAccess, requireAdmin, ROLES, authEnabled: !!SUPABASE_URL };
