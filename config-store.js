const Store = require('electron-store');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const SUPPORTED_LANGUAGES = ['ru', 'en', 'uk', 'de', 'es', 'pt', 'fr', 'pl'];

const DEFAULT_CONFIG = {
  language: 'en',
  hotkey: 'F8',
  cancelHotkey: 'F9',
  restartHotkey: 'F10',
  theme: 'dark',
  scanTimeoutMs: 30000, // covers trying several fallback Gemini models, not just one
  apiKey: '', // Google AI Studio key (generativelanguage.googleapis.com)
  scanCountDate: '',
  scanCountToday: 0,
  scanHistory: []
};

// The folder where the app stores its settings/key/history is itself USER-CONFIGURABLE
// (see changeStorageDirectory). But to know where to actually look for data on the next
// launch (a chicken-and-egg problem: the setting for "where to store settings" can't
// itself live at the location it points to), a tiny "beacon" file always lives in the
// fixed default system folder and just contains the path to the real folder.
const DEFAULT_USER_DATA_DIR = app.getPath('userData');
const BOOTSTRAP_FILE = path.join(DEFAULT_USER_DATA_DIR, 'storage-location.json');

function readCustomDir() {
  try {
    const raw = fs.readFileSync(BOOTSTRAP_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (data && typeof data.customDir === 'string' && data.customDir.trim()) {
      return data.customDir;
    }
  } catch (e) {
    // No file, or it's corrupt/from an old version — fall back to the default folder, that's normal.
  }
  return null;
}

const initialCustomDir = readCustomDir();
const store = new Store(
  initialCustomDir
    ? { defaults: DEFAULT_CONFIG, cwd: initialCustomDir }
    : { defaults: DEFAULT_CONFIG }
);

function detectSystemLanguage() {
  const primary = app.getLocale().split('-')[0].toLowerCase();
  return SUPPORTED_LANGUAGES.includes(primary) ? primary : 'en';
}

function detectSystemTheme() {
  const { nativeTheme } = require('electron');
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

// Called once at startup (after app.whenReady()). If the language/theme have
// never been explicitly saved yet (first launch), fills in the system ones —
// otherwise leaves whatever the user already picked in Settings.
function ensureSmartDefaults() {
  if (!store.has('language')) store.set('language', detectSystemLanguage());
  if (!store.has('theme')) store.set('theme', detectSystemTheme());
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function incrementScanCount() {
  const today = todayStr();
  if (store.get('scanCountDate') !== today) {
    store.set('scanCountDate', today);
    store.set('scanCountToday', 0);
  }
  const next = store.get('scanCountToday') + 1;
  store.set('scanCountToday', next);
  return next;
}

function getQuotaInfo() {
  const today = todayStr();
  const used = store.get('scanCountDate') === today ? store.get('scanCountToday') : 0;
  // Rough estimate of Google AI Studio's free-tier daily limit for Gemini 2.5 Flash.
  // The real value depends on the model/region/account — see aistudio.google.com.
  const limit = 1500;
  return { used, limit };
}

function addHistoryEntry(entry) {
  const history = store.get('scanHistory') || [];
  history.unshift({ ...entry, timestamp: Date.now() });
  store.set('scanHistory', history.slice(0, 10));
}

function clearHistory() {
  store.set('scanHistory', []);
}

function clearApiKey() {
  store.set('apiKey', '');
}

function getStorageInfo() {
  return {
    filePath: store.path,
    directory: path.dirname(store.path),
    isCustom: !!readCustomDir(),
    defaultDirectory: DEFAULT_USER_DATA_DIR
  };
}

function isDirectoryWritable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (e) {
    return false;
  }
}

// Migrates the current settings/key/history into the new folder and records the
// choice in the "beacon" file (which always lives in the default folder, see the
// comment above). Requires an app restart so electron-store reopens at the new
// path — the calling code (main.js) is responsible for app.relaunch()/app.exit()
// after success.
function changeStorageDirectory(newDir) {
  if (!newDir || typeof newDir !== 'string') {
    throw new Error('No folder was specified.');
  }
  if (!fs.existsSync(newDir) || !fs.statSync(newDir).isDirectory()) {
    throw new Error('The given path is not a folder, or it does not exist.');
  }
  if (!isDirectoryWritable(newDir)) {
    throw new Error('No write permission for the selected folder.');
  }
  if (path.resolve(newDir) === path.resolve(path.dirname(store.path))) {
    return; // already there — nothing to migrate
  }

  const currentData = { ...DEFAULT_CONFIG, ...store.store };
  const newStore = new Store({ defaults: DEFAULT_CONFIG, cwd: newDir });
  newStore.set(currentData);

  fs.writeFileSync(BOOTSTRAP_FILE, JSON.stringify({ customDir: newDir }, null, 2), 'utf-8');
}

// Moves storage back to the default system folder (migrating the data there too,
// so nothing is lost) and removes the beacon file. This also requires a restart.
function resetStorageDirectory() {
  const wasCustom = readCustomDir();
  if (wasCustom) {
    const currentData = { ...DEFAULT_CONFIG, ...store.store };
    const defaultStore = new Store({ defaults: DEFAULT_CONFIG, cwd: DEFAULT_USER_DATA_DIR });
    defaultStore.set(currentData);
  }
  try {
    fs.unlinkSync(BOOTSTRAP_FILE);
  } catch (e) {
    // wasn't there anyway — that's fine
  }
}

module.exports = {
  get: (key) => store.get(key),
  has: (key) => store.has(key),
  getAll: () => ({ ...DEFAULT_CONFIG, ...store.store }),
  setAll: (partial) => {
    for (const [key, value] of Object.entries(partial)) {
      store.set(key, value);
    }
  },
  ensureSmartDefaults,
  incrementScanCount,
  getQuotaInfo,
  addHistoryEntry,
  clearHistory,
  clearApiKey,
  getStorageInfo,
  changeStorageDirectory,
  resetStorageDirectory
};
