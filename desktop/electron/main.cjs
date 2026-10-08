// Electron entry: one window running the React UI, plus IPC handlers for the things a web
// page can't do on its own (local files, OCR, the encrypted API key).
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const store = require('./store.cjs');
const ocr = require('./ocr.cjs');

const DEV_URL = process.env.VITE_DEV_SERVER_URL;

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#eef0fb',
    title: 'COGS Desktop',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Links open in the browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (DEV_URL && url.startsWith(DEV_URL)) return;
    e.preventDefault();
  });

  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

const handle = (channel, fn) => ipcMain.handle(channel, (_event, ...args) => fn(...args));

handle('store:read', (name, fallback) => store.readJson(name, fallback));
handle('store:write', (name, value) => store.writeJson(name, value));
handle('image:save', bytes => store.saveImage(bytes));
handle('image:read', id => store.readImage(id));
handle('image:delete', id => store.deleteImage(id));
handle('ocr:local', bytes => ocr.readLocal(bytes));
handle('ocr:claude', request => ocr.readClaude(request));
handle('apikey:status', () => ({ hasKey: !!store.getApiKey(), model: ocr.MODEL }));
handle('apikey:set', key => store.setApiKey(key));
handle('app:info', () => ({ version: app.getVersion(), dataDir: store.root() }));
handle('app:open-data-dir', () => shell.openPath(store.root()));

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  await ocr.shutdown();
  if (process.platform !== 'darwin') app.quit();
});
