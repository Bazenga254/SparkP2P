const { app, BrowserWindow, Tray, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, execSync } = require('child_process');
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
const POLL_INTERVAL = 30000; // 30 seconds

let mainWindow = null;
let tray = null;
let token = null;
let browser = null;
let pollerRunning = false;
let pollTimer = null;
let stats = { polls: 0, actions: 0, errors: 0, orders: 0 };
let traderPin = null; // Binance security PIN — stored in memory only
let browserLocked = false;
let lockFrameListener = null;
let chromeProcess = null; // Child process reference for killing Chrome on quit
let connectingBinance = false; // Prevents concurrent connectBinance() calls
let scanningInProgress = false; // Prevents concurrent initialScan() calls
let sessionStartTime = null;   // When Binance login was last confirmed
let loggedOutStrikes = 0;      // Consecutive failed isLoggedIn() checks before re-login
const SESSION_GRACE_MS = 30 * 60 * 1000; // 30 min grace period before re-login is allowed
const LOGOUT_STRIKES_NEEDED = 3;          // Require 3 consecutive failures before declaring session lost
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

// Persist token to disk so it survives app restarts
const TOKEN_FILE = path.join(app.getPath('userData'), 'session.json');
function saveTokenToDisk(t) {
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token: t, savedAt: Date.now() })); } catch (e) {}
}
function loadTokenFromDisk() {
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    return data?.token || null;
  } catch (e) { return null; }
}
// Load persisted token on startup
token = loadTokenFromDisk();
if (token) console.log('[SparkP2P] Session restored from disk');

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
function killChrome() {
  if (!chromeProcess) return;
  const pid = chromeProcess.pid;
  chromeProcess = null;
  try {
    // Kill the entire process tree (Chrome spawns many child processes)
    if (process.platform === 'win32') {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch (e) {}
}

app.on('before-quit', () => {
  stopPoller();
  killChrome();
  if (browser) { try { browser.disconnect(); } catch(e) {} browser = null; }
  if (tray) tray.destroy();
});

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 850, title: 'SparkP2P',
    backgroundColor: '#0d0f1e',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true },
    autoHideMenuBar: true,
  });

  const loadDashboard = (attempt = 1) => {
    mainWindow.loadURL(DASHBOARD_URL).catch(() => {});
  };

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    // -3 = ERR_ABORTED — fires on normal SPA navigations, ignore it
    // Also ignore failures on data: URLs (our own retry page)
    if (errorCode === -3) return;
    if (validatedURL && validatedURL.startsWith('data:')) return;
    console.log(`[SparkP2P] Page load failed (${errorCode}): ${errorDescription}`);
    // Show a retry page inline (use encodeURIComponent so # in hex colors don't break the data URL)
    const retryHTML = `<html><head><style>body{margin:0;background:rgb(13,15,30);color:white;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px;}h2{color:rgb(245,158,11);margin:0;}p{color:rgb(156,163,175);margin:0;font-size:14px;}button{margin-top:8px;padding:12px 28px;background:rgb(245,158,11);border:none;border-radius:8px;font-weight:700;font-size:14px;cursor:pointer;}</style></head><body><h2>&#9889; SparkP2P</h2><p>Could not connect. Check your internet connection.</p><button onclick="location.reload()">Retry</button><p style="font-size:12px;color:rgb(107,114,128);">Error: ${errorDescription.replace(/</g,'&lt;')}</p></body></html>`;
    mainWindow.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(retryHTML)}`);
    // Auto-retry after 20 seconds
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) loadDashboard();
    }, 20000);
  });

  loadDashboard();
  mainWindow.on('close', () => { app.isQuitting = true; app.quit(); });

  // Capture token on every page load and navigation
  const captureToken = () => {
    mainWindow.webContents.executeJavaScript('localStorage.getItem("token")')
      .then((t) => {
        if (t && t !== token) {
          token = t;
          saveTokenToDisk(t);
          console.log('[SparkP2P] Token captured and saved');
          tryAutoStart();
        }
      }).catch(() => {});
  };

  // On every page load: inject persisted token into localStorage BEFORE React checks auth
  mainWindow.webContents.on('did-finish-load', () => {
    if (token) {
      mainWindow.webContents.executeJavaScript(
        `localStorage.setItem("token", ${JSON.stringify(token)})`
      ).catch(() => {});
    }
    captureToken();
  });
  mainWindow.webContents.on('did-navigate-in-page', captureToken);
  // Also poll for token every 5 seconds (catches SPA login)
  setInterval(captureToken, 5000);

  // Intercept WebSocket remote browser — open Chrome instead (only if not already connecting/connected)
  mainWindow.webContents.session.webRequest.onBeforeRequest(
    { urls: ['wss://sparkp2p.com/api/browser/login-stream*', 'ws://*/api/browser/login-stream*'] },
    (_, cb) => { cb({ cancel: true }); if (!connectingBinance && !pollerRunning) connectBinance(); }
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

  // Clear previous session files to prevent Chrome from restoring old tabs
  const sessionDir = path.join(app.getPath('userData'), 'chrome-binance', 'Default');
  ['Current Session', 'Current Tabs', 'Last Session', 'Last Tabs'].forEach(f => {
    try { fs.unlinkSync(path.join(sessionDir, f)); } catch(e) {}
  });

  chromeProcess = execFile(chrome, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + path.join(app.getPath('userData'), 'chrome-binance'),
    url || 'https://accounts.binance.com/en/login',
  ]);
  chromeProcess.on('exit', () => {
    // Chrome was closed externally — stop the bot, don't reopen
    console.log('[SparkP2P] Chrome closed by user');
    chromeProcess = null;
    if (browser) { try { browser.disconnect(); } catch(e) {} browser = null; }
    stopPoller();
    browserLocked = false;
    connectingBinance = false;
    scanningInProgress = false;
    if (lockFrameListener) { lockFrameListener = null; }
    if (mainWindow) {
      mainWindow.show();
      mainWindow.webContents.executeJavaScript(
        'window.dispatchEvent(new CustomEvent("binance-disconnected"))'
      ).catch(() => {});
    }
  });
  console.log('[SparkP2P] Chrome launched');
  await new Promise(r => setTimeout(r, 4000));
  return true;
}

async function connectPuppeteer() {
  try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP_PORT}`, defaultViewport: null });
    // When Chrome closes externally, immediately stop the bot (prevents auto-reopen)
    browser.on('disconnected', () => {
      if (browser) { browser = null; }
      stopPoller();
      browserLocked = false;
    });
    // Close any extra tabs — keep only the first one
    const pages = await browser.pages();
    for (let i = 1; i < pages.length; i++) {
      await pages[i].close().catch(() => {});
    }
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
    const url = page.url();
    // Definitely not logged in if on login/register/auth pages
    if (url.includes('accounts.binance.com')) return false;
    if (/\/(login|register|forgot-password|security-verify)/.test(url)) return false;
    // If we're on any binance.com page that's not the login page, user is authenticated
    // (Binance redirects to login if not authenticated)
    if (url.includes('binance.com') && url.length > 20) {
      // Double-check: make sure the page didn't silently redirect to a login form
      const hasLoginForm = await page.evaluate(() => {
        return !!(document.querySelector('input[type="password"][placeholder*="assword"]') ||
                  document.querySelector('button[data-bn-type="button"][type="submit"]') &&
                  document.querySelector('form') &&
                  document.querySelector('input[name="email"]'));
      }).catch(() => false);
      return !hasLoginForm;
    }
    return false;
  } catch (e) { return false; }
}

// ═══════════════════════════════════════════════════════════
// BROWSER LOCK — Block user input on Chrome after login
// ═══════════════════════════════════════════════════════════

async function injectLockOverlay(page) {
  await page.evaluate(() => {
    if (document.getElementById('sparkp2p-browser-lock')) return;
    const el = document.createElement('div');
    el.id = 'sparkp2p-browser-lock';
    el.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'width:100vw', 'height:100vh',
      'background:transparent', 'z-index:2147483647',
      'cursor:not-allowed', 'pointer-events:all', 'user-select:none',
      'font-family:-apple-system,sans-serif',
    ].join('!important;') + '!important';
    el.innerHTML = `
      <div style="position:fixed;bottom:16px;right:16px;display:flex;align-items:center;gap:8px;padding:8px 14px;background:rgba(0,0,0,0.75);border:1px solid rgba(245,158,11,0.5);border-radius:20px;backdrop-filter:blur(4px)">
        <span style="font-size:14px">🔒</span>
        <span style="color:#f59e0b;font-size:12px;font-weight:600">SparkP2P Bot Active</span>
      </div>`;
    const block = e => { e.preventDefault(); e.stopImmediatePropagation(); };
    ['click','mousedown','mouseup','dblclick','contextmenu',
     'keydown','keyup','keypress','wheel','scroll','touchstart','touchend'
    ].forEach(t => el.addEventListener(t, block, true));
    document.body.appendChild(el);
  }).catch(() => {});
}

async function lockChromeBrowser() {
  browserLocked = true;
  const page = await getPage('binance.com');
  if (!page) return;
  await injectLockOverlay(page);
  // Re-inject after every Puppeteer navigation (bot navigates internally)
  if (lockFrameListener) page.off('framenavigated', lockFrameListener);
  lockFrameListener = async (frame) => {
    if (frame === page.mainFrame()) {
      await new Promise(r => setTimeout(r, 600));
      await injectLockOverlay(page).catch(() => {});
    }
  };
  page.on('framenavigated', lockFrameListener);
  console.log('[SparkP2P] Chrome browser locked');
}

async function unlockChromeBrowser() {
  browserLocked = false;
  const page = await getPage('binance.com');
  if (page) {
    if (lockFrameListener) { page.off('framenavigated', lockFrameListener); lockFrameListener = null; }
    await page.evaluate(() => {
      const el = document.getElementById('sparkp2p-browser-lock');
      if (el) el.remove();
    }).catch(() => {});
  }
  console.log('[SparkP2P] Chrome browser unlocked');
}

// ═══════════════════════════════════════════════════════════
// CONNECT BINANCE — Open Chrome, wait for login, start bot
// ═══════════════════════════════════════════════════════════

async function connectBinance() {
  if (connectingBinance || pollerRunning) return; // Already connecting or running
  connectingBinance = true;

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
  let detected = false; // Guard against duplicate login detection
  const check = setInterval(async () => {
    if (detected) return; // Already handling login
    attempts++;
    if (attempts > 300) { clearInterval(check); connectingBinance = false; return; } // 10 min timeout

    if (await isLoggedIn()) {
      if (detected) return; // Double-check after async
      detected = true;
      clearInterval(check);
      console.log('[SparkP2P] Login detected!');
      sessionStartTime = Date.now();
      loggedOutStrikes = 0;

      // Lock Chrome immediately so user cannot interact with Binance
      await lockChromeBrowser();

      // Bring SparkP2P dashboard to front
      if (mainWindow) mainWindow.show();

      // Send heartbeat immediately so dashboard shows "Connected"
      if (token) {
        fetch(`${API_BASE}/ext/heartbeat`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } }).catch(() => {});
      }

      // Sync cookies to mark as connected on VPS
      await syncCookies();
      connectingBinance = false;

      // Block window.open() on all Binance pages to prevent popup tabs
      const mainPage = await getPage();
      if (mainPage) {
        await mainPage.evaluateOnNewDocument(() => { window.open = () => null; }).catch(() => {});
      }

      // Run initial scan FIRST — poller would race on the same tab causing extra tabs
      await initialScan().catch(e => { scanningInProgress = false; console.error('[SparkP2P] Initial scan error:', e.message?.substring(0, 60)); });

      // Start poller only after scan is done (no more tab conflicts)
      startPoller();
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

// Silently refresh JWT every 20 minutes — prevents session expiry without re-login
setInterval(async () => {
  if (!token) return;
  try {
    const res = await fetch(`${API_BASE}/traders/refresh-token`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.access_token) {
        token = data.access_token;
        saveTokenToDisk(token);
        // Store refreshed token back in the dashboard's localStorage
        if (mainWindow) {
          mainWindow.webContents.executeJavaScript(
            `localStorage.setItem("token", ${JSON.stringify(data.access_token)})`
          ).catch(() => {});
        }
        console.log('[SparkP2P] Token refreshed — session extended 30 days');
      }
    }
  } catch (e) {}
}, 20 * 60 * 1000);

// ═══════════════════════════════════════════════════════════
// INITIAL SCAN — First thing after login:
// 1. Profile page → get username
// 2. Funding wallet → get funding USDT balance
// 3. Spot wallet → get spot USDT balance
// 4. Upload everything to VPS
// 5. Navigate to P2P ads page and keep browser there
// ═══════════════════════════════════════════════════════════

async function verifyTraderIdentity(page) {
  if (!token) return;
  try {
    // Navigate to P2P My Ads — payment methods here show the real account holder name
    await page.goto('https://p2p.binance.com/en/myAds', { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 4000));

    const pageText = await page.evaluate(() => {
      const overlay = document.getElementById('sparkp2p-browser-lock');
      const overlayText = overlay ? overlay.innerText : '';
      return document.body.innerText.replace(overlayText, '');
    }).catch(() => '');

    if (!pageText) return;

    let realName = '';
    if (aiApiKey) {
      const result = await aiScanner.analyzeText(pageText, `
        This is from a Binance P2P "My Ads" page. Find the payment method account holder's real name.
        It appears next to M-PESA, bank, or other payment methods (e.g. "JOHN DOE KAMAU").
        Return JSON: {"real_name": "FULL NAME IN CAPS or empty string if not found"}
      `);
      realName = (result?.real_name || '').trim().toUpperCase();
    }

    if (!realName) {
      console.log('[SparkP2P] Identity scan: no name found, skipping');
      return;
    }

    console.log(`[SparkP2P] Identity scan: found name "${realName}"`);

    const res = await fetch(`${API_BASE}/ext/verify-identity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ p2p_real_name: realName }),
    }).catch(() => null);

    if (!res) return;
    const data = await res.json().catch(() => ({}));

    if (!data.verified) {
      console.log(`[SparkP2P] IDENTITY MISMATCH: ${data.message}`);
      stopPoller();
      await unlockChromeBrowser();
      if (mainWindow) {
        mainWindow.show();
        mainWindow.webContents.executeJavaScript(
          `window.dispatchEvent(new CustomEvent("identity-mismatch", { detail: ${JSON.stringify({ message: data.message })} }))`
        ).catch(() => {});
      }
    } else {
      console.log(`[SparkP2P] Identity verified: ${realName}`);
    }
  } catch (e) {
    console.error('[SparkP2P] Identity verify error:', e.message?.substring(0, 60));
  }
}

// ═══════════════════════════════════════════════════════════
// WALLET SCANNER — Read all coin balances from Overview
// Uses DOM text (overlay-safe) + AI parsing
// ═══════════════════════════════════════════════════════════

async function readWalletPage(page, url, walletType) {
  console.log(`[SparkP2P] Reading ${walletType} wallet...`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 5000));

  // Take full-page screenshot — overlay is transparent so AI sees the real page
  const screenshot = await page.screenshot({ type: 'jpeg', quality: 85 });

  if (aiApiKey) {
    const parsed = await aiScanner.analyzeScreenshot(screenshot, `
      This is a screenshot of a Binance ${walletType} wallet page.
      Extract ALL visible crypto coin balances from the "My Assets" or coin list.
      Return JSON: {"balances": [{"asset": "USDT", "total": 42.31, "available": 42.31, "locked": 0}]}
      Include ALL coins with a total > 0. If nothing visible return {"balances": []}.
    `);
    console.log(`[SparkP2P] ${walletType}:`, JSON.stringify(parsed)?.substring(0, 200));
    return (parsed?.balances || []).map(b => ({
      asset: b.asset, free: b.available ?? b.total ?? 0,
      locked: b.locked ?? 0, total: b.total ?? 0, wallet: walletType,
    }));
  }

  return []; // No AI key — cannot parse screenshot without AI
}

async function scanWalletBalances(page) {
  const fundingBals = await readWalletPage(page, 'https://www.binance.com/en/my/wallet/funding', 'Funding');
  const spotBals = await readWalletPage(page, 'https://www.binance.com/en/my/wallet/account/overview', 'Spot');

  // Merge: if same asset exists in both, keep funding; add spot-only assets separately
  const fundingAssets = new Set(fundingBals.map(b => b.asset));
  const allBalances = [...fundingBals, ...spotBals.filter(b => !fundingAssets.has(b.asset))];
  console.log(`[SparkP2P] Wallet scan: ${allBalances.length} assets (${fundingBals.length} funding, ${spotBals.length} spot)`);

  // Successfully scanned Binance pages — session is alive, reset the re-login timer
  sessionStartTime = Date.now();
  loggedOutStrikes = 0;

  return allBalances;
}

async function uploadBalances(balances, nickname = '') {
  if (!token) return;
  await fetch(`${API_BASE}/ext/report-account-data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ balances, active_ads: [], completed_orders: [], payment_methods: [], nickname }),
  }).catch(() => {});
  console.log(`[SparkP2P] Uploaded ${balances.length} balances to VPS`);
}

async function initialScan() {
  if (scanningInProgress) return;
  scanningInProgress = true;

  const page = await getPage();
  if (!page) { scanningInProgress = false; return; }

  console.log('[SparkP2P] === INITIAL SCAN START ===');

  // Step 1: Profile — get username
  let nickname = '';
  if (aiApiKey) {
    const profileData = await aiScanner.scanProfile(page);
    nickname = profileData?.nickname || '';
    console.log(`[SparkP2P] Username: ${nickname || 'unknown'}`);
  }

  // Step 2: Scan all wallet balances (Funding + Spot)
  const balances = await scanWalletBalances(page);

  // Step 3: Upload to VPS
  await uploadBalances(balances, nickname);

  // Step 4: Verify trader identity
  console.log('[SparkP2P] Verifying trader identity...');
  await verifyTraderIdentity(page);

  console.log('[SparkP2P] === INITIAL SCAN COMPLETE ===');
  scanningInProgress = false;
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
  // IMPORTANT: Use DOM text — NOT screenshots — for orders.
  // GPT Vision OCR misreads 18-20 digit order numbers causing duplicate DB records.
  // DOM text gives exact digits straight from the HTML.
  if (!browser || _ordersTabOpen) return { sell: [], buy: [], cancelled: [] };

  _ordersTabOpen = true;
  try {
    const page = await getPage();
    if (!page) { _ordersTabOpen = false; return { sell: [], buy: [], cancelled: [] }; }

    // ── Step 1: Read active/ongoing orders (tab=0) ──────────────────────────
    await page.goto('https://p2p.binance.com/en/fiatOrder?tab=0&page=1', { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2500));

    const activeText = await page.evaluate(() => document.body.innerText).catch(() => '');

    let sell = [], buy = [];
    if (activeText && aiApiKey && !activeText.includes('No records') && !activeText.includes('No data')) {
      const aiResult = await aiScanner.analyzeText(activeText, `
        This is exact text copied from a Binance P2P orders page.
        Extract ALL pending or active orders (ignore Completed/Cancelled).
        The order numbers are 18-20 digit integers — copy them EXACTLY as they appear, do NOT change any digits.
        Return JSON: {
          "orders": [{
            "order_number": "exact 18-20 digit number as written",
            "type": "SELL" or "BUY",
            "amount_fiat": number (KES amount, exact),
            "amount_crypto": number (USDT amount, exact),
            "status": "Pending Payment" or "Paid" or "Appeal",
            "counterparty": "string"
          }]
        }
        If no pending/active orders, return {"orders": []}.
      `);

      if (aiResult?.orders) {
        for (const o of aiResult.orders) {
          const order = {
            orderNumber: String(o.order_number || '').replace(/\D/g, ''),
            tradeType: (o.type || '').toUpperCase() === 'BUY' ? 'BUY' : 'SELL',
            totalPrice: o.amount_fiat || 0,
            amount: o.amount_crypto || 0,
            asset: 'USDT',
            status: o.status || 'PENDING',
            counterparty: o.counterparty || '',
          };
          if (order.orderNumber.length >= 15) {
            if (order.tradeType === 'SELL') sell.push(order);
            else buy.push(order);
          }
        }
      }
    }

    // ── Step 2: Read recently cancelled orders (tab=1, Cancelled filter) ───
    let cancelled = [];
    await page.goto('https://p2p.binance.com/en/fiatOrder?tab=1&page=1', { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));

    // Click the "Canceled" filter tab if it exists
    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('div[class*="tab"], span[class*="tab"], button'));
      const cancelTab = tabs.find(el => el.textContent.trim() === 'Canceled' || el.textContent.trim() === 'Cancelled');
      if (cancelTab) cancelTab.click();
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));

    const cancelledText = await page.evaluate(() => document.body.innerText).catch(() => '');

    if (cancelledText && aiApiKey && !cancelledText.includes('No records') && !cancelledText.includes('No data')) {
      const aiResult = await aiScanner.analyzeText(cancelledText, `
        This is text from a Binance P2P cancelled orders history page.
        Extract order numbers of CANCELLED orders from TODAY only (ignore older dates).
        The order numbers are 18-20 digit integers — copy them EXACTLY as they appear.
        Return JSON: { "cancelled_order_numbers": ["number1", "number2", ...] }
        If none today, return {"cancelled_order_numbers": []}.
      `);
      if (aiResult?.cancelled_order_numbers) {
        cancelled = aiResult.cancelled_order_numbers
          .map(n => String(n).replace(/\D/g, ''))
          .filter(n => n.length >= 15);
      }
    }

    console.log(`[SparkP2P] Orders: ${sell.length} sell, ${buy.length} buy, ${cancelled.length} cancelled`);
    return { sell, buy, cancelled };

  } catch (e) {
    console.error('[SparkP2P] Read orders error:', e.message?.substring(0, 60));
    _ordersTabOpen = false;
    return { sell: [], buy: [], cancelled: [] };
  } finally {
    _ordersTabOpen = false;
  }
}

async function readBalance() {
  // Navigate to wallet overview and read balance from page DOM
  const page = await navigateTo('https://www.binance.com/en/my/wallet/account/overview');
  if (!page) return [];

  try {
    await new Promise(r => setTimeout(r, 5000)); // Wait for balances to load

    const balances = await page.evaluate(() => {
      const results = [];
      const text = document.body.innerText;

      // Strategy 1: Find rows with asset + amount pattern in wallet table
      const rows = document.querySelectorAll('tr, [class*="assetRow"], [class*="coinRow"], [class*="asset-row"]');
      rows.forEach(row => {
        const rowText = row.innerText || '';
        // Look for known crypto assets followed by a number
        const assetMatch = rowText.match(/^(USDT|BTC|ETH|BNB|USDC|BUSD)\s+([\d,]+\.?\d*)/m);
        if (assetMatch) {
          const asset = assetMatch[1];
          const total = parseFloat(assetMatch[2].replace(/,/g, ''));
          if (total > 0 && !results.find(r => r.asset === asset)) {
            results.push({ asset, free: total, locked: 0, total, wallet: 'Spot' });
          }
        }
      });

      // Strategy 2: Scan full page text for Estimated Balance in USDT
      if (results.length === 0) {
        const estMatch = text.match(/Estimated Balance\s*[\n\r]*\s*([\d,]+\.?\d*)\s*USDT/i);
        if (estMatch) {
          const total = parseFloat(estMatch[1].replace(/,/g, ''));
          if (total >= 0) results.push({ asset: 'USDT', free: total, locked: 0, total, wallet: 'Spot' });
        }
      }

      // Strategy 3: Look for prominent USDT amount on the page
      if (results.length === 0) {
        const spans = Array.from(document.querySelectorAll('span, div, p'));
        for (const el of spans) {
          const t = (el.innerText || '').trim();
          if (/^\d[\d,]*\.\d{2,8}$/.test(t)) {
            const prev = el.previousElementSibling?.innerText || el.parentElement?.innerText || '';
            if (prev.includes('USDT') || prev.includes('Total')) {
              const val = parseFloat(t.replace(/,/g, ''));
              if (val >= 0) {
                results.push({ asset: 'USDT', free: val, locked: 0, total: val, wallet: 'Spot' });
                break;
              }
            }
          }
        }
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

async function verifyMpesaPayment(orderNumber, fiatAmount) {
  if (!token) return false;
  try {
    const res = await fetch(`${API_BASE}/ext/verify-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ binance_order_number: orderNumber, fiat_amount: fiatAmount || 0 }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    if (data.verified) {
      console.log(`[SparkP2P] M-Pesa verified: receipt=${data.mpesa_receipt}, amount=KES ${data.amount_received}, from=${data.payer_name}`);
    } else {
      console.log(`[SparkP2P] M-Pesa NOT verified: ${data.reason}`);
    }
    return data.verified === true;
  } catch (e) {
    console.error('[SparkP2P] verifyMpesaPayment error:', e.message?.substring(0, 60));
    return false;
  }
}

async function pollCycle() {
  if (!pollerRunning || !token || !browser || scanningInProgress) return;
  scanningInProgress = true;

  try {
    // ── Check Binance session ───────────────────────────────
    // Only check after the 30-minute grace period has passed since login
    const sessionAge = sessionStartTime ? Date.now() - sessionStartTime : Infinity;
    if (browserLocked && sessionAge > SESSION_GRACE_MS) {
      if (!(await isLoggedIn())) {
        loggedOutStrikes++;
        console.log(`[SparkP2P] isLoggedIn() returned false (strike ${loggedOutStrikes}/${LOGOUT_STRIKES_NEEDED})`);
        if (loggedOutStrikes < LOGOUT_STRIKES_NEEDED) {
          // Not enough consecutive failures yet — could be a transient navigation glitch
          scanningInProgress = false;
          return;
        }
        // 3 strikes in a row — session is genuinely gone
        console.log('[SparkP2P] Session expired — re-login required');
        loggedOutStrikes = 0;
        sessionStartTime = null;
        stopPoller();
        scanningInProgress = false;
        await unlockChromeBrowser();
        const page = await getPage('binance.com');
        if (page) await page.goto('https://accounts.binance.com/en/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        if (mainWindow) {
          mainWindow.show();
          mainWindow.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("binance-disconnected"))');
        }
        connectingBinance = false;
        connectBinance();
        return;
      } else {
        loggedOutStrikes = 0; // Reset strikes on successful login check
      }
    }

    const page = await getPage();
    if (!page) { scanningInProgress = false; return; }

    console.log(`[SparkP2P] ── POLL #${stats.polls + 1} ──`);

    // ── Step 1: Scan wallet (Funding + Spot) ───────────────
    console.log('[SparkP2P] Step 1: Scanning wallet balances...');
    const balances = await scanWalletBalances(page);
    await uploadBalances(balances);

    // ── Step 2: Check P2P orders ───────────────────────────
    console.log('[SparkP2P] Step 2: Checking P2P orders...');
    const orders = await readOrders();
    stats.orders = orders.sell.length + orders.buy.length;
    console.log(`[SparkP2P] Found: ${orders.sell.length} sell orders, ${orders.buy.length} buy orders`);

    // Report to VPS
    const res = await fetch(`${API_BASE}/ext/report-orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ sell_orders: orders.sell.map(norm), buy_orders: orders.buy.map(norm), cancelled_order_numbers: orders.cancelled || [] }),
    }).catch(() => null);

    // VPS may also request actions (e.g. send message, release)
    if (res?.ok) {
      const { actions } = await res.json().catch(() => ({ actions: [] }));
      for (const a of (actions || [])) await execAction(a);
    }

    // ── Step 2b: Also poll pending-actions for VPS-confirmed releases ──
    // This catches orders where M-Pesa was confirmed via Safaricom C2B callback
    const pendingRes = await fetch(`${API_BASE}/ext/pending-actions`, {
      headers: { 'Authorization': `Bearer ${token}` },
    }).catch(() => null);
    if (pendingRes?.ok) {
      const { actions: pendingActions } = await pendingRes.json().catch(() => ({ actions: [] }));
      for (const a of (pendingActions || [])) {
        if (a.action === 'release') {
          console.log(`[SparkP2P] VPS confirmed M-Pesa payment — releasing order ${a.order_number}`);
          await execAction(a);
        }
      }
    }

    // ── Step 3: Complete paid SELL orders ──────────────────
    // BUY orders are handled manually by the trader
    let releasedCount = 0;
    for (const order of orders.sell) {
      const st = (order.status || '').toLowerCase();
      const isBinancePaid = st.includes('paid') || st.includes('payment received');

      // Check M-Pesa for ALL active sell orders — not just GPT-detected "Paid"
      // This covers cases where GPT misreads the status label
      const verified = await verifyMpesaPayment(order.orderNumber, order.totalPrice);

      if (verified) {
        if (!isBinancePaid) {
          // M-Pesa confirmed but Binance not yet showing "Paid" — wait for buyer to confirm
          console.log(`[SparkP2P] M-Pesa confirmed for ${order.orderNumber} but Binance shows "${order.status}" — waiting for buyer to click "I have paid"`);
          continue;
        }
        console.log(`[SparkP2P] ✅ M-Pesa + Binance both confirmed for ${order.orderNumber} — releasing...`);
        await execAction({ action: 'release', order_number: order.orderNumber, message: null });
        releasedCount++;
      } else if (isBinancePaid) {
        console.log(`[SparkP2P] ⚠️  Order ${order.orderNumber} shows PAID on Binance but M-Pesa NOT confirmed — HOLDING release`);
      }
    }

    // ── Step 4: Rescan wallet if orders were completed ─────
    if (releasedCount > 0) {
      console.log(`[SparkP2P] Step 4: ${releasedCount} order(s) released — rescanning wallet...`);
      await new Promise(r => setTimeout(r, 4000)); // wait for Binance to update balance
      const updatedBalances = await scanWalletBalances(page);
      await uploadBalances(updatedBalances);
    }

    stats.polls++;
    lastActiveTime = Date.now();

    // Heartbeat — keeps "Binance Connected" status alive on dashboard
    fetch(`${API_BASE}/ext/heartbeat`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } }).catch(() => {});

    // Market prices — every 3rd poll
    if (stats.polls % 3 === 0) await readMarketPrices().catch(() => {});

    console.log(`[SparkP2P] Poll complete. Next in ${POLL_INTERVAL / 1000}s`);

  } catch (e) {
    stats.errors++;
    console.error('[SparkP2P] Poll error:', e.message);
  } finally {
    scanningInProgress = false;
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
    // Navigate to the specific order page
    const page = await navigateTo(`https://p2p.binance.com/en/fiatOrder?orderNo=${order_number}`);
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
  const statusMap = { 'pending': 1, 'pending payment': 1, 'paid': 2, 'appeal': 3, 'completed': 4, 'cancelled': 5, 'canceled': 5, 'expired': 6 };
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
