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
const POLL_INTERVAL = 15000; // 15 seconds

let mainWindow = null;
let tray = null;
let token = null;
let browser = null;
let pollerRunning = false;
let pollTimer = null;
let stats = { polls: 0, actions: 0, errors: 0, orders: 0 };

// ═══════════════════════════════════════════════════════════
// ELECTRON
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
  if (!browser) {
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

      // Navigate to P2P orders page
      const page = await getPage();
      if (page) {
        await page.goto('https://p2p.binance.com/en/fiatOrder', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 3000));
      }

      // Sync cookies to VPS
      await syncCookies();

      // Start the bot
      startPoller();

      if (mainWindow) {
        mainWindow.show();
        mainWindow.webContents.executeJavaScript(
          'alert("Binance connected! Bot is running. Keep Chrome open (you can minimize it).")'
        );
      }
    }
  }, 2000);
}

async function tryAutoStart() {
  if (!token || browser) return;
  try {
    if (await connectPuppeteer()) {
      if (await isLoggedIn()) {
        console.log('[SparkP2P] Auto-connected to existing Chrome session');
        startPoller();
        return;
      }
    }
  } catch (e) {}
  console.log('[SparkP2P] No active session — launching Chrome...');
  await connectBinance();
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

async function readOrders() {
  // Navigate to P2P orders page and read pending orders from DOM
  const page = await navigateTo('https://p2p.binance.com/en/fiatOrder');
  if (!page) return { sell: [], buy: [] };

  try {
    const orders = await page.evaluate(() => {
      const results = { sell: [], buy: [] };
      // Look for order cards/rows on the page
      const orderElements = document.querySelectorAll('[class*="order-item"], [class*="OrderItem"], tr[class*="order"], [data-testid*="order"]');

      orderElements.forEach(el => {
        const text = el.textContent || '';
        const order = {
          orderNumber: (text.match(/(\d{18,})/)?.[1] || ''),
          tradeType: text.toLowerCase().includes('sell') ? 'SELL' : 'BUY',
          totalPrice: parseFloat((text.match(/KES\s*([\d,]+\.?\d*)/i)?.[1] || '0').replace(/,/g, '')),
          amount: parseFloat(text.match(/([\d.]+)\s*USDT/)?.[1] || '0'),
          asset: 'USDT',
          status: text.toLowerCase().includes('release') ? 'PENDING_RELEASE' :
                  text.toLowerCase().includes('paid') ? 'PAID' :
                  text.toLowerCase().includes('pending') ? 'PENDING' : 'ACTIVE',
        };
        if (order.orderNumber) {
          if (order.tradeType === 'SELL') results.sell.push(order);
          else results.buy.push(order);
        }
      });

      return results;
    });

    return orders;
  } catch (e) {
    console.error('[SparkP2P] Read orders error:', e.message?.substring(0, 60));
    return { sell: [], buy: [] };
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

    stats.polls++;

    // Heartbeat
    if (stats.polls % 3 === 0) {
      fetch(`${API_BASE}/ext/heartbeat`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } }).catch(() => {});
    }

    // Account data every 10th poll (navigates to wallet page)
    if (stats.polls % 10 === 0) {
      await reportAccountData();
    }

  } catch (e) {
    stats.errors++;
    console.error('[SparkP2P] Poll error:', e.message);
  }
}

async function execAction(action) {
  const { action: type, order_number } = action;
  console.log(`[SparkP2P] Executing: ${type} for order ${order_number}`);

  try {
    // Navigate to the specific order page
    const page = await navigateTo(`https://p2p.binance.com/en/fiatOrder?orderNumber=${order_number}`);
    if (!page) return;

    if (type === 'release') {
      // Click the Release button on the order page
      const clicked = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b =>
          b.textContent.toLowerCase().includes('release') || b.textContent.toLowerCase().includes('confirm')
        );
        if (btn) { btn.click(); return true; }
        return false;
      });

      // May need to confirm in a dialog
      if (clicked) {
        await new Promise(r => setTimeout(r, 2000));
        await page.evaluate(() => {
          const confirmBtn = Array.from(document.querySelectorAll('button')).find(b =>
            b.textContent.toLowerCase().includes('confirm') || b.textContent.toLowerCase().includes('release')
          );
          if (confirmBtn) confirmBtn.click();
        });
      }

      await fetch(`${API_BASE}/ext/report-release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ order_number, success: clicked, error: clicked ? null : 'Release button not found' }),
      });
      if (clicked) stats.actions++;

    } else if (type === 'pay' || type === 'mark_as_paid') {
      // Click the "Payment Done" / "Transferred" button
      const clicked = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b =>
          b.textContent.toLowerCase().includes('payment') ||
          b.textContent.toLowerCase().includes('transferred') ||
          b.textContent.toLowerCase().includes('paid')
        );
        if (btn) { btn.click(); return true; }
        return false;
      });

      if (clicked) {
        await new Promise(r => setTimeout(r, 2000));
        await page.evaluate(() => {
          const confirmBtn = Array.from(document.querySelectorAll('button')).find(b =>
            b.textContent.toLowerCase().includes('confirm')
          );
          if (confirmBtn) confirmBtn.click();
        });
      }

      await fetch(`${API_BASE}/ext/report-payment-sent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ order_number, success: clicked }),
      });
      if (clicked) stats.actions++;

    } else if (type === 'send_message') {
      // Type in the chat input
      const chatInput = await page.$('textarea, input[placeholder*="message"], input[placeholder*="Message"]');
      if (chatInput) {
        await chatInput.type(action.message || '', { delay: 30 });
        await page.keyboard.press('Enter');
      }
    }
  } catch (e) {
    stats.errors++;
    console.error(`[SparkP2P] Action ${type} error:`, e.message?.substring(0, 60));
  }
}

async function reportAccountData() {
  try {
    // Read balance from wallet page
    const balances = await readBalance();

    // Navigate back to P2P orders for completed orders
    const page = await navigateTo('https://p2p.binance.com/en/fiatOrder?tab=completed');
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
    await navigateTo('https://p2p.binance.com/en/fiatOrder');

  } catch (e) {
    console.error('[SparkP2P] Account data error:', e.message?.substring(0, 60));
  }
}

function norm(o) {
  return {
    orderNumber: o.orderNumber || '', tradeType: o.tradeType || '',
    totalPrice: o.totalPrice || 0, amount: o.amount || 0,
    price: o.totalPrice && o.amount ? o.totalPrice / o.amount : 0,
    asset: o.asset || 'USDT', orderStatus: o.status || null,
  };
}

// IPC
ipcMain.handle('connect-binance', () => { connectBinance(); return { opened: true }; });
ipcMain.handle('set-token', (_, t) => { token = t; return { ok: true }; });
