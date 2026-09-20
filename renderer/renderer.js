let config = { language: 'en', hotkey: 'F8', cancelHotkey: 'F9', restartHotkey: 'F10', theme: 'dark' };
let map, currentMarker, currentCircle, tileLayer;

const el = (id) => document.getElementById(id);

// Small inline icons for text labels (instead of the emoji ✦ ✧ ✕ ← 📍).
// The icon markup is our own, static and trusted. Dynamic text (e.g. clues/
// alternatives — raw AI output) is always appended as a separate text node via
// setIconLabel(), never by concatenating strings into innerHTML, so the model's
// response can never be parsed as HTML under any circumstances.
const ICON_TARGET = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" style="vertical-align:-2px;margin-right:5px;flex-shrink:0;"><circle cx="12" cy="12" r="7" stroke="currentColor" stroke-width="1.6"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const ICON_LAYERS = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" style="vertical-align:-2px;margin-right:5px;flex-shrink:0;"><path d="M12 3L21 8.5L12 14L3 8.5L12 3Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M3 15.5L12 21L21 15.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_X_SMALL = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" style="vertical-align:-1px;margin-right:5px;flex-shrink:0;"><path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const ICON_BACK = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" style="vertical-align:-2px;margin-right:5px;flex-shrink:0;"><path d="M10 3L5 8L10 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_PIN = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" style="vertical-align:-2px;margin-right:5px;flex-shrink:0;"><path d="M12 21S5 14 5 9.5A7 7 0 0 1 19 9.5C19 14 12 21 12 21Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="9.3" r="2.3" stroke="currentColor" stroke-width="1.6"/></svg>';

// iconSvg — trusted constant defined above. text — plain text, inserted as a text node.
function setIconLabel(element, iconSvg, text) {
  element.innerHTML = iconSvg;
  element.appendChild(document.createTextNode(text));
}

function initMap() {
  map = L.map('map', { zoomControl: false }).setView([20, 0], 2);
  applyMapTileTheme(config.theme === 'dark');
}

function applyMapTileTheme(isDark) {
  if (tileLayer) map.removeLayer(tileLayer);
  tileLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
    referrerPolicy: 'strict-origin-when-cross-origin'
  }).addTo(map);
  document.querySelector('#map').style.filter = isDark
    ? 'invert(100%) hue-rotate(180deg) brightness(90%) contrast(90%)'
    : '';
}

function updateLocation(lat, lng, radiusKm, title) {
  const circleColor = config.theme === 'dark' ? '#00F2FE' : '#0070F3';

  if (currentMarker) map.removeLayer(currentMarker);
  if (currentCircle) map.removeLayer(currentCircle);

  const radiusMeters = radiusKm * 1000;
  currentCircle = L.circle([lat, lng], {
    color: circleColor, weight: 2, opacity: 0.85,
    fillColor: circleColor, fillOpacity: 0.25, radius: radiusMeters
  }).addTo(map);

  currentMarker = L.circleMarker([lat, lng], {
    radius: 6, color: '#ffffff', weight: 2, fillColor: circleColor, fillOpacity: 1
  }).addTo(map).bindPopup(`<b>${escapeHtml(title)}</b>`).openPopup();

  // At low confidence, radius_km can be as large as 800-1200 km (whole-country scale),
  // and fitting the entire error circle on screen would zoom the map out so far you
  // can't tell which part of the country the point is in. So for the zoom calculation
  // we use a capped radius (max 220 km), while the error circle itself is still drawn
  // at its full size — it just extends beyond the visible area, which is fine.
  //
  // Bounds are computed manually with a simple spherical formula (rather than via
  // L.circle(...).getBounds() on an object not attached to the map — that throws,
  // since Leaflet can't project a circle without an active map, which used to abort
  // the whole onScanResult handler BEFORE stopScanTimer() ever ran).
  const viewRadiusKm = Math.min(radiusKm, 220);
  const latDelta = viewRadiusKm / 111.32;
  const lngDelta = viewRadiusKm / (111.32 * Math.max(Math.cos(lat * Math.PI / 180), 0.15));
  const viewBounds = L.latLngBounds(
    [lat - latDelta, lng - lngDelta],
    [lat + latDelta, lng + lngDelta]
  );
  map.fitBounds(viewBounds, { padding: [30, 30], maxZoom: 11 });
  setTimeout(() => map.invalidateSize(), 50);
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.innerText = str;
  return d.innerHTML;
}

let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playTone(freq, durationMs, type = 'sine', volume = 0.15) {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.value = volume;
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durationMs / 1000);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + durationMs / 1000);
  } catch (e) {
    console.warn('[SOUND] Failed to play sound:', e);
  }
}

function playScanStartSound() {
  playTone(660, 90);
  setTimeout(() => playTone(880, 110), 90);
}

function playScanStopSound() {
  playTone(520, 90);
  setTimeout(() => playTone(340, 140), 90);
}

let lastQuota = { used: 0, limit: 1500 };
let lastResultLatLng = null;
let scanTimerInterval = null;

function startScanTimer() {
  let seconds = 0;
  const timerEl = el('scan-timer');
  timerEl.style.display = '';
  timerEl.textContent = '0s';
  scanTimerInterval = setInterval(() => {
    seconds += 1;
    timerEl.textContent = `${seconds}s`;
  }, 1000);
}

function stopScanTimer() {
  clearInterval(scanTimerInterval);
  el('scan-timer').style.display = 'none';
}

function renderQuota(data) {
  lastQuota = data;
  const el2 = el('quota-badge');
  const { used, limit } = data;
  const remaining = Math.max(limit - used, 0);
  const tr = t(config.language);
  el2.textContent = tr.quota_badge.replace('{used}', used).replace('{limit}', limit);
  const hintText = tr.quota_hint.replace('{limit}', limit);
  el2.title = hintText;
  el2.classList.toggle('quota-low', remaining <= 10 && remaining > 0);
  el2.classList.toggle('quota-empty', remaining === 0);
  el('quota-footnote').textContent = hintText;
}

async function renderHistory() {
  const tr = t(config.language);
  const history = await window.api.getHistory();
  const listEl = el('history-list');
  const emptyEl = el('history-empty');

  listEl.innerHTML = '';
  if (history.length === 0) {
    emptyEl.textContent = tr.history_empty;
    emptyEl.style.display = '';
    return;
  }
  emptyEl.style.display = 'none';

  for (const entry of history) {
    const item = document.createElement('div');
    item.className = 'history-item';
    const time = new Date(entry.timestamp).toLocaleTimeString(config.language, { hour: '2-digit', minute: '2-digit' });
    item.innerHTML = `
      <span class="history-item-title">${escapeHtml(entry.country || '?')} — ${escapeHtml(entry.region || '')}</span>
      <span class="history-item-meta">${time} · ${escapeHtml(entry.confidence || '')}</span>
    `;
    item.style.cursor = 'pointer';
    item.addEventListener('click', () => {
      if (typeof entry.lat === 'number' && typeof entry.lng === 'number') {
        showView('radar');
        updateLocation(entry.lat, entry.lng, 100, `${entry.country} — ${entry.region}`);
      }
    });
    listEl.appendChild(item);
  }
}

async function loadStorageInfo() {
  const tr = t(config.language);
  try {
    const info = await window.api.getStorageInfo();
    el('storage-current-path').textContent = info.directory;
    el('storage-reset-btn').style.display = info.isCustom ? '' : 'none';
  } catch (e) {
    el('storage-current-path').textContent = tr.storage_error.replace('{error}', e.message || String(e));
  }
}

function applyLanguage() {
  document.documentElement.lang = config.language;
  const tr = t(config.language);
  el('min-btn').title = tr.tooltip_minimize;
  el('close-btn').title = tr.tooltip_close;
  el('onb-apikey-toggle').title = tr.tooltip_show_hide;
  el('apikey-toggle').title = tr.tooltip_show_hide;
  el('history-btn').title = tr.tooltip_history;
  el('settings-btn').title = tr.tooltip_settings;
  el('badge').textContent = tr.ready.replace('{hotkey}', config.hotkey);
  el('title-label').textContent = tr.press_key;
  el('clues-label').textContent = tr.default_desc;
  el('disclaimer-label').textContent = tr.disclaimer;
  el('back-btn').innerHTML = '';
  setIconLabel(el('back-btn'), ICON_BACK, tr.back);
  el('lang-title').textContent = tr.lang_label;
  el('theme-title').textContent = tr.theme_label;
  el('hotkey-title').textContent = tr.hotkey_label;
  el('cancel-hotkey-title').textContent = tr.cancel_hotkey_label;
  el('restart-hotkey-title').textContent = tr.restart_hotkey_label;
  el('apikey-title').textContent = tr.apikey_label;
  el('apikey-hint').textContent = tr.apikey_hint;
  el('storage-title').textContent = tr.storage_label;
  el('storage-hint').textContent = tr.storage_hint;
  el('storage-change-btn').textContent = tr.storage_change_btn;
  el('storage-reset-btn').textContent = tr.storage_reset_btn;
  el('clear-data-title').textContent = tr.clear_data_label;
  el('clear-data-hint').textContent = tr.clear_data_hint;
  el('clear-history-btn').textContent = tr.clear_history_btn;
  el('clear-apikey-btn').textContent = tr.clear_apikey_btn;

  el('onb-title').textContent = tr.onb_title;
  el('onb-intro').textContent = tr.onb_intro;
  el('onb-step1').textContent = tr.onb_step1;
  el('onb-step2').textContent = tr.onb_step2;
  el('onb-step3').textContent = tr.onb_step3;
  el('onb-open-btn').textContent = tr.onb_open_btn;
  el('onb-continue-btn').textContent = tr.onb_continue_btn;
  el('onb-skip-btn').textContent = tr.onb_skip_btn;

  el('history-title').textContent = tr.history_title;
  el('history-back-btn').innerHTML = '';
  setIconLabel(el('history-back-btn'), ICON_BACK, tr.back);
  el('timeout-title').textContent = tr.timeout_label;
  el('update-banner-text').textContent = tr.update_available;
  el('update-restart-btn').textContent = tr.update_restart;
  if (lastResultLatLng) {
    el('maps-link-btn').innerHTML = '';
    setIconLabel(el('maps-link-btn'), ICON_PIN, tr.maps_link);
  }

  renderQuota(lastQuota);

  populateDropdownLabels();
}

function applyTheme() {
  document.body.classList.toggle('theme-dark', config.theme === 'dark');
  document.body.classList.toggle('theme-light', config.theme !== 'dark');
  if (map) applyMapTileTheme(config.theme === 'dark');
}

function buildDropdown({ toggleId, valueId, menuId, dropdownId, options, currentValue, onSelect }) {
  const dropdownEl = el(dropdownId);
  const toggleEl = el(toggleId);
  const valueEl = el(valueId);
  const menuEl = el(menuId);

  menuEl.innerHTML = '';
  for (const opt of options) {
    const optEl = document.createElement('div');
    optEl.className = 'dropdown-option';
    optEl.textContent = opt.label;
    optEl.dataset.value = opt.value;
    if (opt.value === currentValue) {
      optEl.classList.add('selected');
      valueEl.textContent = opt.label;
    }
    optEl.addEventListener('click', () => {
      dropdownEl.classList.remove('open');
      onSelect(opt.value);
    });
    menuEl.appendChild(optEl);
  }

  toggleEl.onclick = (e) => {
    e.stopPropagation();
    const willOpen = !dropdownEl.classList.contains('open');
    closeAllDropdowns();
    if (willOpen) dropdownEl.classList.add('open');
  };
}

function closeAllDropdowns() {
  document.querySelectorAll('.dropdown.open').forEach(d => d.classList.remove('open'));
}
document.addEventListener('click', closeAllDropdowns);

function populateDropdownLabels() {
  const tr = t(config.language);

  buildDropdown({
    toggleId: 'lang-toggle', valueId: 'lang-value', menuId: 'lang-menu', dropdownId: 'lang-dropdown',
    options: Object.entries(LANGUAGE_NAMES).map(([code, name]) => ({ value: code, label: name })),
    currentValue: config.language,
    onSelect: async (value) => {
      config = await window.api.setConfig({ language: value });
      applyLanguage();
    }
  });

  buildDropdown({
    toggleId: 'theme-toggle', valueId: 'theme-value', menuId: 'theme-menu', dropdownId: 'theme-dropdown',
    options: [
      { value: 'dark', label: tr.theme_dark },
      { value: 'light', label: tr.theme_light }
    ],
    currentValue: config.theme,
    onSelect: async (value) => {
      config = await window.api.setConfig({ theme: value });
      applyTheme();
      applyLanguage();
    }
  });
}

function syncOnbContinueState() {
  el('onb-continue-btn').disabled = el('onb-apikey-input').value.trim().length === 0;
}

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  el(`view-${name}`).classList.add('active');
  if (name === 'radar') setTimeout(() => map.invalidateSize(), 50);
  if (name === 'onboarding') syncOnbContinueState();
  if (name === 'history') renderHistory();
}

let recordingTarget = null;

function startHotkeyRecording(configKey, buttonId) {
  if (recordingTarget) {
    el(recordingTarget.buttonId).classList.remove('recording');
    el(recordingTarget.buttonId).textContent = config[recordingTarget.configKey];
  }
  recordingTarget = { configKey, buttonId };
  const btn = el(buttonId);
  btn.classList.add('recording');
  btn.textContent = t(config.language).press_new_key;
}

window.addEventListener('keydown', async (e) => {
  if (!recordingTarget) return;
  e.preventDefault();
  const { configKey, buttonId } = recordingTarget;
  recordingTarget = null;

  const newKey = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  config = await window.api.setConfig({ [configKey]: newKey });

  const btn = el(buttonId);
  btn.classList.remove('recording');
  btn.textContent = config[configKey];
  applyLanguage();
});

window.api.onQuotaUpdate((data) => renderQuota(data));

window.api.onScanDebug((msg) => {
  console.log('%c[GeoRadar debug]', 'color:#FFD200', msg);
});

window.api.onScanStarted(() => {
  const tr = t(config.language);
  el('badge').textContent = tr.scanning;
  el('badge').style.color = '#FFD200';
  el('title-label').textContent = tr.analyzing;
  el('clues-label').textContent = '';
  el('alternatives-label').style.display = 'none';
  el('maps-link-btn').style.display = 'none';
  startScanTimer();
  playScanStartSound();
});

window.api.onScanResult((data) => {
  try {
    const tr = t(config.language);
    const country = data.country || 'Unknown';
    const region = data.region || '';
    const lat = data.lat ?? 0;
    const lng = data.lng ?? 0;
    const radius = data.radius_km ?? 200;
    const clues = data.clues || '';
    const alternatives = Array.isArray(data.alternatives) ? data.alternatives.filter(Boolean) : [];

    el('badge').textContent = tr.zone.replace('{radius}', radius);
    el('badge').style.color = getComputedStyle(document.body).getPropertyValue('--accent-text').trim();
    el('title-label').textContent = `${country} — ${region}`;
    el('clues-label').innerHTML = '';
    setIconLabel(el('clues-label'), ICON_TARGET, tr.clues.replace('{clues}', clues));

    const altEl = el('alternatives-label');
    if (alternatives.length > 0) {
      altEl.innerHTML = '';
      setIconLabel(altEl, ICON_LAYERS, tr.alternatives_label.replace('{alternatives}', alternatives.join('; ')));
      altEl.style.display = '';
    } else {
      altEl.style.display = 'none';
    }

    updateLocation(lat, lng, radius, `${country} — ${region}`);

    lastResultLatLng = { lat, lng };
    const mapsBtn = el('maps-link-btn');
    mapsBtn.innerHTML = '';
    setIconLabel(mapsBtn, ICON_PIN, tr.maps_link);
    mapsBtn.style.display = '';
  } catch (e) {
    // Whatever goes wrong while rendering the result (map, icons, etc.) — the timer and
    // sound must still finish cleanly instead of getting stuck until the next scan.
    console.error('[GeoRadar] Error while displaying the result:', e);
  } finally {
    stopScanTimer();
    playScanStopSound();
  }
});

window.api.onScanError((err) => {
  const tr = t(config.language);
  el('badge').innerHTML = '';
  setIconLabel(el('badge'), ICON_X_SMALL, tr.error_badge);
  el('badge').style.color = '#FF3B30';
  el('title-label').textContent = tr.error_title;
  el('clues-label').textContent = `Log: ${err}`;
  stopScanTimer();
  playScanStopSound();
});

window.api.onScanTimeout(() => {
  const tr = t(config.language);
  el('badge').textContent = tr.timeout_badge;
  el('badge').style.color = '#FF9F1C';
  el('title-label').textContent = tr.timeout_title;
  el('clues-label').textContent = tr.timeout_desc;
  stopScanTimer();
  playScanStopSound();
});

window.api.onScanCancelled(() => {
  const tr = t(config.language);
  el('badge').textContent = tr.cancelled_badge;
  el('badge').style.color = '#9CA3AF';
  el('title-label').textContent = tr.cancelled_title;
  el('clues-label').textContent = tr.cancelled_desc;
  stopScanTimer();
  playScanStopSound();
});

window.api.onScanNoKey(() => {
  showView('onboarding');
});

// ---------- Initialization ----------
async function init() {
  try {
    config = await window.api.getConfig();

    initMap();
    applyTheme();
    applyLanguage();
    renderQuota(await window.api.getQuota());

    el('hotkey-btn').textContent = config.hotkey;
    el('cancel-hotkey-btn').textContent = config.cancelHotkey;
    el('restart-hotkey-btn').textContent = config.restartHotkey;
    el('apikey-input').value = config.apiKey || '';

    const timeoutSeconds = Math.round((config.scanTimeoutMs || 20000) / 1000);
    el('timeout-slider').value = timeoutSeconds;
    el('timeout-value').textContent = `${timeoutSeconds}s`;

    showView(config.apiKey ? 'radar' : 'onboarding');

    el('settings-btn').addEventListener('click', () => { showView('settings'); loadStorageInfo(); });
    el('back-btn').addEventListener('click', () => showView('radar'));
    el('history-btn').addEventListener('click', () => showView('history'));
    el('history-back-btn').addEventListener('click', () => showView('radar'));

    el('storage-change-btn').addEventListener('click', async () => {
      const tr = t(config.language);
      el('storage-change-btn').disabled = true;
      try {
        const result = await window.api.chooseStorageDirectory(tr.storage_dialog_title);
        if (result.cancelled) {
          el('storage-change-btn').disabled = false;
          return;
        }
        if (result.ok) {
          el('storage-current-path').textContent = tr.storage_restarting;
        } else {
          alert(tr.storage_error.replace('{error}', result.error || ''));
          el('storage-change-btn').disabled = false;
        }
      } catch (e) {
        alert(tr.storage_error.replace('{error}', e.message || String(e)));
        el('storage-change-btn').disabled = false;
      }
    });

    el('storage-reset-btn').addEventListener('click', async () => {
      const tr = t(config.language);
      el('storage-reset-btn').disabled = true;
      try {
        const result = await window.api.resetStorageDirectory();
        if (result.ok) {
          el('storage-current-path').textContent = tr.storage_restarting;
        } else {
          alert(tr.storage_error.replace('{error}', result.error || ''));
          el('storage-reset-btn').disabled = false;
        }
      } catch (e) {
        alert(tr.storage_error.replace('{error}', e.message || String(e)));
        el('storage-reset-btn').disabled = false;
      }
    });

    el('clear-history-btn').addEventListener('click', async () => {
      const tr = t(config.language);
      if (!confirm(tr.clear_history_confirm)) return;
      await window.api.clearHistory();
      if (el('view-history').classList.contains('active')) renderHistory();
    });

    el('clear-apikey-btn').addEventListener('click', async () => {
      const tr = t(config.language);
      if (!confirm(tr.clear_apikey_confirm)) return;
      await window.api.clearApiKey();
      config.apiKey = '';
      el('apikey-input').value = '';
    });

    el('maps-link-btn').addEventListener('click', () => {
      if (lastResultLatLng) window.api.openInMaps(lastResultLatLng.lat, lastResultLatLng.lng);
    });

    el('timeout-slider').addEventListener('input', (e) => {
      el('timeout-value').textContent = `${e.target.value}s`;
    });
    el('timeout-slider').addEventListener('change', async (e) => {
      config = await window.api.setConfig({ scanTimeoutMs: Number(e.target.value) * 1000 });
    });

    window.api.onUpdateReady(() => {
      el('update-banner').style.display = '';
    });
    el('update-restart-btn').addEventListener('click', () => window.api.installUpdate());

    el('apikey-input').addEventListener('blur', async (e) => {
      config = await window.api.setConfig({ apiKey: e.target.value.trim() });
    });

    el('apikey-toggle').addEventListener('click', () => {
      const input = el('apikey-input');
      input.type = input.type === 'password' ? 'text' : 'password';
    });

    el('hotkey-btn').addEventListener('click', () => startHotkeyRecording('hotkey', 'hotkey-btn'));
    el('cancel-hotkey-btn').addEventListener('click', () => startHotkeyRecording('cancelHotkey', 'cancel-hotkey-btn'));
    el('restart-hotkey-btn').addEventListener('click', () => startHotkeyRecording('restartHotkey', 'restart-hotkey-btn'));

    el('min-btn').addEventListener('click', () => window.api.minimizeWindow());
    el('close-btn').addEventListener('click', () => window.api.closeWindow());

    el('onb-open-btn').addEventListener('click', () => window.api.openGoogleKeys());

    const syncOnbContinueState2 = syncOnbContinueState;
    el('onb-apikey-input').addEventListener('input', syncOnbContinueState2);
    el('onb-apikey-input').addEventListener('paste', () => setTimeout(syncOnbContinueState2, 0));
    syncOnbContinueState2();

    el('onb-apikey-toggle').addEventListener('click', () => {
      const input = el('onb-apikey-input');
      input.type = input.type === 'password' ? 'text' : 'password';
    });

    el('onb-continue-btn').addEventListener('click', async () => {
      const key = el('onb-apikey-input').value.trim();
      if (!key) return;
      config = await window.api.setConfig({ apiKey: key });
      el('apikey-input').value = key;
      showView('radar');
    });

    el('onb-skip-btn').addEventListener('click', () => showView('radar'));
  } catch (err) {
    document.body.classList.add('theme-dark');
    document.body.innerHTML = `
      <div style="padding:24px; color:#ff6b6b; font-family:monospace; font-size:13px;
                  background:#10141e; height:100%; box-sizing:border-box; white-space:pre-wrap;">
        UI failed to start:\n${err && err.stack ? err.stack : err}
      </div>`;
    console.error('[INIT ERROR]', err);
  }
}

init();
