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
const BINANCE = 'https://api.binance.com';

let running = false;
let stopFlag = false;
const status = { running: false, lastPoll: 0, jobs: 0, lastError: '' };
const listeners = new Set();
const emit = () => listeners.forEach(fn => { try { fn({ ...status }); } catch (_) {} });

export const onRelayStatus = fn => { listeners.add(fn); fn({ ...status }); return () => listeners.delete(fn); };
export const getRelayStatus = () => ({ ...status });
export const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

const nativeHttp = async (opts) => {
  const H = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
  if (!H) throw new Error('CapacitorHttp unavailable');
  return H.request(opts);   // resolves { status, data, headers }
};

async function executeJob(job, token) {
  let respBody = null;
  try {
    const u = new URL(BINANCE + job.path);
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

export async function startRelay() {
  if (running || !isNative()) return;
  running = true; stopFlag = false; status.running = true; status.lastError = ''; emit();
  localStorage.setItem('sparkp2p_relay_on', '1');
  await startForegroundService();
  const token = localStorage.getItem('token');
  if (token) { try { await fetch(`${API_BASE}/ext/bot-started`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); } catch (_) {} }
  loop();
}

export async function stopRelay() {
  stopFlag = true;
  localStorage.setItem('sparkp2p_relay_on', '0');
  await stopForegroundService();
}

// Auto-resume on app launch if the user left the relay enabled.
if (isNative() && localStorage.getItem('sparkp2p_relay_on') === '1') {
  setTimeout(() => startRelay(), 1500);
}
