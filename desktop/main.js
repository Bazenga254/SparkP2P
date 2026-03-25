const { app, BrowserWindow, BrowserView, Tray, Menu, ipcMain, session } = require('electron');
const path = require('path');

const API_BASE = 'https://sparkp2p.com/api';
const DASHBOARD_URL = 'https://sparkp2p.com/dashboard';
const BINANCE_URL = 'https://c2c.binance.com/en/trade/all-payments/USDT?fiat=KES';
const POLL_INTERVAL = 10000; // 10 seconds

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
  // Don't quit — stay in system tray
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

  // Minimize to tray instead of closing
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

  // Extract token when dashboard loads
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.executeJavaScript('localStorage.getItem("token")')
      .then((t) => {
        if (t && t !== token) {
          token = t;
          console.log('[SparkP2P] Token captured from dashboard');
        }
      })
      .catch(() => {});
  });
}

// ═══════════════════════════════════════════════════════════
// SYSTEM TRAY
// ═══════════════════════════════════════════════════════════

function createTray() {
  // Use a simple icon (create icon.png in same dir)
  const iconPath = path.join(__dirname, 'icon.png');
  try {
    tray = new Tray(iconPath);
  } catch (e) {
    // Fallback: create tray without icon
    return;
  }

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open SparkP2P', click: () => mainWindow.show() },
    { type: 'separator' },
    {
      label: 'Start Trading Bot',
      click: () => {
        if (!pollerRunning) startPoller();
      },
    },
    {
      label: 'Stop Trading Bot',
      click: () => stopPoller(),
    },
    { type: 'separator' },
    { label: 'Connect Binance', click: () => openBinanceLogin() },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('SparkP2P — Automated P2P Trading');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => mainWindow.show());
}

// ═══════════════════════════════════════════════════════════
// BINANCE BROWSER — Hidden view for automation
// ═══════════════════════════════════════════════════════════

function createBinanceView() {
  if (binanceView) return;

  binanceView = new BrowserView({
    webPreferences: {
      partition: 'persist:binance', // Separate session — keeps Binance cookies
      preload: path.join(__dirname, 'binance-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Load Binance P2P
  binanceView.webContents.loadURL(BINANCE_URL);

  // Don't attach to window — runs hidden in background
  console.log('[SparkP2P] Binance view created (hidden)');
}

function openBinanceLogin() {
  // Open Binance in a VISIBLE window so user can log in
  const loginWin = new BrowserWindow({
    width: 1280,
    height: 850,
    title: 'Log into Binance',
    webPreferences: {
      partition: 'persist:binance', // Same session as automation
      nodeIntegration: false,
      contextIsolation: true,
    },
    autoHideMenuBar: true,
  });

  loginWin.loadURL('https://accounts.binance.com/en/login');

  // Monitor for successful login
  const checkLogin = setInterval(async () => {
    try {
      const cookies = await session.fromPartition('persist:binance').cookies.get({
        domain: '.binance.com',
      });
      const cookieNames = cookies.map(c => c.name);

      if (cookieNames.includes('p20t') || cookieNames.includes('logined')) {
        clearInterval(checkLogin);
        console.log(`[SparkP2P] Binance login detected! ${cookies.length} cookies`);

        // Sync cookies to VPS
        await syncCookiesToVPS(cookies);

        // Close login window
        loginWin.close();

        // Start hidden Binance view for automation
        createBinanceView();

        // Notify user
        if (mainWindow) {
          mainWindow.show();
          mainWindow.webContents.executeJavaScript(
            `alert("Binance connected! ${cookies.length} cookies saved. Bot ready.")`
          );
        }
      }
    } catch (e) {
      // Not logged in yet
    }
  }, 2000);

  loginWin.on('closed', () => clearInterval(checkLogin));
}

// ═══════════════════════════════════════════════════════════
// COOKIE SYNC — Send Binance cookies to VPS
// ═══════════════════════════════════════════════════════════

async function syncCookiesToVPS(cookies) {
  if (!token) {
    console.log('[SparkP2P] No token — cannot sync cookies');
    return;
  }

  const cookieDict = {};
  const cookiesFull = [];

  for (const c of cookies) {
    cookieDict[c.name] = c.value;
    cookiesFull.push({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite || 'no_restriction',
      expirationDate: c.expirationDate || null,
    });
  }

  try {
    const res = await fetch(`${API_BASE}/traders/connect-binance`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        cookies: cookieDict,
        cookies_full: cookiesFull,
        csrf_token: cookieDict['csrftoken'] || '',
        bnc_uuid: cookieDict['bnc-uuid'] || '',
      }),
    });

    if (res.ok) {
      console.log(`[SparkP2P] Cookies synced to VPS: ${cookies.length} cookies`);
    }
  } catch (err) {
    console.error('[SparkP2P] Cookie sync failed:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// TRADING POLLER — Poll Binance, report to VPS, execute actions
// ═══════════════════════════════════════════════════════════

async function startPoller() {
  if (pollerRunning) return;
  if (!token) {
    console.log('[SparkP2P] Cannot start poller — no token');
    return;
  }

  // Ensure Binance view exists
  createBinanceView();

  pollerRunning = true;
  console.log('[SparkP2P] Poller started');

  pollCycle(); // First cycle immediately
  pollTimer = setInterval(pollCycle, POLL_INTERVAL);
}

function stopPoller() {
  pollerRunning = false;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  console.log('[SparkP2P] Poller stopped');
}

async function pollCycle() {
  if (!pollerRunning || !binanceView || !token) return;

  try {
    // Fetch orders from Binance via the hidden browser view
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

    // Report to VPS
    const reportRes = await fetch(`${API_BASE}/ext/report-orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        sell_orders: sellData.map(normalizeOrder),
        buy_orders: buyData.map(normalizeOrder),
      }),
    });

    if (!reportRes.ok) throw new Error(`VPS report failed: ${reportRes.status}`);

    const { actions } = await reportRes.json();

    // Execute actions
    for (const action of (actions || [])) {
      await executeAction(action);
    }

    stats.polls++;

    // Send heartbeat every 3rd poll
    if (stats.polls % 3 === 0) {
      fetch(`${API_BASE}/ext/heartbeat`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
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
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
    orderNumber: o.orderNumber || '',
    advNo: o.advNo || null,
    tradeType: o.tradeType || '',
    totalPrice: parseFloat(o.totalPrice || 0),
    amount: parseFloat(o.amount || 0),
    price: parseFloat(o.price || 0),
    asset: o.asset || 'USDT',
    buyerNickname: o.buyerNickname || null,
    sellerNickname: o.sellerNickname || null,
    orderStatus: o.orderStatus || null,
  };
}

// ═══════════════════════════════════════════════════════════
// IPC — Communication with renderer (dashboard)
// ═══════════════════════════════════════════════════════════

ipcMain.handle('get-bot-status', () => ({
  running: pollerRunning,
  stats,
  binanceReady: !!binanceView,
}));

ipcMain.handle('start-bot', async () => {
  await startPoller();
  return { started: pollerRunning };
});

ipcMain.handle('stop-bot', () => {
  stopPoller();
  return { stopped: true };
});

ipcMain.handle('connect-binance', () => {
  openBinanceLogin();
  return { opened: true };
});

ipcMain.handle('set-token', (_, t) => {
  token = t;
  return { ok: true };
});
