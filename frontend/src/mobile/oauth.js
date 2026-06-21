// Google sign-in launcher (native app) + startup resume.
//
// Google can't run inside the WebView and browser→app deep links are unreliable, so: open Google
// externally with a one-time `sid`, the backend stashes the finished session under that sid, and the
// app fetches it from /api/auth/google/result?sid=...
//
// Key reliability rules learned the hard way:
//  - Open the browser WITHOUT tearing down this page (Custom Tab, or window.open('_system')) so the
//    in-page poll survives and completes the login the moment the result lands / the app resumes.
//  - Also persist the sid and re-check on every app load (resumePendingGoogleLogin) as a safety net.
import { isNative } from './relayAgent';

const PENDING_KEY = 'pending_google_sid';
const PENDING_TS = 'pending_google_sid_ts';
const PENDING_TTL = 5 * 60 * 1000; // 5 min

let _browser = null; // @capacitor/browser ref, so we can close the Custom Tab on success

function finish(d) {
  // d = { google_token, name, id, role, needs_profile }
  localStorage.removeItem(PENDING_KEY);
  localStorage.removeItem(PENDING_TS);
  try { if (_browser) _browser.close(); } catch (_) { /* tab may be gone */ }
  // Route through /login?google_token=… — the SAME path the working web Google login uses. Login.jsx
  // then calls loginUser() (sets the session synchronously, no reload) and navigates, or shows the
  // profile-completion screen if needed. We deliberately do NOT set the token + hard-reload to
  // /dashboard: a hard reload re-boots the app (auth re-check + biometric gate) and bounces back to
  // login — which is exactly the "flashes signing-in then returns to login" symptom.
  const needsProfile = d.needs_profile === '1' || d.needs_profile === 1 || d.needs_profile === true;
  const q = new URLSearchParams({
    google_token: d.google_token,
    name: d.name || '',
    id: d.id != null ? String(d.id) : '',
    role: d.role || 'trader',
    needs_profile: needsProfile ? '1' : '0',
  });
  window.location.href = `/login?${q.toString()}`;
}

async function fetchResult(sid) {
  try {
    const r = await fetch(`${window.location.origin}/api/auth/google/result?sid=${encodeURIComponent(sid)}`, { cache: 'no-store' });
    if (r.ok) {
      const d = await r.json();
      if (d && d.google_token) return d;
    }
  } catch (_) { /* keep trying */ }
  return null;
}

async function pollLoop(sid, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (localStorage.getItem('token')) return;
    const d = await fetchResult(sid);
    if (d) { finish(d); return; }
    await new Promise((res) => setTimeout(res, 1500));
  }
}

export async function startGoogleLogin() {
  if (!isNative()) {
    window.location.href = `${import.meta.env.VITE_API_URL || ''}/api/auth/google`;
    return;
  }

  const sid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  localStorage.setItem(PENDING_KEY, sid);          // persist BEFORE opening (page may still die)
  localStorage.setItem(PENDING_TS, String(Date.now()));

  const url = `${window.location.origin}/api/auth/google?platform=app&sid=${encodeURIComponent(sid)}`;

  // Open the browser WITHOUT navigating this WebView away, so the poll below survives.
  try {
    const mod = await import('@capacitor/browser');
    _browser = mod.Browser;
    await _browser.open({ url });
  } catch (e) {
    _browser = null;
    // '_system' opens the external browser but keeps this page alive (unlike location.href).
    try { window.open(url, '_system'); } catch (_) { window.location.href = url; }
  }

  // Poll in the background; throttled while the app is backgrounded, resumes when it returns.
  pollLoop(sid, 170);

  // Poll immediately whenever the app comes back to the foreground.
  try {
    const { App } = await import('@capacitor/app');
    const sub = await App.addListener('appStateChange', (s) => {
      if (s && s.isActive) {
        fetchResult(sid).then((d) => { if (d) { finish(d); if (sub) sub.remove(); } });
      }
    });
  } catch (_) { /* timer loop covers it */ }
}

// Called on every app load (main.jsx). If a Google login was in flight, complete it.
export async function resumePendingGoogleLogin() {
  if (!isNative()) return;
  const sid = localStorage.getItem(PENDING_KEY);
  if (!sid) return;
  const ts = parseInt(localStorage.getItem(PENDING_TS) || '0', 10);
  if (!ts || Date.now() - ts > PENDING_TTL || localStorage.getItem('token')) {
    localStorage.removeItem(PENDING_KEY);
    localStorage.removeItem(PENDING_TS);
    return;
  }
  await pollLoop(sid, 25);
}
