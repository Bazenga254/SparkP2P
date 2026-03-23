const API_BASE = 'https://sparkp2p.com/api';

const BINANCE_COOKIE_NAMES = [
  'p20t', 'bnc-uuid', 'logined', 'cr00', 'r20t', 'r30t',
  'BNC_FV_KEY', 's9r1', 'csrftoken', 'lang',
];

// Monitor cookie changes on binance.com
chrome.cookies.onChanged.addListener(async (changeInfo) => {
  const cookie = changeInfo.cookie;

  // Only care about binance.com cookies
  if (!cookie.domain.includes('binance.com')) return;

  // Only care about the session cookie (p20t)
  if (cookie.name !== 'p20t') return;

  // Only on cookie set (not removal)
  if (changeInfo.removed) return;

  // Check if auto-sync is enabled
  const { auto_sync, sparkp2p_token } = await chrome.storage.local.get(['auto_sync', 'sparkp2p_token']);

  if (auto_sync === false || !sparkp2p_token) return;

  console.log('[SparkP2P] Binance session cookie changed, auto-syncing...');

  // Wait a moment for all cookies to update
  setTimeout(() => autoSync(), 2000);
});

async function autoSync() {
  try {
    const { sparkp2p_token } = await chrome.storage.local.get('sparkp2p_token');
    if (!sparkp2p_token) return;

    // Get all binance cookies
    const allCookies = await chrome.cookies.getAll({ domain: '.binance.com' });
    const c2cCookies = await chrome.cookies.getAll({ domain: 'c2c.binance.com' });

    const cookieMap = {};
    for (const cookie of [...allCookies, ...c2cCookies]) {
      if (BINANCE_COOKIE_NAMES.includes(cookie.name)) {
        cookieMap[cookie.name] = cookie.value;
      }
    }

    if (!cookieMap['p20t']) return;

    const csrfToken = cookieMap['csrftoken'] || '';
    const bncUuid = cookieMap['bnc-uuid'] || '';
    delete cookieMap['csrftoken'];

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

    if (res.ok) {
      const now = new Date().toISOString();
      await chrome.storage.local.set({ last_sync: now });
      console.log('[SparkP2P] Auto-sync successful');
    } else {
      console.log('[SparkP2P] Auto-sync failed:', res.status);
    }
  } catch (err) {
    console.error('[SparkP2P] Auto-sync error:', err);
  }
}

// Periodic check every 30 minutes
chrome.alarms.create('sparkp2p-check', { periodInMinutes: 30 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'sparkp2p-check') return;

  const { sparkp2p_token, auto_sync } = await chrome.storage.local.get(['sparkp2p_token', 'auto_sync']);
  if (!sparkp2p_token || auto_sync === false) return;

  // Check if cookies still valid
  const cookies = await chrome.cookies.getAll({ domain: '.binance.com' });
  const p20t = cookies.find(c => c.name === 'p20t');

  if (!p20t) {
    console.log('[SparkP2P] Binance session expired');
    return;
  }

  // Auto-sync to keep connection fresh
  autoSync();
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'auto_sync_changed') {
    console.log('[SparkP2P] Auto-sync:', msg.enabled ? 'enabled' : 'disabled');
  }
});
