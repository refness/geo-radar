const { app, BrowserWindow, globalShortcut, desktopCapturer, screen, ipcMain, shell, Menu, dialog } = require('electron');
const path = require('path');
const store = require('./config-store');
const { autoUpdater } = require('electron-updater');

function getApiKey() {
  return process.env.GOOGLE_API_KEY || store.get('apiKey') || '';
}

// Google Gemini models via Google AI Studio (generativelanguage.googleapis.com).
// Each user's own key gets its own free quota (~1500 requests/day on the flash
// models as of this writing) — not a shared pool split across every user, the
// way it would be with free models routed through a middleman like OpenRouter
// (which we moved away from because of that exact shared-pool overload problem).
//
// Google updates its model lineup very often (2.5 -> 3.x within a few months,
// with individual versions cut off from new users without much warning). So the
// "floating" -latest aliases go first — Google itself points these at whatever
// it currently recommends, which has historically been more durable than a
// hard-pinned version number. The specific versions below are just a fallback
// in case something goes wrong with the aliases themselves.
const MODEL_CANDIDATES = [
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite'
];

let mainWindow = null;
const registeredHotkeys = { hotkey: null, cancelHotkey: null, restartHotkey: null };

let scanState = { active: false, abortController: null, timeoutHandle: null, deadline: null };

function sendDebug(msg) {
  console.log(`[GeoRadar] ${msg}`);
  if (mainWindow) mainWindow.webContents.send('scan-debug', msg);
}

const LANGUAGE_NAMES = {
  ru: 'Русский', en: 'English', uk: 'Українська', de: 'Deutsch',
  es: 'Español', pt: 'Português', fr: 'Français', pl: 'Polski'
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 560,
    height: 890,
    minWidth: 440,
    minHeight: 480,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    resizable: true,
    icon: path.join(__dirname, 'assets', 'icons', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  registerAllHotkeys();
}

function registerAllHotkeys() {
  registerOneHotkey('hotkey', () => runScan());
  registerOneHotkey('cancelHotkey', () => cancelScan('user'));
  registerOneHotkey('restartHotkey', () => restartScan());
}

function registerOneHotkey(configKey, handler) {
  const accelerator = store.get(configKey);
  const previous = registeredHotkeys[configKey];
  if (previous) globalShortcut.unregister(previous);

  const ok = globalShortcut.register(accelerator, handler);
  registeredHotkeys[configKey] = ok ? accelerator : null;
  if (!ok) console.error(`[HOTKEY] Failed to register "${accelerator}" for "${configKey}".`);
}

async function captureScreen() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.size;

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(width * primaryDisplay.scaleFactor),
      height: Math.round(height * primaryDisplay.scaleFactor)
    }
  });

  const source = sources.find(s => s.display_id === String(primaryDisplay.id)) || sources[0];
  if (!source) throw new Error('Could not find a screen source to capture.');
  return source.thumbnail;
}

// Quick check that Google AI actually responds BEFORE burning the whole scan timeout on it.
// If a network/firewall/VPN is blocking generativelanguage.googleapis.com, we find out in 5s instead of 20-60.
async function preflightCheck() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('preflight-timeout'), 5000);
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': getApiKey() },
      signal: controller.signal
    });
    // A 400/401 here means "the service is up, but the key is invalid/expired" — that's NOT a
    // network problem, so we still count it as "the service responded" (we surface the key
    // error separately later, with its own clear message).
    return { ok: res.status < 500, status: res.status };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  } finally {
    clearTimeout(timer);
  }
}

async function askOneModel(modelName, base64Data, prompt, signal, timeoutMs) {
  const localController = new AbortController();
  const onParentAbort = () => localController.abort(signal.reason);
  signal.addEventListener('abort', onParentAbort);
  const localTimer = setTimeout(() => localController.abort('model-timeout'), timeoutMs);

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': getApiKey() },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: 'image/jpeg', data: base64Data } }
            ]
          }],
          generationConfig: { temperature: 0.2 }
        }),
        signal: localController.signal
      }
    );

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      const err = new Error(`${modelName}: HTTP ${res.status} ${errBody.slice(0, 150)}`);
      err.status = res.status;
      throw err;
    }

    const json = await res.json();
    const rawText = json?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    if (!rawText) {
      const blockReason = json?.promptFeedback?.blockReason;
      throw new Error(`${modelName} returned an empty response${blockReason ? ` (blockReason: ${blockReason})` : ''}`);
    }

    const match = rawText.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`${modelName} did not return JSON. Response: ${rawText.slice(0, 100)}`);
    return JSON.parse(match[0]);
  } catch (err) {
    if (localController.signal.aborted && localController.signal.reason === 'model-timeout') {
      throw new Error(`${modelName} did not respond within ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(localTimer);
    signal.removeEventListener('abort', onParentAbort);
  }
}

async function askAI(nativeImg, langCode, signal) {
  const langName = LANGUAGE_NAMES[langCode] || 'English';

  const resized = nativeImg.resize({ width: 1600, height: 900 });
  const base64Data = resized.toJPEG(92).toString('base64');

  const prompt = `
You are a world-class expert at identifying exactly where a photograph was taken, purely from subtle visual clues — the same kind of careful deduction used in competitive photo-location-guessing games, with sharp attention to detail.

STEP 1 - READ FIRST: Carefully scan the entire image for any visible text: road signs, street name plates, license plates, storefront signs, billboards, warning signs, kilometer posts, and the Google Street View watermark/copyright text in the corners. Transcribe every legible piece of text to yourself, even partial or blurry text, since a single letter or word (language, alphabet, plate format, area code) is often the strongest clue.

STEP 2 - VISUAL CHECKLIST: Go through this list explicitly, noting what you observe for each:
- Road centerline/edge line color and style (e.g. yellow center line vs white, dashed pattern)
- Road surface color and texture (asphalt shade, concrete slabs, chip-seal)
- Utility/power poles: material (wood, concrete, metal lattice), transformer style, pole-mounted equipment
- Guardrails and bollards: shape, color, reflector style (a very strong country-level signal)
- License plate shape, color, and character format (if any vehicle is visible)
- Driving side (left-hand or right-hand traffic)
- Architecture style, roof shapes, building materials, fencing style
- Vegetation and terrain (biome, soil color, tree species) as a climate/latitude hint
- Sun position and shadow direction/length (rough hemisphere and time hint)
- Any Google Street View camera generation artifacts or car model reflections

STEP 3 - REASON: Combine both steps. If text/alphabet was found, treat it as the primary disambiguator over purely visual guesses.

Provide the final analysis in LANGUAGE: ${langName}.
Output ONLY pure valid JSON between { and }, no extra text before or after.
Fields must appear in this exact order (reasoning first, so you think before committing to an answer):
{
  "reasoning": "2-4 sentences in ${langName}: what text you read (if any) and which checklist items were most decisive",
  "country": "Country name in ${langName}",
  "region": "Region / State / City in ${langName}",
  "lat": 0.0,
  "lng": 0.0,
  "radius_km": 50,
  "clues": "2-3 short visual clues in ${langName}, prioritizing any text you read",
  "confidence": "high | medium | low",
  "alternatives": ["Country - Region in ${langName}", "Country - Region in ${langName}"]
}

Rules:
- radius_km guide: 10-50 for exact town, 100-300 for state/region, 500-1200 for country only.
- confidence = "high" only if you read identifying text (place name, area code, plate format) or recognize an unmistakable landmark. Otherwise use "medium" or "low".
- If confidence is not "high", widen radius_km accordingly and fill "alternatives" with 1-2 other plausible guesses.
- If confidence is "high", "alternatives" should be an empty array.
- Never invent precise lat/lng you are not reasonably sure of — if unsure, use the centroid of your best-guess region and a larger radius_km instead of a fabricated exact point.
`.trim();

  let lastError = null;
  const remainingCandidates = [...MODEL_CANDIDATES];
  while (remainingCandidates.length > 0) {
    if (signal.aborted) throw new Error('aborted');
    const modelName = remainingCandidates.shift();

    // Split the time remaining until the overall timeout evenly across the remaining
    // candidates, with a 6s floor and a 20s ceiling per model.
    const remainingBudget = scanState.deadline ? scanState.deadline - Date.now() : 15000;
    const perModelTimeoutMs = Math.max(6000, Math.min(20000, Math.floor(remainingBudget / (remainingCandidates.length + 1))));

    sendDebug(`Trying model: ${modelName} (budget ${Math.round(perModelTimeoutMs / 1000)}s)`);
    try {
      const result = await askOneModel(modelName, base64Data, prompt, signal, perModelTimeoutMs);
      sendDebug(`✓ Got a successful response from: ${modelName}`);
      return result;
    } catch (err) {
      if (signal.aborted) throw err; // overall timeout/cancellation — stop trying further candidates immediately
      lastError = err;
      sendDebug(`✗ ${modelName}: ${err.message}`);
      continue;
    }
  }
  throw new Error(
    `Gemini is unavailable. Last error: ${lastError ? lastError.message : 'unknown'}`
  );
}

async function runScan() {
  if (!mainWindow || scanState.active) return;

  if (!getApiKey()) {
    mainWindow.webContents.send('scan-no-key');
    return;
  }

  const abortController = new AbortController();
  scanState.active = true;
  scanState.abortController = abortController;

  mainWindow.webContents.send('scan-started');

  const timeoutMs = store.get('scanTimeoutMs') || 30000;
  scanState.deadline = Date.now() + timeoutMs;
  scanState.timeoutHandle = setTimeout(() => abortController.abort('timeout'), timeoutMs);

  try {
    sendDebug('Checking that Google AI is reachable...');
    const preflight = await preflightCheck();
    if (!preflight.ok) {
      const reason = preflight.error || `HTTP ${preflight.status}`;
      sendDebug(`✗ Google AI is unreachable: ${reason}`);
      throw new Error(
        `Can't reach generativelanguage.googleapis.com (${reason}). ` +
        `Check your internet connection, VPN, or firewall/antivirus blocking.`
      );
    }
    sendDebug('✓ Google AI is responding, capturing the screen...');

    const img = await captureScreen();
    const quota = store.incrementScanCount();
    mainWindow.webContents.send('quota-update', { used: quota, limit: 1500 });
    const data = await askAI(img, store.get('language'), abortController.signal);
    store.addHistoryEntry({
      country: data.country, region: data.region,
      lat: data.lat, lng: data.lng, confidence: data.confidence
    });
    mainWindow.webContents.send('scan-result', data);
  } catch (err) {
    if (abortController.signal.aborted) {
      const reason = abortController.signal.reason;
      if (reason === 'timeout') mainWindow.webContents.send('scan-timeout');
      else if (reason !== 'restart') mainWindow.webContents.send('scan-cancelled');
      // reason === 'restart' -> send nothing, runScan() will restart itself below (see finally)
    } else {
      let friendly = String(err && err.message ? err.message : err);
      if (friendly.includes('429') || friendly.includes('RESOURCE_EXHAUSTED')) {
        friendly = "You've hit today's Gemini request limit. Wait a bit or check your quota in Google AI Studio.";
      } else if (friendly.includes('403') || friendly.includes('API_KEY_INVALID') || friendly.includes('401')) {
        friendly = 'Your Google AI Studio API key is invalid. Check it in Settings.';
      }
      mainWindow.webContents.send('scan-error', friendly);
    }
  } finally {
    clearTimeout(scanState.timeoutHandle);
    const wasRestart = scanState.abortController && scanState.abortController.signal.reason === 'restart';
    scanState.active = false;
    scanState.abortController = null;
    scanState.timeoutHandle = null;
    scanState.deadline = null;
    if (wasRestart) runScan();
  }
}

function cancelScan(reason) {
  if (!scanState.active || !scanState.abortController) return;
  scanState.abortController.abort(reason);
}

function restartScan() {
  if (scanState.active) {
    cancelScan('restart');
  } else {
    runScan();
  }
}

ipcMain.handle('config:get', () => store.getAll());
ipcMain.handle('quota:get', () => store.getQuotaInfo());
ipcMain.handle('history:get', () => store.get('scanHistory') || []);

ipcMain.handle('config:set', (event, partial) => {
  store.setAll(partial);
  if ('hotkey' in partial || 'cancelHotkey' in partial || 'restartHotkey' in partial) {
    registerAllHotkeys();
  }
  return store.getAll();
});

ipcMain.handle('storage:get-info', () => store.getStorageInfo());

ipcMain.handle('storage:choose-and-set', async (event, dialogTitle) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: dialogTitle || 'Choose a folder for settings and history'
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false, cancelled: true };

  try {
    store.changeStorageDirectory(result.filePaths[0]);
    // A small delay so this IPC response has time to reach the renderer (to show
    // "restarting...") BEFORE the process actually exits and relaunches.
    setTimeout(() => { app.relaunch(); app.exit(0); }, 400);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('storage:reset-to-default', () => {
  try {
    store.resetStorageDirectory();
    setTimeout(() => { app.relaunch(); app.exit(0); }, 400);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('data:clear-history', () => {
  store.clearHistory();
  return { ok: true };
});

ipcMain.handle('data:clear-api-key', () => {
  store.clearApiKey();
  return { ok: true };
});

ipcMain.on('window:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('window:close', () => mainWindow && mainWindow.close());
ipcMain.on('shell:open-google-keys', () => shell.openExternal('https://aistudio.google.com/apikey'));
ipcMain.on('app:install-update', () => autoUpdater.quitAndInstall());
ipcMain.on('shell:open-maps', (event, lat, lng) => {
  if (typeof lat !== 'number' || typeof lng !== 'number') return;
  shell.openExternal(`https://www.google.com/maps?q=${lat},${lng}`);
});

app.whenReady().then(() => {
  store.ensureSmartDefaults();

  // In the packaged app, strip out Electron's default menu entirely — that also removes
  // its built-in Ctrl+Shift+I DevTools shortcut (we never register F12 for this at all).
  // When running via `npm start` (app.isPackaged === false) the menu stays, so debugging
  // remains available during development.
  if (app.isPackaged) {
    Menu.setApplicationMenu(null);
  }

  createWindow();

  if (app.isPackaged) {
    // The portable build (portable .exe) can't auto-update — there's no NSIS
    // installer for electron-updater to swap files underneath. Only attempt
    // auto-update for the NSIS-installed version.
    const isPortable = !!process.env.PORTABLE_EXECUTABLE_FILE;
    if (!isPortable) {
      // Forks without a configured package.json build.publish.owner/repo (or without any
      // published GitHub Releases) will get a network/404 error here — without a handler,
      // this unhandled 'error' event on autoUpdater could crash the process. Catch and log it.
      autoUpdater.on('error', (err) => {
        console.warn('[AutoUpdater] Update check failed (this is normal for forks without their own releases):', err.message);
      });
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
      autoUpdater.on('update-downloaded', () => {
        if (mainWindow) mainWindow.webContents.send('update-ready');
      });
    }
  }
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
