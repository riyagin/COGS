// The renderer's only door to the main process: window.desktop.*
const { contextBridge, ipcRenderer } = require('electron');

const call = channel => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('desktop', {
  readStore: call('store:read'),
  writeStore: call('store:write'),
  saveImage: call('image:save'),
  readImage: call('image:read'),
  deleteImage: call('image:delete'),
  ocrLocal: call('ocr:local'),
  ocrClaude: call('ocr:claude'),
  apiKeyStatus: call('apikey:status'),
  setApiKey: call('apikey:set'),
  appInfo: call('app:info'),
  openDataDir: call('app:open-data-dir'),
});
