const { app, BrowserWindow, Tray, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const puppeteer = require('puppeteer-core');
const aiScanner = require('./ai-scanner');
const { autoUpdater } = require('electron-updater');

// Logging — use app data folder when packaged, __dirname when dev
const logDir = app.isPackaged ? path.join(process.env.APPDATA || process.env.HOME, 'sparkp2p') : __dirname;
try { fs.mkdirSync(logDir, { recursive: true }); } catch (e) {}
const logFile = path.join(logDir, 'sparkp2p.log');
try { fs.writeFileSync(logFile, ''); } catch (e) {}
const _log = console.log, _err = console.error;
console.log = (...a) => { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${a.join(' ')}\n`); _log(...a); };
console.error = (...a) => { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ERR: ${a.join(' ')}\n`); _err(...a); };

const API_BASE = 'https://sparkp2p.com/api';
const DASHBOARD_URL = 'https://sparkp2p.com/dashboard';
const CDP_PORT = 9222;
const POLL_INTERVAL = 120000; // 2 minutes

let mainWindow = null;
let tray = null;
let token = null;
let browser = null;
let pollerRunning = false;
let pollTimer = null;
let stats = { polls: 0, actions: 0, errors: 0, orders: 0 };
let traderPin = null; // Binance security PIN — stored in memory only
// Load .env file for API keys — check app data folder and app directory
try {
  const envPath = app.isPackaged
    ? path.join(process.env.APPDATA || process.env.HOME, 'sparkp2p', '.env')
    : path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const [key, ...val] = line.split('=');
      if (key && val.length) process.env[key.trim()] = val.join('=').trim();
    });
  }
} catch (e) {}
let aiApiKey = process.env.OPENAI_API_KEY || null;

// ═══════════════════════════════════════════════════════════
// ELECTRON
// ═══════════════════════════════════════════════════════════

app.whenReady().then(() => {
  createMainWindow();
  createTray();
  aiScanner.initAI(aiApiKey);
  checkForUpdates();
});

// ═══════════════════════════════════════════════════════════
// AUTO-UPDATE — checks GitHub Releases for new versions
// ═══════════════════════════════════════════════════════════

function checkForUpdates() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    console.log(`[SparkP2P] Update available: v${info.version}`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[SparkP2P] Update downloaded: v${info.version}`);
    if (mainWindow) {
      mainWindow.webContents.executeJavaScript(
        `if(confirm("SparkP2P v${info.version} is ready. Restart now to update?")) { window.sparkp2p?.restartApp?.() }`
      );
    }
  });

  autoUpdater.on('error', (err) => {
    console.log('[SparkP2P] Update check:', err.message?.substring(0, 60));
  });

  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
}
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

  // Capture token on every page load and navigation
  const captureToken = () => {
    mainWindow.webContents.executeJavaScript('localStorage.getItem("token")')
      .then((t) => {
        if (t && t !== token) {
          token = t;
          console.log('[SparkP2P] Token captured');
          tryAutoStart();
        }
      }).catch(() => {});
  };
  mainWindow.webContents.on('did-finish-load', captureToken);
  mainWindow.webContents.on('did-navigate-in-page', captureToken);
  // Also poll for token every 5 seconds (catches SPA login)
  setInterval(captureToken, 5000);

  // Intercept WebSocket remote browser — open Chrome instead
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
// CHROME — Launch once, keep open forever.
// User logs in once. Session stays alive.
// Bot reads the page like a human — no API hacking.
// ═══════════════════════════════════════════════════════════

function findChrome() {
  for (const p of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ]) { if (fs.existsSync(p)) return p; }
  return null;
}

async function launchChrome(url) {
  const chrome = findChrome();
  if (!chrome) { console.error('Chrome not found'); return false; }
  execFile(chrome, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + path.join(app.getPath('userData'), 'chrome-binance'),
    url || 'https://accounts.binance.com/en/login',
  ]);
  console.log('[SparkP2P] Chrome launched');
  await new Promise(r => setTimeout(r, 4000));
  return true;
}

async function connectPuppeteer() {
  try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP_PORT}`, defaultViewport: null });
    console.log('[SparkP2P] Puppeteer connected');
    return true;
  } catch (e) { return false; }
}

async function getPage(urlMatch) {
  if (!browser) return null;
  const pages = await browser.pages();
  if (urlMatch) return pages.find(p => p.url().includes(urlMatch));
  return pages.find(p => p.url().includes('binance.com') && !p.url().includes('accounts.google')) || pages[0];
}

async function isLoggedIn() {
  const page = await getPage('binance.com');
  if (!page) return false;
  try {
    // Check if we see a logged-in indicator (user avatar, menu, etc.)
    const url = page.url();
    if (url.includes('login') || url.includes('accounts.binance.com')) return false;
    // Check for user menu (logged in users see their profile icon)
    const loggedIn = await page.evaluate(() => {
      return !!(document.querySelector('[data-testid="user-avatar"]') ||
               document.querySelector('.user-avatar') ||
               document.querySelector('[class*="AccountButton"]') ||
               document.querySelector('[aria-label="User Center"]') ||
               document.querySelector('#header_user_avatar') ||
               document.cookie.includes('logined'));
    }).catch(() => false);
    return loggedIn;
  } catch (e) { return false; }
}

// ═══════════════════════════════════════════════════════════
// CONNECT BINANCE — Open Chrome, wait for login, start bot
// ═══════════════════════════════════════════════════════════

async function connectBinance() {
  // Check if we already have a Binance page open
  let existingPage = browser ? await getPage('binance.com') : null;

  if (!existingPage) {
    // No Binance page — launch Chrome fresh
    if (browser) { try { await browser.disconnect(); } catch(e) {} browser = null; }
    await launchChrome('https://accounts.binance.com/en/login');
    await connectPuppeteer();
    if (!browser) return;
  }

  console.log('[SparkP2P] Waiting for login...');

  let attempts = 0;
  const check = setInterval(async () => {
    attempts++;
    if (attempts > 300) { clearInterval(check); return; } // 10 min timeout

    if (await isLoggedIn()) {
      clearInterval(check);
      console.log('[SparkP2P] Login detected!');

      // Show alert IMMEDIATELY
      if (mainWindow) {
        mainWindow.show();
        mainWindow.webContents.executeJavaScript(
          'alert("Binance connected! Bot is running. Keep Chrome open (you can minimize it).")'
        );
      }

      // Send heartbeat immediately so dashboard shows "Connected"
      if (token) {
        fetch(`${API_BASE}/ext/heartbeat`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } }).catch(() => {});
      }

      // Sync cookies to mark as connected on VPS
      await syncCookies();

      // Start poller FIRST (so heartbeats keep going)
      startPoller();

      // Then do the initial scan in background (takes time, won't block heartbeats)
      initialScan().catch(e => console.error('[SparkP2P] Initial scan error:', e.message?.substring(0, 60)));
    }
  }, 2000);
}

let lastActiveTime = Date.now();
const INACTIVITY_TIMEOUT = 6 * 60 * 60 * 1000; // 6 hours

async function tryAutoStart() {
  if (!token) return; // Don't do anything until user logs into SparkP2P
  if (browser) return; // Already connected

  // Only try to reconnect to existing Chrome — don't launch new one
  try {
    if (await connectPuppeteer()) {
      if (await isLoggedIn()) {
        console.log('[SparkP2P] Auto-connected to existing Chrome session');
        lastActiveTime = Date.now();
        startPoller();
        return;
      }
    }
  } catch (e) {}
  // Don't auto-launch Chrome — wait for user to click "Connect Binance"
  console.log('[SparkP2P] No active Binance session. Click Connect Binance to start.');
}

function checkInactivityTimeout() {
  if (!pollerRunning) return;
  const elapsed = Date.now() - lastActiveTime;
  if (elapsed > INACTIVITY_TIMEOUT) {
    console.log('[SparkP2P] 6 hours inactive — logging out for security');
    stopPoller();
    if (browser) {
      browser.close().catch(() => {});
      browser = null;
    }
    if (mainWindow) {
      mainWindow.webContents.executeJavaScript(
        'alert("Binance session expired after 6 hours of inactivity. Please reconnect.")'
      );
    }
  }
}

// Check inactivity every 5 minutes
setInterval(checkInactivityTimeout, 5 * 60 * 1000);

// ═══════════════════════════════════════════════════════════
// INITIAL SCAN — First thing after login:
// 1. Profile page → get username
// 2. Funding wallet → get funding USDT balance
// 3. Spot wallet → get spot USDT balance
// 4. Upload everything to VPS
// 5. Navigate to P2P ads page and keep browser there
// ═══════════════════════════════════════════════════════════

async function initialScan() {
  const page = await getPage();
  if (!page) return;

  console.log('[SparkP2P] === INITIAL SCAN START ===');

  // Step 1: Profile — get username
  console.log('[SparkP2P] Step 1: Reading profile...');
  let profileData = null;
  if (aiApiKey) {
    profileData = await aiScanner.scanProfile(page);
  }
  const nickname = profileData?.nickname || '';
  console.log(`[SparkP2P] Username: ${nickname || 'unknown'}`);

  // Step 2: Funding wallet — get USDT balance
  console.log('[SparkP2P] Step 2: Reading funding wallet...');
  let fundingData = null;
  if (aiApiKey) {
    await page.goto('https://www.binance.com/en/my/wallet/funding', { waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 5000));
    const ss1 = await page.screenshot({ type: 'jpeg', quality: 80 });
    fundingData = await aiScanner.analyzeScreenshot(ss1, `
      Look at this Binance Funding wallet page. Extract:
      {
        "funding_balances": [{ "asset": "string", "total": number, "available": number }],
        "estimated_total_usd": number or null
      }
      List ALL visible crypto balances. If USDT shows 3.39, return {"asset":"USDT","total":3.39,"available":3.39}.
    `);
  }
  console.log('[SparkP2P] Funding:', JSON.stringify(fundingData)?.substring(0, 200));

  // Step 3: Spot wallet — get USDT balance
  console.log('[SparkP2P] Step 3: Reading spot wallet...');
  let spotData = null;
  if (aiApiKey) {
    await page.goto('https://www.binance.com/en/my/wallet/account/overview', { waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 5000));
    const ss2 = await page.screenshot({ type: 'jpeg', quality: 80 });
    spotData = await aiScanner.analyzeScreenshot(ss2, `
      Look at this Binance Spot/Overview wallet page. Extract:
      {
        "spot_balances": [{ "asset": "string", "total": number, "available": number }],
        "estimated_total_usd": number or null
      }
      List ALL visible crypto balances with their amounts.
    `);
  }
  console.log('[SparkP2P] Spot:', JSON.stringify(spotData)?.substring(0, 200));

  // Combine balances
  const allBalances = [];
  const seen = new Set();
  for (const b of (fundingData?.funding_balances || [])) {
    if (b.asset && !seen.has(b.asset + '_funding')) {
      seen.add(b.asset + '_funding');
      allBalances.push({ asset: b.asset, free: b.available || b.total || 0, locked: (b.total || 0) - (b.available || 0), total: b.total || 0, wallet: 'Funding' });
    }
  }
  for (const b of (spotData?.spot_balances || [])) {
    if (b.asset && !seen.has(b.asset + '_spot')) {
      seen.add(b.asset + '_spot');
      allBalances.push({ asset: b.asset, free: b.available || b.total || 0, locked: (b.total || 0) - (b.available || 0), total: b.total || 0, wallet: 'Spot' });
    }
  }

  console.log(`[SparkP2P] Total balances found: ${allBalances.length}`);

  // Step 4: Upload to VPS
  if (token) {
    await fetch(`${API_BASE}/ext/report-account-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        balances: allBalances,
        active_ads: [],
        completed_orders: [],
        payment_methods: [],
        nickname: nickname,
      }),
    }).catch(() => {});
    console.log('[SparkP2P] Data uploaded to VPS');
  }

  // Step 5: Navigate to P2P ads/trade page — browser stays here
  console.log('[SparkP2P] Step 5: Going to P2P page...');
  await page.goto('https://p2p.binance.com/en/trade/all-payments/USDT?fiat=KES', { waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

  console.log('[SparkP2P] === INITIAL SCAN COMPLETE ===');
}

// ═══════════════════════════════════════════════════════════
// COOKIE SYNC (just for VPS to mark as connected)
// ═══════════════════════════════════════════════════════════

async function syncCookies() {
  if (!token || !browser) return;
  try {
    const page = await getPage();
    if (!page) return;
    const cookies = await page.cookies('https://www.binance.com', 'https://p2p.binance.com', 'https://c2c.binance.com');
    const dict = {}, full = [];
    for (const c of cookies) {
      dict[c.name] = c.value;
      full.push({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly });
    }
    await fetch(`${API_BASE}/traders/connect-binance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ cookies: dict, cookies_full: full, csrf_token: dict.csrftoken || '', bnc_uuid: dict['bnc-uuid'] || '' }),
    });
    console.log(`[SparkP2P] ${cookies.length} cookies synced`);
  } catch (e) {}
}

// ═══════════════════════════════════════════════════════════
// PAGE READER — Read data from Binance pages like a human
// Navigate → Wait → Read DOM → Report to VPS
// ═══════════════════════════════════════════════════════════

async function navigateTo(url) {
  const page = await getPage();
  if (!page) return null;
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    await new Promise(r => setTimeout(r, 2000));
    return page;
  } catch (e) {
    console.error('[SparkP2P] Navigate error:', e.message?.substring(0, 60));
    return page; // Return page anyway, it may have partially loaded
  }
}

let _ordersTabOpen = false;

async function readOrders() {
  // Open a SECOND TAB to check orders — don't touch the main tab
  if (!browser || _ordersTabOpen) return { sell: [], buy: [] };

  _ordersTabOpen = true;
  let ordersTab = null;
  try {
    ordersTab = await browser.newPage();
    await ordersTab.goto('https://p2p.binance.com/en/fiatOrder?tab=0&page=1', { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));
    const page = ordersTab;

    // Use GPT-4o to read the orders page if AI is available
    if (aiApiKey) {
      const screenshot = await page.screenshot({ type: 'jpeg', quality: 80 });
      const aiResult = await aiScanner.analyzeScreenshot(screenshot, `
        Look at this Binance P2P orders page. Extract ALL pending/active orders:
        {
          "orders": [{
            "order_number": "string (long number like 12871954638757629952)",
            "type": "SELL" or "BUY",
            "amount_fiat": number (KES amount),
            "amount_crypto": number (USDT amount),
            "status": "Pending Payment" or "Paid" or "Appeal" or "Completed",
            "counterparty": "string (username)"
          }],
          "has_orders": true/false
        }
        If the page shows "No records" or is empty, return {"orders":[],"has_orders":false}.
      `);

      if (aiResult?.orders?.length > 0) {
        const sell = [], buy = [];
        for (const o of aiResult.orders) {
          const order = {
            orderNumber: o.order_number || '',
            tradeType: (o.type || '').toUpperCase() === 'BUY' ? 'BUY' : 'SELL',
            totalPrice: o.amount_fiat || 0,
            amount: o.amount_crypto || 0,
            asset: 'USDT',
            status: o.status || 'PENDING',
            counterparty: o.counterparty || '',
          };
          if (order.orderNumber) {
            if (order.tradeType === 'SELL') sell.push(order);
            else buy.push(order);
          }
        }

        // Close orders tab
        if (ordersTab) await ordersTab.close().catch(() => {});

        return { sell, buy };
      }
    }

    // Fallback: DOM reading
    const orders = await page.evaluate(() => {
      const results = { sell: [], buy: [] };
      const text = document.body.innerText;

      // Check for "No records"
      if (text.includes('No records') || text.includes('No data')) return results;

      // Try to find order numbers and details
      const orderNumbers = text.match(/\d{18,}/g) || [];
      const kesAmounts = text.match(/[\d,]+\.?\d*\s*KES/gi) || [];
      const usdtAmounts = text.match(/[\d.]+\s*USDT/gi) || [];

      for (let i = 0; i < orderNumbers.length; i++) {
        const order = {
          orderNumber: orderNumbers[i],
          tradeType: text.toLowerCase().includes('sell') ? 'SELL' : 'BUY',
          totalPrice: kesAmounts[i] ? parseFloat(kesAmounts[i].replace(/[,KES\s]/gi, '')) : 0,
          amount: usdtAmounts[i] ? parseFloat(usdtAmounts[i].replace(/[USDT\s]/gi, '')) : 0,
          asset: 'USDT',
          status: 'PENDING',
        };
        if (order.tradeType === 'SELL') results.sell.push(order);
        else results.buy.push(order);
      }

      return results;
    });

    // Navigate back to P2P trade page
    await page.goto('https://p2p.binance.com/en/trade/all-payments/USDT?fiat=KES', { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});

    return orders;
  } catch (e) {
    console.error('[SparkP2P] Read orders error:', e.message?.substring(0, 60));
    if (ordersTab) await ordersTab.close().catch(() => {});
    _ordersTabOpen = false;
    return { sell: [], buy: [] };
  } finally {
    _ordersTabOpen = false;
  }
}

async function readBalance() {
  // Navigate to wallet overview and read balance from page
  const page = await navigateTo('https://www.binance.com/en/my/wallet/account/overview');
  if (!page) return [];

  try {
    await new Promise(r => setTimeout(r, 3000)); // Wait for balances to load

    const balances = await page.evaluate(() => {
      const results = [];
      // Read balance amounts from the wallet page
      const text = document.body.innerText;

      // Look for USDT balance specifically
      const usdtMatch = text.match(/USDT[^]*?([\d.]+)/);
      if (usdtMatch) {
        results.push({ asset: 'USDT', free: parseFloat(usdtMatch[1]), locked: 0, total: parseFloat(usdtMatch[1]) });
      }

      // Also try to read "Estimated Balance"
      const estMatch = text.match(/Estimated Balance[^]*?([\d.]+)\s*USDT/);
      if (estMatch && results.length === 0) {
        results.push({ asset: 'USDT', free: parseFloat(estMatch[1]), locked: 0, total: parseFloat(estMatch[1]) });
      }

      return results;
    });

    return balances;
  } catch (e) {
    console.error('[SparkP2P] Read balance error:', e.message?.substring(0, 60));
    return [];
  }
}

async function readAccountData() {
  // Read username, ads, payment methods from the P2P page
  const page = await navigateTo('https://p2p.binance.com/en/trade/all-payments/USDT?fiat=KES');
  if (!page) return { nickname: '', ads: [], pms: [] };

  try {
    await new Promise(r => setTimeout(r, 2000));

    const data = await page.evaluate(() => {
      const text = document.body.innerText;
      const result = { nickname: '', ads: [], pms: [] };

      // Try to find user nickname from header/menu
      const avatarEl = document.querySelector('[data-testid="user-avatar"], .user-avatar, [class*="AccountButton"]');
      if (avatarEl) result.nickname = avatarEl.textContent?.trim() || '';

      return result;
    });

    return data;
  } catch (e) {
    return { nickname: '', ads: [], pms: [] };
  }
}

// ═══════════════════════════════════════════════════════════
// TRADING POLLER — Reads pages, reports to VPS, takes actions
// ═══════════════════════════════════════════════════════════

function startPoller() {
  if (pollerRunning) return;
  pollerRunning = true;
  console.log('[SparkP2P] Bot started');
  pollCycle();
  pollTimer = setInterval(pollCycle, POLL_INTERVAL);
}

function stopPoller() {
  pollerRunning = false;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function pollCycle() {
  if (!pollerRunning || !token || !browser) return;

  try {
    // Read orders from the P2P orders page
    const orders = await readOrders();
    stats.orders = orders.sell.length + orders.buy.length;

    console.log(`[SparkP2P] Orders: ${orders.sell.length} sell, ${orders.buy.length} buy`);

    // Report to VPS
    const res = await fetch(`${API_BASE}/ext/report-orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        sell_orders: orders.sell.map(norm),
        buy_orders: orders.buy.map(norm),
      }),
    });

    if (res.ok) {
      const { actions } = await res.json();
      for (const a of (actions || [])) await execAction(a);
    }

    // AUTO-RELEASE: If any sell order has status "Paid" or "Payment Received",
    // release immediately — don't wait for C2B callback (Safaricom is unreliable)
    for (const order of orders.sell) {
      const st = (order.status || '').toLowerCase();
      if (st === 'paid' || st === 'payment received' || st.includes('paid')) {
        console.log(`[SparkP2P] PAID order detected: ${order.orderNumber} — auto-releasing!`);
        await execAction({ action: 'release', order_number: order.orderNumber, message: null });
      }
    }

    stats.polls++;
    lastActiveTime = Date.now(); // Reset inactivity timer

    // Heartbeat every poll (60s) — keeps "Binance Connected" status alive
    fetch(`${API_BASE}/ext/heartbeat`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } }).catch(() => {});

    // Read market prices from P2P page for spread calculator
    if (stats.polls % 3 === 0) {
      try {
        await readMarketPrices();
      } catch (e) {}
    }

    // AI scan disabled during polling — runs only once on login (initialScan)
    // to avoid navigating away from the P2P page and breaking order reading

  } catch (e) {
    stats.errors++;
    console.error('[SparkP2P] Poll error:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════
// MARKET PRICES — Read buy/sell prices from P2P page
// ═══════════════════════════════════════════════════════════

async function readMarketPrices() {
  const page = await getPage();
  if (!page || !token) return;

  try {
    const prices = await page.evaluate(() => {
      const text = document.body.innerText;
      // Find all KSh prices on the page
      const priceMatches = text.match(/KSh\s*([\d,]+\.?\d*)/gi) || [];
      const allPrices = priceMatches.map(m => parseFloat(m.replace(/KSh\s*/i, '').replace(/,/g, ''))).filter(p => p > 50 && p < 500);

      // The P2P page shows "Buy" tab prices (sellers' ads) or "Sell" tab prices (buyers' ads)
      // Try to detect which tab we're on
      const buyTabActive = !!document.querySelector('[class*="active"][class*="buy"], [aria-selected="true"]:has(> *:contains("Buy"))');

      return { prices: allPrices, buyTabActive };
    });

    if (prices.prices.length === 0) return;

    // Sort prices - lowest first
    const sorted = [...new Set(prices.prices)].sort((a, b) => a - b);
    const bestBuyPrice = sorted[0]; // Lowest sell ad = best price to buy at
    const bestSellPrice = sorted[sorted.length - 1]; // Highest buy ad = best price to sell at

    // Send to VPS
    await fetch(`${API_BASE}/ext/market-prices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        buy_prices: sorted.slice(0, 5),
        sell_prices: sorted.slice(-5).reverse(),
        best_buy: bestBuyPrice,
        best_sell: bestSellPrice,
        spread: bestSellPrice - bestBuyPrice,
        total_ads_scanned: sorted.length,
        timestamp: new Date().toISOString(),
      }),
    }).catch(() => {});

    if (stats.polls <= 5) {
      console.log(`[SparkP2P] Market prices: buy=${bestBuyPrice}, sell=${bestSellPrice}, spread=${(bestSellPrice - bestBuyPrice).toFixed(2)}, ${sorted.length} prices found`);
    }
  } catch (e) {
    // Page not ready or navigating
  }
}

// ═══════════════════════════════════════════════════════════
// SCREENSHOT — Capture page and send to VPS
// ═══════════════════════════════════════════════════════════

async function takeScreenshot(reason) {
  const page = await getPage();
  if (!page) return null;
  try {
    const buffer = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: false });
    const base64 = buffer.toString('base64');
    console.log(`[SparkP2P] Screenshot taken: ${reason} (${Math.round(buffer.length / 1024)}KB)`);

    // Send to VPS for monitoring
    if (token) {
      await fetch(`${API_BASE}/ext/screenshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ screenshot: base64, reason, url: page.url(), timestamp: new Date().toISOString() }),
      }).catch(() => {});
    }
    return base64;
  } catch (e) {
    console.error('[SparkP2P] Screenshot error:', e.message?.substring(0, 60));
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// PIN/PASSKEY ENTRY — Auto-enter security code when Binance asks
// ═══════════════════════════════════════════════════════════

async function handleSecurityVerification(page) {
  // After clicking release/confirm, Binance may ask for:
  // 1. Passkey/PIN (6-digit code)
  // 2. Google Authenticator code
  // 3. Email/SMS verification
  // 4. Security password

  await new Promise(r => setTimeout(r, 2000));

  // Check what Binance is asking for
  const verification = await page.evaluate(() => {
    const text = document.body.innerText.toLowerCase();
    const html = document.body.innerHTML.toLowerCase();

    // Check for PIN/password input
    const pinInputs = document.querySelectorAll('input[type="password"], input[type="tel"], input[maxlength="6"], input[maxlength="1"]');
    const hasVerification = pinInputs.length > 0;

    let type = 'none';
    if (text.includes('security verification') || text.includes('verify')) type = 'verification';
    if (text.includes('passkey') || text.includes('pass key')) type = 'passkey';
    if (text.includes('authenticator') || text.includes('google auth')) type = 'authenticator';
    if (text.includes('email verification') || text.includes('email code')) type = 'email';
    if (text.includes('sms') || text.includes('phone verification')) type = 'sms';
    if (text.includes('fund password') || text.includes('trading password')) type = 'fund_password';
    if (pinInputs.length === 6 || (pinInputs.length > 0 && pinInputs[0].maxLength == 1)) type = 'pin_digits';
    if (pinInputs.length === 1 && pinInputs[0].type === 'password') type = 'password';

    return { hasVerification, type, inputCount: pinInputs.length };
  });

  if (!verification.hasVerification) {
    console.log('[SparkP2P] No security verification needed');
    return true;
  }

  console.log(`[SparkP2P] Security verification: ${verification.type} (${verification.inputCount} inputs)`);

  // Take screenshot of verification dialog
  await takeScreenshot(`Security verification: ${verification.type}`);

  // Auto-enter PIN if we have it
  if (!traderPin) {
    console.log('[SparkP2P] No PIN configured — cannot auto-verify. Screenshot sent to dashboard.');
    return false;
  }

  try {
    if (verification.type === 'pin_digits') {
      // Multiple single-digit inputs (e.g., 6 boxes)
      const inputs = await page.$$('input[maxlength="1"]');
      for (let i = 0; i < Math.min(inputs.length, traderPin.length); i++) {
        await inputs[i].type(traderPin[i], { delay: 50 });
      }
      console.log('[SparkP2P] PIN digits entered');

    } else if (verification.type === 'password' || verification.type === 'fund_password') {
      // Single password input
      const input = await page.$('input[type="password"]');
      if (input) {
        await input.click();
        await input.type(traderPin, { delay: 30 });
        console.log('[SparkP2P] Password entered');
      }

    } else if (verification.type === 'authenticator') {
      // Google Authenticator — need TOTP code, not PIN
      // TODO: Generate TOTP from secret if available
      console.log('[SparkP2P] Authenticator required — cannot auto-generate code');
      await takeScreenshot('Authenticator code required');
      return false;

    } else {
      // Generic: try typing the PIN into whatever input is focused
      await page.keyboard.type(traderPin, { delay: 50 });
      console.log('[SparkP2P] PIN typed into active input');
    }

    // Click confirm/submit button
    await new Promise(r => setTimeout(r, 500));
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => {
        const t = b.textContent.toLowerCase();
        return t.includes('confirm') || t.includes('submit') || t.includes('verify') || t.includes('next');
      });
      if (btn) btn.click();
    });

    await new Promise(r => setTimeout(r, 3000));

    // Check if verification succeeded (dialog closed)
    const stillVisible = await page.evaluate(() => {
      const inputs = document.querySelectorAll('input[type="password"], input[maxlength="6"], input[maxlength="1"]');
      return inputs.length > 0;
    });

    if (!stillVisible) {
      console.log('[SparkP2P] Security verification passed!');
      await takeScreenshot('Verification passed');
      return true;
    } else {
      console.log('[SparkP2P] Verification may have failed — inputs still visible');
      await takeScreenshot('Verification may have failed');
      return false;
    }

  } catch (e) {
    console.error('[SparkP2P] PIN entry error:', e.message?.substring(0, 60));
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// CLICK HELPER — Find and click buttons by text
// ═══════════════════════════════════════════════════════════

async function clickButton(page, ...textOptions) {
  const clicked = await page.evaluate((options) => {
    for (const text of options) {
      const btn = Array.from(document.querySelectorAll('button, a[role="button"], [class*="btn"]')).find(b => {
        const t = (b.textContent || '').toLowerCase().trim();
        return t.includes(text.toLowerCase());
      });
      if (btn) { btn.click(); return text; }
    }
    return null;
  }, textOptions);

  if (clicked) console.log(`[SparkP2P] Clicked: "${clicked}"`);
  return !!clicked;
}

// ═══════════════════════════════════════════════════════════
// ACTION EXECUTION — Full automation with PIN + screenshots
// ═══════════════════════════════════════════════════════════

async function execAction(action) {
  const { action: type, order_number } = action;
  console.log(`[SparkP2P] Executing: ${type} for order ${order_number}`);

  try {
    // Navigate to the specific order
    const page = await navigateTo(`https://p2p.binance.com/en/trade/all-payments/USDT?fiat=KES?orderNumber=${order_number}`);
    if (!page) return;
    await takeScreenshot(`Before ${type}: order ${order_number}`);

    if (type === 'release') {
      // Step 0: Send confirmation message in chat before releasing
      if (action.message) {
        console.log(`[SparkP2P] Sending confirmation: ${action.message.substring(0, 60)}`);
        const chatInput = await page.$('textarea, input[placeholder*="message" i], input[placeholder*="type" i], [contenteditable="true"]');
        if (chatInput) {
          await chatInput.click();
          await chatInput.type(action.message, { delay: 20 });
          await page.keyboard.press('Enter');
          await new Promise(r => setTimeout(r, 1000));
          console.log('[SparkP2P] Confirmation message sent');
        }
      }

      // Step 1: Click "Release" / "Confirm Release" button
      let clicked = await clickButton(page, 'release', 'confirm release');
      if (!clicked) {
        // Try looking for the button in a different way
        clicked = await clickButton(page, 'release crypto', 'release usdt');
      }

      if (clicked) {
        await new Promise(r => setTimeout(r, 2000));

        // Step 2: Confirm in dialog (Binance shows "Are you sure?")
        await clickButton(page, 'confirm', 'yes', 'release');
        await new Promise(r => setTimeout(r, 2000));

        // Step 3: Handle security verification (PIN/passkey)
        const verified = await handleSecurityVerification(page);

        await takeScreenshot(`After release: order ${order_number}`);

        await fetch(`${API_BASE}/ext/report-release`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ order_number, success: verified, error: verified ? null : 'Verification failed' }),
        });
        if (verified) stats.actions++;
      } else {
        console.log('[SparkP2P] Release button not found');
        await takeScreenshot(`Release button not found: ${order_number}`);
        await fetch(`${API_BASE}/ext/report-release`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ order_number, success: false, error: 'Release button not found' }),
        });
      }

    } else if (type === 'pay' || type === 'mark_as_paid') {
      // Step 1: Click "Payment Done" / "Transferred, notify seller"
      let clicked = await clickButton(page, 'transferred', 'payment done', 'i have paid', 'mark as paid', 'notify seller');

      if (clicked) {
        await new Promise(r => setTimeout(r, 2000));

        // Step 2: Confirm dialog
        await clickButton(page, 'confirm', 'yes');
        await new Promise(r => setTimeout(r, 2000));

        // Step 3: Handle verification
        const verified = await handleSecurityVerification(page);

        await takeScreenshot(`After payment confirm: order ${order_number}`);

        await fetch(`${API_BASE}/ext/report-payment-sent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ order_number, success: verified }),
        });
        if (verified) stats.actions++;
      } else {
        console.log('[SparkP2P] Payment button not found');
        await takeScreenshot(`Payment button not found: ${order_number}`);
      }

    } else if (type === 'send_message') {
      // Find chat input and type message
      const chatInput = await page.$('textarea, input[placeholder*="message" i], input[placeholder*="type" i], [contenteditable="true"]');
      if (chatInput) {
        await chatInput.click();
        await chatInput.type(action.message || '', { delay: 30 });
        await page.keyboard.press('Enter');
        console.log(`[SparkP2P] Message sent: ${(action.message || '').substring(0, 50)}`);
      } else {
        console.log('[SparkP2P] Chat input not found');
        await takeScreenshot('Chat input not found');
      }

    } else if (type === 'screenshot') {
      // Just take a screenshot of current state
      await takeScreenshot(action.reason || 'Manual screenshot request');
    }

    // Navigate back to orders page for next poll
    await navigateTo('https://p2p.binance.com/en/trade/all-payments/USDT?fiat=KES');

  } catch (e) {
    stats.errors++;
    console.error(`[SparkP2P] Action ${type} error:`, e.message?.substring(0, 60));
    await takeScreenshot(`Error during ${type}: ${e.message?.substring(0, 40)}`);
  }
}

async function aiScan() {
  const page = await getPage();
  if (!page) return;

  try {
    console.log('[SparkP2P] Starting AI scan...');
    const scanData = await aiScanner.fullScan(page);

    // Format and send to VPS
    const balances = (scanData.wallet?.balances || []).map(b => ({
      asset: b.asset, free: b.available || b.total || 0, locked: b.locked || 0, total: b.total || 0,
    }));

    const activeAds = (scanData.ads?.ads || []).map(a => ({
      tradeType: a.type, asset: a.asset || 'USDT', fiat: a.currency || 'KES',
      price: a.price || 0, amount: a.available_amount || 0,
      minLimit: a.min_limit || 0, maxLimit: a.max_limit || 0,
      status: a.status, paymentMethods: a.payment_methods || [],
    }));

    const pendingOrders = (scanData.orders?.pending_orders || []).map(o => ({
      orderNumber: o.order_number, tradeType: o.type, totalPrice: o.amount_fiat || 0,
      amount: o.amount_crypto || 0, price: o.price || 0, asset: o.asset || 'USDT',
      counterparty: o.counterparty || '', status: o.status,
    }));

    await fetch(`${API_BASE}/ext/report-account-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        balances,
        active_ads: activeAds,
        completed_orders: [],
        payment_methods: [],
      }),
    });

    // Also update trader nickname if found
    if (scanData.profile?.nickname) {
      await fetch(`${API_BASE}/ext/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      }).catch(() => {});
    }

    console.log(`[SparkP2P] AI scan: ${balances.length} bal, ${activeAds.length} ads, ${pendingOrders.length} orders, user: ${scanData.profile?.nickname || 'unknown'}`);

    // Navigate back to orders page for polling
    await page.goto('https://p2p.binance.com/en/trade/all-payments/USDT?fiat=KES', { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});

  } catch (e) {
    console.error('[SparkP2P] AI scan error:', e.message?.substring(0, 80));
  }
}

async function reportAccountData() {
  try {
    // Read balance from wallet page
    const balances = await readBalance();

    // Navigate back to P2P orders for completed orders
    const page = await navigateTo('https://p2p.binance.com/en/trade/all-payments/USDT?fiat=KES?tab=completed');
    let completed = [];
    if (page) {
      await new Promise(r => setTimeout(r, 2000));
      completed = await page.evaluate(() => {
        const orders = [];
        const rows = document.querySelectorAll('[class*="order-item"], [class*="OrderItem"], tr[class*="order"]');
        rows.forEach(el => {
          const text = el.textContent || '';
          orders.push({
            orderNumber: text.match(/(\d{18,})/)?.[1] || '',
            tradeType: text.toLowerCase().includes('sell') ? 'SELL' : 'BUY',
            totalPrice: parseFloat((text.match(/KES\s*([\d,]+\.?\d*)/i)?.[1] || '0').replace(/,/g, '')),
            amount: parseFloat(text.match(/([\d.]+)\s*USDT/)?.[1] || '0'),
            asset: 'USDT', fiat: 'KES',
          });
        });
        return orders.filter(o => o.orderNumber);
      }).catch(() => []);
    }

    await fetch(`${API_BASE}/ext/report-account-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ balances, completed_orders: completed, active_ads: [], payment_methods: [] }),
    });

    console.log(`[SparkP2P] Account: ${balances.length} bal, ${completed.length} orders`);

    // Navigate back to active orders page for next poll
    await navigateTo('https://p2p.binance.com/en/trade/all-payments/USDT?fiat=KES');

  } catch (e) {
    console.error('[SparkP2P] Account data error:', e.message?.substring(0, 60));
  }
}

function norm(o) {
  // Map status strings to Binance status codes
  const statusMap = { 'pending': 1, 'pending payment': 1, 'paid': 2, 'appeal': 3, 'completed': 4 };
  const statusCode = typeof o.status === 'number' ? o.status :
    statusMap[(o.status || '').toLowerCase()] || 1;

  return {
    orderNumber: o.orderNumber || '',
    tradeType: o.tradeType || 'SELL',
    totalPrice: o.totalPrice || 0,
    amount: o.amount || 0,
    price: o.totalPrice && o.amount ? o.totalPrice / o.amount : 130,
    asset: o.asset || 'USDT',
    orderStatus: statusCode,
    buyerNickname: o.counterparty || null,
  };
}

// IPC
ipcMain.handle('connect-binance', () => { connectBinance(); return { opened: true }; });
ipcMain.handle('set-token', (_, t) => { token = t; return { ok: true }; });
ipcMain.handle('set-pin', (_, pin) => { traderPin = pin; console.log('[SparkP2P] PIN configured'); return { ok: true }; });
ipcMain.handle('set-ai-key', (_, key) => { aiApiKey = key; aiScanner.initAI(key); console.log('[SparkP2P] GPT-4o configured'); return { ok: true }; });
ipcMain.handle('get-bot-status', () => ({ running: pollerRunning, stats, hasPin: !!traderPin, hasAI: !!aiApiKey }));
ipcMain.handle('take-screenshot', async () => { const ss = await takeScreenshot('Manual request'); return { screenshot: ss }; });
ipcMain.handle('run-ai-scan', async () => { await aiScan(); return { ok: true }; });
ipcMain.handle('restart-app', () => { autoUpdater.quitAndInstall(); });
