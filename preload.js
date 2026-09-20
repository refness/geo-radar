const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (partial) => ipcRenderer.invoke('config:set', partial),
  getQuota: () => ipcRenderer.invoke('quota:get'),
  onQuotaUpdate: (cb) => ipcRenderer.on('quota-update', (event, data) => cb(data)),
  getHistory: () => ipcRenderer.invoke('history:get'),
  openInMaps: (lat, lng) => ipcRenderer.send('shell:open-maps', lat, lng),
  onUpdateReady: (cb) => ipcRenderer.on('update-ready', () => cb()),
  installUpdate: () => ipcRenderer.send('app:install-update'),

  onScanStarted: (cb) => ipcRenderer.on('scan-started', () => cb()),
  onScanResult: (cb) => ipcRenderer.on('scan-result', (event, data) => cb(data)),
  onScanError: (cb) => ipcRenderer.on('scan-error', (event, err) => cb(err)),
  onScanTimeout: (cb) => ipcRenderer.on('scan-timeout', () => cb()),
  onScanCancelled: (cb) => ipcRenderer.on('scan-cancelled', () => cb()),
  onScanNoKey: (cb) => ipcRenderer.on('scan-no-key', () => cb()),
  onScanDebug: (cb) => ipcRenderer.on('scan-debug', (event, msg) => cb(msg)),

  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  openGoogleKeys: () => ipcRenderer.send('shell:open-google-keys'),

  getStorageInfo: () => ipcRenderer.invoke('storage:get-info'),
  chooseStorageDirectory: (dialogTitle) => ipcRenderer.invoke('storage:choose-and-set', dialogTitle),
  resetStorageDirectory: () => ipcRenderer.invoke('storage:reset-to-default'),

  clearHistory: () => ipcRenderer.invoke('data:clear-history'),
  clearApiKey: () => ipcRenderer.invoke('data:clear-api-key')
});
