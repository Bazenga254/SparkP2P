const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, clipboard, safeStorage } = require('electron');
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
    await unlockChromeBrowser().catch(() => {}); // Give user access to Chrome
    startPauseInactivityTimer();
    console.log('[SparkP2P] Bot PAUSED — Chrome unlocked for manual use, auto-resume in 30s');
    res.end(JSON.stringify({ ok: true, paused: true }));
  } else if (req.url === '/resume') {
    pauseNavigation = false;
    clearPauseInactivityTimer();
    await lockChromeBrowser().catch(() => {}); // Bot takes Chrome back
    mainWindow?.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("bot-resumed"))').catch(() => {});
    console.log('[SparkP2P] Bot RESUMED — Chrome locked back to bot');
    res.end(JSON.stringify({ ok: true, paused: false }));
  } else if (req.url === '/status') {
    res.end(JSON.stringify({ paused: pauseNavigation, running: pollerRunning, version: app.getVersion() }));
  } else {
    res.end(JSON.stringify({ ok: false }));
  }
}).listen(9223, '127.0.0.1', () => {
  console.log('[SparkP2P] Local control server on http://127.0.0.1:9223');
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Another instance is already running — kill it and retry after 2s
    console.log('[SparkP2P] Port 9223 in use — killing old instance and retrying...');
    const { exec } = require('child_process');
    const killCmd = process.platform === 'win32'
      ? 'for /f "tokens=5" %a in (\'netstat -aon ^| findstr :9223\') do taskkill /F /PID %a'
      : 'fuser -k 9223/tcp';
    exec(killCmd, () => {});
  } else {
    console.error('[SparkP2P] Local server error:', err.message);
  }
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
let activeOrderNumber = null;     // Sell order currently being monitored (null = idle)
let activeOrderFiatAmount = 0;    // KES amount of the active sell order
let activeBuyOrderNumber = null;  // Buy order waiting for seller to release crypto (null = not waiting)
let buyPaymentTime = null;        // Timestamp when we sent the I&M payment
let buyReminderSent = false;      // Whether the 10-min reminder has been sent to seller
let buyOrderDetails = null;       // { sellerName, amount, phone, method, orderNumber } for chat messages
let buyPaymentScreenshot = null;  // Base64 screenshot of I&M success — uploaded to Binance chat
let gmailPage = null;          // Persistent Gmail tab — opened alongside Binance, kept alive
let imPage = null;             // Persistent I&M Bank tab — new tab in the main Binance browser
let connectingIm = false;      // Prevents concurrent connectIm() calls
let imWithdrawalRunning = false; // Prevents concurrent withdrawal executions
let mpesaOrgPage = null;       // Persistent M-PESA org portal tab
let connectingMpesa = false;   // Prevents concurrent connectMpesaPortal() calls
let mpesaSweepRunning = false; // Prevents concurrent sweep executions
let pauseInactivityTimer = null; // Auto-resume timer when bot is paused
const PAUSE_AUTO_RESUME_MS = 30 * 1000; // 30 seconds

function startPauseInactivityTimer() {
  clearPauseInactivityTimer();
  pauseInactivityTimer = setTimeout(async () => {
    if (!pauseNavigation) return; // already resumed
    console.log('[SparkP2P] 30s inactivity while paused — auto-resuming and locking all screens');
    pauseNavigation = false;
    await lockChromeBrowser().catch(() => {});
    mainWindow?.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("bot-resumed", { detail: { reason: "inactivity" } }))').catch(() => {});
  }, PAUSE_AUTO_RESUME_MS);
}

function clearPauseInactivityTimer() {
  if (pauseInactivityTimer) { clearTimeout(pauseInactivityTimer); pauseInactivityTimer = null; }
}

// Any mouse/keyboard activity on the Electron window resets the 30s timer
function resetPauseTimerOnActivity() {
  if (pauseNavigation && pauseInactivityTimer) {
    startPauseInactivityTimer(); // reset the 30s countdown
  }
}
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

// Persist Anthropic API key to disk — survives restarts without needing backend fetch
const ANTHROPIC_KEY_FILE = path.join(app.getPath('userData'), 'anthropic_key.json');
function saveAnthropicKey(key) {
  try { fs.writeFileSync(ANTHROPIC_KEY_FILE, JSON.stringify({ key }), 'utf8'); } catch (_) {}
}
function loadAnthropicKey() {
  try {
    const data = JSON.parse(fs.readFileSync(ANTHROPIC_KEY_FILE, 'utf8'));
    if (data?.key) { anthropicApiKey = data.key; console.log('[SparkP2P] Anthropic API key loaded from disk'); }
  } catch (_) {}
}
loadAnthropicKey(); // Load immediately on startup

// ── I&M Bank PIN — stored ONLY on this device using OS-level encryption ──
// Uses Electron safeStorage (Windows Credential Store / macOS Keychain).
// The PIN never leaves this machine and cannot be decrypted on any other device.
let imPin = null;
const IM_PIN_FILE = path.join(app.getPath('userData'), 'im_pin.enc');
function saveImPin(pin) {
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage not available');
    const encrypted = safeStorage.encryptString(pin);
    fs.writeFileSync(IM_PIN_FILE, encrypted);
    imPin = pin;
    console.log('[SparkP2P] I&M PIN saved securely on this device');
  } catch (e) { console.error('[SparkP2P] Failed to save I&M PIN:', e.message); }
}
function loadImPin() {
  try {
    if (!fs.existsSync(IM_PIN_FILE)) return;
    if (!safeStorage.isEncryptionAvailable()) return;
    const encrypted = fs.readFileSync(IM_PIN_FILE);
    imPin = safeStorage.decryptString(encrypted);
    console.log('[SparkP2P] I&M PIN loaded from secure storage');
  } catch (e) { console.error('[SparkP2P] Failed to load I&M PIN:', e.message); }
}
function clearImPin() {
  try { fs.unlinkSync(IM_PIN_FILE); } catch (_) {}
  imPin = null;
}
// Load PIN on startup (after app is ready — safeStorage requires app to be ready)
app.whenReady().then(() => loadImPin());
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
  aiScanner.initAI(anthropicApiKey);
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

  // Disable cache so frontend updates are always picked up immediately
  mainWindow.webContents.session.clearCache().catch(() => {});

  const loadDashboard = (attempt = 1) => {
    mainWindow.loadURL(DASHBOARD_URL + '?v=' + Date.now()).catch(() => {});
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
  // Reset pause inactivity timer on any user activity in the app window
  mainWindow.webContents.on('before-input-event', () => resetPauseTimerOnActivity());
  mainWindow.on('focus', () => resetPauseTimerOnActivity());

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
        label: pauseNavigation ? '▶ Resume Bot' : '⏸ Pause Bot',
        click: async () => {
          if (pauseNavigation) {
            pauseNavigation = false;
            clearPauseInactivityTimer();
            await lockChromeBrowser();
            console.log('[SparkP2P] Bot RESUMED via tray');
          } else {
            pauseNavigation = true;
            scanningInProgress = false; // force-exit any running cycle immediately
            await unlockChromeBrowser();
            startPauseInactivityTimer();
            console.log('[SparkP2P] Bot PAUSED via tray — Chrome unlocked for manual use');
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
        clearPauseInactivityTimer();
        await lockChromeBrowser();
        console.log('[SparkP2P] Bot RESUMED via shortcut');
      } else {
        pauseNavigation = true;
        scanningInProgress = false; // force-exit any running cycle immediately
        await unlockChromeBrowser();
        startPauseInactivityTimer();
        console.log('[SparkP2P] Bot PAUSED via shortcut — Chrome unlocked for manual use');
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

async function verifyGmailWithVision(page) {
  if (!anthropicApiKey) {
    // Fallback to URL check if no Vision key yet
    const url = page.url();
    return url.includes('mail.google.com') && !url.includes('accounts.google.com') && !url.includes('/signin');
  }
  try {
    const ss = await page.screenshot({ encoding: 'base64' });
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 50,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ss } },
          { type: 'text', text: 'Is this a Gmail inbox showing emails (logged in)? Or is it a Google sign-in/login page? Reply with only: LOGGED_IN or LOGIN_PAGE' },
        ]}],
      }),
    });
    const data = await response.json();
    const verdict = (data.content?.[0]?.text || '').trim().toUpperCase();
    console.log(`[SparkP2P] Gmail Vision check: ${verdict}`);
    return verdict === 'LOGGED_IN';
  } catch (e) {
    return false;
  }
}

async function onGmailConfirmed() {
  // Called once Vision confirms Gmail inbox is visible
  console.log('[SparkP2P] Gmail login confirmed! Syncing cookies...');
  await syncCookies();
  mainWindow.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("gmail-connected"))').catch(() => {});
  // Wait for Gmail to finish loading before locking — injecting too early lets Gmail's own JS remove the overlay
  if (gmailPage && !gmailPage.isClosed()) {
    console.log('[SparkP2P] Waiting for Gmail to finish loading before locking...');
    await gmailPage.waitForNetworkIdle({ idleTime: 1500, timeout: 10000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1000)); // extra 1s buffer
  }
  // Lock ALL bot-controlled tabs (sets browserLocked = true)
  await lockChromeBrowser().catch(() => {});
  console.log('[SparkP2P] Gmail locked successfully');
  // Re-check setup completeness
  const setup = await checkSetupComplete();
  if (setup.complete && !pollerRunning) {
    pauseNavigation = false;
    mainWindow.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("setup-complete"))').catch(() => {});
    console.log('[SparkP2P] All connections established — bot ready to start');
  }
}

async function openGmailTab() {
  if (!browser) return false;
  try {
    // Reuse existing Gmail tab if already open
    const pages = await browser.pages();
    const existing = pages.find(p => p.url().includes('mail.google.com') || p.url().includes('accounts.google.com/'));
    if (existing) {
      gmailPage = existing;
      gmailPage.on('close', () => { gmailPage = null; });
      // Vision-verify the existing tab
      const loggedIn = await verifyGmailWithVision(existing);
      console.log(`[SparkP2P] Gmail tab found — ${loggedIn ? 'confirmed logged in' : 'on login page'}`);
      if (loggedIn) { await onGmailConfirmed(); return true; }
      // Not logged in — start polling for login
      startGmailLoginPoller();
      return false;
    }
    // Open Gmail tab fresh
    gmailPage = await browser.newPage();
    await gmailPage.goto('https://mail.google.com/mail/u/0/#inbox', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    gmailPage.on('close', () => { gmailPage = null; });
    const loggedIn = await verifyGmailWithVision(gmailPage);
    console.log(`[SparkP2P] Gmail tab opened — ${loggedIn ? 'confirmed logged in' : 'needs login'}`);
    if (loggedIn) { await onGmailConfirmed(); return true; }
    // Not logged in — poll until user signs in
    startGmailLoginPoller();
    return false;
  } catch (e) {
    console.error('[SparkP2P] Could not open Gmail tab:', e.message?.substring(0, 60));
    gmailPage = null;
    return false;
  }
}

let gmailLoginPollTimer = null;
function startGmailLoginPoller() {
  if (gmailLoginPollTimer) return; // already polling
  let attempts = 0;
  let verifying = false;
  console.log('[SparkP2P] Waiting for Gmail login...');
  gmailLoginPollTimer = setInterval(async () => {
    attempts++;
    if (attempts > 600) { clearInterval(gmailLoginPollTimer); gmailLoginPollTimer = null; return; } // 10 min
    if (!gmailPage || gmailPage.isClosed()) { clearInterval(gmailLoginPollTimer); gmailLoginPollTimer = null; return; }
    if (verifying) return;
    verifying = true;
    try {
      const loggedIn = await verifyGmailWithVision(gmailPage);
      if (loggedIn) {
        clearInterval(gmailLoginPollTimer);
        gmailLoginPollTimer = null;
        await onGmailConfirmed();
      }
    } catch (e) {}
    verifying = false;
  }, 3000);
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
  // Bypass CSP in case the page blocks our script
  await page.setBypassCSP(true).catch(() => {});

  const result = await page.evaluate(() => {
    try {
      if (document.getElementById('sparkp2p-browser-lock')) return { ok: true, existing: true };

      const inject = () => {
        if (document.getElementById('sparkp2p-browser-lock')) return;
        const dlg = document.createElement('dialog');
        dlg.id = 'sparkp2p-browser-lock';
        dlg.style.cssText = [
          'position:fixed', 'inset:0', 'width:100vw', 'height:100vh',
          'background:transparent', 'border:none', 'padding:0', 'margin:0',
          'max-width:100vw', 'max-height:100vh',
          'pointer-events:all', 'cursor:not-allowed', 'outline:none',
          'z-index:2147483647',
        ].join('!important;') + '!important';
        dlg.innerHTML = `
          <div style="position:fixed;bottom:16px;right:16px;display:flex;align-items:center;gap:8px;padding:8px 14px;background:rgba(0,0,0,0.82);border:1px solid rgba(245,158,11,0.5);border-radius:20px;backdrop-filter:blur(4px);pointer-events:none">
            <span style="font-size:14px">🔒</span>
            <span style="color:#f59e0b;font-size:12px;font-weight:600;font-family:-apple-system,sans-serif">SparkP2P Bot Active</span>
          </div>`;
        const block = e => { e.preventDefault(); e.stopImmediatePropagation(); };
        ['click','mousedown','mouseup','dblclick','contextmenu',
         'keydown','keyup','keypress','wheel','scroll','touchstart','touchend'
        ].forEach(t => dlg.addEventListener(t, block, true));
        dlg.close = () => {};
        document.documentElement.appendChild(dlg);
        dlg.showModal();
      };

      inject();

      if (!window.__sparkLockObserver) {
        window.__sparkLockObserver = new MutationObserver(() => {
          if (!document.getElementById('sparkp2p-browser-lock')) inject();
        });
        window.__sparkLockObserver.observe(document.documentElement, { childList: true, subtree: false });
      }
      if (!window.__sparkLockInterval) {
        window.__sparkLockInterval = setInterval(() => {
          if (!document.getElementById('sparkp2p-browser-lock')) inject();
        }, 800);
      }

      const dlg = document.getElementById('sparkp2p-browser-lock');
      return { ok: true, inDom: !!dlg, isOpen: dlg?.open, url: location.href.substring(0, 60) };
    } catch(e) {
      return { ok: false, error: e.toString() };
    }
  }).catch(e => ({ ok: false, evalError: e.message?.substring(0, 100) }));

  if (result?.ok) {
    console.log('[SparkP2P] Lock overlay injected:', JSON.stringify(result));
  } else {
    console.error('[SparkP2P] Lock overlay FAILED:', JSON.stringify(result));
  }
}

async function lockChromeBrowser() {
  browserLocked = true;

  // Lock Binance tab
  const binancePage = await getPage('binance.com');
  if (binancePage) {
    await injectLockOverlay(binancePage);
    if (lockFrameListener) binancePage.off('framenavigated', lockFrameListener);
    lockFrameListener = async (frame) => {
      if (frame === binancePage.mainFrame()) {
        await new Promise(r => setTimeout(r, 600));
        await injectLockOverlay(binancePage).catch(() => {});
      }
    };
    binancePage.on('framenavigated', lockFrameListener);
  }

  // Lock Gmail tab
  if (gmailPage && !gmailPage.isClosed()) {
    await injectLockOverlay(gmailPage);
    gmailPage.on('framenavigated', async (frame) => {
      if (frame === gmailPage.mainFrame()) {
        await new Promise(r => setTimeout(r, 600));
        await injectLockOverlay(gmailPage).catch(() => {});
      }
    });
  }

  // Lock I&M tab
  if (imPage && !imPage.isClosed()) {
    await injectLockOverlay(imPage);
    imPage.on('framenavigated', async (frame) => {
      if (frame === imPage.mainFrame()) {
        await new Promise(r => setTimeout(r, 600));
        await injectLockOverlay(imPage).catch(() => {});
      }
    });
  }

  // Lock M-PESA org portal tab
  if (mpesaOrgPage && !mpesaOrgPage.isClosed()) {
    await injectLockOverlay(mpesaOrgPage);
    mpesaOrgPage.on('framenavigated', async (frame) => {
      if (frame === mpesaOrgPage.mainFrame()) {
        await new Promise(r => setTimeout(r, 600));
        await injectLockOverlay(mpesaOrgPage).catch(() => {});
      }
    });
  }

  console.log('[SparkP2P] Chrome browser locked (Binance + Gmail + I&M + M-PESA)');
}

async function unlockChromeBrowser() {
  browserLocked = false;
  const removeLock = async (page) => {
    if (!page || page.isClosed()) return;
    await page.evaluate(() => {
      const el = document.getElementById('sparkp2p-browser-lock');
      if (el) el.remove();
      // Stop the re-inject interval and observer so they don't fight the unlock
      if (window.__sparkLockInterval) { clearInterval(window.__sparkLockInterval); window.__sparkLockInterval = null; }
      if (window.__sparkLockObserver) { window.__sparkLockObserver.disconnect(); window.__sparkLockObserver = null; }
    }).catch(() => {});
  };

  const binancePage = await getPage('binance.com');
  if (binancePage) {
    if (lockFrameListener) { binancePage.off('framenavigated', lockFrameListener); lockFrameListener = null; }
    await removeLock(binancePage);
  }
  await removeLock(gmailPage);
  await removeLock(imPage);
  await removeLock(mpesaOrgPage);

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

      // Verify all connections before starting bot
      const setup = await checkSetupComplete();
      if (!setup.complete) {
        notifySetupIncomplete(setup.missing);
        await lockChromeBrowser(); // lock browser so user can't browse freely
        return;
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
      saveAnthropicKey(anthropic_api_key); // persist to disk for future restarts
      console.log('[SparkP2P] Claude Vision API key loaded from backend and saved to disk');
    }
  } catch (e) {
    console.log('[SparkP2P] Could not fetch credentials:', e.message?.substring(0, 40));
  }
}

// Check that Binance, Gmail, and I&M are all connected before allowing bot to start
async function checkSetupComplete() {
  if (!token) return { complete: false, missing: ['binance', 'gmail', 'im'] };
  try {
    const res = await fetch(`${API_BASE}/traders/me`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) return { complete: false, missing: [] };
    const profile = await res.json();
    const missing = [];
    if (!profile.binance_connected) missing.push('Binance');
    if (!profile.gmail_connected) missing.push('Gmail');
    if (!profile.im_connected) missing.push('I&M Bank');
    return { complete: missing.length === 0, missing };
  } catch (e) {
    return { complete: false, missing: [] };
  }
}

function notifySetupIncomplete(missing) {
  // Pause bot and tell frontend to show setup warning
  pauseNavigation = true;
  const detail = JSON.stringify({ missing });
  mainWindow.webContents.executeJavaScript(
    `window.dispatchEvent(new CustomEvent("setup-incomplete", { detail: ${detail} }))`
  ).catch(() => {});
  console.log(`[SparkP2P] Bot paused — missing connections: ${missing.join(', ')}`);
}

async function tryAutoStart() {
  if (!token) return; // Don't do anything until user logs into SparkP2P
  if (browser) return; // Already connected

  // Reset all browser-session flags — stale DB state from the previous run is
  // misleading. Vision will re-confirm and set them back to true this session.
  try {
    await fetch(`${API_BASE}/ext/reset-session-flags`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    console.log('[SparkP2P] Session flags reset — awaiting Vision confirmation');
  } catch (e) {}

  await fetchAndApplyCredentials(); // Load PIN or TOTP from backend

  // Check all connections before starting
  const setup = await checkSetupComplete();
  if (!setup.complete) {
    notifySetupIncomplete(setup.missing);
    // Don't launch Chrome — wait for user to connect missing services
    return;
  }

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
    if (anthropicApiKey) {
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

  if (anthropicApiKey) {
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
  if (anthropicApiKey) {
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

    const syncRes = await fetch(`${API_BASE}/traders/connect-binance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        cookies: dict, cookies_full: full,
        csrf_token: dict.csrftoken || '', bnc_uuid: dict['bnc-uuid'] || '',
        gmail_cookies: gmailCookies,
      }),
    });
    console.log(`[SparkP2P] ${cookies.length} Binance cookies synced${gmailCookies ? `, ${gmailCookies.length} Gmail cookies synced` : ''}`);
    // Notify frontend to refresh profile so connection badge updates
    if (syncRes.ok && full.length > 10) {
      mainWindow.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("binance-connected"))').catch(() => {});
    }
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
  if (!browser || _ordersTabOpen) return { sell: [], buy: [], cancelled: [], completed_buy: [] };

  _ordersTabOpen = true;
  try {
    const page = await getPage();
    if (!page) { _ordersTabOpen = false; return { sell: [], buy: [], cancelled: [], completed_buy: [] }; }

    // ── Step 1: Read active/ongoing orders (tab=0) ──────────────────────────
    await page.goto('https://p2p.binance.com/en/fiatOrder?tab=0&page=1', { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2500));

    const activeText = await page.evaluate(() => document.body.innerText).catch(() => '');

    let sell = [], buy = [];
    if (activeText && anthropicApiKey && !activeText.includes('No records') && !activeText.includes('No data')) {
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

    if (cancelledText && anthropicApiKey && !cancelledText.includes('No records') && !cancelledText.includes('No data')) {
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

    // ── Step 3: Read recently completed BUY orders (tab=1, Completed filter) ──
    // We're still on tab=1 — click the "Completed" filter to find completed buy orders
    let completed_buy = [];
    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('div[class*="tab"], span[class*="tab"], button'));
      const completedTab = tabs.find(el => el.textContent.trim() === 'Completed');
      if (completedTab) completedTab.click();
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));

    const completedText = await page.evaluate(() => document.body.innerText).catch(() => '');

    if (completedText && anthropicApiKey && !completedText.includes('No records') && !completedText.includes('No data')) {
      const aiResult = await aiScanner.analyzeText(completedText, `
        This is text from a Binance P2P completed orders history page.
        Extract order numbers of COMPLETED BUY orders from TODAY only (ignore SELL orders and older dates).
        BUY orders are ones where YOU paid KES to a seller to receive crypto (USDT).
        The order numbers are 18-20 digit integers — copy them EXACTLY as they appear, do NOT change any digits.
        Return JSON: { "completed_buy_order_numbers": ["number1", "number2", ...] }
        If none today, return {"completed_buy_order_numbers": []}.
      `);
      if (aiResult?.completed_buy_order_numbers) {
        completed_buy = aiResult.completed_buy_order_numbers
          .map(n => String(n).replace(/\D/g, ''))
          .filter(n => n.length >= 15);
      }
    }

    console.log(`[SparkP2P] Orders: ${sell.length} sell, ${buy.length} buy, ${cancelled.length} cancelled, ${completed_buy.length} completed buy`);
    return { sell, buy, cancelled, completed_buy };

  } catch (e) {
    console.error('[SparkP2P] Read orders error:', e.message?.substring(0, 60));
    _ordersTabOpen = false;
    return { sell: [], buy: [], cancelled: [], completed_buy: [] };
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
  activeBuyOrderNumber = null;
  scanningInProgress = false;
}

async function extractMpesaCodesFromChat(page) {
  if (!anthropicApiKey) {
    console.log('[SparkP2P] No API key — skipping chat M-Pesa extraction');
    return { mpesaCodes: [], bankRefs: [] };
  }
  try {
    // ── Step 1: Scan buyer's TEXT messages for M-Pesa/bank codes ─────────────
    // Buyer may type the code directly (e.g. "UD5IZBFOER") instead of sending a screenshot
    const textCodes = await page.evaluate(() => {
      const vw = window.innerWidth;
      const mpesaPattern = /\b([A-Z0-9]{10})\b/g;
      const bankRefPattern = /\b([A-Z0-9]{6,20})\b/g;
      const found = { mpesaCodes: [], bankRefs: [] };

      // Chat messages from buyer are on the RIGHT side of the chat panel (left > 50% viewport)
      const allEls = Array.from(document.querySelectorAll('*'));
      for (const el of allEls) {
        if (el.children.length > 0) continue; // leaf nodes only (actual text)
        const rect = el.getBoundingClientRect();
        if (rect.left < vw * 0.45 || rect.width === 0 || rect.height === 0) continue;
        const text = (el.textContent || '').trim();
        if (!text || text.length > 200) continue; // skip long blocks

        // M-Pesa codes: exactly 10 uppercase alphanumeric
        let m;
        mpesaPattern.lastIndex = 0;
        while ((m = mpesaPattern.exec(text)) !== null) {
          const code = m[1];
          if (!found.mpesaCodes.includes(code)) found.mpesaCodes.push(code);
        }
        // Bank refs: 6-20 chars (only if not already in mpesaCodes)
        bankRefPattern.lastIndex = 0;
        while ((m = bankRefPattern.exec(text)) !== null) {
          const ref = m[1];
          if (ref.length !== 10 && !found.bankRefs.includes(ref)) found.bankRefs.push(ref);
        }
      }
      return found;
    });

    if (textCodes.mpesaCodes.length || textCodes.bankRefs.length) {
      console.log(`[SparkP2P] Found in chat text — M-Pesa: ${textCodes.mpesaCodes.join(', ')} Bank: ${textCodes.bankRefs.join(', ')}`);
      return textCodes;
    }

    // ── Step 2: Find all <img> elements in the right half of the viewport (chat panel)
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
        const bankRef = result.bank_ref;
        console.log(`[SparkP2P] Vision image ${i + 1}: mpesa_code=${code} bank_ref=${bankRef}`);

        // Close lightbox before next attempt
        await page.keyboard.press('Escape').catch(() => {});
        await new Promise(r => setTimeout(r, 500));

        const mpesaFound = (code && /^[A-Z0-9]{10}$/.test(code)) ? code : null;
        const bankFound = (bankRef && /^[A-Z0-9]{6,20}$/i.test(bankRef.trim())) ? bankRef.trim().toUpperCase() : null;
        if (!mpesaFound && code) console.log(`[SparkP2P] Rejected mpesa_code "${code}" — not exactly 10 chars`);
        if (!bankFound && bankRef) console.log(`[SparkP2P] Rejected bank_ref "${bankRef}" — unexpected format`);

        if (mpesaFound || bankFound) {
          return { mpesaCodes: mpesaFound ? [mpesaFound] : [], bankRefs: bankFound ? [bankFound] : [] };
        }
      } catch (e) {
        console.log(`[SparkP2P] Chat image ${i + 1} error: ${e.message?.substring(0, 60)}`);
        await page.keyboard.press('Escape').catch(() => {});
      }
    }

    console.log('[SparkP2P] No payment code found in chat images');
    return { mpesaCodes: [], bankRefs: [] };
  } catch (e) {
    console.error('[SparkP2P] extractMpesaCodesFromChat error:', e.message?.substring(0, 60));
    return { mpesaCodes: [], bankRefs: [] };
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
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
            { type: 'text', text: `This is a payment confirmation screenshot. Extract the transaction reference code for an OUTGOING/SENT payment to a paybill or business.

Two possible payment types:

1. M-Pesa SENT confirmation:
   Message: "XXXXXXXXXX Confirmed. Ksh X,XXX.XX sent to SPARK FREELANCE SOLUTIONS..."
   Code: EXACTLY 10 uppercase letters/digits (e.g. UD5IZBFOER)
   IGNORE RECEIVED messages.

2. Bank transfer to M-Pesa paybill (KCB, Equity, Co-op, Absa, etc.):
   Message: "Your payment/transfer of KES X,XXX to paybill XXXXXXX was successful. Ref/Transaction ID: XXXXXXXXXXX"
   Code: The reference/transaction ID shown (may be longer than 10 chars, e.g. FT24096123456)

Return ONLY valid JSON:
{"mpesa_code": "<M-Pesa 10-char code or null>", "bank_ref": "<bank transaction ref or null>"}` },
          ],
        }],
      }),
    });
    const data = await resp.json();
    const text = (data.content?.[0]?.text || '').trim()
      .replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    return { mpesa_code: null, bank_ref: null };
  } catch (e) {
    console.error('[Vision] askVisionForMpesaCode error:', e.message?.substring(0, 60));
    return { mpesa_code: null, bank_ref: null };
  }
}

async function verifyMpesaPayment(orderNumber, fiatAmount, page = null) {
  if (!token) return false;
  try {
    // Extract M-Pesa codes and bank refs from the chat panel if page is available
    let mpesaCodes = [], bankRefs = [];
    if (page) {
      const extracted = await extractMpesaCodesFromChat(page);
      mpesaCodes = extracted.mpesaCodes || [];
      bankRefs = extracted.bankRefs || [];
      if (mpesaCodes.length) console.log(`[SparkP2P] M-Pesa codes: ${mpesaCodes.join(', ')}`);
      if (bankRefs.length) console.log(`[SparkP2P] Bank refs: ${bankRefs.join(', ')}`);
    }
    const res = await fetch(`${API_BASE}/ext/verify-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        binance_order_number: orderNumber,
        fiat_amount: fiatAmount || 0,
        mpesa_codes_from_chat: mpesaCodes.length ? mpesaCodes : null,
        bank_refs_from_chat: bankRefs.length ? bankRefs : null,
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
    // Sell-side takes priority; buy-side monitoring runs when sell-side is idle
    if (activeOrderNumber) {
      await monitorActiveOrder(page);
    } else if (activeBuyOrderNumber) {
      await monitorActiveBuyOrder(page);
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

// ── Buy order monitoring — runs each poll cycle while waiting for seller to release ──
async function monitorActiveBuyOrder(page) {
  console.log(`[SparkP2P] ── MONITORING BUY ORDER ${activeBuyOrderNumber} (waiting for seller release) ──`);

  // Go directly to the order detail page — we know the order number
  await page.goto(
    `https://p2p.binance.com/en/fiatOrderDetail?orderNo=${activeBuyOrderNumber}`,
    { waitUntil: 'domcontentloaded', timeout: 15000 }
  ).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));
  if (pauseNavigation) return;

  await takeScreenshot(`buy_monitor_${activeBuyOrderNumber}`, page);

  // Vision check with retry
  let info = { screen: 'unknown' };
  for (let i = 1; i <= 3; i++) {
    info = await analyzePageWithVision(page);
    console.log(`[SparkP2P] Buy monitor Vision attempt ${i}: ${info.screen}`);
    if (info.screen !== 'unknown') break;
    await new Promise(r => setTimeout(r, 3000));
  }

  const screen = info.screen;

  if (screen === 'order_complete') {
    console.log(`[SparkP2P] ✅ Buy order ${activeBuyOrderNumber} COMPLETED — crypto received!`);
    const orderNum = activeBuyOrderNumber;
    activeBuyOrderNumber = null;
    buyPaymentTime = null;
    buyReminderSent = false;
    buyOrderDetails = null;
    buyPaymentScreenshot = null;

    await fetch(`${API_BASE}/ext/report-buy-completed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ order_number: orderNum }),
    }).catch(e => console.error('[SparkP2P] report-buy-completed failed:', e.message));

    stats.actions++;
    const balances = await scanWalletBalances(page);
    await uploadBalances(balances);
    return;
  }

  // DOM text fallback — Vision occasionally misses cancelled/expired/appeal states
  const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
  const lower = pageText.toLowerCase();
  const minutesWaiting = buyPaymentTime ? Math.floor((Date.now() - buyPaymentTime) / 60000) : 0;

  // ── Expired or appeal raised AFTER we already paid ──
  if (lower.includes('appeal') || lower.includes('expired') || lower.includes('order expired')) {
    console.log(`[SparkP2P] 🚨 Buy order ${activeBuyOrderNumber} EXPIRED — filing dispute and notifying trader`);
    const orderNum = activeBuyOrderNumber;
    const details = buyOrderDetails;
    activeBuyOrderNumber = null;
    buyPaymentTime = null;
    buyReminderSent = false;

    // Try to click the Appeal button on Binance
    try {
      const allBtns = await page.$$('button');
      for (const btn of allBtns) {
        const txt = await page.evaluate(el => el.textContent, btn).catch(() => '');
        if (txt.toLowerCase().includes('appeal')) { await btn.click(); console.log('[SparkP2P] Clicked Appeal button'); break; }
      }
    } catch (e) { console.log('[SparkP2P] Appeal click error:', e.message); }

    await takeScreenshot(`Dispute filed: ${orderNum}`);

    // Notify backend — this sends SMS + in-app notification to trader
    await fetch(`${API_BASE}/ext/report-buy-expired`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        order_number: orderNum,
        seller_name: details?.sellerName || 'Unknown',
        amount: details?.amount || 0,
        minutes_waited: minutesWaiting,
      }),
    }).catch(e => console.error('[SparkP2P] report-buy-expired failed:', e.message));
    return;
  }

  // ── Cancelled ──
  if (lower.includes('cancelled') || lower.includes('canceled')) {
    console.log(`[SparkP2P] Buy order ${activeBuyOrderNumber} CANCELLED`);
    const orderNum = activeBuyOrderNumber;
    activeBuyOrderNumber = null;
    buyPaymentTime = null;
    buyReminderSent = false;
    buyOrderDetails = null;
    await fetch(`${API_BASE}/ext/report-orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ sell_orders: [], buy_orders: [], cancelled_order_numbers: [orderNum] }),
    }).catch(() => {});
    return;
  }

  // ── Still waiting — check time and respond to chat ──

  // At 10 minutes: send one polite reminder to seller
  if (minutesWaiting >= 10 && !buyReminderSent) {
    console.log(`[SparkP2P] ⏰ 10 minutes passed — sending reminder to seller`);
    const reminderMsg = `Hi, just a friendly reminder — I sent the payment ${minutesWaiting} minutes ago. Could you please release the crypto when you get a chance? Thank you! 😊`;
    await sendBinanceChatMessage(page, reminderMsg);
    buyReminderSent = true;
  }

  // At 15 minutes: file dispute, pause ad, notify trader
  if (minutesWaiting >= 15) {
    console.log(`[SparkP2P] 🚨 15 minutes passed with no release — filing dispute`);
    const orderNum = activeBuyOrderNumber;
    const details = buyOrderDetails;
    activeBuyOrderNumber = null;
    buyPaymentTime = null;
    buyReminderSent = false;

    // Inform seller before appealing
    await sendBinanceChatMessage(page, `I have been waiting ${minutesWaiting} minutes for the crypto release. I am now filing an appeal with Binance support. Please release the crypto to avoid any issues.`);
    await new Promise(r => setTimeout(r, 1500));

    // Click Appeal
    try {
      const allBtns = await page.$$('button');
      for (const btn of allBtns) {
        const txt = await page.evaluate(el => el.textContent, btn).catch(() => '');
        if (txt.toLowerCase().includes('appeal')) { await btn.click(); console.log('[SparkP2P] Clicked Appeal'); break; }
      }
    } catch (e) { console.log('[SparkP2P] Appeal error:', e.message); }

    await takeScreenshot(`15min dispute: ${orderNum}`);

    await fetch(`${API_BASE}/ext/report-buy-expired`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        order_number: orderNum,
        seller_name: details?.sellerName || 'Unknown',
        amount: details?.amount || 0,
        minutes_waited: minutesWaiting,
      }),
    }).catch(() => {});
    return;
  }

  // ── Respond to seller chat messages using AI ──
  if (buyOrderDetails && anthropicApiKey) {
    await respondToBuyOrderChat(page, buyOrderDetails);
  }

  console.log(`[SparkP2P] Buy order ${activeBuyOrderNumber} — waiting ${minutesWaiting}m for seller release (screen: ${screen})`);
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

  // ── Step 3: No active orders — check completed tab + scan My Ads prices ────
  if (orders.sell.length === 0 && orders.buy.length === 0) {
    console.log('[SparkP2P] Step 3: No active orders — checking completed tab (tab=1)...');
    await page.goto('https://p2p.binance.com/en/fiatOrder?tab=1&page=1',
      { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));
    if (pauseNavigation) return;
    // Re-read cancelled orders from this tab
    const cancelledOrders = await readOrders();
    orders.cancelled = cancelledOrders.cancelled || [];

    // ── Step 3b: Scan My Ads for current buy/sell prices (every 1 min) ───────
    // Floating prices change frequently — Vision scrape to keep spread calculator live
    const secsSinceLastScan = (Date.now() - lastAdPriceScan) / 1000;
    if (secsSinceLastScan >= 55) {
      await scanMyAdPrices();
    } else {
      console.log(`[SparkP2P] Ad price scan skipped — last scan ${Math.round(secsSinceLastScan)}s ago`);
    }
  }

  // Report orders to VPS
  const res = await fetch(`${API_BASE}/ext/report-orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({
        sell_orders: orders.sell.map(norm),
        buy_orders: orders.buy.map(norm),
        cancelled_order_numbers: orders.cancelled || [],
        completed_buy_order_numbers: orders.completed_buy || [],
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
          console.log(`[SparkP2P] ⚠️ M-Pesa NOT confirmed for ${order.orderNumber} — asking buyer`);
          activeOrderNumber = order.orderNumber;
          activeOrderFiatAmount = order.totalPrice;
          await sendChatMessage(page,
            'Sorry, I don\'t seem to be able to see your transaction. How did you make your payment? Through bank, M-Pesa or another method? If you paid through M-Pesa or bank please share your M-Pesa reference code so that I can confirm.'
          );
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

    // Check if buyer already sent a screenshot or typed a code in chat
    // If so, acknowledge it before starting verification so they don't think we're ignoring them
    const buyerAlreadySent = await page.evaluate(() => {
      const vw = window.innerWidth;
      // Check for images in right side of screen (buyer's chat side)
      const hasImage = Array.from(document.querySelectorAll('img')).some(img => {
        const r = img.getBoundingClientRect();
        return r.width > 60 && r.height > 60 && r.left > vw * 0.5
          && r.top >= 0 && r.bottom <= window.innerHeight;
      });
      // Check for M-Pesa-like codes typed as text on right side
      const hasCode = Array.from(document.querySelectorAll('*')).some(el => {
        if (el.children.length > 0) return false;
        const r = el.getBoundingClientRect();
        if (r.left < vw * 0.5 || r.width === 0) return false;
        return /\b[A-Z0-9]{10}\b/.test(el.textContent || '');
      });
      return hasImage || hasCode;
    });

    if (buyerAlreadySent) {
      console.log(`[SparkP2P] Buyer already sent payment proof — acknowledging`);
      await sendChatMessage(page, 'I can see that you have already made your payment, please wait as I verify this payment. Thank you!');
      await new Promise(r => setTimeout(r, 1000));
    }

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

      // Send confirmation message to buyer in chat
      await sendChatMessage(page, 'I have received your payment. Releasing crypto in a short while.');
      await new Promise(r => setTimeout(r, 1000));

      // Scroll to bottom so Payment Received button is visible
      await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
      await new Promise(r => setTimeout(r, 1000));

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
      console.log(`[SparkP2P] ⚠️ M-Pesa NOT confirmed — asking buyer for payment method`);
      await sendChatMessage(page,
        'Sorry, I don\'t seem to be able to see your transaction. How did you make your payment? Through bank, M-Pesa or another method? If you paid through M-Pesa or bank please share your M-Pesa reference code so that I can confirm.'
      );
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
    } else {
      console.log(`[SparkP2P] ⚠️ M-Pesa NOT confirmed — asking buyer`);
      await sendChatMessage(page,
        'Sorry, I don\'t seem to be able to see your transaction. How did you make your payment? Through bank, M-Pesa or another method? If you paid through M-Pesa or bank please share your M-Pesa reference code so that I can confirm.'
      );
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
// MY AD PRICES — Vision-scrape trader's own buy/sell prices
// ═══════════════════════════════════════════════════════════

const MY_ADS_URL = 'https://p2p.binance.com/en/myads?type=normal&code=default';
let lastAdPriceScan = 0; // timestamp of last successful scan

async function scanMyAdPrices() {
  if (!token || !anthropicApiKey) return;
  if (pauseNavigation) return;

  const page = await getPage('binance.com');
  if (!page || page.isClosed()) return;

  try {
    console.log('[SparkP2P] Scanning My Ads page for prices...');
    await page.goto(MY_ADS_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));

    if (pauseNavigation) return;

    const ss = await page.screenshot({ encoding: 'base64' });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ss } },
            {
              type: 'text',
              text: `This is a Binance P2P "My Ads" page showing the trader's own buy and sell advertisements.
Find the Price/Exchange Rate column values.
- The BUY ad row shows the price at which the trader buys USDT (paying KES).
- The SELL ad row shows the price at which the trader sells USDT (receiving KES).
Extract ONLY the numeric prices. Reply in this exact format with no extra text:
BUY:129.74
SELL:129.70
If a price is not visible or there is no ad of that type, use 0 for that value.`,
            },
          ],
        }],
      }),
    });

    const data = await response.json();
    const text_result = (data.content?.[0]?.text || '').trim();
    console.log(`[SparkP2P] My Ads Vision result: ${text_result}`);

    // Parse BUY:xxx and SELL:xxx from response
    const buyMatch = text_result.match(/BUY[:=]\s*([\d.]+)/i);
    const sellMatch = text_result.match(/SELL[:=]\s*([\d.]+)/i);

    const buyPrice = buyMatch ? parseFloat(buyMatch[1]) : null;
    const sellPrice = sellMatch ? parseFloat(sellMatch[1]) : null;

    if ((buyPrice && buyPrice > 50) || (sellPrice && sellPrice > 50)) {
      console.log(`[SparkP2P] My Ads prices — Buy: ${buyPrice}, Sell: ${sellPrice}`);

      // Upload to backend
      await fetch(`${API_BASE}/ext/report-ad-prices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          buy: (buyPrice && buyPrice > 50) ? buyPrice : null,
          sell: (sellPrice && sellPrice > 50) ? sellPrice : null,
        }),
      }).catch(() => {});

      lastAdPriceScan = Date.now();

      // Notify frontend to refresh spread calculator
      mainWindow?.webContents.executeJavaScript(
        `window.dispatchEvent(new CustomEvent("ad-prices-updated", { detail: { buy: ${buyPrice}, sell: ${sellPrice} } }))`
      ).catch(() => {});
    } else {
      console.log('[SparkP2P] My Ads Vision: could not extract valid prices');
    }
  } catch (e) {
    console.error('[SparkP2P] scanMyAdPrices error:', e.message?.substring(0, 80));
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

// ── Vision-based Gmail OTP reader ──────────────────────────────────────────────
async function readEmailOTPWithVision(binancePage = null) {
  if (!browser) return null;
  const sentAt = Date.now();

  if (!gmailPage || gmailPage.isClosed()) {
    console.log('[SparkP2P] Opening Gmail tab...');
    await openGmailTab();
  }
  if (!gmailPage) return null;

  // Try up to 3 times, waiting for the email to arrive
  for (let attempt = 1; attempt <= 3; attempt++) {
    await gmailPage.bringToFront();

    // Navigate to Binance verification emails
    await gmailPage.goto(
      'https://mail.google.com/mail/u/0/#search/from%3Ado-not-reply%40binance.com+subject%3Averification+newer_than%3A1h',
      { waitUntil: 'networkidle2', timeout: 15000 }
    ).catch(() => {});
    await new Promise(r => setTimeout(r, 2500));

    // Click the first (most recent) email row
    const clicked = await gmailPage.evaluate(() => {
      const row = document.querySelector('tr.zA');
      if (row) { row.click(); return true; }
      return false;
    });

    if (!clicked) {
      console.log(`[Vision] Gmail: no email yet (attempt ${attempt}/3) — waiting 8s...`);
      await new Promise(r => setTimeout(r, 8000));
      continue;
    }

    await new Promise(r => setTimeout(r, 2500));

    // Screenshot the open email and ask Vision for the 6-digit OTP
    const ss = await gmailPage.screenshot({ type: 'jpeg', quality: 90 });
    await takeScreenshot('gmail_otp_email', gmailPage);

    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001', max_tokens: 80,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: ss.toString('base64') } },
            { type: 'text', text: `This is a Binance security verification email. Find the 6-digit verification code.\nReturn ONLY JSON: {"code": "<6 digits or null>"}` },
          ]}],
        }),
      });
      const data = await resp.json();
      const raw = (data.content?.[0]?.text || '').trim().replace(/```json|```/g, '');
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        if (parsed.code && /^\d{6}$/.test(parsed.code)) {
          console.log(`[Vision] Gmail Vision extracted OTP: ${parsed.code}`);
          return parsed.code;
        }
      }
    } catch (e) {
      console.log('[Vision] Gmail Vision OTP error:', e.message?.substring(0, 60));
    }

    console.log(`[Vision] OTP not found in email (attempt ${attempt}/3) — retrying...`);
    await new Promise(r => setTimeout(r, 8000));
  }
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
  // Scroll to bottom — chat input is at the bottom of the order page
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise(r => setTimeout(r, 800));

  // Find the chat input — Binance uses a contenteditable div
  const inputFound = await page.evaluate((msg) => {
    const selectors = [
      '[contenteditable="true"]',
      '[placeholder*="message" i]',
      '[placeholder*="Enter message" i]',
      'input[placeholder*="message" i]',
      'textarea[placeholder]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      el.click();
      el.focus();
      if (el.isContentEditable) {
        // Clear existing content first
        el.textContent = '';
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        // execCommand fires beforeinput + input events that React's synthetic system picks up
        document.execCommand('insertText', false, msg);
        return `contenteditable:${sel}`;
      } else {
        // Regular input/textarea — use native setter to bypass React's read-only value prop
        const proto = el.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(el, msg);
        } else {
          el.value = msg;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return `input:${sel}`;
      }
    }
    // Debug: log all placeholder elements so we can identify the correct selector
    const allPlaceholders = Array.from(document.querySelectorAll('[placeholder]'))
      .map(e => `${e.tagName}[placeholder="${e.getAttribute('placeholder')}"]`);
    console.log('[DEBUG] Elements with placeholder:', JSON.stringify(allPlaceholders));
    return null;
  }, message);

  if (inputFound) {
    await new Promise(r => setTimeout(r, 500));
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 1000));
    console.log(`[SparkP2P] Chat message sent via "${inputFound}": "${message.substring(0, 60)}"`);
    return true;
  }
  console.log('[SparkP2P] Chat input not found — check [DEBUG] log above for available inputs');
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
- "Order Completed" or "Sale Successful" or "Released" → order_complete
- Page is still loading (spinner, blank, skeleton) → awaiting_payment (assume still waiting, safe default)
- Any page with a countdown timer visible → awaiting_payment
- When uncertain between two states, pick the safer one (e.g. awaiting_payment over unknown)`;

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
  const MAX_STEPS = 60;  // Raised: buyer has up to 15 min, awaiting_payment uses DOM poll not steps
  let step = 0;
  let consecutiveUnknown = 0;  // Track back-to-back unknowns before reloading

  console.log(`[Vision] Starting vision-driven release for order ${orderNumber}`);

  // Ensure Anthropic API key is loaded — re-fetch credentials if missing
  if (!anthropicApiKey) {
    console.log('[Vision] Anthropic API key missing — re-fetching credentials...');
    await fetchAndApplyCredentials();
    if (!anthropicApiKey) {
      console.error('[Vision] Anthropic API key still missing after re-fetch — cannot proceed with Vision release');
      return { success: false, error: 'No Anthropic API key' };
    }
    console.log('[Vision] Anthropic API key loaded successfully');
  }

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

      // ── DOM pre-check: catch modals Vision misses due to overlay ────────────
      const domScreen = await page.evaluate(() => {
        const text = document.body.innerText || '';
        if (text.includes('My Passkeys Are Not Available') || text.includes('Passkeys Are Not Available'))
          return 'passkey_failed';
        if (text.includes('Security Verification') && (text.includes('0/2') || text.includes('1/2'))) {
          const progress = text.includes('1/2') ? '1/2' : '0/2';
          return `security_verification:${progress}`;
        }
        if (text.includes('Sale Successful') || text.includes('Order Completed') || text.includes('Released'))
          return 'order_complete';
        return null;
      }).catch(() => null);

      if (domScreen) {
        console.log(`[Vision] Step ${step}/${MAX_STEPS} | DOM detected: ${domScreen}`);
      }

      const info = domScreen ? { screen: domScreen.split(':')[0] } : await analyzePageWithVision(page);
      const screen = info.screen || 'unknown';
      if (!domScreen) console.log(`[Vision] Step ${step}/${MAX_STEPS} | ${screen}`);

      // Reset consecutive unknown counter on any known screen
      if (screen !== 'unknown') consecutiveUnknown = 0;

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

      // ── Awaiting payment — DOM poll, no Vision calls until buyer pays ─────
      if (screen === 'awaiting_payment') {
        consecutiveUnknown = 0;
        console.log('[Vision] Awaiting buyer payment — DOM polling every 20s (no Vision calls)...');
        // Poll DOM up to 45 times (15 minutes) without consuming Vision steps
        let paymentDetected = false;
        for (let poll = 0; poll < 45; poll++) {
          if (pauseNavigation) return { success: false, error: 'paused' };
          await new Promise(r => setTimeout(r, 20000));
          try {
            await page.reload({ waitUntil: 'domcontentloaded' });
            await new Promise(r => setTimeout(r, 2500));
            const pageText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
            if (
              pageText.includes('Payment Received') ||
              pageText.includes('Verify Payment') ||
              pageText.includes('Payment Processing') ||
              pageText.includes('Processing Payment') ||
              pageText.includes('Verifying Payment') ||
              pageText.includes('Order Completed') ||
              pageText.includes('Sale Successful') ||
              pageText.includes('Received payment in your account')
            ) {
              console.log('[Vision] Payment detected via DOM — resuming Vision loop');
              paymentDetected = true;
              break;
            }
            console.log(`[Vision] Still awaiting payment (poll ${poll + 1}/45)...`);
          } catch (e) {
            console.log('[Vision] DOM poll error:', e.message?.substring(0, 40));
          }
        }
        if (!paymentDetected) {
          console.log('[Vision] Buyer did not pay within 15 minutes — giving up');
          return { success: false, error: 'Payment timeout' };
        }
        continue;
      }

      // ── Payment processing — Binance verifying payment ──────
      if (screen === 'payment_processing') {
        consecutiveUnknown = 0;
        console.log('[Vision] Payment processing — waiting 10s for Binance to complete...');
        await new Promise(r => setTimeout(r, 10000));
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
        // Tick the checkbox — try multiple selectors since Binance uses custom checkboxes
        const cbClicked = await page.evaluate(() => {
          const selectors = [
            'input[type="checkbox"]',
            '[class*="checkbox"]',
            '[class*="Checkbox"]',
            '[role="checkbox"]',
          ];
          for (const sel of selectors) {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                el.click();
                return sel;
              }
            }
          }
          return null;
        });
        console.log(`[Vision] Checkbox clicked via: ${cbClicked}`);
        await new Promise(r => setTimeout(r, 1000));
        await clickButton(page, 'Confirm Release', 'Confirm release', 'Confirm');
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // ── Passkey failed — skip to alternative method ─────────
      if (screen === 'passkey_failed') {
        // Wait up to 4s for "My Passkeys Are Not Available" to be visible and sized
        try {
          await page.waitForFunction(() => {
            const all = Array.from(document.querySelectorAll('*'));
            return all.some(e => {
              const tc = e.textContent.trim();
              if (!/passkey.*not.*available/i.test(tc) || tc.length >= 120) return false;
              const r = e.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            });
          }, { timeout: 4000 });
        } catch (_) { /* didn't appear in time — try anyway */ }

        // Search main frame + all iframes for the "My Passkeys Are Not Available" link.
        // Returns debug info as return value (not console.log — that goes to browser console).
        let passKeyCoords = null;
        const allFrames = [page, ...page.frames()];
        for (const frame of allFrames) {
          try {
            const result = await frame.evaluate(() => {
              const all = Array.from(document.querySelectorAll('*'));
              for (let i = all.length - 1; i >= 0; i--) {
                const el = all[i];
                const tc = el.textContent.trim();
                if (!/passkey.*not.*available/i.test(tc) || tc.length >= 120) continue;
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) continue;
                return { found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: tc.substring(0, 60) };
              }
              // Return debug info so Node.js terminal can see it
              const debugEls = all
                .filter(e => /passkey/i.test(e.textContent) && e.textContent.trim().length < 150)
                .map(e => {
                  const r = e.getBoundingClientRect();
                  return `${e.tagName}[${Math.round(r.width)}x${Math.round(r.height)}]="${e.textContent.trim().substring(0, 60)}"`;
                });
              return { found: false, debug: debugEls.slice(-10) }; // last 10 = most specific
            });
            if (result && result.found) {
              passKeyCoords = result;
              console.log(`[Vision] Passkey found in frame: "${result.text}"`);
              break;
            } else if (result && result.debug && result.debug.length > 0) {
              console.log(`[DEBUG] Passkey DOM elements: ${JSON.stringify(result.debug)}`);
            }
          } catch (e) { /* cross-origin frame — skip */ }
        }

        if (passKeyCoords) {
          await page.mouse.click(passKeyCoords.x, passKeyCoords.y);
          console.log(`[Vision] Passkey button clicked at (${Math.round(passKeyCoords.x)},${Math.round(passKeyCoords.y)})`);
        } else {
          // Final fallback: ask Vision for exact pixel coordinates
          console.log('[Vision] Passkey not found in DOM — asking Vision for coordinates');
          try {
            const ss = await page.screenshot({ type: 'jpeg', quality: 90 });
            const resp = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
              body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 100,
                messages: [{ role: 'user', content: [
                  { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: ss.toString('base64') } },
                  { type: 'text', text: `Find the "My Passkeys Are Not Available" link or button in this Binance passkey modal. Return its center pixel coordinates.\nReturn ONLY valid JSON: {"x": <number>, "y": <number>, "found": true}. If not visible return {"found": false}` },
                ]}],
              }),
            });
            const data = await resp.json();
            const raw = (data.content?.[0]?.text || '').trim().replace(/```json|```/g, '');
            const match = raw.match(/\{[\s\S]*\}/);
            if (match) {
              const parsed = JSON.parse(match[0]);
              if (parsed.found && parsed.x && parsed.y) {
                await page.mouse.click(parsed.x, parsed.y);
                console.log(`[Vision] Passkey clicked via Vision coords (${parsed.x},${parsed.y})`);
              } else {
                console.log('[Vision] Vision could not locate passkey button');
              }
            }
          } catch (e) {
            console.log('[Vision] Vision coordinate fallback error:', e.message?.substring(0, 60));
          }
        }
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // ── Security verification selector ──────────────────────
      if (screen === 'security_verification') {
        // Ask Vision to identify which verifications are done/pending and where to click next.
        // This avoids relying on fragile DOM "1/2" text which can change between checks.
        try {
          const ss = await page.screenshot({ type: 'jpeg', quality: 90 });
          const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 150,
              messages: [{ role: 'user', content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: ss.toString('base64') } },
                { type: 'text', text: `This is a Binance "Security Verification Requirements" modal. Look for checkmarks (✓) next to completed items.
Which item should I click NEXT (the first incomplete one without a checkmark)?
- If "Authenticator App" has NO checkmark → click it
- If "Authenticator App" has a checkmark (✓) AND "Email" has no checkmark → click "Email"
Return ONLY JSON: {"next_action": "authenticator"|"email"|"done", "x": <number>, "y": <number>, "found": true}` },
              ]}],
            }),
          });
          const data = await resp.json();
          const raw = (data.content?.[0]?.text || '').trim().replace(/```json|```/g, '');
          const match = raw.match(/\{[\s\S]*\}/);
          if (match) {
            const sv = JSON.parse(match[0]);
            console.log(`[Vision] Security verification next_action="${sv.next_action}" at (${sv.x},${sv.y})`);
            if (sv.next_action === 'done') {
              console.log('[Vision] Security verification complete — proceeding');
            } else if (sv.found && sv.x && sv.y) {
              await page.mouse.click(sv.x, sv.y);
              console.log(`[Vision] Clicked "${sv.next_action}" at (${sv.x},${sv.y})`);
            }
          }
        } catch (e) {
          console.log('[Vision] Security verification Vision error:', e.message?.substring(0, 60));
        }
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // ── TOTP input — generate code, fill via nativeInputValueSetter, click Submit via Vision ──
      if (screen === 'totp_input') {
        if (!totpSecret) {
          console.error('[Vision] TOTP required but not configured');
          return { success: false, error: 'TOTP not configured' };
        }
        const code = generateTOTP(totpSecret);
        console.log(`[Vision] Auto-filling TOTP: ${code}`);

        // Take one screenshot, ask Vision for BOTH the input field and Paste button coords,
        // click input to focus, then click Paste — guaranteed to work like passkey/auth clicks did
        const ss1 = await page.screenshot({ type: 'jpeg', quality: 90 });
        let totpFilled = false;
        try {
          const resp1 = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 120,
              messages: [{ role: 'user', content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: ss1.toString('base64') } },
                { type: 'text', text: `In this Authenticator App Verification modal, find the text input field and the "Paste" button.\nReturn ONLY JSON: {"input_x": <number>, "input_y": <number>, "paste_x": <number>, "paste_y": <number>, "found": true}. If not found: {"found": false}` },
              ]}],
            }),
          });
          const d1 = await resp1.json();
          const raw1 = (d1.content?.[0]?.text || '').trim().replace(/```json|```/g, '');
          const m1 = raw1.match(/\{[\s\S]*\}/);
          if (m1) {
            const c1 = JSON.parse(m1[0]);
            if (c1.found) {
              // Write to Electron clipboard
              clipboard.writeText(code);
              // Click the input to focus it
              await page.mouse.click(c1.input_x, c1.input_y);
              await new Promise(r => setTimeout(r, 300));
              // Click the Paste button
              await page.mouse.click(c1.paste_x, c1.paste_y);
              console.log(`[Vision] Clicked input at (${c1.input_x},${c1.input_y}), Paste at (${c1.paste_x},${c1.paste_y})`);
              totpFilled = true;
            }
          }
        } catch (e) {
          console.log('[Vision] TOTP fill Vision error:', e.message?.substring(0, 60));
        }
        if (!totpFilled) {
          // Fallback: type directly via keyboard
          console.log('[Vision] TOTP Vision fill failed — typing directly');
          await page.keyboard.type(code, { delay: 80 });
        }

        await new Promise(r => setTimeout(r, 500));

        // Click Submit via Vision coordinates
        try {
          const ss = await page.screenshot({ type: 'jpeg', quality: 90 });
          const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 80,
              messages: [{ role: 'user', content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: ss.toString('base64') } },
                { type: 'text', text: `Find the Submit or Confirm button in the Authenticator App verification modal. Return ONLY JSON: {"x": <number>, "y": <number>, "found": true}. If not visible: {"found": false}` },
              ]}],
            }),
          });
          const data = await resp.json();
          const raw = (data.content?.[0]?.text || '').trim().replace(/```json|```/g, '');
          const match = raw.match(/\{[\s\S]*\}/);
          if (match) {
            const coords = JSON.parse(match[0]);
            if (coords.found && coords.x && coords.y) {
              await page.mouse.click(coords.x, coords.y);
              console.log(`[Vision] TOTP Submit clicked at (${coords.x},${coords.y})`);
            }
          }
        } catch (e) {
          console.log('[Vision] TOTP Submit Vision error:', e.message?.substring(0, 60));
        }
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // ── Email OTP — Vision clicks Send Code, Gmail Vision extracts OTP ──
      if (screen === 'email_otp_input') {
        // Step 1: Use Vision to find and click "Send Code" / "Get Code" button
        try {
          const ssSend = await page.screenshot({ type: 'jpeg', quality: 90 });
          const rSend = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001', max_tokens: 80,
              messages: [{ role: 'user', content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: ssSend.toString('base64') } },
                { type: 'text', text: `Find the "Send Code" or "Get Code" button in the Email verification section. Return ONLY JSON: {"x":<number>,"y":<number>,"found":true}. If not visible: {"found":false}` },
              ]}],
            }),
          });
          const dSend = await rSend.json();
          const mSend = (dSend.content?.[0]?.text || '').match(/\{[\s\S]*\}/);
          if (mSend) {
            const cSend = JSON.parse(mSend[0]);
            if (cSend.found && cSend.x && cSend.y) {
              await page.mouse.click(cSend.x, cSend.y);
              console.log(`[Vision] Clicked "Send Code" at (${cSend.x},${cSend.y})`);
            }
          }
        } catch (e) { console.log('[Vision] Send Code click error:', e.message?.substring(0, 50)); }
        await new Promise(r => setTimeout(r, 3000)); // wait for email to arrive

        // Step 2: Switch to Gmail, screenshot email, extract OTP via Vision
        console.log('[Vision] Switching to Gmail to extract OTP via Vision...');
        const emailCode = await readEmailOTPWithVision(page);
        if (!emailCode) {
          console.error('[Vision] Email OTP not found via Vision');
          return { success: false, error: 'Email OTP not found' };
        }
        console.log(`[Vision] Got OTP: ${emailCode} — switching back to Binance`);
        await page.bringToFront();
        await new Promise(r => setTimeout(r, 1000));

        // Step 3: Use clipboard + Vision to paste code into Email input and click Submit
        clipboard.writeText(emailCode);
        try {
          const ssEmail = await page.screenshot({ type: 'jpeg', quality: 90 });
          const rEmail = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001', max_tokens: 150,
              messages: [{ role: 'user', content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: ssEmail.toString('base64') } },
                { type: 'text', text: `In the Email verification modal, find the text input field, the "Paste" button (if any), and the Submit/Confirm button.\nReturn ONLY JSON: {"input_x":<n>,"input_y":<n>,"paste_x":<n>,"paste_y":<n>,"submit_x":<n>,"submit_y":<n>,"has_paste":<bool>,"found":true}. If not found: {"found":false}` },
              ]}],
            }),
          });
          const dEmail = await rEmail.json();
          const mEmail = (dEmail.content?.[0]?.text || '').match(/\{[\s\S]*\}/);
          if (mEmail) {
            const cEmail = JSON.parse(mEmail[0]);
            if (cEmail.found) {
              await page.mouse.click(cEmail.input_x, cEmail.input_y);
              await new Promise(r => setTimeout(r, 300));
              if (cEmail.has_paste && cEmail.paste_x) {
                await page.mouse.click(cEmail.paste_x, cEmail.paste_y);
                console.log(`[Vision] Email OTP pasted via Paste button`);
              } else {
                await page.keyboard.down('Control');
                await page.keyboard.press('v');
                await page.keyboard.up('Control');
                console.log(`[Vision] Email OTP pasted via Ctrl+V`);
              }
              await new Promise(r => setTimeout(r, 500));
              await page.mouse.click(cEmail.submit_x, cEmail.submit_y);
              console.log(`[Vision] Email Submit clicked at (${cEmail.submit_x},${cEmail.submit_y})`);
            }
          }
        } catch (e) { console.log('[Vision] Email OTP entry error:', e.message?.substring(0, 60)); }
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // ── Unknown — wait and retry before reloading ───────────────────────────
      consecutiveUnknown++;
      const unknownUrl = page.url();
      console.log(`[Vision] Unknown screen at step ${step} (${consecutiveUnknown} in a row) — URL: ${unknownUrl}`);

      if (!unknownUrl.includes('fiatOrderDetail')) {
        // We are not on the order detail page — navigate back immediately
        console.log(`[Vision] Not on order detail page — navigating back to order ${orderNumber}`);
        await page.goto('https://p2p.binance.com/en/fiatOrder?tab=0&page=1',
          { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 2500));
        await clickOrderWithMouse(page, orderNumber);
        await new Promise(r => setTimeout(r, 4000));
        consecutiveUnknown = 0;
        continue;
      }

      // On the right page but Vision confused — wait longer before reloading
      if (consecutiveUnknown < 3) {
        // First 2 unknowns: just wait and retry Vision (page may be mid-load)
        console.log(`[Vision] Waiting 5s and retrying Vision (attempt ${consecutiveUnknown}/3 before reload)...`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      // 3+ consecutive unknowns — reload the page
      console.log(`[Vision] 3 consecutive unknowns — reloading page...`);
      consecutiveUnknown = 0;
      await new Promise(r => setTimeout(r, 2000));
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
      // ── Full buy-side payment automation ──
      // 1. Extract payment details from Binance order page using Vision
      // 2. Send money via I&M Bank
      // 3. Upload receipt + notify seller on Binance
      // 4. Start monitoring for seller release

      // Step 1: Extract payment details via Vision
      console.log(`[SparkP2P] Extracting payment details from order ${order_number}...`);
      await new Promise(r => setTimeout(r, 2000));
      const ss = await page.screenshot({ encoding: 'base64' }).catch(() => null);
      let paymentDetails = action.payment_details || null;

      if (!paymentDetails && ss && anthropicApiKey) {
        const extractRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 300,
            messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ss } },
              { type: 'text', text: 'Extract the payment details from this Binance P2P buy order page. Return JSON only: {"method": "mpesa|bank|paybill", "phone": "07XXXXXXXX or null", "account_number": "null or account", "paybill": "null or paybill", "name": "recipient name", "amount": 1234, "network": "safaricom|airtel|null", "reference": "order number"}' },
            ]}],
          }),
        }).catch(() => null);

        if (extractRes?.ok) {
          const extractData = await extractRes.json();
          const jsonMatch = (extractData.content?.[0]?.text || '').match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try { paymentDetails = JSON.parse(jsonMatch[0]); } catch (_) {}
          }
        }
      }

      // Fallback: use action fields if Vision extraction failed
      if (!paymentDetails) {
        paymentDetails = {
          method: action.method || 'mpesa',
          phone: action.phone || '',
          name: action.seller_name || 'Seller',
          amount: action.amount || 0,
          network: action.network || 'safaricom',
          reference: order_number,
        };
      }

      console.log(`[SparkP2P] Payment details: ${JSON.stringify(paymentDetails)}`);

      // Step 2: Execute I&M Bank payment
      let imResult = { success: false, screenshot: null };
      try {
        imResult = await executeImPayment({
          phone: paymentDetails.phone,
          name: paymentDetails.name,
          amount: paymentDetails.amount,
          reference: paymentDetails.reference || order_number,
          network: paymentDetails.network || 'safaricom',
        });
      } catch (e) {
        console.error('[SparkP2P] I&M payment failed:', e.message);
        await takeScreenshot(`I&M payment failed: ${e.message.substring(0, 40)}`);
      }

      if (!imResult.success) {
        console.log('[SparkP2P] ⚠️ I&M payment may have failed — proceeding to notify Binance anyway');
      }

      // Store payment details for chat monitoring
      buyOrderDetails = {
        sellerName: paymentDetails.name,
        amount: paymentDetails.amount,
        phone: paymentDetails.phone,
        method: paymentDetails.method || 'M-Pesa',
        orderNumber: order_number,
      };
      buyPaymentScreenshot = imResult.screenshot;
      buyPaymentTime = Date.now();
      buyReminderSent = false;

      // Step 3: Switch back to Binance order page
      await page.bringToFront();
      await page.goto(`https://p2p.binance.com/en/fiatOrderDetail?orderNo=${order_number}`, {
        waitUntil: 'domcontentloaded', timeout: 15000,
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 3000));

      // Step 4: Send chat message to seller
      const payTime = new Date().toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
      const chatMsg = `Hello ${paymentDetails.name.split(' ')[0]}, I have sent KSh ${paymentDetails.amount.toLocaleString()} to your ${paymentDetails.method === 'mpesa' ? 'M-Pesa' : 'account'} (${paymentDetails.phone || paymentDetails.account_number || ''}) at ${payTime}. Please check and release the crypto. Thank you! 🙏`;
      await sendBinanceChatMessage(page, chatMsg);

      // Step 5: Upload payment proof (I&M receipt screenshot)
      if (imResult.screenshot) {
        await new Promise(r => setTimeout(r, 1000));
        await uploadPaymentProofToBinance(page, imResult.screenshot);
      }

      // Step 6: Click "Transferred, notify seller" / "Upload Payment Proof" → confirm on Binance
      await new Promise(r => setTimeout(r, 2000));
      let clicked = await clickButton(page, 'transferred', 'payment done', 'i have paid', 'mark as paid', 'notify seller', 'upload payment proof');
      if (clicked) {
        await new Promise(r => setTimeout(r, 2000));
        await clickButton(page, 'confirm', 'yes');
        await new Promise(r => setTimeout(r, 2000));
        await handleSecurityVerification(page);
      }

      await takeScreenshot(`Buy payment complete: order ${order_number}`);

      await fetch(`${API_BASE}/ext/report-payment-sent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ order_number, success: true }),
      }).catch(() => {});

      stats.actions++;
      activeBuyOrderNumber = order_number;
      console.log(`[SparkP2P] 👀 Buy order ${order_number} — I&M paid, monitoring for seller release`);

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

// ═══════════════════════════════════════════════════════════
// BUY ORDER — I&M PAYMENT EXECUTION
// Reads payment details from Binance, sends money via I&M Bank,
// takes a screenshot of success, and uploads proof to Binance chat.
// ═══════════════════════════════════════════════════════════

async function executeImPayment({ phone, name, amount, reference, network = 'safaricom' }) {
  if (!imPage || imPage.isClosed()) throw new Error('I&M Bank tab is not open. Please reconnect I&M Bank.');
  if (!imPin) throw new Error('I&M PIN not set. Please save your PIN in Settings → Binance tab.');

  console.log(`[SparkP2P] 💳 Starting I&M payment: KSh ${amount} → ${name} (${phone})`);

  // Navigate to Send Money to Mobile form
  await imPage.bringToFront();
  await imPage.goto('https://digital.imbank.com/inm-retail/transfers/send-money-to-mobile/form', {
    waitUntil: 'domcontentloaded', timeout: 20000,
  });
  await new Promise(r => setTimeout(r, 3000));

  // ── Step 1: Select debit account ──
  // Click the account dropdown and select the KES account
  const accountDropdown = await imPage.$('select, [class*="account-select"], [placeholder*="account" i], [class*="dropdown"]');
  if (accountDropdown) {
    await accountDropdown.click();
    await new Promise(r => setTimeout(r, 1000));
    // Try to click an option containing "KES" or the account number ending in 050
    const options = await imPage.$$('option, [role="option"], [class*="option"]');
    for (const opt of options) {
      const text = await imPage.evaluate(el => el.textContent, opt).catch(() => '');
      if (text.includes('KES') || text.includes('050') || text.includes('BONITO')) {
        await opt.click();
        break;
      }
    }
  }
  await new Promise(r => setTimeout(r, 1000));

  // ── Step 2: Select "One-off Beneficiary" ──
  const oneOff = await imPage.$('[value*="one" i], [id*="one-off" i], label');
  if (oneOff) {
    const labels = await imPage.$$('label');
    for (const lbl of labels) {
      const txt = await imPage.evaluate(el => el.textContent, lbl).catch(() => '');
      if (txt.toLowerCase().includes('one-off') || txt.toLowerCase().includes('one off')) {
        await lbl.click();
        break;
      }
    }
  }
  await new Promise(r => setTimeout(r, 800));

  // ── Step 3: Enter phone number ──
  // Strip leading 0 — I&M already shows +254 prefix
  const cleanPhone = phone.replace(/^0/, '').replace(/\s/g, '');
  const phoneInput = await imPage.$('input[placeholder*="phone" i], input[name*="phone" i], input[type="tel"]');
  if (phoneInput) {
    await phoneInput.click({ clickCount: 3 });
    await phoneInput.type(cleanPhone, { delay: 80 });
    console.log(`[SparkP2P] Entered phone: ${cleanPhone}`);
    await new Promise(r => setTimeout(r, 1500)); // wait for name lookup
  }

  // ── Step 4: Select Safaricom/Airtel ──
  const networkLabels = await imPage.$$('label, [role="radio"]');
  for (const lbl of networkLabels) {
    const txt = await imPage.evaluate(el => el.textContent, lbl).catch(() => '');
    if (txt.toLowerCase().includes(network.toLowerCase())) {
      await lbl.click();
      break;
    }
  }
  await new Promise(r => setTimeout(r, 800));

  // ── Step 5: Enter amount ──
  const amountInput = await imPage.$('input[placeholder*="amount" i], input[name*="amount" i], input[type="number"]');
  if (amountInput) {
    await amountInput.click({ clickCount: 3 });
    await amountInput.type(String(amount), { delay: 80 });
    console.log(`[SparkP2P] Entered amount: ${amount}`);
  }
  await new Promise(r => setTimeout(r, 500));

  // ── Step 6: Enter payment reference (order number) ──
  const refInput = await imPage.$('input[placeholder*="reference" i], input[name*="reference" i], textarea[placeholder*="reference" i]');
  if (refInput) {
    await refInput.click({ clickCount: 3 });
    await refInput.type(String(reference).substring(0, 50), { delay: 60 });
  }
  await new Promise(r => setTimeout(r, 500));

  // ── Step 7: Click Continue ──
  const continueBtn = await imPage.$('button[type="submit"], button');
  const allBtns = await imPage.$$('button');
  for (const btn of allBtns) {
    const txt = await imPage.evaluate(el => el.textContent, btn).catch(() => '');
    if (txt.toLowerCase().includes('continue')) { await btn.click(); break; }
  }
  await new Promise(r => setTimeout(r, 3000));
  console.log('[SparkP2P] Clicked Continue — waiting for review modal...');

  // ── Step 8: Review modal — click Submit ──
  const modalBtns = await imPage.$$('button');
  let submitted = false;
  for (const btn of modalBtns) {
    const txt = await imPage.evaluate(el => el.textContent, btn).catch(() => '');
    if (txt.toLowerCase().includes('submit')) {
      await btn.click();
      submitted = true;
      console.log('[SparkP2P] Clicked Submit on review modal');
      break;
    }
  }
  if (!submitted) console.log('[SparkP2P] Submit button not found — may have auto-advanced');
  await new Promise(r => setTimeout(r, 2000));

  // ── Step 9: Identity Validation — enter PIN ──
  const pinInput = await imPage.$('input[type="password"], input[placeholder*="pin" i], input[placeholder*="PIN" i]');
  if (pinInput) {
    await pinInput.click({ clickCount: 3 });
    await pinInput.type(imPin, { delay: 120 });
    console.log('[SparkP2P] Entered I&M PIN');
    await new Promise(r => setTimeout(r, 500));

    // Click Complete
    const completeBtns = await imPage.$$('button');
    for (const btn of completeBtns) {
      const txt = await imPage.evaluate(el => el.textContent, btn).catch(() => '');
      if (txt.toLowerCase().includes('complete')) {
        await btn.click();
        console.log('[SparkP2P] Clicked Complete — waiting for confirmation...');
        break;
      }
    }
  } else {
    console.log('[SparkP2P] PIN input not found — may have already advanced');
  }

  // ── Step 10: Wait for success and take screenshot ──
  await new Promise(r => setTimeout(r, 4000));
  const screenshot = await imPage.screenshot({ encoding: 'base64' }).catch(() => null);

  // Verify success via page text
  const pageText = await imPage.evaluate(() => document.body.innerText).catch(() => '');
  const success = pageText.toLowerCase().includes('success') ||
                  pageText.toLowerCase().includes('transaction') ||
                  pageText.toLowerCase().includes('submitted') ||
                  pageText.toLowerCase().includes('processed');

  console.log(`[SparkP2P] I&M payment ${success ? '✅ SUCCESS' : '⚠️ status unclear'}`);
  return { success, screenshot };
}

async function sendBinanceChatMessage(page, message) {
  try {
    const chatInput = await page.$('[placeholder*="message" i], [placeholder*="Enter message" i], textarea');
    if (!chatInput) { console.log('[SparkP2P] Chat input not found'); return false; }
    await chatInput.click();
    await new Promise(r => setTimeout(r, 400));
    await chatInput.type(message, { delay: 30 });
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 1000));
    console.log(`[SparkP2P] Chat message sent: ${message.substring(0, 60)}`);
    return true;
  } catch (e) {
    console.log('[SparkP2P] Chat send error:', e.message);
    return false;
  }
}

async function uploadPaymentProofToBinance(page, screenshotBase64) {
  try {
    // Click the "Upload Payment Proof" button
    const allBtns = await page.$$('button, [role="button"]');
    let uploadBtn = null;
    for (const btn of allBtns) {
      const txt = await page.evaluate(el => el.textContent, btn).catch(() => '');
      if (txt.toLowerCase().includes('upload') || txt.toLowerCase().includes('payment proof')) {
        uploadBtn = btn;
        break;
      }
    }

    if (!uploadBtn) {
      // Try the + attachment button in chat
      uploadBtn = await page.$('[class*="attach" i], [title*="attach" i], [aria-label*="attach" i]');
    }

    if (!uploadBtn) { console.log('[SparkP2P] Upload button not found'); return false; }

    // Write screenshot to temp file and upload via file input
    const tmpPath = path.join(app.getPath('temp'), `im_receipt_${Date.now()}.png`);
    const buf = Buffer.from(screenshotBase64, 'base64');
    fs.writeFileSync(tmpPath, buf);

    // Intercept file chooser
    const [fileChooser] = await Promise.all([
      page.waitForFileChooser({ timeout: 5000 }),
      uploadBtn.click(),
    ]);
    await fileChooser.accept([tmpPath]);
    await new Promise(r => setTimeout(r, 2000));

    // Click Send if there's a send button after file selection
    const sendBtns = await page.$$('button');
    for (const btn of sendBtns) {
      const txt = await page.evaluate(el => el.textContent, btn).catch(() => '');
      if (txt.toLowerCase() === 'send' || txt.toLowerCase().includes('send')) {
        await btn.click();
        break;
      }
    }

    // Clean up temp file
    fs.unlinkSync(tmpPath);
    console.log('[SparkP2P] Payment proof uploaded to Binance chat');
    return true;
  } catch (e) {
    console.log('[SparkP2P] Upload proof error:', e.message);
    return false;
  }
}

async function respondToBuyOrderChat(page, orderDetails) {
  try {
    // Get all chat messages visible on the page
    const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');

    // Only respond if there are seller messages we haven't addressed
    // Ask Claude to read the chat and generate a response if needed
    const ss = await page.screenshot({ encoding: 'base64' }).catch(() => null);
    if (!ss || !anthropicApiKey) return;

    const minutesSincePayment = buyPaymentTime ? Math.floor((Date.now() - buyPaymentTime) / 60000) : 0;
    const prompt = `You are managing a Binance P2P buy order. You are the BUYER.

Order details:
- You sent KSh ${orderDetails.amount} to ${orderDetails.name} via ${orderDetails.method} (${orderDetails.phone || ''})
- Payment was sent ${minutesSincePayment} minute(s) ago
- Order number: ${orderDetails.orderNumber}

Look at this Binance P2P order chat screenshot.
1. Has the seller sent any NEW message that requires a response?
2. If yes, what should the buyer reply? Be professional, friendly, and concise (max 2 sentences).
3. If no response is needed, reply with "NO_REPLY_NEEDED".

Reply in this JSON format: {"needs_reply": true/false, "message": "your reply here or NO_REPLY_NEEDED"}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ss } },
          { type: 'text', text: prompt },
        ]}],
      }),
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const result = JSON.parse(jsonMatch[0]);
    if (result.needs_reply && result.message && result.message !== 'NO_REPLY_NEEDED') {
      await sendBinanceChatMessage(page, result.message);
      console.log(`[SparkP2P] AI replied to seller: ${result.message.substring(0, 60)}`);
    }
  } catch (e) {
    console.log('[SparkP2P] Chat response error:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════
// I&M BANK AUTOMATION
// Opens as a new tab in the existing Binance browser — one browser, all tabs
// ═══════════════════════════════════════════════════════════

const IM_URL = 'https://digital.imbank.com/inm-retail/select-context'; // entry point — redirects to login if not authenticated
const IM_TRANSFERS_URL = 'https://digital.imbank.com/inm-retail/transfers';
const IM_KEEP_ALIVE_INTERVAL = 60 * 1000; // ping every 1 min to prevent session timeout
let imKeepAliveTimer = null;

async function connectIm() {
  if (connectingIm) return;
  connectingIm = true;
  console.log('[SparkP2P] Opening I&M Bank tab...');
  try {
    // Ensure main browser is running — launch if needed
    if (!browser) {
      await launchChrome('https://digital.imbank.com');
      await connectPuppeteer();
      if (!browser) { connectingIm = false; return; }
    }

    // Check if an I&M tab is already open
    const pages = await browser.pages();
    const existing = pages.find(p => p.url().includes('imbank.com'));
    if (existing) {
      imPage = existing;
    } else {
      imPage = await browser.newPage();
      await imPage.goto(IM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    await imPage.bringToFront();
    imPage.on('close', () => { imPage = null; });

    // Poll until Claude Vision confirms the user is actually logged into I&M dashboard
    let attempts = 0;
    let verifying = false;
    const check = setInterval(async () => {
      attempts++;
      if (attempts > 600) { clearInterval(check); connectingIm = false; return; } // 10 min timeout
      if (verifying) return; // don't stack Vision calls
      try {
        const url = imPage.url();
        // Quick URL pre-filter — skip obvious login/auth pages without Vision call
        if (url.includes('/openid-connect/') || url.includes('/auth/realms/')) return;
        if (!url.includes('imbank.com')) return;

        // URL looks promising — use Vision to confirm dashboard is visible
        verifying = true;
        const ss = await imPage.screenshot({ encoding: 'base64' });
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 50,
            messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ss } },
              { type: 'text', text: 'Is this an I&M Bank online banking dashboard showing account information (logged in)? Or is it a login/QR code screen? Reply with only: LOGGED_IN or LOGIN_PAGE' },
            ]}],
          }),
        });
        const data = await response.json();
        const verdict = (data.content?.[0]?.text || '').trim().toUpperCase();
        console.log(`[SparkP2P] I&M Vision check: ${verdict}`);
        verifying = false;

        if (verdict === 'LOGGED_IN') {
          clearInterval(check);
          console.log('[SparkP2P] I&M login confirmed by Vision! Syncing cookies...');
          await syncImCookies();
          startImKeepAlive();
          // Lock ALL bot-controlled tabs (sets browserLocked = true)
          await lockChromeBrowser().catch(() => {});
          connectingIm = false;
          mainWindow.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("im-connected"))').catch(() => {});
          // Re-check setup — if all 3 now connected, auto-start bot
          const setup = await checkSetupComplete();
          if (setup.complete && !pollerRunning) {
            pauseNavigation = false;
            mainWindow.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("setup-complete"))').catch(() => {});
            console.log('[SparkP2P] All connections established — bot ready to start');
          }
        }
      } catch (e) { verifying = false; }
    }, 3000); // check every 3s (Vision calls are slower than URL checks)
  } catch (e) {
    console.log('[SparkP2P] I&M connect error:', e.message);
    connectingIm = false;
  }
}

async function syncImCookies() {
  if (!token || !imPage) return;
  try {
    const cookies = await imPage.cookies(IM_URL, 'https://digital.imbank.com');
    if (cookies.length < 3) return;
    await fetch(`${API_BASE}/traders/connect-im`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ cookies }),
    });
    console.log(`[SparkP2P] I&M ${cookies.length} cookies synced`);
  } catch (e) { console.log('[SparkP2P] I&M cookie sync error:', e.message); }
}

function startImKeepAlive() {
  if (imKeepAliveTimer) clearInterval(imKeepAliveTimer);
  imKeepAliveTimer = setInterval(async () => {
    if (!imPage || imPage.isClosed()) { imPage = null; return; }
    try {
      const url = imPage.url();

      // Detect session expiry — login/QR page means we've been logged out
      if (url.includes('/openid-connect/') || url.includes('/auth/realms/') ||
          url.includes('login') || url.includes('Login') ||
          !url.includes('imbank.com')) {
        console.log('[SparkP2P] I&M session expired — auto-reconnecting...');
        imPage = null;
        if (imKeepAliveTimer) { clearInterval(imKeepAliveTimer); imKeepAliveTimer = null; }
        // Clear backend connected flag
        if (token) {
          await fetch(`${API_BASE}/traders/connect-im`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ cookies: [], disconnected: true }),
          }).catch(() => {});
        }
        // Auto-reconnect — re-opens the I&M tab and waits for QR scan
        console.log('[SparkP2P] I&M auto-reconnect triggered — opening login page');
        await connectIm().catch(() => {});
        return;
      }

      // Skip keep-alive navigation if a withdrawal is currently running
      if (imWithdrawalRunning) {
        console.log('[SparkP2P] I&M keep-alive skipped — withdrawal in progress');
        return;
      }

      // Navigate to dashboard to refresh the I&M session timer (SPA navigation)
      await imPage.goto('https://digital.imbank.com/inm-retail/dashboard', {
        waitUntil: 'domcontentloaded', timeout: 15000
      }).catch(() => {});
      await syncImCookies();
      console.log('[SparkP2P] I&M keep-alive: navigated to dashboard, session refreshed');
    } catch (e) {
      console.log('[SparkP2P] I&M keep-alive error:', e.message);
    }
  }, IM_KEEP_ALIVE_INTERVAL);
}

async function executeImWithdrawal(job) {
  // job = { id, amount, destination_account, destination_name }
  // Transfers from SPARK FREELANCE SOLUTIONS (00108094726150) → trader's personal account
  // Flow: dashboard → Money Transfer nav → Own Account Transfer → fill form → review → PIN → success
  if (imWithdrawalRunning) return;
  if (!imPage || imPage.isClosed()) {
    console.log('[SparkP2P] I&M page not open — cannot execute withdrawal');
    return;
  }
  if (!imPin) {
    console.log('[SparkP2P] I&M PIN not set — cannot execute withdrawal');
    return;
  }
  imWithdrawalRunning = true;
  const FROM_ACCOUNT = '00108094726150'; // SPARK FREELANCE SOLUTIONS (M-Pesa sweep destination)
  const TO_ACCOUNT   = job.destination_account || '00108094726050'; // trader personal KES acc
  const EXPECTED_NAME = (job.destination_name || '').toUpperCase();
  console.log(`[SparkP2P] 💸 I&M own-account transfer: KES ${job.amount} → ${TO_ACCOUNT}`);

  try {
    // ── STEP 1: Navigate to Own Account Transfer form ──────────────────────────
    await imPage.goto(
      'https://digital.imbank.com/inm-retail/transfers/own-account-transfer/form',
      { waitUntil: 'networkidle2', timeout: 30000 }
    );
    await imPage.waitForTimeout(2000);
    console.log('[SparkP2P] I&M: Loaded own-account-transfer form');

    // ── STEP 2: Select FROM account (SPARK FREELANCE SOLUTIONS) ───────────────
    // Click the From dropdown
    await imPage.waitForSelector('select, [class*="dropdown"], [class*="select"]', { timeout: 10000 }).catch(() => {});
    // Use Claude Vision to identify and click the From dropdown, then select correct account
    let ss = await imPage.screenshot({ encoding: 'base64' });
    let fromDone = false;
    // Try clicking the first dropdown (From) and selecting by account number text
    const fromDropdowns = await imPage.$$('ng-select, app-select, select').catch(() => []);
    if (fromDropdowns.length > 0) {
      await fromDropdowns[0].click().catch(() => {});
      await imPage.waitForTimeout(1000);
      // Find option containing FROM_ACCOUNT number
      const fromOption = await imPage.$x(`//*[contains(text(), '${FROM_ACCOUNT}') or contains(text(), 'SPARK FREELANCE')]`).catch(() => []);
      if (fromOption.length > 0) {
        await fromOption[0].click().catch(() => {});
        fromDone = true;
        console.log('[SparkP2P] I&M: Selected FROM account (Spark Freelance Solutions)');
      }
    }
    if (!fromDone) {
      // Fallback: use Vision to click From dropdown and select
      ss = await imPage.screenshot({ encoding: 'base64' });
      await imVisionClick(ss, `Click the "From" account dropdown and select the account with number ${FROM_ACCOUNT} (SPARK FREELANCE SOLUTIONS)`);
    }
    await imPage.waitForTimeout(1000);

    // ── STEP 3: Select TO account (trader's personal account) ─────────────────
    const allDropdowns = await imPage.$$('ng-select, app-select, select').catch(() => []);
    let toDone = false;
    if (allDropdowns.length > 1) {
      await allDropdowns[1].click().catch(() => {});
      await imPage.waitForTimeout(1000);
      const toOption = await imPage.$x(`//*[contains(text(), '${TO_ACCOUNT}') or contains(text(), 'BONITO')]`).catch(() => []);
      if (toOption.length > 0) {
        await toOption[0].click().catch(() => {});
        toDone = true;
        console.log('[SparkP2P] I&M: Selected TO account');
      }
    }
    if (!toDone) {
      ss = await imPage.screenshot({ encoding: 'base64' });
      await imVisionClick(ss, `Click the "To" account dropdown and select the account with number ${TO_ACCOUNT}`);
    }
    await imPage.waitForTimeout(1000);

    // ── STEP 4: Set currency to KES ────────────────────────────────────────────
    // Click the currency dropdown and select KES
    const currencyDropdown = await imPage.$('select[formcontrolname*="currency"], [class*="currency"] select, select').catch(() => null);
    if (currencyDropdown) {
      await imPage.select('select', 'KES').catch(() => {});
    } else {
      // Try clicking currency button and picking KES from list
      const currencyBtn = await imPage.$x('//*[contains(text(), "KES") or contains(text(), "EUR") or contains(text(), "USD")]').catch(() => []);
      if (currencyBtn.length > 0) {
        await currencyBtn[0].click().catch(() => {});
        await imPage.waitForTimeout(500);
        const kesOption = await imPage.$x('//*[contains(text(), "KES")]').catch(() => []);
        if (kesOption.length > 0) await kesOption[0].click().catch(() => {});
      }
    }
    console.log('[SparkP2P] I&M: Currency set to KES');
    await imPage.waitForTimeout(500);

    // ── STEP 5: Enter amount ───────────────────────────────────────────────────
    // Amount field — type the whole number part (cents field stays 00)
    const amountWhole = Math.floor(job.amount).toString();
    const amountInput = await imPage.$('input[type="number"], input[formcontrolname*="amount"], input[placeholder*="amount" i]').catch(() => null);
    if (amountInput) {
      await amountInput.click({ clickCount: 3 });
      await amountInput.type(amountWhole, { delay: 50 });
    } else {
      // Vision fallback
      ss = await imPage.screenshot({ encoding: 'base64' });
      await imVisionType(ss, `Type ${amountWhole} in the Amount field`, amountWhole);
    }
    console.log(`[SparkP2P] I&M: Entered amount ${amountWhole}`);
    await imPage.waitForTimeout(500);

    // ── STEP 6: Enter description (optional) ──────────────────────────────────
    const descInput = await imPage.$('textarea, input[formcontrolname*="description"], input[placeholder*="description" i]').catch(() => null);
    if (descInput) {
      await descInput.click();
      await descInput.type(`SparkP2P withdrawal ${job.id}`, { delay: 30 });
    }
    await imPage.waitForTimeout(500);

    // ── STEP 7: Click Continue ─────────────────────────────────────────────────
    const continueBtn = await imPage.$x('//button[contains(text(), "Continue")]').catch(() => []);
    if (continueBtn.length > 0) {
      await continueBtn[0].click();
    } else {
      await imPage.click('button[type="submit"], button.btn-primary').catch(() => {});
    }
    console.log('[SparkP2P] I&M: Clicked Continue');
    await imPage.waitForTimeout(3000);

    // ── STEP 8: Review modal — verify account name then click Submit ───────────
    // Use Claude Vision to read the beneficiary name shown in the review modal
    ss = await imPage.screenshot({ encoding: 'base64' });
    const reviewCheck = await imVisionVerify(
      ss,
      `This is the "Own Account Transfer - Review" confirmation modal.
      Read the Account Name shown under "Beneficiary bank details".
      Expected account name: "${EXPECTED_NAME || 'BONITO CHELUGET SAMOEI'}".
      Does the account name in the modal match?
      Respond JSON only: { "match": true/false, "found_name": "name you read", "description": "brief" }`
    );

    if (reviewCheck && reviewCheck.match === false) {
      console.log(`[SparkP2P] ⚠️ I&M review: account name mismatch! Expected "${EXPECTED_NAME}", found "${reviewCheck.found_name}" — discarding`);
      const discardBtn = await imPage.$x('//button[contains(text(), "Discard")] | //a[contains(text(), "Discard")]').catch(() => []);
      if (discardBtn.length > 0) await discardBtn[0].click().catch(() => {});
      throw new Error(`Account name mismatch: expected "${EXPECTED_NAME}", got "${reviewCheck.found_name}"`);
    }
    console.log(`[SparkP2P] I&M: Review verified (${reviewCheck?.found_name || 'name confirmed'}) — submitting`);

    // Click Submit
    const submitBtn = await imPage.$x('//button[contains(text(), "Submit")]').catch(() => []);
    if (submitBtn.length > 0) {
      await submitBtn[0].click();
    } else {
      await imPage.click('button[type="submit"]').catch(() => {});
    }
    await imPage.waitForTimeout(2000);
    console.log('[SparkP2P] I&M: Clicked Submit');

    // ── STEP 9: Identity Validation — enter PIN ────────────────────────────────
    await imPage.waitForSelector('input[type="password"], input[placeholder*="PIN" i]', { timeout: 10000 });
    const pinInput = await imPage.$('input[type="password"], input[placeholder*="PIN" i]').catch(() => null);
    if (!pinInput) throw new Error('PIN input not found');
    await pinInput.click();
    await pinInput.type(imPin, { delay: 80 });
    console.log('[SparkP2P] I&M: Entered PIN');
    await imPage.waitForTimeout(500);

    // Click Complete button
    const completeBtn = await imPage.$x('//button[contains(text(), "Complete")]').catch(() => []);
    if (completeBtn.length > 0) {
      await completeBtn[0].click();
    } else {
      await imPage.click('button[type="submit"]').catch(() => {});
    }
    console.log('[SparkP2P] I&M: Clicked Complete');
    await imPage.waitForTimeout(4000);

    // ── STEP 10: Verify success screen ────────────────────────────────────────
    ss = await imPage.screenshot({ encoding: 'base64' });
    const successCheck = await imVisionVerify(
      ss,
      `Does this screen show "Payment Success" with a green checkmark?
      Also extract the Reference ID number if visible.
      Respond JSON only: { "success": true/false, "reference": "ref number or null", "description": "brief" }`
    );

    if (successCheck && successCheck.success) {
      console.log(`[SparkP2P] ✅ I&M withdrawal KES ${job.amount} SUCCESS — ref: ${successCheck.reference || 'N/A'}`);
      // Click Close to dismiss the success modal
      const closeBtn = await imPage.$x('//button[contains(text(), "Close")]').catch(() => []);
      if (closeBtn.length > 0) await closeBtn[0].click().catch(() => {});
      await imPage.waitForTimeout(1000);

      // Notify backend
      await fetch(`${API_BASE}/ext/bank-withdrawal-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ tx_id: job.id, reference: successCheck.reference }),
      });
    } else {
      throw new Error(`Payment success screen not detected: ${successCheck?.description || 'unknown state'}`);
    }

  } catch (e) {
    console.log('[SparkP2P] I&M withdrawal error:', e.message);
    await fetch(`${API_BASE}/ext/bank-withdrawal-failed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ tx_id: job.id, error: e.message }),
    }).catch(() => {});
  } finally {
    imWithdrawalRunning = false;
    await syncImCookies();
  }
}

// ── Claude Vision helpers for I&M automation ──────────────────────────────────
async function imVisionClick(screenshotB64, instruction) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 300,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshotB64 } },
          { type: 'text', text: `${instruction}. Respond JSON only: { "selector": "css selector to click", "description": "what you see" }` },
        ]}],
      }),
    });
    const data = await res.json();
    const result = JSON.parse(data.content[0].text);
    if (result.selector) await imPage.click(result.selector).catch(() => {});
    await imPage.waitForTimeout(1000);
  } catch (e) { console.log('[SparkP2P] imVisionClick error:', e.message); }
}

async function imVisionType(screenshotB64, instruction, text) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 300,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshotB64 } },
          { type: 'text', text: `${instruction}. Respond JSON only: { "selector": "css selector of input field", "description": "what you see" }` },
        ]}],
      }),
    });
    const data = await res.json();
    const result = JSON.parse(data.content[0].text);
    if (result.selector) {
      await imPage.click(result.selector, { clickCount: 3 }).catch(() => {});
      await imPage.type(result.selector, text, { delay: 50 }).catch(() => {});
    }
    await imPage.waitForTimeout(500);
  } catch (e) { console.log('[SparkP2P] imVisionType error:', e.message); }
}

async function imVisionVerify(screenshotB64, instruction) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 400,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshotB64 } },
          { type: 'text', text: instruction },
        ]}],
      }),
    });
    const data = await res.json();
    return JSON.parse(data.content[0].text);
  } catch (e) {
    console.log('[SparkP2P] imVisionVerify error:', e.message);
    return null;
  }
}

// ── I&M Local Transfer (to any I&M account holder) ────────────────────────────
// Used for all trader withdrawals to their I&M accounts
async function executeImLocalTransfer(job) {
  // job = { id, amount, destination_account, destination_name }
  // Flow: local-transfers/form → select FROM → One-off Beneficiary → I&M Bank → enter account
  //       → Validate → verify name → KES → amount → Import Payments → Continue
  //       → review modal → Submit → PIN → success
  if (imWithdrawalRunning) return;
  if (!imPage || imPage.isClosed()) {
    console.log('[SparkP2P] I&M page not open — cannot execute local transfer');
    return;
  }
  if (!imPin) {
    console.log('[SparkP2P] I&M PIN not set — cannot execute local transfer');
    return;
  }
  imWithdrawalRunning = true;
  const FROM_ACCOUNT  = '00108094726150'; // SPARK FREELANCE SOLUTIONS
  const TO_ACCOUNT    = job.destination_account;
  const EXPECTED_NAME = (job.destination_name || '').toUpperCase().trim();
  console.log(`[SparkP2P] 💸 I&M local transfer: KES ${job.amount} → ${TO_ACCOUNT} (${EXPECTED_NAME})`);

  try {
    // ── STEP 1: Navigate to Local Transfers form ───────────────────────────────
    await imPage.goto(
      'https://digital.imbank.com/inm-retail/transfers/local-transfers/form',
      { waitUntil: 'networkidle2', timeout: 30000 }
    );
    await imPage.waitForTimeout(2500);
    console.log('[SparkP2P] I&M: Loaded local-transfers form');

    // ── STEP 2: Select Debit Account (SPARK FREELANCE SOLUTIONS) ──────────────
    // Click the Debit Account dropdown
    let ss = await imPage.screenshot({ encoding: 'base64' });
    // Try to find and click the debit account dropdown via XPath
    const debitDropdown = await imPage.$x('//*[contains(text(), "Select an account") or contains(@placeholder, "Select an account")]').catch(() => []);
    if (debitDropdown.length > 0) {
      await debitDropdown[0].click();
      await imPage.waitForTimeout(1000);
    } else {
      // Vision fallback: click the "Debit Account" dropdown
      await imVisionClick(ss, 'Click the "Debit Account" or "Select an account" dropdown at the top of the form');
      await imPage.waitForTimeout(1000);
    }
    // Select SPARK FREELANCE SOLUTIONS
    const fromOption = await imPage.$x(`//*[contains(text(), '${FROM_ACCOUNT}') or contains(text(), 'SPARK FREELANCE')]`).catch(() => []);
    if (fromOption.length > 0) {
      await fromOption[0].click();
      console.log('[SparkP2P] I&M: Selected FROM account (Spark Freelance Solutions)');
    } else {
      ss = await imPage.screenshot({ encoding: 'base64' });
      await imVisionClick(ss, `Select the SPARK FREELANCE SOLUTIONS account (${FROM_ACCOUNT}) from the dropdown list`);
    }
    await imPage.waitForTimeout(1000);

    // ── STEP 3: Click "One-off Beneficiary" tab ────────────────────────────────
    const oneOffTab = await imPage.$x('//label[contains(text(), "One-off Beneficiary")] | //span[contains(text(), "One-off Beneficiary")] | //*[contains(text(), "One-off")]').catch(() => []);
    if (oneOffTab.length > 0) {
      await oneOffTab[0].click();
      console.log('[SparkP2P] I&M: Clicked One-off Beneficiary tab');
    } else {
      ss = await imPage.screenshot({ encoding: 'base64' });
      await imVisionClick(ss, 'Click the "One-off Beneficiary" radio button or tab');
    }
    await imPage.waitForTimeout(1000);

    // ── STEP 4: Select Bank = I & M Bank Ltd ──────────────────────────────────
    // Click the Bank name dropdown
    const bankDropdown = await imPage.$x('//*[contains(text(), "Bank name") or @placeholder[contains(., "Bank")]]').catch(() => []);
    // Try using ng-select or regular select for bank
    const bankSelects = await imPage.$$('ng-select, app-select, select').catch(() => []);
    let bankSelected = false;
    for (const sel of bankSelects) {
      const text = await imPage.evaluate(el => el.textContent || '', sel).catch(() => '');
      if (text.includes('Bank') || text.includes('Select')) {
        await sel.click().catch(() => {});
        await imPage.waitForTimeout(800);
        const imOption = await imPage.$x('//*[contains(text(), "I & M Bank") or contains(text(), "I&M Bank")]').catch(() => []);
        if (imOption.length > 0) {
          await imOption[0].click();
          bankSelected = true;
          console.log('[SparkP2P] I&M: Selected I & M Bank Ltd as destination bank');
          break;
        }
      }
    }
    if (!bankSelected) {
      ss = await imPage.screenshot({ encoding: 'base64' });
      await imVisionClick(ss, 'Click the "Bank name" dropdown and select "I & M Bank Ltd" from the list');
    }
    await imPage.waitForTimeout(1000);

    // ── STEP 5: Enter Account Number then click Validate ──────────────────────
    const acctInput = await imPage.$('input[formcontrolname*="account"], input[placeholder*="Account number" i], input[name*="account" i]').catch(() => null);
    if (acctInput) {
      await acctInput.click({ clickCount: 3 });
      await acctInput.type(TO_ACCOUNT, { delay: 60 });
    } else {
      ss = await imPage.screenshot({ encoding: 'base64' });
      await imVisionType(ss, 'Type the account number in the "Account number" field', TO_ACCOUNT);
    }
    await imPage.waitForTimeout(500);

    // Click Validate button
    const validateBtn = await imPage.$x('//button[contains(text(), "Validate")]').catch(() => []);
    if (validateBtn.length > 0) {
      await validateBtn[0].click();
      console.log('[SparkP2P] I&M: Clicked Validate — waiting for account name...');
    } else {
      ss = await imPage.screenshot({ encoding: 'base64' });
      await imVisionClick(ss, 'Click the "Validate" button next to the account number field');
    }
    // Wait for the account name to auto-fill (API call)
    await imPage.waitForTimeout(3000);

    // ── STEP 6: Read auto-filled account name and verify ──────────────────────
    // The "Account name" field should now be populated
    let autoFilledName = '';
    const acctNameInput = await imPage.$('input[formcontrolname*="name" i], input[placeholder*="Account name" i]').catch(() => null);
    if (acctNameInput) {
      autoFilledName = await imPage.evaluate(el => el.value || '', acctNameInput).catch(() => '');
    }
    if (!autoFilledName) {
      // Vision fallback: read the account name from the page
      ss = await imPage.screenshot({ encoding: 'base64' });
      const nameRead = await imVisionVerify(ss,
        `The "Account name" field should now be auto-filled after Validate was clicked.
        Read the text in the "Account name" input field.
        Respond JSON only: { "account_name": "the name shown or empty string if blank", "description": "brief" }`
      );
      autoFilledName = nameRead?.account_name || '';
    }
    autoFilledName = autoFilledName.toUpperCase().trim();
    console.log(`[SparkP2P] I&M: Validated account name = "${autoFilledName}"`);

    // Verify name matches expected (if we have an expected name)
    if (EXPECTED_NAME && autoFilledName && !autoFilledName.includes(EXPECTED_NAME.split(' ')[0])) {
      console.log(`[SparkP2P] ⚠️ Account name mismatch! Expected "${EXPECTED_NAME}", got "${autoFilledName}" — aborting`);
      throw new Error(`Account name mismatch: expected "${EXPECTED_NAME}", got "${autoFilledName}"`);
    }
    console.log(`[SparkP2P] I&M: Account name verified ✓`);

    // ── STEP 7: Select Currency = KES ─────────────────────────────────────────
    // The currency is a small dropdown (KES/EUR/USD/GBP)
    const currencySelects = await imPage.$$('select').catch(() => []);
    let currencySet = false;
    for (const sel of currencySelects) {
      try {
        await imPage.evaluate(el => { el.value = 'KES'; el.dispatchEvent(new Event('change', { bubbles: true })); }, sel);
        currencySet = true;
        break;
      } catch (_) {}
    }
    if (!currencySet) {
      // Try clicking the currency "-" dropdown and picking KES
      const currDrop = await imPage.$x('//*[text()="-" or text()="KES" or text()="EUR" or text()="USD"]').catch(() => []);
      if (currDrop.length > 0) {
        await currDrop[0].click();
        await imPage.waitForTimeout(500);
        const kesOpt = await imPage.$x('//*[text()="KES"]').catch(() => []);
        if (kesOpt.length > 0) await kesOpt[0].click();
      }
    }
    console.log('[SparkP2P] I&M: Currency set to KES');
    await imPage.waitForTimeout(500);

    // ── STEP 8: Enter Amount ───────────────────────────────────────────────────
    const amountWhole = Math.floor(job.amount).toString();
    // The amount field is a number input (whole part); there's a separate .00 field for cents
    const amountInputs = await imPage.$$('input[type="number"], input[formcontrolname*="amount"]').catch(() => []);
    let amountEntered = false;
    for (const inp of amountInputs) {
      const placeholder = await imPage.evaluate(el => el.placeholder || el.getAttribute('formcontrolname') || '', inp).catch(() => '');
      if (!placeholder.includes('cent') && !placeholder.includes('00')) {
        await inp.click({ clickCount: 3 });
        await inp.type(amountWhole, { delay: 50 });
        amountEntered = true;
        break;
      }
    }
    if (!amountEntered) {
      ss = await imPage.screenshot({ encoding: 'base64' });
      await imVisionType(ss, `Type ${amountWhole} in the Amount (whole number) field`, amountWhole);
    }
    console.log(`[SparkP2P] I&M: Entered amount ${amountWhole}`);
    await imPage.waitForTimeout(500);

    // ── STEP 9: Enter Payment Reference ───────────────────────────────────────
    const refText = `SparkP2P ${job.id}`.substring(0, 50);
    const refInput = await imPage.$('input[formcontrolname*="reference" i], input[placeholder*="Payment Description" i], input[placeholder*="description" i]').catch(() => null);
    if (refInput) {
      await refInput.click();
      await refInput.type(refText, { delay: 30 });
    }
    await imPage.waitForTimeout(500);

    // ── STEP 10: Select Payment Purpose = "Import Payments" ───────────────────
    // Click the Payment Purpose dropdown and select "Import Payments"
    const purposeSelect = await imPage.$('select[formcontrolname*="purpose" i]').catch(() => null);
    let purposeSet = false;
    if (purposeSelect) {
      // Try setting by option text
      const options = await imPage.evaluate(el => Array.from(el.options).map((o, i) => ({ i, text: o.text })), purposeSelect).catch(() => []);
      const importOpt = options.find(o => o.text.toLowerCase().includes('import'));
      if (importOpt !== undefined) {
        await imPage.evaluate((el, idx) => { el.selectedIndex = idx; el.dispatchEvent(new Event('change', { bubbles: true })); }, purposeSelect, importOpt.i);
        purposeSet = true;
      }
    }
    if (!purposeSet) {
      // Try ng-select / custom dropdown
      const purposeDrop = await imPage.$x('//*[contains(text(), "Select payment purpose") or contains(text(), "Payment Purpose")]').catch(() => []);
      if (purposeDrop.length > 0) {
        await purposeDrop[0].click();
        await imPage.waitForTimeout(800);
        const importOpt = await imPage.$x('//*[contains(text(), "Import Payments")]').catch(() => []);
        if (importOpt.length > 0) {
          await importOpt[0].click();
          purposeSet = true;
        }
      }
    }
    if (!purposeSet) {
      ss = await imPage.screenshot({ encoding: 'base64' });
      await imVisionClick(ss, 'Click the "Payment Purpose" dropdown and select "Import Payments" from the list');
    }
    console.log('[SparkP2P] I&M: Payment purpose set to Import Payments');
    await imPage.waitForTimeout(500);

    // ── STEP 11: Click Continue ────────────────────────────────────────────────
    const continueBtn = await imPage.$x('//button[contains(text(), "Continue")]').catch(() => []);
    if (continueBtn.length > 0) {
      await continueBtn[0].click();
    } else {
      await imPage.click('button[type="submit"], button.btn-primary').catch(() => {});
    }
    console.log('[SparkP2P] I&M: Clicked Continue');
    await imPage.waitForTimeout(3000);

    // ── STEP 12: Review modal — verify beneficiary name then click Submit ──────
    ss = await imPage.screenshot({ encoding: 'base64' });
    const reviewCheck = await imVisionVerify(
      ss,
      `This is the "Local Transfer - Review" confirmation modal.
      Read the Account Name shown under "Beneficiary bank details".
      Expected account name contains: "${EXPECTED_NAME || autoFilledName}".
      Does the Account Name in the modal match?
      Respond JSON only: { "match": true/false, "found_name": "name you read", "description": "brief" }`
    );

    if (reviewCheck && reviewCheck.match === false) {
      console.log(`[SparkP2P] ⚠️ Review modal name mismatch! Expected "${EXPECTED_NAME}", found "${reviewCheck.found_name}" — discarding`);
      const discardBtn = await imPage.$x('//button[contains(text(), "Discard")]').catch(() => []);
      if (discardBtn.length > 0) await discardBtn[0].click().catch(() => {});
      throw new Error(`Account name mismatch at review: expected "${EXPECTED_NAME}", got "${reviewCheck.found_name}"`);
    }
    console.log(`[SparkP2P] I&M: Review verified (${reviewCheck?.found_name || 'confirmed'}) — submitting`);

    // Click Submit
    const submitBtn = await imPage.$x('//button[contains(text(), "Submit")]').catch(() => []);
    if (submitBtn.length > 0) {
      await submitBtn[0].click();
    } else {
      await imPage.click('button[type="submit"]').catch(() => {});
    }
    console.log('[SparkP2P] I&M: Clicked Submit');
    await imPage.waitForTimeout(2000);

    // ── STEP 13: Identity Validation — enter PIN then click Complete ───────────
    await imPage.waitForSelector('input[type="password"], input[placeholder*="PIN" i]', { timeout: 10000 });
    const pinInput = await imPage.$('input[type="password"], input[placeholder*="PIN" i]').catch(() => null);
    if (!pinInput) throw new Error('PIN input not found');
    await pinInput.click();
    await pinInput.type(imPin, { delay: 80 });
    console.log('[SparkP2P] I&M: Entered PIN');
    await imPage.waitForTimeout(500);

    const completeBtn = await imPage.$x('//button[contains(text(), "Complete")]').catch(() => []);
    if (completeBtn.length > 0) {
      await completeBtn[0].click();
    } else {
      await imPage.click('button[type="submit"]').catch(() => {});
    }
    console.log('[SparkP2P] I&M: Clicked Complete');
    await imPage.waitForTimeout(4000);

    // ── STEP 14: Verify success screen ────────────────────────────────────────
    ss = await imPage.screenshot({ encoding: 'base64' });
    const successCheck = await imVisionVerify(
      ss,
      `Does this screen show "Payment Success" or a green success confirmation?
      Also extract the Reference ID or transaction number if visible.
      Respond JSON only: { "success": true/false, "reference": "ref number or null", "description": "brief" }`
    );

    if (successCheck && successCheck.success) {
      console.log(`[SparkP2P] ✅ I&M local transfer KES ${job.amount} → ${TO_ACCOUNT} SUCCESS — ref: ${successCheck.reference || 'N/A'}`);
      const closeBtn = await imPage.$x('//button[contains(text(), "Close")]').catch(() => []);
      if (closeBtn.length > 0) await closeBtn[0].click().catch(() => {});
      await imPage.waitForTimeout(1000);

      // Notify backend of success
      await fetch(`${API_BASE}/ext/bank-withdrawal-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ tx_id: job.id, reference: successCheck.reference }),
      }).catch(() => {});
    } else {
      throw new Error(`Payment success not detected: ${successCheck?.description || 'unknown state'}`);
    }

  } catch (e) {
    console.log('[SparkP2P] I&M local transfer error:', e.message);
    await fetch(`${API_BASE}/ext/bank-withdrawal-failed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ tx_id: job.id, error: e.message }),
    }).catch(() => {});
  } finally {
    imWithdrawalRunning = false;
    await syncImCookies();
  }
}

// Poll VPS every 30s for pending bank withdrawals and execute them
setInterval(async () => {
  if (!token || !imPage || imPage.isClosed() || imWithdrawalRunning) return;
  try {
    const res = await fetch(`${API_BASE}/ext/pending-bank-withdrawals`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.jobs && data.jobs.length > 0) {
      console.log(`[SparkP2P] ${data.jobs.length} pending I&M withdrawal(s) found — executing first`);
      const job = data.jobs[0];
      // Own-account transfer for owner's personal account; local transfer for all other traders
      if (job.destination_account === '00108094726050' && !job.destination_name) {
        await executeImWithdrawal(job);
      } else {
        await executeImLocalTransfer(job);
      }
    }
  } catch (e) {}
}, 30 * 1000);

// ═══════════════════════════════════════════════════════════
// M-PESA ORG PORTAL AUTOMATION
// Automates org.ke.m-pesa.com to sweep funds from paybill 4041355
// → linked I&M Bank account (FREE — "No charge" confirmed in portal)
// Same approach as I&M Bank: real Chrome tab, cookie persistence, Vision
// ═══════════════════════════════════════════════════════════

const MPESA_ORG_URL = 'https://org.ke.m-pesa.com';
const MPESA_ORG_REVENUE_URL = 'https://org.ke.m-pesa.com/#/mainPage/businessCenter/settlement/revenueSettlement/initiate';
const MPESA_ORG_INITIATE_URL = 'https://org.ke.m-pesa.com/#/mainPage/transactionCenter/initiate/initiateTransaction/list';
const MPESA_ORG_KEEP_ALIVE_INTERVAL = 5 * 60 * 1000; // ping every 5 min
let mpesaOrgKeepAliveTimer = null;

async function connectMpesaPortal() {
  if (connectingMpesa) return;
  connectingMpesa = true;
  console.log('[SparkP2P] Opening M-PESA org portal tab...');
  try {
    // Ensure main browser is running — launch if needed
    if (!browser) {
      await launchChrome(MPESA_ORG_URL);
      await connectPuppeteer();
      if (!browser) { connectingMpesa = false; return; }
    }

    // Reuse existing M-PESA org tab if already open
    const pages = await browser.pages();
    const existing = pages.find(p => p.url().includes('org.ke.m-pesa.com'));
    if (existing) {
      mpesaOrgPage = existing;
    } else {
      mpesaOrgPage = await browser.newPage();
      await mpesaOrgPage.goto(MPESA_ORG_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    }
    await mpesaOrgPage.bringToFront();
    mpesaOrgPage.on('close', () => { mpesaOrgPage = null; });

    // Poll until Vision confirms user is logged into M-PESA org dashboard
    let attempts = 0;
    let verifying = false;
    const check = setInterval(async () => {
      attempts++;
      if (attempts > 600) { clearInterval(check); connectingMpesa = false; return; } // 10 min timeout
      if (!mpesaOrgPage || mpesaOrgPage.isClosed()) { clearInterval(check); connectingMpesa = false; return; }
      if (verifying) return;
      verifying = true;
      try {
        const url = mpesaOrgPage.url();
        // Skip obvious auth pages without Vision call
        if (!url.includes('org.ke.m-pesa.com')) { verifying = false; return; }

        const ss = await mpesaOrgPage.screenshot({ encoding: 'base64' });
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 50,
            messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ss } },
              { type: 'text', text: 'Is this the M-PESA organization portal dashboard (logged in, showing menu/accounts/transactions)? Or is it a login page? Reply with only: LOGGED_IN or LOGIN_PAGE' },
            ]}],
          }),
        });
        const data = await response.json();
        const verdict = (data.content?.[0]?.text || '').trim().toUpperCase();
        console.log(`[SparkP2P] M-PESA portal Vision check: ${verdict}`);
        verifying = false;

        if (verdict === 'LOGGED_IN') {
          clearInterval(check);
          console.log('[SparkP2P] M-PESA portal login confirmed! Starting keep-alive...');
          startMpesaOrgKeepAlive();
          startPaybillSync();
          // Lock ALL bot-controlled tabs (sets browserLocked = true and injects overlay on all pages)
          await lockChromeBrowser().catch(() => {});
          connectingMpesa = false;
          // Mark connected in backend
          if (token) {
            await fetch(`${API_BASE}/traders/connect-mpesa-portal`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
              body: JSON.stringify({ connected: true }),
            }).catch(() => {});
          }
          mainWindow?.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("mpesa-portal-connected"))').catch(() => {});
        }
      } catch (e) { verifying = false; }
    }, 3000);
  } catch (e) {
    console.log('[SparkP2P] M-PESA portal connect error:', e.message);
    connectingMpesa = false;
  }
}

function startMpesaOrgKeepAlive() {
  if (mpesaOrgKeepAliveTimer) clearInterval(mpesaOrgKeepAliveTimer);
  mpesaOrgKeepAliveTimer = setInterval(async () => {
    if (!mpesaOrgPage || mpesaOrgPage.isClosed()) return;
    try {
      // Silent keep-alive: navigate to home page to reset session timer
      // Avoid navigating away from initiate page if a sweep is in progress
      if (!mpesaSweepRunning) {
        await mpesaOrgPage.evaluate(() => {
          // Trigger a lightweight XHR instead of full navigation
          fetch('/mainPage', { method: 'HEAD' }).catch(() => {});
        }).catch(() => {});
      }
      console.log('[SparkP2P] M-PESA portal keep-alive sent');
    } catch (e) {}
  }, MPESA_ORG_KEEP_ALIVE_INTERVAL);
}

// ── Paybill Statement Scraper ─────────────────────────────────────────────────
// Navigates to the M-PESA org portal statement/history page, uses Claude Vision
// to extract all visible transactions, and pushes them to the backend.
// Runs every 30 min when the portal is connected.

const MPESA_ORG_STATEMENT_URL = 'https://org.ke.m-pesa.com/#/mainPage/transactionCenter/statement/statementQuery';
let paybillSyncTimer = null;

async function scrapePaybillStatement() {
  if (!mpesaOrgPage || mpesaOrgPage.isClosed() || mpesaSweepRunning) return;
  if (!anthropicApiKey) { console.log('[PaybillSync] No Anthropic key, skipping'); return; }
  try {
    console.log('[PaybillSync] Navigating to statement page...');
    await mpesaOrgPage.goto(MPESA_ORG_STATEMENT_URL, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 4000));

    // Use Vision to understand the page and extract transactions
    const screenshot = await mpesaOrgPage.screenshot({ type: 'jpeg', quality: 80 });
    const base64 = screenshot.toString('base64');

    const visionRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
            { type: 'text', text: `This is the M-PESA Org Portal statement/transaction history page.
Extract ALL visible transactions from the table. For each row extract:
- mpesa_ref: the M-PESA reference/receipt number (e.g. "QGH1234XYZ")
- direction: "inbound" if money came IN to the paybill (C2B, deposit), "outbound" if money went OUT (withdrawal, B2B, payment)
- amount: numeric amount in KES (no commas)
- phone: phone number or account involved
- counterparty_name: name of the other party
- balance_after: account balance after transaction (numeric, if shown)
- transaction_type: e.g. "C2B", "B2B", "Withdrawal", "Settlement"
- remarks: description or remarks column
- transaction_at: date and time as ISO string (e.g. "2026-04-12T10:30:00+03:00")

If this is a date filter/query form (not a results table), return {"transactions": [], "needs_query": true}.
If no transactions visible, return {"transactions": []}.
Return ONLY valid JSON: {"transactions": [...]}` }
          ]
        }]
      })
    });

    const visionData = await visionRes.json();
    const rawText = visionData?.content?.[0]?.text || '';
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { console.log('[PaybillSync] No JSON from Vision'); return; }

    const parsed = JSON.parse(jsonMatch[0]);

    // If page is a query form, fill in date range and submit
    if (parsed.needs_query) {
      console.log('[PaybillSync] Statement page needs date query, attempting to fill...');
      // Try to fill date range via page evaluation or clicking
      const today = new Date().toISOString().split('T')[0];
      const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      // Use Vision to find and click "Query" or "Search" button
      await mpesaOrgPage.evaluate((start, end) => {
        const inputs = Array.from(document.querySelectorAll('input[type="date"], input[placeholder*="date"], input[placeholder*="Date"]'));
        if (inputs[0]) inputs[0].value = start;
        if (inputs[1]) inputs[1].value = end;
        const btn = Array.from(document.querySelectorAll('button')).find(b => /query|search|submit/i.test(b.textContent));
        if (btn) btn.click();
      }, monthAgo, today).catch(() => {});
      await new Promise(r => setTimeout(r, 3000));

      // Re-screenshot and extract
      const ss2 = await mpesaOrgPage.screenshot({ type: 'jpeg', quality: 80 });
      const b64_2 = ss2.toString('base64');
      const res2 = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2048,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64_2 } },
            { type: 'text', text: 'Extract all M-PESA transactions visible in this table. Return JSON: {"transactions": [{"mpesa_ref":"...","direction":"inbound|outbound","amount":0,"phone":"...","counterparty_name":"...","balance_after":null,"transaction_type":"...","remarks":"...","transaction_at":"ISO string"}]}' }
          ]}]
        })
      });
      const d2 = await res2.json();
      const t2 = d2?.content?.[0]?.text || '';
      const m2 = t2.match(/\{[\s\S]*\}/);
      if (m2) {
        try { parsed.transactions = JSON.parse(m2[0]).transactions || []; } catch (_) {}
      }
    }

    const transactions = (parsed.transactions || []).filter(t => t.mpesa_ref && t.amount);
    if (transactions.length === 0) { console.log('[PaybillSync] No transactions extracted'); return; }

    console.log(`[PaybillSync] Extracted ${transactions.length} transactions, pushing to backend...`);
    const pushRes = await fetch(`${API_BASE}/ext/sync-paybill-statement`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ transactions }),
    });
    const pushData = await pushRes.json();
    console.log(`[PaybillSync] Sync complete — inserted: ${pushData.inserted}, skipped: ${pushData.skipped}`);

  } catch (e) {
    console.error('[PaybillSync] Error:', e.message?.substring(0, 100));
  }
}

function startPaybillSync() {
  if (paybillSyncTimer) clearInterval(paybillSyncTimer);
  // Run immediately, then every 30 min
  scrapePaybillStatement();
  paybillSyncTimer = setInterval(scrapePaybillStatement, 30 * 60 * 1000);
  console.log('[PaybillSync] Statement sync started (every 30 min)');
}

// ── Shared helper: fill a form on the M-PESA org portal ──────────────────────
// Fills Amount(KSH), Remark, and Reason (Input Manually) on the current page,
// then clicks Submit. Used by both Revenue Settlement and Org Withdrawal steps.
async function _fillAndSubmitMpesaForm(page, amount, remark, reason) {
  // Fill Amount(KSH)
  const amountFilled = await page.evaluate((amt) => {
    const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="number"], input:not([type])'));
    for (const inp of inputs) {
      const nearText = (inp.placeholder || inp.name || inp.id || inp.getAttribute('aria-label') || inp.closest('div,td,tr,label')?.textContent || '').toLowerCase();
      if (nearText.includes('amount')) {
        inp.value = '';
        inp.focus();
        inp.value = String(amt);
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  }, amount).catch(() => false);

  if (!amountFilled) await fillFieldWithVision(page, 'Amount(KSH)', String(amount));
  console.log(`[SparkP2P] Amount filled: ${amountFilled}`);

  await new Promise(r => setTimeout(r, 300));

  // Fill Remark (textarea with placeholder "Remarks information for a transaction...")
  await page.evaluate((txt) => {
    const els = Array.from(document.querySelectorAll('textarea, input[type="text"]'));
    for (const el of els) {
      const hint = (el.placeholder || el.getAttribute('aria-label') || el.closest('div,td,tr')?.textContent || '').toLowerCase();
      if (hint.includes('remark')) {
        el.value = txt;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        break;
      }
    }
  }, remark).catch(() => {});

  await new Promise(r => setTimeout(r, 300));

  // Reason dropdown: "Input Manually..." is either already selected or needs clicking
  // The portal shows it pre-selected as a custom dropdown with value "Input Manually..."
  // Just make sure it's set, then fill the reason textarea below it
  await page.evaluate(() => {
    // For standard <select>
    const selects = Array.from(document.querySelectorAll('select'));
    for (const sel of selects) {
      const opts = Array.from(sel.options);
      const manual = opts.find(o => o.text.toLowerCase().includes('manual') || o.text.toLowerCase().includes('input'));
      if (manual) { sel.value = manual.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return; }
    }
    // For custom dropdown already showing "Input Manually..." — nothing to do
  }).catch(() => {});

  await new Promise(r => setTimeout(r, 400));

  // Fill the reason textarea / text input (labelled "Enter The Reason...")
  await page.evaluate((txt) => {
    const els = Array.from(document.querySelectorAll('textarea, input[type="text"]'));
    for (const el of els) {
      const hint = (el.placeholder || el.getAttribute('aria-label') || '').toLowerCase();
      if (hint.includes('reason') || hint.includes('enter the reason')) {
        el.value = txt;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
    }
    // Fallback: first visible empty textarea
    for (const el of els) {
      if (!el.value && el.offsetParent && el.tagName === 'TEXTAREA') {
        el.value = txt;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
    }
  }, reason).catch(() => {});

  await new Promise(r => setTimeout(r, 300));

  // Click Submit
  const submitted = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
    const btn = btns.find(b => (b.textContent.trim().toLowerCase() === 'submit' || b.value?.toLowerCase() === 'submit') && b.offsetParent);
    if (btn) { btn.click(); return true; }
    return false;
  }).catch(() => false);
  console.log(`[SparkP2P] Submit clicked: ${submitted}`);
  return submitted;
}

// ── Wait for "Operation succeeded." or "Transaction Budget" popup ─────────────
async function _waitForMpesaSuccess(page, screenshotLabel) {
  await new Promise(r => setTimeout(r, 3000));

  // Check for success message first
  const succeeded = await page.evaluate(() => {
    const body = document.body.innerText.toLowerCase();
    return body.includes('operation succeeded') || body.includes('successfully') || body.includes('success');
  }).catch(() => false);

  if (succeeded) {
    console.log(`[SparkP2P] ✅ ${screenshotLabel} — "Operation succeeded." detected`);
    await takeScreenshot(screenshotLabel + '_success', page);
    return true;
  }

  // Look for a "Continue" / "OK" popup (Transaction Budget confirmation)
  const popupClicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, a'));
    const btn = btns.find(b => ['continue', 'ok', 'confirm'].includes(b.textContent.trim().toLowerCase()) && b.offsetParent);
    if (btn) { btn.click(); return btn.textContent.trim(); }
    return null;
  }).catch(() => null);

  if (popupClicked) {
    console.log(`[SparkP2P] Popup button clicked: "${popupClicked}"`);
    await new Promise(r => setTimeout(r, 2000));
    await takeScreenshot(screenshotLabel + '_after_popup', page);
    return true;
  }

  // Vision fallback — check what's on screen
  if (anthropicApiKey) {
    const ss = await page.screenshot({ encoding: 'base64' });
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 80,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ss } },
          { type: 'text', text: 'Does this page show "Operation succeeded" or a success message? Or is there a popup with a button to click? Reply JSON: {"success": true/false, "popup_button": "button text or null"}' },
        ]}],
      }),
    }).catch(() => null);
    if (resp?.ok) {
      const vd = await resp.json().catch(() => ({}));
      const vt = (vd.content?.[0]?.text || '').replace(/```json?/g, '').replace(/```/g, '').trim();
      try {
        const vi = JSON.parse(vt.match(/\{[\s\S]*\}/)?.[0] || '{}');
        if (vi.success) { await takeScreenshot(screenshotLabel + '_vision_success', page); return true; }
        if (vi.popup_button) {
          await page.evaluate((txt) => {
            const b = Array.from(document.querySelectorAll('button,a')).find(el => el.textContent.trim().toLowerCase() === txt.toLowerCase());
            if (b) b.click();
          }, vi.popup_button).catch(() => {});
          console.log(`[SparkP2P] Vision clicked: "${vi.popup_button}"`);
          await new Promise(r => setTimeout(r, 1500));
          return true;
        }
      } catch (_) {}
    }
  }

  await takeScreenshot(screenshotLabel + '_unknown', page);
  return false;
}

// ── Full sweep: Step 1 Revenue Settlement + Step 2 Org Withdrawal ────────────
async function executeMpesaSweep(sweepJob) {
  // sweepJob = { sweep_id, amount, reference }
  if (mpesaSweepRunning) return { success: false, error: 'sweep_in_progress' };
  if (!mpesaOrgPage || mpesaOrgPage.isClosed()) {
    console.log('[SparkP2P] M-PESA org page not open — cannot execute sweep');
    return { success: false, error: 'portal_not_connected' };
  }
  mpesaSweepRunning = true;
  const { sweep_id, amount, reference } = sweepJob;
  console.log(`[SparkP2P] === M-PESA SWEEP KES ${amount} (sweep #${sweep_id}) ===`);

  try {
    // ── STEP 1: Revenue Settlement (utility float → working account) ────────
    // Business Center → Revenue Settlement → Initiate Revenue Settlement
    console.log('[SparkP2P] Step 1: Revenue Settlement...');
    await mpesaOrgPage.goto(MPESA_ORG_REVENUE_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));
    await takeScreenshot('sweep_step1_revenue_form', mpesaOrgPage);

    const step1Submitted = await _fillAndSubmitMpesaForm(mpesaOrgPage, amount, 'P2p Transactions', 'p2p trades');
    if (!step1Submitted) {
      console.log('[SparkP2P] Step 1: Submit not found — debug screenshot saved');
      mpesaSweepRunning = false;
      if (token) {
        await fetch(`${API_BASE}/ext/mpesa-sweep-failed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ sweep_id, error: 'Revenue Settlement submit not found' }),
        }).catch(() => {});
      }
      return { success: false, error: 'revenue_settlement_submit_not_found' };
    }

    const step1Ok = await _waitForMpesaSuccess(mpesaOrgPage, 'sweep_step1_revenue');
    console.log(`[SparkP2P] Step 1 result: ${step1Ok ? 'success' : 'unknown — proceeding anyway'}`);

    // Brief pause between steps so the portal processes the settlement
    await new Promise(r => setTimeout(r, 2000));

    // ── STEP 2: Organization Withdrawal (working account → I&M Bank) ────────
    // Transaction Center → Initiate Transaction → "Organization Withdrawal From MPESA-Real Time"
    console.log('[SparkP2P] Step 2: Organization Withdrawal...');
    await mpesaOrgPage.goto(MPESA_ORG_INITIATE_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));
    await takeScreenshot('sweep_step2_withdrawal_form', mpesaOrgPage);

    // Select "Organization Withdrawal From MPESA-Real Time" from Transaction Services dropdown
    const serviceSelected = await mpesaOrgPage.evaluate(() => {
      // Standard <select>
      for (const sel of document.querySelectorAll('select')) {
        const opts = Array.from(sel.options);
        const target = opts.find(o => o.text.toLowerCase().includes('organisation withdrawal') ||
                                      o.text.toLowerCase().includes('organization withdrawal') ||
                                      o.text.toLowerCase().includes('withdrawal from mpesa'));
        if (target) {
          sel.value = target.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return 'select:' + target.text;
        }
      }
      // Custom dropdown trigger
      for (const t of document.querySelectorAll('[class*="dropdown"],[class*="select"],[role="combobox"],[role="listbox"]')) {
        const txt = t.textContent.toLowerCase();
        if (txt.includes('service') || txt.includes('transaction') || txt.includes('select')) {
          t.click();
          return 'trigger_clicked';
        }
      }
      return null;
    }).catch(() => null);
    console.log(`[SparkP2P] Service dropdown: ${serviceSelected}`);

    if (serviceSelected === 'trigger_clicked') {
      await new Promise(r => setTimeout(r, 1500));
      await mpesaOrgPage.evaluate(() => {
        const opts = Array.from(document.querySelectorAll('li,[role="option"],[class*="option"]'));
        const t = opts.find(o => o.textContent.toLowerCase().includes('organisation withdrawal') ||
                                  o.textContent.toLowerCase().includes('organization withdrawal') ||
                                  o.textContent.toLowerCase().includes('withdrawal from mpesa'));
        if (t) t.click();
      }).catch(() => {});
    }

    await new Promise(r => setTimeout(r, 2000));

    const step2Submitted = await _fillAndSubmitMpesaForm(mpesaOrgPage, amount, 'P2p Transactions', 'p2p trades');
    if (!step2Submitted) {
      console.log('[SparkP2P] Step 2: Submit not found');
      mpesaSweepRunning = false;
      if (token) {
        await fetch(`${API_BASE}/ext/mpesa-sweep-failed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ sweep_id, error: 'Org Withdrawal submit not found' }),
        }).catch(() => {});
      }
      return { success: false, error: 'org_withdrawal_submit_not_found' };
    }

    // "Transaction Budget" popup shows "No charge." — click Continue
    const step2Ok = await _waitForMpesaSuccess(mpesaOrgPage, 'sweep_step2_withdrawal');
    console.log(`[SparkP2P] Step 2 result: ${step2Ok ? 'success' : 'unknown'}`);

    // Report to backend
    if (token) {
      await fetch(`${API_BASE}/ext/mpesa-sweep-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ sweep_id, amount, reference }),
      }).catch(() => {});
    }

    console.log(`[SparkP2P] ✅ M-PESA sweep KES ${amount} complete (Revenue Settlement + Org Withdrawal)`);
    mpesaSweepRunning = false;
    return { success: true };

  } catch (e) {
    console.error('[SparkP2P] executeMpesaSweep error:', e.message?.substring(0, 80));
    await takeScreenshot('mpesa_sweep_error', mpesaOrgPage).catch(() => {});
    if (token) {
      await fetch(`${API_BASE}/ext/mpesa-sweep-failed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ sweep_id, error: e.message }),
      }).catch(() => {});
    }
    mpesaSweepRunning = false;
    return { success: false, error: e.message };
  }
}

// Helper: use Vision to find a field by label and type a value
async function fillFieldWithVision(page, fieldLabel, value) {
  try {
    const ss = await page.screenshot({ encoding: 'base64' });
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ss } },
          { type: 'text', text: `Find the input field labelled "${fieldLabel}" on this page. Reply JSON: {"selector": "best CSS selector for this input or null", "found": true/false}` },
        ]}],
      }),
    });
    const data = await resp.json();
    const text = (data.content?.[0]?.text || '').replace(/```json?/g, '').replace(/```/g, '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const info = JSON.parse(match[0]);
      if (info.found && info.selector) {
        await page.click(info.selector).catch(() => {});
        await page.evaluate((sel, val) => {
          const el = document.querySelector(sel);
          if (el) { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }
        }, info.selector, value).catch(() => {});
        console.log(`[SparkP2P] Vision filled "${fieldLabel}" via ${info.selector}`);
      }
    }
  } catch (e) {}
}

// Poll VPS every 30s for pending M-PESA sweeps and execute them
setInterval(async () => {
  if (!token || !mpesaOrgPage || mpesaOrgPage.isClosed() || mpesaSweepRunning) return;
  try {
    const res = await fetch(`${API_BASE}/ext/pending-mpesa-sweeps`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.sweeps && data.sweeps.length > 0) {
      console.log(`[SparkP2P] ${data.sweeps.length} pending M-PESA sweep(s) found — executing first`);
      await executeMpesaSweep(data.sweeps[0]);
    }
  } catch (e) {}
}, 30 * 1000);

// IPC
ipcMain.handle('connect-binance', () => { connectBinance(); return { opened: true }; });
ipcMain.handle('connect-im', () => { connectIm(); return { opened: true }; });
ipcMain.handle('connect-mpesa', () => { connectMpesaPortal(); return { opened: true }; });
ipcMain.handle('unlock-browser', async () => { await unlockChromeBrowser(); console.log('[SparkP2P] Browser manually unlocked'); return { ok: true }; });
ipcMain.handle('lock-browser', async () => { const p = await getPage(); if (p) await lockChromeBrowser(); return { ok: true }; });
ipcMain.handle('pause-navigation', async () => { pauseNavigation = true; scanningInProgress = false; await unlockChromeBrowser(); startPauseInactivityTimer(); console.log('[SparkP2P] Navigation PAUSED — Chrome unlocked for manual use'); return { ok: true }; });
ipcMain.handle('resume-navigation', async () => { pauseNavigation = false; clearPauseInactivityTimer(); await lockChromeBrowser(); console.log('[SparkP2P] Navigation RESUMED — Chrome locked back to bot'); return { ok: true }; });
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
ipcMain.handle('save-im-pin', (_, pin) => { saveImPin(pin); return { ok: true }; });
ipcMain.handle('clear-im-pin', () => { clearImPin(); return { ok: true }; });
ipcMain.handle('has-im-pin', () => ({ hasPin: !!imPin }));
ipcMain.handle('set-totp-secret', (_, secret) => { totpSecret = secret ? secret.toUpperCase().replace(/\s/g, '') : null; console.log('[SparkP2P] TOTP secret configured'); return { ok: true }; });
ipcMain.handle('set-ai-key', (_, key) => { aiApiKey = key; console.log('[SparkP2P] AI key set (legacy)'); return { ok: true }; });
ipcMain.handle('set-anthropic-key', (_, key) => { anthropicApiKey = key; saveAnthropicKey(key); aiScanner.initAI(key); console.log('[SparkP2P] Claude configured and saved to disk'); return { ok: true }; });
ipcMain.handle('get-bot-status', () => ({ running: pollerRunning, stats, hasPin: !!traderPin, hasTOTP: !!totpSecret, hasAI: !!anthropicApiKey, hasVision: !!anthropicApiKey, version: app.getVersion() }));
ipcMain.handle('take-screenshot', async () => { const ss = await takeScreenshot('Manual request'); return { screenshot: ss }; });
ipcMain.handle('run-ai-scan', async () => { await aiScan(); return { ok: true }; });
ipcMain.handle('restart-app', () => { autoUpdater.quitAndInstall(); });
