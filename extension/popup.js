const API_BASE = 'https://sparkp2p.com/api';

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
    // Step 0: Try to capture headers from content script on active Binance tab
    let contentHeaders = {};
    let contentCookies = '';
    try {
      const [tab] = await chrome.tabs.query({ active: true, url: '*://*.binance.com/*' });
      if (tab) {
        // First trigger a request so the content script can capture fresh headers
        const triggerResult = await chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_CAPTURE' });
        console.log('[SparkP2P] Trigger result:', triggerResult);

        // Wait a moment then get captured headers
        await new Promise(r => setTimeout(r, 1000));
        const captured = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CAPTURED_HEADERS' });
        contentHeaders = captured?.headers || {};
        contentCookies = captured?.documentCookies || '';
        console.log('[SparkP2P] Content script headers:', Object.keys(contentHeaders));
        console.log('[SparkP2P] Content script cookies length:', contentCookies.length);
      }
    } catch (e) {
      console.log('[SparkP2P] Content script not available:', e.message);
    }
    // Capture ALL cookies from Binance — not just a filtered list
    const cookieMap = {};

    // Get from all Binance URLs
    const urls = [
      'https://www.binance.com',
      'https://binance.com',
      'https://p2p.binance.com',
      'https://c2c.binance.com',
      'https://accounts.binance.com',
    ];

    for (const url of urls) {
      try {
        const cookies = await chrome.cookies.getAll({ url });
        for (const cookie of cookies) {
          // Capture EVERY cookie, not just specific ones
          if (!cookieMap[cookie.name]) {
            cookieMap[cookie.name] = cookie.value;
          }
        }
      } catch (e) { /* ignore */ }
    }

    // Also domain-based
    const domains = ['.binance.com', 'binance.com'];
    for (const domain of domains) {
      try {
        const cookies = await chrome.cookies.getAll({ domain });
        for (const cookie of cookies) {
          if (!cookieMap[cookie.name]) {
            cookieMap[cookie.name] = cookie.value;
          }
        }
      } catch (e) { /* ignore */ }
    }

    // Merge cookies from document.cookie (content script)
    if (contentCookies) {
      contentCookies.split(';').forEach(c => {
        const [name, ...rest] = c.trim().split('=');
        if (name && rest.length > 0 && !cookieMap[name]) {
          cookieMap[name] = rest.join('=');
        }
      });
    }

    // Extract csrftoken from content script headers (the REAL one the browser sends)
    if (contentHeaders['csrftoken'] && !cookieMap['csrftoken']) {
      cookieMap['csrftoken'] = contentHeaders['csrftoken'];
    }

    // Extract bnc-uuid from content script headers
    if (contentHeaders['bnc-uuid'] && !cookieMap['bnc-uuid']) {
      cookieMap['bnc-uuid'] = contentHeaders['bnc-uuid'];
    }

    const totalFound = Object.keys(cookieMap).length;
    const hasP20t = !!cookieMap['p20t'];

    console.log(`[SparkP2P] Total captured: ${totalFound} cookies, p20t: ${hasP20t}, csrf: ${!!cookieMap['csrftoken']}`);

    if (!hasP20t) {
      showMsg(syncMsg, `No Binance session found (${totalFound} cookies captured). Please login to Binance first.`, 'error');
      btn.disabled = false;
      btn.textContent = 'Sync Binance Cookies';
      return;
    }

    // Get csrftoken and bnc-uuid from background's webRequest capture (most reliable)
    let bgHeaders = {};
    try {
      bgHeaders = await chrome.runtime.sendMessage({ type: 'get_captured_headers' });
    } catch (e) { /* ignore */ }

    // Also check stored values
    const stored = await chrome.storage.local.get(['captured_csrf', 'captured_bnc_uuid']);

    // Priority: background capture > stored > content script > cookies
    const csrfToken = bgHeaders?.csrf || stored.captured_csrf || contentHeaders['csrftoken'] || cookieMap['csrftoken'] || '';
    const bncUuid = bgHeaders?.bnc_uuid || stored.captured_bnc_uuid || contentHeaders['bnc-uuid'] || cookieMap['bnc-uuid'] || '';

    console.log(`[SparkP2P] CSRF: ${csrfToken ? csrfToken.substring(0, 10) + '...' : 'MISSING'}`);
    console.log(`[SparkP2P] BNC-UUID: ${bncUuid ? bncUuid.substring(0, 10) + '...' : 'MISSING'}`);

    // Send ALL cookies to SparkP2P — let the backend use what it needs
    const cookiesToSend = { ...cookieMap };
    delete cookiesToSend['csrftoken']; // sent separately

    const { sparkp2p_token } = await chrome.storage.local.get('sparkp2p_token');

    const res = await fetch(`${API_BASE}/traders/connect-binance`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sparkp2p_token}`,
      },
      body: JSON.stringify({
        cookies: cookiesToSend,
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

      let msg = `Connected! (${totalFound} cookies synced)`;
      if (data.binance_name) {
        msg = `Connected as: ${data.binance_name}`;
      }
      if (data.name_match === false && data.binance_name) {
        showMsg(syncMsg, `${msg} — Name mismatch with ${data.registered_name}. Update in Settings.`, 'error');
      } else {
        showMsg(syncMsg, msg, 'success');
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
  const btn = document.getElementById('check-btn');
  btn.disabled = true;
  btn.textContent = 'Checking...';

  try {
    const { sparkp2p_token } = await chrome.storage.local.get('sparkp2p_token');
    const res = await fetch(`${API_BASE}/traders/me`, {
      headers: { 'Authorization': `Bearer ${sparkp2p_token}` },
    });

    if (!res.ok) {
      updateStatus(false);
      showMsg(syncMsg, 'Could not reach SparkP2P. Check your connection.', 'error');
      btn.disabled = false;
      btn.textContent = 'Check Status';
      return;
    }

    const data = await res.json();
    updateStatus(data.binance_connected);

    if (data.binance_connected) {
      showMsg(syncMsg, `Connected as: ${data.full_name}${data.binance_username ? ' (' + data.binance_username + ')' : ''}`, 'success');
    } else {
      showMsg(syncMsg, 'Binance not connected. Click "Sync Binance Cookies" while logged into Binance.', 'error');
    }

    const { last_sync } = await chrome.storage.local.get('last_sync');
    if (last_sync) {
      updateSyncTime(last_sync);
    }
  } catch (err) {
    updateStatus(false);
    showMsg(syncMsg, 'Connection check failed: ' + err.message, 'error');
  }

  btn.disabled = false;
  btn.textContent = 'Check Status';
}

// ── Auto-sync toggle ─────────────────────────────────
document.getElementById('auto-sync').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ auto_sync: e.target.checked });
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
  if (syncTime) updateSyncTime(syncTime);
}

function updateSyncTime(isoTime) {
  const date = new Date(isoTime);
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  if (mins < 1) lastSyncEl.textContent = 'Synced just now';
  else if (mins < 60) lastSyncEl.textContent = `Synced ${mins}m ago`;
  else lastSyncEl.textContent = `Synced ${Math.round(mins / 60)}h ago`;
}

function showMsg(el, text, type) {
  el.innerHTML = `<div class="msg ${type}">${text}</div>`;
  setTimeout(() => { el.innerHTML = ''; }, 8000);
}

init();
