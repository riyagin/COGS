// Create an account (or reset an existing one's password) from the command line.
// Needed once to create the first admin, since the Users page requires an admin.
//   npm run user:create -- <username> [admin|staff|viewer] ["Display Name"]
//   npm run user:create -- <username> --reset
// Prints a one-time temporary password; the user must change it at first sign-in.
require('../env');
const db = require('../db');
const { ROLES } = require('../auth');
const { hashPassword, generatePassword } = require('../passwords');

(async () => {
  const [rawUsername, second, name] = process.argv.slice(2);
  const username = String(rawUsername || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    throw new Error('Usage: npm run user:create -- <username> [admin|staff|viewer] ["Display Name"]   (or <username> --reset)');
  }

  const temporaryPassword = generatePassword();
  const hash = await hashPassword(temporaryPassword);

  if (second === '--reset') {
    const user = await db.one(`
      UPDATE users SET password_hash = $2, must_change_password = true, token_version = token_version + 1,
                       failed_logins = 0, locked_until = NULL, active = true
      WHERE username = $1 RETURNING username, role
    `, [username, hash]);
    if (!user) throw new Error(`No user named "${username}"`);
    console.log(`Password reset for ${user.username} (${user.role}).`);
  } else {
    const role = second || 'admin';
    if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(', ')}`);
    const exists = await db.one('SELECT 1 FROM users WHERE username = $1', [username]);
    if (exists) throw new Error(`"${username}" already exists. Use --reset to give it a new temporary password.`);
    await db.query(
      'INSERT INTO users (username, name, role, password_hash, must_change_password) VALUES ($1, $2, $3, $4, true)',
      [username, name || null, role, hash]
    );
    console.log(`Created ${role} account "${username}".`);
  }

  console.log(`Temporary password: ${temporaryPassword}`);
  console.log('Sign in with it; you will be asked to choose your own password.');
  await db.close();
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});
