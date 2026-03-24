const API_BASE = 'https://sparkp2p.com/api';

let syncTimeout = null;
let lastSyncTime = 0;
const MIN_SYNC_INTERVAL = 30000;

// ═══════════════════════════════════════════════════════════
// PERSISTENT HEADER CAPTURE — captures csrftoken & bnc-uuid
// from EVERY Binance request automatically
// ═══════════════════════════════════════════════════════════

let capturedCsrf = '';
let capturedBncUuid = '';
let capturedDeviceInfo = '';
let capturedFvideoId = '';

// Intercept ALL requests to Binance to capture headers
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!details.requestHeaders) return;

    for (const header of details.requestHeaders) {
      const name = header.name.toLowerCase();
      if (name === 'csrftoken' && header.value) {
        capturedCsrf = header.value;
      }
      if (name === 'bnc-uuid' && header.value) {
        capturedBncUuid = header.value;
      }
      if (name === 'device-info' && header.value) {
        capturedDeviceInfo = header.value;
      }
      if (name === 'fvideo-id' && header.value) {
        capturedFvideoId = header.value;
      }
    }

    // Save to storage whenever we capture new values
    if (capturedCsrf || capturedBncUuid) {
      chrome.storage.local.set({
        captured_csrf: capturedCsrf,
        captured_bnc_uuid: capturedBncUuid,
        captured_device_info: capturedDeviceInfo,
        captured_fvideo_id: capturedFvideoId,
        headers_last_captured: new Date().toISOString(),
      });
    }
  },
  { urls: ['https://*.binance.com/*'] },
  ['requestHeaders']
);

// ═══════════════════════════════════════════════════════════
// COOKIE CHANGE MONITOR
// ═══════════════════════════════════════════════════════════

chrome.cookies.onChanged.addListener(async (changeInfo) => {
  const cookie = changeInfo.cookie;
  if (!cookie.domain.includes('binance.com')) return;
  if (changeInfo.removed) return;

  const importantCookies = ['p20t', 'r20t', 'cr00', 'csrftoken', 's9r1', 'logined'];
  if (!importantCookies.includes(cookie.name)) return;

  const { auto_sync, sparkp2p_token } = await chrome.storage.local.get(['auto_sync', 'sparkp2p_token']);
  if (auto_sync === false || !sparkp2p_token) return;

  if (syncTimeout) clearTimeout(syncTimeout);
  syncTimeout = setTimeout(() => {
    const now = Date.now();
    if (now - lastSyncTime > MIN_SYNC_INTERVAL) {
      console.log(`[SparkP2P] Cookie "${cookie.name}" changed, auto-syncing...`);
      autoSync();
    }
  }, 3000);
});

// ═══════════════════════════════════════════════════════════
// AUTO-SYNC FUNCTION — sends ALL cookies + captured headers
// ═══════════════════════════════════════════════════════════

async function autoSync() {
  try {
    const {
      sparkp2p_token,
      captured_csrf,
      captured_bnc_uuid,
      captured_device_info,
      captured_fvideo_id,
    } = await chrome.storage.local.get([
      'sparkp2p_token',
      'captured_csrf',
      'captured_bnc_uuid',
      'captured_device_info',
      'captured_fvideo_id',
    ]);

    if (!sparkp2p_token) return;

    // Capture ALL cookies from every Binance domain
    const cookieMap = {};
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
          if (!cookieMap[cookie.name]) {
            cookieMap[cookie.name] = cookie.value;
          }
        }
      } catch (e) { /* ignore */ }
    }

    // Domain-based fallback
    for (const domain of ['.binance.com', 'binance.com']) {
      try {
        const cookies = await chrome.cookies.getAll({ domain });
        for (const cookie of cookies) {
          if (!cookieMap[cookie.name]) {
            cookieMap[cookie.name] = cookie.value;
          }
        }
      } catch (e) { /* ignore */ }
    }

    if (!cookieMap['p20t']) {
      console.log('[SparkP2P] Auto-sync: no p20t cookie found');
      return;
    }

    // Use captured headers (from webRequest interception) as primary source
    // These are the REAL values the browser sends, including from httpOnly cookies
    const csrfToken = captured_csrf || cookieMap['csrftoken'] || '';
    const bncUuid = captured_bnc_uuid || cookieMap['bnc-uuid'] || '';

    // Add captured values to cookie map so backend has them
    if (!cookieMap['logined']) cookieMap['logined'] = 'y';
    if (bncUuid && !cookieMap['bnc-uuid']) cookieMap['bnc-uuid'] = bncUuid;

    // Remove csrftoken from cookies (sent separately)
    const cookiesToSend = { ...cookieMap };
    delete cookiesToSend['csrftoken'];

    const body = {
      cookies: cookiesToSend,
      csrf_token: csrfToken,
      bnc_uuid: bncUuid,
    };

    // Include extra headers if available (for better session replication)
    if (captured_device_info) body.device_info = captured_device_info;
    if (captured_fvideo_id) body.fvideo_id = captured_fvideo_id;

    console.log(`[SparkP2P] Syncing: ${Object.keys(cookieMap).length} cookies, csrf: ${!!csrfToken}, uuid: ${!!bncUuid}`);

    const res = await fetch(`${API_BASE}/traders/connect-binance`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sparkp2p_token}`,
      },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      lastSyncTime = Date.now();
      const now = new Date().toISOString();
      await chrome.storage.local.set({ last_sync: now });
      console.log(`[SparkP2P] Sync successful (${Object.keys(cookieMap).length} cookies, csrf: ${csrfToken ? 'yes' : 'no'})`);
    } else {
      const errText = await res.text();
      console.log('[SparkP2P] Sync failed:', res.status, errText);
    }
  } catch (err) {
    console.error('[SparkP2P] Sync error:', err);
  }
}

// ═══════════════════════════════════════════════════════════
// ALARMS — periodic sync + keepalive
// ═══════════════════════════════════════════════════════════

chrome.alarms.create('sparkp2p-periodic-sync', { periodInMinutes: 15 });
chrome.alarms.create('binance-keepalive', { periodInMinutes: 10 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'sparkp2p-periodic-sync') {
    const { sparkp2p_token, auto_sync } = await chrome.storage.local.get(['sparkp2p_token', 'auto_sync']);
    if (!sparkp2p_token || auto_sync === false) return;
    console.log('[SparkP2P] Periodic sync...');
    autoSync();
  }

  if (alarm.name === 'binance-keepalive') {
    const { auto_sync } = await chrome.storage.local.get('auto_sync');
    if (auto_sync === false) return;

    try {
      await fetch('https://www.binance.com/bapi/accounts/v1/public/authcenter/auth', {
        credentials: 'include',
      });
      console.log('[SparkP2P] Keepalive ping sent');
    } catch (e) {
      console.log('[SparkP2P] Keepalive failed:', e.message);
    }
  }
});

// ═══════════════════════════════════════════════════════════
// MESSAGE LISTENER
// ═══════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'auto_sync_changed') {
    console.log('[SparkP2P] Auto-sync:', msg.enabled ? 'enabled' : 'disabled');
  }
  if (msg.type === 'get_captured_headers') {
    sendResponse({
      csrf: capturedCsrf,
      bnc_uuid: capturedBncUuid,
      device_info: capturedDeviceInfo,
      fvideo_id: capturedFvideoId,
    });
  }
  if (msg.type === 'force_sync') {
    autoSync().then(() => sendResponse({ done: true }));
    return true;
  }
});
