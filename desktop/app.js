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
let traderPin = null; // Binance security PIN — stored in memory only

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
    const page = await navigateTo(`https://p2p.binance.com/en/fiatOrder?orderNumber=${order_number}`);
    if (!page) return;
    await takeScreenshot(`Before ${type}: order ${order_number}`);

    if (type === 'release') {
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
    await navigateTo('https://p2p.binance.com/en/fiatOrder');

  } catch (e) {
    stats.errors++;
    console.error(`[SparkP2P] Action ${type} error:`, e.message?.substring(0, 60));
    await takeScreenshot(`Error during ${type}: ${e.message?.substring(0, 40)}`);
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
ipcMain.handle('set-pin', (_, pin) => { traderPin = pin; console.log('[SparkP2P] PIN configured'); return { ok: true }; });
ipcMain.handle('get-bot-status', () => ({ running: pollerRunning, stats, hasPin: !!traderPin }));
ipcMain.handle('take-screenshot', async () => { const ss = await takeScreenshot('Manual request'); return { screenshot: ss }; });
