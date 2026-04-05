const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { execFile, execSync } = require('child_process');
const puppeteer = require('puppeteer-core');
const aiScanner = require('./ai-scanner');
const { autoUpdater } = require('electron-updater');

// ── Local control server on port 9223 ───────────────────────
// Lets the Settings panel pause/resume via fetch() — works even in packaged app
http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/pause') {
    pauseNavigation = true;
    scanningInProgress = false;
    await unlockChromeBrowser().catch(() => {});
    console.log('[SparkP2P] Bot PAUSED via local API');
    res.end(JSON.stringify({ ok: true, paused: true }));
  } else if (req.url === '/resume') {
    pauseNavigation = false;
    await lockChromeBrowser().catch(() => {});
    console.log('[SparkP2P] Bot RESUMED via local API');
    res.end(JSON.stringify({ ok: true, paused: false }));
  } else if (req.url === '/status') {
    res.end(JSON.stringify({ paused: pauseNavigation, running: pollerRunning }));
  } else {
    res.end(JSON.stringify({ ok: false }));
  }
}).listen(9223, '127.0.0.1', () => {
  console.log('[SparkP2P] Local control server on http://127.0.0.1:9223');
});

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
const POLL_INTERVAL_IDLE   = 60000; // 1 minute — normal scanning (no active order)
const POLL_INTERVAL_ACTIVE = 20000; // 20 seconds — focused order monitoring

let mainWindow = null;
let tray = null;
let token = null;
let browser = null;
let pollerRunning = false;
let pollTimer = null;
let stats = { polls: 0, actions: 0, errors: 0, orders: 0 };
let traderPin = null;    // Binance fund/trading password — stored in memory only
let totpSecret = null;   // Google Authenticator base32 secret — stored in memory only
let browserLocked = false;
let lockFrameListener = null;
let chromeProcess = null; // Child process reference for killing Chrome on quit
let pauseNavigation = false;    // When true, bot pauses all polling/navigation so user can use Chrome freely
let connectingBinance = false; // Prevents concurrent connectBinance() calls
let scanningInProgress = false; // Prevents concurrent initialScan() calls
let sessionStartTime = null;   // When Binance login was last confirmed
let loggedOutStrikes = 0;      // Consecutive failed isLoggedIn() checks before re-login
let activeOrderNumber = null;  // Order number currently being monitored (null = idle)
let activeOrderFiatAmount = 0; // KES amount of the active order (for M-Pesa verification)
let gmailPage = null;          // Persistent Gmail tab — opened alongside Binance, kept alive
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
let anthropicApiKey = process.env.ANTHROPIC_API_KEY || null;

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
    if (!mainWindow || mainWindow.isDestroyed()) return;
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
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (token) {
      mainWindow.webContents.executeJavaScript(
        `localStorage.setItem("token", ${JSON.stringify(token)})`
      ).catch(() => {});
    }
    captureToken();
  });
  mainWindow.webContents.on('did-navigate-in-page', captureToken);
  // Also poll for token every 5 seconds (catches SPA login) — cleared on window destroy
  const captureInterval = setInterval(captureToken, 5000);
  mainWindow.once('destroyed', () => clearInterval(captureInterval));

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

    const buildTrayMenu = () => Menu.buildFromTemplate([
      { label: 'Open SparkP2P', click: () => mainWindow.show() },
      { type: 'separator' },
      { label: 'Connect Binance', click: () => connectBinance() },
      { type: 'separator' },
      {
        label: pauseNavigation ? '▶ Resume Bot' : '⏸ Pause Bot (free Chrome)',
        click: async () => {
          if (pauseNavigation) {
            pauseNavigation = false;
            await lockChromeBrowser();
            console.log('[SparkP2P] Bot RESUMED via tray');
          } else {
            pauseNavigation = true;
            scanningInProgress = false; // force-exit any running cycle immediately
            await unlockChromeBrowser();
            console.log('[SparkP2P] Bot PAUSED via tray — Chrome is free');
          }
          tray.setContextMenu(buildTrayMenu());
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
    ]);

    tray.setContextMenu(buildTrayMenu());
    tray.on('double-click', () => mainWindow.show());

    // Global shortcut Ctrl+Shift+P — pause/resume bot from anywhere
    globalShortcut.register('CommandOrControl+Shift+P', async () => {
      if (pauseNavigation) {
        pauseNavigation = false;
        await lockChromeBrowser();
        console.log('[SparkP2P] Bot RESUMED via shortcut');
      } else {
        pauseNavigation = true;
        scanningInProgress = false; // force-exit any running cycle immediately
        await unlockChromeBrowser();
        console.log('[SparkP2P] Bot PAUSED via shortcut — Chrome is free');
      }
      tray.setContextMenu(buildTrayMenu());
    });
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

async function openGmailTab() {
  if (!browser) return false;
  try {
    // Reuse existing Gmail tab if already open
    const pages = await browser.pages();
    const existing = pages.find(p => p.url().includes('mail.google.com') || p.url().includes('accounts.google.com/'));
    if (existing) {
      gmailPage = existing;
      const loggedIn = !existing.url().includes('accounts.google.com');
      console.log(`[SparkP2P] Gmail tab found — ${loggedIn ? 'logged in' : 'needs login'}`);
      gmailPage.on('close', () => { gmailPage = null; });
      return loggedIn;
    }
    // Open Gmail tab — always show it, even if login is required
    // The chrome-binance profile starts fresh, user may need to log in once
    gmailPage = await browser.newPage();
    await gmailPage.goto('https://mail.google.com/mail/u/0/#inbox', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    const finalUrl = gmailPage.url();
    const loggedIn = !finalUrl.includes('accounts.google.com') && !finalUrl.includes('/signin');
    console.log(`[SparkP2P] Gmail tab opened — ${loggedIn ? 'logged in' : 'not logged in (user can sign in now)'}`);
    gmailPage.on('close', () => { gmailPage = null; });
    return loggedIn;
  } catch (e) {
    console.error('[SparkP2P] Could not open Gmail tab:', e.message?.substring(0, 60));
    gmailPage = null;
    return false;
  }
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

      // Re-fetch credentials now that we're logged in (ensures Anthropic key is loaded)
      await fetchAndApplyCredentials();

      // Sync cookies immediately — don't block on Gmail
      await syncCookies();
      connectingBinance = false;

      // Open Gmail tab in background — doesn't block connect flow
      // If Chrome profile has Gmail logged in it will be ready for OTP scanning
      openGmailTab().then(ok => {
        if (ok) {
          console.log('[SparkP2P] Gmail ready for OTP scanning');
          syncCookies(); // Re-sync now that Gmail cookies are available
        } else {
          console.log('[SparkP2P] Gmail not detected — open Gmail in Chrome manually if needed');
        }
      }).catch(() => {});

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

async function fetchAndApplyCredentials() {
  if (!token) return;
  try {
    const res = await fetch(`${API_BASE}/traders/desktop-credentials`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) return;
    const { verify_method, fund_password, totp_secret, anthropic_api_key } = await res.json();
    if (verify_method === 'fund_password' && fund_password) {
      traderPin = fund_password;
      console.log('[SparkP2P] Fund password loaded from backend');
    } else if (verify_method === 'totp' && totp_secret) {
      totpSecret = totp_secret.toUpperCase().replace(/\s/g, '');
      console.log('[SparkP2P] TOTP secret loaded from backend');
    }
    if (anthropic_api_key) {
      anthropicApiKey = anthropic_api_key;
      console.log('[SparkP2P] Claude Vision API key loaded from backend');
    }
  } catch (e) {
    console.log('[SparkP2P] Could not fetch credentials:', e.message?.substring(0, 40));
  }
}

async function tryAutoStart() {
  if (!token) return; // Don't do anything until user logs into SparkP2P
  if (browser) return; // Already connected

  await fetchAndApplyCredentials(); // Load PIN or TOTP from backend

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

// Sync cookies (Binance + Gmail) to VPS every 1 minute
setInterval(() => { if (pollerRunning) syncCookies(); }, 60 * 1000);

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
    await page.goto('https://p2p.binance.com/en/advertise/post-new?side=SELL&tradeType=SELL', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
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

  // Step 5: Resume any in-progress orders from before restart
  await resumeInProgressOrders();

  console.log('[SparkP2P] === INITIAL SCAN COMPLETE ===');
  scanningInProgress = false;
}

async function resumeInProgressOrders() {
  if (!token) return;
  try {
    console.log('[SparkP2P] Checking for in-progress orders to resume...');
    const res = await fetch(`${API_BASE}/ext/pending-actions`, {
      headers: { 'Authorization': `Bearer ${token}` },
    }).catch(() => null);
    if (!res?.ok) return;

    const { actions } = await res.json().catch(() => ({ actions: [] }));
    const releaseAction = (actions || []).find(a => a.action === 'release' && a.order_number);
    if (!releaseAction) { console.log('[SparkP2P] No in-progress orders to resume'); return; }

    // Set activeOrderNumber — the poll cycle will route to monitorActiveOrder automatically
    console.log(`[SparkP2P] 🔄 Will resume order ${releaseAction.order_number} on first poll`);
    activeOrderNumber = releaseAction.order_number;
    activeOrderFiatAmount = releaseAction.fiat_amount || 0;
  } catch (e) {
    console.error('[SparkP2P] resumeInProgressOrders error:', e.message?.substring(0, 60));
  }
}

// ═══════════════════════════════════════════════════════════
// COOKIE SYNC (just for VPS to mark as connected)
// ═══════════════════════════════════════════════════════════

async function syncCookies() {
  if (!token || !browser) return;
  try {
    const page = await getPage();
    if (!page) return;

    // Binance cookies
    const cookies = await page.cookies('https://www.binance.com', 'https://p2p.binance.com', 'https://c2c.binance.com');
    const dict = {}, full = [];
    for (const c of cookies) {
      dict[c.name] = c.value;
      full.push({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly });
    }

    // Gmail cookies — read directly from gmailPage tab (most reliable)
    let gmailCookies = null;
    try {
      const gp = gmailPage && !gmailPage.isClosed() ? gmailPage : null;
      if (gp) {
        const gc = await gp.cookies('https://mail.google.com', 'https://accounts.google.com', 'https://google.com');
        // Accept any Google session cookie as proof of login
        if (gc.length > 0 && gc.some(c => ['GMAIL_AT','SID','SSID','__Secure-1PSID','__Secure-3PSID','HSID','APISID'].includes(c.name))) {
          gmailCookies = gc.map(c => ({
            name: c.name, value: c.value, domain: c.domain, path: c.path,
            secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite || 'no_restriction',
          }));
          console.log(`[SparkP2P] Gmail session detected — ${gmailCookies.length} cookies captured`);
        }
      }
    } catch (e) { /* gmailPage not ready — skip */ }

    await fetch(`${API_BASE}/traders/connect-binance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        cookies: dict, cookies_full: full,
        csrf_token: dict.csrftoken || '', bnc_uuid: dict['bnc-uuid'] || '',
        gmail_cookies: gmailCookies,
      }),
    });
    console.log(`[SparkP2P] ${cookies.length} Binance cookies synced${gmailCookies ? `, ${gmailCookies.length} Gmail cookies synced` : ''}`);
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

function scheduleNextPoll(delayMs) {
  if (!pollerRunning) return;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    await pollCycle();
    scheduleNextPoll(activeOrderNumber ? POLL_INTERVAL_ACTIVE : POLL_INTERVAL_IDLE);
  }, delayMs);
}

function startPoller() {
  if (pollerRunning) return;
  pollerRunning = true;
  console.log('[SparkP2P] Bot started');
  scheduleNextPoll(0); // run immediately
}

function stopPoller() {
  pollerRunning = false;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  activeOrderNumber = null;
  activeOrderFiatAmount = 0;
  scanningInProgress = false;
}

async function extractMpesaCodesFromChat(page) {
  if (!anthropicApiKey) {
    console.log('[SparkP2P] No API key — skipping chat M-Pesa extraction');
    return [];
  }
  try {
    // Find all <img> elements in the right half of the viewport (chat panel)
    const chatImgHandles = await page.evaluateHandle(() => {
      const vw = window.innerWidth;
      return Array.from(document.querySelectorAll('img')).filter(img => {
        const r = img.getBoundingClientRect();
        return r.width > 60 && r.height > 60
          && r.left > vw * 0.5
          && r.top >= 0 && r.bottom <= window.innerHeight;
      });
    });

    const imgElements = await chatImgHandles.getProperties();
    const handles = [...imgElements.values()].filter(h => h.asElement());
    console.log(`[SparkP2P] Chat images found: ${handles.length}`);

    for (let i = handles.length - 1; i >= 0; i--) {
      const el = handles[i].asElement();
      try {
        // Click the element directly via JS — triggers React's handler, opens lightbox
        await el.evaluate(node => node.click());
        console.log(`[SparkP2P] Clicked chat image ${i + 1} — waiting for lightbox...`);
        await new Promise(r => setTimeout(r, 2000));

        // Screenshot the full page — lightbox should now be open and full-size
        const enlarged = await page.screenshot({ type: 'jpeg', quality: 95 });
        await takeScreenshot(`chat_image_${i + 1}_enlarged`, page);

        const result = await askVisionForMpesaCode(enlarged.toString('base64'));
        const code = result.mpesa_code;
        console.log(`[SparkP2P] Vision enlarged image ${i + 1}: code=${code} (length=${code ? code.length : 0})`);

        // Close lightbox before next attempt
        await page.keyboard.press('Escape').catch(() => {});
        await new Promise(r => setTimeout(r, 500));

        if (code && /^[A-Z0-9]{10}$/.test(code)) {
          return [code];
        } else if (code) {
          console.log(`[SparkP2P] Rejected code "${code}" — not exactly 10 chars`);
        }
      } catch (e) {
        console.log(`[SparkP2P] Chat image ${i + 1} error: ${e.message?.substring(0, 60)}`);
        await page.keyboard.press('Escape').catch(() => {});
      }
    }

    console.log('[SparkP2P] No M-Pesa code found in chat images');
    return [];
  } catch (e) {
    console.error('[SparkP2P] extractMpesaCodesFromChat error:', e.message?.substring(0, 60));
    return [];
  }
}

async function askVisionForMpesaCode(b64) {
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
            { type: 'text', text: `This is an M-Pesa SMS screenshot showing a conversation.

Find the code for a SENT/outgoing payment only — the message will say:
"XXXXXXXXXX Confirmed. Ksh X,XXX.XX sent to SPARK FREELANCE SOLUTIONS..."

IGNORE any RECEIVED messages (e.g. "You have received Ksh... from KCB").

The code is EXACTLY 10 characters: uppercase letters and digits only (e.g. UD5IZBFOER).
Count every character carefully — must be exactly 10.

Return ONLY valid JSON: {"mpesa_code": "<exactly 10-char code, or null if not found>"}` },
          ],
        }],
      }),
    });
    const data = await resp.json();
    const text = (data.content?.[0]?.text || '').trim()
      .replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    return { mpesa_code: null };
  } catch (e) {
    console.error('[Vision] askVisionForMpesaCode error:', e.message?.substring(0, 60));
    return { mpesa_code: null };
  }
}

async function verifyMpesaPayment(orderNumber, fiatAmount, page = null) {
  if (!token) return false;
  try {
    // Extract M-Pesa codes from the chat panel if page is available
    let mpesaCodes = [];
    if (page) {
      mpesaCodes = await extractMpesaCodesFromChat(page);
    }
    const res = await fetch(`${API_BASE}/ext/verify-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        binance_order_number: orderNumber,
        fiat_amount: fiatAmount || 0,
        mpesa_codes_from_chat: mpesaCodes,
      }),
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
  if (!pollerRunning || !token || !browser || scanningInProgress || pauseNavigation) return;
  scanningInProgress = true;

  try {
    // ── Check Binance session ───────────────────────────────
    const sessionAge = sessionStartTime ? Date.now() - sessionStartTime : Infinity;
    if (browserLocked && sessionAge > SESSION_GRACE_MS) {
      if (!(await isLoggedIn())) {
        loggedOutStrikes++;
        console.log(`[SparkP2P] isLoggedIn() returned false (strike ${loggedOutStrikes}/${LOGOUT_STRIKES_NEEDED})`);
        if (loggedOutStrikes < LOGOUT_STRIKES_NEEDED) {
          scanningInProgress = false;
          return;
        }
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
        loggedOutStrikes = 0;
      }
    }

    const page = await getPage();
    if (!page) { scanningInProgress = false; return; }

    // ── Route: focused order monitoring vs. idle full scan ──
    if (activeOrderNumber) {
      await monitorActiveOrder(page);
    } else {
      await idleScan(page);
    }

    stats.polls++;
    lastActiveTime = Date.now();
    fetch(`${API_BASE}/ext/heartbeat`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } }).catch(() => {});
    if (stats.polls % 5 === 0) await readMarketPrices().catch(() => {});

    const nextIn = (activeOrderNumber ? POLL_INTERVAL_ACTIVE : POLL_INTERVAL_IDLE) / 1000;
    console.log(`[SparkP2P] Poll complete. ${activeOrderNumber ? `Monitoring order ${activeOrderNumber}` : 'Idle'} — next in ${nextIn}s`);

  } catch (e) {
    stats.errors++;
    console.error('[SparkP2P] Poll error:', e.message);
  } finally {
    scanningInProgress = false;
  }
}

// ── Idle full scan — runs when no active order ──────────────────────────────
async function idleScan(page) {
  console.log(`[SparkP2P] ── IDLE SCAN #${stats.polls + 1} ──`);
  if (pauseNavigation) return;

  // ── Step 1: Wallet balances ──────────────────────────────────────────────
  const balances = await scanWalletBalances(page);
  await uploadBalances(balances);
  if (pauseNavigation) return;

  // ── Step 2: Go straight to Processing tab (tab=0) ───────────────────────
  console.log('[SparkP2P] Step 2: Checking active orders (tab=0) with Claude Vision...');
  await page.goto('https://p2p.binance.com/en/fiatOrder?tab=0&page=1',
    { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));
  if (pauseNavigation) return;

  // Vision confirms what's on screen, DOM reads the order list
  await takeScreenshot('idle_scan_orders_tab', page);
  const visionInfo = await analyzePageWithVision(page);
  console.log(`[SparkP2P] Vision sees: ${visionInfo.screen}`);

  const orders = await readOrders();
  stats.orders = orders.sell.length + orders.buy.length;
  console.log(`[SparkP2P] Orders: ${orders.sell.length} sell, ${orders.buy.length} buy, ${orders.cancelled.length} cancelled`);

  // ── Step 3: Check completed/cancelled tab (tab=1) — only when no active orders ──
  if (orders.sell.length === 0 && orders.buy.length === 0) {
    console.log('[SparkP2P] Step 3: No active orders — checking completed tab (tab=1)...');
    await page.goto('https://p2p.binance.com/en/fiatOrder?tab=1&page=1',
      { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));
    if (pauseNavigation) return;
    // Re-read cancelled orders from this tab
    const cancelledOrders = await readOrders();
    orders.cancelled = cancelledOrders.cancelled || [];
  }

  // Report orders to VPS
  const res = await fetch(`${API_BASE}/ext/report-orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({
        sell_orders: orders.sell.map(norm),
        buy_orders: orders.buy.map(norm),
        cancelled_order_numbers: orders.cancelled || [],
        active_order_numbers: activeOrderNumber ? [activeOrderNumber] : [],
      }),
  }).catch(() => null);
  if (res?.ok) {
    const { actions } = await res.json().catch(() => ({ actions: [] }));
    for (const a of (actions || [])) await execAction(a);
  }

  // ── Step 4: If sell orders exist, click each one — already on tab=0 ───────
  if (orders.sell.length > 0) {
    console.log(`[SparkP2P] 🔔 ${orders.sell.length} active sell order(s) detected`);

    for (const order of orders.sell) {
      if (pauseNavigation) break;
      console.log(`[SparkP2P] Processing order ${order.orderNumber} (KES ${order.totalPrice})`);

      // We are already on tab=0 — click directly, no extra navigation
      const clicked = await clickOrderWithMouse(page, order.orderNumber);
      if (!clicked) {
        console.log(`[SparkP2P] Could not click order ${order.orderNumber} — skipping`);
        continue;
      }

      // Wait for order detail page to fully load
      await new Promise(r => setTimeout(r, 5000));
      await takeScreenshot(`order_detail_${order.orderNumber}`, page);

      // Vision retry loop — up to 3 attempts if page returns unknown
      let orderInfo = { screen: 'unknown' };
      for (let attempt = 1; attempt <= 3; attempt++) {
        orderInfo = await analyzePageWithVision(page);
        console.log(`[SparkP2P] Order ${order.orderNumber} vision attempt ${attempt}: ${orderInfo.screen}`);
        if (orderInfo.screen !== 'unknown') break;
        console.log('[SparkP2P] Vision returned unknown — waiting 3s and retrying...');
        await new Promise(r => setTimeout(r, 3000));
        await takeScreenshot(`order_detail_retry${attempt}_${order.orderNumber}`, page);
      }

      if (orderInfo.screen === 'verify_payment') {
        // Buyer has paid — verify M-Pesa before releasing
        console.log(`[SparkP2P] Order ${order.orderNumber} shows VERIFY PAYMENT — checking M-Pesa...`);
        const verified = await verifyMpesaPayment(order.orderNumber, order.totalPrice || orderInfo.fiat_amount_kes, page);
        if (verified) {
          console.log(`[SparkP2P] ✅ M-Pesa confirmed — starting vision release for ${order.orderNumber}`);
          activeOrderNumber = order.orderNumber;
          activeOrderFiatAmount = order.totalPrice;
          // releaseWithVision handles all DOM interactions — no mouse needed
          await releaseWithVision(page, order.orderNumber, { message: 'Payment confirmed. Releasing crypto now.' });
          activeOrderNumber = null;
          activeOrderFiatAmount = 0;
        } else {
          console.log(`[SparkP2P] ⚠️ M-Pesa NOT confirmed for ${order.orderNumber} — holding`);
          activeOrderNumber = order.orderNumber;
          activeOrderFiatAmount = order.totalPrice;
          break;
        }
      } else if (orderInfo.screen === 'awaiting_payment' || orderInfo.screen === 'payment_processing') {
        console.log(`[SparkP2P] Order ${order.orderNumber} awaiting buyer payment — monitoring`);
        activeOrderNumber = order.orderNumber;
        activeOrderFiatAmount = order.totalPrice;
        break;
      } else if (orderInfo.screen === 'order_complete') {
        console.log(`[SparkP2P] Order ${order.orderNumber} already completed`);
      } else if (orderInfo.screen === 'confirm_release_modal' || orderInfo.screen === 'security_verification' ||
                 orderInfo.screen === 'totp_input' || orderInfo.screen === 'email_otp_input' || orderInfo.screen === 'passkey_failed') {
        // Already mid-release — jump straight into vision loop
        console.log(`[SparkP2P] Order ${order.orderNumber} mid-release (${orderInfo.screen}) — continuing with vision`);
        activeOrderNumber = order.orderNumber;
        activeOrderFiatAmount = order.totalPrice;
        await releaseWithVision(page, order.orderNumber, {});
        activeOrderNumber = null;
        activeOrderFiatAmount = 0;
      } else {
        console.log(`[SparkP2P] Order ${order.orderNumber} state: ${orderInfo.screen} — will retry next poll`);
        activeOrderNumber = order.orderNumber;
        activeOrderFiatAmount = order.totalPrice;
        break;
      }
    }
  } else {
    console.log('[SparkP2P] No active orders — staying idle');
  }
}

// ── Click an order row using DOM (reliable, no mouse needed) ─────────────────
async function clickOrderWithMouse(page, orderNumber) {
  await takeScreenshot(`before_click_order_${orderNumber}`, page);

  const found = await page.evaluate((orderNo) => {
    // Strategy 1: <a> tag whose text is exactly or contains the order number
    const links = Array.from(document.querySelectorAll('a'));
    for (const a of links) {
      if (a.textContent.replace(/\s/g, '').includes(orderNo)) {
        a.click();
        return 'order-number-link';
      }
    }
    // Strategy 2: any element whose trimmed text equals the order number
    const all = Array.from(document.querySelectorAll('span, td, div, p'));
    for (const el of all) {
      if (el.children.length === 0 && el.textContent.trim().replace(/\s/g, '') === orderNo) {
        el.click();
        return 'order-number-text';
      }
    }
    // Strategy 3: "Please release" link — click the row containing it
    const releaseEl = Array.from(document.querySelectorAll('a, span, div')).find(
      el => el.textContent.trim() === 'Please release'
    );
    if (releaseEl) {
      releaseEl.click();
      return 'please-release';
    }
    // Strategy 4: first row in the orders table
    const firstRow = document.querySelector('tbody tr td a, table tr:not(:first-child) a');
    if (firstRow) { firstRow.click(); return 'first-row'; }
    return null;
  }, orderNumber);

  if (!found) {
    console.log(`[SparkP2P] Could not find order ${orderNumber} in DOM`);
    return false;
  }
  console.log(`[SparkP2P] Clicked order ${orderNumber} via DOM (${found})`);
  return true;
}

// ── Focused order monitor — runs every 20s while an order is active ─────────
async function navigateToOrderDetail(page, orderNumber) {
  if (pauseNavigation) { console.log('[SparkP2P] Navigation paused — skipping order navigation'); return false; }
  console.log(`[SparkP2P] Navigating to order ${orderNumber} via orders list`);
  await page.goto('https://p2p.binance.com/en/fiatOrder?tab=0&page=1',
    { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

  // Find the element containing the order number and get its screen coordinates
  const box = await page.evaluate((orderNo) => {
    // Look for <a> link or any element whose text contains the order number
    const candidates = [
      ...Array.from(document.querySelectorAll('a')),
      ...Array.from(document.querySelectorAll('span, td, div')),
    ];
    for (const el of candidates) {
      if (el.textContent.replace(/\s/g, '').includes(orderNo)) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
      }
    }
    // Fallback: find "Please release" text
    const releaseEl = Array.from(document.querySelectorAll('*')).find(
      el => el.children.length === 0 && el.textContent.trim() === 'Please release'
    );
    if (releaseEl) {
      const rect = releaseEl.getBoundingClientRect();
      if (rect.width > 0) return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    return null;
  }, orderNumber);

  if (!box) {
    console.error(`[SparkP2P] Could not find order ${orderNumber} on page`);
    return false;
  }

  console.log(`[SparkP2P] Moving mouse to order at (${Math.round(box.x)}, ${Math.round(box.y)}) and clicking`);
  await page.mouse.move(box.x, box.y, { steps: 10 }); // smooth move
  await new Promise(r => setTimeout(r, 300));
  await page.mouse.click(box.x, box.y);
  await new Promise(r => setTimeout(r, 3000));

  const finalUrl = page.url();
  console.log(`[SparkP2P] Now on: ${finalUrl}`);
  return true;
}

async function monitorActiveOrder(page) {
  console.log(`[SparkP2P] ── MONITORING ORDER ${activeOrderNumber} ──`);

  // Navigate to the order detail page via the orders list (DOM click)
  await page.goto('https://p2p.binance.com/en/fiatOrder?tab=0&page=1',
    { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

  const clicked = await clickOrderWithMouse(page, activeOrderNumber);
  if (!clicked) {
    console.log(`[SparkP2P] Order ${activeOrderNumber} not found on orders list — may be complete or cancelled`);
    activeOrderNumber = null;
    activeOrderFiatAmount = 0;
    return;
  }

  // Wait for order detail to load then use Claude Vision
  await new Promise(r => setTimeout(r, 5000));
  await takeScreenshot(`monitor_${activeOrderNumber}`, page);

  // Vision with retry
  let info = { screen: 'unknown' };
  for (let i = 1; i <= 3; i++) {
    info = await analyzePageWithVision(page);
    console.log(`[SparkP2P] Monitor vision attempt ${i}: ${info.screen}`);
    if (info.screen !== 'unknown') break;
    await new Promise(r => setTimeout(r, 3000));
  }

  const screen = info.screen;

  if (screen === 'order_complete') {
    console.log(`[SparkP2P] Order ${activeOrderNumber} COMPLETED`);
    activeOrderNumber = null; activeOrderFiatAmount = 0;
    const balances = await scanWalletBalances(page);
    await uploadBalances(balances);
    return;
  }

  if (screen === 'awaiting_payment' || screen === 'payment_processing') {
    console.log(`[SparkP2P] Order ${activeOrderNumber} still waiting for buyer payment`);
    return; // Keep monitoring next poll
  }

  if (screen === 'verify_payment') {
    console.log(`[SparkP2P] Order ${activeOrderNumber} PAID — verifying M-Pesa...`);
    const verified = await verifyMpesaPayment(activeOrderNumber, activeOrderFiatAmount || info.fiat_amount_kes, page);
    if (verified) {
      console.log(`[SparkP2P] ✅ M-Pesa confirmed — clicking Payment Received`);

      // Close any open lightbox first
      await page.keyboard.press('Escape').catch(() => {});
      await new Promise(r => setTimeout(r, 800));

      // Confirm we are still on the order detail page (lightbox/Escape may have navigated away)
      const currentUrl = page.url();
      console.log(`[SparkP2P] Current URL after verification: ${currentUrl}`);

      if (!currentUrl.includes('fiatOrderDetail')) {
        // We navigated away — go back to orders list and re-click the order
        console.log(`[SparkP2P] Not on order detail — navigating back and clicking order...`);
        await page.goto('https://p2p.binance.com/en/fiatOrder?tab=0&page=1',
          { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 2500));
        const reClicked = await clickOrderWithMouse(page, activeOrderNumber);
        if (!reClicked) {
          console.log(`[SparkP2P] Could not re-click order ${activeOrderNumber}`);
          return;
        }
        await new Promise(r => setTimeout(r, 4000));
      }

      // Click Payment Received directly on the order detail page
      const clicked = await clickButton(page, 'Payment Received', 'payment received');
      console.log(`[SparkP2P] Payment Received clicked: ${clicked}`);
      await new Promise(r => setTimeout(r, 2000));

      // Continue the full release flow (confirm modal, TOTP, email OTP, etc.)
      await releaseWithVision(page, activeOrderNumber, {});
      activeOrderNumber = null; activeOrderFiatAmount = 0;
      const balances = await scanWalletBalances(page);
      await uploadBalances(balances);
    } else {
      console.log(`[SparkP2P] ⚠️ M-Pesa NOT confirmed — holding`);
    }
    return;
  }

  // Mid-release states — jump straight into vision release loop
  if (['confirm_release_modal','passkey_failed','security_verification','totp_input','email_otp_input'].includes(screen)) {
    console.log(`[SparkP2P] Order ${activeOrderNumber} mid-release (${screen}) — continuing`);
    await releaseWithVision(page, activeOrderNumber, {});
    activeOrderNumber = null; activeOrderFiatAmount = 0;
    return;
  }

  // DOM text fallback when vision returns unknown
  const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
  const lower = pageText.toLowerCase();
  if (lower.includes('cancelled') || lower.includes('canceled')) {
    console.log(`[SparkP2P] Order ${activeOrderNumber} CANCELLED`);
    await fetch(`${API_BASE}/ext/report-orders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ sell_orders: [], buy_orders: [], cancelled_order_numbers: [activeOrderNumber] }),
    }).catch(() => {});
    activeOrderNumber = null; activeOrderFiatAmount = 0;
    return;
  }
  if (lower.includes('verify payment') || lower.includes('payment received') || lower.includes('confirm payment')) {
    console.log(`[SparkP2P] DOM text indicates payment received — checking M-Pesa`);
    const verified = await verifyMpesaPayment(activeOrderNumber, activeOrderFiatAmount, page);
    if (verified) {
      await page.keyboard.press('Escape').catch(() => {});
      await new Promise(r => setTimeout(r, 1000));
      await clickButton(page, 'Payment Received', 'payment received');
      await new Promise(r => setTimeout(r, 2000));
      await releaseWithVision(page, activeOrderNumber, {});
      activeOrderNumber = null; activeOrderFiatAmount = 0;
    }
    return;
  }

  console.log(`[SparkP2P] Order ${activeOrderNumber} screen: ${screen} — rechecking next poll`);
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

// ── Screenshots folder — all bot screenshots saved here for review ───────────
const screenshotsDir = path.join(app.getPath('userData'), 'sparkp2p-screenshots');
try { fs.mkdirSync(screenshotsDir, { recursive: true }); } catch (e) {}

async function takeScreenshot(reason, specificPage) {
  const page = specificPage || await getPage();
  if (!page) return null;
  try {
    const buffer = await page.screenshot({ type: 'jpeg', quality: 80, fullPage: false });
    const base64 = buffer.toString('base64');

    // Save to local screenshots folder
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeReason = (reason || 'screenshot').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40);
    const filename = path.join(screenshotsDir, `${ts}_${safeReason}.jpg`);
    try { fs.writeFileSync(filename, buffer); } catch (e) {}

    console.log(`[SparkP2P] Screenshot: ${reason} → ${filename} (${Math.round(buffer.length / 1024)}KB)`);

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
// TOTP — Generate Google Authenticator code from base32 secret
// ═══════════════════════════════════════════════════════════

function generateTOTP(secret) {
  const crypto = require('crypto');
  const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = secret.toUpperCase().replace(/\s|=/g, '');

  // Decode base32 → bytes
  let bits = '';
  for (const ch of clean) {
    const v = BASE32.indexOf(ch);
    if (v === -1) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const keyBytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    keyBytes.push(parseInt(bits.slice(i, i + 8), 2));
  const key = Buffer.from(keyBytes);

  // Counter = floor(unix_seconds / 30)
  const counter = Math.floor(Date.now() / 1000 / 30);
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);

  // HMAC-SHA1 + dynamic truncation
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = hmac[19] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset+1] << 16 | hmac[offset+2] << 8 | hmac[offset+3]) % 1000000;
  return code.toString().padStart(6, '0');
}

// ═══════════════════════════════════════════════════════════
// PIN/PASSKEY ENTRY — Auto-enter security code when Binance asks
// ═══════════════════════════════════════════════════════════

// ── Read email OTP from Gmail (opened in new Chrome tab) ──────────────────────
// ── Read Binance OTP from Gmail — smart version ──────────────────────────────
// • Searches for all recent Binance emails, picks the NEWEST one sent within
//   the last 10 minutes (OTPs expire in 10 min on Binance).
// • If no qualifying email found, returns null so the caller can resend.
// • If multiple emails exist, uses the timestamp to pick the latest one.
async function _readEmailOTPOnce(gmailPage, sentAfterMs) {
  // Search Binance security emails sent in the last hour
  await gmailPage.goto(
    'https://mail.google.com/mail/u/0/#search/from%3Ado-not-reply%40binance.com+subject%3Averification+newer_than%3A1h',
    { waitUntil: 'networkidle2', timeout: 15000 }
  ).catch(() => {});
  await new Promise(r => setTimeout(r, 2500));

  // Collect all email rows with their timestamps
  const emails = await gmailPage.evaluate(() => {
    const rows = document.querySelectorAll('tr.zA');
    return Array.from(rows).map((row, idx) => {
      const timeEl = row.querySelector('td.xW span, td.xW, [data-tooltip]');
      const subjectEl = row.querySelector('span.bog, .y6 span');
      return {
        idx,
        timeText: timeEl?.getAttribute('data-tooltip') || timeEl?.title || timeEl?.innerText || '',
        subject: subjectEl?.innerText || '',
      };
    });
  });

  console.log(`[SparkP2P] Gmail: found ${emails.length} Binance email(s)`);

  if (emails.length === 0) return null;

  // Find the most recent email that was sent AFTER sentAfterMs
  // Gmail timestamps are like "Apr 2, 2026, 3:45 PM" — parse them
  let targetIdx = null;
  const now = Date.now();
  const OTP_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

  for (const email of emails) {
    // Try to parse the tooltip timestamp (full date+time)
    let emailTime = null;
    if (email.timeText) {
      try { emailTime = new Date(email.timeText).getTime(); } catch (_) {}
    }

    // If we can parse the time, check it's within the OTP window
    if (emailTime && !isNaN(emailTime)) {
      const ageMs = now - emailTime;
      if (ageMs <= OTP_MAX_AGE_MS && emailTime >= sentAfterMs) {
        console.log(`[SparkP2P] Found qualifying email (age: ${Math.round(ageMs/1000)}s): "${email.subject}"`);
        targetIdx = email.idx; // first match = newest (Gmail sorts newest first)
        break;
      } else if (ageMs > OTP_MAX_AGE_MS) {
        console.log(`[SparkP2P] Email too old (${Math.round(ageMs/1000)}s), skipping`);
      }
    } else {
      // Can't parse time — fall back to just using the first (newest) email
      // if it arrived after we triggered the send
      if (targetIdx === null) targetIdx = email.idx;
    }
  }

  if (targetIdx === null) {
    console.log('[SparkP2P] No qualifying recent Binance email found');
    return null;
  }

  // Click the selected email
  const clicked = await gmailPage.evaluate((idx) => {
    const rows = document.querySelectorAll('tr.zA');
    if (rows[idx]) { rows[idx].click(); return true; }
    return false;
  }, targetIdx);

  if (!clicked) return null;
  await new Promise(r => setTimeout(r, 2000));

  // Extract 6-digit OTP — look for patterns like "123456" or "Your code is 123456"
  const emailText = await gmailPage.evaluate(() => document.body.innerText).catch(() => '');

  // Match 6-digit code — prefer one near keywords like "code", "verification", "OTP"
  const lines = emailText.split('\n');
  let code = null;
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes('verif') || lower.includes('code') || lower.includes('otp') || lower.includes('security')) {
      const m = line.match(/\b(\d{6})\b/);
      if (m) { code = m[1]; break; }
    }
  }
  // Fallback: any 6-digit number in the body
  if (!code) {
    const m = emailText.match(/\b(\d{6})\b/);
    if (m) code = m[1];
  }

  if (code) {
    console.log(`[SparkP2P] Email OTP extracted: ${code}`);
    return code;
  }
  console.log('[SparkP2P] Could not extract OTP code from email body');
  return null;
}

// ── Main readEmailOTP — with retry + resend logic ─────────────────────────────
// Tries up to MAX_ATTEMPTS times. On each failed attempt it goes back to the
// Binance tab and clicks the resend button before trying Gmail again.
async function readEmailOTP(binancePage = null) {
  if (!browser) return null;
  const MAX_ATTEMPTS = 3;
  const WAIT_FOR_EMAIL_MS = 5000;
  const RESEND_WAIT_MS   = 8000;
  const sentAt = Date.now();

  // Ensure persistent Gmail tab is open — open it now if it was closed
  if (!gmailPage || gmailPage.isClosed()) {
    console.log('[SparkP2P] Gmail tab not open — opening now...');
    await openGmailTab();
  }
  if (!gmailPage) { console.error('[SparkP2P] Could not open Gmail tab'); return null; }

  // If Gmail tab is on login page, wait up to 60s for user to log in
  const gmailUrl = gmailPage.url();
  if (gmailUrl.includes('accounts.google.com') || gmailUrl.includes('/signin')) {
    console.log('[SparkP2P] Gmail not logged in — waiting up to 60s for user to sign in...');
    await gmailPage.bringToFront();
    const loginDeadline = Date.now() + 60000;
    while (Date.now() < loginDeadline) {
      await new Promise(r => setTimeout(r, 2000));
      const url = gmailPage.url();
      if (!url.includes('accounts.google.com') && !url.includes('/signin')) {
        console.log('[SparkP2P] Gmail login detected — proceeding with OTP read');
        break;
      }
    }
    if (gmailPage.url().includes('accounts.google.com')) {
      console.error('[SparkP2P] Gmail login timeout — could not read OTP');
      return null;
    }
  }

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      console.log(`[SparkP2P] Gmail OTP attempt ${attempt}/${MAX_ATTEMPTS}...`);
      await gmailPage.bringToFront();
      await new Promise(r => setTimeout(r, attempt === 1 ? WAIT_FOR_EMAIL_MS : RESEND_WAIT_MS));

      const code = await _readEmailOTPOnce(gmailPage, sentAt);
      if (code) {
        // Switch back to Binance tab before returning
        if (binancePage) await binancePage.bringToFront().catch(() => {});
        return code;
      }

      // No OTP yet — click Resend on Binance then wait again
      if (attempt < MAX_ATTEMPTS && binancePage) {
        console.log('[SparkP2P] OTP not arrived — switching to Binance to resend...');
        await binancePage.bringToFront();
        const resent = await binancePage.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button, span, a')).find(el => {
            const t = el.textContent.trim().toLowerCase();
            return t === 'resend' || t === 'send again' || t === 'get code' || t === 'resend code';
          });
          if (btn) { btn.click(); return true; }
          return false;
        });
        if (resent) console.log('[SparkP2P] Resend clicked');
      }
    }

    console.log('[SparkP2P] All OTP attempts exhausted');
    if (binancePage) await binancePage.bringToFront().catch(() => {});
    return null;
  } catch (e) {
    console.error('[SparkP2P] readEmailOTP error:', e.message?.substring(0, 60));
    if (binancePage) await binancePage.bringToFront().catch(() => {});
    return null;
  }
  // Note: gmailPage stays open — it's a persistent tab
}

// ── Type a 6-digit code using real keyboard events (like a human) ─────────────
// Returns the CSS selector of the input that was focused, or null if not found.
async function _findInputNearLabel(page, labelKeyword) {
  // Returns { type: 'split'|'single', selector: string } or null
  return await page.evaluate((keyword) => {
    const allEls = Array.from(document.querySelectorAll('label, div, span, p, h3, h4'));
    for (const el of allEls) {
      if (!el.textContent.toLowerCase().includes(keyword)) continue;
      // Search up to 6 levels of siblings + parent for inputs
      let node = el;
      for (let depth = 0; depth < 8; depth++) {
        node = node.nextElementSibling || node.parentElement;
        if (!node) break;
        // 6 individual digit boxes (maxlength=1)
        const splitInputs = node.querySelectorAll('input[maxlength="1"]');
        if (splitInputs.length >= 6) {
          // Return selector for first box
          const id = `_sbox_${Date.now()}`;
          splitInputs[0].setAttribute('data-sparkfind', id);
          return { type: 'split', attr: id };
        }
        // Single 6-digit input
        const single = node.querySelector(
          'input[maxlength="6"], input[type="tel"], input[type="number"], input[autocomplete="one-time-code"]'
        );
        if (single) {
          const id = `_sbox_${Date.now()}`;
          single.setAttribute('data-sparkfind', id);
          return { type: 'single', attr: id };
        }
      }
    }
    return null;
  }, labelKeyword);
}

async function enterCodeIntoSection(page, labelKeyword, code) {
  const found = await _findInputNearLabel(page, labelKeyword);
  if (!found) return false;

  if (found.type === 'split') {
    // Re-query all sibling maxlength=1 inputs from the same parent
    const allBoxes = await page.evaluate((attr) => {
      const first = document.querySelector(`[data-sparkfind="${attr}"]`);
      if (!first) return 0;
      first.removeAttribute('data-sparkfind');
      // Collect all maxlength=1 siblings in same container
      const parent = first.parentElement;
      const inputs = parent ? parent.querySelectorAll('input[maxlength="1"]') : [];
      inputs.forEach((inp, i) => inp.setAttribute('data-sparkidx', String(i)));
      return inputs.length;
    }, found.attr);

    for (let i = 0; i < Math.min(6, allBoxes); i++) {
      const inp = await page.$(`[data-sparkidx="${i}"]`);
      if (inp) {
        await inp.click();
        await new Promise(r => setTimeout(r, 40));
        // Clear existing value first, then type the digit
        await inp.evaluate(el => { el.value = ''; });
        await inp.type(String(code[i]), { delay: 60 });
        await new Promise(r => setTimeout(r, 30));
      }
    }
    // Clean up temp attributes
    await page.evaluate(() => {
      document.querySelectorAll('[data-sparkidx]').forEach(el => el.removeAttribute('data-sparkidx'));
    });
    console.log(`[SparkP2P] Typed ${code} into split boxes (${labelKeyword})`);
    return true;

  } else {
    // Single input — click it, clear it, type the whole code
    const inp = await page.$(`[data-sparkfind="${found.attr}"]`);
    if (!inp) return false;
    await inp.click({ clickCount: 3 }); // triple-click to select all
    await new Promise(r => setTimeout(r, 80));
    await inp.evaluate(el => { el.value = ''; });
    await inp.type(code, { delay: 60 });
    await inp.evaluate(el => el.removeAttribute('data-sparkfind'));
    console.log(`[SparkP2P] Typed ${code} into single input (${labelKeyword})`);
    return true;
  }
}

async function handleSecurityVerification(page) {
  await new Promise(r => setTimeout(r, 2000));

  // Detect what Binance is asking for — may be multiple fields
  const verification = await page.evaluate(() => {
    const text = document.body.innerText.toLowerCase();
    const hasEmail = text.includes('email verification') || text.includes('email code') || text.includes('email address');
    const hasAuth = text.includes('authenticator') || text.includes('google auth') || text.includes('authentication code');
    const hasFundPw = text.includes('fund password') || text.includes('trading password');
    const hasPasskey = text.includes('passkey');
    const inputs = document.querySelectorAll('input[maxlength="1"], input[maxlength="6"], input[type="tel"], input[type="password"]');
    return { hasEmail, hasAuth, hasFundPw, hasPasskey, hasAny: inputs.length > 0, inputCount: inputs.length };
  });

  if (!verification.hasAny) {
    console.log('[SparkP2P] No security verification needed');
    return true;
  }

  console.log(`[SparkP2P] Verification needed — email:${verification.hasEmail} auth:${verification.hasAuth} fundpw:${verification.hasFundPw}`);
  await takeScreenshot('Security verification');

  try {
    // ── Google Authenticator ──
    if (verification.hasAuth) {
      if (!totpSecret) {
        console.log('[SparkP2P] TOTP required but not configured');
      } else {
        const code = generateTOTP(totpSecret);
        console.log(`[SparkP2P] TOTP code: ${code}`);
        let entered = await enterCodeIntoSection(page, 'authenticator', code);
        if (!entered) entered = await enterCodeIntoSection(page, 'google', code);
        if (!entered) {
          // Last-resort fallback: type into the first available digit inputs
          const digitInputs = await page.$$('input[maxlength="1"]');
          if (digitInputs.length >= 6) {
            for (let i = 0; i < 6; i++) {
              await digitInputs[i].click();
              await digitInputs[i].evaluate(el => { el.value = ''; });
              await digitInputs[i].type(code[i], { delay: 60 });
              await new Promise(r => setTimeout(r, 30));
            }
            entered = true;
          } else {
            const inp = await page.$('input[maxlength="6"], input[type="tel"], input[autocomplete="one-time-code"]');
            if (inp) {
              await inp.click({ clickCount: 3 });
              await inp.evaluate(el => { el.value = ''; });
              await inp.type(code, { delay: 60 });
              entered = true;
            }
          }
        }
        console.log(`[SparkP2P] TOTP ${entered ? 'entered' : 'FAILED to enter'}`);
      }
    }

    // ── Email OTP — read from Gmail ──
    if (verification.hasEmail) {
      console.log('[SparkP2P] Email OTP required — fetching from Gmail...');
      // Click "Get Code" / "Send Code" if present (triggers the email send)
      const sentCode = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button, a, span')).find(b =>
          /^(send|get code|send code)$/i.test(b.textContent.trim())
        );
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (sentCode) console.log('[SparkP2P] Clicked Send Code button');
      // readEmailOTP handles waiting, retrying, and auto-resend automatically
      const emailCode = await readEmailOTP(page);
      if (emailCode) {
        let entered = await enterCodeIntoSection(page, 'email', emailCode);
        if (!entered) {
          // Fallback: type into digit inputs after any TOTP inputs
          const allDigitInputs = await page.$$('input[maxlength="1"]');
          const start = verification.hasAuth ? 6 : 0;
          for (let i = 0; i < 6 && (start + i) < allDigitInputs.length; i++) {
            await allDigitInputs[start + i].click();
            await allDigitInputs[start + i].evaluate(el => { el.value = ''; });
            await allDigitInputs[start + i].type(emailCode[i], { delay: 60 });
            await new Promise(r => setTimeout(r, 30));
          }
          entered = true;
        }
        console.log(`[SparkP2P] Email OTP ${entered ? 'entered' : 'FAILED to enter'}`);
      } else {
        console.log('[SparkP2P] Could not get email OTP — manual intervention needed');
        await takeScreenshot('Email OTP required — manual needed');
        return false;
      }
    }

    // ── Fund Password ──
    if (verification.hasFundPw && traderPin) {
      const inp = await page.$('input[type="password"]');
      if (inp) {
        await inp.click({ clickCount: 3 });
        await inp.evaluate(el => { el.value = ''; });
        await inp.type(traderPin, { delay: 40 });
      }
      console.log('[SparkP2P] Fund password entered');
    }

    // Passkey — cannot automate
    if (verification.hasPasskey && !verification.hasAuth && !verification.hasEmail) {
      console.log('[SparkP2P] Passkey required — cannot automate');
      await takeScreenshot('Passkey required');
      return false;
    }

    // ── Submit — try clicking the button, then press Enter as backup ──
    await new Promise(r => setTimeout(r, 600));
    const btnClicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => {
        const t = b.textContent.toLowerCase().trim();
        return t === 'confirm' || t === 'submit' || t === 'verify' || t === 'next' || t === 'continue';
      });
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!btnClicked) {
      // No button found — press Enter on keyboard (works on most forms)
      console.log('[SparkP2P] No submit button found — pressing Enter');
      await page.keyboard.press('Enter');
    }

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
// CLICK HELPER — Find and click buttons by text, AI fallback
// ═══════════════════════════════════════════════════════════

async function clickButton(page, ...textOptions) {
  // First try: direct text matching (fast, no API cost)
  const clicked = await page.evaluate((options) => {
    for (const text of options) {
      const btn = Array.from(document.querySelectorAll('button, a[role="button"], [class*="btn"], [role="button"]')).find(b => {
        const t = (b.textContent || '').toLowerCase().trim();
        return t === text.toLowerCase() || t.includes(text.toLowerCase());
      });
      if (btn) { btn.click(); return text; }
    }
    return null;
  }, textOptions);

  if (clicked) { console.log(`[SparkP2P] Clicked: "${clicked}"`); return true; }

  // AI fallback: take screenshot, ask AI to identify the button and give us its exact text
  console.log(`[SparkP2P] Button not found by text (${textOptions[0]}...) — asking AI`);
  try {
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 70 });
    const aiResult = await aiScanner.analyzeScreenshot(screenshot, `
      I am looking for a clickable button on this Binance page.
      I need to click a button related to: "${textOptions.join('" or "')}"
      List ALL visible buttons on the page and tell me which one I should click.
      {
        "target_button_text": "exact full text of the button I should click, or null if not found",
        "all_buttons": ["list of all visible button texts"]
      }
    `);
    if (aiResult?.target_button_text) {
      const aiClicked = await page.evaluate((btnText) => {
        const btn = Array.from(document.querySelectorAll('button, a[role="button"], [class*="btn"], [role="button"]'))
          .find(b => (b.textContent || '').trim().toLowerCase() === btnText.toLowerCase());
        if (btn) { btn.click(); return true; }
        return false;
      }, aiResult.target_button_text);
      if (aiClicked) {
        console.log(`[SparkP2P] AI found and clicked: "${aiResult.target_button_text}"`);
        return true;
      }
    }
    if (aiResult?.all_buttons?.length) {
      console.log(`[SparkP2P] AI visible buttons: ${aiResult.all_buttons.slice(0, 8).join(' | ')}`);
    }
  } catch (e) { /* AI unavailable — not critical */ }

  return false;
}

// ── Send a chat message on an order page ────────────────────────────────────
async function sendChatMessage(page, message) {
  // Scroll to bottom first — chat is usually at the bottom of the order page

  // Scroll to bottom where chat usually is
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise(r => setTimeout(r, 800));

  // Try known chat input selectors
  const chatInput = await page.$(
    'textarea[placeholder], ' +
    'input[placeholder*="message" i], ' +
    'input[placeholder*="type" i], ' +
    'input[placeholder*="send" i], ' +
    '[contenteditable="true"][class*="chat" i], ' +
    '[contenteditable="true"][class*="input" i], ' +
    '[contenteditable="true"]'
  );

  if (chatInput) {
    await chatInput.click();
    await new Promise(r => setTimeout(r, 300));
    await chatInput.type(message, { delay: 30 });
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 800));
    console.log(`[SparkP2P] Chat message sent: "${message.substring(0, 60)}"`);
    return true;
  }
  console.log('[SparkP2P] Chat input not found');
  return false;
}

// ═══════════════════════════════════════════════════════════
// CLAUDE VISION — Screenshot-based page analysis
// ═══════════════════════════════════════════════════════════

const VISION_PROMPT = `You are analyzing a Binance P2P order page screenshot.
Extract ALL data with perfect precision and identify the exact screen state.

Return ONLY a valid JSON object — no markdown, no explanation, no code fences.

{
  "screen": "<orders_list|awaiting_payment|payment_processing|verify_payment|confirm_release_modal|passkey_failed|security_verification|totp_input|email_otp_input|order_complete|unknown>",
  "order_number": "<exact order number string or null>",
  "buyer_name": "<exact full name or null>",
  "fiat_amount_kes": <KES amount as plain number e.g. 1000.00 — NEVER add zeros>,
  "usdt_amount": <USDT amount as plain number e.g. 7.71 — read character by character>,
  "countdown_timer": "<e.g. 13:32 or null>",
  "verification_progress": "<e.g. 0/2 or 1/2 or null>",
  "pending_verifications": [],
  "completed_verifications": [],
  "buttons_visible": [],
  "passkeys_not_available_visible": false,
  "checkbox_visible": false,
  "checkbox_checked": false,
  "input_field_visible": false,
  "sale_successful": false,
  "error_message": "<any error text visible or null>"
}

CRITICAL NUMBER RULES — read every digit individually:
- "7.71 USDT" → usdt_amount: 7.71   (NOT 7710, NOT 7000, NOT 771)
- "1,000.00 KES" → fiat_amount_kes: 1000.00
- Commas are thousand separators, periods are decimal points

Screen identification rules:
- Table of orders with columns "Type/Date", "Order number", "Price", "Fiat / Crypto Amount", "Counterparty", "Status" → orders_list
- "Please release" or "Appeal" status links in a table row → orders_list
- "Awaiting Buyer's Payment" with countdown timer → awaiting_payment
- "Payment Processing" or "Processing Payment" or "Verifying Payment" or loading spinner with no action buttons → payment_processing
- "Verify Payment" or "Payment Received" button visible → verify_payment
- Modal saying "Received payment in your account?" with checkbox → confirm_release_modal
- Modal saying "Verify with passkey" with "Verification failed" → passkey_failed
- Modal saying "Security Verification Requirements" with 0/2 or 1/2 → security_verification
- Input box specifically for Authenticator App code → totp_input
- Input box specifically for Email verification code → email_otp_input
- "Order Completed" or "Sale Successful" or "Released" → order_complete`;

async function analyzePageWithVision(page) {
  if (!anthropicApiKey) {
    console.log('[Vision] No Anthropic API key — skipping vision analysis');
    return { screen: 'unknown' };
  }
  try {
    const raw = await page.screenshot({ type: 'jpeg', quality: 85 });
    const b64 = raw.toString('base64');
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
            { type: 'text', text: VISION_PROMPT },
          ],
        }],
      }),
    });
    const data = await resp.json();
    let text = (data.content?.[0]?.text || '').trim()
      .replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const result = JSON.parse(match[0]);
      console.log(`[Vision] screen=${result.screen} usdt=${result.usdt_amount} kes=${result.fiat_amount_kes}`);
      return result;
    }
    return { screen: 'unknown' };
  } catch (e) {
    console.error('[Vision] analyzePageWithVision error:', e.message?.substring(0, 80));
    return { screen: 'unknown' };
  }
}

async function releaseWithVision(page, orderNumber, action) {
  const MAX_STEPS = 20;
  let step = 0;

  console.log(`[Vision] Starting vision-driven release for order ${orderNumber}`);

  try {
    await navigateToOrderDetail(page, orderNumber);
    await new Promise(r => setTimeout(r, 1500));

    // Send pre-release chat message if provided
    if (action.message) await sendChatMessage(page, action.message);

    while (step < MAX_STEPS) {
      // Stop immediately if user paused the bot
      if (pauseNavigation) {
        console.log('[Vision] Bot paused by user — halting vision loop');
        return { success: false, error: 'paused' };
      }
      step++;
      const info = await analyzePageWithVision(page);
      const screen = info.screen || 'unknown';
      console.log(`[Vision] Step ${step}/${MAX_STEPS} | ${screen}`);

      // ── Order complete ──────────────────────────────────────
      if (screen === 'order_complete' || info.sale_successful) {
        console.log(`[Vision] Order ${orderNumber} released successfully!`);
        await fetch(`${API_BASE}/ext/report-release`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ order_number: orderNumber, success: true }),
        }).catch(() => {});
        return { success: true };
      }

      // ── Awaiting payment — poll until buyer pays ────────────
      if (screen === 'awaiting_payment') {
        console.log('[Vision] Awaiting buyer payment — polling in 15s...');
        await new Promise(r => setTimeout(r, 15000));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      // ── Payment processing — Binance verifying payment ──────
      if (screen === 'payment_processing') {
        console.log('[Vision] Payment processing — waiting 8s for Binance to complete...');
        await new Promise(r => setTimeout(r, 8000));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      // ── Verify payment — click Payment Received ─────────────
      if (screen === 'verify_payment') {
        await clickButton(page, 'Payment Received', 'payment received');
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // ── Confirm release modal — checkbox + Confirm Release ──
      if (screen === 'confirm_release_modal') {
        if (info.checkbox_visible && !info.checkbox_checked) {
          const cb = await page.$('input[type="checkbox"]');
          if (cb) { await cb.click(); await new Promise(r => setTimeout(r, 800)); }
        }
        await clickButton(page, 'Confirm Release', 'Confirm release', 'Confirm');
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // ── Passkey failed — skip to alternative method ─────────
      if (screen === 'passkey_failed') {
        await clickButton(page, 'My Passkeys Are Not Available', 'Passkeys Are Not Available', 'Use another method');
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // ── Security verification selector ──────────────────────
      if (screen === 'security_verification') {
        const pending = info.pending_verifications || [];
        const completed = info.completed_verifications || [];
        if (pending.includes('Authenticator App')) {
          await clickButton(page, 'Authenticator App', 'Authenticator');
        } else if (pending.includes('Email') && completed.includes('Authenticator App')) {
          await clickButton(page, 'Email');
        }
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // ── TOTP input — generate via pyotp equivalent ──────────
      if (screen === 'totp_input') {
        if (!totpSecret) {
          console.error('[Vision] TOTP required but not configured');
          return { success: false, error: 'TOTP not configured' };
        }
        const code = generateTOTP(totpSecret);
        console.log(`[Vision] Auto-filling TOTP: ${code}`);
        let entered = await enterCodeIntoSection(page, 'authenticator', code);
        if (!entered) entered = await enterCodeIntoSection(page, 'google', code);
        if (!entered) {
          const inp = await page.$('input[maxlength="6"], input[type="tel"]');
          if (inp) { await inp.click({ clickCount: 3 }); await inp.type(code, { delay: 50 }); }
        }
        await clickButton(page, 'Confirm', 'Submit', 'Verify');
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // ── Email OTP — switch to Gmail tab, scan, switch back ──
      if (screen === 'email_otp_input') {
        // Trigger the OTP email send
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button, span, a')).find(el =>
            /^(send|get code|send code)$/i.test(el.textContent.trim())
          );
          if (btn) btn.click();
        });
        await new Promise(r => setTimeout(r, 1000));

        console.log('[Vision] Email OTP needed — switching to Gmail tab...');
        const emailCode = await readEmailOTP(page);
        if (!emailCode) {
          console.error('[Vision] Email OTP not found in Gmail');
          return { success: false, error: 'Email OTP not found' };
        }
        console.log(`[Vision] Got OTP ${emailCode} — switching back to Binance tab`);
        await page.bringToFront();
        let entered = await enterCodeIntoSection(page, 'email', emailCode);
        if (!entered) {
          const digitInputs = await page.$$('input[maxlength="1"]');
          const start = (info.completed_verifications || []).includes('Authenticator App') ? 6 : 0;
          for (let i = 0; i < 6 && (start + i) < digitInputs.length; i++) {
            await digitInputs[start + i].click();
            await digitInputs[start + i].type(emailCode[i], { delay: 50 });
          }
        }
        await clickButton(page, 'Confirm', 'Submit', 'Verify');
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // ── Unknown — check if we drifted off the order detail page ────────────
      const unknownUrl = page.url();
      console.log(`[Vision] Unknown screen at step ${step} — URL: ${unknownUrl}`);

      if (!unknownUrl.includes('fiatOrderDetail')) {
        // We are not on the order detail page — navigate back
        console.log(`[Vision] Not on order detail page — navigating back to order ${orderNumber}`);
        await page.goto('https://p2p.binance.com/en/fiatOrder?tab=0&page=1',
          { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 2500));
        await clickOrderWithMouse(page, orderNumber);
        await new Promise(r => setTimeout(r, 4000));
        continue;
      }

      // Still on the right page — just reload and retry Vision
      console.log(`[Vision] On order page but Vision confused — reloading...`);
      await new Promise(r => setTimeout(r, 3000));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await new Promise(r => setTimeout(r, 3000));
    }

    console.error(`[Vision] Order ${orderNumber} exceeded ${MAX_STEPS} steps`);
    return { success: false, error: `Exceeded ${MAX_STEPS} steps` };

  } catch (e) {
    console.error('[Vision] releaseWithVision error:', e.message?.substring(0, 80));
    return { success: false, error: e.message };
  }
}

// ═══════════════════════════════════════════════════════════
// ACTION EXECUTION — Full automation with PIN + screenshots
// ═══════════════════════════════════════════════════════════

async function execAction(action) {
  const { action: type, order_number } = action;
  console.log(`[SparkP2P] Executing: ${type} for order ${order_number}`);

  try {
    // For release, let releaseWithVision handle navigation (uses fiatOrderDetail URL)
    // For other actions, navigate to order page first
    const orderUrl = type === 'release'
      ? `https://p2p.binance.com/en/fiatOrderDetail?orderNo=${order_number}`
      : `https://p2p.binance.com/en/fiatOrderDetail?orderNo=${order_number}`;
    const page = await navigateTo(orderUrl);
    if (!page) return;
    await takeScreenshot(`Before ${type}: order ${order_number}`);

    if (type === 'release') {
      // Vision-driven release — Claude reads every screenshot and decides the next action
      const result = await releaseWithVision(page, order_number, action);
      if (result.success) stats.actions++;
      await takeScreenshot(`After release: order ${order_number}`);

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
ipcMain.handle('unlock-browser', async () => { await unlockChromeBrowser(); console.log('[SparkP2P] Browser manually unlocked'); return { ok: true }; });
ipcMain.handle('lock-browser', async () => { const p = await getPage(); if (p) await lockChromeBrowser(); return { ok: true }; });
ipcMain.handle('pause-navigation', async () => { pauseNavigation = true; scanningInProgress = false; await unlockChromeBrowser(); console.log('[SparkP2P] Navigation PAUSED — Chrome is free'); return { ok: true }; });
ipcMain.handle('resume-navigation', async () => { pauseNavigation = false; await lockChromeBrowser(); console.log('[SparkP2P] Navigation RESUMED'); return { ok: true }; });
ipcMain.handle('open-gmail-tab', async () => {
  // If Chrome is not running yet, launch it to Gmail directly
  if (!browser) {
    const chrome = findChrome();
    if (!chrome) return { opened: false, error: 'Chrome not found' };
    await launchChrome('https://mail.google.com/mail/u/0/#inbox');
    await connectPuppeteer();
    if (!browser) return { opened: false, error: 'Could not connect to Chrome' };
  }
  const ok = await openGmailTab();
  if (ok) syncCookies();
  return { opened: true, loggedIn: ok };
});
ipcMain.handle('set-token', (_, t) => { token = t; return { ok: true }; });
ipcMain.handle('set-pin', (_, pin) => { traderPin = pin; console.log('[SparkP2P] Fund password configured'); return { ok: true }; });
ipcMain.handle('set-totp-secret', (_, secret) => { totpSecret = secret ? secret.toUpperCase().replace(/\s/g, '') : null; console.log('[SparkP2P] TOTP secret configured'); return { ok: true }; });
ipcMain.handle('set-ai-key', (_, key) => { aiApiKey = key; aiScanner.initAI(key); console.log('[SparkP2P] GPT-4o configured'); return { ok: true }; });
ipcMain.handle('set-anthropic-key', (_, key) => { anthropicApiKey = key; console.log('[SparkP2P] Claude Vision configured'); return { ok: true }; });
ipcMain.handle('get-bot-status', () => ({ running: pollerRunning, stats, hasPin: !!traderPin, hasTOTP: !!totpSecret, hasAI: !!aiApiKey, hasVision: !!anthropicApiKey }));
ipcMain.handle('take-screenshot', async () => { const ss = await takeScreenshot('Manual request'); return { screenshot: ss }; });
ipcMain.handle('run-ai-scan', async () => { await aiScan(); return { ok: true }; });
ipcMain.handle('restart-app', () => { autoUpdater.quitAndInstall(); });
