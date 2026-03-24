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
    // Step 0: Use scripting.executeScript to run code directly in the Binance page
    // This bypasses CSP and content script isolation issues
    let contentCsrf = '';
    let contentUuid = '';
    let contentCookies = '';
    try {
      const tabs = await chrome.tabs.query({ url: '*://*.binance.com/*' });
      if (tabs.length > 0) {
        const tab = tabs[0];
        console.log(`[SparkP2P] Found Binance tab: ${tab.url}`);

        // Execute script directly in the page to get cookies
        const cookieResult = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => document.cookie,
        });
        contentCookies = cookieResult?.[0]?.result || '';
        console.log(`[SparkP2P] Page cookies: ${contentCookies.length} chars`);

        // Execute script to find csrftoken from Binance's JS globals
        const csrfResult = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            // Try multiple sources for csrftoken
            // 1. Check if it's in a cookie
            const cookies = document.cookie.split(';').reduce((acc, c) => {
              const [k, ...v] = c.trim().split('=');
              acc[k] = v.join('=');
              return acc;
            }, {});
            if (cookies.csrftoken) return { csrf: cookies.csrftoken, source: 'cookie' };

            // 2. Check localStorage
            const ls = localStorage.getItem('csrftoken');
            if (ls) return { csrf: ls, source: 'localStorage' };

            // 3. Check sessionStorage
            const ss = sessionStorage.getItem('csrftoken');
            if (ss) return { csrf: ss, source: 'sessionStorage' };

            // 4. Check meta tags
            const meta = document.querySelector('meta[name="csrf-token"], meta[name="csrftoken"]');
            if (meta) return { csrf: meta.content, source: 'meta' };

            // 5. Search window object for anything csrf-related
            try {
              // Binance stores it in their app state
              const scripts = document.querySelectorAll('script');
              for (const s of scripts) {
                if (s.textContent.includes('csrftoken')) {
                  const match = s.textContent.match(/csrftoken['":\s]+['"]([a-f0-9]{32,})['"]/);
                  if (match) return { csrf: match[1], source: 'script' };
                }
              }
            } catch (e) {}

            return { csrf: '', source: 'not_found' };
          },
        });
        const csrfData = csrfResult?.[0]?.result || {};
        contentCsrf = csrfData.csrf || '';
        console.log(`[SparkP2P] CSRF from ${csrfData.source}: ${contentCsrf ? contentCsrf.substring(0, 10) + '...' : 'EMPTY'}`);

        // Get bnc-uuid from cookies
        const uuidResult = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const cookies = document.cookie.split(';').reduce((acc, c) => {
              const [k, ...v] = c.trim().split('=');
              acc[k.trim()] = v.join('=');
              return acc;
            }, {});
            return cookies['bnc-uuid'] || '';
          },
        });
        contentUuid = uuidResult?.[0]?.result || '';
        console.log(`[SparkP2P] UUID: ${contentUuid ? contentUuid.substring(0, 10) + '...' : 'EMPTY'}`);

      } else {
        console.log('[SparkP2P] No Binance tab found');
        showMsg(syncMsg, 'Please open Binance P2P in a tab first, then try again.', 'error');
        btn.disabled = false;
        btn.textContent = 'Sync Binance Cookies';
        return;
      }
    } catch (e) {
      console.log('[SparkP2P] Script execution error:', e.message);
    }
    // Capture ALL cookies from Binance including httpOnly (chrome.cookies API can!)
    const cookieMap = {};

    // FIRST: Specifically search for csrftoken on all domains
    // chrome.cookies.getAll CAN read httpOnly cookies
    const csrfSearchDomains = ['.binance.com', 'www.binance.com', 'c2c.binance.com', 'p2p.binance.com', 'accounts.binance.com'];
    for (const domain of csrfSearchDomains) {
      try {
        const csrfCookies = await chrome.cookies.getAll({ domain, name: 'csrftoken' });
        if (csrfCookies.length > 0) {
          cookieMap['csrftoken'] = csrfCookies[0].value;
          console.log(`[SparkP2P] Found csrftoken on ${domain}: ${csrfCookies[0].value.substring(0, 10)}... (httpOnly: ${csrfCookies[0].httpOnly})`);
          break;
        }
      } catch (e) {}
    }

    // Also search by URL
    if (!cookieMap['csrftoken']) {
      for (const url of ['https://www.binance.com', 'https://c2c.binance.com', 'https://p2p.binance.com']) {
        try {
          const csrfCookies = await chrome.cookies.getAll({ url, name: 'csrftoken' });
          if (csrfCookies.length > 0) {
            cookieMap['csrftoken'] = csrfCookies[0].value;
            console.log(`[SparkP2P] Found csrftoken via URL ${url}: ${csrfCookies[0].value.substring(0, 10)}...`);
            break;
          }
        } catch (e) {}
      }
    }

    console.log(`[SparkP2P] csrftoken after explicit search: ${cookieMap['csrftoken'] ? 'FOUND' : 'NOT FOUND'}`);

    // Get ALL cookies from all Binance URLs
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

    // Merge cookies from page's document.cookie (includes cookies not visible to extension API)
    if (contentCookies) {
      contentCookies.split(';').forEach(c => {
        const [name, ...rest] = c.trim().split('=');
        const val = rest.join('=');
        if (name && val) {
          // Page cookies override extension API cookies (more complete)
          cookieMap[name.trim()] = val;
        }
      });
    }

    // Add bnc-uuid from page if we got it
    if (contentUuid && !cookieMap['bnc-uuid']) {
      cookieMap['bnc-uuid'] = contentUuid;
    }

    // Add csrftoken from page if found
    if (contentCsrf && !cookieMap['csrftoken']) {
      cookieMap['csrftoken'] = contentCsrf;
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

    // Priority for csrf/uuid: content script (page interceptor) > cookies
    const csrfToken = contentCsrf || cookieMap['csrftoken'] || '';
    const bncUuid = contentUuid || cookieMap['bnc-uuid'] || '';

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
