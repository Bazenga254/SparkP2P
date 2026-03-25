const { app, BrowserWindow, Tray, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const puppeteer = require('puppeteer-core');

// Logging
const logFile = path.join(__dirname, 'sparkp2p.log');
fs.writeFileSync(logFile, '');
const _log = console.log, _err = console.error;
console.log = (...a) => { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${a.join(' ')}\n`); _log(...a); };
console.error = (...a) => { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ERR: ${a.join(' ')}\n`); _err(...a); };

const API_BASE = 'https://sparkp2p.com/api';
const DASHBOARD_URL = 'https://sparkp2p.com/dashboard';
const CDP_PORT = 9222;
const POLL_INTERVAL = 10000;

let mainWindow = null;
let tray = null;
let token = null;
let browser = null;  // Puppeteer browser instance
let binancePage = null;  // p2p.binance.com tab for order polling
let pollerRunning = false;
let pollTimer = null;
let stats = { polls: 0, actions: 0, errors: 0, orders: 0 };

// Captured data from Binance page's own network requests
let capturedData = { balances: [], ads: [], paymentMethods: [], nickname: '', uid: '' };

// ═══════════════════════════════════════════════════════════
// ELECTRON APP
// ═══════════════════════════════════════════════════════════

app.whenReady().then(() => { createMainWindow(); createTray(); });
app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', () => { stopPoller(); if (tray) tray.destroy(); });

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 850, title: 'SparkP2P',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true },
    autoHideMenuBar: true,
  });
  mainWindow.loadURL(DASHBOARD_URL);
  mainWindow.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); mainWindow.hide(); } });

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.executeJavaScript('localStorage.getItem("token")')
      .then((t) => { if (t) { token = t; console.log('[SparkP2P] Token captured'); tryAutoStart(); } }).catch(() => {});
  });

  mainWindow.webContents.session.webRequest.onBeforeRequest(
    { urls: ['wss://sparkp2p.com/api/browser/login-stream*', 'ws://*/api/browser/login-stream*'] },
    (_, cb) => { cb({ cancel: true }); connectBinance(); }
  );
}

function createTray() {
  try {
    tray = new Tray(path.join(__dirname, 'icon.png'));
    tray.setToolTip('SparkP2P');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open SparkP2P', click: () => mainWindow.show() },
      { type: 'separator' },
      { label: 'Connect Binance', click: () => connectBinance() },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
    tray.on('double-click', () => mainWindow.show());
  } catch (e) {}
}

// ═══════════════════════════════════════════════════════════
// CHROME + PUPPETEER (GoLogin approach)
//
// 1. Launch user's real Chrome with --remote-debugging-port
// 2. Connect Puppeteer via WebSocket (like GoLogin does)
// 3. page.evaluate() runs in REAL page context with cookies
// 4. No CDP restrictions — full browser access
// ═══════════════════════════════════════════════════════════

function findChrome() {
  for (const p of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ]) { if (fs.existsSync(p)) return p; }
  return null;
}

async function launchChrome() {
  const chrome = findChrome();
  if (!chrome) { console.error('Chrome not found'); return false; }

  execFile(chrome, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + path.join(app.getPath('userData'), 'chrome-binance'),
    'https://accounts.binance.com/en/login',
  ]);
  console.log('[SparkP2P] Chrome launched');
  await new Promise(r => setTimeout(r, 5000));
  return true;
}

async function connectPuppeteer() {
  try {
    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${CDP_PORT}`,
      defaultViewport: null,
    });
    console.log('[SparkP2P] Puppeteer connected to Chrome');
    return true;
  } catch (e) {
    console.error('[SparkP2P] Puppeteer connect failed:', e.message);
    return false;
  }
}

async function findBinancePage() {
  if (!browser) return null;
  const pages = await browser.pages();
  // Prefer p2p.binance.com (new domain) or c2c.binance.com
  return pages.find(p => p.url().includes('p2p.binance.com'))
    || pages.find(p => p.url().includes('c2c.binance.com'))
    || pages.find(p => p.url().includes('binance.com') && !p.url().includes('accounts.google'));
}

async function isLoggedIn() {
  const page = await findBinancePage();
  if (!page) return false;
  try {
    const cookies = await page.cookies('https://www.binance.com', 'https://c2c.binance.com');
    return cookies.some(c => c.name === 'p20t') || cookies.some(c => c.name === 'logined');
  } catch (e) { return false; }
}

// ═══════════════════════════════════════════════════════════
// CONNECT BINANCE — Launch Chrome, wait for login, start bot
// ═══════════════════════════════════════════════════════════

async function connectBinance() {
  // Launch Chrome if not running
  if (!browser) {
    const launched = await launchChrome();
    if (!launched) return;
    const connected = await connectPuppeteer();
    if (!connected) return;
  }

  console.log('[SparkP2P] Waiting for Binance login...');

  let attempts = 0;
  const check = setInterval(async () => {
    attempts++;
    if (attempts > 150) { clearInterval(check); return; }

    if (await isLoggedIn()) {
      clearInterval(check);
      console.log('[SparkP2P] Binance login detected!');

      // Navigate to P2P page for order polling
      const page = await findBinancePage();
      if (page) {
        await page.goto('https://p2p.binance.com/en/trade/all-payments/USDT?fiat=KES', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 3000));
        binancePage = page;
        console.log('[SparkP2P] P2P page ready:', page.url());

        // Intercept Binance's own network responses to capture account data
        setupNetworkCapture(page);
      }

      // Test: can Puppeteer's page.evaluate make Binance API calls?
      await testBinanceFetch();

      // Sync cookies to VPS
      await syncCookies();

      // Start bot
      startPoller();

      if (mainWindow) {
        mainWindow.show();
        mainWindow.webContents.executeJavaScript(
          'alert("Binance connected! Bot started. Keep Chrome open (minimize it).")'
        );
      }
    }
  }, 2000);
}

async function testBinanceFetch() {
  if (!binancePage) return;
  try {
    const result = await binancePage.evaluate(async () => {
      const resp = await fetch('/bapi/c2c/v2/private/c2c/order-match/order-list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Clienttype': 'web', 'C2ctype': 'c2c_web' },
        body: JSON.stringify({ page: 1, rows: 1, tradeType: 'SELL', orderStatusList: [1] }),
        credentials: 'include',
      });
      return await resp.json();
    });
    console.log('[SparkP2P] TEST FETCH:', JSON.stringify(result).substring(0, 200));
  } catch (e) {
    console.error('[SparkP2P] TEST FETCH ERROR:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════
// AUTO-START — reconnect if Chrome already running
// ═══════════════════════════════════════════════════════════

async function tryAutoStart() {
  if (!token || browser) return;

  // Try connecting to existing Chrome first
  try {
    const connected = await connectPuppeteer();
    if (connected && await isLoggedIn()) {
      binancePage = await findBinancePage();
      if (binancePage) {
        console.log('[SparkP2P] Auto-connected to existing Chrome');
        startPoller();
        return;
      }
    }
  } catch (e) {}

  // No Chrome running — launch it automatically
  console.log('[SparkP2P] No active session — launching Chrome...');
  await connectBinance();
}

// ═══════════════════════════════════════════════════════════
// BINANCE API — page.evaluate() runs in REAL page context
// ═══════════════════════════════════════════════════════════

async function binanceFetch(endpoint, payload) {
  if (!binancePage || binancePage.isClosed()) {
    binancePage = await findBinancePage();
    if (!binancePage) return null;
  }
  try {
    return await binancePage.evaluate(async (ep, pl) => {
      // Use relative URL so it works on both c2c.binance.com and p2p.binance.com
      const resp = await fetch('/bapi/c2c/v2/private' + ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Clienttype': 'web', 'C2ctype': 'c2c_web' },
        body: JSON.stringify(pl),
        credentials: 'include',
      });
      return await resp.json();
    }, endpoint, payload);
  } catch (e) {
    // Context destroyed (page navigated) — refind page
    if (e.message.includes('context') || e.message.includes('destroyed') || e.message.includes('closed')) {
      binancePage = await findBinancePage();
    }
    console.error(`[SparkP2P] API error ${endpoint}: ${e.message.substring(0, 80)}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// COOKIE SYNC TO VPS
// ═══════════════════════════════════════════════════════════

async function syncCookies() {
  if (!token || !binancePage) return;
  try {
    const cookies = await binancePage.cookies('https://www.binance.com', 'https://c2c.binance.com', 'https://accounts.binance.com');
    const dict = {}, full = [];
    for (const c of cookies) {
      dict[c.name] = c.value;
      full.push({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite || 'None', expirationDate: c.expires > 0 ? c.expires : null });
    }
    await fetch(`${API_BASE}/traders/connect-binance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ cookies: dict, cookies_full: full, csrf_token: dict.csrftoken || '', bnc_uuid: dict['bnc-uuid'] || '' }),
    });
    console.log(`[SparkP2P] ${cookies.length} cookies synced to VPS`);
  } catch (e) { console.error('[SparkP2P] Sync error:', e.message); }
}

// ═══════════════════════════════════════════════════════════
// TRADING POLLER
// ═══════════════════════════════════════════════════════════

function startPoller() {
  if (pollerRunning) return;
  pollerRunning = true;
  console.log('[SparkP2P] Poller started');
  pollCycle();
  pollTimer = setInterval(pollCycle, POLL_INTERVAL);
}

function stopPoller() {
  pollerRunning = false;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function pollCycle() {
  if (!pollerRunning || !token) return;

  // Re-find binance page if context was destroyed
  if (!binancePage || binancePage.isClosed()) {
    binancePage = await findBinancePage();
    if (!binancePage) { console.log('[SparkP2P] No Binance page found'); return; }
    console.log('[SparkP2P] Reconnected to:', binancePage.url());
  }

  try {
    const sell = await binanceFetch('/c2c/order-match/order-list', { page: 1, rows: 20, tradeType: 'SELL', orderStatusList: [1, 2, 3] });
    const buy = await binanceFetch('/c2c/order-match/order-list', { page: 1, rows: 20, tradeType: 'BUY', orderStatusList: [1, 2, 3] });

    const sellData = sell?.code === '000000' ? (sell.data || []) : [];
    const buyData = buy?.code === '000000' ? (buy.data || []) : [];
    stats.orders = sellData.length + buyData.length;

    if (stats.polls < 3) console.log(`[SparkP2P] Orders: ${sellData.length} sell, ${buyData.length} buy`);

    const res = await fetch(`${API_BASE}/ext/report-orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ sell_orders: sellData.map(norm), buy_orders: buyData.map(norm) }),
    });
    if (res.ok) {
      const { actions } = await res.json();
      for (const a of (actions || [])) await execAction(a);
    }

    stats.polls++;
    if (stats.polls % 3 === 0) fetch(`${API_BASE}/ext/heartbeat`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } }).catch(() => {});
    if (stats.polls % 5 === 0) reportAccountData().catch(() => {});

  } catch (e) { stats.errors++; console.error('[SparkP2P] Poll error:', e.message); }
}

async function execAction(action) {
  const { action: type, order_number } = action;
  try {
    if (type === 'release') {
      const r = await binanceFetch('/c2c/order-match/confirm-order', { orderNumber: order_number });
      await fetch(`${API_BASE}/ext/report-release`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ order_number, success: r?.code === '000000', error: r?.error }) });
    } else if (type === 'pay' || type === 'mark_as_paid') {
      const r = await binanceFetch('/c2c/order-match/buyer-confirm-pay', { orderNumber: order_number });
      await fetch(`${API_BASE}/ext/report-payment-sent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ order_number, success: r?.code === '000000', error: r?.error }) });
    } else if (type === 'send_message') {
      await binanceFetch('/c2c/chat/send-message', { orderNumber: order_number, message: action.message || '', msgType: 1 });
    }
    stats.actions++;
  } catch (e) { stats.errors++; }
}

function setupNetworkCapture(page) {
  // Listen to ALL network responses from Binance pages
  // When Binance's own JS fetches data, we capture the responses
  page.on('response', async (response) => {
    const url = response.url();
    try {
      if (url.includes('/asset/query-user-asset') || url.includes('/asset-service/wallet/balance')) {
        const data = await response.json();
        if (data?.code === '000000' && data.data) {
          const arr = Array.isArray(data.data) ? data.data : [data.data];
          capturedData.balances = arr.filter(a => a.asset || a.coin).map(a => ({
            asset: a.asset || a.coin || 'USDT',
            free: parseFloat(a.available || a.free || a.balance || 0),
            locked: parseFloat(a.freeze || a.locked || 0),
            total: parseFloat(a.available || a.free || a.balance || 0) + parseFloat(a.freeze || a.locked || 0),
          }));
          console.log(`[SparkP2P] Captured ${capturedData.balances.length} balances from network`);
        }
      }
      if (url.includes('/adv/search') || url.includes('/adv/list')) {
        const data = await response.json();
        if (data?.code === '000000' && data.data) {
          capturedData.ads = (Array.isArray(data.data) ? data.data : []).map(a => ({
            advNo: a.advNo, tradeType: a.tradeType, asset: a.asset, fiat: a.fiatUnit,
            price: parseFloat(a.price || 0), amount: parseFloat(a.surplusAmount || a.tradableQuantity || 0),
            minLimit: parseFloat(a.minSingleTransAmount || 0), maxLimit: parseFloat(a.maxSingleTransAmount || 0),
          }));
          console.log(`[SparkP2P] Captured ${capturedData.ads.length} ads from network`);
        }
      }
      if (url.includes('/pay-method/user-paymethods')) {
        const data = await response.json();
        if (data?.code === '000000' && data.data) {
          capturedData.paymentMethods = data.data.map(p => ({
            id: p.id, type: p.identifier,
            name: (p.fields || []).find(f => (f.fieldName || '').toLowerCase().includes('name'))?.fieldValue || '',
          }));
          console.log(`[SparkP2P] Captured ${capturedData.paymentMethods.length} payment methods from network`);
        }
      }
      if (url.includes('/user/profile') || url.includes('/user-info')) {
        const data = await response.json();
        if (data?.data) {
          capturedData.nickname = data.data.nickName || data.data.nickname || '';
          capturedData.uid = data.data.userId || data.data.uid || '';
          if (capturedData.nickname) console.log(`[SparkP2P] Captured user: ${capturedData.nickname}`);
        }
      }
    } catch (e) {
      // Response not JSON or already consumed — ignore
    }
  });
  console.log('[SparkP2P] Network capture enabled — listening for Binance data');
}

async function triggerPageRefresh() {
  // Navigate to pages that trigger Binance to fetch account data
  if (!binancePage || binancePage.isClosed()) return;
  try {
    // Reload the P2P page — Binance's JS will fetch balance, ads, etc.
    await binancePage.reload({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));
  } catch (e) {}
}

async function reportAccountData() {
  if (!binancePage || binancePage.isClosed()) return;

  // Completed orders — these work via relative URL
  const cs = await binanceFetch('/c2c/order-match/order-list', { page: 1, rows: 20, tradeType: 'SELL', orderStatusList: [4] });
  const cb = await binanceFetch('/c2c/order-match/order-list', { page: 1, rows: 20, tradeType: 'BUY', orderStatusList: [4] });

  // Trigger page refresh every 10th poll to capture fresh data
  if (stats.polls % 10 === 0) {
    await triggerPageRefresh();
  }

  // Use captured data from network interception
  const balances = capturedData.balances;
  const completed = [...((cs?.code === '000000' ? cs.data : []) || []), ...((cb?.code === '000000' ? cb.data : []) || [])].sort((a, b) => (b.createTime || 0) - (a.createTime || 0)).slice(0, 20).map(o => ({ orderNumber: o.orderNumber, tradeType: o.tradeType, totalPrice: parseFloat(o.totalPrice || 0), amount: parseFloat(o.amount || 0), price: parseFloat(o.price || 0), asset: o.asset || 'USDT', fiat: o.fiat || 'KES', counterparty: o.buyerNickname || o.sellerNickname || '', status: o.orderStatus, createTime: o.createTime }));
  const activeAds = capturedData.ads;
  const pms = capturedData.paymentMethods;

  await fetch(`${API_BASE}/ext/report-account-data`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ balances, completed_orders: completed, active_ads: activeAds, payment_methods: pms }) });
  console.log(`[SparkP2P] Account: ${balances.length} bal, ${completed.length} orders, ${activeAds.length} ads, ${pms.length} PMs`);
}

function norm(o) {
  return { orderNumber: o.orderNumber || '', advNo: o.advNo || null, tradeType: o.tradeType || '', totalPrice: parseFloat(o.totalPrice || 0), amount: parseFloat(o.amount || 0), price: parseFloat(o.price || 0), asset: o.asset || 'USDT', buyerNickname: o.buyerNickname || null, sellerNickname: o.sellerNickname || null, orderStatus: o.orderStatus || null };
}

// IPC
ipcMain.handle('connect-binance', () => { connectBinance(); return { opened: true }; });
ipcMain.handle('set-token', (_, t) => { token = t; return { ok: true }; });
