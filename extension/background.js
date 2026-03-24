/**
 * SparkP2P Background Service Worker — Trading Engine Orchestrator
 *
 * Architecture:
 *   background.js (this) — timer, VPS communication, state management
 *   content.js           — executes Binance API calls from the browser
 *
 * Flow every 10 seconds:
 *   1. background sends "poll orders" to content script on Binance tab
 *   2. content script fetches orders from Binance (correct IP!)
 *   3. background sends orders to VPS: POST /api/ext/report-orders
 *   4. VPS responds with actions (release, pay, send_message)
 *   5. background sends each action to content script for execution
 *   6. background reports results to VPS
 */

const API_BASE = 'https://sparkp2p.com/api';
const POLL_INTERVAL_MS = 10000;   // 10 seconds
const HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds

// ═══════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════

let pollerRunning = false;
let pollTimer = null;
let heartbeatTimer = null;
let binanceTabId = null;
let lastPollTime = null;
let lastHeartbeatTime = null;
let stats = {
  polls: 0,
  actions_executed: 0,
  errors: 0,
  last_error: null,
  orders_tracked: 0,
};

// ═══════════════════════════════════════════════════════════
// ALARMS (persistent timers that survive service worker restarts)
// ═══════════════════════════════════════════════════════════

chrome.alarms.create('sparkp2p-poll', { periodInMinutes: 0.17 }); // ~10 seconds
chrome.alarms.create('sparkp2p-heartbeat', { periodInMinutes: 0.5 }); // 30 seconds

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'sparkp2p-poll') {
    if (!pollerRunning) return;
    await pollCycle();
  }
  if (alarm.name === 'sparkp2p-heartbeat') {
    if (!pollerRunning) return;
    await sendHeartbeat();
  }
});

// ═══════════════════════════════════════════════════════════
// POLLER CONTROL
// ═══════════════════════════════════════════════════════════

async function startPoller() {
  const token = await getToken();
  if (!token) {
    console.log('[SparkP2P] Cannot start poller — not logged in');
    return false;
  }

  pollerRunning = true;
  await chrome.storage.local.set({ poller_running: true });
  console.log('[SparkP2P] Poller started');

  // Run first cycle immediately
  pollCycle();
  sendHeartbeat();
  return true;
}

async function stopPoller() {
  pollerRunning = false;
  await chrome.storage.local.set({ poller_running: false });
  console.log('[SparkP2P] Poller stopped');
}

// ═══════════════════════════════════════════════════════════
// MAIN POLL CYCLE
// ═══════════════════════════════════════════════════════════

async function pollCycle() {
  try {
    const token = await getToken();
    if (!token) return;

    // Find Binance tab with content script
    const tabId = await findBinanceTab();
    if (!tabId) {
      // No Binance tab — can't make API calls
      await chrome.storage.local.set({ binance_tab_active: false });
      return;
    }
    await chrome.storage.local.set({ binance_tab_active: true });
    binanceTabId = tabId;

    // 1. Get sell orders from Binance via content script
    const sellOrders = await sendToBinanceTab(tabId, {
      type: 'BINANCE_REQUEST',
      endpoint: '/c2c/order-match/order-list',
      payload: {
        page: 1,
        rows: 20,
        tradeType: 'SELL',
        orderStatusList: [1, 2, 3],
      },
    });

    // 2. Get buy orders from Binance via content script
    const buyOrders = await sendToBinanceTab(tabId, {
      type: 'BINANCE_REQUEST',
      endpoint: '/c2c/order-match/order-list',
      payload: {
        page: 1,
        rows: 20,
        tradeType: 'BUY',
        orderStatusList: [1, 2, 3],
      },
    });

    const sellData = sellOrders.success ? (sellOrders.data?.data || []) : [];
    const buyData = buyOrders.success ? (buyOrders.data?.data || []) : [];

    stats.orders_tracked = sellData.length + buyData.length;

    // 3. Report orders to VPS
    const reportResp = await fetchVPS('/ext/report-orders', {
      method: 'POST',
      body: JSON.stringify({
        sell_orders: sellData.map(normalizeOrder),
        buy_orders: buyData.map(normalizeOrder),
      }),
    }, token);

    if (!reportResp.ok) {
      throw new Error(`VPS report-orders failed: ${reportResp.status}`);
    }

    const { actions } = await reportResp.json();

    // 4. Execute actions from VPS
    for (const action of (actions || [])) {
      await executeAction(action, tabId, token);
    }

    stats.polls++;
    lastPollTime = new Date().toISOString();
    await chrome.storage.local.set({
      last_poll: lastPollTime,
      poll_stats: stats,
    });

  } catch (err) {
    stats.errors++;
    stats.last_error = err.message;
    console.error('[SparkP2P] Poll cycle error:', err.message);
    await chrome.storage.local.set({ poll_stats: stats });
  }
}

// ═══════════════════════════════════════════════════════════
// ACTION EXECUTION
// ═══════════════════════════════════════════════════════════

async function executeAction(action, tabId, token) {
  console.log(`[SparkP2P] Executing action: ${action.action} for order ${action.order_number}`);

  try {
    if (action.action === 'release') {
      await executeRelease(action.order_number, tabId, token);
    } else if (action.action === 'pay') {
      await executeMarkAsPaid(action.order_number, tabId, token);
    } else if (action.action === 'send_message') {
      await executeSendMessage(action.order_number, action.message, tabId, token);
    }
    stats.actions_executed++;
  } catch (err) {
    console.error(`[SparkP2P] Action ${action.action} failed:`, err.message);
    stats.errors++;
    stats.last_error = err.message;
  }
}

async function executeRelease(orderNumber, tabId, token) {
  // Release crypto on Binance
  const result = await sendToBinanceTab(tabId, {
    type: 'BINANCE_REQUEST',
    endpoint: '/c2c/order-match/confirm-order',
    payload: { orderNumber },
  });

  const success = result.success && result.data?.code === '000000';

  // Report result to VPS
  await fetchVPS('/ext/report-release', {
    method: 'POST',
    body: JSON.stringify({
      order_number: orderNumber,
      success,
      error: result.success ? null : result.error,
    }),
  }, token);

  if (success) {
    console.log(`[SparkP2P] Released order ${orderNumber}`);
    showNotification('Crypto Released', `Order ${orderNumber} released successfully`);
  } else {
    console.error(`[SparkP2P] Release failed for ${orderNumber}:`, result.error);
    showNotification('Release Failed', `Order ${orderNumber}: ${result.error || 'Unknown error'}`);
  }
}

async function executeMarkAsPaid(orderNumber, tabId, token) {
  // Mark order as paid on Binance (buy side)
  const result = await sendToBinanceTab(tabId, {
    type: 'BINANCE_REQUEST',
    endpoint: '/c2c/order-match/buyer-confirm-pay',
    payload: { orderNumber },
  });

  const success = result.success && result.data?.code === '000000';

  // Report result to VPS
  await fetchVPS('/ext/report-payment-sent', {
    method: 'POST',
    body: JSON.stringify({
      order_number: orderNumber,
      success,
      error: result.success ? null : result.error,
    }),
  }, token);

  if (success) {
    console.log(`[SparkP2P] Marked order ${orderNumber} as paid`);
  }
}

async function executeSendMessage(orderNumber, message, tabId, token) {
  // Send chat message on Binance
  const result = await sendToBinanceTab(tabId, {
    type: 'BINANCE_REQUEST',
    endpoint: '/c2c/chat/send-message',
    payload: {
      orderNumber,
      message,
      msgType: 1,
    },
  });

  const success = result.success;

  // Report result to VPS
  await fetchVPS('/ext/report-message-sent', {
    method: 'POST',
    body: JSON.stringify({
      order_number: orderNumber,
      success,
    }),
  }, token);

  if (success) {
    console.log(`[SparkP2P] Sent message for order ${orderNumber}`);
  }
}

// ═══════════════════════════════════════════════════════════
// HEARTBEAT
// ═══════════════════════════════════════════════════════════

async function sendHeartbeat() {
  try {
    const token = await getToken();
    if (!token) return;

    const resp = await fetchVPS('/ext/heartbeat', { method: 'POST' }, token);
    if (resp.ok) {
      lastHeartbeatTime = new Date().toISOString();
      await chrome.storage.local.set({ last_heartbeat: lastHeartbeatTime });
    }
  } catch (err) {
    console.error('[SparkP2P] Heartbeat error:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// CONTENT SCRIPT COMMUNICATION
// ═══════════════════════════════════════════════════════════

async function findBinanceTab() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://*.binance.com/*' });
    if (tabs.length === 0) return null;

    // Prefer P2P page, fall back to any Binance tab
    const p2pTab = tabs.find(t => t.url && (
      t.url.includes('/p2p') || t.url.includes('/c2c') ||
      t.url.includes('/fiat/order')
    ));
    const tab = p2pTab || tabs[0];

    // Check if content script is alive
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
      if (resp?.alive) return tab.id;
    } catch (e) {
      // Content script not loaded — try injecting it
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js'],
        });
        // Wait briefly for it to initialize
        await new Promise(r => setTimeout(r, 500));
        const resp = await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
        if (resp?.alive) return tab.id;
      } catch (e2) {
        console.warn('[SparkP2P] Could not inject content script:', e2.message);
      }
    }

    return null;
  } catch (err) {
    console.error('[SparkP2P] findBinanceTab error:', err.message);
    return null;
  }
}

function sendToBinanceTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({
          success: false,
          error: chrome.runtime.lastError.message || 'Content script communication failed',
        });
      } else {
        resolve(response || { success: false, error: 'No response from content script' });
      }
    });
  });
}

// ═══════════════════════════════════════════════════════════
// VPS COMMUNICATION
// ═══════════════════════════════════════════════════════════

async function fetchVPS(path, options = {}, token = null) {
  if (!token) token = await getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
  };

  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });
}

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════

async function getToken() {
  const { sparkp2p_token } = await chrome.storage.local.get('sparkp2p_token');
  return sparkp2p_token || null;
}

function normalizeOrder(binanceOrder) {
  return {
    orderNumber: binanceOrder.orderNumber || '',
    advNo: binanceOrder.advNo || null,
    tradeType: binanceOrder.tradeType || '',
    totalPrice: parseFloat(binanceOrder.totalPrice || 0),
    amount: parseFloat(binanceOrder.amount || 0),
    price: parseFloat(binanceOrder.price || 0),
    asset: binanceOrder.asset || 'USDT',
    buyerNickname: binanceOrder.buyerNickname || null,
    sellerNickname: binanceOrder.sellerNickname || null,
    orderStatus: binanceOrder.orderStatus || null,
  };
}

function showNotification(title, message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icon128.png',
      title: `SparkP2P: ${title}`,
      message,
    });
  } catch (e) {
    // Notifications may not be available in all contexts
  }
}

// ═══════════════════════════════════════════════════════════
// COOKIE SYNC (kept from v1 — auto-sync cookies to VPS)
// ═══════════════════════════════════════════════════════════

async function syncCookiesToVPS() {
  try {
    const token = await getToken();
    if (!token) return;

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

    if (!cookieMap['p20t']) return;

    const csrfToken = cookieMap['csrftoken'] || '';
    const bncUuid = cookieMap['bnc-uuid'] || '';

    const cookiesToSend = { ...cookieMap };
    delete cookiesToSend['csrftoken'];

    const res = await fetchVPS('/traders/connect-binance', {
      method: 'POST',
      body: JSON.stringify({
        cookies: cookiesToSend,
        csrf_token: csrfToken,
        bnc_uuid: bncUuid,
      }),
    }, token);

    if (res.ok) {
      await chrome.storage.local.set({ last_sync: new Date().toISOString() });
      console.log('[SparkP2P] Cookie sync successful');
    }
  } catch (err) {
    console.error('[SparkP2P] Cookie sync error:', err.message);
  }
}

// Sync cookies every 15 minutes
chrome.alarms.create('sparkp2p-cookie-sync', { periodInMinutes: 15 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'sparkp2p-cookie-sync') {
    const token = await getToken();
    if (token) syncCookiesToVPS();
  }
});

// ═══════════════════════════════════════════════════════════
// MESSAGE LISTENER (from popup and content script)
// ═══════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Content script ready notification
  if (msg.type === 'CONTENT_SCRIPT_READY') {
    console.log('[SparkP2P] Content script ready on:', msg.url);
    // If poller should be running, auto-start
    chrome.storage.local.get('poller_running', (data) => {
      if (data.poller_running && !pollerRunning) {
        startPoller();
      }
    });
    return false;
  }

  // Popup requests
  if (msg.type === 'START_POLLER') {
    startPoller().then(ok => sendResponse({ started: ok }));
    return true;
  }

  if (msg.type === 'STOP_POLLER') {
    stopPoller().then(() => sendResponse({ stopped: true }));
    return true;
  }

  if (msg.type === 'GET_STATUS') {
    (async () => {
      const tabId = await findBinanceTab();
      sendResponse({
        poller_running: pollerRunning,
        binance_tab_found: !!tabId,
        last_poll: lastPollTime,
        last_heartbeat: lastHeartbeatTime,
        stats,
      });
    })();
    return true;
  }

  if (msg.type === 'FORCE_SYNC') {
    syncCookiesToVPS().then(() => sendResponse({ done: true }));
    return true;
  }

  if (msg.type === 'OPEN_BINANCE_TAB') {
    chrome.tabs.create({ url: 'https://p2p.binance.com/en/trade/all-payments/USDT?fiat=KES' });
    sendResponse({ opened: true });
    return false;
  }
});

// ═══════════════════════════════════════════════════════════
// STARTUP — restore state
// ═══════════════════════════════════════════════════════════

chrome.storage.local.get(['poller_running', 'sparkp2p_token'], (data) => {
  if (data.poller_running && data.sparkp2p_token) {
    console.log('[SparkP2P] Restoring poller state — starting');
    startPoller();
  }
});

console.log('[SparkP2P] Background service worker loaded (v2.0 — Extension Trading Engine)');
