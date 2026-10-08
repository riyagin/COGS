// Local storage for the desktop app, kept in Electron's userData folder:
//   data/<name>.json   drafts and learned matches (receipt drafts, stock-move rows, aliases, settings)
//   receipts/<id>.jpg  receipt photos waiting for review
//   secrets.bin        the Anthropic API key, encrypted with the OS keychain (safeStorage)
// Nothing here is the source of truth: saved purchases and adjustments live in the database.
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = () => app.getPath('userData');
const dataDir = () => path.join(root(), 'data');
const imageDir = () => path.join(root(), 'receipts');
const secretsFile = () => path.join(root(), 'secrets.bin');

// Store names come from the renderer: allow only plain identifiers
const NAME = /^[a-z][a-z0-9-]{0,40}$/;
const IMAGE_ID = /^[a-f0-9]{40}$/;

function checkName(name) {
  if (!NAME.test(name)) throw new Error(`Invalid store name: ${name}`);
}

function readJson(name, fallback) {
  checkName(name);
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir(), `${name}.json`), 'utf8'));
  } catch {
    return fallback;
  }
}

// Write to a temp file and rename, so a crash mid-write can't leave half a JSON file
function writeJson(name, value) {
  checkName(name);
  fs.mkdirSync(dataDir(), { recursive: true });
  const file = path.join(dataDir(), `${name}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value));
  fs.renameSync(`${file}.tmp`, file);
}

// Receipt photos are stored by content hash, so adding the same photo twice is detectable
function saveImage(bytes) {
  const buf = Buffer.from(bytes);
  const id = crypto.createHash('sha1').update(buf).digest('hex');
  fs.mkdirSync(imageDir(), { recursive: true });
  const file = path.join(imageDir(), `${id}.jpg`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  return id;
}

function imagePath(id) {
  if (!IMAGE_ID.test(id)) throw new Error('Invalid image id');
  return path.join(imageDir(), `${id}.jpg`);
}

const readImage = id => fs.readFileSync(imagePath(id));

function deleteImage(id) {
  fs.rmSync(imagePath(id), { force: true });
}

function getApiKey() {
  try {
    const raw = fs.readFileSync(secretsFile());
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8');
  } catch {
    return '';
  }
}

function setApiKey(key) {
  const value = String(key || '').trim();
  if (!value) return fs.rmSync(secretsFile(), { force: true });
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value) : Buffer.from(value, 'utf8');
  fs.writeFileSync(secretsFile(), data);
}

module.exports = { readJson, writeJson, saveImage, readImage, deleteImage, getApiKey, setApiKey, root };
