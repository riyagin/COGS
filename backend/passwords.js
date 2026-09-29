// Password hashing with Node's built-in scrypt (no native modules, works on Vercel).
// Stored format: scrypt$N$r$p$<salt base64>$<hash base64>
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const PARAMS = { N: 32768, r: 8, p: 1 };
const KEY_LEN = 64;
const maxmem = n => 256 * n * PARAMS.r; // 2x the 128*N*r scrypt needs

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEY_LEN, { ...PARAMS, maxmem: maxmem(PARAMS.N) });
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(String(password).normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length,
    { N: Number(N), r: Number(r), p: Number(p), maxmem: maxmem(Number(N)) });
  return crypto.timingSafeEqual(key, expected);
}

// Checked against when the username doesn't exist, so a login takes the same time
// whether or not the account exists
let dummyHash = null;
const getDummyHash = () => (dummyHash ??= hashPassword(crypto.randomBytes(16).toString('hex')));

// Readable temporary password for new accounts and resets (no 0/O, 1/l/I look-alikes)
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generatePassword(length = 12) {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

const MIN_LENGTH = 8;
function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_LENGTH) return `Password must be at least ${MIN_LENGTH} characters`;
  if (password.length > 200) return 'Password is too long';
  return null;
}

module.exports = { hashPassword, verifyPassword, getDummyHash, generatePassword, passwordProblem };
