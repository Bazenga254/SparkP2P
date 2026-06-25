// SparkP2P mobile relay agent.
//
// Ships inside the normal web app but only ACTIVATES when the page is running inside the
// Capacitor native wrapper (window.Capacitor.isNativePlatform()). In a regular browser it
// stays completely inert (isNative() === false), so deploying it to the web is harmless.
//
// It mirrors the desktop relay loop (desktop/app.js → startRelayAgent) exactly:
//   long-poll  GET  /api/ext/relay/poll      (Bearer auth)
//   execute    →    the pre-signed job against api.binance.com FROM THE PHONE'S IP
//   return     POST /api/ext/relay/result    { job_id, body }
//
// The Binance call goes through Capacitor's native HTTP (CapacitorHttp), which runs outside
// the WebView's CORS sandbox — a browser fetch to api.binance.com would be blocked by CORS.

const API_BASE = '/api';                       // page is served from sparkp2p.com inside the wrapper
const ABS_API = (typeof location !== 'undefined' ? location.origin : 'https://sparkp2p.com') + '/api';
const BINANCE = 'https://api.binance.com';

let running = false;
let stopFlag = false;
let nativeTimer = null;
const status = { running: false, lastPoll: 0, jobs: 0, lastError: '', native: false };
const listeners = new Set();
const emit = () => listeners.forEach(fn => { try { fn({ ...status }); } catch (_) {} });

// Native foreground-service relay (Kotlin) — preferred: survives WebView throttling/Doze.
const nativeRelay = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SparkRelay;

let refreshTimer = null;
async function refreshToken() {
  const tk = localStorage.getItem('token');
  if (!tk) return;
  try {
    const r = await fetch(`${API_BASE}/traders/refresh-token`, { method: 'POST', headers: { Authorization: `Bearer ${tk}` } });
    if (r.ok) {
      const d = await r.json();
      if (d && d.access_token) {
        localStorage.setItem('token', d.access_token);
        const NR = nativeRelay();
        if (NR) { try { NR.updateToken({ token: d.access_token }); } catch (_) {} }
      }
    }
  } catch (_) { /* keep the old token; relay continues until it actually 401s */ }
}
function startTokenRefresh() { clearInterval(refreshTimer); refreshTimer = setInterval(refreshToken, 18 * 60 * 1000); }   // mirrors desktop (~20 min)
function stopTokenRefresh() { clearInterval(refreshTimer); refreshTimer = null; }

export const onRelayStatus = fn => { listeners.add(fn); fn({ ...status }); return () => listeners.delete(fn); };
export const getRelayStatus = () => ({ ...status });
// Robust native detection — the Capacitor bridge can expose any of these, and on some devices/
// WebViews one signal is present before another. Treat the presence of our own SparkRelay plugin
// as definitive proof we're inside the native app.
export const isNative = () => {
  const C = window.Capacitor;
  if (!C) return false;
  try {
    if (C.Plugins && C.Plugins.SparkRelay) return true;
    if (typeof C.isNativePlatform === 'function' && C.isNativePlatform()) return true;
    if (typeof C.getPlatform === 'function' && C.getPlatform() !== 'web') return true;
    if (C.isNative === true) return true;
  } catch (_) {}
  return false;
};

// Human-readable platform for diagnostics shown on the connect screen.
export const platformName = () => {
  const C = window.Capacitor;
  if (!C) return 'web (no Capacitor bridge)';
  try {
    if (typeof C.getPlatform === 'function') return C.getPlatform();
    if (typeof C.isNativePlatform === 'function') return C.isNativePlatform() ? 'native' : 'web';
  } catch (_) {}
  return 'unknown';
};

const nativeHttp = async (opts) => {
  const H = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
  if (!H) throw new Error('CapacitorHttp unavailable');
  return H.request(opts);   // resolves { status, data, headers }
};

async function executeJob(job, token) {
  let respBody = null;
  try {
    const u = new URL((job.host || BINANCE) + job.path);   // host override (e.g. c2c.binance.com for cookie chat-send)
    for (const k of Object.keys(job.params || {})) u.searchParams.set(k, String(job.params[k]));
    const headers = {};
    for (const [k, v] of Object.entries(job.headers || {})) { if (/^x-relay-/i.test(k)) continue; headers[k] = v; }
    const res = await nativeHttp({ url: u.toString(), method: job.method || 'POST', headers, data: (job.body ?? undefined) });
    respBody = res.data;
  } catch (e) {
    respBody = { code: 'RELAY_EXEC_ERROR', msg: String(e && e.message ? e.message : e) };
  }
  try {
    await fetch(`${API_BASE}/ext/relay/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ job_id: job.job_id, body: respBody }),
    });
  } catch (_) { /* VPS times the job out; keep polling */ }
}

async function loop() {
  const nap = ms => new Promise(r => setTimeout(r, ms));
  while (!stopFlag) {
    const token = localStorage.getItem('token');
    if (!token) { await nap(3000); continue; }
    let job = null;
    try {
      const r = await fetch(`${API_BASE}/ext/relay/poll`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) { const d = await r.json(); if (d && d.job_id) job = d; }
      else { status.lastError = 'poll ' + r.status; emit(); await nap(2000); continue; }
    } catch (_) { status.lastError = 'poll failed'; emit(); await nap(2000); continue; }
    status.lastPoll = Date.now(); status.lastError = ''; emit();
    if (!job) continue;                 // no job in the long-poll window — re-poll immediately
    status.jobs++; emit();
    await executeJob(job, token);
  }
  running = false; status.running = false; emit();
}

async function startForegroundService() {
  // @capawesome/capacitor-android-foreground-service keeps the app alive in the background.
  const FS = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.ForegroundService;
  if (!FS) return false;
  try {
    await FS.startForegroundService({ id: 1, title: 'SparkP2P relay', body: 'Keeping your trading relay online', smallIcon: 'splash' });
    return true;
  } catch (_) { return false; }
}
async function stopForegroundService() {
  const FS = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.ForegroundService;
  if (FS) { try { await FS.stopForegroundService(); } catch (_) {} }
}

function startNativeStatusPolling() {
  clearInterval(nativeTimer);
  const NR = nativeRelay();
  if (!NR) return;
  nativeTimer = setInterval(async () => {
    try {
      const s = await NR.status();
      status.running = !!s.running; status.lastPoll = s.lastPoll || 0; status.jobs = s.jobs || 0; status.native = true; emit();
      const tk = localStorage.getItem('token');
      if (tk) { try { NR.updateToken({ token: tk }); } catch (_) {} }   // keep native loop's token fresh
    } catch (_) {}
  }, 5000);
}

export async function startRelay() {
  if (running || !isNative()) return;
  localStorage.setItem('sparkp2p_relay_on', '1');
  const token = localStorage.getItem('token') || '';
  const NR = nativeRelay();
  if (NR) {
    // Native foreground service does the loop — most reliable in the background.
    try { if (NR.requestNotificationPermission) await NR.requestNotificationPermission(); } catch (_) {}   // Android 13+ notif permission
    if (localStorage.getItem('sparkp2p_batt_asked') !== '1') {
      try { await NR.requestBatteryExemption(); } catch (_) {}
      localStorage.setItem('sparkp2p_batt_asked', '1');   // prompt once
    }
    running = true; status.running = true; status.native = true; status.lastError = ''; emit();
    try { await NR.start({ apiBase: ABS_API, token }); } catch (e) { status.lastError = 'native start failed'; emit(); }
    if (token) { try { await fetch(`${API_BASE}/ext/bot-started`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); } catch (_) {} }
    startNativeStatusPolling();
    startTokenRefresh();
    return;
  }
  // Fallback: WebView JS loop (foreground-only / iOS) kept alive by a generic foreground-service plugin.
  running = true; stopFlag = false; status.running = true; status.native = false; status.lastError = ''; emit();
  await startForegroundService();
  if (token) { try { await fetch(`${API_BASE}/ext/bot-started`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); } catch (_) {} }
  startTokenRefresh();
  loop();
}

export async function stopRelay() {
  localStorage.setItem('sparkp2p_relay_on', '0');
  clearInterval(nativeTimer);
  stopTokenRefresh();
  const NR = nativeRelay();
  if (NR) { try { await NR.stop(); } catch (_) {} running = false; status.running = false; emit(); return; }
  stopFlag = true;
  await stopForegroundService();
}

// Auto-resume on app launch if the user left the relay enabled.
if (isNative() && localStorage.getItem('sparkp2p_relay_on') === '1') {
  setTimeout(() => startRelay(), 1500);
}
