const { app, BrowserWindow, BrowserView, Tray, Menu, ipcMain, session, shell, dialog } = require('electron');
const path = require('path');
const { execFile } = require('child_process');
const CDP = require('chrome-remote-interface');

const API_BASE = 'https://sparkp2p.com/api';
const DASHBOARD_URL = 'https://sparkp2p.com/dashboard';
const BINANCE_URL = 'https://c2c.binance.com/en/trade/all-payments/USDT?fiat=KES';
const POLL_INTERVAL = 10000;

let mainWindow = null;
let binanceView = null;
let tray = null;
let token = null;
let pollerRunning = false;
let pollTimer = null;
let stats = { polls: 0, actions: 0, errors: 0, orders: 0 };

// ═══════════════════════════════════════════════════════════
// APP LIFECYCLE
// ═══════════════════════════════════════════════════════════

app.whenReady().then(() => {
  createMainWindow();
  createTray();
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});

app.on('before-quit', () => {
  stopPoller();
  if (tray) tray.destroy();
});

// ═══════════════════════════════════════════════════════════
// MAIN WINDOW — SparkP2P Dashboard
// ═══════════════════════════════════════════════════════════

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    title: 'SparkP2P',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    autoHideMenuBar: true,
  });

  mainWindow.loadURL(DASHBOARD_URL);

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      if (tray) {
        tray.displayBalloon({
          title: 'SparkP2P',
          content: 'Running in background. Trading bot is active.',
        });
      }
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    // Grab token
    mainWindow.webContents.executeJavaScript('localStorage.getItem("token")')
      .then((t) => {
        if (t && t !== token) {
          token = t;
          console.log('[SparkP2P] Token captured');
        }
      })
      .catch(() => {});

    // Inject desktop flag so dashboard uses native Binance login
    mainWindow.webContents.executeJavaScript(`
      window.sparkp2p = {
        isDesktop: true,
        connectBinance: () => {
          const { ipcRenderer } = require('electron');
          ipcRenderer.invoke('connect-binance');
        },
      };
      console.log('[SparkP2P Desktop] Bridge injected');
    `).catch(() => {
      // If require fails due to context isolation, use postMessage instead
      mainWindow.webContents.executeJavaScript(`
        window.sparkp2p = { isDesktop: true };
        console.log('[SparkP2P Desktop] Flag injected');
      `).catch(() => {});
    });
  });

  // Intercept WebSocket connections to login-stream — block them and open Chrome instead
  mainWindow.webContents.session.webRequest.onBeforeRequest(
    { urls: ['wss://sparkp2p.com/api/browser/login-stream*', 'ws://*/api/browser/login-stream*'] },
    (details, callback) => {
      console.log('[SparkP2P] Intercepted remote browser — opening Chrome instead');
      callback({ cancel: true });
      openBinanceLogin();
    }
  );
}

// ═══════════════════════════════════════════════════════════
// SYSTEM TRAY
// ═══════════════════════════════════════════════════════════

function createTray() {
  const iconPath = path.join(__dirname, 'icon.png');
  try {
    tray = new Tray(iconPath);
  } catch (e) {
    console.log('[SparkP2P] Tray icon not found, skipping tray');
    return;
  }

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open SparkP2P', click: () => mainWindow.show() },
    { type: 'separator' },
    { label: 'Start Trading Bot', click: () => { if (!pollerRunning) startPoller(); } },
    { label: 'Stop Trading Bot', click: () => stopPoller() },
    { type: 'separator' },
    { label: 'Connect Binance', click: () => openBinanceLogin() },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);

  tray.setToolTip('SparkP2P — Automated P2P Trading');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => mainWindow.show());
}

// ═══════════════════════════════════════════════════════════
// BINANCE LOGIN — Opens user's REAL Chrome browser
// ═══════════════════════════════════════════════════════════

const CDP_PORT = 9222;
let chromeProcess = null;

function findChromePath() {
  const fs = require('fs');
  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function openBinanceLogin() {
  const chromePath = findChromePath();
  if (!chromePath) {
    dialog.showErrorBox('Chrome Not Found', 'Google Chrome is required. Please install Chrome and try again.');
    return;
  }

  console.log('[SparkP2P] Opening Binance login in your Chrome browser...');

  // Launch Chrome with remote debugging so we can extract cookies after login
  chromeProcess = execFile(chromePath, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + path.join(app.getPath('userData'), 'chrome-binance'),
    'https://accounts.binance.com/en/login',
  ]);

  chromeProcess.on('error', (err) => {
    console.error('[SparkP2P] Chrome launch failed:', err.message);
  });

  // Poll for login via CDP
  let checkCount = 0;
  const checkLogin = setInterval(async () => {
    checkCount++;
    if (checkCount > 300) { // 10 min timeout
      clearInterval(checkLogin);
      return;
    }

    try {
      const client = await CDP({ port: CDP_PORT });
      const { Network } = client;

      // Get all cookies for binance.com
      const { cookies } = await Network.getCookies({ urls: [
        'https://www.binance.com',
        'https://accounts.binance.com',
        'https://c2c.binance.com',
      ]});

      const cookieNames = cookies.map(c => c.name);

      if (cookieNames.includes('p20t') || cookieNames.includes('logined')) {
        clearInterval(checkLogin);
        console.log(`[SparkP2P] Binance login detected! ${cookies.length} cookies from Chrome`);

        // Sync to VPS
        await syncCookiesToVPS(cookies);

        // Close the Chrome debugging tab (not the whole browser)
        try { await client.close(); } catch (_) {}

        // Set up hidden Binance view with the cookies
        await loadCookiesIntoElectron(cookies);
        createBinanceView();

        if (mainWindow) {
          mainWindow.show();
          mainWindow.webContents.executeJavaScript(
            `alert("Binance connected! ${cookies.length} cookies saved. You can close the Chrome window.")`
          );
        }
      } else {
        await client.close();
      }
    } catch (e) {
      // CDP not ready yet or Chrome not launched — keep trying
    }
  }, 2000);
}

async function loadCookiesIntoElectron(cdpCookies) {
  // Load cookies from Chrome into Electron's Binance session
  const ses = session.fromPartition('persist:binance');
  for (const c of cdpCookies) {
    try {
      await ses.cookies.set({
        url: `https://${c.domain.replace(/^\./, '')}${c.path}`,
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite === 'None' ? 'no_restriction' : (c.sameSite || 'no_restriction').toLowerCase(),
        expirationDate: c.expires > 0 ? c.expires : undefined,
      });
    } catch (_) {}
  }
  console.log(`[SparkP2P] Loaded ${cdpCookies.length} cookies into Electron session`);
}

// ═══════════════════════════════════════════════════════════
// BINANCE VIEW — Hidden browser for automation
// ═══════════════════════════════════════════════════════════

function createBinanceView() {
  if (binanceView) return;
  binanceView = new BrowserView({
    webPreferences: {
      partition: 'persist:binance',
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  binanceView.webContents.loadURL(BINANCE_URL);
  console.log('[SparkP2P] Binance view created (hidden)');
}

// ═══════════════════════════════════════════════════════════
// COOKIE SYNC
// ═══════════════════════════════════════════════════════════

async function syncCookiesToVPS(cookies) {
  if (!token) return;
  const cookieDict = {};
  const cookiesFull = [];
  for (const c of cookies) {
    cookieDict[c.name] = c.value;
    cookiesFull.push({
      name: c.name, value: c.value, domain: c.domain,
      path: c.path, secure: c.secure, httpOnly: c.httpOnly,
      sameSite: c.sameSite || 'no_restriction',
      expirationDate: c.expirationDate || null,
    });
  }
  try {
    const res = await fetch(`${API_BASE}/traders/connect-binance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        cookies: cookieDict, cookies_full: cookiesFull,
        csrf_token: cookieDict['csrftoken'] || '',
        bnc_uuid: cookieDict['bnc-uuid'] || '',
      }),
    });
    if (res.ok) console.log(`[SparkP2P] Cookies synced: ${cookies.length}`);
  } catch (err) {
    console.error('[SparkP2P] Cookie sync failed:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// TRADING POLLER
// ═══════════════════════════════════════════════════════════

async function startPoller() {
  if (pollerRunning || !token) return;
  createBinanceView();
  pollerRunning = true;
  console.log('[SparkP2P] Poller started');
  pollCycle();
  pollTimer = setInterval(pollCycle, POLL_INTERVAL);
}

function stopPoller() {
  pollerRunning = false;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  console.log('[SparkP2P] Poller stopped');
}

async function pollCycle() {
  if (!pollerRunning || !binanceView || !token) return;
  try {
    const sellOrders = await binanceView.webContents.executeJavaScript(`
      fetch('https://c2c.binance.com/bapi/c2c/v2/private/c2c/order-match/order-list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Clienttype': 'web' },
        body: JSON.stringify({ page: 1, rows: 20, tradeType: 'SELL', orderStatusList: [1, 2, 3] }),
        credentials: 'include',
      }).then(r => r.json()).catch(e => ({ error: e.message }))
    `);
    const buyOrders = await binanceView.webContents.executeJavaScript(`
      fetch('https://c2c.binance.com/bapi/c2c/v2/private/c2c/order-match/order-list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Clienttype': 'web' },
        body: JSON.stringify({ page: 1, rows: 20, tradeType: 'BUY', orderStatusList: [1, 2, 3] }),
        credentials: 'include',
      }).then(r => r.json()).catch(e => ({ error: e.message }))
    `);

    const sellData = sellOrders?.code === '000000' ? (sellOrders.data || []) : [];
    const buyData = buyOrders?.code === '000000' ? (buyOrders.data || []) : [];
    stats.orders = sellData.length + buyData.length;

    const reportRes = await fetch(`${API_BASE}/ext/report-orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        sell_orders: sellData.map(normalizeOrder),
        buy_orders: buyData.map(normalizeOrder),
      }),
    });
    if (!reportRes.ok) throw new Error(`VPS report failed: ${reportRes.status}`);
    const { actions } = await reportRes.json();

    for (const action of (actions || [])) {
      await executeAction(action);
    }
    stats.polls++;

    if (stats.polls % 3 === 0) {
      fetch(`${API_BASE}/ext/heartbeat`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}` },
      }).catch(() => {});
    }
  } catch (err) {
    stats.errors++;
    console.error('[SparkP2P] Poll error:', err.message);
  }
}

async function executeAction(action) {
  if (!binanceView) return;
  const { action: type, order_number } = action;
  try {
    if (type === 'release') {
      const result = await binanceView.webContents.executeJavaScript(`
        fetch('https://c2c.binance.com/bapi/c2c/v2/private/c2c/order-match/confirm-order', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderNumber: '${order_number}' }),
          credentials: 'include',
        }).then(r => r.json()).catch(e => ({ error: e.message }))
      `);
      const success = result?.code === '000000';
      await fetch(`${API_BASE}/ext/report-release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ order_number, success, error: result?.error }),
      });
      if (success) stats.actions++;
    } else if (type === 'pay' || type === 'mark_as_paid') {
      const result = await binanceView.webContents.executeJavaScript(`
        fetch('https://c2c.binance.com/bapi/c2c/v2/private/c2c/order-match/buyer-confirm-pay', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderNumber: '${order_number}' }),
          credentials: 'include',
        }).then(r => r.json()).catch(e => ({ error: e.message }))
      `);
      const success = result?.code === '000000';
      await fetch(`${API_BASE}/ext/report-payment-sent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ order_number, success, error: result?.error }),
      });
      if (success) stats.actions++;
    } else if (type === 'send_message') {
      await binanceView.webContents.executeJavaScript(`
        fetch('https://c2c.binance.com/bapi/c2c/v2/private/c2c/chat/send-message', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderNumber: '${order_number}', message: \`${action.message || ''}\`, msgType: 1 }),
          credentials: 'include',
        }).then(r => r.json()).catch(e => ({ error: e.message }))
      `);
    }
  } catch (err) {
    console.error(`[SparkP2P] Action ${type} failed:`, err.message);
    stats.errors++;
  }
}

function normalizeOrder(o) {
  return {
    orderNumber: o.orderNumber || '', advNo: o.advNo || null,
    tradeType: o.tradeType || '', totalPrice: parseFloat(o.totalPrice || 0),
    amount: parseFloat(o.amount || 0), price: parseFloat(o.price || 0),
    asset: o.asset || 'USDT', buyerNickname: o.buyerNickname || null,
    sellerNickname: o.sellerNickname || null, orderStatus: o.orderStatus || null,
  };
}

// ═══════════════════════════════════════════════════════════
// IPC
// ═══════════════════════════════════════════════════════════

ipcMain.handle('get-bot-status', () => ({ running: pollerRunning, stats, binanceReady: !!binanceView }));
ipcMain.handle('start-bot', async () => { await startPoller(); return { started: pollerRunning }; });
ipcMain.handle('stop-bot', () => { stopPoller(); return { stopped: true }; });
ipcMain.handle('connect-binance', () => { openBinanceLogin(); return { opened: true }; });
ipcMain.handle('set-token', (_, t) => { token = t; return { ok: true }; });
