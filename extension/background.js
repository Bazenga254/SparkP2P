const API_BASE = 'https://sparkp2p.com/api';

let syncTimeout = null;
let lastSyncTime = 0;
const MIN_SYNC_INTERVAL = 30000; // Don't sync more than once per 30 seconds

// Monitor ANY cookie change on binance.com
chrome.cookies.onChanged.addListener(async (changeInfo) => {
  const cookie = changeInfo.cookie;

  // Only care about binance.com cookies
  if (!cookie.domain.includes('binance.com')) return;

  // Only on cookie set (not removal)
  if (changeInfo.removed) return;

  // Only care about important cookies (session-related)
  const importantCookies = ['p20t', 'r20t', 'cr00', 'csrftoken', 's9r1', 'logined'];
  if (!importantCookies.includes(cookie.name)) return;

  const { auto_sync, sparkp2p_token } = await chrome.storage.local.get(['auto_sync', 'sparkp2p_token']);
  if (auto_sync === false || !sparkp2p_token) return;

  // Debounce — wait 3 seconds after last cookie change before syncing
  // This ensures all cookies from a login/refresh are captured together
  if (syncTimeout) clearTimeout(syncTimeout);
  syncTimeout = setTimeout(() => {
    const now = Date.now();
    if (now - lastSyncTime > MIN_SYNC_INTERVAL) {
      console.log(`[SparkP2P] Cookie "${cookie.name}" changed, auto-syncing...`);
      autoSync();
    }
  }, 3000);
});

async function autoSync() {
  try {
    const { sparkp2p_token } = await chrome.storage.local.get('sparkp2p_token');
    if (!sparkp2p_token) return;

    // Capture ALL cookies from Binance
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

    // Domain-based
    try {
      const cookies = await chrome.cookies.getAll({ domain: '.binance.com' });
      for (const cookie of cookies) {
        if (!cookieMap[cookie.name]) {
          cookieMap[cookie.name] = cookie.value;
        }
      }
    } catch (e) { /* ignore */ }

    if (!cookieMap['p20t']) {
      console.log('[SparkP2P] Auto-sync: no p20t cookie found');
      return;
    }

    const csrfToken = cookieMap['csrftoken'] || '';
    const bncUuid = cookieMap['bnc-uuid'] || '';
    const cookiesToSend = { ...cookieMap };
    delete cookiesToSend['csrftoken'];

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

    if (res.ok) {
      lastSyncTime = Date.now();
      const now = new Date().toISOString();
      await chrome.storage.local.set({ last_sync: now });
      console.log(`[SparkP2P] Auto-sync successful (${Object.keys(cookieMap).length} cookies)`);
    } else {
      console.log('[SparkP2P] Auto-sync failed:', res.status);
    }
  } catch (err) {
    console.error('[SparkP2P] Auto-sync error:', err);
  }
}

// Periodic sync every 15 minutes to keep connection alive
chrome.alarms.create('sparkp2p-periodic-sync', { periodInMinutes: 15 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'sparkp2p-periodic-sync') return;

  const { sparkp2p_token, auto_sync } = await chrome.storage.local.get(['sparkp2p_token', 'auto_sync']);
  if (!sparkp2p_token || auto_sync === false) return;

  console.log('[SparkP2P] Periodic sync...');
  autoSync();
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'auto_sync_changed') {
    console.log('[SparkP2P] Auto-sync:', msg.enabled ? 'enabled' : 'disabled');
  }
});
