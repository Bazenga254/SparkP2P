const API_BASE = 'https://sparkp2p.com/api';

// Key Binance cookies to capture
const BINANCE_COOKIE_NAMES = [
  'p20t', 'bnc-uuid', 'logined', 'cr00', 'r20t', 'r30t',
  'BNC_FV_KEY', 's9r1', 'csrftoken', 'lang',
];

// DOM elements
const loginView = document.getElementById('login-view');
const mainView = document.getElementById('main-view');
const statusDot = document.getElementById('status-dot');
const statusLabel = document.getElementById('status-label');
const lastSyncEl = document.getElementById('last-sync');
const syncMsg = document.getElementById('sync-msg');
const loginMsg = document.getElementById('login-msg');

// ── Init ──────────────────────────────────────────────
async function init() {
  const { sparkp2p_token } = await chrome.storage.local.get('sparkp2p_token');
  if (sparkp2p_token) {
    showMainView();
    checkStatus();
  } else {
    showLoginView();
  }

  // Load auto-sync setting
  const { auto_sync } = await chrome.storage.local.get('auto_sync');
  document.getElementById('auto-sync').checked = auto_sync !== false;
}

function showLoginView() {
  loginView.style.display = 'block';
  mainView.style.display = 'none';
}

function showMainView() {
  loginView.style.display = 'none';
  mainView.style.display = 'block';
}

// ── Login ─────────────────────────────────────────────
document.getElementById('login-btn').addEventListener('click', async () => {
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;

  if (!email || !password) {
    showMsg(loginMsg, 'Enter email and password', 'error');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json();

    if (!res.ok) {
      showMsg(loginMsg, data.detail || 'Login failed', 'error');
      return;
    }

    await chrome.storage.local.set({
      sparkp2p_token: data.access_token,
      sparkp2p_user: data.full_name,
    });

    showMainView();
    checkStatus();
    showMsg(syncMsg, `Welcome, ${data.full_name}!`, 'success');
  } catch (err) {
    showMsg(loginMsg, 'Connection failed', 'error');
  }
});

// ── Sync Binance Cookies ─────────────────────────────
document.getElementById('sync-btn').addEventListener('click', syncCookies);

async function syncCookies() {
  const btn = document.getElementById('sync-btn');
  btn.disabled = true;
  btn.textContent = 'Syncing...';
  syncMsg.innerHTML = '';

  try {
    // Get all binance.com cookies
    const allCookies = await chrome.cookies.getAll({ domain: '.binance.com' });
    const cookieMap = {};

    for (const cookie of allCookies) {
      if (BINANCE_COOKIE_NAMES.includes(cookie.name)) {
        cookieMap[cookie.name] = cookie.value;
      }
    }

    // Also check c2c.binance.com
    const c2cCookies = await chrome.cookies.getAll({ domain: 'c2c.binance.com' });
    for (const cookie of c2cCookies) {
      if (BINANCE_COOKIE_NAMES.includes(cookie.name) && !cookieMap[cookie.name]) {
        cookieMap[cookie.name] = cookie.value;
      }
    }

    // Check we have the critical cookie
    if (!cookieMap['p20t']) {
      showMsg(syncMsg, 'Binance session not found. Please login to Binance P2P first.', 'error');
      btn.disabled = false;
      btn.textContent = 'Sync Binance Cookies';
      return;
    }

    // Extract csrf token and bnc-uuid
    const csrfToken = cookieMap['csrftoken'] || '';
    const bncUuid = cookieMap['bnc-uuid'] || '';

    // Remove csrftoken from cookies object (sent separately)
    delete cookieMap['csrftoken'];

    // Get SparkP2P token
    const { sparkp2p_token } = await chrome.storage.local.get('sparkp2p_token');

    // Send to SparkP2P
    const res = await fetch(`${API_BASE}/traders/connect-binance`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sparkp2p_token}`,
      },
      body: JSON.stringify({
        cookies: cookieMap,
        csrf_token: csrfToken,
        bnc_uuid: bncUuid,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      showMsg(syncMsg, data.detail || 'Sync failed', 'error');
    } else {
      const now = new Date().toISOString();
      await chrome.storage.local.set({ last_sync: now });

      if (data.name_match === false && data.binance_name) {
        showMsg(syncMsg, `Connected! Name mismatch: ${data.binance_name} vs ${data.registered_name}. Update in Settings.`, 'error');
      } else {
        showMsg(syncMsg, `Connected! ${data.binance_name ? 'Name: ' + data.binance_name : ''}`, 'success');
      }

      updateStatus(true, now);
    }
  } catch (err) {
    showMsg(syncMsg, 'Failed to sync: ' + err.message, 'error');
  }

  btn.disabled = false;
  btn.textContent = 'Sync Binance Cookies';
}

// ── Check Status ─────────────────────────────────────
document.getElementById('check-btn').addEventListener('click', checkStatus);

async function checkStatus() {
  try {
    const { sparkp2p_token } = await chrome.storage.local.get('sparkp2p_token');
    const res = await fetch(`${API_BASE}/traders/me`, {
      headers: { 'Authorization': `Bearer ${sparkp2p_token}` },
    });

    if (!res.ok) {
      updateStatus(false);
      return;
    }

    const data = await res.json();
    updateStatus(data.binance_connected);

    const { last_sync } = await chrome.storage.local.get('last_sync');
    if (last_sync) {
      updateSyncTime(last_sync);
    }
  } catch {
    updateStatus(false);
  }
}

// ── Auto-sync toggle ─────────────────────────────────
document.getElementById('auto-sync').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ auto_sync: e.target.checked });
  // Notify background script
  chrome.runtime.sendMessage({ type: 'auto_sync_changed', enabled: e.target.checked });
});

// ── Logout ───────────────────────────────────────────
document.getElementById('logout-btn').addEventListener('click', async () => {
  await chrome.storage.local.remove(['sparkp2p_token', 'sparkp2p_user', 'last_sync']);
  showLoginView();
});

// ── Helpers ──────────────────────────────────────────
function updateStatus(connected, syncTime) {
  statusDot.className = `status-dot ${connected ? 'green' : 'red'}`;
  statusLabel.textContent = connected ? 'Binance Connected' : 'Binance Disconnected';

  if (syncTime) {
    updateSyncTime(syncTime);
  }
}

function updateSyncTime(isoTime) {
  const date = new Date(isoTime);
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  if (mins < 1) {
    lastSyncEl.textContent = 'Synced just now';
  } else if (mins < 60) {
    lastSyncEl.textContent = `Synced ${mins}m ago`;
  } else {
    lastSyncEl.textContent = `Synced ${Math.round(mins / 60)}h ago`;
  }
}

function showMsg(el, text, type) {
  el.innerHTML = `<div class="msg ${type}">${text}</div>`;
  setTimeout(() => { el.innerHTML = ''; }, 5000);
}

// Start
init();
