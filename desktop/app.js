const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, clipboard, safeStorage, dialog, powerMonitor, screen: electronScreen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { execFile, execSync } = require('child_process');
const puppeteer = require('puppeteer-core');
const aiScanner = require('./ai-scanner');
let autoUpdater = null; // lazy-loaded inside checkForUpdates() after app is ready

// â"€â"€ Local control server on port 9223 â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
// Lets the Settings panel pause/resume via fetch() â€" works even in packaged app
http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/activity' && req.method === 'POST') {
    // Chrome page detected mouse/keyboard activity â€" reset the pause inactivity timer
    resetPauseTimerOnActivity();
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === '/pause') {
    pauseNavigation = true;
    scanningInProgress = false;
    await unlockChromeBrowser().catch(() => {}); // Give user access to Chrome
    startPauseInactivityTimer();
    // Attach activity listeners to all open Chrome pages so mouse movement resets the timer
    const pages = browser ? await browser.pages().catch(() => []) : [];
    for (const p of pages) attachActivityListenerToPage(p);
    console.log('[SparkP2P] Bot PAUSED â€" Chrome unlocked for manual use, auto-resume in 3 minutes');
    sendBotLog('warning', 'Bot paused — Chrome unlocked for manual use');
    res.end(JSON.stringify({ ok: true, paused: true }));
  } else if (req.url === '/resume') {
    pauseNavigation = false;
    clearPauseInactivityTimer();
    await lockChromeBrowser().catch(() => {}); // Bot takes Chrome back
    mainWindow?.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("bot-resumed"))').catch(() => {});
    console.log('[SparkP2P] Bot RESUMED â€" Chrome locked back to bot');
    sendBotLog('success', 'Bot resumed — Chrome locked back to bot');
    res.end(JSON.stringify({ ok: true, paused: false }));
  } else if (req.url === '/status') {
    res.end(JSON.stringify({
      paused: pauseNavigation,
      running: pollerRunning,
      version: app.getVersion(),
      imConnected: !!(typeof imPage !== 'undefined' && imPage && !imPage.isClosed()),
      mpesaConnected: !!(typeof mpesaOrgPage !== 'undefined' && mpesaOrgPage && !mpesaOrgPage.isClosed()),
    }));
  } else {
    res.end(JSON.stringify({ ok: false }));
  }
}).listen(9223, '127.0.0.1', () => {
  console.log('[SparkP2P] Local control server on http://127.0.0.1:9223');
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Another instance is already running â€" kill it and retry after 2s
    console.log('[SparkP2P] Port 9223 in use â€" killing old instance and retrying...');
    const { exec } = require('child_process');
    const killCmd = process.platform === 'win32'
      ? 'for /f "tokens=5" %a in (\'netstat -aon ^| findstr :9223\') do taskkill /F /PID %a'
      : 'fuser -k 9223/tcp';
    exec(killCmd, () => {});
  } else {
    console.error('[SparkP2P] Local server error:', err.message);
  }
});

// Logging â€" use app data folder when packaged, __dirname when dev
const logDir = app.isPackaged ? path.join(process.env.APPDATA || process.env.HOME, 'sparkp2p') : __dirname;
try { fs.mkdirSync(logDir, { recursive: true }); } catch (e) {}
const logFile = path.join(logDir, 'sparkp2p.log');
try { fs.writeFileSync(logFile, ''); } catch (e) {}
const _log = console.log, _err = console.error;
console.log = (...a) => { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${a.join(' ')}\n`); _log(...a); };
console.error = (...a) => { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ERR: ${a.join(' ')}\n`); _err(...a); };

const API_BASE = 'https://sparkp2p.com/api';
const DASHBOARD_URL = 'https://sparkp2p.com/dashboard';

// â"€â"€ Persistent paid-orders store â€" survives bot restarts â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
const paidOrdersFile = path.join(logDir, 'paid_orders.json');
function loadPaidOrders() {
  try { return JSON.parse(fs.readFileSync(paidOrdersFile, 'utf8')); } catch (e) { return {}; }
}
function savePaidOrder(orderNum, data) {
  try {
    const store = loadPaidOrders();
    store[orderNum] = { ...data, paidAt: Date.now() };
    fs.writeFileSync(paidOrdersFile, JSON.stringify(store, null, 2));
  } catch (e) { console.error('[SparkP2P] Could not save paid order:', e.message); }
}
function removePaidOrder(orderNum) {
  try {
    const store = loadPaidOrders();
    delete store[orderNum];
    fs.writeFileSync(paidOrdersFile, JSON.stringify(store, null, 2));
  } catch (e) {}
}

// ── Unified per-order flag store — every boolean survives bot restarts ──────────
// Tracks: greetingSent, approvalRequested, paymentFailed, postPaymentMsgSent,
//         markPaidDone, reminderSent — keyed by orderNumber.
const orderFlagsFile = path.join(logDir, 'order_flags.json');
function _loadOrderFlags() {
  try { return JSON.parse(fs.readFileSync(orderFlagsFile, 'utf8')); } catch(e) { return {}; }
}
function _saveOrderFlag(orderNum, flag, value) {
  try {
    const store = _loadOrderFlags();
    if (!store[orderNum]) store[orderNum] = {};
    store[orderNum][flag] = value;
    fs.writeFileSync(orderFlagsFile, JSON.stringify(store, null, 2));
  } catch(e) { console.error('[SparkP2P] Could not save order flag:', e.message); }
}
function _removeOrderFlags(orderNum) {
  try {
    const store = _loadOrderFlags();
    delete store[orderNum];
    fs.writeFileSync(orderFlagsFile, JSON.stringify(store, null, 2));
  } catch(e) {}
}


// ── Persistent reported-completed-buy store — prevents duplicate SMS across restarts ──
const reportedCompletedFile = path.join(logDir, 'reported_completed.json');
function loadReportedCompleted() {
  try { return JSON.parse(fs.readFileSync(reportedCompletedFile, 'utf8')); } catch (e) { return []; }
}
function saveReportedCompleted(numSet) {
  try {
    const arr = [...numSet];
    const trimmed = arr.slice(Math.max(0, arr.length - 1000)); // keep last 1000
    fs.writeFileSync(reportedCompletedFile, JSON.stringify(trimmed));
  } catch (e) {}
}

const CDP_PORT = 9222;
const POLL_INTERVAL_ACTIVE = 10000; // 10 seconds â€" cycle through all active orders
const POLL_INTERVAL_IDLE   = 5000;  // 15 seconds â€" no orders, scan faster

let mainWindow = null;
let tray = null;
let token = null;
let traderIsAdmin = false; // Set after login — gates M-PESA portal auto-open to admin accounts only
let browser = null;
let pollerRunning = false;
let pollTimer = null;
let stats = { polls: 0, actions: 0, errors: 0, orders: 0 };
let traderPin = null;    // Binance fund/trading password â€" stored in memory only
let totpSecret = null;   // Google Authenticator base32 secret â€" stored in memory only
let traderAccountNumber = null; // e.g. "P2PT0001" â€" used in paybill payment replies
let traderChoiceAccountNumber = null; // Choice Bank account number (e.g. CMB00001) — shown to buyers for PesaLink
let traderChoiceAccountId = null;     // Choice Bank internal account ID — used as payer for BUY transfers
let traderPhoneNumber = null;  // Trader's own phone number â€" included in buy greeting message
let traderImAccount = null;    // Trader's I&M settlement account number â€" used to select debit account
const DEV_UNLOCK = false; // true = no CSS overlay on browser tabs
const DEV_FORCE_NAME_MISMATCH = false; // true = simulate name mismatch (TEST ONLY)
const BOT_DISABLED = false; // set to true to disable automation
const LOCK_TIMEOUT_SECS = 5 * 60; // 5 minutes inactivity before screen locks
let screenLocked = false;
let browserLocked = false;
let lockFrameListener = null;
let lockGmailFrameListener = null;
let lockImFrameListener = null;
let lockMpesaFrameListener = null;
let overlayWindow = null;       // Transparent Electron window that blocks Chrome mouse input
let overlayPositionTimer = null; // Interval that keeps overlay synced to Chrome window position
let overlayActive = false;      // True only while overlay should be visible — guards against async race re-show
let _criClient = null;           // Persistent chrome-remote-interface connection for window bounds
let chromeProcess = null; // Child process reference for killing Chrome on quit
let chromeGeneration = 0; // Incremented each launch â€" old exit handlers check this to avoid nuking new connections
const codeFallbackAskedOrders = new Set(); // Order numbers we've already asked buyer to type M-Pesa code (avoid spamming)
const svAuthDoneOrders = new Set(); // Orders where Auth App (TOTP) step completed â€" next SV targets Email
const verifiedOrders = new Map(); // orderNumber → { code, totalPrice } â€" verified on first visit, released on second visit
const partialPayments = {}; // orderNumber → [{code, amount}] â€" accumulates payments across polls for consolidation
const orderChatHistory = new Map(); // orderNumber → [{role, content}] — per-order AI conversation history
const _chatMonitorExposed = new WeakSet(); // Puppeteer page objects that have had exposeFunction registered
const lastDeficitSent = {}; // orderNumber → deficit amount last messaged â€" prevents spamming same deficit twice
const sellApprovalRequestedOrders = new Set(); // sell orderNums where Telegram approval request was sent
const sellApprovedOrders = new Set();           // sell orderNums approved by merchant via Telegram
const sellRejectedOrders = new Set();           // sell orderNums rejected or timed-out by merchant
const buyApprovalRequestedOrders = new Set();   // buy orderNums where Telegram approval has been requested
const buyDeclineMsgSent = new Set();            // buy orderNums where the polite excuse was sent to seller
const buyPaymentDetailsCache = {};              // orderNum → paymentDetails extracted from Binance API
const sellRejectionMsgSent = new Set();         // sell orderNums where the polite cancel request was already sent
const sellPayInstructSentOrders = new Set();    // sell orderNums where payment instructions sent to buyer
const lastSellDeficitMsg = {};                  // orderNum → KES deficit last sent to buyer (dedup)
let codeFallbackAskedForOrder = null; // Legacy single-order reference (kept for monitorActiveOrder compat)
let pauseNavigation = false;    // When true, bot pauses all polling/navigation so user can use Chrome freely
let botTradeMode = 'both';      // 'both' | 'buy_only' | 'sell_only' — fetched from backend on start
let ddEnabled = false;          // Counterparty screening on/off
let botFullAuto = false;        // Strict full-auto: auto-reject failed orders, no manual approval
let ddMin30d = 20;              // Tier 1: minimum 30-day trade count
let ddMinAll = 0;               // Tier 2: minimum all-time trade count (0 = off)
let ddAutoCancelNew = false;    // Auto-cancel accounts with <5 all-time trades
let cfEnabled = false;          // Binance ad counterparty filters on/off
let cfMin30d = 0;               // Min trades in last 30D (app-level enforcement)
let cfMinAll = 0;               // Min trades all-time (app-level enforcement)
let connectingBinance = false; // Prevents concurrent connectBinance() calls
let scanningInProgress = false; // Prevents concurrent initialScan() calls
let sessionStartTime = null;   // When Binance login was last confirmed
let loggedOutStrikes = 0;      // Consecutive failed isLoggedIn() checks before re-login
let activeOrderNumber = null;     // Sell order currently being released (guards auto-cancel protection)
let activeOrderFiatAmount = 0;    // KES amount of the sell order being released
let activeBuyOrderNumber = null;  // Last buy order processed (kept for compat)
// Per-order tracking dictionaries â€" supports multiple concurrent orders
const orderFirstSeenAt = {};        // { orderNum: timestamp } â€" when we first detected this order
const orderReminderSent = new Set(); // sell orderNums where we already sent the 1-min "Hi, are you there?" reminder
const orderLastBotReplyAt = {};      // orderNum → timestamp (ms) of last bot reply in awaiting state (for buyer-question detection)
const buyPaymentSentAt = {};        // { orderNum: timestamp } â€" when I&M payment was sent for this buy order
const buyReminderSentOrders = new Set(); // buy orderNums where we sent the 10-min reminder to seller
const buyOrderDetailsMap = {};       // { orderNum: { sellerName, amount, phone, method } } â€" for chat/dispute
const imPaymentDoneMap = {};         // { orderNum: { screenshot, referenceId } } â€" I&M payment done, skip on retry
const imPaymentFailedOrders = new Set(); // orderNums where I&M payment failed all retries — skip until order clears
const reportedCompletedBuyOrders = new Set();  // order numbers already sent as completed_buy_order_numbers — prevents duplicate SMS
const reportedCompletedSellOrders = new Set(); // order numbers already sent as completed_sell_order_numbers — prevents duplicate SMS
const buyGreetingSentOrders = new Set();    // orderNums where greeting was already sent
const buyPostPaymentMsgSentOrders = new Set(); // orderNums where "I have sent KSh..." was already sent
const markPaidDoneOrders = new Set();          // orderNums where EP-17 mark-paid was already called — skip on restart
// Restore paid orders from disk on startup (survives bot restarts)
{
  const _paidOnDisk = loadPaidOrders();
  const _nums = Object.keys(_paidOnDisk);
  _nums.forEach(num => {
    imPaymentDoneMap[num] = _paidOnDisk[num];
    buyGreetingSentOrders.add(num);
    buyPostPaymentMsgSentOrders.add(num);
    // Restore payment-sent tracking so ghost detection and dispute timeouts survive restarts.
    // Only restore orders paid within the last 24 hours to avoid stale tracking.
    const paidAt = _paidOnDisk[num]?.paidAt || 0;
    if (paidAt && Date.now() - paidAt < 24 * 60 * 60 * 1000) {
      buyPaymentSentAt[num] = paidAt;
    }
  });
  if (_nums.length) console.log(`[SparkP2P] Restored ${_nums.length} paid order(s) from disk: ${_nums.join(', ')}`);
}
// Restore buy order state (greeting sent + approval requested) from disk on startup
  const _flags = _loadOrderFlags();
  Object.entries(_flags).forEach(([num, f]) => {
    if (f.greetingSent)        buyGreetingSentOrders.add(num);
    if (f.approvalRequested)   buyApprovalRequestedOrders.add(num);
    if (f.paymentFailed)       imPaymentFailedOrders.add(num);
    if (f.postPaymentMsgSent)  buyPostPaymentMsgSentOrders.add(num);
    if (f.markPaidDone)        markPaidDoneOrders.add(num);
    if (f.reminderSent)        buyReminderSentOrders.add(num);
  });
  const _restored = Object.keys(_flags).length;
  if (_restored) console.log(`[SparkP2P] Restored order flags for ${_restored} order(s) from disk`);
// Restore completed buy orders from disk — prevents duplicate SMS when bot restarts
{
  const _completedOnDisk = loadReportedCompleted();
  _completedOnDisk.forEach(n => reportedCompletedBuyOrders.add(n));
  if (_completedOnDisk.length) console.log(`[SparkP2P] Restored ${_completedOnDisk.length} completed buy order(s) from disk (duplicate SMS guard)`);
}
let buyPaymentScreenshot = null;  // Base64 screenshot of I&M success â€" uploaded to Binance chat
let gmailPage = null;          // Persistent Gmail tab â€" opened alongside Binance, kept alive
let imPage = null;             // Persistent I&M Bank tab â€" new tab in the main Binance browser
let connectingIm = false;      // Prevents concurrent connectIm() calls
let imWithdrawalRunning = false; // Prevents concurrent withdrawal executions
let mpesaOrgPage = null;       // Persistent M-PESA org portal tab
let connectingMpesa = false;   // Prevents concurrent connectMpesaPortal() calls
let mpesaPortalReady = false;  // True only after Vision confirms LOGGED_IN — gates sweep execution
let mpesaSweepRunning = false; // Prevents concurrent sweep executions
let lastSweepCompletedAt = 0;  // Timestamp of last completed sweep (ms) — enforces cooldown
let pauseInactivityTimer = null; // Auto-resume timer when bot is paused
const PAUSE_AUTO_RESUME_MS = 3 * 60 * 1000; // 3 minutes

// ── Bot Activity Logs ─────────────────────────────────────────────────────────
const BOT_LOG_MAX = 400;
const botLogBuffer = [];

function sanitizeLog(msg) {
  if (typeof msg !== 'string') msg = String(msg);
  return msg
    .replace(/\b(0\d{2})\d{5}(\d{3})\b/g, '$1XXXXX$2')           // Kenyan phone: 07XX XXXXX 123
    .replace(/\b(254\d{2})\d{5}(\d{3})\b/g, '$1XXXXX$2')          // +254 format
    .replace(/\b(\d{4})\d{4,8}(\d{4})\b/g, '$1XXXX$2')            // Bank account / long numbers
    .replace(/(pin|PIN|password|secret|token|otp|totp|code)([:\s=]+)\S+/gi, '$1$2[hidden]')
    .replace(/\[TOTP[^\]]*\]/gi, '[TOTP hidden]');
}

function sendBotLog(level, message) {
  const entry = { level, message: sanitizeLog(message), time: new Date().toISOString() };
  botLogBuffer.push(entry);
  if (botLogBuffer.length > BOT_LOG_MAX) botLogBuffer.shift();
  mainWindow?.webContents.send('bot-log', entry);
}

function startPauseInactivityTimer() {
  clearPauseInactivityTimer();
  pauseInactivityTimer = setTimeout(async () => {
    if (!pauseNavigation) return; // already resumed
    console.log('[SparkP2P] 3 minute pause elapsed â€" auto-resuming and locking all screens');
    pauseNavigation = false;
    await lockChromeBrowser().catch(() => {});
    mainWindow?.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("bot-resumed", { detail: { reason: "inactivity" } }))').catch(() => {});
  }, PAUSE_AUTO_RESUME_MS);
}

function clearPauseInactivityTimer() {
  if (pauseInactivityTimer) { clearTimeout(pauseInactivityTimer); pauseInactivityTimer = null; }
}

// Any mouse/keyboard activity on the Electron window OR Chrome pages resets the 60s timer
function resetPauseTimerOnActivity() {
  if (pauseNavigation && pauseInactivityTimer) {
    startPauseInactivityTimer(); // reset the 60s countdown
  }
}

// Attach mouse-move listener to a Chrome page so user activity resets the pause timer
function attachActivityListenerToPage(page) {
  if (!page || page.isClosed()) return;
  page.evaluate(() => {
    if (window.__sparkActivityBound) return;
    window.__sparkActivityBound = true;
    ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'].forEach(evt => {
      window.addEventListener(evt, () => {
        // Post a message to the local bot server so Node.js can reset the timer
        fetch('http://127.0.0.1:9223/activity', { method: 'POST' }).catch(() => {});
      }, { passive: true });
    });
  }).catch(() => {});
}
const SESSION_GRACE_MS = 30 * 60 * 1000; // 30 min grace period before re-login is allowed
const LOGOUT_STRIKES_NEEDED = 3;          // Require 3 consecutive failures before declaring session lost
// Load .env file for API keys â€" check app data folder and app directory
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

// Persist Anthropic API key to disk â€" survives restarts without needing backend fetch
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

// â"€â"€ I&M Bank PIN â€" stored ONLY on this device using OS-level encryption â"€â"€
// â"€â"€ Session cookie persistence for I&M and M-Pesa portals â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
// Saves session cookies to disk after login so reconnects don't require re-login
const IM_COOKIES_FILE = path.join(app.getPath('userData'), 'im_session.json');
const MPESA_COOKIES_FILE = path.join(app.getPath('userData'), 'mpesa_session.json');

function saveImCookiesLocal(cookies) {
  try { fs.writeFileSync(IM_COOKIES_FILE, JSON.stringify(cookies)); } catch (e) {}
}
function loadImCookiesLocal() {
  try { return JSON.parse(fs.readFileSync(IM_COOKIES_FILE, 'utf8')); } catch (e) { return null; }
}
function saveMpesaCookiesLocal(cookies) {
  try { fs.writeFileSync(MPESA_COOKIES_FILE, JSON.stringify(cookies)); } catch (e) {}
}
function loadMpesaCookiesLocal() {
  try { return JSON.parse(fs.readFileSync(MPESA_COOKIES_FILE, 'utf8')); } catch (e) { return null; }
}

async function restoreCookiesToPage(page, cookies, url) {
  if (!cookies || !cookies.length) return false;
  try {
    await page.goto('about:blank').catch(() => {});
    for (const c of cookies) {
      await page.setCookie(c).catch(() => {});
    }
    console.log(`[SparkP2P] Restored ${cookies.length} session cookies`);
    return true;
  } catch (e) { return false; }
}

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

function saveGmailCredentials(email, appPassword) {
  try {
    const data = JSON.stringify({ email, appPassword });
    const encrypted = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(data) : Buffer.from(data);
    fs.writeFileSync(path.join(app.getPath('userData'), 'gmail-creds.enc'), encrypted);
    console.log('[SparkP2P] Gmail credentials saved');
  } catch (e) { console.error('[SparkP2P] saveGmailCredentials error:', e.message); }
}

function loadGmailCredentials() {
  try {
    const p = path.join(app.getPath('userData'), 'gmail-creds.enc');
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p);
    const data = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString();
    return JSON.parse(data);
  } catch (e) { return null; }
}

function clearGmailCredentials() {
  try {
    const p = path.join(app.getPath('userData'), 'gmail-creds.enc');
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) {}
}

// Load PIN on startup (after app is ready â€" safeStorage requires app to be ready)
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
if (token) {
  console.log('[SparkP2P] Session restored from disk');
  sendBotLog('info', 'App started — previous session restored');
} else {
  sendBotLog('info', 'App started — please log in');
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// ELECTRON
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

app.whenReady().then(() => {
  createMainWindow();
  createTray();
  aiScanner.initAI(anthropicApiKey);
  checkForUpdates();
  startRelayAgent();   // execute this trader's Binance calls from THIS machine's IP
});

// ═══════════════════════════════════════════════════════════════════
// PER-TRADER BINANCE RELAY AGENT
// The VPS is geo-blocked by Binance, so it hands this trader's signed Binance requests to this
// machine (the trader's own residential IP) to execute. The VPS signs everything; we only forward
// the request to Binance (host pinned) and return the response. Runs only while logged in.
// ═══════════════════════════════════════════════════════════════════
const BINANCE_API_BASE = 'https://api.binance.com';
let relayAgentRunning = false;

// Execute a relay job with Node's http/https — unlike Electron's main-process fetch (Chromium),
// this sends the Cookie header, which is required for cookie-authenticated Binance calls (chat).
function relayNodeRequest(urlObj, method, headers, bodyObj) {
  return new Promise((resolve) => {
    const mod = urlObj.protocol === 'http:' ? require('http') : require('https');
    const data = (bodyObj !== null && bodyObj !== undefined) ? JSON.stringify(bodyObj) : null;
    const h = { ...headers };
    if (data && !Object.keys(h).some(k => k.toLowerCase() === 'content-length')) {
      h['Content-Length'] = Buffer.byteLength(data);
    }
    const opts = {
      method, hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'http:' ? 80 : 443),
      path: urlObj.pathname + urlObj.search, headers: h,
    };
    const req = mod.request(opts, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => { try { resolve(JSON.parse(chunks)); } catch { resolve(chunks); } });
    });
    req.on('error', (e) => resolve({ code: 'RELAY_EXEC_ERROR', msg: String(e && e.message ? e.message : e) }));
    req.setTimeout(20000, () => { try { req.destroy(); } catch {} resolve({ code: 'RELAY_EXEC_ERROR', msg: 'timeout' }); });
    if (data) req.write(data);
    req.end();
  });
}

async function startRelayAgent() {
  if (relayAgentRunning) return;
  relayAgentRunning = true;
  const nap = ms => new Promise(r => setTimeout(r, ms));
  for (;;) {
    if (!token) { await nap(3000); continue; }
    let job = null;
    try {
      const r = await fetch(`${API_BASE}/ext/relay/poll`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (r.ok) { const d = await r.json(); if (d && d.job_id) job = d; }
      else { await nap(2000); continue; }
    } catch { await nap(2000); continue; }
    if (!job) continue;   // no job within the long-poll window — re-poll immediately

    let respBody = null;
    try {
      const url = new URL((job.host || BINANCE_API_BASE) + job.path);   // host override (e.g. p2p.binance.com for cookie chat-send)
      const params = job.params || {};
      for (const k of Object.keys(params)) url.searchParams.set(k, String(params[k]));
      const headers = {};
      for (const [k, v] of Object.entries(job.headers || {})) {
        if (/^x-relay-/i.test(k)) continue;   // relay-only headers don't go to Binance
        headers[k] = v;
      }
      // Use Node's https (NOT Electron's Chromium fetch, which silently strips the Cookie header)
      // so cookie-authenticated calls actually carry the session.
      respBody = await relayNodeRequest(url, job.method || 'POST', headers, job.body);
    } catch (e) {
      respBody = { code: 'RELAY_EXEC_ERROR', msg: String(e && e.message ? e.message : e) };
    }
    try {
      await fetch(`${API_BASE}/ext/relay/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ job_id: job.job_id, body: respBody }),
      });
    } catch { /* VPS will time the job out; next poll continues */ }
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// AUTO-UPDATE â€" checks GitHub Releases for new versions
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

let updateReadyToInstall = false;

function checkForUpdates() {
  try { autoUpdater = require('electron-updater').autoUpdater; } catch (e) { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false; // handled manually so app.quit() path works correctly

  autoUpdater.on('update-available', (info) => {
    console.log(`[SparkP2P] Update available: v${info.version} — downloading in background`);
    if (mainWindow) {
      mainWindow.webContents.executeJavaScript(
        `window.dispatchEvent(new CustomEvent('sparkp2p-update-downloading', { detail: { version: '${info.version}', percent: 0 } }))`
      ).catch(() => {});
    }
  });

  autoUpdater.on('download-progress', (p) => {
    const pct = Math.round(p.percent);
    console.log(`[SparkP2P] Update download progress: ${pct}%`);
    if (mainWindow) {
      mainWindow.webContents.executeJavaScript(
        `window.dispatchEvent(new CustomEvent('sparkp2p-update-downloading', { detail: { percent: ${pct} } }))`
      ).catch(() => {});
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateReadyToInstall = true;
    console.log(`[SparkP2P] Update downloaded: v${info.version} — will install on next restart`);
    if (mainWindow) {
      // Dispatch event to React UI so it can show a non-blocking banner
      mainWindow.webContents.executeJavaScript(
        `window.dispatchEvent(new CustomEvent('sparkp2p-update-ready', { detail: { version: '${info.version}' } }))`
      ).catch(() => {});
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    console.log(`[SparkP2P] App is up to date: v${info.version}`);
    if (mainWindow) {
      mainWindow.webContents.executeJavaScript(
        `window.dispatchEvent(new CustomEvent('sparkp2p-up-to-date', { detail: { version: '${info.version}' } }))`
      ).catch(() => {});
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

let isQuitting = false;
app.on('before-quit', (event) => {
  if (isQuitting) return; // second before-quit from app.quit() below — let it proceed to will-quit
  isQuitting = true;
  event.preventDefault();
  stopPoller();
  killChrome();
  if (browser) { try { browser.disconnect(); } catch(e) {} browser = null; }
  if (tray) tray.destroy();

  // Tell the backend the bot stopped intentionally so offline alerts are suppressed
  const notifyAndExit = async () => {
    if (token) {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 3000);
      try {
        await fetch(`${API_BASE}/ext/bot-stopped`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
          signal: controller.signal,
        });
      } catch (e) {}
      clearTimeout(t);
    }
    if (updateReadyToInstall && autoUpdater) {
      autoUpdater.quitAndInstall(false, true); // install silently and relaunch
    } else {
      app.quit(); // normal exit — isQuitting guard prevents re-entry, will-quit fires cleanly
    }
  };
  notifyAndExit();
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

  // ── "Continue with Google" → open the user's SYSTEM browser (where they're already signed in)
  // instead of an in-app window. Mirrors the mobile flow: open /api/auth/google?platform=app&sid=…
  // externally, poll /api/auth/google/result, then load /login?google_token=… back into the app.
  const _origin = (DASHBOARD_URL.match(/^https?:\/\/[^/]+/) || ['https://sparkp2p.com'])[0];
  const isGoogleOAuthTrigger = (u) => {
    if (!u) return false;
    // our own external call already carries platform=app, and the result poll is a fetch (not a nav)
    if (/\/api\/auth\/google(\b|\/|\?)/.test(u) && !u.includes('platform=app') && !u.includes('/google/result')) return true;
    try { if (/(^|\.)accounts\.google\.com$/.test(new URL(u).hostname)) return true; } catch {}
    return false;
  };
  let _googleOAuthInFlight = false;
  const startExternalGoogleOAuth = () => {
    if (_googleOAuthInFlight) return;
    _googleOAuthInFlight = true;
    const sid = (() => { try { return require('crypto').randomUUID(); } catch { return Date.now() + '' + Math.random().toString(36).slice(2); } })();
    shell.openExternal(`${_origin}/api/auth/google?platform=app&sid=${encodeURIComponent(sid)}`);
    console.log('[SparkP2P] Google sign-in opened in your browser — waiting for you to choose an account…');
    let tries = 0;
    const poll = setInterval(async () => {
      tries++;
      if (tries > 150 || !mainWindow || mainWindow.isDestroyed()) { clearInterval(poll); _googleOAuthInFlight = false; return; }
      try {
        const r = await fetch(`${_origin}/api/auth/google/result?sid=${encodeURIComponent(sid)}`);
        if (r.ok) {
          const d = await r.json().catch(() => null);
          if (d && d.google_token) {
            clearInterval(poll); _googleOAuthInFlight = false;
            console.log('[SparkP2P] Google sign-in complete — logging in');
            mainWindow.loadURL(`${_origin}/login?google_token=${encodeURIComponent(d.google_token)}`);
          }
        }
      } catch {}
    }, 2000);
  };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isGoogleOAuthTrigger(url)) { startExternalGoogleOAuth(); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (isGoogleOAuthTrigger(url)) { e.preventDefault(); startExternalGoogleOAuth(); }
  });

  const loadDashboard = (attempt = 1) => {
    mainWindow.loadURL(DASHBOARD_URL + '?v=' + Date.now()).catch(() => {});
  };

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    // -3 = ERR_ABORTED â€" fires on normal SPA navigations, ignore it
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
  let userConfirmedClose = false;
  mainWindow.on('close', async (e) => {
    if (userConfirmedClose) return; // user already confirmed — let the close proceed
    e.preventDefault();
    const { response, checkboxChecked } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Terminate Session',
      message: 'You are about to terminate your session',
      detail: 'All other trades from here on will be completed manually.',
      checkboxLabel: 'Yes, I understand',
      checkboxChecked: false,
      buttons: ['Cancel', 'Close App'],
      defaultId: 0,
      cancelId: 0,
    });
    if (response === 1 && checkboxChecked) {
      userConfirmedClose = true;
      app.quit();
    } else if (response === 1 && !checkboxChecked) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Confirmation Required',
        message: 'Please tick "Yes, I understand" before closing.',
        buttons: ['OK'],
      });
    }
  });
  // Reset pause inactivity timer on any user activity in the app window
  mainWindow.webContents.on('before-input-event', () => resetPauseTimerOnActivity());
  mainWindow.on('focus', () => {
    resetPauseTimerOnActivity();
    if (screenLocked && mainWindow && !mainWindow.isDestroyed()) {
      setTimeout(() => injectLockOverlay(), 150);
    }
  });

  // Capture token on every page load and navigation
  const captureToken = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.executeJavaScript('localStorage.getItem("token")')
      .then((t) => {
        if (t && t !== token) {
          token = t;
          saveTokenToDisk(t);
          console.log('[SparkP2P] Token captured and saved');
          sendBotLog('success', 'Logged in to SparkP2P account');
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
    // Re-inject lock overlay if screen was locked before navigation
    if (screenLocked) {
      setTimeout(() => { if (screenLocked && mainWindow && !mainWindow.isDestroyed()) injectLockOverlay(); }, 800);
    }
  });
  mainWindow.webContents.on('did-navigate-in-page', captureToken);
  // Also poll for token every 5 seconds (catches SPA login) â€" cleared on window destroy
  const captureInterval = setInterval(captureToken, 5000);
  mainWindow.once('destroyed', () => { clearInterval(captureInterval); clearInterval(lockCheckInterval); });

  // ── Inactivity screen lock ────────────────────────────────────────────────
  function injectLockOverlay() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const script = '(function(){'
      + 'if(document.getElementById("sp2p-lock"))return;'
      + 'var el=document.createElement("div");'
      + 'el.id="sp2p-lock";'
      + 'el.style.cssText="position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(6,6,18,0.90);backdrop-filter:blur(28px);-webkit-backdrop-filter:blur(28px);font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif";'
      + 'el.innerHTML=\'<div style="background:#0f1623;border:1px solid #1f2937;border-radius:20px;padding:48px 40px;text-align:center;max-width:380px;width:90%;box-shadow:0 32px 80px rgba(0,0,0,0.85)">'
      + '<div style="font-size:56px;margin-bottom:12px">🔒</div>'
      + '<div style="font-size:22px;font-weight:700;color:#f59e0b;margin-bottom:8px">Session Locked</div>'
      + '<div style="font-size:13px;color:#6b7280;margin-bottom:28px;line-height:1.6">5 minutes of inactivity.<br>Enter your Google Authenticator<br>code to resume.</div>'
      + '<input id="sp2p-lock-code" type="text" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="one-time-code" style="width:100%;padding:16px;font-size:28px;letter-spacing:12px;text-align:center;background:#1f2937;border:2px solid #374151;border-radius:12px;color:#fff;outline:none;box-sizing:border-box;margin-bottom:8px">'
      + '<div id="sp2p-lock-err" style="min-height:20px;font-size:13px;color:#ef4444;margin-bottom:12px"></div>'
      + '<button id="sp2p-lock-btn" style="width:100%;padding:14px;background:#f59e0b;color:#000;font-weight:700;font-size:16px;border:none;border-radius:12px;cursor:pointer">Unlock</button>'
      + '<div style="margin-top:20px;font-size:11px;color:#2d3748">SparkP2P — Automated P2P Trading</div>'
      + '</div>\';'
      + 'document.body.appendChild(el);'
      + 'var inp=document.getElementById("sp2p-lock-code");'
      + 'var btn=document.getElementById("sp2p-lock-btn");'
      + 'var err=document.getElementById("sp2p-lock-err");'
      + 'inp.focus();'
      + 'function tryUnlock(){'
      +   'var code=inp.value.replace(/[^0-9]/g,"");'
      +   'if(code.length!==6){err.textContent="Enter the 6-digit code from Google Authenticator";return;}'
      +   'btn.disabled=true;btn.textContent="Verifying…";err.textContent="";'
      +   'window.sparkp2p.verifyLockTotp(code).then(function(ok){'
      +     'if(ok){el.remove();}'
      +     'else{err.textContent="Incorrect code — try again";inp.value="";inp.focus();btn.disabled=false;btn.textContent="Unlock";}'
      +   '}).catch(function(){err.textContent="Verification error — try again";btn.disabled=false;btn.textContent="Unlock";});'
      + '}'
      + 'btn.addEventListener("click",tryUnlock);'
      + 'inp.addEventListener("keydown",function(e){if(e.key==="Enter")tryUnlock();});'
      + 'inp.addEventListener("input",function(){inp.value=inp.value.replace(/[^0-9]/g,"");if(inp.value.length===6)tryUnlock();});'
      + '})();';
    mainWindow.webContents.executeJavaScript(script).catch(() => {});
  }

  const lockCheckInterval = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || screenLocked || !token) return;
    const idleSecs = powerMonitor.getSystemIdleTime();
    if (idleSecs >= LOCK_TIMEOUT_SECS) {
      screenLocked = true;
      console.log(`[SparkP2P] Screen locked after ${idleSecs}s system inactivity`);
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      injectLockOverlay();
    }
  }, 30000); // check every 30 seconds

  // Intercept WebSocket remote browser â€" open Chrome instead (only if not already connecting/connected)
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
        label: pauseNavigation ? 'â–¶ Resume Bot' : 'â¸ Pause Bot',
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
            console.log('[SparkP2P] Bot PAUSED via tray â€" Chrome unlocked for manual use');
          }
          tray.setContextMenu(buildTrayMenu());
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
    ]);

    tray.setContextMenu(buildTrayMenu());
    tray.on('double-click', () => mainWindow.show());

    // Global shortcut Ctrl+Shift+P â€" pause/resume bot from anywhere
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
        console.log('[SparkP2P] Bot PAUSED via shortcut â€" Chrome unlocked for manual use');
      }
      tray.setContextMenu(buildTrayMenu());
    });
  } catch (e) {}
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// CHROME â€" Launch once, keep open forever.
// User logs in once. Session stays alive.
// Bot reads the page like a human â€" no API hacking.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function findChrome() {
  for (const p of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ]) { if (fs.existsSync(p)) return p; }
  return null;
}

async function killChromeOnPort(port) {
  try {
    // Parse netstat output directly (no shell pipe needed â€" works without shell:true)
    const out = execSync('netstat -ano', { encoding: 'utf8' });
    const pids = new Set();
    for (const line of out.split('\n')) {
      // Match lines with our port as local address (e.g. "  TCP  0.0.0.0:9222  ...")
      if (line.includes(`:${port} `) || line.includes(`:${port}\t`)) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid);
      }
    }
    for (const pid of pids) {
      try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch (e) {}
    }
    if (pids.size > 0) {
      console.log(`[SparkP2P] Killed ${pids.size} stale process(es) on port ${port}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (e) {}
}

async function launchChrome(url) {
  const chrome = findChrome();
  if (!chrome) { console.error('Chrome not found'); return false; }

  // Bump generation FIRST â€" any exit handler from a previous Chrome will see a stale generation
  // and skip the browser.disconnect() call that would nuke our new connection
  chromeGeneration++;
  const myGeneration = chromeGeneration;

  // Kill any existing process on the CDP port
  await killChromeOnPort(CDP_PORT);

  // Remove Chrome's singleton lock files so the new instance can start cleanly
  const profileDir = path.join(app.getPath('userData'), 'chrome-binance');
  const sessionDir = path.join(profileDir, 'Default');
  ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].forEach(f => {
    try { fs.unlinkSync(path.join(profileDir, f)); } catch(e) {}
  });
  ['Current Session', 'Current Tabs', 'Last Session', 'Last Tabs'].forEach(f => {
    try { fs.unlinkSync(path.join(sessionDir, f)); } catch(e) {}
  });

  chromeProcess = execFile(chrome, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-features=MediaRouter',
    '--disable-backgrounding-occluded-windows', // prevent Chrome throttling GPU when overlay covers it
    '--user-data-dir=' + profileDir,
    url || 'https://accounts.binance.com/en/login',
  ]);
  chromeProcess.on('exit', () => {
    if (chromeGeneration !== myGeneration) {
      console.log('[SparkP2P] Old Chrome process exited (ignored)');
      return;
    }
    console.log('[SparkP2P] Chrome closed by user');
    chromeProcess = null;
    // Puppeteer fires 'disconnected' automatically when Chrome exits.
    // Give it 2 seconds; if it hasn't fired, manually trigger cleanup so
    // the overlay is dismissed and the UI shows "Binance Disconnected".
    setTimeout(() => {
      if (!browser) return; // 'disconnected' already fired — nothing to do
      console.log('[SparkP2P] Chrome exit: forcing cleanup (Puppeteer disconnect event did not fire)');
      hideOverlay(); // dismiss overlay immediately
      try { browser.disconnect(); } catch(e) {} // triggers 'disconnected' handler if possible
      // Final safety: if disconnect() also didn't clean up, do it directly
      setTimeout(() => {
        if (!browser) return;
        browser = null;
        stopPoller();
        browserLocked = false;
        connectingBinance = false;
        scanningInProgress = false;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("binance-disconnected"))').catch(() => {});
        }
      }, 1000);
    }, 2000);
  });
  console.log('[SparkP2P] Chrome launched');
  await new Promise(r => setTimeout(r, 8000)); // Give Chrome time to start and restore session
  return true;
}

async function connectPuppeteer() {
  try {
    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${CDP_PORT}`,
      defaultViewport: null,
    });
    // Enforce tab whitelist and one-tab-per-service rule.
    // maxTabs: 1 = enforce single tab; Infinity = allow any number (OAuth popups, etc.)
    const TAB_GROUPS = [
      { name: 'Binance',    domains: ['binance.com'],                            maxTabs: 1        },
      { name: 'Gmail',      domains: ['mail.google.com'],                        maxTabs: 1        },
      { name: 'GoogleAuth', domains: ['accounts.google.com', 'google.com'],      maxTabs: Infinity }, // OAuth popups — Binance and Gmail both open these
      { name: 'M-Pesa',     domains: ['org.ke.m-pesa.com'],                       maxTabs: 1       },
    ];

    // Match on hostname only (not full URL) to avoid false positives from
    // query params like ?continue=https://binance.com/... on Google OAuth pages.
    const hostMatches = (hostname, domains) =>
      domains.some(d => hostname === d || hostname.endsWith('.' + d));

    const enforceTabRules = async (page, url) => {
      if (!url || url === 'about:blank' || url === '' || url.startsWith('chrome://')) return;
      if (!browser || !page || page.isClosed()) return;
      try {
        let hostname;
        try { hostname = new URL(url).hostname; } catch { return; }

        const matchedGroup = TAB_GROUPS.find(g => hostMatches(hostname, g.domains));
        if (!matchedGroup) {
          await page.close();
          console.log(`[SparkP2P] Blocked unauthorised tab: ${url.substring(0, 80)}`);
          return;
        }

        // Allowed domain — enforce single-tab limit if maxTabs === 1
        if (matchedGroup.maxTabs === 1) {
          const allPages = await browser.pages().catch(() => []);
          const duplicate = allPages.filter(p => {
            if (p === page || p.isClosed()) return false;
            try { return hostMatches(new URL(p.url()).hostname, matchedGroup.domains); }
            catch { return false; }
          });
          if (duplicate.length > 0) {
            await page.close();
            console.log(`[SparkP2P] Blocked duplicate ${matchedGroup.name} tab: ${url.substring(0, 80)}`);
          }
        }
      } catch (e) {}
    };

    // ── Startup tab audit ─────────────────────────────────────────────────────
    // targetcreated only fires for NEW tabs. Audit existing tabs immediately on
    // connect so duplicates opened before the app started are also closed.
    (async () => {
      try {
        const allPages = await browser.pages().catch(() => []);
        // Group existing tabs by service
        const seen = new Map(); // group name → [page]
        for (const p of allPages) {
          const url = p.url();
          if (!url || url === 'about:blank' || url.startsWith('chrome://')) continue;
          let hostname;
          try { hostname = new URL(url).hostname; } catch { continue; }
          const group = TAB_GROUPS.find(g => hostMatches(hostname, g.domains));
          if (!group) {
            await p.close().catch(() => {});
            console.log(`[SparkP2P] Startup: closed unauthorised tab ${url.substring(0, 80)}`);
            continue;
          }
          if (group.maxTabs === Infinity) continue; // OAuth tabs — keep all
          if (!seen.has(group.name)) seen.set(group.name, []);
          seen.get(group.name).push(p);
        }
        // Keep only the first tab per service, close the rest
        for (const [groupName, pages] of seen) {
          for (const p of pages.slice(1)) {
            await p.close().catch(() => {});
            console.log(`[SparkP2P] Startup: closed duplicate ${groupName} tab`);
          }
        }
      } catch (e) {}
    })();

    browser.on('targetcreated', async (target) => {
      if (target.type() !== 'page') return;
      try {
        const page = await target.page();
        if (!page) return;
        const initialUrl = target.url();
        if (initialUrl && initialUrl !== 'about:blank' && initialUrl !== '') {
          await enforceTabRules(page, initialUrl);
        } else {
          // Tab starts as about:blank — wait for first real navigation.
          // Use page.on (not once) so redirects (e.g. OAuth → binance.com) are also caught.
          page.on('framenavigated', async (frame) => {
            if (frame !== page.mainFrame()) return;
            const url = frame.url();
            if (!url || url === 'about:blank') return;
            await enforceTabRules(page, url).catch(() => {});
          });
        }
      } catch (e) {}
    });

    // Catch URL changes on EXISTING tabs (e.g. OAuth redirect completing to binance.com)
    browser.on('targetchanged', async (target) => {
      if (target.type() !== 'page') return;
      try {
        const url = target.url();
        if (!url || url === 'about:blank' || url.startsWith('chrome://')) return;
        const page = await target.page();
        if (!page || page.isClosed()) return;
        await enforceTabRules(page, url).catch(() => {});
      } catch (e) {}
    });

    // This is the SINGLE cleanup handler — fires automatically when Chrome exits or CDP drops
    browser.on('disconnected', () => {
      console.log('[SparkP2P] Binance Chrome disconnected');
      sendBotLog('error', 'Binance disconnected — bot stopped');
      hideOverlay();
      browser = null;
      chromeProcess = null;
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
    // Log what pages are visible
    const pages = await browser.pages().catch(() => []);
    console.log(`[SparkP2P] Puppeteer connected â€" ${pages.length} page(s): ${pages.map(p => p.url().substring(0, 50)).join(' | ')}`);
    if (!browser) return false;
    // Zoom setup deferred â€" done after login detected to avoid triggering Chrome exit
    return true;
  } catch (e) {
    console.error('[SparkP2P] Puppeteer connect error:', e.message?.substring(0, 60));
    return false;
  }
}

// Per-page CDP sessions so Binance and I&M zoom sessions don't collide
const _zoomSessions = new WeakMap();
let _zoomSession = null; // kept for legacy references â€" mirrors last setZoom80 call

// Device-type zoom level: 0.5 for laptops, 0.8 for desktops/TVs
let _deviceZoomLevel = null;

async function getDeviceZoomLevel() {
  if (_deviceZoomLevel !== null) return _deviceZoomLevel;
  try {
    // Battery presence = laptop (most reliable check on Windows)
    const { execSync } = require('child_process');
    const out = execSync('powershell -NoProfile -Command "(Get-WmiObject -Class Win32_Battery | Measure-Object).Count"', { timeout: 5000, windowsHide: true }).toString().trim();
    if (parseInt(out) > 0) {
      _deviceZoomLevel = 0.5;
      console.log('[SparkP2P] Device: laptop detected (battery found) — zoom 50%');
      return _deviceZoomLevel;
    }
  } catch (_) {}
  try {
    // Fallback: screens narrower than 1920px are treated as laptop displays
    const { screen } = require('electron');
    const d = screen.getPrimaryDisplay();
    if (d.size.width < 1920) {
      _deviceZoomLevel = 0.5;
      console.log(`[SparkP2P] Device: small screen (${d.size.width}x${d.size.height}) — zoom 50%`);
      return _deviceZoomLevel;
    }
  } catch (_) {}
  _deviceZoomLevel = 0.8;
  console.log('[SparkP2P] Device: desktop/TV detected — zoom 80%');
  return _deviceZoomLevel;
}

async function setZoom80(page) {
  const zoomLevel = await getDeviceZoomLevel();
  try {
    let session = _zoomSessions.get(page);
    if (!session || !session._connection) {
      session = await page.createCDPSession();
      _zoomSessions.set(page, session);
    }
    _zoomSession = session; // keep global in sync
    await session.send('Emulation.setPageScaleFactor', { pageScaleFactor: zoomLevel });
  } catch (_) {
    _zoomSessions.delete(page);
    _zoomSession = null;
    try { await page.evaluate((z) => { document.documentElement.style.zoom = `${Math.round(z * 100)}%`; }, zoomLevel); } catch (__) {}
  }
}

async function resetZoom(page) {
  try {
    let session = _zoomSessions.get(page);
    if (!session || !session._connection) {
      session = await page.createCDPSession();
      _zoomSessions.set(page, session);
    }
    await session.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
  } catch (_) {
    try { await page.evaluate(() => { document.documentElement.style.zoom = '100%'; }); } catch (__) {}
  }
}

async function takeImSuccessScreenshot(page) {
  await resetZoom(page);
  await new Promise(r => setTimeout(r, 500));
  // Remove Angular Material dark backdrop so modal shows on a clear background
  await page.evaluate(() => {
    document.querySelectorAll('.cdk-overlay-backdrop, .cdk-overlay-dark-backdrop, .mat-drawer-backdrop').forEach(el => {
      el.style.display = 'none';
    });
  }).catch(() => {});
  await new Promise(r => setTimeout(r, 200));
  return page.screenshot({ encoding: 'base64' }).catch(() => null);
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
  // Wait for Gmail to finish loading before locking â€" injecting too early lets Gmail's own JS remove the overlay
  if (gmailPage && !gmailPage.isClosed()) {
    console.log('[SparkP2P] Waiting for Gmail to finish loading before locking...');
    await gmailPage.waitForNetworkIdle({ idleTime: 800, timeout: 4000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 500));
  }
  // Lock ALL bot-controlled tabs (sets browserLocked = true)
  await lockChromeBrowser().catch(() => {});
  console.log('[SparkP2P] Gmail locked successfully');
  // Re-fetch credentials in case the initial fetch failed (e.g. outage during startup)
  if (!traderImAccount) await fetchAndApplyCredentials().catch(() => {});

  // Return focus to Binance tab so the trader sees the trading interface
  try {
    const pages = await browser.pages();
    const binancePage = pages.find(p => p.url().includes('binance.com'));
    if (binancePage) await binancePage.bringToFront();
  } catch (e) {}

  const setup = await checkSetupComplete();
  if (setup.complete && !pollerRunning) {
    pauseNavigation = false;
    mainWindow.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("setup-complete"))').catch(() => {});
    console.log('[SparkP2P] All connections established â€" starting bot');
    await initialScan().catch(e => { scanningInProgress = false; console.error('[SparkP2P] Initial scan error:', e.message?.substring(0, 60)); });
    startPoller();
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
      console.log(`[SparkP2P] Gmail tab found â€" ${loggedIn ? 'confirmed logged in' : 'on login page'}`);
      if (loggedIn) { await onGmailConfirmed(); return true; }
      // Not logged in â€" start polling for login
      startGmailLoginPoller();
      return false;
    }
    // Open Gmail tab fresh
    gmailPage = await browser.newPage();
    await gmailPage.goto('https://mail.google.com/mail/u/0/#inbox', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    gmailPage.on('close', () => { gmailPage = null; });
    const loggedIn = await verifyGmailWithVision(gmailPage);
    console.log(`[SparkP2P] Gmail tab opened â€" ${loggedIn ? 'confirmed logged in' : 'needs login'}`);
    if (loggedIn) { await onGmailConfirmed(); return true; }
    // Not logged in â€" poll until user signs in
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
  if (!page) { console.log('[Login] No Binance page found'); return false; }
  try {
    const url = page.url();
    console.log(`[Login] Checking URL: ${url.substring(0, 80)}`);
    if (url.includes('accounts.binance.com')) return false;
    if (/\/(login|register|forgot-password|security-verify)/.test(url)) return false;
    if (url.includes('binance.com') && url.length > 20) {
      const hasLoginForm = await page.evaluate(() => {
        return !!(document.querySelector('input[type="password"][placeholder*="assword"]') ||
                  document.querySelector('button[data-bn-type="button"][type="submit"]') &&
                  document.querySelector('form') &&
                  document.querySelector('input[name="email"]'));
      }).catch(() => false);
      console.log(`[Login] hasLoginForm=${hasLoginForm} → result=${!hasLoginForm}`);
      return !hasLoginForm;
    }
    console.log('[Login] URL does not match binance.com pattern');
    return false;
  } catch (e) { return false; }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// BROWSER LOCK â€" Block user input on Chrome after login
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

async function injectLockOverlay(page) {
  if (DEV_UNLOCK) return { ok: true, dev: true };
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

        // Build badge with createElement â€" no innerHTML so Trusted Types (Gmail CSP) can't block it
        const badge = document.createElement('div');
        badge.style.cssText = 'position:fixed;bottom:16px;right:16px;display:flex;align-items:center;gap:8px;padding:8px 14px;background:rgba(0,0,0,0.82);border:1px solid rgba(245,158,11,0.5);border-radius:20px;backdrop-filter:blur(4px);pointer-events:none';
        const icon = document.createElement('span');
        icon.style.fontSize = '14px';
        icon.textContent = '\uD83D\uDD12'; // ðŸ"'
        const label = document.createElement('span');
        label.style.cssText = 'color:#f59e0b;font-size:12px;font-weight:600;font-family:-apple-system,sans-serif';
        label.textContent = 'SparkP2P Bot Active';
        badge.appendChild(icon);
        badge.appendChild(label);
        dlg.appendChild(badge);

        const block = e => { e.preventDefault(); e.stopImmediatePropagation(); };
        ['click','mousedown','mouseup','dblclick','contextmenu',
         'keydown','keyup','keypress','wheel','scroll','touchstart','touchend'
        ].forEach(t => dlg.addEventListener(t, block, true));
        dlg.close = () => {};
        // Append to DOM first, THEN showModal() â€" dialog must be in document before showModal
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
    if (!result.existing) console.log('[SparkP2P] Lock overlay injected:', JSON.stringify(result));
  } else {
    console.error('[SparkP2P] Lock overlay FAILED:', JSON.stringify(result));
  }
}

// ── Electron overlay window ───────────────────────────────────────────────────
// Sits on top of the Chrome window at the OS level — absorbs all mouse clicks
// without affecting Puppeteer (CDP uses a WebSocket, not OS input events).

async function getChromeBounds() {
  try {
    // Use chrome-remote-interface for a browser-level session — page-level CDP sessions
    // don't have access to Browser domain commands (getWindowForTarget / getWindowBounds).
    const CRI = require('chrome-remote-interface');
    if (!_criClient) {
      _criClient = await CRI({ port: CDP_PORT, local: true });
      _criClient.on('disconnect', () => { _criClient = null; });
    }
    const { targetInfos } = await _criClient.Target.getTargets();
    const pageTarget = targetInfos.find(t => t.type === 'page');
    if (!pageTarget) return null;
    const { windowId } = await _criClient.Browser.getWindowForTarget({ targetId: pageTarget.targetId });
    const { bounds } = await _criClient.Browser.getWindowBounds({ windowId });
    return bounds; // { left, top, width, height, windowState }
  } catch (e) {
    _criClient = null;
    return null;
  }
}

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return;
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;background:transparent;overflow:hidden;cursor:not-allowed;user-select:none;-webkit-app-region:no-drag}
#badge{position:fixed;bottom:20px;right:20px;display:flex;align-items:center;gap:8px;padding:8px 16px;background:rgba(0,0,0,0.85);border:1px solid rgba(245,158,11,0.6);border-radius:20px;backdrop-filter:blur(8px);pointer-events:none}
.icon{font-size:15px}.label{color:#f59e0b;font-size:12px;font-weight:600;font-family:-apple-system,BlinkMacSystemFont,sans-serif;white-space:nowrap}
</style></head><body>
<div id="badge"><span class="icon">🔒</span><span class="label">SparkP2P Bot Active</span></div>
</body></html>`;
  overlayWindow = new BrowserWindow({
    x: 0, y: 0, width: 1024, height: 768,
    frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, focusable: false, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, devTools: false },
  });
  // 'screen-saver' level keeps overlay above Chrome but below windows we manually elevate
  overlayWindow.setAlwaysOnTop(true, 'normal');
  overlayWindow.setIgnoreMouseEvents(false); // absorb clicks — do NOT pass through to Chrome
  overlayWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  overlayWindow.on('closed', () => { overlayWindow = null; });
}

async function showOverlay() {
  if (DEV_UNLOCK) return;
  overlayActive = true;
  createOverlayWindow();
  let bounds = await getChromeBounds();
  console.log('[SparkP2P] Overlay bounds from CDP:', JSON.stringify(bounds));
  if (!bounds) {
    // CDP bounds unavailable — fall back to right portion of primary display
    const { width, height } = electronScreen.getPrimaryDisplay().workAreaSize;
    bounds = { left: Math.round(width * 0.3), top: 0, width: Math.round(width * 0.7), height, windowState: 'normal' };
    console.log('[SparkP2P] Overlay using fallback bounds:', JSON.stringify(bounds));
  }
  if (overlayActive && bounds.windowState !== 'minimized') {
    overlayWindow.setBounds({ x: bounds.left || 0, y: bounds.top || 0, width: bounds.width || 1024, height: bounds.height || 768 });
    overlayWindow.showInactive();
    console.log('[SparkP2P] Overlay shown');
  }
  // Keep SparkP2P dashboard above the overlay so the trader can always pause/resume
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(true, 'floating');
    mainWindow.moveTop();
  }
  if (overlayPositionTimer) clearInterval(overlayPositionTimer);
  overlayPositionTimer = setInterval(async () => {
    if (!overlayActive) { clearInterval(overlayPositionTimer); overlayPositionTimer = null; return; }
    if (!overlayWindow || overlayWindow.isDestroyed()) { clearInterval(overlayPositionTimer); overlayPositionTimer = null; return; }
    const b = await getChromeBounds();
    if (!overlayActive) return; // hideOverlay() may have fired while awaiting bounds
    if (!b) return;
    if (b.windowState === 'minimized') { if (overlayWindow.isVisible()) overlayWindow.hide(); return; }
    overlayWindow.setBounds({ x: b.left || 0, y: b.top || 0, width: b.width || 1024, height: b.height || 768 });
    if (!overlayWindow.isVisible()) overlayWindow.showInactive();
  }, 500);
}

function hideOverlay() {
  overlayActive = false; // set first — stops async timer callbacks from re-showing
  if (overlayPositionTimer) { clearInterval(overlayPositionTimer); overlayPositionTimer = null; }
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
  // Restore mainWindow to normal stacking — no longer needs to float above overlay
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false);
}

let _lockInProgress = false;
async function lockChromeBrowser() {
  if (DEV_UNLOCK) { console.log('[SparkP2P] DEV_UNLOCK — browser lock skipped'); return; }
  if (_lockInProgress) return; // already locking — skip concurrent call
  _lockInProgress = true;
  browserLocked = true;
  await showOverlay();
  _lockInProgress = false;
  console.log('[SparkP2P] Chrome browser locked (Electron overlay active)');
}

async function unlockChromeBrowser() {
  browserLocked = false;
  hideOverlay();

  // Clear any leftover DOM overlays from the old approach (safety cleanup)
  const cleanDOM = async (page) => {
    if (!page || page.isClosed()) return;
    await page.evaluate(() => {
      const el = document.getElementById('sparkp2p-browser-lock');
      if (el) el.remove();
      if (window.__sparkLockInterval) { clearInterval(window.__sparkLockInterval); window.__sparkLockInterval = null; }
      if (window.__sparkLockObserver) { window.__sparkLockObserver.disconnect(); window.__sparkLockObserver = null; }
    }).catch(() => {});
  };
  const binancePage = await getPage('binance.com');
  if (binancePage && lockFrameListener) { binancePage.off('framenavigated', lockFrameListener); lockFrameListener = null; }
  if (gmailPage && !gmailPage.isClosed() && lockGmailFrameListener) { gmailPage.off('framenavigated', lockGmailFrameListener); lockGmailFrameListener = null; }
  if (imPage && !imPage.isClosed() && lockImFrameListener) { imPage.off('framenavigated', lockImFrameListener); lockImFrameListener = null; }
  if (mpesaOrgPage && !mpesaOrgPage.isClosed() && lockMpesaFrameListener) { mpesaOrgPage.off('framenavigated', lockMpesaFrameListener); lockMpesaFrameListener = null; }
  await cleanDOM(binancePage);
  await cleanDOM(gmailPage);
  await cleanDOM(imPage);
  await cleanDOM(mpesaOrgPage);

  console.log('[SparkP2P] Chrome browser unlocked');
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// CONNECT BINANCE â€" Open Chrome, wait for login, start bot
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

async function connectBinance() {
  if (connectingBinance || pollerRunning) return; // Already connecting or running
  connectingBinance = true;

  // Always do a clean Chrome relaunch — this restores saved session cookies just like
  // restarting the app does, avoiding stale Puppeteer connection issues.
  if (browser) { try { await browser.disconnect(); } catch(e) {} browser = null; }
  await launchChrome('https://accounts.binance.com/en/login');
  await connectPuppeteer();
  if (!browser) {
    console.error('[SparkP2P] Could not connect to Chrome â€" try clicking Connect Binance again');
    connectingBinance = false;
    return;
  }
  console.log('[SparkP2P] Puppeteer OK â€" checking login state immediately');
  if (await isLoggedIn()) {
    console.log('[SparkP2P] Session already restored â€" starting bot');
    await onLoginDetected();
    return;
  }
  console.log('[SparkP2P] Not logged in yet â€" waiting for login...');

  let attempts = 0;
  let detected = false; // Guard against duplicate login detection
  const check = setInterval(async () => {
    if (detected) return; // Already handling login
    attempts++;
    if (attempts > 300) {
      // 10 min passed with no login — do one more clean relaunch and restart the loop
      clearInterval(check);
      connectingBinance = false;
      console.log('[SparkP2P] Login wait timed out — relaunching Chrome and retrying');
      sendBotLog('warning', 'Binance login wait timed out — relaunching Chrome. Please log in.');
      connectBinance();
      return;
    }

    if (await isLoggedIn()) {
      if (detected) return; // Double-check after async
      detected = true;
      clearInterval(check);
      console.log('[SparkP2P] Login detected!');
      await onLoginDetected();
    }
  }, 2000);
}

async function onLoginDetected() {
  sessionStartTime = Date.now();
  loggedOutStrikes = 0;
  connectingBinance = false;

  await lockChromeBrowser();
  if (mainWindow) mainWindow.show();

  if (token) {
    fetch(`${API_BASE}/ext/heartbeat`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } }).catch(() => {});
    // Reset portal connection flags â€" they reflect live sessions, not persistent state
    fetch(`${API_BASE}/traders/disconnect-im`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } }).catch(() => {});
    fetch(`${API_BASE}/traders/disconnect-mpesa-portal`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } }).catch(() => {});
    // Determine if this trader is an admin — controls M-PESA portal auto-open
    try {
      const profileRes = await fetch(`${API_BASE}/traders/profile`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (profileRes.ok) {
        const profileData = await profileRes.json();
        traderIsAdmin = !!(profileData.is_admin);
        botTradeMode = profileData.bot_trade_mode || 'both';
        console.log(`[SparkP2P] Trader role: ${traderIsAdmin ? 'admin' : 'trader'}, trade mode: ${botTradeMode}`);
      }
    } catch (e) { traderIsAdmin = false; }
  }

  await fetchAndApplyCredentials();

  // Close extra tabs â€" keep Binance page and Chrome internal pages (chrome://)
  // IMPORTANT: pages[0] is not always Binance â€" Chrome internal popups can be index 0
  const _pages = await browser.pages().catch(() => []);
  const _binancePage = _pages.find(p => p.url().includes('binance.com'))
    || _pages.find(p => !p.url().startsWith('chrome://') && p.url() !== 'about:blank');
  for (const p of _pages) {
    if (p !== _binancePage && !p.url().startsWith('chrome://')) {
      await p.close().catch(() => {});
    }
  }
  if (_binancePage) {
    const _zl = await getDeviceZoomLevel();
    await _binancePage.evaluateOnNewDocument((z) => {
      document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.zoom = `${Math.round(z * 100)}%`; });
    }, _zl).catch(() => {});
    await setZoom80(_binancePage);
    _binancePage.on('load', () => setZoom80(_binancePage).catch(() => {}));
  }

  // Sync Binance cookies immediately so backend marks binance_connected = true
  await syncCookies();

  // Open Gmail tab (tab 2) — onGmailConfirmed() starts bot once Gmail is confirmed
  const gmailOk = await openGmailTab().catch(() => false);
  if (gmailOk) {
    console.log('[SparkP2P] Gmail ready — bot start handled by onGmailConfirmed');
  } else {
    console.log('[SparkP2P] Gmail not confirmed — starting bot in Binance-only mode (Gmail optional for OTP reads)');
    // Bot starts with Binance alone; Gmail login poller runs in background and will sync cookies when user signs in
    const setup = await checkSetupComplete();
    if (setup.complete && !pollerRunning) {
      mainWindow.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("setup-complete"))').catch(() => {});
        console.log('[SparkP2P] All connections established — starting bot');
        await initialScan().catch(e => { scanningInProgress = false; console.error('[SparkP2P] Initial scan error:', e.message?.substring(0, 60)); });
        startPoller();
    } else if (!setup.complete) {
      console.log('[SparkP2P] Setup incomplete:', setup.missing.join(', '));
    }
  }

  // Suppress window.open() on Binance pages (prevents popup tabs)
  const mainPage = await getPage();
  if (mainPage) {
    await mainPage.evaluateOnNewDocument(() => { window.open = () => null; }).catch(() => {});
  }
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
    const { verify_method, fund_password, totp_secret, anthropic_api_key, account_number, phone_number, im_account, choice_account_number, choice_account_id } = await res.json();
    if (account_number) { traderAccountNumber = account_number; console.log(`[SparkP2P] Account number: ${traderAccountNumber}`); }
    if (phone_number) { traderPhoneNumber = phone_number; console.log(`[SparkP2P] Trader phone: ${traderPhoneNumber}`); }
    if (im_account) { traderImAccount = im_account; console.log(`[SparkP2P] I&M debit account: ${traderImAccount}`); }
    if (choice_account_number) { traderChoiceAccountNumber = choice_account_number; console.log(`[SparkP2P] Choice Bank account: ${traderChoiceAccountNumber}`); }
    if (choice_account_id) { traderChoiceAccountId = choice_account_id; console.log(`[SparkP2P] Choice Bank account ID: ${traderChoiceAccountId}`); }
    console.log(`[SparkP2P] Credentials: verify_method=${verify_method} has_totp=${!!totp_secret} has_pin=${!!fund_password}`);
    if (totp_secret) {
      totpSecret = totp_secret.toUpperCase().replace(/\s/g, '');
      console.log('[SparkP2P] TOTP secret loaded from backend');
    } else if (fund_password) {
      traderPin = fund_password;
      console.log('[SparkP2P] Fund password loaded from backend');
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

// Check that Binance is connected (Gmail and I&M Bank are both optional)
async function checkSetupComplete() {
  if (!token) return { complete: false, missing: ['binance'] };
  try {
    const res = await fetch(`${API_BASE}/traders/me`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) return { complete: false, missing: [] };
    const profile = await res.json();
    const missing = [];
    if (!profile.binance_connected) missing.push('Binance');
    // Gmail and I&M Bank are optional — bot runs without them; Gmail only needed for OTP reads
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
  console.log(`[SparkP2P] Bot paused â€" missing connections: ${missing.join(', ')}`);
  sendBotLog('warning', `Setup incomplete — waiting for: ${missing.join(', ')}`);
}

async function tryAutoStart() {
  if (!token) return;
  if (browser) return; // Already connected

  await fetchAndApplyCredentials(); // Load TOTP/PIN from backend

  // Try to connect to an existing Chrome on port 9222 â€" no launch delay
  try {
    if (await connectPuppeteer()) {
      if (await isLoggedIn()) {
        console.log('[SparkP2P] Auto-connected to existing Chrome â€" starting bot');
        connectingBinance = true; // onLoginDetected() expects this to be true so it can reset it
        await onLoginDetected();
        return;
      }
      // Connected but not on Binance â€" disconnect cleanly
      try { await browser.disconnect(); } catch(e) {}
      browser = null;
    }
  } catch (e) {}

  console.log('[SparkP2P] No active Binance session â€" click Connect Binance to start');
  sendBotLog('warning', 'No active Binance session — click Connect Binance to start');
}

function checkInactivityTimeout() {
  if (!pollerRunning) return;
  const elapsed = Date.now() - lastActiveTime;
  if (elapsed > INACTIVITY_TIMEOUT) {
    console.log('[SparkP2P] 6 hours inactive â€" logging out for security');
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

// Silently refresh JWT every 20 minutes â€" prevents session expiry without re-login
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
        console.log('[SparkP2P] Token refreshed â€" session extended 30 days');
        sendBotLog('info', 'Session refreshed — login extended');
      }
    }
  } catch (e) {}
}, 20 * 60 * 1000);

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// INITIAL SCAN â€" First thing after login:
// 1. Profile page → get username
// 2. Funding wallet → get funding USDT balance
// 3. Spot wallet → get spot USDT balance
// 4. Upload everything to VPS
// 5. Navigate to P2P ads page and keep browser there
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

async function verifyTraderIdentity(page) {
  if (!token) return;
  try {
    // Navigate to P2P My Ads â€" payment methods here show the real account holder name
    await page.goto('https://p2p.binance.com/en/advertise/post-new?side=SELL&tradeType=SELL', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 4000));

    const pageText = await page.evaluate(() => {
      const overlay = document.getElementById('sparkp2p-browser-lock');
      const overlayText = overlay ? overlay.innerText : '';
      return document.body.innerText.replace(overlayText, '');
    }).catch(() => '');

    if (!pageText) return;

    let realName = '';
    const idLines = pageText.split('\n').map(l => l.trim()).filter(Boolean);
    const allCapsName = /^[A-Z]{2,}(?:\s+[A-Z]{2,})+$/;
    // Look for all-caps full name near payment method keywords
    for (let i = 0; i < idLines.length; i++) {
      if (/M.?PESA|MPESA|M-PESA|Equity|KCB|Co.op|Cooperative|Absa|DTB|Stanbic/i.test(idLines[i])) {
        for (let j = i + 1; j < Math.min(i + 8, idLines.length); j++) {
          if (allCapsName.test(idLines[j]) && idLines[j].split(' ').length >= 2) {
            realName = idLines[j];
            break;
          }
        }
        if (realName) break;
      }
    }
    // Fallback: first all-caps multi-word line in full page text
    if (!realName) {
      for (const line of idLines) {
        if (allCapsName.test(line) && line.split(' ').length >= 2 && line.length >= 8 && line.length <= 60) {
          realName = line;
          break;
        }
      }
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


async function initialScan() {
  if (scanningInProgress) return;
  scanningInProgress = true;

  const page = await getPage();
  if (!page) { scanningInProgress = false; return; }

  console.log('[SparkP2P] === INITIAL SCAN START ===');

  // Navigate straight to the P2P orders page and stay there
  await page.goto('https://p2p.binance.com/en/fiatOrder?tab=0&page=1',
    { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 2000));

  // Resume any in-progress orders from before restart
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

    // Set activeOrderNumber â€" the poll cycle will route to monitorActiveOrder automatically
    console.log(`[SparkP2P] ðŸ"„ Will resume order ${releaseAction.order_number} on first poll`);
    activeOrderNumber = releaseAction.order_number;
    activeOrderFiatAmount = releaseAction.fiat_amount || 0;
  } catch (e) {
    console.error('[SparkP2P] resumeInProgressOrders error:', e.message?.substring(0, 60));
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// COOKIE SYNC (just for VPS to mark as connected)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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

    // Gmail cookies â€" read directly from gmailPage tab (most reliable)
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
          console.log(`[SparkP2P] Gmail session detected â€" ${gmailCookies.length} cookies captured`);
        }
      }
    } catch (e) { /* gmailPage not ready â€" skip */ }

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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// PAGE READER â€" Read data from Binance pages like a human
// Navigate → Wait → Read DOM → Report to VPS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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

// activeOnly=true skips the tab=1 history scan (cancelled/completed).
// Use this when active orders are present so the page navigates directly
// to order details without bouncing through history tabs first.
async function readOrders(activeOnly = false) {
  // IMPORTANT: Use DOM text â€" NOT screenshots â€" for orders.
  // GPT Vision OCR misreads 18-20 digit order numbers causing duplicate DB records.
  // DOM text gives exact digits straight from the HTML.
  if (!browser || _ordersTabOpen) return { sell: [], buy: [], cancelled: [], completed_buy: [] };

  _ordersTabOpen = true;
  try {
    const page = await getPage();
    if (!page) { _ordersTabOpen = false; return { sell: [], buy: [], cancelled: [], completed_buy: [] }; }

    // Step 1: Read active orders — backend API first (uses stored session, independent of
    // Puppeteer browser state), then DOM fallback with 3s wait for React render.
    let sell = [], buy = [];

    // Primary: call backend /ext/active-orders — backend holds the trader's Binance session
    // credentials independently of the Puppeteer browser, so this works even after reconnects.
    try {
      const resp = await fetch(`${API_BASE}/ext/active-orders`, {
        headers: { 'Authorization': `Bearer ${token}` },
      }).catch(() => null);
      if (resp && resp.ok) {
        const data = await resp.json().catch(() => null);
        if (data && data.ok && Array.isArray(data.orders) && data.orders.length > 0) {
          for (const o of data.orders) {
            if ((o.tradeType || '') === 'SELL') sell.push(o);
            else buy.push(o);
          }
          console.log(`[SparkP2P] Backend API order read: ${buy.length} buy, ${sell.length} sell`);
        }
      }
    } catch(_) {}

    // DOM fallback: navigate to the orders list page and parse text
    if (sell.length === 0 && buy.length === 0) {
      await page.goto('https://p2p.binance.com/en/fiatOrder?tab=0&page=1', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 3000)); // 3s for React to render orders
      const activeText = await page.evaluate(() => document.body.innerText).catch(() => '');
      if (activeText && !activeText.includes('No records') && !activeText.includes('No data')) {
        const seenActive = new Set();
        const activeOrderPattern = /\b(\d{18,20})\b/g;
        let am;
        while ((am = activeOrderPattern.exec(activeText)) !== null) {
          const orderNumber = am[1];
          if (seenActive.has(orderNumber)) continue;
          const ctxStart = Math.max(0, am.index - 600);
          const ctxEnd   = Math.min(activeText.length, am.index + 200);
          const ctx = activeText.slice(ctxStart, ctxEnd);
          if (/\b(Completed|Cancelled|Canceled)\b/i.test(ctx)) continue;
          const statusMatch = ctx.match(/\b(Pending Payment|Pending|Paid|Appeal)\b/i);
          if (!statusMatch) continue;
          const typeMatch = ctx.match(/\b(Buy|Sell)\b/i);
          if (!typeMatch) continue;
          const tradeType = typeMatch[1].toUpperCase();
          const usdtMatch = ctx.match(/([\d,]+\.?\d*)\s*USDT/);
          const crypto = usdtMatch ? parseFloat(usdtMatch[1].replace(/,/g, '')) : 0;
          const kesValues = [...ctx.matchAll(/([\d,]+\.?\d*)\s*KES/g)].map(m => parseFloat(m[1].replace(/,/g, '')));
          const fiat = kesValues.find(v => v >= 1000) || kesValues[0] || 0;
          const priceGuesses = [...ctx.matchAll(/\b(1[0-9]{2}\.\d{1,4})\b/g)].map(pg => parseFloat(pg[1]));
          const price = priceGuesses.find(p => p >= 100 && p <= 200) || (crypto > 0 ? fiat / crypto : 0);
          seenActive.add(orderNumber);
          const order = { orderNumber, tradeType, totalPrice: fiat, amount: crypto, price, asset: 'USDT', status: statusMatch[1], counterparty: '' };
          if (order.orderNumber.length >= 15) {
            if (tradeType === 'SELL') sell.push(order);
            else buy.push(order);
          }
        }
      }
      if (sell.length > 0 || buy.length > 0) {
        console.log(`[SparkP2P] DOM order read: ${buy.length} buy, ${sell.length} sell`);
      }
    }

    // â"€â"€ Step 2: Read recently cancelled orders (tab=1, Cancelled filter) â"€â"€â"€
    // Skip history scan when activeOnly=true â€" avoids page bouncing when
    // active orders are already detected and need immediate attention.
    if (activeOnly) {
      console.log('[SparkP2P] readOrders: activeOnly mode â€" skipping tab=1 history scan');
      _ordersTabOpen = false;
      return { sell, buy, cancelled: [], completed_buy: [] };
    }

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

    if (cancelledText && !cancelledText.includes('No records') && !cancelledText.includes('No data')) {
      const seenCancelled = new Set();
      const cancelledPattern = /\b(\d{18,20})\b/g;
      let cm;
      while ((cm = cancelledPattern.exec(cancelledText)) !== null) {
        const n = cm[1];
        if (!seenCancelled.has(n)) { seenCancelled.add(n); cancelled.push(n); }
      }
    }

    // â"€â"€ Step 3: Read recently completed BUY orders (tab=1, Completed filter) â"€â"€
    // We're still on tab=1 â€" click the "Completed" filter to find completed buy orders
    let completed_buy = [];
    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('div[class*="tab"], span[class*="tab"], button'));
      const completedTab = tabs.find(el => el.textContent.trim() === 'Completed');
      if (completedTab) completedTab.click();
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));

    const completedText = await page.evaluate(() => document.body.innerText).catch(() => '');

    if (completedText && !completedText.includes('No records') && !completedText.includes('No data')) {
      const seenCompleted = new Set();
      const completedPattern = /\b(\d{18,20})\b/g;
      let cpm;
      while ((cpm = completedPattern.exec(completedText)) !== null) {
        const orderNumber = cpm[1];
        if (seenCompleted.has(orderNumber)) continue;
        const ctxStart = Math.max(0, cpm.index - 400);
        const ctxEnd   = Math.min(completedText.length, cpm.index + 100);
        const ctx = completedText.slice(ctxStart, ctxEnd);
        const typeMatch = ctx.match(/\b(Buy|Sell)\b/i);
        if (typeMatch && typeMatch[1].toLowerCase() === 'sell') continue;
        seenCompleted.add(orderNumber);
        completed_buy.push(orderNumber);
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// TRADING POLLER â€" Reads pages, reports to VPS, takes actions
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function scheduleNextPoll(delayMs) {
  if (!pollerRunning) return;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    await pollCycle();
    scheduleNextPoll(stats.orders > 0 ? POLL_INTERVAL_ACTIVE : POLL_INTERVAL_IDLE);
  }, delayMs);
}

function startPoller() {
  if (BOT_DISABLED) { console.log('[SparkP2P] BOT_DISABLED — automation skipped'); return; }
  if (pollerRunning) return;
  pollerRunning = true;
  console.log('[SparkP2P] Bot started');
  // Notify backend that bot is running — clears bot_intentionally_stopped flag
  if (token) {
    fetch(`${API_BASE}/ext/bot-started`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } }).catch(() => {});
  }
  scheduleNextPoll(0); // run immediately
}

function stopPoller() {
  pollerRunning = false;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  activeOrderNumber = null;
  activeOrderFiatAmount = 0;
  activeBuyOrderNumber = null;
  codeFallbackAskedForOrder = null;
  scanningInProgress = false;
  // Tell backend the bot stopped so offline SMS alerts are suppressed.
  // Uses fire-and-forget — no await needed since this is a synchronous function.
  if (token) {
    fetch(`${API_BASE}/ext/bot-stopped`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } }).catch(() => {});
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// STEP 1 â€" Vision-directed M-Pesa screenshot extraction
//
// Flow:
//  1. Take full-page screenshot
//  2. Vision identifies if there is a payment screenshot in the chat
//     and returns its approximate x,y coordinates
//  3. DOM clicks those coordinates to open/enlarge the image
//  4. Vision reads the enlarged screenshot and extracts the M-Pesa code
//  5. Returns { code, method } or null if no screenshot found
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function findAndReadPaymentScreenshot(page) {
  if (!anthropicApiKey) return null;
  try {
    // â"€â"€ Step 1: Scroll chat panel to bottom via DOM â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    console.log('[Screenshot] Scrolling chat to bottom...');
    await page.evaluate(() => {
      // Try to find the chat scroll container and scroll it to the bottom
      const all = Array.from(document.querySelectorAll('*'));
      for (const el of all) {
        if (el.scrollHeight > el.clientHeight + 50 && el.clientWidth > 200 && el.getBoundingClientRect().left > window.innerWidth * 0.4) {
          el.scrollTop = el.scrollHeight;
        }
      }
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));

    // â"€â"€ Step 2: Take screenshot → Vision finds the thumbnail coords â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    console.log('[Screenshot] Taking screenshot to locate payment thumbnail...');
    const scanSS = await page.screenshot({ type: 'jpeg', quality: 85 });
    const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 }));
    const scanW = Math.round(vp.w * vp.dpr);
    const scanH = Math.round(vp.h * vp.dpr);
    const dpr = vp.dpr;
    console.log(`[Screenshot] Viewport ${vp.w}Ã—${vp.h} dpr=${dpr} → image ${scanW}Ã—${scanH}`);

    const locateResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 80,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: scanSS.toString('base64') } },
          { type: 'text', text:
            `This is a ${scanW}Ã—${scanH}px screenshot of a Binance P2P order page.\n` +
            `The RIGHT side of the page has a chat panel with messages.\n` +
            `Is there an image/photo thumbnail sent by the buyer in that chat panel? ` +
            `(It looks like a dark or colored rectangular thumbnail showing a phone screenshot or receipt â€" NOT an icon, NOT a button.)\n` +
            `If yes, return the CENTER pixel coordinates of that thumbnail.\n` +
            `If no thumbnail exists, return {"found": false}.\n` +
            `Return ONLY JSON: {"found": true, "x": 640, "y": 400} or {"found": false}` },
        ]}],
      }),
    });
    const locateData = await locateResp.json();
    const locateRaw = (locateData.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
    console.log(`[Screenshot] Vision locate: ${locateRaw.substring(0, 100)}`);
    const locateMatch = locateRaw.match(/\{[\s\S]*?\}/);
    if (!locateMatch) { console.log('[Screenshot] No JSON from Vision'); return null; }
    const locateResult = JSON.parse(locateMatch[0]);
    if (!locateResult.found) { console.log('[Screenshot] No payment thumbnail found in chat'); return null; }

    // â"€â"€ Step 3: Click thumbnail to open lightbox â€" mouse click first, DOM fallback â"€â"€
    const thumbVpX = Math.round(locateResult.x / dpr);
    const thumbVpY = Math.round(locateResult.y / dpr);
    console.log(`[Screenshot] Thumbnail at image(${locateResult.x},${locateResult.y}) → viewport(${thumbVpX},${thumbVpY}) â€" clicking...`);
    await page.mouse.move(thumbVpX, thumbVpY);
    await new Promise(r => setTimeout(r, 100));
    await page.mouse.click(thumbVpX, thumbVpY);
    await new Promise(r => setTimeout(r, 1500));
    // Also fire a DOM click on the closest chat img to guarantee React handler fires
    await page.evaluate((vpX, vpY) => {
      const imgs = Array.from(document.querySelectorAll('img')).filter(img => {
        const r = img.getBoundingClientRect();
        return r.width > 40 && r.height > 40 && r.left > window.innerWidth * 0.4;
      });
      let best = null, bestDist = Infinity;
      for (const img of imgs) {
        const r = img.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const dist = Math.hypot(cx - vpX, cy - vpY);
        if (dist < bestDist) { best = img; bestDist = dist; }
      }
      if (best) best.click();
    }, thumbVpX, thumbVpY).catch(() => {});

    // Wait for lightbox to fully load â€" skip verification (Vision misidentifies it)
    console.log('[Screenshot] Waiting 5s for lightbox to load...');
    await new Promise(r => setTimeout(r, 5000));

    // â"€â"€ Step 6: Screenshot the enlarged lightbox view â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    const enlargedSS = await page.screenshot({ type: 'png' });
    await takeScreenshot('payment_screenshot_enlarged', page);

    // â"€â"€ Step 7: Vision reads the enlarged screenshot â€" up to 2 attempts â"€â"€â"€â"€â"€â"€â"€
    console.log('[Vision] Reading enlarged payment screenshot (Sonnet)...');

    const MPESA_OCR_PROMPT = `This screenshot may show one or more M-Pesa payment messages. Focus ONLY on the MOST RECENT (bottom-most) payment confirmation message.

There are two possible formats for the M-Pesa transaction code:

FORMAT 1 â€" Safaricom SMS:
"XXXXXXXXXX Confirmed. Ksh 2,000.00 sent to NAME on DATE..."
The code is the FIRST word â€" 8-12 uppercase alphanumeric characters (letters and digits only).

FORMAT 2 â€" I&M Bank / other bank SMS:
"M-PESA transfer of KES 2,000.00 to A/C ... M-PESA Ref ID: XXXXXXXXXX"
The code follows "M-PESA Ref ID:" â€" 8-12 uppercase alphanumeric characters.

Common OCR confusions: Iâ†"1, Oâ†"0, Bâ†"8, Sâ†"5, Zâ†"2.
Ignore older messages higher up in the screenshot â€" only extract from the LAST/BOTTOM message.
The code may start with digits or letters â€" include it regardless.

Return ONLY this JSON with no other text:
{"found": true, "code": "XXXXXXXXXX", "amount": 2000}
OR if no M-Pesa confirmation visible in the bottom message:
{"found": false, "reason": "no_mpesa_message"}`;

    let readResult = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const readResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-5',
            max_tokens: 400,
            messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: enlargedSS.toString('base64') } },
              { type: 'text', text: MPESA_OCR_PROMPT },
            ]}],
          }),
        });
        const readData = await readResp.json();
        const readRaw = (readData.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
        console.log(`[Vision] Attempt ${attempt} raw response: ${readRaw.substring(0, 120)}`);
        const readMatch = readRaw.match(/\{[\s\S]*\}/);
        if (readMatch) {
          const parsed = JSON.parse(readMatch[0]);
          if (parsed.found && parsed.code) {
            // Accept 9-11 char codes â€" slight miscount is OK, VPS will validate
            if (/^[A-Z0-9]{9,11}$/i.test(parsed.code)) {
              readResult = { ...parsed, code: parsed.code.toUpperCase() };
              console.log(`[Vision] Attempt ${attempt} âœ… code=${readResult.code} amount=${readResult.amount}`);
              break;
            } else {
              console.log(`[Vision] Attempt ${attempt} rejected code "${parsed.code}" â€" unexpected format`);
            }
          } else {
            console.log(`[Vision] Attempt ${attempt}: found=false reason=${parsed.reason}`);
          }
        }
      } catch (e) {
        console.log(`[Vision] Attempt ${attempt} error: ${e.message?.substring(0, 60)}`);
      }
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
    }

    // â"€â"€ 7. Close lightbox by reloading the page â€" most reliable approach â"€â"€â"€â"€â"€
    // Escape is unreliable for Binance's lightbox. Page reload guarantees all
    // overlays are destroyed and we get a clean DOM for the next steps.
    console.log('[Vision] Closing lightbox â€" reloading page for clean state...');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));
    console.log('[Vision] Page reloaded â€" lightbox destroyed');

    if (readResult?.found && readResult.code && /^[A-Z0-9]{8,12}$/i.test(readResult.code)) {
      console.log(`[Vision] âœ… M-Pesa code extracted: ${readResult.code} (amount: KES ${readResult.amount})`);
      return { code: readResult.code, amount: readResult.amount, method: 'vision_screenshot' };
    }
    console.log(`[Vision] Could not read code: ${readResult?.reason || 'unclear'}`);
    return { code: null, amount: null, attempted: true }; // thumbnail found but code unreadable

  } catch (e) {
    console.error('[Vision] findAndReadPaymentScreenshot error:', e.message?.substring(0, 80));
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));
    return null;
  }
}

async function extractMpesaCodesFromChat(page) {
  if (!anthropicApiKey) {
    console.log('[SparkP2P] No API key — skipping chat M-Pesa extraction');
    return { mpesaCodes: [], bankRefs: [], hasImages: false };
  }
  try {
    // â"€â"€ Step 0: Vision â€" ask Claude to read ONLY the most recent buyer message â"€â"€
    // This avoids picking up old codes from previous orders still visible in chat.
    try {
      const ss = await page.screenshot({ type: 'jpeg', quality: 85 });
      const vRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 80,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: ss.toString('base64') } },
            { type: 'text', text: `Look at the chat panel on the RIGHT side of this Binance P2P order page.
Find ONLY the most recent (last / bottom-most) message sent by the BUYER (left-aligned bubbles).
Does it contain an M-Pesa transaction code (8-12 uppercase alphanumeric characters, e.g. QE1FXYZABC or UDMSATAB0) or a bank reference number?
Return ONLY JSON: {"mpesa_code": "CODE or null", "bank_ref": "REF or null"}
IMPORTANT: ignore ALL older messages â€" only look at the single most recent buyer message.` },
          ]}],
        }),
      });
      const vData = await vRes.json();
      const vText = (vData.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
      const vMatch = vText.match(/\{[\s\S]*\}/);
      if (vMatch) {
        const vResult = JSON.parse(vMatch[0]);
        const vCode = vResult.mpesa_code && /^[A-Z0-9]{8,12}$/i.test(vResult.mpesa_code) ? vResult.mpesa_code.toUpperCase() : null;
        const vRef  = vResult.bank_ref  && /^[A-Z0-9]{6,20}$/i.test(vResult.bank_ref)  ? vResult.bank_ref.toUpperCase()   : null;
        if (vCode || vRef) {
          console.log(`[SparkP2P] Vision (latest message) â€" M-Pesa: ${vCode || 'none'} Bank: ${vRef || 'none'}`);
          return { mpesaCodes: vCode ? [vCode] : [], bankRefs: vRef ? [vRef] : [] };
        }
      }
    } catch (e) {
      console.log(`[SparkP2P] Vision latest-message scan error: ${e.message?.substring(0, 60)}`);
    }

    // â"€â"€ Step 1: Find all <img> elements in the right half of the viewport (chat panel)
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
        // Click the element directly via JS â€" triggers React's handler, opens lightbox
        await el.evaluate(node => node.click());
        console.log(`[SparkP2P] Clicked chat image ${i + 1} â€" waiting for lightbox...`);
        await new Promise(r => setTimeout(r, 2000));

        // Screenshot the full page â€" lightbox should now be open and full-size
        const enlarged = await page.screenshot({ type: 'jpeg', quality: 95 });
        await takeScreenshot(`chat_image_${i + 1}_enlarged`, page);

        const result = await askVisionForMpesaCode(enlarged.toString('base64'));
        const code = result.mpesa_code;
        const bankRef = result.bank_ref;
        console.log(`[SparkP2P] Vision image ${i + 1}: mpesa_code=${code} bank_ref=${bankRef}`);

        // Close lightbox before next attempt â€" wait long enough for it to fully close
        await page.keyboard.press('Escape').catch(() => {});
        await new Promise(r => setTimeout(r, 1500));

        const mpesaFound = (code && /^[A-Z0-9]{8,12}$/i.test(code)) ? code.toUpperCase() : null;
        const bankFound = (bankRef && /^[A-Z0-9]{6,20}$/i.test(bankRef.trim())) ? bankRef.trim().toUpperCase() : null;
        if (!mpesaFound && code) console.log(`[SparkP2P] Rejected mpesa_code "${code}" â€" unexpected format`);
        if (!bankFound && bankRef) console.log(`[SparkP2P] Rejected bank_ref "${bankRef}" â€" unexpected format`);

        // If Vision classified a 8-12 char code as bank_ref (e.g. starts with digits), treat it
        // as a potential M-Pesa code too so VPS can attempt verification on both
        const altMpesa = (!mpesaFound && bankFound && /^[A-Z0-9]{8,12}$/i.test(bankFound)) ? bankFound : null;

        if (mpesaFound || bankFound) {
          const mpesaCodes = mpesaFound ? [mpesaFound] : (altMpesa ? [altMpesa] : []);
          const bankRefs = bankFound ? [bankFound] : [];
          console.log(`[SparkP2P] Image codes: mpesa=[${mpesaCodes}] bank=[${bankRefs}]`);
          return { mpesaCodes, bankRefs, hasImages: true };
        }
      } catch (e) {
        console.log(`[SparkP2P] Chat image ${i + 1} error: ${e.message?.substring(0, 60)}`);
        await page.keyboard.press('Escape').catch(() => {});
      }
    }

    console.log('[SparkP2P] No payment code found in chat images');
    return { mpesaCodes: [], bankRefs: [], hasImages: handles.length > 0 };
  } catch (e) {
    console.error('[SparkP2P] extractMpesaCodesFromChat error:', e.message?.substring(0, 60));
    return { mpesaCodes: [], bankRefs: [], hasImages: false };
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
   Code: 8-12 uppercase letters/digits (e.g. UD5IZBFOER or UDMSATAB0)
   IGNORE RECEIVED messages.

2. Bank transfer to M-Pesa paybill (KCB, Equity, Co-op, Absa, etc.):
   Message: "Your payment/transfer of KES X,XXX to paybill XXXXXXX was successful. Ref/Transaction ID: XXXXXXXXXXX"
   Code: The reference/transaction ID shown (may be longer than 10 chars, e.g. FT24096123456)

Return ONLY valid JSON:
{"mpesa_code": "<M-Pesa 8-12 char code or null>", "bank_ref": "<bank transaction ref or null>"}` },
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

async function verifyMpesaPayment(orderNumber, fiatAmount, page = null, preExtracted = null) {
  if (!token) return { verified: false, reason: 'no token' };
  try {
    // Use pre-extracted codes if provided (e.g. read before modal covered the chat).
    // Only re-scan the chat from page if no pre-extracted codes were supplied.
    let mpesaCodes = [], bankRefs = [];
    if (preExtracted) {
      mpesaCodes = preExtracted.mpesaCodes || [];
      bankRefs = preExtracted.bankRefs || [];
      console.log(`[SparkP2P] Using pre-extracted codes â€" M-Pesa: [${mpesaCodes.join(', ')}] Bank: [${bankRefs.join(', ')}]`);
    } else if (page) {
      const extracted = await extractMpesaCodesFromChat(page);
      mpesaCodes = extracted.mpesaCodes || [];
      bankRefs = extracted.bankRefs || [];
      if (mpesaCodes.length) console.log(`[SparkP2P] M-Pesa codes from chat: ${mpesaCodes.join(', ')}`);
      if (bankRefs.length) console.log(`[SparkP2P] Bank refs from chat: ${bankRefs.join(', ')}`);
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
    if (!res.ok) return { verified: false, reason: 'VPS error' };
    const data = await res.json();
    if (data.verified) {
      console.log(`[SparkP2P] M-Pesa verified: receipt=${data.mpesa_receipt}, amount=KES ${data.amount_received}, from=${data.payer_name}`);
    } else {
      console.log(`[SparkP2P] M-Pesa NOT verified: ${data.reason}`);
    }
    return { verified: data.verified === true, reason: data.reason || '' };
  } catch (e) {
    console.error('[SparkP2P] verifyMpesaPayment error:', e.message?.substring(0, 60));
    return { verified: false, reason: 'error' };
  }
}

// â"€â"€ Reconcile stuck orders â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
// Runs every 10 polls. Reads Binance cancelled+completed history (all dates, not
// just today) and reports them to SparkP2P so disputed/expired orders get updated.
async function reconcileStuckOrders(page) {
  if (!page || !token || pauseNavigation) return;
  console.log('[SparkP2P] ðŸ"„ Reconciling stuck orders against Binance history...');

  try {
    // Navigate to Binance order history tab
    await page.goto('https://p2p.binance.com/en/fiatOrder?tab=1&page=1', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2500));

    // Read cancelled orders (all dates)
    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('div[class*="tab"], span[class*="tab"], button'));
      const t = tabs.find(el => el.textContent.trim() === 'Canceled' || el.textContent.trim() === 'Cancelled');
      if (t) t.click();
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));

    const cancelledText = await page.evaluate(() => document.body.innerText).catch(() => '');
    let cancelledNums = [];
    if (cancelledText && !cancelledText.includes('No records')) {
      const seenCN = new Set();
      const cnPat = /\b(\d{18,20})\b/g;
      let cn;
      while ((cn = cnPat.exec(cancelledText)) !== null) {
        const n = cn[1];
        if (!seenCN.has(n)) { seenCN.add(n); cancelledNums.push(n); }
      }
    }

    // Read completed BUY orders with full financial details so missing orders can be created in DB
    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('div[class*="tab"], span[class*="tab"], button'));
      const t = tabs.find(el => el.textContent.trim() === 'Completed');
      if (t) t.click();
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));

    const completedText = await page.evaluate(() => document.body.innerText).catch(() => '');
    let completedBuyNums = [];
    let completedBuyOrders = []; // full data for buy orders not yet in DB
    let completedSellNums = [];
    if (completedText && !completedText.includes('No records')) {
      const seenCB = new Set();
      const cbPat = /\b(\d{18,20})\b/g;
      let cb;
      while ((cb = cbPat.exec(completedText)) !== null) {
        const orderNumber = cb[1];
        if (seenCB.has(orderNumber)) continue;
        const ctxBefore = completedText.slice(Math.max(0, cb.index - 400), cb.index);
        const ctxAfter  = completedText.slice(cb.index + orderNumber.length, Math.min(completedText.length, cb.index + orderNumber.length + 300));
        const ctx = ctxBefore + ctxAfter;
        const typeMatch = ctx.match(/\b(Buy|Sell)\b/i);
        const isSell = typeMatch && typeMatch[1].toLowerCase() === 'sell';
        seenCB.add(orderNumber);

        if (isSell) {
          completedSellNums.push(orderNumber);
          continue;
        }

        completedBuyNums.push(orderNumber);

        // Parse financial details from text after the order number.
        // Binance history format: "<rate> KES\n<fiatAmt> KES\n<cryptoAmt> USDT\n<counterparty>"
        const kesMatches = [...ctxAfter.matchAll(/([\d,]+(?:\.\d+)?)\s*KES/g)];
        const usdtMatch  = ctxAfter.match(/([\d,]+(?:\.\d+)?)\s*USDT/);
        const cpMatch    = ctxAfter.match(/\n([A-Za-z][A-Za-z0-9_\-]+)\s*\n/);
        const rate       = kesMatches.length > 0 ? parseFloat(kesMatches[0][1].replace(/,/g, '')) : 0;
        const fiatAmount = kesMatches.length > 1 ? parseFloat(kesMatches[1][1].replace(/,/g, '')) : 0;
        const cryptoAmt  = usdtMatch ? parseFloat(usdtMatch[1].replace(/,/g, '')) : 0;
        const counterparty = cpMatch ? cpMatch[1] : null;

        // Only include if we parsed a meaningful fiat amount (>= 100 KES)
        if (fiatAmount >= 100) {
          completedBuyOrders.push({
            orderNumber,
            tradeType: 'BUY',
            totalPrice: fiatAmount,
            amount: cryptoAmt,
            price: rate,
            asset: 'USDT',
            sellerNickname: counterparty,
          });
        }
      }
    }

    // Filter already-reported numbers to avoid duplicate SMS
    const newCompletedBuyNums = completedBuyNums.filter(n => !reportedCompletedBuyOrders.has(n));
    const newCompletedBuyOrders = completedBuyOrders.filter(o => !reportedCompletedBuyOrders.has(o.orderNumber));
    const newCompletedSellNums = completedSellNums.filter(n => !reportedCompletedSellOrders.has(n));

    if (cancelledNums.length || newCompletedBuyNums.length || newCompletedSellNums.length) {
      const reconcileRes = await fetch(`${API_BASE}/ext/report-orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          sell_orders: [],
          buy_orders: newCompletedBuyOrders,
          cancelled_order_numbers: cancelledNums,
          completed_buy_order_numbers: newCompletedBuyNums,
          completed_sell_order_numbers: newCompletedSellNums,
        }),
      }).catch(() => null);
      if (reconcileRes?.ok) {
        newCompletedBuyNums.forEach(n => reportedCompletedBuyOrders.add(n));
        newCompletedSellNums.forEach(n => reportedCompletedSellOrders.add(n));
        if (newCompletedBuyNums.length) saveReportedCompleted(reportedCompletedBuyOrders);
      }
      console.log(`[SparkP2P] ✅ Reconciled: ${cancelledNums.length} cancelled, ${newCompletedBuyNums.length} completed buy, ${newCompletedSellNums.length} completed sell`);
    } else {
      console.log('[SparkP2P] Reconcile: no cancelled/completed orders found in history');
    }
  } catch (e) {
    console.log(`[SparkP2P] reconcileStuckOrders error: ${e.message}`);
  }
}

async function pollCycle() {
  if (!pollerRunning || !token || !browser || scanningInProgress || pauseNavigation) return;
  scanningInProgress = true;

  try {
    // â"€â"€ Check Binance session â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    const sessionAge = sessionStartTime ? Date.now() - sessionStartTime : Infinity;
    if (browserLocked && sessionAge > SESSION_GRACE_MS) {
      if (!(await isLoggedIn())) {
        loggedOutStrikes++;
        console.log(`[SparkP2P] isLoggedIn() returned false (strike ${loggedOutStrikes}/${LOGOUT_STRIKES_NEEDED})`);
        if (loggedOutStrikes < LOGOUT_STRIKES_NEEDED) {
          scanningInProgress = false;
          return;
        }
        console.log('[SparkP2P] Session expired â€" re-login required');
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

    // â"€â"€ idleScan handles everything â€" cycles through ALL active orders each poll â"€â"€
    await idleScan(page);

    stats.polls++;
    lastActiveTime = Date.now();
    fetch(`${API_BASE}/ext/heartbeat`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } }).catch(() => {});
    if (stats.polls % 5 === 0) await readMarketPrices().catch(() => {});
    // Every 10 polls, reconcile disputed/expired orders against Binance actual status
    if (stats.polls % 10 === 0) await reconcileStuckOrders(page).catch(e => console.log(`[SparkP2P] reconcileStuckOrders err: ${e.message}`));

    const nextIn = (stats.orders > 0 ? POLL_INTERVAL_ACTIVE : POLL_INTERVAL_IDLE) / 1000;
    const orderSummary = stats.orders > 0
      ? `${stats.orders} active order(s) â€" next cycle in ${nextIn}s`
      : `Idle â€" next scan in ${nextIn}s`;
    const visionSummary = (_cycleVision + _cycleDom) > 0
      ? ` | State detection: ${_cycleDom} DOM, ${_cycleVision} Vision (${_cycleVision === 0 ? '0 Claude calls' : `${_cycleVision} Claude call${_cycleVision > 1 ? 's' : ''}`})`
      : '';
    console.log(`[SparkP2P] Poll complete. ${orderSummary}${visionSummary}`);
    sendBotLog('info', `Poll #${stats.polls} — ${orderSummary}${visionSummary}`);

  } catch (e) {
    stats.errors++;
    console.error('[SparkP2P] Poll error:', e.message);
  } finally {
    scanningInProgress = false;
  }
}

// â"€â"€ monitorActiveBuyOrder â€" DEPRECATED: logic now in idleScan buy order loop â"€â"€
// Kept as dead code; no longer called by the poll cycle.
async function monitorActiveBuyOrder(_page) {
  console.log('[SparkP2P] monitorActiveBuyOrder called (deprecated â€" idleScan handles buy orders)');
}


// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// DOM-BASED ORDER STATE DETECTION â€" replaces analyzePageWithVision
// Reads page text directly. No screenshots. No AI.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function detectOrderState(page) {
  const text = await page.evaluate(() => document.body.innerText).catch(() => '');
  const lower = text.toLowerCase();

  // Order complete / crypto released
  if (lower.includes('sale successful') || lower.includes('order completed') ||
      lower.includes('released to buyer') || lower.includes('crypto released') ||
      lower.includes('you have released')) {
    return 'order_complete';
  }

  // Passkey screen â€" check before security_verification
  if (lower.includes('verify with passkey') || lower.includes('my passkeys are not available')) {
    return 'passkey_required';
  }

  // Security verification in progress
  if (lower.includes('authenticator') || lower.includes('google auth') ||
      lower.includes('email verification code') || lower.includes('enter the code')) {
    return 'security_verification';
  }

  // Confirm release modal â€" "Received payment in your account?" dialog
  // Exact title Binance shows after clicking "Payment Received" button.
  // Also catches older wording as fallback.
  if (lower.includes('received payment in your account') ||
      lower.includes('confirm release') ||
      lower.includes('i have verified that i received')) {
    return 'confirm_release_modal';
  }

  // Awaiting buyer payment â€" check BEFORE verify_payment to prevent false positives.
  // If "awaiting" is on the page, buyer has NOT paid yet regardless of other button text.
  if (lower.includes("awaiting buyer's payment") || lower.includes('awaiting payment') ||
      lower.includes('waiting for buyer') || lower.includes('waiting for payment') ||
      lower.includes('buyer to complete')) {
    return 'awaiting_payment';
  }

  // Buyer has paid â€" Binance shows "Verify Payment" page with header text.
  // These phrases are UNIQUE to the sell-order payment verification state.
  // IMPORTANT: checked BEFORE awaiting_payment_confirmation to prevent BUY-order
  // phrases on the page (e.g. timeline text) from triggering the wrong branch.
  if (lower.includes('verify payment') ||
      lower.includes('confirm payment from buyer') ||
      lower.includes('confirm payment is received') ||
      lower.includes('payment received') ||
      lower.includes('buyer has completed the payment') ||
      lower.includes('buyer has paid') ||
      lower.includes('buyer paid') ||
      lower.includes('has made payment')) {
    return 'verify_payment';
  }

  // Cancelled
  if (lower.includes('order cancelled') || lower.includes('order canceled') ||
      lower.includes('has been cancelled')) {
    return 'cancelled';
  }

  // Buy order â€" we need to mark payment as sent to seller.
  // Use the exact button label only â€" avoids matching timeline text on sell pages.
  if (lower.includes("i've transferred, notify seller") ||
      lower.includes("i have transferred, notify seller") ||
      lower.includes('transferred, notify seller') ||
      lower.includes('mark as paid')) {
    return 'awaiting_payment_confirmation';
  }

  // Buy order â€" waiting for seller to release
  if (lower.includes("awaiting seller's release") || lower.includes('waiting for seller') ||
      lower.includes('seller to release')) {
    return 'awaiting_release';
  }

  return 'unknown';
}

// ── Counterparty Due Diligence helpers ────────────────────────────────────────

async function fetchCounterpartyStats(page, orderNumber, side) {
  // side: 'buyer' for sell orders (we screen who's buying from us)
  //       'seller' for buy orders (we screen who we're paying)
  // Uses Binance's internal browser API — same endpoints the P2P web UI calls.
  // No API keys needed: runs inside the logged-in browser session via page.evaluate().
  try {
    const stats = await page.evaluate(async (orderNo, counterpartySide) => {
      try {
        // Step 1: Fetch order detail to get the counterparty's Binance userNo
        const detailRes = await fetch('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/trade/get', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderNo }),
          credentials: 'include',
        });
        if (!detailRes.ok) return null;
        const detail = await detailRes.json();
        const d = detail?.data;
        if (!d) return null;

        const userNo = counterpartySide === 'buyer'
          ? (d.buyerUserNo || d.buyerNo || d.buyer?.userNo)
          : (d.sellerUserNo || d.sellerNo || d.seller?.userNo || d.advertiserUserNo);
        if (!userNo) return null;

        // Step 2: Fetch the counterparty's public profile stats
        const profileRes = await fetch('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/user/profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userNo }),
          credentials: 'include',
        });
        if (!profileRes.ok) return null;
        const profile = await profileRes.json();
        const p = profile?.data;
        if (!p) return null;

        // DEBUG: expose the raw profile field names so we can confirm which fields
        // Binance actually returns (counterparty trade count, completion rate, etc.)
        const _debugProfileKeys = Object.keys(p);
        const _debugStatKeys = p.userTradeStatistic ? Object.keys(p.userTradeStatistic) : [];

        // Field names vary slightly across Binance API versions — try all known variants
        const trades_30d =
          p.monthOrderCount ??
          p.recentOrderNum ??
          p.userTradeStatistic?.recentOrderNum ??
          null;

        const trades_all =
          p.totalOrderCount ??
          p.allOrderCount ??
          p.userTradeStatistic?.totalFinishOrder ??
          p.userTradeStatistic?.allTrade ??
          null;

        const buy_trades =
          p.buyOrderCount ?? p.userTradeStatistic?.buyFinishCount ?? null;

        const sell_trades =
          p.sellOrderCount ?? p.userTradeStatistic?.sellFinishCount ?? null;

        const completion_rate =
          p.finishRate ?? p.completionRate ?? p.tradeCompleteRate ?? null;

        const avg_pay_mins =
          p.avgPayTime ?? p.averagePayTime ?? p.userTradeStatistic?.avgPayTime ?? null;

        const counterparties =
          p.userTradePartnerCount ?? p.tradePartnerCount ?? p.userTradeStatistic?.partnerCount ?? null;

        const now = Date.now();
        const reg_time = p.registerTime ?? p.createTime ?? p.userCreateTime ?? null;
        const registered_days = reg_time ? Math.floor((now - reg_time) / 86400000) : null;

        const first_trade_time = p.firstOrderTime ?? p.firstTradeTime ?? null;
        const first_trade_days = first_trade_time ? Math.floor((now - first_trade_time) / 86400000) : null;

        // Step 3: Check if this buyer has ever traded with the current merchant on Binance.
        // EP-19 in the docs is queryCounterPartyOrderStatistic — purpose-built for this.
        // Binance's internal (bapi) API isn't publicly documented, so try known variants:
        //   1. dedicated counterparty-statistic endpoint (returns a trade count with this user)
        //   2. merchant's completed order history filtered by counterparty userNo
        let traded_before = null;          // null = couldn't determine (caller falls back)
        let _debugHist = null;             // raw response for the first endpoint that answered
        const _histAttempts = [
          { kind: 'stat', url: 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/order-match/queryCounterPartyOrderStatistic',
            body: { counterPartyUserNo: userNo } },
          { kind: 'stat', url: 'https://p2p.binance.com/bapi/c2c/v2/private/c2c/order-match/queryCounterPartyOrderStatistic',
            body: { counterPartyUserNo: userNo } },
          { kind: 'list', url: 'https://p2p.binance.com/bapi/c2c/v2/private/c2c/order-match/order-list',
            body: { page: 1, rows: 1, orderStatusList: [4], counterPartUserNo: userNo } },
          { kind: 'list', url: 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/order-match/order-list',
            body: { page: 1, rows: 1, orderStatusList: [4], counterPartyUserNo: userNo } },
        ];
        for (const attempt of _histAttempts) {
          try {
            const hRes = await fetch(attempt.url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(attempt.body),
              credentials: 'include',
            });
            if (!hRes.ok) continue;
            const hData = await hRes.json();
            const dd = hData?.data;
            if (dd === undefined || dd === null) continue;
            _debugHist = { url: attempt.url, keys: (dd && typeof dd === 'object' && !Array.isArray(dd)) ? Object.keys(dd) : 'array/scalar' };
            if (attempt.kind === 'stat') {
              // Look for any count-of-trades-with-this-user field
              const cnt = dd.orderCount ?? dd.totalOrderCount ?? dd.finishOrderCount ??
                          dd.tradeCount ?? dd.count ?? null;
              if (cnt !== null) { traded_before = cnt > 0; break; }
            } else {
              const total = dd.total ?? dd.totalNum ?? (Array.isArray(dd) ? dd.length : null);
              if (total !== null) { traded_before = total > 0; break; }
            }
          } catch (_) {}
        }

        // ── Payment details from the same trade/get API response ──
        // d.payInfo is an array: [{payMethodName, fields: [{identifier, value}]}]
        // d.tradePayInfo — alternate field name on some Binance versions
        let paymentDetails = null;
        try {
          const payInfoArr = d.payInfo || d.tradePayInfo || d.sellerPayInfo || [];
          const pi = Array.isArray(payInfoArr) ? payInfoArr[0] : null;
          if (pi) {
            const methodRaw = (pi.payMethodName || pi.payType || '').toString().toLowerCase();
            const method = /i\s*&?\s*m\s*bank/i.test(methodRaw) ? 'im_bank'
              : /mpesa|m-pesa|safaricom/i.test(methodRaw) ? 'mpesa'
              : /airtel/i.test(methodRaw) ? 'mpesa'  // Airtel uses phone too
              : /bank|equity|kcb|co.op|absa|stanbic|dtb|ncba|cooperative/i.test(methodRaw) ? 'other_bank'
              : 'mpesa';
            const fields = Array.isArray(pi.fields) ? pi.fields : [];
            const fv = (id) => {
              const f = fields.find(f => (f.identifier || f.fieldName || '').toLowerCase().includes(id));
              return (f?.value || f?.fieldValue || '').trim();
            };
            const phone = fv('phone') || fv('mobile') || fv('number');
            const name = fv('name') || (d.sellerRealName) || (d.buyer?.nickName) || '';
            const accountNumber = fv('account') || fv('card') || '';
            const bankName = fv('bank') || pi.payMethodName || '';
            const amount = d.totalPrice ?? d.fiatAmount ?? d.amount ?? null;
            const network = /airtel/i.test(methodRaw) ? 'airtel' : 'safaricom';
            if (amount && (phone || accountNumber)) {
              paymentDetails = { method, phone: phone || null, name, amount, network,
                account_number: accountNumber || null, bank_name: bankName || null,
                reference: null, _source: 'api' };
            }
          }
        } catch(_) {}

        return {
          trades_30d, trades_all, paymentDetails,
          // Full profile fields for Telegram approval message
          allTimeTrades: trades_all,
          buyTrades: buy_trades,
          sellTrades: sell_trades,
          last30dTrades: trades_30d,
          completionRate: completion_rate !== null ? (completion_rate * 100).toFixed(2) + '%' : 'N/A',
          avgPayMins: avg_pay_mins !== null ? parseFloat(avg_pay_mins).toFixed(2) : 'N/A',
          counterparties: counterparties,
          registeredDays: registered_days,
          firstTradeDays: first_trade_days,
          tradedBefore: traded_before,
          _debugProfileKeys,
          _debugStatKeys,
          _debugHist,
        };
      } catch (_) {
        return null;
      }
    }, orderNumber, side);

    if (stats) {
      console.log(`[SparkP2P] DD stats via API — 30d: ${stats.trades_30d ?? 'n/a'}, all: ${stats.trades_all ?? 'n/a'}, tradedBefore: ${stats.tradedBefore ?? 'n/a'}`);
      // DEBUG: log the actual Binance field names so we can confirm the correct ones to read
      if (stats._debugProfileKeys) {
        console.log(`[SparkP2P] DEBUG profile fields: ${JSON.stringify(stats._debugProfileKeys)}`);
        console.log(`[SparkP2P] DEBUG userTradeStatistic fields: ${JSON.stringify(stats._debugStatKeys)}`);
        console.log(`[SparkP2P] DEBUG counterparty-history response: ${JSON.stringify(stats._debugHist)}`);
      }
      return stats;
    }
  } catch (_) {}

  // Fallback: parse page text (less reliable but better than nothing)
  console.log('[SparkP2P] DD: API fetch failed — falling back to page text parsing');
  const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
  const d30 = pageText.match(/(\d[\d,]*)\s*(?:orders?|trades?)\s*\/\s*30\s*days?/i);
  const allMatch = pageText.match(/(\d[\d,]*)\s*(?:orders?|trades?)(?!\s*\/\s*30)/i);
  return {
    trades_30d: d30 ? parseInt(d30[1].replace(/,/g, ''), 10) : null,
    trades_all: allMatch ? parseInt(allMatch[1].replace(/,/g, ''), 10) : null,
  };
}

async function checkReturningBuyer(nickname) {
  if (!nickname || !token) return false;
  try {
    const r = await fetch(
      `${API_BASE}/ext/check-returning-buyer?nickname=${encodeURIComponent(nickname)}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    ).catch(() => null);
    if (r?.ok) return (await r.json()).is_returning;
  } catch (_) {}
  return false;
}

async function cancelOrderOnBinance(page, orderNumber, reason) {
  const cancelled = await page.evaluate(() => {
    const phrases = ['cancel order', 'cancel', 'cancel the order'];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const el = walker.currentNode;
      if (el.tagName !== 'BUTTON' && el.tagName !== 'A') continue;
      const t = (el.textContent || '').trim().toLowerCase();
      if (phrases.some(p => t === p || t.startsWith(p))) { el.click(); return true; }
    }
    return false;
  }).catch(() => false);

  if (!cancelled) {
    console.log(`[SparkP2P] DD cancel: cancel button not found for ${orderNumber}`);
    return false;
  }

  await new Promise(r => setTimeout(r, 2000));
  await page.evaluate(() => {
    const phrases = ['confirm', 'yes', 'confirm cancel', 'yes, cancel'];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const el = walker.currentNode;
      if (el.tagName !== 'BUTTON') continue;
      const t = (el.textContent || '').trim().toLowerCase();
      if (phrases.some(p => t === p || t.startsWith(p))) { el.click(); return true; }
    }
    return false;
  }).catch(() => {});
  await new Promise(r => setTimeout(r, 1500));

  delete orderFirstSeenAt[orderNumber];
  orderReminderSent.delete(orderNumber);
  delete orderLastBotReplyAt[orderNumber];
  codeFallbackAskedOrders.delete(orderNumber);
  delete partialPayments[orderNumber];
  delete lastDeficitSent[orderNumber];
  verifiedOrders.delete(orderNumber);

  await fetch(`${API_BASE}/ext/report-orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ sell_orders: [], buy_orders: [], cancelled_order_numbers: [orderNumber] }),
  }).catch(() => {});

  sendBotLog('warn', `DD screening: cancelled order ${orderNumber} — ${reason}`);
  console.log(`[SparkP2P] DD: cancelled ${orderNumber} — ${reason}`);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────

async function idleScan(page) {
  console.log(`[SparkP2P] â"€â"€ IDLE SCAN #${stats.polls + 1} â"€â"€`);
  _cycleVision = 0;
  _cycleDom    = 0;
  if (pauseNavigation) return;

  // Refresh botTradeMode from backend on every scan so UI changes take effect immediately
  if (token) {
    try {
      const modeRes = await fetch(`${API_BASE}/traders/profile`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (modeRes.ok) {
        const modeData = await modeRes.json();
        const newMode = modeData.bot_trade_mode || 'both';
        const modeChanged = newMode !== botTradeMode;
        if (modeChanged) {
          console.log(`[SparkP2P] Trade mode updated: ${botTradeMode} -> ${newMode}`);
          botTradeMode = newMode;
        }
        ddEnabled       = modeData.dd_enabled        || false;
        botFullAuto     = modeData.bot_full_auto      || false;
        ddMin30d        = modeData.dd_min_30d_trades  || 20;
        ddMinAll        = modeData.dd_min_all_trades  || 0;
        ddAutoCancelNew = modeData.dd_auto_cancel_new || false;
        cfEnabled       = modeData.cf_filters_enabled || false;
        cfMin30d        = modeData.cf_all_trades_min  || 0;
        cfMinAll        = modeData.cf_all_trades_min_all || 0;
      }
    } catch (_) {}
  }

  // â"€â"€ Step 1: Check active orders FIRST â€" readOrders navigates to tab=0 itself â"€â"€
  console.log('[SparkP2P] Step 1: Checking active orders (tab=0)...');
  if (pauseNavigation) return;

  // Read active orders only â€" skip history scan so the page goes straight to order details.
  // readOrders() handles the navigation; we don't navigate here to avoid a duplicate goto.
  const orders = await readOrders(true); // activeOnly=true
  stats.orders = orders.sell.length + orders.buy.length;
  console.log(`[SparkP2P] Orders found: ${orders.sell.length} sell, ${orders.buy.length} buy`);

  const hasActiveOrders = orders.sell.length > 0 || orders.buy.length > 0;

  // Detect buy orders we already paid for that have vanished from the active tab.
  // This happens the moment a seller releases crypto — Binance moves the order to
  // Completed immediately, so readOrders(true) won't see it anymore.
  // We must scan the Completed tab for these even when other active orders exist,
  // otherwise the order stays stuck as "payment sent" until the 10-poll reconcile.
  const currentActiveNums = [...orders.sell, ...orders.buy].map(o => o.orderNumber);
  const ghostPaidNums = Object.keys(buyPaymentSentAt).filter(n => !currentActiveNums.includes(n));
  if (ghostPaidNums.length > 0) {
    console.log(`[SparkP2P] Ghost paid order(s) detected (paid but left active tab): ${ghostPaidNums.join(', ')} — scanning Completed tab now`);
    sendBotLog('info', `Paid order left active tab — checking Completed tab: ${ghostPaidNums.join(', ')}`);
  }

  // â"€â"€ Step 2: No active orders (or ghost paid orders) â€" scan wallets + full history â"€â"€â"€â"€

  // Track first-seen times for all active orders, clean up departed ones
  const allActiveNums = [...orders.sell, ...orders.buy].map(o => o.orderNumber);
  for (const num of allActiveNums) {
    if (!orderFirstSeenAt[num]) {
      orderFirstSeenAt[num] = Date.now();
      console.log(`[SparkP2P] New order detected: ${num}`);
      sendBotLog('info', `New order detected: ${num}`);
    }
  }
  for (const num of Object.keys(orderFirstSeenAt)) {
    if (!allActiveNums.includes(num)) {
      delete orderFirstSeenAt[num];
      orderReminderSent.delete(num);
      delete orderLastBotReplyAt[num];
      codeFallbackAskedOrders.delete(num);
      delete buyPaymentSentAt[num];
      buyReminderSentOrders.delete(num);
      delete buyOrderDetailsMap[num];
      delete imPaymentDoneMap[num];
      imPaymentFailedOrders.delete(num);
      buyGreetingSentOrders.delete(num);
      buyPostPaymentMsgSentOrders.delete(num);
      removePaidOrder(num);
      delete partialPayments[num];
      delete lastDeficitSent[num];
    }
  }

  // Report orders to VPS â€" protect ALL active orders from auto-cancel
  // Retry up to 3 times so a transient network hiccup doesn't silently lose an order
  const reportPayload = JSON.stringify({
    sell_orders: orders.sell.map(norm),
    buy_orders: orders.buy.map(norm),
    cancelled_order_numbers: orders.cancelled || [],
    completed_buy_order_numbers: orders.completed_buy || [],
    active_order_numbers: allActiveNums,
  });
  // Add completed buy orders to the in-memory set now (prevents same-cycle duplicates).
  // Disk save happens AFTER a successful API response — if the request fails, the
  // order is NOT written to disk so the next reconcile cycle can retry it.
  if ((orders.completed_buy || []).length) {
    orders.completed_buy.forEach(n => reportedCompletedBuyOrders.add(n));
  }

  let res = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    res = await fetch(`${API_BASE}/ext/report-orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: reportPayload,
    }).catch(e => { console.error(`[SparkP2P] report-orders attempt ${attempt} failed:`, e.message); return null; });
    if (res?.ok) break;
    if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
  }
  if (!res?.ok && allActiveNums.length > 0) {
    console.error(`[SparkP2P] ⚠️ report-orders failed after 3 attempts — ${allActiveNums.length} active orders NOT recorded in DB: ${allActiveNums.join(', ')}`);
    sendBotLog('error', `report-orders failed — ${allActiveNums.length} active orders may not appear in dashboard`);
  }
  if (res?.ok) {
    // Persist completed orders to disk only after backend confirms receipt
    if ((orders.completed_buy || []).length) saveReportedCompleted(reportedCompletedBuyOrders);
    const { actions } = await res.json().catch(() => ({ actions: [] }));
    for (const a of (actions || [])) {
      const isBuyAction = ['pay', 'mark_as_paid'].includes(a.action);
      const isSellAction = a.action === 'release';
      if (botTradeMode === 'sell_only' && isBuyAction) {
        console.log(`[SparkP2P] Skipping ${a.action} for order ${a.order_number} — mode: sell_only`);
        continue;
      }
      if (botTradeMode === 'buy_only' && isSellAction) {
        console.log(`[SparkP2P] Skipping ${a.action} for order ${a.order_number} — mode: buy_only`);
        continue;
      }
      await execAction(a);
    }
  }

  // â"€â"€ Step 4: Cycle through ALL sell orders â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  // Bot visits each order, acts where needed, then moves on â€" never blocks on one order
  if (orders.sell.length > 0) {
    console.log(`[SparkP2P] ðŸ"" ${orders.sell.length} sell order(s) â€" cycling through all`);
  }
  if (botTradeMode === 'buy_only') {
    if (orders.sell.length > 0) console.log(`[SparkP2P] Skipping ${orders.sell.length} sell order(s) — mode: buy_only`);
  } else {
  for (const order of orders.sell) {
    if (pauseNavigation) break;
    const seenMs = Date.now() - (orderFirstSeenAt[order.orderNumber] || Date.now());
    const seenMins = Math.floor(seenMs / 60000);
    console.log(`[SparkP2P] Checking sell order ${order.orderNumber} (KES ${order.totalPrice}, seen ${seenMins}m)`);

    // Navigate directly to order detail â€" no orders-list click needed
    await page.goto(
      `https://p2p.binance.com/en/fiatOrderDetail?orderNo=${order.orderNumber}`,
      { waitUntil: 'domcontentloaded', timeout: 15000 }
    ).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));
    if (pauseNavigation) break;

    await takeScreenshot(`scan_sell_${order.orderNumber}`, page);

    // Vision is primary â€" understands page context, not just text matching.
    // DOM fallback if Vision unavailable (no API key).
    // DOM-first: free, instant. Vision only when DOM returns 'unknown'.
    let screen = await detectOrderState(page);
    let visionInfo = null;
    let usedVision = false;
    if (screen === 'unknown' && anthropicApiKey) {
      visionInfo = await analyzePageWithVision(page);
      screen = visionInfo?.screen || 'unknown';
      usedVision = true;
    }
    if (screen === 'unknown') {
      await new Promise(r => setTimeout(r, 2000));
      screen = await detectOrderState(page);
      if (screen === 'unknown' && anthropicApiKey) {
        visionInfo = await analyzePageWithVision(page);
        screen = visionInfo?.screen || 'unknown';
        usedVision = true;
      }
    }
    _cycleVision += usedVision ? 1 : 0;
    _cycleDom   += usedVision ? 0 : 1;
    console.log(`[SparkP2P] Sell order ${order.orderNumber} state: ${screen} (via ${usedVision ? 'Vision' : 'DOM'})`);
    const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
    const lower = pageText.toLowerCase();

    // â"€â"€ Complete â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    if (screen === 'order_complete' ||
        lower.includes('sale successful') || lower.includes('order completed') || lower.includes('crypto released')) {
      console.log(`[SparkP2P] âœ… Sell order ${order.orderNumber} COMPLETED â€" reporting release`);
      sendBotLog('success', `Sell order ${order.orderNumber} completed — crypto released`);
      await fetch(`${API_BASE}/ext/report-release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ order_number: order.orderNumber, success: true }),
      }).catch(() => {});
      delete orderFirstSeenAt[order.orderNumber]; _removeOrderFlags(order.orderNumber);
      orderReminderSent.delete(order.orderNumber);
      delete orderLastBotReplyAt[order.orderNumber];
      codeFallbackAskedOrders.delete(order.orderNumber);
      delete partialPayments[order.orderNumber];
      delete lastDeficitSent[order.orderNumber];
      verifiedOrders.delete(order.orderNumber);
      sellApprovalRequestedOrders.delete(order.orderNumber);
      sellApprovedOrders.delete(order.orderNumber);
      sellRejectedOrders.delete(order.orderNumber);
      sellPayInstructSentOrders.delete(order.orderNumber);
      delete lastSellDeficitMsg[order.orderNumber];

    // â"€â"€ SELL ORDER: Buyer marked as paid â€" verify M-Pesa before releasing â"€â"€â"€â"€â"€â"€
    } else if (screen === 'verify_payment') {
      activeOrderNumber = order.orderNumber;
      activeOrderFiatAmount = order.totalPrice;

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // SECOND VISIT: order already verified on a previous poll â€" send message
      // then click Payment Received and release. Nothing else.
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      if (verifiedOrders.has(order.orderNumber)) {
        const vd = verifiedOrders.get(order.orderNumber);
        console.log(`[SparkP2P] â•â•â• Order ${order.orderNumber} â€" SECOND VISIT (release) â•â•â•`);

        // Reload the order page to guarantee a clean state (no lightboxes, no overlays)
        console.log(`[SparkP2P] Reloading order page for clean state...`);
        await page.goto(
          `https://p2p.binance.com/en/fiatOrderDetail?orderNo=${order.orderNumber}`,
          { waitUntil: 'domcontentloaded', timeout: 15000 }
        ).catch(() => {});

        // Wait for the chat panel to fully render before screenshotting
        // React needs time to hydrate â€" poll DOM for contenteditable on the right side
        console.log(`[SparkP2P] Waiting for chat panel to render...`);
        const chatPanelReady = await (async () => {
          for (let i = 0; i < 20; i++) {
            const found = await page.evaluate(() => {
              const els = Array.from(document.querySelectorAll('[contenteditable="true"]'));
              return els.some(el => {
                const r = el.getBoundingClientRect();
                return r.width > 50 && r.left > window.innerWidth * 0.3;
              });
            }).catch(() => false);
            if (found) { console.log(`[SparkP2P] Chat panel ready (${(i+1)*500}ms)`); return true; }
            await new Promise(r => setTimeout(r, 500));
          }
          console.log(`[SparkP2P] Chat panel not detected â€" proceeding anyway`);
          return false;
        })();
        await new Promise(r => setTimeout(r, 1000)); // extra settle time

        // 1. Send message to buyer â€" Vision finds "Enter message here" and types
        const chatMsg = `Your payment of KES ${order.totalPrice} has been received and verified successfully. I am now releasing your crypto. Thank you!`;
        await sendChatMessage(page, chatMsg);
        await new Promise(r => setTimeout(r, 500));
        if (pauseNavigation) break;

        // 2. Click Payment Received
        const btnClicked = await page.evaluate(() => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
          while (walker.nextNode()) {
            const el = walker.currentNode;
            if (el.tagName !== 'BUTTON') continue;
            const t = (el.textContent || '').trim().toLowerCase();
            if (t === 'payment received' || t.startsWith('payment received')) {
              el.click(); return true;
            }
          }
          return false;
        });
        console.log(`[SparkP2P] Payment Received button clicked: ${btnClicked}`);
        await new Promise(r => setTimeout(r, 2000));

        // 3. Vision handles: modal checkbox → Confirm Release → security verification
        // skipNavigation=true â€" we're already on the order page with the modal open.
        // EP-20: try API release first — if it succeeds, skip Vision entirely
        let _apiReleased = false;
        try {
          const _rlRes = await fetch(`${API_BASE}/ext/release-coin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ order_number: order.orderNumber }),
          }).catch(() => null);
          if (_rlRes?.ok) {
            const _rlData = await _rlRes.json().catch(() => ({}));
            _apiReleased = _rlData.ok === true;
            if (_apiReleased) console.log(`[SparkP2P] ✅ EP-20 API release success for ${order.orderNumber} — no Vision needed`);
            else console.log(`[SparkP2P] EP-20 release returned ok=false for ${order.orderNumber} — falling back to Vision`);
          }
        } catch(_e) {}
        if (!_apiReleased) {
          await releaseWithVision(page, order.orderNumber, { preChatCodes: { mpesaCodes: [vd.code], bankRefs: [] } }, { skipNavigation: true });
        }

        // Cleanup
        activeOrderNumber = null;
        activeOrderFiatAmount = 0;
        verifiedOrders.delete(order.orderNumber);
        orderChatHistory.delete(order.orderNumber);
        delete orderFirstSeenAt[order.orderNumber]; _removeOrderFlags(order.orderNumber);
        codeFallbackAskedOrders.delete(order.orderNumber);
      delete partialPayments[order.orderNumber];
      delete lastDeficitSent[order.orderNumber];
        orderReminderSent.delete(order.orderNumber);
      delete orderLastBotReplyAt[order.orderNumber];
        if (orderReminderSent._times) delete orderReminderSent._times[order.orderNumber + '_waiting_mpesa'];

      } else {
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // FIRST VISIT: read the payment screenshot, verify the M-Pesa code.
      // Do NOT click Payment Received here â€" that happens on the next poll.
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
        console.log(`[SparkP2P] â•â•â• Order ${order.orderNumber} â€" FIRST VISIT (verify only) â•â•â•`);


        // ── Choice Bank payment verification (runs before M-Pesa code check) ──
        let _choiceHandled = false;
        const _choiceVerifyRes = await fetch(
          `${API_BASE}/ext/choice-payment-received?order_number=${encodeURIComponent(order.orderNumber)}`,
          { headers: { 'Authorization': `Bearer ${token}` } }
        ).catch(() => null);
        if (_choiceVerifyRes?.ok) {
          const _choiceVerifyData = await _choiceVerifyRes.json().catch(() => ({}));
          const _cvPaid = _choiceVerifyData.total_paid || 0;
          if (_choiceVerifyData.received) {
            // Full Choice Bank payment confirmed — release immediately
            console.log(`[SparkP2P] ✅ Choice Bank full payment confirmed (KES ${_cvPaid}) — releasing immediately`);
            const _cvMsg = await generateUniqueMessage('payment_verified_releasing', null, { amount: order.totalPrice })
              || `Your payment of KES ${order.totalPrice.toLocaleString()} has been confirmed via our banking system. Releasing your crypto now — thank you!`;
            await sendChatMessage(page, _cvMsg);
            await new Promise(r => setTimeout(r, 500));
            if (!pauseNavigation) {
              const _cvBtnClicked = await page.evaluate(() => {
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
                while (walker.nextNode()) {
                  const el = walker.currentNode;
                  if (el.tagName !== 'BUTTON') continue;
                  const t = (el.textContent || '').trim().toLowerCase();
                  if (t === 'payment received' || t.startsWith('payment received')) { el.click(); return true; }
                }
                return false;
              });
              console.log(`[SparkP2P] Payment Received button clicked: ${_cvBtnClicked}`);
              await new Promise(r => setTimeout(r, 2000));
              activeOrderNumber = order.orderNumber;
              activeOrderFiatAmount = order.totalPrice;
              await releaseWithVision(page, order.orderNumber, { preChatCodes: { mpesaCodes: [], bankRefs: [] } }, { skipNavigation: true });
              activeOrderNumber = null;
              activeOrderFiatAmount = 0;
            }
            // Cleanup
            verifiedOrders.delete(order.orderNumber);
            delete orderFirstSeenAt[order.orderNumber]; _removeOrderFlags(order.orderNumber);
            codeFallbackAskedOrders.delete(order.orderNumber);
            delete partialPayments[order.orderNumber];
            delete lastDeficitSent[order.orderNumber];
            delete lastSellDeficitMsg[order.orderNumber];
            sellPayInstructSentOrders.delete(order.orderNumber);
            sellApprovalRequestedOrders.delete(order.orderNumber);
            sellApprovedOrders.delete(order.orderNumber);
            orderReminderSent.delete(order.orderNumber);
            delete orderLastBotReplyAt[order.orderNumber];
            _choiceHandled = true;
          } else if (_cvPaid > 0) {
            // Partial Choice Bank payment — send deficit message and wait
            const _cvDeficit = Math.round((Number(order.totalPrice) - _cvPaid) * 100) / 100;
            if (lastSellDeficitMsg[order.orderNumber] !== _cvDeficit) {
              const _cvDefMsg = `We have received KES ${_cvPaid.toLocaleString()} of the required KES ${order.totalPrice.toLocaleString()}. Please send the remaining KES ${_cvDeficit.toLocaleString()} and we will release your crypto immediately.`;
              await sendChatMessage(page, _cvDefMsg);
              lastSellDeficitMsg[order.orderNumber] = _cvDeficit;
              console.log(`[SparkP2P] Choice Bank partial (verify_payment): KES ${_cvPaid}/${order.totalPrice} — deficit message sent`);
            }
            _choiceHandled = true;
          }
        }
        if (!_choiceHandled) {
        // Choice Bank payment not yet confirmed — buyer marked as paid but payment not detected.
        // Send a brief "verifying" message once, then wait silently for the webhook to fire.
        const _awaitKey = order.orderNumber + '_awaiting_choice_confirm';
        if (!codeFallbackAskedOrders.has(_awaitKey)) {
          await sendChatMessage(page, `Thank you! We're verifying your payment through our banking system. Your crypto will be released automatically as soon as the payment is confirmed.`);
          codeFallbackAskedOrders.add(_awaitKey);
          console.log(`[SparkP2P] Order ${order.orderNumber} — buyer marked paid, Choice Bank not yet confirmed — sent wait message`);
        } else {
          console.log(`[SparkP2P] Order ${order.orderNumber} — buyer marked paid, waiting for Choice Bank confirmation (silent)`);
        }
        } // end _choiceHandled guard
      } // end FIRST VISIT

    // â"€â"€ Mid-release state â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    } else if (['confirm_release_modal','security_verification','totp_input','email_otp_input','passkey_failed'].includes(screen)) {
      console.log(`[SparkP2P] Order ${order.orderNumber} mid-release (${screen}) â€" completing now`);
      activeOrderNumber = order.orderNumber;
      activeOrderFiatAmount = order.totalPrice;
      await releaseWithVision(page, order.orderNumber, {});
      activeOrderNumber = null;
      activeOrderFiatAmount = 0;
      delete orderFirstSeenAt[order.orderNumber]; _removeOrderFlags(order.orderNumber);
      codeFallbackAskedOrders.delete(order.orderNumber);
      delete partialPayments[order.orderNumber];
      delete lastDeficitSent[order.orderNumber];
      verifiedOrders.delete(order.orderNumber);
      orderReminderSent.delete(order.orderNumber);
      delete orderLastBotReplyAt[order.orderNumber];

    // â"€â"€ Awaiting buyer payment â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    } else if (screen === 'awaiting_payment' || screen === 'payment_processing' ||
               lower.includes('awaiting') || lower.includes('pending payment')) {

      // â"€â"€ Check countdown: if â‰¤ 2 minutes remaining, cancel the order â"€â"€â"€â"€â"€â"€â"€â"€
      const countdown = await page.evaluate(() => {
        // Binance renders countdown as MM:SS text â€" find smallest visible timer
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const pattern = /^\d{1,2}:\d{2}$/;
        let smallest = null;
        while (walker.nextNode()) {
          const t = walker.currentNode.textContent.trim();
          if (pattern.test(t)) {
            const [mm, ss] = t.split(':').map(Number);
            const totalSecs = mm * 60 + ss;
            if (smallest === null || totalSecs < smallest) smallest = totalSecs;
          }
        }
        return smallest; // null if not found
      }).catch(() => null);

      if (countdown !== null) {
        console.log(`[SparkP2P] Order ${order.orderNumber} countdown: ${Math.floor(countdown / 60)}:${String(countdown % 60).padStart(2, '0')} (${countdown}s remaining)`);
      }

      // Never self-cancel a REJECTED sell order — a seller-initiated cancel hurts our completion
      // rate. We asked the buyer to cancel; otherwise let Binance expire it (counts against buyer).
      const nearExpiry = countdown !== null && countdown <= 120 && !sellRejectedOrders.has(order.orderNumber); // â‰¤ 2 minutes

      if (nearExpiry) {
        console.log(`[SparkP2P] â° Order ${order.orderNumber} is about to expire (${countdown}s left) â€" cancelling`);
        // Use TreeWalker to find and click the Cancel / Cancel Order button
        const cancelled = await page.evaluate(() => {
          const cancelPhrases = ['cancel order', 'cancel', 'cancel the order'];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
          while (walker.nextNode()) {
            const el = walker.currentNode;
            if (el.tagName !== 'BUTTON' && el.tagName !== 'A') continue;
            const t = (el.textContent || '').trim().toLowerCase();
            if (cancelPhrases.some(p => t === p || t.startsWith(p))) {
              el.click();
              return true;
            }
          }
          return false;
        });
        if (cancelled) {
          console.log(`[SparkP2P] Order ${order.orderNumber} cancel clicked â€" waiting for confirmation dialog`);
          await new Promise(r => setTimeout(r, 2000));
          // Confirm the cancellation dialog if it appears
          await page.evaluate(() => {
            const phrases = ['confirm', 'yes', 'confirm cancel', 'yes, cancel'];
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
            while (walker.nextNode()) {
              const el = walker.currentNode;
              if (el.tagName !== 'BUTTON') continue;
              const t = (el.textContent || '').trim().toLowerCase();
              if (phrases.some(p => t === p || t.startsWith(p))) {
                el.click();
                return true;
              }
            }
            return false;
          });
          await new Promise(r => setTimeout(r, 1000));
          await takeScreenshot(`cancel_expired_${order.orderNumber}`, page);
          delete orderFirstSeenAt[order.orderNumber]; _removeOrderFlags(order.orderNumber);
          orderReminderSent.delete(order.orderNumber);
      delete orderLastBotReplyAt[order.orderNumber];
          codeFallbackAskedOrders.delete(order.orderNumber);
      delete partialPayments[order.orderNumber];
      delete lastDeficitSent[order.orderNumber];
          verifiedOrders.delete(order.orderNumber);
        } else {
          console.log(`[SparkP2P] Order ${order.orderNumber} â€" could not find Cancel button, will retry next cycle`);
        }
      } else if (sellRejectedOrders.has(order.orderNumber)) {
        // Merchant rejected this SELL order. We do NOT cancel it ourselves — a seller-initiated
        // cancellation hurts our completion rate. Instead, send a polite, professional message
        // (once) asking the buyer to cancel, then let the order ride: the buyer cancels, or
        // Binance expires it at the payment deadline (which counts against the buyer, not us).
        if (!sellRejectionMsgSent.has(order.orderNumber)) {
          const rejMsg =
            `Hello, and thank you for your order. I sincerely apologize, but I am currently ` +
            `experiencing a temporary issue with my bank and I am unable to complete this ` +
            `transaction at the moment. To save you time, kindly cancel this order so you can ` +
            `trade with another merchant without any delay. I am very sorry for the inconvenience ` +
            `and truly appreciate your understanding. Thank you.`;
          await sendBinanceChatMessage(page, rejMsg).catch(() => {});
          sellRejectionMsgSent.add(order.orderNumber);
          console.log(`[SparkP2P] Order ${order.orderNumber} — rejected (sell): sent polite cancel request, NOT self-cancelling`);
          sendBotLog('info', `Sell order ${order.orderNumber} rejected — asked buyer to cancel (no seller-side cancel)`);
        } else {
          console.log(`[SparkP2P] Order ${order.orderNumber} — rejected (sell): awaiting buyer cancel / expiry (silent)`);
        }

      } else if (!sellApprovalRequestedOrders.has(order.orderNumber)) {
        // ── STEP 1: First time seeing this order — request Telegram approval ──
        console.log(`[SparkP2P] Order ${order.orderNumber} — new sell order, requesting Telegram approval`);
        // Primary: confirmed Binance stats via backend EP-19; fallback to browser scraping
        let _buyerStats = null;
        try {
          const _csRes = await fetch(`${API_BASE}/ext/counterparty-stats?order_number=${encodeURIComponent(order.orderNumber)}`,
            { headers: { 'Authorization': `Bearer ${token}` } });
          if (_csRes.ok) { const _cs = await _csRes.json(); if (_cs.ok) _buyerStats = _cs; }
        } catch (_) {}
        if (!_buyerStats) _buyerStats = await fetchCounterpartyStats(page, order.orderNumber, 'buyer').catch(() => ({}));
        const _buyerNick = order.buyerNickname || order.counterparty || '';
        const _approvalBody = {
          order: {
            orderNumber: order.orderNumber,
            totalPrice: order.totalPrice,
            buyerNickname: _buyerNick,
            counterparty: _buyerNick,
          },
          buyer_stats: _buyerStats || {},
        };
        if (botFullAuto) {
          // Strict full-auto: screen here and auto-decide — no manual approval card.
          const _s = _buyerStats || {};
          const _ret = _s.tradedBefore === true;
          let _ff = null;
          if (!_ret) {
            if (ddEnabled) {
              if (ddAutoCancelNew && _s.trades_all != null && _s.trades_all < 5) _ff = `brand-new account (${_s.trades_all} trades)`;
              if (!_ff && ddMin30d > 0 && _s.trades_30d != null && _s.trades_30d < ddMin30d) _ff = `low 30-day trades (${_s.trades_30d}/${ddMin30d})`;
              if (!_ff && ddMinAll > 0 && _s.trades_all != null && _s.trades_all < ddMinAll) _ff = `low all-time trades (${_s.trades_all}/${ddMinAll})`;
            }
            if (cfEnabled) {
              if (!_ff && cfMin30d > 0 && _s.trades_30d != null && _s.trades_30d < cfMin30d) _ff = `insufficient 30-day trades (${_s.trades_30d}/${cfMin30d})`;
              if (!_ff && cfMinAll > 0 && _s.trades_all != null && _s.trades_all < cfMinAll) _ff = `insufficient all-time trades (${_s.trades_all}/${cfMinAll})`;
            }
          }
          sellApprovalRequestedOrders.add(order.orderNumber);
          if (_ff) {
            sellRejectedOrders.add(order.orderNumber);
            sendBotLog('info', `Sell order ${order.orderNumber} auto-rejected (full-auto) — ${_ff}`);
            await fetch(`${API_BASE}/ext/notify-trader`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ message: `🤖 Auto-rejected sell order ${order.orderNumber} (KES ${(order.totalPrice || 0).toLocaleString()}) — failed screening: ${_ff}. A polite cancel message was sent.` }) }).catch(() => {});
            console.log(`[SparkP2P] FULL-AUTO idleScan auto-reject ${order.orderNumber} — ${_ff}`);
          } else {
            sellApprovedOrders.add(order.orderNumber);   // STEP 3 sends the payment details
            sendBotLog('info', `Sell order ${order.orderNumber} auto-approved (full-auto) — passed screening`);
            console.log(`[SparkP2P] FULL-AUTO idleScan auto-approve ${order.orderNumber}`);
          }
        } else {
          const _approvalRes = await fetch(`${API_BASE}/telegram/request-approval`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify(_approvalBody),
          }).catch(() => null);
          sellApprovalRequestedOrders.add(order.orderNumber);
          const _approvalOk = _approvalRes?.ok ? (await _approvalRes.json().catch(() => ({}))).ok : false;
          console.log(`[SparkP2P] Telegram approval request sent for ${order.orderNumber}: ${_approvalOk ? 'OK' : 'FAILED'}`);
          sendBotLog('info', `Sell order ${order.orderNumber} — waiting for Telegram approval`);
        }

      } else if (!sellApprovedOrders.has(order.orderNumber)) {
        // ── STEP 2: Poll Telegram approval status ──
        const _statusRes = await fetch(
          `${API_BASE}/telegram/approval-status?order_number=${encodeURIComponent(order.orderNumber)}`,
          { headers: { 'Authorization': `Bearer ${token}` } }
        ).catch(() => null);
        const _statusData = _statusRes?.ok ? await _statusRes.json().catch(() => ({})) : {};
        const _approvalStatus = _statusData.status || 'pending';
        console.log(`[SparkP2P] Order ${order.orderNumber} Telegram approval status: ${_approvalStatus}`);

        if (_approvalStatus === 'approved') {
          sellApprovedOrders.add(order.orderNumber);
          console.log(`[SparkP2P] ✅ Order ${order.orderNumber} APPROVED by merchant`);
          sendBotLog('success', `Sell order ${order.orderNumber} approved — sending payment instructions`);
        } else if (_approvalStatus === 'rejected' || _approvalStatus === 'timeout') {
          sellRejectedOrders.add(order.orderNumber);
          console.log(`[SparkP2P] ❌ Order ${order.orderNumber} ${_approvalStatus} by merchant`);
        } else {
          console.log(`[SparkP2P] Order ${order.orderNumber} — still waiting for merchant approval (${_approvalStatus})`);
        }

      }

      // ── STEP 3: Send payment instructions once approved ──
      if (sellApprovedOrders.has(order.orderNumber) && !sellPayInstructSentOrders.has(order.orderNumber)) {
        const _choiceAccNum = traderChoiceAccountNumber || '';
        const _orderAmount = Number(order.totalPrice);
        const _lowerPage = (await page.evaluate(() => document.body.innerText).catch(() => '')).toLowerCase();

        // Detect buyer payment method from Binance order page
        const _isPesaLink = _lowerPage.includes('pesalink') || _lowerPage.includes('pesa link') ||
          _lowerPage.includes('bank transfer') || _lowerPage.includes('equity bank') ||
          _lowerPage.includes('kcb') || _lowerPage.includes('co-op') || _lowerPage.includes('cooperative') ||
          _lowerPage.includes('absa') || _lowerPage.includes('stanbic') || _lowerPage.includes('family bank') ||
          _lowerPage.includes('ncba') || _lowerPage.includes('dtb') || _lowerPage.includes('diamond trust');
        const _isMpesa = !_isPesaLink;

        // Choice Bank production paybill (was a stale hardcoded 4007199). Sent as separate, easy-to-
        // copy messages: intro, paybill, account number — matching the approved-buyer path.
        const _PAYBILL = '444174';
        let _payMsgs = [];
        if (_isPesaLink) {
          _payMsgs = [
            `Hello! Please send KES ${_orderAmount.toLocaleString()} via PesaLink to Choice Microfinance Bank 👇`,
            `Bank: Choice Microfinance Bank`,
            `Account Number: ${_choiceAccNum}`,
            `Once sent, share your bank confirmation here and I'll release your crypto. Thank you!`,
          ];
        } else if (_isMpesa && _orderAmount > 250000) {
          // M-Pesa per-transaction limit is 250K — buyer pays in two transactions to the same paybill.
          const _secondTx = _orderAmount - 250000;
          _payMsgs = [
            `Hello! Please send KES ${_orderAmount.toLocaleString()} via M-Pesa in TWO transactions to the Paybill below 👇`,
            `Paybill Number: ${_PAYBILL}`,
            `Account Number: ${_choiceAccNum}`,
            `1️⃣ Send KES 250,000 first, then 2️⃣ send KES ${_secondTx.toLocaleString()} to the same Paybill + account. Then tap "I've Sent Payment". Thank you!`,
          ];
        } else {
          _payMsgs = [
            `Hello! Please send KES ${_orderAmount.toLocaleString()} via M-Pesa to the Paybill below. Your crypto is released automatically once payment is received 👇`,
            `Paybill Number: ${_PAYBILL}`,
            `Account Number: ${_choiceAccNum}`,
          ];
        }

        if (_choiceAccNum) {
          for (let i = 0; i < _payMsgs.length; i++) {
            await sendBinanceChatMessage(page, _payMsgs[i]);
            if (i < _payMsgs.length - 1) await new Promise(r => setTimeout(r, 1000 + Math.random() * 800));  // human-like gap
          }
          sellPayInstructSentOrders.add(order.orderNumber);
          console.log(`[SparkP2P] Order ${order.orderNumber} — payment instructions sent (${_isPesaLink ? 'PesaLink' : _orderAmount > 250000 ? 'M-Pesa split' : 'M-Pesa'}, ${_payMsgs.length} msgs, paybill ${_PAYBILL})`);
        } else {
          console.log(`[SparkP2P] Order ${order.orderNumber} — Choice Bank account number not set, cannot send instructions`);
        }
      }

      // ── STEP 4: Poll Choice Bank for incoming payment & send deficit messages ──
      if (sellApprovedOrders.has(order.orderNumber) && sellPayInstructSentOrders.has(order.orderNumber)) {
        const _cbPollRes = await fetch(
          `${API_BASE}/ext/choice-payment-received?order_number=${encodeURIComponent(order.orderNumber)}`,
          { headers: { 'Authorization': `Bearer ${token}` } }
        ).catch(() => null);
        if (_cbPollRes?.ok) {
          const _cbPollData = await _cbPollRes.json().catch(() => ({}));
          const _cbPaid = _cbPollData.total_paid || 0;
          if (_cbPollData.received) {
            console.log(`[SparkP2P] Order ${order.orderNumber} — Choice Bank FULL payment confirmed (KES ${_cbPaid}) — waiting for buyer to mark as paid`);
            sendBotLog('success', `Sell order ${order.orderNumber} — Choice Bank payment received KES ${_cbPaid}`);
          } else if (_cbPaid > 0) {
            // Partial payment — send deficit message (deduped)
            const _cbDeficit = Math.round((Number(order.totalPrice) - _cbPaid) * 100) / 100;
            if (lastSellDeficitMsg[order.orderNumber] !== _cbDeficit) {
              const _defMsg = `Thank you for your payment! We have received KES ${_cbPaid.toLocaleString()} so far. Please send the remaining KES ${_cbDeficit.toLocaleString()} to the same paybill to complete the transaction.`;
              await sendBinanceChatMessage(page, _defMsg);
              lastSellDeficitMsg[order.orderNumber] = _cbDeficit;
              console.log(`[SparkP2P] Order ${order.orderNumber} — Choice Bank partial: KES ${_cbPaid}/${order.totalPrice} — deficit message sent`);
            }
          } else {
            console.log(`[SparkP2P] Order ${order.orderNumber} — Choice Bank: no payment yet (${seenMins}m elapsed)`);
          }
        }
      } else if (!sellApprovalRequestedOrders.has(order.orderNumber)) {
        // Silent wait — approval not yet requested (happens when buyerStats fetch delays things)
        console.log(`[SparkP2P] Order ${order.orderNumber} — awaiting buyer payment (${seenMins}m elapsed, ${countdown !== null ? countdown + 's left' : 'no timer'}) — silent`);
      }
      // Move on — check other orders

    // â"€â"€ Cancelled â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    } else if (lower.includes('cancelled') || lower.includes('canceled')) {
      console.log(`[SparkP2P] Sell order ${order.orderNumber} CANCELLED`);
      await fetch(`${API_BASE}/ext/report-orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ sell_orders: [], buy_orders: [], cancelled_order_numbers: [order.orderNumber] }),
      }).catch(() => {});
      delete orderFirstSeenAt[order.orderNumber]; _removeOrderFlags(order.orderNumber);
      orderReminderSent.delete(order.orderNumber);
      delete orderLastBotReplyAt[order.orderNumber];
      sellApprovalRequestedOrders.delete(order.orderNumber);
      sellApprovedOrders.delete(order.orderNumber);
      sellRejectedOrders.delete(order.orderNumber);
      sellPayInstructSentOrders.delete(order.orderNumber);
      delete lastSellDeficitMsg[order.orderNumber];

    } else {
      console.log(`[SparkP2P] Sell order ${order.orderNumber} state unclear (${screen}) â€" will recheck next cycle`);
    }
  }

  }  // end sell orders block
  // â"€â"€ Step 5: Cycle through ALL buy orders â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  if (orders.buy.length > 0) {
    console.log(`[SparkP2P] ðŸ'³ ${orders.buy.length} buy order(s) â€" cycling through all`);
  }
  if (botTradeMode === 'sell_only') {
    if (orders.buy.length > 0) console.log(`[SparkP2P] Skipping ${orders.buy.length} buy order(s) — mode: sell_only (trader handles manually)`);
  } else {
  for (const order of orders.buy) {
    if (pauseNavigation) break;
    console.log(`[SparkP2P] Checking buy order ${order.orderNumber}`);

    // Only navigate to order page if not already there — keeps the bot parked on the active order.
    const targetOrderUrl = `https://p2p.binance.com/en/fiatOrderDetail?orderNo=${order.orderNumber}`;
    const currentUrl = page.url();
    if (!currentUrl.includes(order.orderNumber)) {
      await page.goto(targetOrderUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 3000));
    } else {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 1500));
    }
    if (pauseNavigation) break;

    await dismissBinanceModals(page);
    await takeScreenshot(`scan_buy_${order.orderNumber}`, page);

    // Vision primary, DOM fallback
    // DOM-first: free, instant. Vision only when DOM returns 'unknown'.
    let buyScreen = await detectOrderState(page);
    let buyVisionInfo = null;
    let buyUsedVision = false;
    if (buyScreen === 'unknown' && anthropicApiKey) {
      buyVisionInfo = await analyzePageWithVision(page);
      buyScreen = buyVisionInfo?.screen || 'unknown';
      buyUsedVision = true;
    }
    if (buyScreen === 'unknown') {
      await new Promise(r => setTimeout(r, 2000));
      buyScreen = await detectOrderState(page);
      if (buyScreen === 'unknown' && anthropicApiKey) {
        buyVisionInfo = await analyzePageWithVision(page);
        buyScreen = buyVisionInfo?.screen || 'unknown';
        buyUsedVision = true;
      }
    }
    _cycleVision += buyUsedVision ? 1 : 0;
    _cycleDom   += buyUsedVision ? 0 : 1;
    console.log(`[SparkP2P] Buy order ${order.orderNumber} state: ${buyScreen} (via ${buyUsedVision ? 'Vision' : 'DOM'})`);
    const buyText = await page.evaluate(() => document.body.innerText).catch(() => '');
    const buyLower = buyText.toLowerCase();

    // â"€â"€ Seller released crypto â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    if (buyScreen === 'order_complete' ||
        buyLower.includes('order completed') || buyLower.includes('crypto received')) {
      console.log(`[SparkP2P] âœ… Buy order ${order.orderNumber} COMPLETED â€" crypto received!`);
      const orderNum = order.orderNumber;
      // Only notify if this bot session actually sent the payment.
      // If buyPaymentSentAt is not set (bot restarted mid-order or order completed offline),
      // notify=false so no Telegram/SMS fires for a stale completion.
      const paidThisSession = !!buyPaymentSentAt[orderNum];
      const buyCompRes = await fetch(`${API_BASE}/ext/report-buy-completed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ order_number: orderNum, notify: paidThisSession }),
      }).catch(e => { console.error('[SparkP2P] report-buy-completed failed:', e.message); return null; });
      if (buyCompRes?.ok) {
        // Only block reconcile/idleScan from re-reporting once backend confirmed receipt
        reportedCompletedBuyOrders.add(orderNum);
        saveReportedCompleted(reportedCompletedBuyOrders);
      } else if (!buyCompRes) {
        console.warn(`[SparkP2P] report-buy-completed failed for ${orderNum} — reconcile will retry`);
        sendBotLog('warn', `Buy order ${orderNum} completion report failed — will retry automatically`);
      }
      delete orderFirstSeenAt[orderNum]; _removeOrderFlags(orderNum);
      delete buyPaymentSentAt[orderNum];
      buyReminderSentOrders.delete(orderNum);
      delete buyOrderDetailsMap[orderNum];
      delete imPaymentDoneMap[orderNum];
      imPaymentFailedOrders.delete(orderNum);
      buyGreetingSentOrders.delete(orderNum);
      buyPostPaymentMsgSentOrders.delete(orderNum);
      removePaidOrder(orderNum);
      if (activeBuyOrderNumber === orderNum) activeBuyOrderNumber = null;
      stats.actions++;

    // â"€â"€ Dispute / expired after we paid â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    // "appeal" text appears normally on Binance after payment confirmed â€" only treat it as
    // a dispute if the seller hasn't released after 20 minutes. "order expired" fires immediately.
    } else if (buyPaymentSentAt[order.orderNumber] && (() => {
        const minsWaited = Math.floor((Date.now() - buyPaymentSentAt[order.orderNumber]) / 60000);
        const hardExpired = buyLower.includes('order expired') || buyLower.includes('order has expired');
        const appealTimeout = buyLower.includes('appeal') && minsWaited >= 20;
        return hardExpired || appealTimeout;
      })()) {
      const orderNum = order.orderNumber;
      const details = buyOrderDetailsMap[orderNum] || {};
      const minsWaited = Math.floor((Date.now() - buyPaymentSentAt[orderNum]) / 60000);
      console.log(`[SparkP2P] ðŸš¨ Buy order ${orderNum} â€" dispute/expired after ${minsWaited}m â€" pausing ad & notifying trader`);
      await pauseBuyAdAndNotify(page, orderNum, buyOrderDetailsMap[orderNum]);
      await takeScreenshot(`paused ad: buy order ${orderNum}`);
      delete buyPaymentSentAt[orderNum];
      buyReminderSentOrders.delete(orderNum);
      if (activeBuyOrderNumber === orderNum) activeBuyOrderNumber = null;

    // â"€â"€ Cancelled â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    // Use Vision screen OR definitive past-tense phrases only.
    // "order will be cancelled in X mins" is a WARNING â€" not a cancellation.
    } else if (
      buyScreen === 'order_cancelled' ||
      buyLower.includes('order has been cancelled') ||
      buyLower.includes('order was cancelled') ||
      buyLower.includes('order is cancelled') ||
      buyLower.includes('has been canceled') ||
      (buyLower.includes('cancelled') && buyLower.includes('order number') && !buyLower.includes('will be cancelled'))
    ) {
      console.log(`[SparkP2P] Buy order ${order.orderNumber} CANCELLED`);
      await fetch(`${API_BASE}/ext/report-orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ sell_orders: [], buy_orders: [], cancelled_order_numbers: [order.orderNumber] }),
      }).catch(() => {});
      delete buyPaymentSentAt[order.orderNumber];
      buyReminderSentOrders.delete(order.orderNumber);
      if (activeBuyOrderNumber === order.orderNumber) activeBuyOrderNumber = null;

    // â"€â"€ We already paid â€" monitoring for seller release â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    } else if (buyPaymentSentAt[order.orderNumber]) {
      const minsWaiting = Math.floor((Date.now() - buyPaymentSentAt[order.orderNumber]) / 60000);
      const details = buyOrderDetailsMap[order.orderNumber] || {};

      if (minsWaiting >= 15) {
        console.log(`[SparkP2P] ðŸš¨ Buy order ${order.orderNumber} â€" ${minsWaiting} min no release â€" pausing buy ad & notifying trader`);
        await sendBinanceChatMessage(page,
          `Hi ${details.sellerName ? details.sellerName.split(' ')[0] : 'there'}, I sent KSh ${(details.amount || 0).toLocaleString()} ${minsWaiting} minutes ago and the crypto has not been released. I have notified the Binance support team. Please release the crypto at the earliest to avoid a formal dispute. Thank you.`
        );
        await new Promise(r => setTimeout(r, 1500));
        await pauseBuyAdAndNotify(page, order.orderNumber, details);
        await takeScreenshot(`15min pause buy: ${order.orderNumber}`);
        delete buyPaymentSentAt[order.orderNumber];
        buyReminderSentOrders.delete(order.orderNumber);
        if (activeBuyOrderNumber === order.orderNumber) activeBuyOrderNumber = null;
      } else if (minsWaiting >= 10 && !buyReminderSentOrders.has(order.orderNumber)) {
        console.log(`[SparkP2P] â° Buy order ${order.orderNumber} â€" 10 min reminder to seller`);
        await sendBinanceChatMessage(page,
          `Hi, just a friendly reminder — I sent the payment ${minsWaiting} minutes ago. Could you please release the crypto when you get a chance? Thank you! 😊`
        );
        buyReminderSentOrders.add(order.orderNumber);; _saveOrderFlag(order.orderNumber, 'reminderSent', true);
      }
      if (details.sellerName && anthropicApiKey) {
        await respondToBuyOrderChat(page, details);
      }
      console.log(`[SparkP2P] Buy order ${order.orderNumber} â€" waiting ${minsWaiting}m for release (${buyScreen})`);

    // ── Payment sent but tracking lost (restart / manual pay) ────────────────
    // If Binance shows "awaiting seller's release" but we have no buyPaymentSentAt
    // entry, the payment already happened. Set the timestamp now so the monitoring
    // block fires on the next cycle. DO NOT fall into the payment flow.
    } else if (
      buyScreen === 'awaiting_release' ||
      buyLower.includes('awaiting seller') ||
      buyLower.includes('pending the seller to release') ||
      buyLower.includes('seller to release') ||
      buyLower.includes('waiting for the seller')
    ) {
      buyPaymentSentAt[order.orderNumber] = Date.now();
      savePaidOrder(order.orderNumber, { source: 'restored', amount: order.fiatAmount });
      console.log(`[SparkP2P] ⚠️ Buy order ${order.orderNumber} — "awaiting release" detected but tracking was lost — restored payment tracking, monitoring next cycle`);
      sendBotLog('warn', `Buy order ${order.orderNumber}: payment tracking restored — awaiting seller release. Will monitor for release or timeout.`);

    } else {
      // Payment not yet sent -- screen seller first (DD), then extract details and pay
      let sellerStats = null; // hoisted so Telegram advisory block can read stats from first cycle

      // Primary: get order detail + seller stats from backend API (uses stored session,
      // independent of Puppeteer browser state). Skips DOM/Vision for payment extraction.
      try {
        const detailRes = await fetch(`${API_BASE}/ext/order-detail?order_number=${order.orderNumber}`, {
          headers: { 'Authorization': `Bearer ${token}` },
        }).catch(() => null);
        if (detailRes && detailRes.ok) {
          const detail = await detailRes.json().catch(() => null);
          if (detail && detail.ok) {
            if (detail.phone || detail.account_number) {
              buyPaymentDetailsCache[order.orderNumber] = {
                method: detail.method || 'mpesa',
                phone: detail.phone || null,
                account_number: detail.account_number || null,
                bank_name: detail.bank_name || null,
                amount: detail.fiat_amount,
                name: detail.counterparty_name || '',
                reference: order.orderNumber,
                network: /airtel/i.test(detail.method || '') ? 'airtel' : 'safaricom',
                _source: 'backend_api',
              };
              console.log(`[SparkP2P] Backend detail: ${detail.method}, ${detail.phone || detail.account_number}, ${detail.counterparty_name}`);
            }
            if (detail.trades_30d != null || detail.trades_all != null) {
              sellerStats = {
                trades_30d: detail.trades_30d,
                trades_all: detail.trades_all,
                completionRate: detail.completion_rate || '',
                avgPayMins: detail.avg_pay_mins,
                avgReleaseMins: null,
                accountAgeDays: detail.account_age_days,
              };
            }
          }
        }
      } catch(_) {}

      if (!orderFirstSeenAt[order.orderNumber] && ddEnabled) {
        const sellerNick = order.counterparty || '';
        sellerStats = await fetchCounterpartyStats(page, order.orderNumber, 'seller');
        const sellerReturning = await checkReturningBuyer(sellerNick);

        if (sellerReturning) {
          console.log(`[SparkP2P] DD: seller ${sellerNick} is returning -- bypassing screening`);
        } else {
          let failReason = null;
          if (ddAutoCancelNew && sellerStats.trades_all !== null && sellerStats.trades_all < 5)
            failReason = `brand-new account (${sellerStats.trades_all} all-time trades, minimum 5)`;
          if (!failReason && sellerStats.trades_30d !== null && sellerStats.trades_30d < ddMin30d)
            failReason = `low recent activity (${sellerStats.trades_30d} trades in 30 days, minimum ${ddMin30d})`;
          if (!failReason && ddMinAll > 0 && sellerStats.trades_all !== null && sellerStats.trades_all < ddMinAll)
            failReason = `low total trades (${sellerStats.trades_all} all-time, minimum ${ddMinAll})`;

          if (failReason) {
            console.log(`[SparkP2P] DD: seller ${sellerNick} FAILED -- ${failReason}`);
            await cancelOrderOnBinance(page, order.orderNumber, failReason);
            continue;
          }
          console.log(`[SparkP2P] DD: seller ${sellerNick} passed (30d: ${sellerStats.trades_30d ?? 'n/a'}, all: ${sellerStats.trades_all ?? 'n/a'})`);
        }
        // Cache payment details extracted from the Binance API (same trade/get call used for DD)
        if (sellerStats?.paymentDetails) {
          buyPaymentDetailsCache[order.orderNumber] = sellerStats.paymentDetails;
          console.log(`[SparkP2P] API extracted payment details for ${order.orderNumber}: method=${sellerStats.paymentDetails.method}, phone=${sellerStats.paymentDetails.phone}, acct=${sellerStats.paymentDetails.account_number}`);
        }
      }
      if (!orderFirstSeenAt[order.orderNumber]) {
        orderFirstSeenAt[order.orderNumber] = Date.now();
      }

      // Payment details — use Binance API result (cached from DD) first; fall back to DOM/Vision
      let paymentDetails = buyPaymentDetailsCache[order.orderNumber] || null;
      if (paymentDetails) {
        console.log(`[SparkP2P] Using API-sourced payment details for ${order.orderNumber} (${paymentDetails._source || 'api'})`);
      }
      if (!paymentDetails) {
      try {
        paymentDetails = await page.evaluate(() => {
          const getText = (labelRegex) => {
            const els = Array.from(document.querySelectorAll('div, span, td, p, th, li'));
            for (const el of els) {
              const raw = (el.innerText || el.textContent || '').trim();
              if (!raw || raw.length > 120) continue;
              const nl = raw.indexOf('\n');
              const firstLine = (nl > -1 ? raw.substring(0, nl) : raw).trim();
              if (!labelRegex.test(firstLine)) continue;
              if (nl > -1) {
                // Container element — value must come from within, not from nextSibling
                // (nextSibling would be the next field's container, not this field's value)
                if (el.children.length >= 2) {
                  const craw = (el.children[1].innerText || el.children[1].textContent || '').trim();
                  const cnl = craw.indexOf('\n');
                  const val = (cnl > -1 ? craw.substring(0, cnl) : craw).trim();
                  if (val && val !== firstLine && val.length < 200) return val;
                }
                const secondLine = raw.substring(nl + 1).trim();
                const sl2 = secondLine.indexOf('\n');
                const val2 = (sl2 > -1 ? secondLine.substring(0, sl2) : secondLine).trim();
                if (val2 && val2 !== firstLine && val2.length < 200) return val2;
                continue;
              }
              // Pure label element — look at siblings
              const parent = el.parentElement;
              const nextSib = el.nextElementSibling || (parent && parent.nextElementSibling);
              if (nextSib) {
                const nraw = (nextSib.innerText || nextSib.textContent || '').trim();
                const nnl = nraw.indexOf('\n');
                const val = (nnl > -1 ? nraw.substring(0, nnl) : nraw).trim();
                if (val && val !== firstLine && val.length < 200) return val;
              }
              if (parent && parent.children.length >= 2) {
                const craw = (parent.children[1].innerText || parent.children[1].textContent || '').trim();
                const cnl = craw.indexOf('\n');
                const val = (cnl > -1 ? craw.substring(0, cnl) : craw).trim();
                if (val && val !== firstLine && val.length < 200) return val;
              }
            }
            return null;
          };
          const bodyText = document.body.innerText || '';
          const phone = getText(/^phone number$/i) || (bodyText.match(/\b(07\d{8}|254\d{9}|\+254\d{9})\b/) || [])[1] || null;
          const name = getText(/^name$/i) || (() => {
            // Regex fallback: find a line that is ONLY "Name" then grab the next non-empty line
            const m = bodyText.match(/(?:^|\n)[ \t]*Name[ \t]*\r?\n[ \t]*([A-Za-z][A-Za-z .'-]{2,60})[ \t]*(?:\r?\n|$)/m);
            return m ? m[1].trim() : null;
          })();
          const via = getText(/^transfer via$/i) || '';
          const ref = getText(/^reference message$/i);
          const amtEl = bodyText.match(/KSh\s*([\d,]+\.?\d*)/);
          const amount = amtEl ? parseFloat(amtEl[1].replace(/,/g, '')) : null;
          // Bank account extraction — use bodyText regex first (most reliable on Binance),
          // fall back to DOM navigation if bodyText doesn't contain the expected pattern.
          const acctBodyMatch = bodyText.match(/Bank Card\/Account Number[\s\S]{0,10}?\n\s*([\d\s]+)\s*\n/i)
            || bodyText.match(/Account Number[\s\S]{0,10}?\n\s*([\d\s]+)\s*\n/i);
          const rawAcctBody = acctBodyMatch ? acctBodyMatch[1].trim() : null;
          const rawAcctDom = getText(/^bank card[/]account number$/i) || getText(/^account number$/i);
          const rawAcct = rawAcctBody || rawAcctDom;
          const account_number = rawAcct ? rawAcct.replace(/[^0-9]/g, '') : null;

          const bankBodyMatch = bodyText.match(/Bank name[\s\S]{0,5}?\n\s*([^\n]+)\s*\n/i);
          const bank_name = (bankBodyMatch ? bankBodyMatch[1].trim() : null) || getText(/^bank name$/i) || null;
          if (!amount) return null;
          if (!phone && account_number && bank_name) {
            // Bank transfer order
            const method = /i\s*&\s*m/i.test(bank_name) ? 'im_bank' : 'other_bank';
            return { method, phone: null, account_number, bank_name, name: name || '', amount, reference: ref || '', network: null };
          }
          if (!phone) return null;
          const method = /i\s*&\s*m/i.test(via) ? 'im_bank' : /mpesa|safaricom|m-pesa/i.test(via) ? 'mpesa' : 'mpesa';
          const network = /airtel/i.test(via) ? 'airtel' : 'safaricom';
          return { method, phone, name: name || '', amount, reference: ref || '', network };
        }).catch(() => null);
        if (paymentDetails?.phone) console.log(`[SparkP2P] L1 DOM extracted phone: ${paymentDetails.phone}, amount: ${paymentDetails.amount}`);
        else if (paymentDetails?.account_number) console.log(`[SparkP2P] L1 DOM extracted bank account: ${paymentDetails.account_number} (${paymentDetails.bank_name}), amount: ${paymentDetails.amount}`);
      } catch (_) {}

      // L2: Vision fallback — only if DOM extraction missed both phone and bank account details
      // (skipped entirely when API payment details are already cached)
      if (!paymentDetails && anthropicApiKey && !paymentDetails?.account_number && (!paymentDetails?.phone || !paymentDetails?.amount)) {
        console.log('[SparkP2P] L1 DOM extraction incomplete — falling back to Vision OCR');
        const domPhone = paymentDetails?.phone || null; // preserve DOM phone if Vision overwrites
        const paySS = await page.screenshot({ encoding: 'base64' }).catch(() => null);
        if (paySS) {
          const extractRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 300,
              messages: [{ role: 'user', content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: paySS } },
                { type: 'text', text: `Extract the payment details from this Binance P2P buy order page.
Return JSON only (no other text):
{
  "method": "mpesa | im_bank | other_bank",
  "phone": "07XXXXXXXX or 254XXXXXXXXX â€" phone number if M-Pesa, else null",
  "account_number": "bank account number if paying to a bank account, else null",
  "bank_name": "bank name e.g. 'I & M Bank', 'Equity Bank', 'KCB' â€" if bank transfer, else null",
  "name": "seller full name",
  "amount": 1234,
  "network": "safaricom | airtel | null",
  "reference": "order number"
}
Method selection rules:
- "mpesa" → payment method is M-PESA / Safaricom (phone number shown)
- "im_bank" → payment method is I&M Bank AND an ACCOUNT NUMBER is shown
- "other_bank" → payment method is any other bank (Equity, KCB, Co-op, Absa, etc.) with an account number` },
              ]}],
            }),
          }).catch(() => null);
          if (extractRes?.ok) {
            const d = await extractRes.json();
            const m = (d.content?.[0]?.text || '').match(/\{[\s\S]*\}/);
            if (m) {
              try {
                const visionData = JSON.parse(m[0]);
                // Always prefer DOM phone over Vision phone — DOM is exact, Vision can misread digits
                if (domPhone) visionData.phone = domPhone;
                paymentDetails = visionData;
              } catch (_) {}
            }
          }
        }
      }
      } // end: if (!paymentDetails from API cache)

      const _localPm = (paymentDetails?.method || 'mpesa').toLowerCase();
      const _localIsBank = _localPm === 'im_bank' || _localPm === 'other_bank';
      const _localMissingPhone = !_localIsBank && (!paymentDetails?.phone || paymentDetails.phone.trim() === '');
      const _localMissingAccount = _localIsBank && (!paymentDetails?.account_number || !paymentDetails?.bank_name);
      // Retry DOM extraction once more if still missing (page may not have fully rendered yet)
      if (!paymentDetails || !paymentDetails.amount || _localMissingPhone || _localMissingAccount) {
        console.log(`[SparkP2P] Buy order ${order.orderNumber} — payment details incomplete, retrying DOM in 4s`);
        await new Promise(r => setTimeout(r, 4000));
        try {
          const retryText = await page.evaluate(() => document.body.innerText).catch(() => '');
          const rPhone = (retryText.match(/\b(07\d{8}|254\d{9}|\+254\d{9})\b/) || [])[1] || null;
          const rAmtM = retryText.match(/KSh\s*([\d,]+\.?\d*)/);
          const rAmt = rAmtM ? parseFloat(rAmtM[1].replace(/,/g, '')) : null;
          const rNameM = retryText.match(/(?:^|\n)[ \t]*Name[ \t]*\r?\n[ \t]*([A-Za-z][A-Za-z .'"-]{2,60})[ \t]*(?:\r?\n|$)/m);
          const rName = rNameM ? rNameM[1].trim() : '';
          const rVia = (retryText.match(/Transfer via[:\s]+([^\n]+)/i) || [])[1] || '';
          const rMethod = /i\s*&\s*m/i.test(rVia) ? 'im_bank' : 'mpesa';
          if (rAmt && rPhone) {
            paymentDetails = { method: rMethod, phone: rPhone, name: rName, amount: rAmt, reference: order.orderNumber, network: 'safaricom', _source: 'dom_retry' };
            console.log(`[SparkP2P] DOM retry extracted: ${rPhone}, KES ${rAmt}`);
          }
        } catch(_) {}
      }
      if (!paymentDetails || !paymentDetails.amount || _localMissingPhone || _localMissingAccount) {
        console.log(`[SparkP2P] Buy order ${order.orderNumber} — could not extract payment details, will retry next cycle`);
        continue;
      }

      const method = _localPm;
      const firstName = (paymentDetails.name || 'Seller').split(' ')[0];
      const amt = Math.floor(parseFloat(paymentDetails.amount));

      console.log(`[SparkP2P] ðŸ'³ Buy order ${order.orderNumber} â€" paying KSh ${amt} to ${paymentDetails.name} via ${method}`);

      // Choice Bank payment (replaced I&M Bank)
      let imResult = { success: false, screenshot: null, referenceId: null };
      let imNameMismatchAborted = false;

      if (imPaymentDoneMap[order.orderNumber]) {
        console.log("[SparkP2P] Choice Bank payment already done for " + order.orderNumber + " — skipping");
        imResult = { success: true, ...imPaymentDoneMap[order.orderNumber] };
      } else if (imPaymentFailedOrders.has(order.orderNumber)) {
        console.log("[SparkP2P] Choice Bank payment previously failed for " + order.orderNumber + " — skipping");
        continue;
      } else {
        let verifiedName = "";

        if (!imNameMismatchAborted) {
          // ── Step 1: Telegram approval — fires IMMEDIATELY after payment details extracted ──
          // Seller stats (already fetched for DD check) are included so the trader sees the
          // full profile in Telegram before approving. Greeting is sent only after approval.
          let choiceBal = 0;
          try {
            const balRes = await fetch(`${API_BASE}/choice/balance/${traderChoiceAccountId}`, { headers: { 'Authorization': 'Bearer ' + token } }).catch(() => null);
            if (balRes && balRes.ok) { const bd = await balRes.json(); choiceBal = bd.balance || 0; }
          } catch(_e) {}

          // Build advisory from seller stats
          const _ss = sellerStats || {};
          let advisory = '';
          if (_ss.trades_30d != null && _ss.completionRate) {
            const cr = parseFloat(_ss.completionRate) || 0;
            if (cr >= 98 && _ss.trades_30d >= 100) {
              advisory = `Looks good\n  • Releases in ~${_ss.avgReleaseMins || _ss.avgPayMins || '?'} min on average`;
            } else if (cr < 90 || (_ss.trades_30d != null && _ss.trades_30d < 10)) {
              advisory = `Caution — low completion rate (${_ss.completionRate})`;
            } else {
              advisory = `Acceptable — ${_ss.completionRate} completion`;
            }
          }

          let buyApproved = false;
          if (!buyApprovalRequestedOrders.has(order.orderNumber)) {
            const approvalRes = await fetch(API_BASE + '/telegram/request-buy-approval', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
              body: JSON.stringify({
                order_number: order.orderNumber,
                seller_name: verifiedName || paymentDetails.name,
                amount: paymentDetails.amount,
                method: method,
                phone: paymentDetails.phone || '',
                account_number: paymentDetails.account_number || '',
                bank_name: paymentDetails.bank_name || '',
                choice_balance: choiceBal,
                trades_30d: _ss.trades_30d ?? null,
                trades_all: _ss.trades_all ?? null,
                completion_rate: _ss.completionRate || '',
                account_age_days: _ss.registeredDays ?? null,
                avg_release_mins: _ss.avgReleaseMins ?? null,
                avg_pay_mins: parseFloat(_ss.avgPayMins) || null,
                advisory,
              }),
            }).catch(() => null);
            const approvalData = approvalRes?.ok ? await approvalRes.json().catch(() => ({})) : {};
            if (approvalData.auto_approved) {
              buyApproved = true;
              console.log(`[SparkP2P] Buy ${order.orderNumber} — Telegram not linked, auto-approving payment`);
            } else {
              buyApprovalRequestedOrders.add(order.orderNumber); _saveOrderFlag(order.orderNumber, 'approvalRequested', true);
              sendBotLog('info', `Buy order ${order.orderNumber} — waiting for Telegram payment approval`);
              console.log(`[SparkP2P] Buy ${order.orderNumber} — Telegram approval sent immediately, bot on order page`);
            }
          } else {
            // Already requested — poll the status
            const statusRes = await fetch(
              `${API_BASE}/telegram/approval-status?order_number=${encodeURIComponent(order.orderNumber)}`,
              { headers: { 'Authorization': 'Bearer ' + token } }
            ).catch(() => null);
            const statusData = statusRes?.ok ? await statusRes.json().catch(() => ({})) : {};
            const approvalStatus = statusData.status || 'pending';
            console.log(`[SparkP2P] Buy ${order.orderNumber} — Telegram approval status: ${approvalStatus}`);

            if (approvalStatus === 'approved') {
              buyApproved = true;
              sendBotLog('success', `Buy order ${order.orderNumber} — approved, executing payment`);
            } else if (approvalStatus === 'rejected') {
              imPaymentFailedOrders.add(order.orderNumber); _saveOrderFlag(order.orderNumber, 'paymentFailed', true);
              sendBotLog('warning', `Buy order ${order.orderNumber} — payment declined on Telegram. Cancelling via API.`);
              // EP-9: cancel order via SAPI — no DOM clicking needed
              await fetch(`${API_BASE}/ext/cancel-order`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ order_number: order.orderNumber }),
              }).catch(() => null);
              console.log(`[SparkP2P] Buy order ${order.orderNumber} — cancelled via API (Telegram declined)`);
              delete orderFirstSeenAt[order.orderNumber]; _removeOrderFlags(order.orderNumber);
              continue;
            } else if (approvalStatus === 'timeout') {
              imPaymentFailedOrders.add(order.orderNumber); _saveOrderFlag(order.orderNumber, 'paymentFailed', true);
              sendBotLog('warning', `Buy order ${order.orderNumber} — Telegram approval timed out (20 min). Order will expire.`);
              continue;
            } else {
              // Still pending — come back next poll cycle
              continue;
            }
          }

          if (!buyApproved) continue;

          // ── Step 2: Send greeting NOW (after approval, not before) ──
          if (!buyGreetingSentOrders.has(order.orderNumber)) {
            buyGreetingSentOrders.add(order.orderNumber); _saveOrderFlag(order.orderNumber, 'greetingSent', true);
            let greetMsg = '';
            if (method === 'mpesa') {
              greetMsg = `Hello ${firstName}, I will be sending KES ${amt} to your M-Pesa number ${paymentDetails.phone} shortly. Please be ready to receive. Thank you! 🙏`;
            } else {
              greetMsg = `Hello ${firstName}, I will be sending KES ${amt} directly to your ${paymentDetails.bank_name || 'bank'} account (${paymentDetails.account_number || ''}) shortly. Thank you! 🙏`;
            }
            await sendBinanceChatMessage(page, greetMsg);
            console.log(`[SparkP2P] ðŸ'‹ Greeting sent for buy order ${order.orderNumber} (after Telegram approval)`);
            await new Promise(r => setTimeout(r, 800));
          }

          // ── Step 3: Execute the Choice Bank payment ──
          try {
            imResult = await executeChoicePayment({
              phone: paymentDetails.phone, accountNumber: paymentDetails.account_number,
              bankCode: paymentDetails.bank_code||"", name: verifiedName||paymentDetails.name,
              amount: paymentDetails.amount, orderNumber: order.orderNumber, method: method,
            });
            if (imResult.success) {
              imPaymentDoneMap[order.orderNumber] = { referenceId: imResult.referenceId||"" };
              savePaidOrder(order.orderNumber, { referenceId: imResult.referenceId||"" });
            }
          } catch(e) {
            console.error("[SparkP2P] Choice Bank payment failed for " + order.orderNumber + ": " + e.message);
            imPaymentFailedOrders.add(order.orderNumber); _saveOrderFlag(order.orderNumber, 'paymentFailed', true);
            await fetch(API_BASE + "/ext/report-buy-expired", { method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
              body: JSON.stringify({ order_number: order.orderNumber, seller_name: paymentDetails.name,
                amount: paymentDetails.amount, minutes_waited: 0,
                reason: "Choice Bank payment failed: " + e.message + ". Please complete manually." })
            }).catch(function(){});
          }
        }
      }
      // Payment succeeded â€" store details and switch back to Binance
      // Payment failed / insufficient balance — do NOT tell the seller anything or click Transferred.
      if (!imResult.success) {
        console.log(`[SparkP2P] ⛔ Buy ${order.orderNumber} NOT paid (success=false) — skipping seller message & Transferred`);
        continue;
      }

      buyOrderDetailsMap[order.orderNumber] = {
        sellerName: paymentDetails.name,
        amount: paymentDetails.amount,
        phone: paymentDetails.phone || null,
        accountNumber: paymentDetails.account_number || null,
        bankName: paymentDetails.bank_name || null,
        method: _localIsBank ? (paymentDetails.bank_name || 'Bank Transfer') : 'M-Pesa',
        orderNumber: order.orderNumber,
        referenceId: imResult.referenceId || null,
        screenshot: imResult.screenshot || null,
      };
      buyPaymentSentAt[order.orderNumber] = Date.now();
      buyReminderSentOrders.delete(order.orderNumber);

      // Navigate back to Binance order page
      await page.bringToFront();
      await page.goto(`https://p2p.binance.com/en/fiatOrderDetail?orderNo=${order.orderNumber}`,
        { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      // Wait for the chat panel to render (Binance P2P uses contenteditable div, not textarea)
      await page.waitForFunction(
        () => !!document.querySelector('[placeholder*="message" i], [placeholder*="Enter message" i], textarea, div[contenteditable="true"]'),
        { timeout: 15000 }
      ).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));

      // Send post-payment chat message (once only — only mark sent if it succeeds)
      if (!buyPostPaymentMsgSentOrders.has(order.orderNumber)) {
        const payTime = new Date().toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
        let postPayMsg = '';
        if (_localIsBank) {
          const refPart = imResult.referenceId ? ` Ref: ${imResult.referenceId}.` : '';
          postPayMsg = `Hello ${firstName}, I have sent KSh ${amt.toLocaleString()} to your ${paymentDetails.bank_name || 'bank'} account (${paymentDetails.account_number || ''}) at ${payTime}.${refPart} Please check and release the crypto. Thank you! 🙏`;
        } else {
          const refPart = imResult.referenceId ? ` M-Pesa Ref: ${imResult.referenceId}.` : '';
          postPayMsg = `Hello ${firstName}, I have sent KSh ${amt.toLocaleString()} to your M-Pesa (${paymentDetails.phone}) at ${payTime}.${refPart} Please check and release the crypto. Thank you! 🙏`;
        }
        const postMsgSent = await sendBinanceChatMessage(page, postPayMsg);
        if (postMsgSent) { buyPostPaymentMsgSentOrders.add(order.orderNumber); _saveOrderFlag(order.orderNumber, 'postPaymentMsgSent', true); }
        else console.log(`[SparkP2P] ⚠️ Post-payment message not sent for ${order.orderNumber} — will retry next cycle`);
      }


      // EP-17: mark order as paid via SAPI — replaces DOM "Transferred" button clicking.
      // Skip if already called in a previous bot session (state persisted in order_flags.json).
      if (markPaidDoneOrders.has(order.orderNumber)) {
        console.log(`[SparkP2P] EP-17 already done for ${order.orderNumber} — skipping (restored from disk)`);
      } else {
        const markPaidRes = await fetch(`${API_BASE}/ext/mark-paid`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ order_number: order.orderNumber }),
        }).catch(() => null);
        const markPaidOk = markPaidRes?.ok ? (await markPaidRes.json().catch(() => ({}))).ok : false;
        if (markPaidOk) {
          markPaidDoneOrders.add(order.orderNumber);
          _saveOrderFlag(order.orderNumber, 'markPaidDone', true);
          console.log(`[SparkP2P] ✅ EP-17 mark-paid success for ${order.orderNumber} — seller notified via API`);
        } else {
          console.log(`[SparkP2P] ⚠️ EP-17 mark-paid failed for ${order.orderNumber} — will retry next cycle`);
        }
      }
      // Send receipt screenshot in chat if we have one
      if (imResult.screenshot) {
        await sendImageInBinanceChat(page, imResult.screenshot).catch(() => {});
      }

      await takeScreenshot(`buy_paid_${order.orderNumber}`, page);
      await fetch(`${API_BASE}/ext/report-payment-sent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ order_number: order.orderNumber, success: true, channel: method === 'mpesa' ? 'MPESA' : 'BANK' }),
      }).catch(() => {});
      stats.actions++;
      console.log(`[SparkP2P] âœ… Buy order ${order.orderNumber} â€" paid and notified seller`);
    }
  }

  if (allActiveNums.length === 0) {
    console.log('[SparkP2P] No active orders â€" staying idle');
    // readOrders() at the start of the next poll will navigate to tab=0 — no need to pre-navigate here
  }
  }  // end buy orders block
}

// â"€â"€ Click an order row using DOM (reliable, no mouse needed) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
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
    // Strategy 3: "Please release" link â€" click the row containing it
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

// â"€â"€ Focused order monitor â€" runs every 20s while an order is active â"€â"€â"€â"€â"€â"€â"€â"€â"€
async function navigateToOrderDetail(page, orderNumber) {
  if (pauseNavigation) { console.log('[SparkP2P] Navigation paused â€" skipping order navigation'); return false; }
  console.log(`[SparkP2P] Navigating to order ${orderNumber} via orders list`);
  await page.goto('https://p2p.binance.com/en/fiatOrder?tab=0&page=1',
    { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

  const box = await page.evaluate((orderNo) => {
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
    return null;
  }, orderNumber);

  if (!box) {
    console.error(`[SparkP2P] Could not find order ${orderNumber} on page`);
    return false;
  }

  await page.mouse.move(box.x, box.y, { steps: 10 });
  await new Promise(r => setTimeout(r, 300));
  await page.mouse.click(box.x, box.y);
  await new Promise(r => setTimeout(r, 3000));
  console.log(`[SparkP2P] Now on: ${page.url()}`);
  return true;
}

async function monitorActiveOrder(page) {
  const orderNum = activeOrderNumber;
  console.log(`[SparkP2P] â"€â"€ FOCUSED ORDER MONITOR: ${orderNum} â"€â"€`);

  // Navigate DIRECTLY to the order detail page â€" do NOT go via the orders list
  await page.goto(
    `https://p2p.binance.com/en/fiatOrderDetail?orderNo=${orderNum}`,
    { waitUntil: 'domcontentloaded', timeout: 15000 }
  ).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));
  if (pauseNavigation || !pollerRunning) return;

  // â"€â"€ Persistent loop â€" stay on this page until the order resolves â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  // Bot never leaves the order page between checks. Reload every 15s.
  // Max 25 minutes (P2P orders expire in 15 min, 10 min buffer for release steps).
  const MAX_ORDER_MS   = 25 * 60 * 1000;
  const CHECK_WAIT_MS  = 15 * 1000;
  const loopStart = Date.now();

  while (Date.now() - loopStart < MAX_ORDER_MS) {
    if (!pollerRunning || pauseNavigation) return;

    // Take screenshot + Vision analysis (up to 3 attempts)
    await takeScreenshot(`monitor_${orderNum}`, page);
    let info = { screen: 'unknown' };
    for (let i = 1; i <= 3; i++) {
      info = await analyzePageWithVision(page);
      console.log(`[SparkP2P] Order ${orderNum} vision (${i}/3): ${info.screen}`);
      if (info.screen !== 'unknown') break;
      await new Promise(r => setTimeout(r, 2000));
    }

    const screen = info.screen;

    // â"€â"€ ORDER COMPLETE â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    if (screen === 'order_complete') {
      console.log(`[SparkP2P] âœ… Order ${orderNum} COMPLETED â€" reporting release`);
      await fetch(`${API_BASE}/ext/report-release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ order_number: orderNum, success: true }),
      }).catch(() => {});
      codeFallbackAskedForOrder = null;
      activeOrderNumber = null; activeOrderFiatAmount = 0;
      return;
    }

    // â"€â"€ STILL WAITING FOR BUYER PAYMENT â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    if (screen === 'awaiting_payment' || screen === 'payment_processing') {
      const elapsed = Math.round((Date.now() - loopStart) / 1000);
      console.log(`[SparkP2P] Order ${orderNum} â€" waiting for buyer (${elapsed}s elapsed)`);
      await new Promise(r => setTimeout(r, CHECK_WAIT_MS));
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }

    // â"€â"€ BUYER HAS PAID â€" VERIFY THEN RELEASE â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    if (screen === 'verify_payment') {
      console.log(`[SparkP2P] Order ${orderNum} shows VERIFY PAYMENT â€" checking M-Pesa...`);

      // Acknowledge buyer if they already sent proof in chat
      const buyerAlreadySent = await page.evaluate(() => {
        const vw = window.innerWidth;
        const hasImage = Array.from(document.querySelectorAll('img')).some(img => {
          const r = img.getBoundingClientRect();
          return r.width > 60 && r.height > 60 && r.left > vw * 0.5
            && r.top >= 0 && r.bottom <= window.innerHeight;
        });
        const hasCode = Array.from(document.querySelectorAll('*')).some(el => {
          if (el.children.length > 0) return false;
          const r = el.getBoundingClientRect();
          if (r.left < vw * 0.5 || r.width === 0) return false;
          return /\b[A-Z0-9]{10}\b/.test(el.textContent || '');
        });
        return hasImage || hasCode;
      });

      if (buyerAlreadySent && codeFallbackAskedForOrder !== orderNum) {
        await sendChatMessage(page, 'I can see that you have already made your payment, please wait as I verify this payment. Thank you!');
        await new Promise(r => setTimeout(r, 1000));
      }

      const { verified: verified, reason: verifyReason2 } = await verifyMpesaPayment(orderNum, activeOrderFiatAmount || info.fiat_amount_kes, page);
      if (verified) {
        console.log(`[SparkP2P] âœ… M-Pesa confirmed â€" releasing`);
        await page.keyboard.press('Escape').catch(() => {});
        await new Promise(r => setTimeout(r, 800));

        // Ensure we're still on the order detail page after verification
        if (!page.url().includes('fiatOrderDetail')) {
          await page.goto(
            `https://p2p.binance.com/en/fiatOrderDetail?orderNo=${orderNum}`,
            { waitUntil: 'domcontentloaded', timeout: 15000 }
          ).catch(() => {});
          await new Promise(r => setTimeout(r, 3000));
        }

        await sendChatMessage(page, 'I have received your payment. Releasing crypto in a short while.');
        await new Promise(r => setTimeout(r, 1000));
        await clickButton(page, 'Payment Received', 'payment received');
        await new Promise(r => setTimeout(r, 2000));
        await releaseWithVision(page, orderNum, {});
        codeFallbackAskedForOrder = null;
        activeOrderNumber = null; activeOrderFiatAmount = 0;
          return;
      } else {
        // Ask buyer for code once, then wait
        if (codeFallbackAskedForOrder !== orderNum) {
          codeFallbackAskedForOrder = orderNum;
          await sendChatMessage(page,
            'Hello! I can see you have made your payment but I\'m having trouble reading the screenshot. Could you please TYPE your M-Pesa confirmation code in this chat (e.g. QE1FXYZABC)? I will verify it immediately. Thank you!'
          );
        } else {
          console.log(`[SparkP2P] Waiting for buyer to type M-Pesa code...`);
        }
        await new Promise(r => setTimeout(r, CHECK_WAIT_MS));
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
    }

    // â"€â"€ MID-RELEASE STATES â€" continue vision loop immediately â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    if (['confirm_release_modal','passkey_failed','security_verification','totp_input','email_otp_input'].includes(screen)) {
      console.log(`[SparkP2P] Order ${orderNum} mid-release (${screen}) â€" continuing`);
      await releaseWithVision(page, orderNum, {});
      codeFallbackAskedForOrder = null;
      activeOrderNumber = null; activeOrderFiatAmount = 0;
      return;
    }

    // â"€â"€ DOM TEXT FALLBACK (Vision returned unknown) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
    const lower = pageText.toLowerCase();

    if (lower.includes('cancelled') || lower.includes('canceled')) {
      console.log(`[SparkP2P] Order ${orderNum} CANCELLED`);
      await fetch(`${API_BASE}/ext/report-orders`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ sell_orders: [], buy_orders: [], cancelled_order_numbers: [orderNum] }),
      }).catch(() => {});
      codeFallbackAskedForOrder = null;
      activeOrderNumber = null; activeOrderFiatAmount = 0;
      return;
    }

    if (lower.includes('order completed') || lower.includes('sale successful') || lower.includes('released')) {
      console.log(`[SparkP2P] Order ${orderNum} COMPLETED (DOM text) â€" reporting release`);
      await fetch(`${API_BASE}/ext/report-release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ order_number: orderNum, success: true }),
      }).catch(() => {});
      codeFallbackAskedForOrder = null;
      activeOrderNumber = null; activeOrderFiatAmount = 0;
      return;
    }

    // NOTE: do NOT match 'confirm payment' â€" that button appears on ALL sell order pages
    if (lower.includes('verify payment') || lower.includes('payment received')) {
      const { verified: verified3, reason: verifyReason3 } = await verifyMpesaPayment(orderNum, activeOrderFiatAmount, page);
      if (verified3) {
        await page.keyboard.press('Escape').catch(() => {});
        await new Promise(r => setTimeout(r, 1000));
        await clickButton(page, 'Payment Received', 'payment received');
        await new Promise(r => setTimeout(r, 2000));
        await releaseWithVision(page, orderNum, {});
        codeFallbackAskedForOrder = null;
        activeOrderNumber = null; activeOrderFiatAmount = 0;
        return;
      } else {
        if (codeFallbackAskedForOrder !== orderNum) {
          codeFallbackAskedForOrder = orderNum;
          await sendChatMessage(page,
            'Hello! I can see you have made your payment but I\'m having trouble reading the screenshot. Could you please TYPE your M-Pesa confirmation code in this chat (e.g. QE1FXYZABC)? I will verify it immediately. Thank you!'
          );
        } else {
          console.log(`[SparkP2P] Already asked buyer for code (DOM path) â€" waiting`);
        }
      }
    }

    // Unknown state â€" wait and reload
    console.log(`[SparkP2P] Order ${orderNum} state unclear (${screen}) â€" reloading in ${CHECK_WAIT_MS / 1000}s`);
    await new Promise(r => setTimeout(r, CHECK_WAIT_MS));
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`[SparkP2P] âš ï¸ Order ${orderNum} monitoring timed out after 25 min`);
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// MARKET PRICES â€" Read buy/sell prices from P2P page
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// MY AD PRICES â€" Vision-scrape trader's own buy/sell prices
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

const MY_ADS_URL = 'https://p2p.binance.com/en/myads?type=normal&code=default';
let lastAdPriceScan = 0; // timestamp of last successful scan

async function scanMyAdPrices() {
  if (!token) return;
  if (pauseNavigation) return;

  const page = await getPage('binance.com');
  if (!page || page.isClosed()) return;

  try {
    console.log('[SparkP2P] Scanning My Ads page for prices...');
    await page.goto(MY_ADS_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));

    if (pauseNavigation) return;

    const adsText = await page.evaluate(() => document.body.innerText).catch(() => '');
    const lines = adsText.split('\n').map(l => l.trim()).filter(Boolean);

    let buyPrice = null, sellPrice = null;
    for (let i = 0; i < lines.length; i++) {
      if (!/^(Buy|Sell)$/i.test(lines[i])) continue;
      const adType = lines[i].toUpperCase();
      // KES/USDT rates are in the 100–200 range — find first match in next 20 lines
      for (let j = i + 1; j < Math.min(i + 20, lines.length); j++) {
        const m = lines[j].match(/^(1[0-9]{2}(?:\.\d{1,4})?)$/);
        if (m) {
          const price = parseFloat(m[1]);
          if (adType === 'BUY'  && !buyPrice)  buyPrice  = price;
          if (adType === 'SELL' && !sellPrice) sellPrice = price;
          break;
        }
      }
      if (buyPrice && sellPrice) break;
    }

    console.log(`[SparkP2P] My Ads DOM result: BUY:${buyPrice} SELL:${sellPrice}`);

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
      console.log('[SparkP2P] My Ads DOM: could not extract valid prices');
    }
  } catch (e) {
    console.error('[SparkP2P] scanMyAdPrices error:', e.message?.substring(0, 80));
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SCREENSHOT â€" Capture page and send to VPS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// â"€â"€ Screenshots folder â€" all bot screenshots saved here for review â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// TOTP â€" Generate Google Authenticator code from base32 secret
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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

function verifyTOTP(secret, userCode) {
  if (!secret || !userCode) return false;
  const input = String(userCode).replace(/[^0-9]/g, '');
  if (input.length !== 6) return false;
  const baseCounter = Math.floor(Date.now() / 1000 / 30);
  for (let d = -1; d <= 1; d++) {
    const expected = generateTOTPAtCounter(secret, baseCounter + d);
    if (expected === input) return true;
  }
  return false;
}

function generateTOTPAtCounter(secret, counter) {
  const crypto = require('crypto');
  const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = secret.toUpperCase().replace(/\s|=/g, '');
  let bits = '';
  for (const ch of clean) { const v = BASE32.indexOf(ch); if (v !== -1) bits += v.toString(2).padStart(5, '0'); }
  const keyBytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) keyBytes.push(parseInt(bits.slice(i, i+8), 2));
  const key = Buffer.from(keyBytes);
  const msg = Buffer.alloc(8); msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0); msg.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const off = hmac[19] & 0x0f;
  const code = ((hmac[off] & 0x7f) << 24 | hmac[off+1] << 16 | hmac[off+2] << 8 | hmac[off+3]) % 1000000;
  return code.toString().padStart(6, '0');
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// PIN/PASSKEY ENTRY â€" Auto-enter security code when Binance asks
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// â"€â"€ Read email OTP from Gmail (opened in new Chrome tab) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
// â"€â"€ Read Binance OTP from Gmail â€" smart version â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
// â€¢ Searches for all recent Binance emails, picks the NEWEST one sent within
//   the last 10 minutes (OTPs expire in 10 min on Binance).
// â€¢ If no qualifying email found, returns null so the caller can resend.
// â€¢ If multiple emails exist, uses the timestamp to pick the latest one.
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
  // Gmail timestamps are like "Apr 2, 2026, 3:45 PM" â€" parse them
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
      // Can't parse time â€" fall back to just using the first (newest) email
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

  // Extract 6-digit OTP â€" look for patterns like "123456" or "Your code is 123456"
  const emailText = await gmailPage.evaluate(() => document.body.innerText).catch(() => '');

  // Match 6-digit code â€" prefer one near keywords like "code", "verification", "OTP"
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// IMAP EMAIL OTP â€" reads Binance verification code from Gmail via IMAP
// No browser tab needed. Direct connection to Gmail.
// Requires Gmail App Password configured in settings.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function readEmailOTPviaIMAP(sentAfterMs = Date.now() - 120000) {
  const creds = loadGmailCredentials();
  if (!creds || !creds.email || !creds.appPassword) {
    console.log('[SparkP2P] Gmail IMAP: credentials not configured');
    return null;
  }
  let client = null;
  try {
    const { ImapFlow } = require('imapflow');
    client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: { user: creds.email, pass: creds.appPassword },
      logger: false,
    });
    await client.connect();
    await client.mailboxOpen('INBOX');

    const since = new Date(sentAfterMs - 60000);
    const uids = await client.search({ from: 'do-not-reply@binance.com', since }, { uid: true });

    if (!uids || uids.length === 0) {
      console.log('[SparkP2P] Gmail IMAP: no recent Binance emails found');
      await client.logout();
      return null;
    }

    const uid = uids[uids.length - 1];
    let emailText = '';
    for await (const msg of client.fetch(String(uid), { bodyParts: ['TEXT'], uid: true })) {
      const part = msg.bodyParts?.get('text') || msg.bodyParts?.get('TEXT') || msg.bodyParts?.get('1');
      if (part) emailText = Buffer.isBuffer(part) ? part.toString('utf8') : String(part);
    }
    await client.logout();

    if (!emailText) { console.log('[SparkP2P] Gmail IMAP: empty email body'); return null; }

    // Extract 6-digit code — prefer line near "code", "verification", "otp"
    const lines = emailText.split(/[\r\n]+/);
    let code = null;
    for (const line of lines) {
      const l = line.toLowerCase();
      if (l.includes('verif') || l.includes('code') || l.includes('otp') || l.includes('security')) {
        const m = line.match(/\b(\d{6})\b/);
        if (m) { code = m[1]; break; }
      }
    }
    if (!code) {
      const m = emailText.match(/\b(\d{6})\b/);
      if (m) code = m[1];
    }
    if (code) { console.log(`[SparkP2P] Gmail IMAP: OTP = ${code}`); return code; }
    console.log('[SparkP2P] Gmail IMAP: no 6-digit code found');
    return null;
  } catch (e) {
    console.error('[SparkP2P] Gmail IMAP error:', e.message?.substring(0, 80));
    if (client) await client.logout().catch(() => {});
    return null;
  }
}

// Read a Choice Bank transaction OTP (4-digit) from Gmail via IMAP.
// Polls every 8s for up to 8 minutes — well inside Choice's 10-minute OTP window.
async function readChoiceOTPviaIMAP(sentAfterMs = Date.now()) {
  const POLL_MS = 8000;
  const MAX_WAIT = 480000; // 8 minutes
  const deadline = Date.now() + MAX_WAIT;
  console.log('[SparkP2P] Waiting for Choice Bank OTP email (IMAP)...');
  while (Date.now() < deadline) {
    const code = await _imapSearch({ sender: 'choice-bank.co', digits: 4, sentAfterMs });
    if (code) { console.log(`[SparkP2P] Choice Bank OTP: ${code}`); return code; }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(r => setTimeout(r, Math.min(POLL_MS, remaining)));
  }
  console.log('[SparkP2P] Choice Bank OTP: timed out waiting for email');
  return null;
}

async function _imapSearch({ sender, digits, sentAfterMs }) {
  const creds = loadGmailCredentials();
  if (!creds || !creds.email || !creds.appPassword) return null;
  let client = null;
  try {
    const { ImapFlow } = require('imapflow');
    client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: creds.email, pass: creds.appPassword }, logger: false });
    await client.connect();
    await client.mailboxOpen('INBOX');
    const uids = await client.search({ from: sender, since: new Date(sentAfterMs - 60000) }, { uid: true });
    if (!uids || uids.length === 0) { await client.logout(); return null; }
    let emailText = '';
    for await (const msg of client.fetch(String(uids[uids.length - 1]), { bodyParts: ['TEXT'], uid: true })) {
      const part = msg.bodyParts?.get('text') || msg.bodyParts?.get('TEXT') || msg.bodyParts?.get('1');
      if (part) emailText = Buffer.isBuffer(part) ? part.toString('utf8') : String(part);
    }
    await client.logout();
    if (!emailText) return null;
    const re = new RegExp(`\\b(\\d{${digits}})\\b`);
    const lines = emailText.split(/[\r\n]+/);
    for (const line of lines) {
      const l = line.toLowerCase();
      if (l.includes('verif') || l.includes('code') || l.includes('otp')) {
        const m = line.match(re); if (m) return m[1];
      }
    }
    const m = emailText.match(re); return m ? m[1] : null;
  } catch (e) {
    console.error('[SparkP2P] IMAP search error:', e.message?.substring(0, 80));
    if (client) await client.logout().catch(() => {});
    return null;
  }
}

// â"€â"€ Vision-based Gmail OTP reader â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
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
      console.log(`[Vision] Gmail: no email yet (attempt ${attempt}/3) â€" waiting 8s...`);
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

    console.log(`[Vision] OTP not found in email (attempt ${attempt}/3) â€" retrying...`);
    await new Promise(r => setTimeout(r, 8000));
  }
  return null;
}

// â"€â"€ Main readEmailOTP â€" with retry + resend logic â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
// Tries up to MAX_ATTEMPTS times. On each failed attempt it goes back to the
// Binance tab and clicks the resend button before trying Gmail again.
async function readEmailOTP(binancePage = null) {
  if (!browser) return null;
  const MAX_ATTEMPTS = 3;
  const WAIT_FOR_EMAIL_MS = 5000;
  const RESEND_WAIT_MS   = 8000;
  const sentAt = Date.now();

  // Ensure persistent Gmail tab is open â€" open it now if it was closed
  if (!gmailPage || gmailPage.isClosed()) {
    console.log('[SparkP2P] Gmail tab not open â€" opening now...');
    await openGmailTab();
  }
  if (!gmailPage) { console.error('[SparkP2P] Could not open Gmail tab'); return null; }

  // If Gmail tab is on login page, wait up to 60s for user to log in
  const gmailUrl = gmailPage.url();
  if (gmailUrl.includes('accounts.google.com') || gmailUrl.includes('/signin')) {
    console.log('[SparkP2P] Gmail not logged in â€" waiting up to 60s for user to sign in...');
    await gmailPage.bringToFront();
    const loginDeadline = Date.now() + 60000;
    while (Date.now() < loginDeadline) {
      await new Promise(r => setTimeout(r, 2000));
      const url = gmailPage.url();
      if (!url.includes('accounts.google.com') && !url.includes('/signin')) {
        console.log('[SparkP2P] Gmail login detected â€" proceeding with OTP read');
        break;
      }
    }
    if (gmailPage.url().includes('accounts.google.com')) {
      console.error('[SparkP2P] Gmail login timeout â€" could not read OTP');
      return null;
    }
  }

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      console.log(`[SparkP2P] Email OTP attempt ${attempt}/${MAX_ATTEMPTS}...`);
      await new Promise(r => setTimeout(r, attempt === 1 ? WAIT_FOR_EMAIL_MS : RESEND_WAIT_MS));

      // Try IMAP first (fast, no browser tab)
      const imapCode = await readEmailOTPviaIMAP(sentAt);
      if (imapCode) {
        if (binancePage) await binancePage.bringToFront().catch(() => {});
        return imapCode;
      }

      // IMAP unavailable or no email yet â€" fall back to Gmail browser tab
      console.log('[SparkP2P] IMAP: no code yet â€" trying Gmail browser tab...');
      await gmailPage.bringToFront();
      const code = await _readEmailOTPOnce(gmailPage, sentAt);
      if (code) {
        // Switch back to Binance tab before returning
        if (binancePage) await binancePage.bringToFront().catch(() => {});
        return code;
      }

      // No OTP yet â€" click Resend on Binance then wait again
      if (attempt < MAX_ATTEMPTS && binancePage) {
        console.log('[SparkP2P] OTP not arrived â€" switching to Binance to resend...');
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
  // Note: gmailPage stays open â€" it's a persistent tab
}

// â"€â"€ Type a 6-digit code using real keyboard events (like a human) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
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
    // Single input â€" click it, clear it, type the whole code
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

  // Detect what Binance is asking for â€" may be multiple fields
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

  console.log(`[SparkP2P] Verification needed â€" email:${verification.hasEmail} auth:${verification.hasAuth} fundpw:${verification.hasFundPw}`);
  await takeScreenshot('Security verification');

  try {
    // Passkey bypass â€" Vision finds "My Passkeys Are Not Available" and clicks it
    if (verification.hasPasskey && !verification.hasAuth && !verification.hasEmail) {
      console.log('[SparkP2P] Passkey screen â€" Vision clicking "My Passkeys Are Not Available"...');
      let bypassed = false;
      for (const frame of [page, ...page.frames()]) {
        try {
          const result = await frame.evaluate(() => {
            for (const el of Array.from(document.querySelectorAll('*')).reverse()) {
              const t = (el.textContent || '').trim();
              if (!/passkey.*not.*available/i.test(t) || t.length > 100) continue;
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }
            return null;
          });
          if (result) {
            await page.mouse.click(result.x, result.y);
            console.log(`[SparkP2P] âœ… "My Passkeys Are Not Available" clicked at (${Math.round(result.x)}, ${Math.round(result.y)})`);
            bypassed = true;
            break;
          }
        } catch (_) {}
      }
      if (bypassed) {
        console.log('[SparkP2P] Passkey bypass clicked â€" waiting for TOTP/email form...');
        await new Promise(r => setTimeout(r, 2500));
        const recheck = await page.evaluate(() => {
          const text = document.body.innerText.toLowerCase();
          return {
            hasEmail: text.includes('email verification') || text.includes('email code'),
            hasAuth: text.includes('authenticator') || text.includes('google auth'),
            hasFundPw: text.includes('fund password') || text.includes('trading password'),
          };
        });
        if (recheck.hasAuth) verification.hasAuth = true;
        if (recheck.hasEmail) verification.hasEmail = true;
        if (recheck.hasFundPw) verification.hasFundPw = true;
        console.log(`[SparkP2P] After bypass â€" email:${verification.hasEmail} auth:${verification.hasAuth}`);
      } else {
        console.log('[SparkP2P] Passkey bypass: Vision could not locate link');
        await takeScreenshot('Passkey bypass failed');
        return false;
      }
    }

    // â"€â"€ Google Authenticator â"€â"€
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

    // â"€â"€ Email OTP â€" read from Gmail â"€â"€
    if (verification.hasEmail) {
      console.log('[SparkP2P] Email OTP required â€" fetching from Gmail...');
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
        console.log('[SparkP2P] Could not get email OTP â€" manual intervention needed');
        await takeScreenshot('Email OTP required â€" manual needed');
        return false;
      }
    }

    // â"€â"€ Fund Password â"€â"€
    if (verification.hasFundPw && traderPin) {
      const inp = await page.$('input[type="password"]');
      if (inp) {
        await inp.click({ clickCount: 3 });
        await inp.evaluate(el => { el.value = ''; });
        await inp.type(traderPin, { delay: 40 });
      }
      console.log('[SparkP2P] Fund password entered');
    }

    // â"€â"€ Submit â€" try clicking the button, then press Enter as backup â"€â"€
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
      // No button found â€" press Enter on keyboard (works on most forms)
      console.log('[SparkP2P] No submit button found â€" pressing Enter');
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
      console.log('[SparkP2P] Verification may have failed â€" inputs still visible');
      await takeScreenshot('Verification may have failed');
      return false;
    }

  } catch (e) {
    console.error('[SparkP2P] PIN entry error:', e.message?.substring(0, 60));
    return false;
  }
}

// â"€â"€ Dismiss any Binance info/warning modals that block the order page â"€â"€â"€â"€â"€â"€â"€â"€
// Handles: "Payment Completed?" → "I Understand", generic OK/Got It dialogs
async function dismissBinanceModals(page) {
  const dismissed = await page.evaluate(() => {
    const keywords = ['i understand', 'got it', 'ok', 'okay', 'close'];
    const btns = Array.from(document.querySelectorAll('button, [role="button"], a'));
    for (const btn of btns) {
      const txt = (btn.textContent || '').trim().toLowerCase();
      if (keywords.includes(txt)) {
        btn.click();
        return txt;
      }
    }
    return null;
  }).catch(() => null);
  if (dismissed) {
    console.log(`[SparkP2P] Dismissed modal â€" clicked "${dismissed}"`);
    await new Promise(r => setTimeout(r, 800));
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// CLICK HELPER â€" Find and click buttons by text, AI fallback
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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
  console.log(`[SparkP2P] Button not found by text (${textOptions[0]}...) â€" asking AI`);
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
  } catch (e) { /* AI unavailable â€" not critical */ }

  return false;
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SMART CHAT â€" Vision reads chat history, generates unique messages
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// Analyse the chat panel: who sent last, how long ago, conversation context
async function analyzeChatHistory(page) {
  if (!anthropicApiKey) return null;
  try {
    const ss = await page.screenshot({ type: 'jpeg', quality: 80 });
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: ss.toString('base64') } },
          { type: 'text', text: `Look at the chat panel on the RIGHT side of this Binance P2P order page.
Analyse the conversation and return JSON:
{
  "last_sender": "bot" or "buyer" (bot messages are right-aligned/darker, buyer messages are left-aligned),
  "last_message_preview": "first 60 chars of the last message",
  "last_buyer_message": "full text of the most recent message sent by the buyer (left-aligned), or null if buyer hasn't messaged",
  "minutes_since_last": <estimated minutes as integer, or 0 if just now>,
  "message_count": <total visible messages as integer>,
  "conversation_summary": "one sentence describing what has been discussed so far"
}
If no chat is visible return: {"last_sender": null, "last_buyer_message": null, "minutes_since_last": 999, "message_count": 0, "conversation_summary": "no chat visible"}
Return ONLY valid JSON.` },
        ]}],
      }),
    });
    const data = await res.json();
    const text = (data.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch (e) {
    console.log('[SparkP2P] analyzeChatHistory error:', e.message?.substring(0, 60));
    return null;
  }
}

// Generate a unique, natural message based on the situation and chat context
async function generateUniqueMessage(situation, chatContext, orderDetails = {}) {
  if (!anthropicApiKey) return null;
  try {
    const contextInfo = chatContext
      ? `Previous conversation: ${chatContext.conversation_summary}. Last message from: ${chatContext.last_sender}, ~${chatContext.minutes_since_last} min ago.`
      : 'No prior context available.';

    const situations = {
      payment_verified_releasing: `The buyer's M-Pesa payment of KES ${orderDetails.amount || ''} has been verified. Tell them their payment is confirmed and you are releasing their crypto right now.`,
      need_mpesa_code:            `You cannot read the buyer's payment screenshot clearly. Ask them to TYPE their M-Pesa confirmation code directly in the chat (e.g. "QE1FXYZABC"). Be polite.`,
      payment_not_received:       `You have not received any M-Pesa payment for KES ${orderDetails.amount || ''} yet. Ask the buyer to send their payment and share the M-Pesa confirmation.`,
      awaiting_code_reminder:     `You are still waiting for the buyer to type their M-Pesa code. Gently remind them.`,
      awaiting_payment_reminder:  `The buyer has placed an order for KES ${orderDetails.amount || ''} but hasn't paid yet. Send a polite, friendly reminder asking them to complete their M-Pesa payment and share the confirmation code once done.`,
      buyer_question:             `The buyer asked: "${orderDetails.buyerMessage || ''}". You are a professional P2P crypto seller. Answer their question helpfully and briefly. If they're asking about payment instructions, remind them to send KES ${orderDetails.amount || ''} via M-Pesa and share the confirmation code in chat.`,
    };

    const prompt = `You are a friendly, professional Binance P2P crypto seller.
Situation: ${situations[situation] || situation}
${contextInfo}

Write ONE short, natural message to send to the buyer (max 2 sentences).
- Sound human, not robotic
- Vary wording â€" never repeat the same phrase twice
- Be warm but professional
- Do NOT include greetings like "Hello" or "Hi" if you've already been chatting
Return ONLY the message text. No quotes, no JSON.`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 120,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    return (data.content?.[0]?.text || '').trim().replace(/^["']|["']$/g, '');
  } catch (e) {
    console.log('[SparkP2P] generateUniqueMessage error:', e.message?.substring(0, 60));
    return null;
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// REAL-TIME AI CHAT — MutationObserver + Claude Haiku
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// Inject a MutationObserver into the Binance P2P order page.
// When the buyer sends any message (text or image), the observer fires window._sparkBuyerMsg()
// which bridges into Node.js via page.exposeFunction — no Vision, no polling, no coordinates.
async function injectChatMonitor(page, { orderNumber, fiatAmount, buyerName, orderSide, paymentInfo } = {}) {
  if (!anthropicApiKey || !orderNumber) return;
  if (!page || page.isClosed()) return;

  // Register the Node.js bridge once per Puppeteer page object
  if (!_chatMonitorExposed.has(page)) {
    try {
      await page.exposeFunction('_sparkBuyerMsg', async (data) => {
        await handleBuyerChatMessage(page, data).catch(e =>
          console.error(`[SparkChat] Handler error: ${e.message?.substring(0, 80)}`)
        );
      });
      _chatMonitorExposed.add(page);
    } catch (e) {
      if (!e.message?.includes('already exists')) {
        console.error(`[SparkChat] exposeFunction error: ${e.message?.substring(0, 80)}`);
        return;
      }
    }
  }

  // Push current order context into the page so the observer knows what order it's on
  await page.evaluate((ctx) => {
    window._sparkOrderCtx = ctx;
  }, {
    orderNumber,
    fiatAmount:    fiatAmount    || 0,
    buyerName:     buyerName     || 'Buyer',
    accountNumber: traderAccountNumber || 'P2PT0001',
    paybill:       '4041355',
    orderSide:     orderSide     || 'sell',
    paymentInfo:   paymentInfo   || null,
  }).catch(() => {});

  // Inject the observer (idempotent — guard prevents double-injection)
  await page.evaluate(() => {
    if (window._sparkChatObserver) return; // already running

    const findContainer = () => {
      const tries = [
        '[class*="ChatMessageList"]', '[class*="chat-message-list"]',
        '[class*="messageList"]',     '[class*="chatContent"]',
        '[class*="chat-content"]',    '[class*="ChatPanel"]',
        '[class*="im-chat"]',
      ];
      for (const sel of tries) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
      // Fallback: largest scrollable div in the right half of the viewport
      const all = [...document.querySelectorAll('div')].filter(d => {
        const r = d.getBoundingClientRect();
        return r.left > window.innerWidth * 0.5 && r.height > 200 && d.scrollHeight > d.clientHeight;
      });
      return all.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0] || null;
    };

    const startObserver = (container) => {
      window._sparkOwnMessages = new Set();   // messages we typed — avoid echo
      window._sparkLastMsgId   = '';          // dedup consecutive firings

      window._sparkChatObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== 1) continue;

            // Walk to find the message bubble element
            const msgEl = [node, ...Array.from(node.querySelectorAll('*'))].find(el => {
              const cls = (el.className || '').toString();
              return /message|msg|bubble|chat.?item/i.test(cls) && el.textContent?.trim();
            }) || node;

            const rect = msgEl.getBoundingClientRect?.();
            if (!rect || rect.width === 0) continue;

            // Buyer messages are on the LEFT side of the chat container
            const cRect = container.getBoundingClientRect();
            const midX  = cRect.left + cRect.width / 2;
            const cls   = (msgEl.className || '').toString() +
                          (msgEl.closest?.('[class]')?.className || '').toString();
            const isRight = /right|self|\bme\b|sender|outgoing/i.test(cls);
            const isLeft  = /left|other|receiver|incoming|buyer/i.test(cls);
            const isBuyer = isLeft || (!isRight && rect.left < midX);
            if (!isBuyer) continue;

            // Extract text from the most specific text-bearing child
            const textEl = msgEl.querySelector?.('p,[class*="text"],[class*="content"],span') || msgEl;
            const text   = textEl.textContent?.trim() || '';

            // Skip our own echoed messages
            if (window._sparkOwnMessages.has(text)) continue;

            // Extract payment screenshot images (skip avatars / emojis)
            const imgs = [...(msgEl.querySelectorAll?.('img') || [])]
              .map(i => i.src || i.getAttribute('src'))
              .filter(s => s && s.startsWith('http') &&
                           !/avatar|emoji|icon|logo/i.test(s));

            if (!text && imgs.length === 0) continue;

            // Deduplicate rapid re-fires for the same message
            const id = text + (imgs[0] || '');
            if (id === window._sparkLastMsgId) continue;
            window._sparkLastMsgId = id;

            const ctx = window._sparkOrderCtx;
            if (!ctx) continue;

            window._sparkBuyerMsg({
              text, imgs,
              orderNumber:   ctx.orderNumber,
              fiatAmount:    ctx.fiatAmount,
              buyerName:     ctx.buyerName,
              accountNumber: ctx.accountNumber,
              paybill:       ctx.paybill,
              orderSide:     ctx.orderSide,
              paymentInfo:   ctx.paymentInfo,
            }).catch(() => {});
          }
        }
      });

      window._sparkChatObserver.observe(container, { childList: true, subtree: true });
      console.log('[SparkChat] ✅ Chat monitor active');
    };

    const container = findContainer();
    if (container) {
      startObserver(container);
    } else {
      // Chat panel may not have rendered yet — retry up to 10s
      let tries = 0;
      const poll = setInterval(() => {
        const c = findContainer();
        if (c || ++tries >= 10) {
          clearInterval(poll);
          if (c) startObserver(c);
        }
      }, 1000);
    }
  }).catch(e => console.error(`[SparkChat] Inject error: ${e.message?.substring(0, 80)}`));
}

// Handle a buyer chat message detected by the injected MutationObserver
async function handleBuyerChatMessage(page, { text, imgs, orderNumber, fiatAmount, buyerName, accountNumber, paybill, orderSide, paymentInfo }) {
  if (!anthropicApiKey || !orderNumber) return;

  // Ignore if we're already in the middle of a release for this order
  if (activeOrderNumber === orderNumber) return;

  console.log(`[SparkChat] Order ${orderNumber} — buyer: "${(text || '').substring(0, 80)}" +${imgs?.length || 0} img`);

  if (!orderChatHistory.has(orderNumber)) orderChatHistory.set(orderNumber, []);
  const history = orderChatHistory.get(orderNumber);

  // Build message content (text + base64 images fetched from within the page)
  const userContent = [];

  for (const imgUrl of (imgs || []).slice(0, 3)) { // max 3 images per message
    const b64 = await page.evaluate(async (url) => {
      try {
        const r = await fetch(url, { credentials: 'include' });
        if (!r.ok) return null;
        const blob = await r.blob();
        return await new Promise(res => {
          const fr = new FileReader();
          fr.onloadend = () => res(fr.result?.split(',')[1] || null);
          fr.readAsDataURL(blob);
        });
      } catch { return null; }
    }, imgUrl).catch(() => null);

    if (b64) {
      userContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
      console.log(`[SparkChat] Image loaded (${Math.round(b64.length * 0.75 / 1024)}KB)`);
    }
  }

  if (text) userContent.push({ type: 'text', text });
  if (userContent.length === 0) return;

  history.push({ role: 'user', content: userContent });

  const isBuyOrder = orderSide === 'buy';
  const systemPrompt = isBuyOrder
    ? `You are a professional, friendly crypto trading assistant managing a P2P buy order on Binance.

We are the BUYER. We have already sent the payment. We are now waiting for the seller to confirm receipt and release the crypto.

Order details:
- Seller: ${buyerName || 'Seller'}
- Amount sent: KES ${(fiatAmount || 0).toLocaleString()}
- Payment method: ${paymentInfo?.method || 'M-Pesa'}
- Sent to: ${paymentInfo?.phone || paymentInfo?.account_number || 'seller\'s account'}
- M-Pesa/Bank Reference: ${paymentInfo?.referenceId || 'see receipt uploaded'}

Respond ONLY with valid JSON — no markdown, no extra text:
{
  "action": "reply" | "notify_trader" | "wait",
  "message": "<message to seller or null>",
  "reason": "<one line>"
}

Action rules:
- "reply" — respond to the seller's message
- "notify_trader" — seller is threatening, demanding extra payment, or clearly scamming
- "wait" — stay silent (just responded, waiting for seller)

Guidelines:
- Respond in seller's language (English or Swahili)
- Be warm, professional, concise
- NEVER say you are a bot or automated system
- If seller asks where you sent the money: confirm the phone/account (${paymentInfo?.phone || paymentInfo?.account_number || 'see receipt'}), amount KES ${(fiatAmount || 0).toLocaleString()}, and reference ${paymentInfo?.referenceId || 'see receipt'}
- If seller says they haven't received the money: politely ask them to check again and mention the reference number
- If seller is asking for more money or delaying without reason: notify_trader
- After you've replied, use "wait" next turn so you don't repeat yourself`
    : `You are a professional, friendly crypto trading assistant managing a P2P sell order on Binance.

Order details:
- Buyer: ${buyerName || 'Buyer'}
- Amount due: KES ${(fiatAmount || 0).toLocaleString()}
- M-Pesa Paybill: ${paybill || '4041355'}
- Account Number: ${accountNumber || 'P2PT0001'}

Respond ONLY with valid JSON — no markdown, no extra text:
{
  "action": "reply" | "verify_and_release" | "notify_trader" | "wait",
  "message": "<message to buyer or null>",
  "mpesa_code": "<M-Pesa transaction code e.g. QE1FXYZABC or null>",
  "reason": "<one line>"
}

Action rules:
- "reply" — send a message to the buyer
- "verify_and_release" — you found a valid M-Pesa code in the image or text. Put it in mpesa_code. The system will verify before releasing.
- "notify_trader" — buyer is threatening, disputing, or clearly attempting fraud. Include a message field.
- "wait" — stay silent (you just responded and are waiting for buyer action)

Guidelines:
- Respond in buyer's language (English or Swahili)
- Be warm, professional, concise
- NEVER say you are a bot or automated system
- Payment instructions if buyer asks: Paybill ${paybill || '4041355'}, Account ${accountNumber || 'P2PT0001'}, Amount KES ${(fiatAmount || 0).toLocaleString()}
- If buyer sends a screenshot: scan it for an M-Pesa transaction code (10-char alphanumeric like QE1FXYZABC). If found → verify_and_release. If not visible → reply asking them to type it.
- If buyer types a 10-char alphanumeric code directly → verify_and_release
- If buyer says "I've paid" / "nimetuma" with no proof → reply asking for screenshot or M-Pesa code
- If buyer is clearly threatening or claiming to have paid with zero proof after 2 attempts → notify_trader
- After you've asked for something, use "wait" next turn so you don't repeat yourself`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: systemPrompt,
        messages: history.slice(-12), // keep last 12 turns for context
      }),
    });
    const data = await resp.json();
    if (data.error) { console.error(`[SparkChat] Claude error: ${data.error.message}`); return; }

    const raw = data.content?.[0]?.text || '';
    // Store assistant reply in history (text only — no images going back)
    history.push({ role: 'assistant', content: raw });

    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) { console.error(`[SparkChat] Non-JSON: ${raw.substring(0, 100)}`); return; }
    const decision = JSON.parse(m[0]);
    console.log(`[SparkChat] Decision: ${decision.action} | ${decision.reason}`);

    // Human-like reply delay: 1.0–2.5 seconds
    const delay = 1000 + Math.random() * 1500;

    const sendReply = async (msg) => {
      if (!msg) return;
      await new Promise(r => setTimeout(r, delay));
      // Register message in the page so the Observer ignores our own echo
      await page.evaluate((t) => { window._sparkOwnMessages?.add(t); }, msg).catch(() => {});
      await sendChatMessage(page, msg);
    };

    if (decision.action === 'reply') {
      await sendReply(decision.message);

    } else if (decision.action === 'verify_and_release') {
      const code = decision.mpesa_code;
      if (!code) { await sendReply(decision.message); return; }

      console.log(`[SparkChat] Verifying M-Pesa code: ${code}`);
      const { verified, reason: vReason } = await verifyMpesaPayment(
        orderNumber, fiatAmount, null, { mpesaCodes: [code], bankRefs: [] }
      ).catch(() => ({ verified: false, reason: 'error' }));

      if (verified) {
        const confirmMsg = decision.message || 'Payment confirmed! Releasing your crypto now. Thank you 🙏';
        await sendReply(confirmMsg);
        await new Promise(r => setTimeout(r, 1000));
        activeOrderNumber   = orderNumber;
        activeOrderFiatAmount = fiatAmount;
        await releaseWithVision(page, orderNumber, {
          preChatCodes: { mpesaCodes: [code], bankRefs: [] },
        }).catch(e => console.error(`[SparkChat] Release error: ${e.message?.substring(0, 80)}`));
        activeOrderNumber   = null;
        activeOrderFiatAmount = 0;
        orderChatHistory.delete(orderNumber);
      } else {
        console.log(`[SparkChat] Verification failed (${vReason}) — telling buyer`);
        await sendReply(
          `We're still verifying your payment — it hasn't been confirmed on our end yet. ` +
          `Please ensure you paid to Paybill ${paybill || '4041355'}, Account ${accountNumber || 'P2PT0001'}, ` +
          `KES ${(fiatAmount || 0).toLocaleString()}. Share your M-Pesa confirmation code if you have it.`
        );
      }

    } else if (decision.action === 'notify_trader') {
      await sendReply(decision.message);
      await fetch(`${API_BASE}/ext/notify-trader`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          message: `Buyer on order ${orderNumber} (KES ${(fiatAmount || 0).toLocaleString()}) needs your attention. ` +
                   `Last message: "${(text || '').substring(0, 150)}"`,
        }),
      }).catch(() => {});

    } else {
      // "wait" — stay silent
      console.log(`[SparkChat] Waiting silently.`);
    }
  } catch (e) {
    console.error(`[SparkChat] Error: ${e.message?.substring(0, 100)}`);
  }
}

// â"€â"€ Send a chat message on an order page â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
// Handles both <textarea>/<input> and div[contenteditable] (Binance P2P uses the latter).
async function sendChatMessageVision(page, message) { return sendChatMessage(page, message); }
async function sendChatMessage(page, message) {
  try {
    await page.keyboard.press('Escape').catch(() => {});
    await new Promise(r => setTimeout(r, 500));

    // â"€â"€ Step 1: Type message into the chat input â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    const typed = await page.evaluate((msg) => {
      // Check textarea/input first, then contenteditable divs
      const textareaSelectors = [
        'textarea[placeholder*="message" i]',
        'textarea[placeholder*="enter" i]',
        'input[placeholder*="message" i]',
        'textarea',
      ];
      let input = null;
      let isContentEditable = false;

      for (const sel of textareaSelectors) {
        const candidates = document.querySelectorAll(sel);
        for (const el of candidates) {
          if (el.offsetParent !== null && !el.disabled && !el.readOnly) { input = el; break; }
        }
        if (input) break;
      }

      if (!input) {
        // Binance P2P uses a contenteditable div for the chat input
        const editables = document.querySelectorAll('div[contenteditable="true"]');
        for (const el of editables) {
          if (el.offsetParent !== null) { input = el; isContentEditable = true; break; }
        }
      }

      if (!input) return false;

      input.focus();

      if (isContentEditable) {
        // Clear existing content, then insert via execCommand so browser/React events fire
        input.textContent = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.execCommand('insertText', false, msg);
        // Also fire an 'input' event in case execCommand alone doesn't trigger React
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: msg }));
        return true;
      }

      // textarea / input â€" use React native value setter so onChange fires
      const proto = input.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (nativeSetter) {
        nativeSetter.call(input, msg);
      } else {
        input.value = msg;
      }
      input.dispatchEvent(new Event('input',  { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, message).catch(() => false);

    let visionTyped = false;
    if (!typed) {
      // DOM couldn't find the input — use Vision to locate and click the chat box, then type
      console.log('[SparkP2P] DOM chat input not found — using Vision click + keyboard.type...');
      try {
        const ssBase64 = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 80 });
        const coordsRaw = await visionAsk(ssBase64,
          'Find the chat message input box at the bottom right of the page (it usually says "Enter message here" or similar). ' +
          'Return ONLY a JSON object: {"x": <number>, "y": <number>} with the center pixel coordinates. No other text.',
          80
        );
        const m = coordsRaw.match(/\{\s*"x"\s*:\s*(\d+)\s*,\s*"y"\s*:\s*(\d+)\s*\}/);
        if (m) {
          const cx = parseInt(m[1]);
          const cy = parseInt(m[2]);
          // Triple-click to select all existing text, then type to replace
          await page.mouse.click(cx, cy, { clickCount: 3 });
          await new Promise(r => setTimeout(r, 200));
          await page.keyboard.type(message, { delay: 20 });
          console.log(`[SparkP2P] Message typed via Vision coords (${cx}, ${cy})`);
          visionTyped = true;
        } else {
          console.error(`[SparkP2P] sendChatMessage: Vision coord parse failed: ${coordsRaw?.substring(0, 80)}`);
          return false;
        }
      } catch (e) {
        console.error(`[SparkP2P] sendChatMessage: Vision fallback error: ${e.message?.substring(0, 80)}`);
        return false;
      }
    } else {
      console.log('[SparkP2P] Message typed via DOM');
    }

    await new Promise(r => setTimeout(r, 400));

    // Step 2: Send — refocus the chat input then press Enter.
    // Binance P2P contenteditable does not have a type="submit" button, so
    // button-click is unreliable. Refocus + Enter is definitive on all paths.
    await page.evaluate(() => {
      const sels = [
        'textarea[placeholder*="message" i]', 'textarea[placeholder*="enter" i]',
        'input[placeholder*="message" i]', 'textarea', 'div[contenteditable="true"]',
      ];
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          if (el.offsetParent !== null && !el.disabled) { el.focus(); return; }
        }
      }
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 150));
    await page.keyboard.press('Enter');

    await new Promise(r => setTimeout(r, 1000));
    console.log(`[SparkP2P] âœ… Message sent: "${message.substring(0, 60)}"`);
    return true;

  } catch (e) {
    console.error(`[SparkP2P] sendChatMessage error: ${e.message?.substring(0, 100)}`);
    return false;
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// CLAUDE VISION â€" Screenshot-based page analysis
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

const VISION_PROMPT = `You are analyzing a Binance P2P order page screenshot.
Extract ALL data with perfect precision and identify the exact screen state.

Return ONLY a valid JSON object â€" no markdown, no explanation, no code fences.

{
  "screen": "<orders_list|awaiting_payment|payment_processing|verify_payment|confirm_release_modal|passkey_failed|security_verification|totp_input|email_otp_input|order_complete|unknown>",
  "order_number": "<exact order number string or null>",
  "buyer_name": "<exact full name or null>",
  "fiat_amount_kes": <KES amount as plain number e.g. 1000.00 â€" NEVER add zeros>,
  "usdt_amount": <USDT amount as plain number e.g. 7.71 â€" read character by character>,
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

CRITICAL NUMBER RULES â€" read every digit individually:
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
    console.log('[Vision] No Anthropic API key â€" skipping vision analysis');
    return { screen: 'unknown' };
  }
  try {
    // â"€â"€ DOM pre-check â€" definitive markers that Vision often misreads â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    const domScreen = await page.evaluate(() => {
      const body = document.body.innerText || '';
      const lower = body.toLowerCase();
      const hasOtpInput = !!document.querySelector('input[maxlength="6"], input[maxlength="8"]');
      // order_complete
      if (lower.includes('order completed') || lower.includes('sale successful') ||
          lower.includes('crypto released')) return 'order_complete';
      // confirm_release_modal â€" unmistakable phrases
      if (lower.includes('received payment in your account') ||
          lower.includes('i have verified that i received') ||
          lower.includes('confirm release')) return 'confirm_release_modal';
      // totp_input â€" check BEFORE security_verification (shares "authenticator app" substring)
      if (hasOtpInput && (lower.includes('authenticator app verification') || lower.includes('google authenticator')))
        return 'totp_input';
      // email_otp
      if (hasOtpInput && (lower.includes('email verification') || lower.includes('email code')))
        return 'email_otp_input';
      // security_verification â€" only when no OTP input present
      if (lower.includes('security verification') || (!hasOtpInput && lower.includes('authenticator app')))
        return 'security_verification';
      // passkey_failed â€" only if we explicitly see passkey failure text
      if ((lower.includes('verification failed') || lower.includes('verify with passkey')) && lower.includes('passkey'))
        return 'passkey_failed';
      return null; // let Vision decide
    }).catch(() => null);

    if (domScreen) {
      console.log(`[Vision] DOM pre-check → ${domScreen}`);
      return { screen: domScreen };
    }

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

// â"€â"€ Vision API helper â€" consistent with rest of codebase (raw fetch, no SDK) â"€â"€
async function visionAsk(imageBase64, prompt, maxTokens = 150) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: prompt },
      ]}],
    }),
  });
  const data = await resp.json();
  return (data.content?.[0]?.text || '').trim().replace(/```[a-z]*\n?/g, '').replace(/```/g, '');
}

/**
 * svClickViaOOPIF â€" finds the Security Verification row using Puppeteer frames,
 * gets its exact coordinates from the DOM, then fires page.mouse.click() at those
 * coordinates. page.mouse.click() sends a real CDP input event (isTrusted:true),
 * so Binance accepts it â€" without any physical mouse movement.
 */
async function svClickViaOOPIF(page, targetText) {
  try {
    const frames = page.frames();
    console.log(`[OOPIF] Puppeteer sees ${frames.length} frames:`);
    frames.forEach(f => console.log(`  [OOPIF]   ${f.url().substring(0, 80)}`));

    // JS to find the target row and return its center coordinates within the frame
    const findCoordsJS = (target) => {
      const allEls = Array.from(document.querySelectorAll('*'));

      // Find the smallest element that contains the target text and is visible
      const candidates = allEls.filter(el => {
        const txt = (el.textContent || '').trim();
        const r = el.getBoundingClientRect();
        return txt.includes(target) && r.width > 10 && r.height > 5;
      });
      if (!candidates.length) return null;

      // Pick the most specific (shortest text = least wrapping)
      candidates.sort((a, b) => a.textContent.length - b.textContent.length);
      const el = candidates[0];
      const r = el.getBoundingClientRect();
      return {
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        tag: el.tagName,
        txt: el.textContent.trim().substring(0, 40),
      };
    };

    // Search all frames â€" try cross-origin (binance) frames first, then main
    const allFrames = [
      ...frames.filter(f => f.url().includes('binance.com')),
      ...frames.filter(f => !f.url().includes('binance.com')),
    ];

    for (const frame of allFrames) {
      const url = frame.url();
      console.log(`[OOPIF] Searching frame: ${url.substring(0, 80)}`);
      let coords = null;
      try {
        coords = await frame.evaluate(findCoordsJS, targetText);
      } catch (e) {
        console.log(`[OOPIF]   eval error: ${e.message?.substring(0, 60)}`);
        continue;
      }
      if (!coords) { console.log(`[OOPIF]   not found`); continue; }

      console.log(`[OOPIF]   found: ${coords.tag} "${coords.txt}" at frame(${Math.round(coords.x)}, ${Math.round(coords.y)})`);

      // coords are relative to the frame's own viewport.
      // If this is a sub-frame, we need to add the iframe's offset in the main page.
      let absX = coords.x;
      let absY = coords.y;

      if (frame !== page.mainFrame()) {
        // Find the <iframe> element in the parent frame that hosts this frame
        const iframeOffset = await frame.parentFrame()?.evaluate((frameUrl) => {
          const iframes = Array.from(document.querySelectorAll('iframe'));
          for (const el of iframes) {
            // Match by src or just take the first visible iframe
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return { x: r.left, y: r.top };
          }
          return { x: 0, y: 0 };
        }, url).catch(() => ({ x: 0, y: 0 }));

        absX += (iframeOffset?.x || 0);
        absY += (iframeOffset?.y || 0);
        console.log(`[OOPIF]   iframe offset: (${Math.round(iframeOffset?.x||0)}, ${Math.round(iframeOffset?.y||0)}) → abs(${Math.round(absX)}, ${Math.round(absY)})`);
      }

      // page.mouse.click() sends a CDP Input.dispatchMouseEvent â€" isTrusted:true,
      // accepted by Binance's security dialog, no physical mouse movement needed.
      console.log(`[OOPIF]   CDP mouse click at (${Math.round(absX)}, ${Math.round(absY)})`);
      await page.mouse.move(absX, absY);
      await new Promise(r => setTimeout(r, 80));
      await page.mouse.click(absX, absY);
      return true;
    }

    console.log('[OOPIF] Target row not found in any frame');
    return false;
  } catch (e) {
    console.log(`[OOPIF] Failed: ${e.message?.substring(0, 120)}`);
    return false;
  }
}

/**
 * svClickAnchored â€" Anchor-based GPT-4o click strategy.
 *
 * 1. Find the Security Verification modal box in the main DOM (heading is accessible).
 * 2. Take screenshot + tell GPT-4o the exact modal pixel bounds.
 * 3. GPT-4o returns ABSOLUTE pixel coords of the target row (not guessed fractions).
 * 4. page.mouse.click() fires a CDP input event â€" isTrusted:true, no physical mouse.
 */
async function svClickAnchored(page, targetText) {
  try {
    if (!anthropicApiKey) throw new Error('No Anthropic API key');

    // â"€â"€ Step 1: Locate the modal container in the main DOM â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    const modal = await page.evaluate(() => {
      // Find the "Security Verification" heading text node â€" it IS in the main frame DOM
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const t = (walker.currentNode.textContent || '').trim();
        if (t.includes('Security Verification')) {
          const el = walker.currentNode.parentElement;
          const r = el?.getBoundingClientRect();
          if (r && r.width > 0 && r.height > 0) {
            return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
          }
        }
      }
      // Fallback: find the "0/2" or "1/2" leaf node
      for (const el of document.querySelectorAll('*')) {
        if (el.children.length > 0) continue;
        const t = (el.textContent || '').trim();
        if (t === '0/2' || t === '1/2') {
          const r = el.getBoundingClientRect();
          if (r.width > 0) return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
        }
      }
      return null;
    }).catch(() => null);

    if (modal) {
      console.log(`[Anchored] Modal found: (${modal.x}, ${modal.y}) ${modal.w}Ã—${modal.h}`);
    } else {
      console.log('[Anchored] Modal not found in DOM â€" sending screenshot without anchor');
    }

    // â"€â"€ Step 2: Screenshot + Claude Vision with modal context â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    const ss = await page.screenshot({ type: 'png' });
    const ssW = ss.readUInt32BE(16);
    const ssH = ss.readUInt32BE(20);
    const vp  = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    const dpr = ssW / vp.w;

    // Save debug screenshot
    try {
      fs.writeFileSync(path.join(app.getPath('desktop'), 'sv_debug_screenshot.png'), ss);
    } catch (_) {}

    const modalHint = modal
      ? `The "Security Verification Requirements" dialog heading is at pixel y=${Math.round(modal.y * dpr)} in the image (x center â‰ˆ ${Math.round((modal.x + modal.w / 2) * dpr)}).\n` +
        `The "Authenticator App" clickable row is approximately 60-80px BELOW the heading (it is the FIRST / TOP row in the list).\n` +
        `The "Email" clickable row is approximately 110-130px BELOW the heading (it is the SECOND / BOTTOM row).\n`
      : `The "Security Verification Requirements" dialog is floating near the center of the screen.\n`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 80,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ss.toString('base64') } },
            { type: 'text', text:
              `This is a ${ssW}Ã—${ssH} pixel screenshot of a Binance P2P trading platform.\n` +
              modalHint +
              `A "Security Verification Requirements" dialog is open. It lists two verification method rows stacked vertically, each spanning the full dialog width and containing an icon on the left, a label in the middle, and a right-pointing ">" arrow on the right:\n\n` +
              `  ROW 1 (TOP ROW):    Label = "Authenticator App"  â€" has a shield or lock icon on the left side\n` +
              `  ROW 2 (BOTTOM ROW): Label = "Email"              â€" has an envelope or email icon on the left side, positioned DIRECTLY BELOW Row 1\n\n` +
              (targetText === 'Email'
                ? `I need to click the EMAIL row (Row 2, the BOTTOM row with the envelope icon). ` +
                  `The Email row is positioned BELOW the Authenticator App row. ` +
                  `If the Authenticator App row already shows a checkmark or completed state, the Email row is the ONLY active/clickable row remaining.\n`
                : `I need to click the AUTHENTICATOR APP row (Row 1, the TOP row with the shield icon).\n`) +
              `Find the center pixel of the "${targetText}" row â€" click the middle of the row horizontally, and the vertical center of that specific row.\n` +
              `Return ONLY a JSON object with absolute pixel coordinates â€" no explanation, no markdown:\n{"x": 640, "y": 334}` },
          ],
        }],
      }),
    });

    const data = await res.json();
    if (data.error) throw new Error(`Anthropic: ${data.error.message || JSON.stringify(data.error)}`);
    const txt = ((data.content?.[0]?.text) || '').trim();
    console.log(`[Anchored] Claude: ${txt.substring(0, 100)}`);

    const m = txt.match(/\{[^}]+\}/);
    if (!m) throw new Error('No JSON in response');
    const coords = JSON.parse(m[0]);
    if (!coords.x || !coords.y) throw new Error('Missing x/y');

    // â"€â"€ Step 3: Image pixels → CSS viewport pixels → CDP click â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    const vpX = Math.round(coords.x / dpr);
    const vpY = Math.round(coords.y / dpr);
    console.log(`[Anchored] "${targetText}" image(${coords.x},${coords.y}) → viewport(${vpX},${vpY})`);

    // page.mouse.click sends CDP Input.dispatchMouseEvent â€" isTrusted:true
    await page.mouse.move(vpX, vpY);
    await new Promise(r => setTimeout(r, 100));
    await page.mouse.click(vpX, vpY);
    console.log(`[Anchored] CDP click fired at viewport(${vpX}, ${vpY})`);
    return { ok: true };
  } catch (e) {
    console.log(`[Anchored] Failed: ${e.message?.substring(0, 120)}`);
    return { ok: false };
  }
}

/**
 * realMouseClick â€" physically moves the OS cursor to a viewport position and clicks.
 * Uses Electron BrowserWindow.getContentBounds() for accurate coordinate mapping,
 * then SetCursorPos + mouse_event via PowerShell for the actual click.
 */
async function realMouseClick(page, viewportX, viewportY) {
  try {
    const { screen: eScreen } = require('electron');
    const sf = eScreen.getPrimaryDisplay().scaleFactor;

    // Find the visible, on-screen BrowserWindow.
    // After Playwright CDP connection, extra hidden windows may appear with bounds (-32000,-32000).
    // Filter those out and pick the window with valid (on-screen) coordinates.
    const allWins = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
    const bwin = allWins.find(w => {
      const b = w.getContentBounds();
      return b.x > -1000 && b.y > -1000 && b.width > 100;
    }) || allWins[0];
    if (!bwin) throw new Error('No BrowserWindow found');

    const cb = bwin.getContentBounds();
    let screenX, screenY;

    if (cb.x > -1000 && cb.y > -1000) {
      // Electron API path â€" reliable when window bounds are valid
      screenX = Math.round((cb.x + viewportX) * sf);
      screenY = Math.round((cb.y + viewportY) * sf);
      console.log(`[RealClick] Electron bounds (${cb.x},${cb.y}) scale=${sf} → screen(${screenX},${screenY})`);
    } else {
      // Fallback: window.screenX/Y (CSS pixels) from inside the page
      const win = await page.evaluate(() => ({
        sx: window.screenX,    sy: window.screenY,
        sl: window.screenLeft, st: window.screenTop,
        ow: window.outerWidth, oh: window.outerHeight,
        iw: window.innerWidth, ih: window.innerHeight,
        dpr: window.devicePixelRatio,
      }));
      const chromeH = win.oh - win.ih;
      // Use screenLeft/screenTop if available (more reliable on some systems)
      const winX = win.sl ?? win.sx;
      const winY = win.st ?? win.sy;
      screenX = Math.round((winX + viewportX) * sf);
      screenY = Math.round((winY + chromeH + viewportY) * sf);
      console.log(`[RealClick] window fallback: pos=(${winX},${winY}) outer=${win.ow}x${win.oh} inner=${win.iw}x${win.ih} chromeH=${chromeH} pageDPR=${win.dpr} scale=${sf}`);
      console.log(`[RealClick] → screen(${screenX},${screenY}) for viewport(${viewportX},${viewportY})`);
    }

    const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
public class RealMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int cButtons, int dwExtraInfo);
  const int MOUSEEVENTF_LEFTDOWN = 0x0002;
  const int MOUSEEVENTF_LEFTUP   = 0x0004;
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    Thread.Sleep(120);
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
    Thread.Sleep(60);
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
  }
}
"@
[RealMouse]::Click(${screenX}, ${screenY})
Write-Host "done"
`;
    const tmpFile = require('path').join(require('os').tmpdir(), 'sp2p_realclick.ps1');
    require('fs').writeFileSync(tmpFile, script, 'utf8');
    const output = await new Promise(resolve => {
      require('child_process').exec(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`,
        { timeout: 8000 },
        (err, stdout) => resolve(stdout || err?.message || 'error')
      );
    });
    console.log(`[RealClick] ${output.trim().substring(0, 60)}`);
    return true;
  } catch (e) {
    console.log(`[RealClick] Failed: ${e.message?.substring(0, 60)}`);
    return false;
  }
}

/**
 * uiAutomationClick â€" clicks an element at screen coordinates using Windows UI Automation.
 * Uses AutomationElement.FromPoint() + InvokePattern.Invoke() via PowerShell.
 * NO cursor movement â€" the mouse stays exactly where it is.
 * Chromium/Electron supports UI Automation for all web content elements.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {number} viewportX  â€" X in viewport pixels
 * @param {number} viewportY  â€" Y in viewport pixels
 */
async function uiAutomationClick(page, viewportX, viewportY) {
  try {
    // Convert viewport coords → logical screen coords
    const win = await page.evaluate(() => ({
      sx: window.screenX, sy: window.screenY,
      ow: window.outerWidth, oh: window.outerHeight,
      iw: window.innerWidth, ih: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
    }));
    const chromeH = win.oh - win.ih;
    const chromeW = win.ow - win.iw;
    const screenX = Math.round((win.sx + Math.floor(chromeW / 2) + viewportX) * win.dpr);
    const screenY = Math.round((win.sy + chromeH + viewportY) * win.dpr);

    console.log(`[UIAuto] viewport(${viewportX},${viewportY}) → physical screen(${screenX},${screenY})`);

    // PowerShell: UI Automation click using inline C# (reliable assembly loading)
    const script = `
Add-Type -ReferencedAssemblies UIAutomationClient,UIAutomationTypes,WindowsBase,PresentationCore @"
using System;
using System.Windows;
using System.Windows.Automation;
public static class UiaClick {
  public static string Do(int x, int y) {
    var pt = new Point(x, y);
    var el = AutomationElement.FromPoint(pt);
    if (el == null) return "no-element";
    Console.WriteLine("UIA found: [" + el.Current.ControlType.ProgrammaticName + "] '" + el.Current.Name + "'");
    try {
      var p = el.GetCurrentPattern(InvokePattern.Pattern) as InvokePattern;
      if (p != null) { p.Invoke(); return "invoked"; }
    } catch {}
    try {
      var p2 = el.GetCurrentPattern(LegacyIAccessiblePattern.Pattern) as LegacyIAccessiblePattern;
      if (p2 != null) { p2.DoDefaultAction(); return "legacy-invoked"; }
    } catch {}
    return "no-pattern";
  }
}
"@
$result = [UiaClick]::Do(${screenX}, ${screenY})
Write-Host "UIA result: $result"
if ($result -eq "no-pattern") { exit 2 }
if ($result -eq "no-element") { exit 1 }
`;
    const tmpFile = require('path').join(require('os').tmpdir(), 'sp2p_uia.ps1');
    require('fs').writeFileSync(tmpFile, script, 'utf8');

    const output = await new Promise((resolve, reject) => {
      require('child_process').exec(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`,
        { timeout: 8000 },
        (err, stdout) => resolve(stdout || (err?.message ?? 'error'))
      );
    });
    console.log(`[UIAuto] ${output.trim().substring(0, 120)}`);
    return output.includes('succeeded');
  } catch (e) {
    console.log(`[UIAuto] Failed: ${e.message?.substring(0, 80)}`);
    return false;
  }
}

async function releaseWithVision(page, orderNumber, action, { skipNavigation = false } = {}) {
  const MAX_STEPS = 60;  // Raised: buyer has up to 15 min, awaiting_payment uses DOM poll not steps
  let step = 0;
  let consecutiveUnknown = 0;  // Track back-to-back unknowns before reloading

  console.log(`[Vision] Starting vision-driven release for order ${orderNumber}`);

  // Ensure Anthropic API key is loaded â€" re-fetch credentials if missing
  if (!anthropicApiKey) {
    console.log('[Vision] Anthropic API key missing â€" re-fetching credentials...');
    await fetchAndApplyCredentials();
    if (!anthropicApiKey) {
      console.error('[Vision] Anthropic API key still missing after re-fetch â€" cannot proceed with Vision release');
      return { success: false, error: 'No Anthropic API key' };
    }
    console.log('[Vision] Anthropic API key loaded successfully');
  }

  try {
    if (skipNavigation) {
      console.log(`[Vision] Skipping navigation â€" already on order page with modal open`);
    } else {
      await navigateToOrderDetail(page, orderNumber);
      await new Promise(r => setTimeout(r, 1500));
    }

    // Inject real-time chat monitor — buyer messages during the release flow get handled immediately
    await injectChatMonitor(page, { orderNumber, fiatAmount: activeOrderFiatAmount });

    // Send pre-release chat message if provided
    if (action.message) await sendChatMessage(page, action.message);

    while (step < MAX_STEPS) {
      // Stop immediately if user paused the bot
      if (pauseNavigation) {
        console.log('[Vision] Bot paused by user â€" halting vision loop');
        return { success: false, error: 'paused' };
      }
      step++;

      // â"€â"€ DOM pre-check: catch all states without Vision â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
      // ORDER MATTERS: more specific / modal states first; broader states last.
      const domScreen = await page.evaluate(() => {
        const text = document.body.innerText || '';
        const lower = text.toLowerCase();

        // 1. Order complete â€" use specific multi-word phrases to avoid false positives
        if (text.includes('Sale Successful') || text.includes('Order Completed') ||
            text.includes('Order Complete') || text.includes('Crypto Released'))
          return 'order_complete';

        // 2. Confirm release modal â€" has unmistakable phrases unique to this modal
        if (text.includes('Received payment in your account') ||
            text.includes('I have verified that I received') ||
            text.includes('Confirm Release'))
          return 'confirm_release_modal';

        // 3. TOTP input â€" check BEFORE security_verification.
        //    "Authenticator App Verification" contains "Authenticator App" so if security_verification
        //    checked first with that substring it would falsely match the TOTP page.
        //    Anchor: an OTP input field must be present on the page.
        const hasOtpInput = !!document.querySelector('input[maxlength="6"], input[maxlength="8"]');
        if (hasOtpInput && (text.includes('Authenticator App Verification') || text.includes('Google Authenticator')))
          return 'totp_input';

        // 4. Email OTP input â€" also requires the input field to be present
        if (hasOtpInput && (text.includes('Email Verification') || text.includes('email verification code') ||
            lower.includes('email code')))
          return 'email_otp_input';

        // 5. Security Verification Requirements (step-picker page â€" no code input).
        //    Use "Security Verification" as anchor (unique to this page); also match
        //    "Authenticator App" only when NO otp input is present (i.e. not on TOTP page).
        if (text.includes('Security Verification') ||
            (!hasOtpInput && text.includes('Authenticator App'))) {
          const progress = text.includes('1/2') ? '1/2' : '0/2';
          return `security_verification:${progress}`;
        }

        // 6. Passkey screen â€" text not always in innerText (native WebAuthn dialog),
        //    so only match when we actually see the passkey-specific phrase.
        const hasPasskeyLink = lower.includes('my passkeys are not available') || lower.includes('passkeys are not available');
        const hasPasskeyFail = lower.includes('verify with passkey') || lower.includes('verification failed');
        if (hasPasskeyLink || (hasPasskeyFail && lower.includes('passkey'))) return 'passkey_failed';

        // 7. Verify Payment page â€" only if the "Payment Received" button is actually clickable.
        //    If the text is present but the button is gone, a dialog (passkey/auth) is covering
        //    the page â€" return null so Vision can identify the true state.
        if (text.includes('Verify Payment') || text.includes('Confirm payment from buyer') ||
            text.includes('Confirm payment is received') || text.includes('Payment Received')) {
          const hasPayBtn = !!Array.from(document.querySelectorAll('button, [role="button"]')).find(b => {
            const t = (b.textContent || '').toLowerCase();
            return (t.includes('payment received') || t.includes('received payment')) &&
                   b.getBoundingClientRect().width > 0;
          });
          if (hasPayBtn) return 'verify_payment';
          return null; // button absent â€" let Vision decide
        }

        // 8. Awaiting payment
        if (text.includes("Awaiting Buyer's Payment") || text.includes('Awaiting Payment'))
          return 'awaiting_payment';

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

      // â"€â"€ Order complete â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
      if (screen === 'order_complete' || info.sale_successful) {
        console.log(`[Vision] Order ${orderNumber} released successfully!`);
        await fetch(`${API_BASE}/ext/report-release`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ order_number: orderNumber, success: true }),
        }).catch(() => {});
        return { success: true };
      }

      // â"€â"€ Awaiting payment â€" DOM poll, no Vision calls until buyer pays â"€â"€â"€â"€â"€
      if (screen === 'awaiting_payment') {
        consecutiveUnknown = 0;
        console.log('[Vision] Awaiting buyer payment â€" DOM polling every 20s (no Vision calls)...');
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
              console.log('[Vision] Payment detected via DOM â€" resuming Vision loop');
              paymentDetected = true;
              break;
            }
            console.log(`[Vision] Still awaiting payment (poll ${poll + 1}/45)...`);
          } catch (e) {
            console.log('[Vision] DOM poll error:', e.message?.substring(0, 40));
          }
        }
        if (!paymentDetected) {
          console.log('[Vision] Buyer did not pay within 15 minutes â€" giving up');
          return { success: false, error: 'Payment timeout' };
        }
        continue;
      }

      // â"€â"€ Payment processing â€" Binance verifying payment â"€â"€â"€â"€â"€â"€
      if (screen === 'payment_processing') {
        consecutiveUnknown = 0;
        console.log('[Vision] Payment processing â€" waiting 10s for Binance to complete...');
        await new Promise(r => setTimeout(r, 10000));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      // â"€â"€ Verify payment â€" click Payment Received â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
      // Message to buyer is sent by the main loop BEFORE releaseWithVision is called.
      // IMPORTANT: Do NOT use clickButton() here â€" its AI fallback can mis-click "Appeal"
      // when the passkey dialog is open and "Payment Received" is not visible.
      if (screen === 'verify_payment') {
        // DOM-only: find and click "Payment Received" button (no AI fallback)
        const clicked = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, a[role="button"], [class*="btn"], [role="button"]'));
          const btn = buttons.find(b => {
            const t = (b.textContent || '').toLowerCase().trim();
            return t.includes('payment received') || t.includes('received payment');
          });
          if (btn && btn.getBoundingClientRect().width > 0) { btn.click(); return true; }
          return false;
        }).catch(() => false);

        if (clicked) {
          console.log('[Vision] âœ… Payment Received clicked via DOM');
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }

        // Payment Received not found â€" passkey dialog is likely open (its text is not in
        // document.body.innerText because WebAuthn renders outside the main DOM tree).
        // Try to find and click the passkey bypass link via shadow DOM search + all frames.
        console.log('[Vision] Payment Received not found â€" passkey dialog may be open, attempting bypass...');
        const phrases = ['my passkeys are not available', 'passkeys are not available', 'passkey is not available'];
        let passKeyHandled = false;

        for (const frame of [page, ...page.frames()]) {
          try {
            const result = await frame.evaluate((phrases) => {
              function searchRoot(root) {
                const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
                while (walker.nextNode()) {
                  const node = walker.currentNode;
                  const t = (node.textContent || '').trim().toLowerCase();
                  if (!phrases.some(p => t.includes(p))) continue;
                  const el = node.parentElement;
                  if (!el) continue;
                  const r = el.getBoundingClientRect();
                  if (r.width === 0 || r.height === 0) continue;
                  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
                }
                for (const el of root.querySelectorAll('*')) {
                  if (el.shadowRoot) {
                    const found = searchRoot(el.shadowRoot);
                    if (found) return found;
                  }
                }
                return null;
              }
              return searchRoot(document.body);
            }, phrases);
            if (result) {
              await page.mouse.click(result.x, result.y);
              console.log(`[Vision] âœ… Passkey bypass (frame) at (${Math.round(result.x)}, ${Math.round(result.y)})`);
              passKeyHandled = true;
              break;
            }
          } catch (_) {}
        }

        if (!passKeyHandled) {
          // Neither Payment Received nor passkey link found â€" use Vision to see true state.
          // This prevents blind clicking (e.g. Appeal) in unexpected situations.
          console.log('[Vision] No actionable button found â€" using Vision to identify current screen...');
          const vInfo = await analyzePageWithVision(page);
          console.log(`[Vision] Vision identified: ${vInfo.screen} â€" will handle next iteration`);
          // Do NOT click anything. Next iteration will re-evaluate with fresh DOM + Vision.
        }

        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // â"€â"€ Confirm release modal â€" verify M-Pesa, tick checkbox, Confirm Release â"€â"€
      // Modal title: "Received payment in your account?"
      // Checkbox: "I have verified that I received KSh [AMOUNT] from the buyer - [NAME]"
      // Flow: verify M-Pesa → if confirmed tick + release; if not → Appeal
      if (screen === 'confirm_release_modal') {
        console.log(`[Vision] Confirm release modal â€" verifying M-Pesa for order ${orderNumber}...`);
        // Use codes extracted before the modal opened (modal covers chat panel).
        // Pass null for page so it doesn't try to re-scan the hidden chat.
        const { verified: mpesaVerified, reason: mpesaFailReason } = await verifyMpesaPayment(orderNumber, activeOrderFiatAmount, null, action.preChatCodes || null);

        if (mpesaVerified) {
          console.log(`[Vision] âœ… M-Pesa confirmed â€" ticking checkbox and releasing...`);

          // â"€â"€ Step 1: Tick the checkbox â€" DOM first, Vision fallback â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
          console.log(`[Vision] Ticking confirm-release checkbox...`);
          const checkboxClicked = await page.evaluate(() => {
            // Binance uses Ant Design â€" try multiple selectors
            const selectors = [
              'input[type="checkbox"]',
              '.ant-checkbox-input',
              '.bn-checkbox-input',
              '[class*="checkbox"] input',
              '[class*="checkbox"]',
            ];
            for (const sel of selectors) {
              const els = Array.from(document.querySelectorAll(sel));
              for (const el of els) {
                if (el.getBoundingClientRect().width > 0) {
                  el.click();
                  // also dispatch change event for React
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                  return true;
                }
              }
            }
            // Fallback: click the label text containing "I have verified"
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
            while (walker.nextNode()) {
              const el = walker.currentNode;
              const t = (el.textContent || '').trim().toLowerCase();
              if (t.includes('i have verified') && el.getBoundingClientRect().width > 0) {
                el.click();
                return true;
              }
            }
            return false;
          }).catch(() => false);

          if (checkboxClicked) {
            console.log(`[Vision] âœ… Checkbox ticked via DOM`);
          } else {
            console.log(`[Vision] DOM checkbox failed â€" trying Vision coordinates...`);
            try {
              const ssBase64 = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 80 });
              const coords = await visionAsk(ssBase64,
                'Find the small square checkbox to the left of the text "I have verified that I received" inside the confirmation modal. ' +
                'Return ONLY a JSON object: {"x": <number>, "y": <number>} with the pixel coordinates of the checkbox center. No other text.',
                80
              );
              const m = coords.match(/\{\s*"x"\s*:\s*(\d+)\s*,\s*"y"\s*:\s*(\d+)\s*\}/);
              if (m) {
                await page.mouse.click(parseInt(m[1]), parseInt(m[2]));
                console.log(`[Vision] âœ… Checkbox clicked via Vision coords (${m[1]}, ${m[2]})`);
              } else {
                console.log(`[Vision] Vision checkbox coord parse failed: ${coords?.substring(0, 80)}`);
              }
            } catch (e) {
              console.log(`[Vision] Vision checkbox fallback failed: ${e.message?.substring(0, 80)}`);
            }
          }
          await new Promise(r => setTimeout(r, 1200));

          // â"€â"€ Step 2: Click Confirm Release â€" DOM first, Vision fallback â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
          console.log(`[Vision] Clicking Confirm Release button...`);
          const confirmClicked = await page.evaluate(() => {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
            while (walker.nextNode()) {
              const el = walker.currentNode;
              const tag = el.tagName;
              const t = (el.textContent || '').trim().toLowerCase();
              if ((tag === 'BUTTON' || tag === 'A' || el.getAttribute('role') === 'button') &&
                  t.includes('confirm') && t.includes('release') &&
                  el.getBoundingClientRect().width > 0) {
                el.click();
                return true;
              }
            }
            return false;
          }).catch(() => false);

          if (confirmClicked) {
            console.log(`[Vision] âœ… Confirm Release clicked via DOM`);
          } else {
            console.log(`[Vision] DOM Confirm Release failed â€" trying Vision coordinates...`);
            try {
              const ssBase64b = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 80 });
              const coords2 = await visionAsk(ssBase64b,
                'Find the yellow or golden "Confirm Release" button at the bottom of the modal. ' +
                'Return ONLY a JSON object: {"x": <number>, "y": <number>} with the pixel coordinates of the button center. No other text.',
                80
              );
              const m2 = coords2.match(/\{\s*"x"\s*:\s*(\d+)\s*,\s*"y"\s*:\s*(\d+)\s*\}/);
              if (m2) {
                await page.mouse.click(parseInt(m2[1]), parseInt(m2[2]));
                console.log(`[Vision] âœ… Confirm Release clicked via Vision coords (${m2[1]}, ${m2[2]})`);
              } else {
                console.log(`[Vision] Vision Confirm Release coord parse failed: ${coords2?.substring(0, 80)}`);
              }
            } catch (e) {
              console.log(`[Vision] Vision Confirm Release fallback failed: ${e.message?.substring(0, 80)}`);
            }
          }
          await new Promise(r => setTimeout(r, 3000));

        } else {
          console.log(`[Vision] âŒ M-Pesa not confirmed for ${orderNumber}: ${mpesaFailReason}`);
          // Close the modal first â€" chat panel is hidden while modal is open
          await page.keyboard.press('Escape').catch(() => {});
          await new Promise(r => setTimeout(r, 800));
          await page.evaluate(() => {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
            while (walker.nextNode()) {
              const el = walker.currentNode;
              const t = (el.textContent || '').trim();
              if ((t === 'Ã—' || t === 'âœ•' || t === 'Close') && el.getBoundingClientRect().width > 0) {
                el.click(); return true;
              }
            }
          }).catch(() => {});
          await new Promise(r => setTimeout(r, 800));

          // Build a professional message depending on the rejection reason
          const alreadyUsed = mpesaFailReason && mpesaFailReason.toLowerCase().includes('already used');
          const buyerMsg = alreadyUsed
            ? `Thank you for your order. However, the M-Pesa receipt you provided has already been used on a previous transaction and cannot be applied again. Kindly send a new, valid M-Pesa receipt for this order. If you completed the payment via your bank, please share the M-Pesa reference number from your bank statement. We appreciate your understanding.`
            : `Thank you for your order. We were unable to verify your payment using the receipt provided. Kindly ensure you share a valid M-Pesa transaction receipt for KES ${activeOrderFiatAmount || ''}. If you made the payment through your bank, please provide the M-Pesa reference number included in your bank transaction confirmation. We are happy to assist once a valid receipt is received.`;

          await sendChatMessage(page, buyerMsg);
          console.log(`[Vision] Sent invalid-receipt message to buyer`);
          return { success: false, error: 'mpesa_unverified_waiting' };
        }
        continue;
      }

      // â"€â"€ Passkey failed â€" click "My Passkeys Are Not Available" â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
      if (screen === 'passkey_failed') {
        console.log('[DOM] Passkey screen â€" locating "My Passkeys Are Not Available"...');
        await new Promise(r => setTimeout(r, 800));

        // Search including shadow DOM â€" Binance may render the dialog in a web component
        const passKeyCoords = await page.evaluate(() => {
          const phrases = ['my passkeys are not available', 'passkeys are not available', 'passkey is not available'];

          function searchRoot(root) {
            // Walk text nodes in this root
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
              const node = walker.currentNode;
              const t = (node.textContent || '').trim().toLowerCase();
              if (!phrases.some(p => t.includes(p))) continue;
              const el = node.parentElement;
              if (!el) continue;
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName, text: t.substring(0, 60) };
            }
            // Recurse into shadow roots
            for (const el of root.querySelectorAll('*')) {
              if (el.shadowRoot) {
                const found = searchRoot(el.shadowRoot);
                if (found) return found;
              }
            }
            return null;
          }

          return searchRoot(document.body);
        }).catch(() => null);

        if (passKeyCoords) {
          console.log(`[DOM] Found "${passKeyCoords.text}" <${passKeyCoords.tag}> at (${Math.round(passKeyCoords.x)}, ${Math.round(passKeyCoords.y)}) â€" clicking`);
          await page.mouse.click(passKeyCoords.x, passKeyCoords.y);
          console.log('[DOM] âœ… "My Passkeys Are Not Available" clicked');
        } else {
          console.log('[DOM] Not found (incl. shadow DOM) â€" trying Tab keyboard navigation...');
          // Keyboard fallback: Tab moves focus from "Try Again" → "My Passkeys Are Not Available" link
          // Then Enter activates it. Much more reliable than DOM/Vision for modal dialogs.
          await page.keyboard.press('Tab');
          await new Promise(r => setTimeout(r, 300));
          // Check if focused element text matches what we want
          const focusedText = await page.evaluate(() => (document.activeElement?.textContent || '').trim().toLowerCase()).catch(() => '');
          console.log(`[DOM] Tab focused: "${focusedText.substring(0, 60)}"`);
          if (focusedText.includes('passkey') || focusedText.includes('not available')) {
            await page.keyboard.press('Enter');
            console.log('[DOM] âœ… Pressed Enter on focused passkey link');
          } else {
            // Tab again â€" dialog may have more focusable elements before the link
            await page.keyboard.press('Tab');
            await new Promise(r => setTimeout(r, 300));
            await page.keyboard.press('Enter');
            console.log('[DOM] âœ… Pressed Enter after second Tab');
          }
        }
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }

      // â"€â"€ Security verification â€" click Authenticator App / Email row â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
      // The rows ARE standard HTML elements (text visible in innerText).
      // Strategy: DOM find + mouse.click() at element coords → Tab keyboard → Vision.
      if (screen === 'security_verification') {
        const svProgress = domScreen?.split(':')[1] || '0/2';
        const authDone = svAuthDoneOrders.has(orderNumber) || svProgress === '1/2' || await page.evaluate(() =>
          (document.body.innerText || '').includes('1/2')
        ).catch(() => false);
        const targetText = authDone ? 'Email' : 'Authenticator App';

        console.log(`[SV] Security verification ${authDone ? '1/2' : '0/2'} â€" clicking "${targetText}" row...`);

        // Wait for dialog open animation to settle
        await new Promise(r => setTimeout(r, 800));

        let advanced = false;

        // Helper: detect that clicking a SV row actually advanced the page.
        // After clicking "Authenticator App" → page shows TOTP screen ("Authenticator App Verification" heading).
        // After clicking "Email"             → page shows Email OTP screen ("Email Verification" heading).
        // These headings ARE in the main DOM even when the input box is in a cross-origin iframe.
        // Also catches the progress badge transitioning to 1/2 or 2/2.
        const svAdvanced = () => page.evaluate(() => {
          const t = document.body.innerText || '';
          return (
            t.includes('1/2') || t.includes('2/2') ||
            !!document.querySelector('input[maxlength="6"], input[maxlength="8"]') ||
            t.includes('Authenticator App Verification') ||
            t.includes('Google Authenticator') ||
            t.includes('Email Verification') ||
            t.includes('email verification code')
          );
        }).catch(() => false);

        // Helper: when Auth App click is confirmed to have advanced the page,
        // immediately mark this order as auth-done so the NEXT security_verification
        // iteration targets Email instead of Auth App again.
        const markAuthDone = () => {
          if (!authDone) {
            svAuthDoneOrders.add(orderNumber);
            console.log(`[SV] âœ… Auth App confirmed â€" order ${orderNumber} marked auth-done, next SV targets Email`);
          }
        };

        // â"€â"€ Method 0: CDP OOPIF direct JS click (no screenshot, no mouse) â"€â"€â"€â"€â"€â"€â"€â"€
        console.log(`[SV] Method 0: OOPIF CDP click on "${targetText}"...`);
        const oopifClicked = await svClickViaOOPIF(page, targetText);
        if (oopifClicked) {
          await new Promise(r => setTimeout(r, 1500));
          advanced = await svAdvanced();
          if (advanced) { console.log('[SV] âœ… OOPIF click advanced the page'); markAuthDone(); }
          else console.log('[SV] OOPIF click fired but page did not advance â€" trying Claude Vision...');
        }

        // â"€â"€ Method 1: Anchor-based Claude Vision → CDP click (no physical mouse) â"€
        if (!advanced) {
          console.log(`[SV] Method 1: Anchor-based Claude Vision click on "${targetText}"...`);
          const anchored = await svClickAnchored(page, targetText);
          if (anchored.ok) {
            await new Promise(r => setTimeout(r, 1500));
            advanced = await svAdvanced();
            if (advanced) { console.log('[SV] âœ… Anchored Claude Vision click advanced the page'); markAuthDone(); }
          }
        }

        if (!advanced) {
          // â"€â"€ Method 2: DOM-anchored CDP click at fixed row offsets â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
          await page.bringToFront();
          await new Promise(r => setTimeout(r, 500));

          const dialogAnchor = await page.evaluate(() => {
            const vw = document.documentElement.clientWidth;
            // Priority 1: find the "0/2" or "1/2" leaf node â€" closest element to the rows
            const all = Array.from(document.querySelectorAll('*'));
            for (const el of all) {
              if (el.children.length > 0) continue; // leaf only
              const t = (el.textContent || '').trim();
              if (t === '0/2' || t === '1/2') {
                const r = el.getBoundingClientRect();
                if (r.width > 0) return { y: Math.round(r.bottom), cx: Math.round(vw / 2), anchor: '0/2' };
              }
            }
            // Priority 2: "Security Verification" heading
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
              const t = (walker.currentNode.textContent || '').trim();
              if (t.includes('Security Verification')) {
                const el = walker.currentNode.parentElement;
                const r = el?.getBoundingClientRect();
                if (r && r.width > 0) return { y: Math.round(r.bottom), cx: Math.round(vw / 2), anchor: 'heading' };
              }
            }
            return null;
          }).catch(() => null);

          let rowX, yGuesses;
          if (dialogAnchor) {
            rowX = dialogAnchor.cx;
            const baseY = dialogAnchor.y;
            const offset1 = dialogAnchor.anchor === '0/2' ? 28  : 80;
            const offset2 = dialogAnchor.anchor === '0/2' ? 56  : 108;
            const offset3 = dialogAnchor.anchor === '0/2' ? 84  : 136;
            yGuesses = authDone
              ? [baseY + offset2, baseY + offset3, baseY + offset1]  // Email = 2nd row
              : [baseY + offset1, baseY + offset2, baseY + offset3]; // Auth App = 1st row
            console.log(`[SV] Anchor "${dialogAnchor.anchor}" bottom y=${baseY} â€" trying y: ${yGuesses.join(', ')}`);
          } else {
            const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
            rowX = Math.round(vp.w / 2);
            yGuesses = authDone ? [280, 320, 360, 240] : [220, 260, 300, 340];
            console.log(`[SV] No anchor â€" scanning y range: ${yGuesses.join(', ')}`);
          }

          for (let attempt = 0; attempt < yGuesses.length && !advanced; attempt++) {
            const rowY = yGuesses[attempt];
            console.log(`[SV] CDP click attempt ${attempt + 1}: "${targetText}" at viewport (${rowX}, ${rowY})`);
            await page.mouse.move(rowX, rowY);
            await new Promise(r => setTimeout(r, 80));
            await page.mouse.click(rowX, rowY);
            await new Promise(r => setTimeout(r, 1200));
            advanced = await svAdvanced();
            if (advanced) { console.log(`[SV] âœ… Advanced after CDP click attempt ${attempt + 1}`); markAuthDone(); }
          }
        }

        // Final poll up to 6s â€" also checks if a previous click worked but detection was slow
        for (let p = 0; p < 12 && !advanced; p++) {
          await new Promise(r => setTimeout(r, 500));
          advanced = await svAdvanced();
          if (advanced) markAuthDone();
        }
        console.log(`[SV] Security verification advance: ${advanced ? 'âœ… progressed' : 'âš ï¸ still on same screen'}`);
        continue;
      }

      // â"€â"€ TOTP input â€" type code character by character + click Submit â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
      if (screen === 'totp_input') {
        if (!totpSecret) {
          console.log('[TOTP] Secret not in memory â€" re-fetching credentials...');
          await fetchAndApplyCredentials();
        }
        if (!totpSecret) {
          console.error('[TOTP] Secret not configured â€" check your SparkP2P settings');
          return { success: false, error: 'TOTP not configured' };
        }
        const code = generateTOTP(totpSecret);
        console.log(`[TOTP] Generated code: ${code}`);

        // Step 1: Find TOTP input across ALL frames (may be in cross-origin iframe),
        // CDP-click to focus it, then paste via clipboard Ctrl+V.
        let totpFilled = false;
        const totpFrames = [page.mainFrame(), ...page.frames()];
        for (const frame of totpFrames) {
          try {
            const coords = await frame.evaluate(() => {
              const input = document.querySelector(
                'input[maxlength="6"], input[maxlength="8"], input[type="tel"], input[type="number"]'
              );
              if (!input) return null;
              const r = input.getBoundingClientRect();
              if (r.width === 0) return null;
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }).catch(() => null);
            if (!coords) continue;

            // Get iframe offset if sub-frame
            let absX = coords.x, absY = coords.y;
            if (frame !== page.mainFrame()) {
              const offset = await frame.parentFrame()?.evaluate(() => {
                for (const el of document.querySelectorAll('iframe')) {
                  const r = el.getBoundingClientRect();
                  if (r.width > 0 && r.height > 0) return { x: r.left, y: r.top };
                }
                return { x: 0, y: 0 };
              }).catch(() => ({ x: 0, y: 0 }));
              absX += (offset?.x || 0);
              absY += (offset?.y || 0);
            }

            console.log(`[TOTP] Input found at (${Math.round(absX)}, ${Math.round(absY)}) in ${frame.url().substring(0, 50)}`);
            clipboard.writeText(code);
            await page.mouse.click(absX, absY); // CDP click â€" isTrusted:true, focuses input
            await new Promise(r => setTimeout(r, 150));
            // Clear any existing value first
            await page.keyboard.down('Control');
            await page.keyboard.press('a');
            await page.keyboard.up('Control');
            await page.keyboard.press('Backspace');
            await new Promise(r => setTimeout(r, 80));
            // Paste
            await page.keyboard.down('Control');
            await page.keyboard.press('v');
            await page.keyboard.up('Control');
            totpFilled = true;
            console.log(`[TOTP] âœ… Code ${code} pasted via Ctrl+V`);
            break;
          } catch (e) {
            console.log(`[TOTP] Frame error: ${e.message?.substring(0, 60)}`);
          }
        }
        if (!totpFilled) {
          // Fallback: CDP keyboard events don't reach cross-origin iframe inputs.
          // Strategy: Claude Vision finds the exact TOTP input box pixel coords,
          // then CDP click focuses it, then clipboard Ctrl+V pastes the code.
          // Uses Anthropic API (anthropicApiKey) â€" avoids GPT-4o content policy refusals
          // on Binance security screenshots.
          console.log('[TOTP] Using Claude Vision to locate TOTP input box...');
          let totpInputVpX = null, totpInputVpY = null;

          try {
            if (!anthropicApiKey) throw new Error('No Anthropic API key for TOTP vision');

            const ss = await page.screenshot({ type: 'png' });
            const ssW = ss.readUInt32BE(16);
            const ssH = ss.readUInt32BE(20);
            const vp  = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
            const dpr = ssW / vp.w;

            // Save debug screenshot
            try { fs.writeFileSync(path.join(app.getPath('desktop'), 'totp_debug_screenshot.png'), ss); } catch (_) {}

            // Find the "Authenticator App Verification" heading in the main DOM for a y-anchor
            const headingAnchor = await page.evaluate(() => {
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              while (walker.nextNode()) {
                const t = (walker.currentNode.textContent || '').trim();
                if (t.includes('Authenticator App Verification') || t.includes('Google Authenticator')) {
                  const el = walker.currentNode.parentElement;
                  const r = el?.getBoundingClientRect();
                  if (r && r.width > 0) return { y: Math.round(r.bottom), cx: Math.round(r.left + r.width / 2) };
                }
              }
              return null;
            }).catch(() => null);

            const anchorHint = headingAnchor
              ? `The "Authenticator App Verification" dialog heading ends at pixel y=${Math.round(headingAnchor.y * dpr)} (x center â‰ˆ ${Math.round(headingAnchor.cx * dpr)}) in the image. The 6-digit TOTP input field is located approximately 40-80px BELOW this y coordinate, centered horizontally in the dialog.\n`
              : `The "Authenticator App Verification" dialog is floating near the center of the screen. The 6-digit TOTP input field is inside this dialog, below the title text.\n`;

            const res = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': anthropicApiKey,
                'anthropic-version': '2023-06-01',
              },
              body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 80,
                messages: [{
                  role: 'user',
                  content: [
                    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ss.toString('base64') } },
                    { type: 'text', text:
                      `This is a ${ssW}Ã—${ssH} pixel screenshot of a Binance P2P trading platform security verification dialog.\n` +
                      anchorHint +
                      `The dialog is titled "Authenticator App Verification" and asks the user to enter the 6-digit code shown in their Google Authenticator app.\n` +
                      `The input area is a text field (either one wide input box, or 6 individual single-digit boxes side by side) where the user types the 6-digit TOTP code.\n` +
                      `It is positioned BELOW the dialog title and ABOVE the Submit/Confirm button.\n` +
                      `The input is currently empty (no digits yet) and has a visible border or underline.\n` +
                      `Identify the center pixel of this input field (or the center of the leftmost digit box if there are 6 separate boxes).\n` +
                      `Return ONLY a JSON object with the absolute pixel coordinates â€" no explanation, no markdown:\n{"x": 640, "y": 290}` },
                  ],
                }],
              }),
            });

            const data = await res.json();
            if (data.error) throw new Error(`Anthropic: ${data.error.message || JSON.stringify(data.error)}`);
            const txt = ((data.content?.[0]?.text) || '').trim();
            console.log(`[TOTP] Claude Vision: ${txt.substring(0, 100)}`);

            const m = txt.match(/\{[^}]+\}/);
            if (!m) throw new Error('No JSON in response');
            const coords = JSON.parse(m[0]);
            if (!coords.x || !coords.y) throw new Error('Missing x/y');

            totpInputVpX = Math.round(coords.x / dpr);
            totpInputVpY = Math.round(coords.y / dpr);
            console.log(`[TOTP] Vision → image(${coords.x},${coords.y}) → viewport(${totpInputVpX},${totpInputVpY})`);
          } catch (vErr) {
            console.log(`[TOTP] Vision failed: ${vErr.message} â€" using center fallback`);
          }

          // If vision failed, use a safe center-screen fallback
          if (!totpInputVpX) {
            const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
            totpInputVpX = Math.round(vp.w / 2);
            totpInputVpY = Math.round(vp.h * 0.42); // ~42% down = below title, above submit
            console.log(`[TOTP] Using fallback coords (${totpInputVpX}, ${totpInputVpY})`);
          }

          // CDP click to focus the input (isTrusted:true), then clipboard paste
          console.log(`[TOTP] CDP click at (${totpInputVpX}, ${totpInputVpY}) to focus input`);
          await page.mouse.move(totpInputVpX, totpInputVpY);
          await new Promise(r => setTimeout(r, 80));
          await page.mouse.click(totpInputVpX, totpInputVpY);
          await new Promise(r => setTimeout(r, 300));

          // Try clipboard paste (Ctrl+V) first â€" works if input is in main frame
          clipboard.writeText(code);
          await page.keyboard.down('Control');
          await page.keyboard.press('v');
          await page.keyboard.up('Control');
          await new Promise(r => setTimeout(r, 400));

          // Check if paste landed in main frame
          const pasteWorked = await page.evaluate((c) =>
            Array.from(document.querySelectorAll('input')).some(i => i.value.length >= 3)
          , code).catch(() => false);

          if (pasteWorked) {
            console.log('[TOTP] âœ… Ctrl+V paste confirmed in main frame input');
          } else {
            // Cross-origin iframe â€" Ctrl+V didn't reach. Fall back to OS keybd_event.
            console.log('[TOTP] Ctrl+V did not land (cross-origin) â€" using OS keyboard fallback');
            const psTypeScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
public class OsType {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, int flags, int extra);
  public static void TypeDigits(string digits) {
    Thread.Sleep(300);
    foreach (char c in digits) {
      byte vk = (byte)(0x30 + (c - '0'));
      keybd_event(vk, 0, 0, 0);
      Thread.Sleep(50);
      keybd_event(vk, 0, 2, 0);
      Thread.Sleep(50);
    }
  }
}
"@
[OsType]::TypeDigits("${code}")
Write-Host "done"`;
            const psTmpFile = require('path').join(require('os').tmpdir(), 'sp2p_ostype.ps1');
            require('fs').writeFileSync(psTmpFile, psTypeScript, 'utf8');
            await new Promise(resolve => {
              require('child_process').exec(
                `powershell -NoProfile -ExecutionPolicy Bypass -File "${psTmpFile}"`,
                { timeout: 6000 },
                (err, stdout) => {
                  console.log(`[TOTP] OS type: ${(stdout || '').trim()}`);
                  resolve();
                }
              );
            });
            await new Promise(r => setTimeout(r, 400));
          }

          console.log('[TOTP] âœ… Code entry complete â€" proceeding to Submit');
          totpFilled = true;
        }
        await new Promise(r => setTimeout(r, 600));

        // Step 2: Click Submit button â€" search all frames, all button-like elements
        let totpSubmitted = false;
        const submitFrames = [page.mainFrame(), ...page.frames()];
        for (const frame of submitFrames) {
          try {
            totpSubmitted = await frame.evaluate(() => {
              const keywords = ['submit', 'confirm', 'verify', 'next'];
              // Walk text nodes â€" catches any language variant
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              while (walker.nextNode()) {
                const t = (walker.currentNode.textContent || '').trim().toLowerCase();
                if (!keywords.some(k => t === k || t.startsWith(k))) continue;
                const el = walker.currentNode.parentElement;
                const r = el?.getBoundingClientRect();
                if (r && r.width > 0 && r.height > 0) { el.click(); return true; }
              }
              // Also try querySelectorAll on common button selectors
              const buttons = Array.from(document.querySelectorAll('button, [role="button"], [type="submit"], a[class*="btn"]'));
              for (const btn of buttons) {
                const t = (btn.textContent || '').trim().toLowerCase();
                const r = btn.getBoundingClientRect();
                if (keywords.some(k => t === k || t.startsWith(k)) && r.width > 0) {
                  btn.click(); return true;
                }
              }
              return false;
            }).catch(() => false);
            if (totpSubmitted) break;
          } catch (_) {}
        }

        if (totpSubmitted) {
          console.log('[TOTP] âœ… Submit clicked via DOM');
        } else {
          console.log('[TOTP] DOM submit failed â€" pressing Enter');
          await page.keyboard.press('Enter');
        }
        await new Promise(r => setTimeout(r, 2500));
        // Mark Auth App as done â€" next security_verification iteration targets Email
        svAuthDoneOrders.add(orderNumber);
        console.log(`[TOTP] âœ… Auth App step complete â€" order ${orderNumber} marked, next SV will target Email`);
        continue;
      }

      // â"€â"€ Email OTP â€" DOM send + Gmail extract + DOM fill â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
      if (screen === 'email_otp_input') {
        // Step 1: Click "Send Code" / "Get Code" via DOM text-node walker
        const sendClicked = await page.evaluate(() => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const t = (walker.currentNode.textContent || '').trim().toLowerCase();
            if (t.includes('send code') || t.includes('get code') || t === 'send') {
              const el = walker.currentNode.parentElement;
              if (el && el.getBoundingClientRect().width > 0) { el.click(); return true; }
            }
          }
          return false;
        }).catch(() => false);
        console.log(`[Email OTP] Send Code clicked: ${sendClicked}`);
        await new Promise(r => setTimeout(r, 4000)); // wait for email to arrive

        // Step 2: Read OTP from Gmail
        console.log('[Email OTP] Reading OTP from Gmail...');
        const emailCode = await readEmailOTPWithVision(page);
        if (!emailCode) {
          console.error('[Email OTP] OTP not found in Gmail');
          return { success: false, error: 'Email OTP not found' };
        }
        console.log(`[Email OTP] Got OTP: ${emailCode} â€" filling into Binance`);
        await page.bringToFront();
        await new Promise(r => setTimeout(r, 1000));

        // Step 3: Find input across ALL frames (may be in cross-origin iframe like risk.binance.com)
        let emailFilled = false;
        const emailFrames = [page.mainFrame(), ...page.frames()];
        for (const frame of emailFrames) {
          try {
            const coords = await frame.evaluate(() => {
              const input = document.querySelector('input[maxlength="6"], input[maxlength="8"], input[type="tel"], input[type="number"]');
              if (!input) return null;
              const r = input.getBoundingClientRect();
              if (r.width === 0) return null;
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }).catch(() => null);
            if (!coords) continue;

            // Get iframe offset if sub-frame
            let absX = coords.x, absY = coords.y;
            if (frame !== page.mainFrame()) {
              const offset = await frame.parentFrame()?.evaluate(() => {
                for (const el of document.querySelectorAll('iframe')) {
                  const r = el.getBoundingClientRect();
                  if (r.width > 0 && r.height > 0) return { x: r.left, y: r.top };
                }
                return { x: 0, y: 0 };
              }).catch(() => ({ x: 0, y: 0 }));
              absX += (offset?.x || 0);
              absY += (offset?.y || 0);
            }

            console.log(`[Email OTP] Input at frame(${frame.url().substring(0,50)}) abs(${Math.round(absX)},${Math.round(absY)})`);
            // Copy code to clipboard then Ctrl+V â€" simplest and most reliable
            clipboard.writeText(emailCode);
            await page.mouse.click(absX, absY); // CDP click â€" isTrusted:true, focuses input
            await new Promise(r => setTimeout(r, 200));
            await page.keyboard.down('Control');
            await page.keyboard.press('v');
            await page.keyboard.up('Control');
            emailFilled = true;
            console.log(`[Email OTP] âœ… Pasted ${emailCode} via Ctrl+V`);
            break;
          } catch (e) {
            console.log(`[Email OTP] Frame error: ${e.message?.substring(0, 60)}`);
          }
        }
        if (!emailFilled) {
          // Cross-origin iframe â€" use Claude Vision to find input coords, then OS keyboard
          console.log('[Email OTP] Frame search failed â€" using Claude Vision to locate input...');
          let emailInputVpX = null, emailInputVpY = null;

          try {
            if (!anthropicApiKey) throw new Error('No Anthropic API key');
            const ss = await page.screenshot({ type: 'png' });
            const ssW = ss.readUInt32BE(16);
            const ssH = ss.readUInt32BE(20);
            const vp  = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
            const dpr = ssW / vp.w;

            const headingAnchor = await page.evaluate(() => {
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              while (walker.nextNode()) {
                const t = (walker.currentNode.textContent || '').trim();
                if (t.includes('Email Verification')) {
                  const el = walker.currentNode.parentElement;
                  const r = el?.getBoundingClientRect();
                  if (r && r.width > 0) return { y: Math.round(r.bottom), cx: Math.round(r.left + r.width / 2) };
                }
              }
              return null;
            }).catch(() => null);

            const anchorHint = headingAnchor
              ? `The "Email Verification" dialog heading ends at pixel y=${Math.round(headingAnchor.y * dpr)} in the image. The 6-digit code input is approximately 60-100px BELOW this y, centered horizontally.\n`
              : `The "Email Verification" dialog is floating near the center of the screen.\n`;

            const res = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
              body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 80,
                messages: [{ role: 'user', content: [
                  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ss.toString('base64') } },
                  { type: 'text', text:
                    `This is a ${ssW}Ã—${ssH} pixel screenshot of a Binance P2P "Email Verification" dialog.\n` +
                    anchorHint +
                    `There is a text input box for the 6-digit email verification code, next to a "Resend Code" button.\n` +
                    `Find the center pixel of that input box. Return ONLY JSON â€" no explanation:\n{"x": 480, "y": 290}` },
                ]}],
              }),
            });
            const data = await res.json();
            const txt = ((data.content?.[0]?.text) || '').trim();
            console.log(`[Email OTP] Claude Vision: ${txt.substring(0, 80)}`);
            const m = txt.match(/\{[^}]+\}/);
            if (m) {
              const coords = JSON.parse(m[0]);
              if (coords.x && coords.y) {
                emailInputVpX = Math.round(coords.x / dpr);
                emailInputVpY = Math.round(coords.y / dpr);
                console.log(`[Email OTP] Vision → viewport(${emailInputVpX},${emailInputVpY})`);
              }
            }
          } catch (vErr) {
            console.log(`[Email OTP] Vision failed: ${vErr.message?.substring(0, 60)}`);
          }

          if (!emailInputVpX) {
            const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
            emailInputVpX = Math.round(vp.w / 2 - 60);
            emailInputVpY = Math.round(vp.h * 0.42);
            console.log(`[Email OTP] Using fallback coords (${emailInputVpX},${emailInputVpY})`);
          }

          // CDP click to focus input
          await page.mouse.move(emailInputVpX, emailInputVpY);
          await new Promise(r => setTimeout(r, 80));
          await page.mouse.click(emailInputVpX, emailInputVpY);
          await new Promise(r => setTimeout(r, 300));

          // Try Ctrl+V first
          clipboard.writeText(emailCode);
          await page.keyboard.down('Control');
          await page.keyboard.press('v');
          await page.keyboard.up('Control');
          await new Promise(r => setTimeout(r, 400));

          const pasteWorked = await page.evaluate((c) =>
            Array.from(document.querySelectorAll('input')).some(i => i.value.length >= 3)
          , emailCode).catch(() => false);

          if (pasteWorked) {
            console.log('[Email OTP] âœ… Ctrl+V paste confirmed');
          } else {
            // Cross-origin iframe â€" fall back to OS keybd_event (same as TOTP)
            console.log('[Email OTP] Ctrl+V did not land â€" using OS keyboard fallback');
            const psTypeScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
public class OsTypeEmail {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, int flags, int extra);
  public static void TypeDigits(string digits) {
    Thread.Sleep(300);
    foreach (char c in digits) {
      byte vk = (byte)(0x30 + (c - '0'));
      keybd_event(vk, 0, 0, 0);
      Thread.Sleep(50);
      keybd_event(vk, 0, 2, 0);
      Thread.Sleep(50);
    }
  }
}
"@
[OsTypeEmail]::TypeDigits("${emailCode}")
Write-Host "done"`;
            const psTmpFile = require('path').join(require('os').tmpdir(), 'sp2p_email_ostype.ps1');
            require('fs').writeFileSync(psTmpFile, psTypeScript, 'utf8');
            await new Promise(resolve => {
              require('child_process').exec(
                `powershell -NoProfile -ExecutionPolicy Bypass -File "${psTmpFile}"`,
                { timeout: 6000 },
                (err, stdout) => {
                  console.log(`[Email OTP] OS type: ${(stdout || '').trim()}`);
                  resolve();
                }
              );
            });
          }
          emailFilled = true;
        }
        await new Promise(r => setTimeout(r, 400));

        // Step 4: Click Submit â€" search all frames
        let emailSubmitted = false;
        for (const frame of emailFrames) {
          try {
            emailSubmitted = await frame.evaluate(() => {
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              while (walker.nextNode()) {
                const t = (walker.currentNode.textContent || '').trim().toLowerCase();
                if (t === 'submit' || t === 'confirm' || t === 'verify') {
                  const el = walker.currentNode.parentElement;
                  if (el && el.getBoundingClientRect().width > 0) { el.click(); return true; }
                }
              }
              return false;
            }).catch(() => false);
            if (emailSubmitted) break;
          } catch (_) {}
        }

        if (emailSubmitted) {
          console.log('[Email OTP] âœ… Submit clicked via DOM');
        } else {
          // DOM submit failed (cross-origin iframe) â€" use Claude Vision to click Submit button
          console.log('[Email OTP] DOM submit failed â€" using Claude Vision to click Submit...');
          try {
            const ss2 = await page.screenshot({ type: 'png' });
            const ssW2 = ss2.readUInt32BE(16);
            const ssH2 = ss2.readUInt32BE(20);
            const vp2  = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
            const dpr2 = ssW2 / vp2.w;
            const res2 = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
              body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 80,
                messages: [{ role: 'user', content: [
                  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ss2.toString('base64') } },
                  { type: 'text', text:
                    `This is a ${ssW2}Ã—${ssH2}px screenshot of a Binance "Email Verification" dialog.\n` +
                    `There is a yellow/gold "Submit" button below the code input field.\n` +
                    `Find the center pixel of the Submit button. Return ONLY JSON:\n{"x": 480, "y": 340}` },
                ]}],
              }),
            });
            const d2 = await res2.json();
            const t2 = ((d2.content?.[0]?.text) || '').trim();
            const m2 = t2.match(/\{[^}]+\}/);
            if (m2) {
              const c2 = JSON.parse(m2[0]);
              if (c2.x && c2.y) {
                const vpX2 = Math.round(c2.x / dpr2);
                const vpY2 = Math.round(c2.y / dpr2);
                console.log(`[Email OTP] Vision Submit at viewport(${vpX2},${vpY2})`);
                await page.mouse.move(vpX2, vpY2);
                await new Promise(r => setTimeout(r, 80));
                await page.mouse.click(vpX2, vpY2);
                emailSubmitted = true;
              }
            }
          } catch (e2) {
            console.log(`[Email OTP] Vision submit failed: ${e2.message?.substring(0, 60)}`);
          }
          if (!emailSubmitted) {
            console.log('[Email OTP] Pressing Enter as last resort');
            await page.keyboard.press('Enter');
          }
        }
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // â"€â"€ Unknown â€" wait and retry before reloading â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
      consecutiveUnknown++;
      const unknownUrl = page.url();
      console.log(`[Vision] Unknown screen at step ${step} (${consecutiveUnknown} in a row) â€" URL: ${unknownUrl}`);

      if (!unknownUrl.includes('fiatOrderDetail')) {
        // We are not on the order detail page â€" navigate back immediately
        console.log(`[Vision] Not on order detail page â€" navigating back to order ${orderNumber}`);
        await page.goto('https://p2p.binance.com/en/fiatOrder?tab=0&page=1',
          { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 2500));
        await clickOrderWithMouse(page, orderNumber);
        await new Promise(r => setTimeout(r, 4000));
        consecutiveUnknown = 0;
        continue;
      }

      // On the right page but Vision confused â€" wait longer before reloading
      if (consecutiveUnknown < 3) {
        // First 2 unknowns: just wait and retry Vision (page may be mid-load)
        console.log(`[Vision] Waiting 5s and retrying Vision (attempt ${consecutiveUnknown}/3 before reload)...`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      // 3+ consecutive unknowns â€" reload the page
      console.log(`[Vision] 3 consecutive unknowns â€" reloading page...`);
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// ACTION EXECUTION â€" Full automation with PIN + screenshots
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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
      // Vision-driven release â€" Claude reads every screenshot and decides the next action
      const result = await releaseWithVision(page, order_number, action);
      if (result.success) stats.actions++;
      await takeScreenshot(`After release: order ${order_number}`);

    } else if (type === 'pay' || type === 'mark_as_paid') {
      // â"€â"€ Full buy-side payment automation â"€â"€
      // 1. Extract payment details from Binance order page using Vision
      // 2. Send money via I&M Bank
      // 3. Upload receipt + notify seller on Binance
      // 4. Start monitoring for seller release

      // Step 1: Extract payment details — DOM first, Vision only if DOM misses phone/amount
      await dismissBinanceModals(page); // dismiss "Payment Completed?" or similar popups first
      console.log(`[SparkP2P] Extracting payment details from order ${order_number}...`);
      await new Promise(r => setTimeout(r, 2000));
      let paymentDetails = action.payment_details || null;

      // L1: DOM extraction — exact text, no OCR digit misreads
      if (!paymentDetails) {
        try {
          const domResult = await page.evaluate(() => {
            const getText = (labelRegex) => {
              const els = Array.from(document.querySelectorAll('div, span, td, p'));
              for (const el of els) {
                if (el.childElementCount > 0) continue;
                const t = (el.textContent || '').trim();
                if (!labelRegex.test(t)) continue;
                const parent = el.parentElement;
                const nextSib = el.nextElementSibling || (parent && parent.nextElementSibling);
                if (nextSib) { const val = (nextSib.textContent || '').trim(); if (val && val !== t) return val; }
                if (parent && parent.children.length >= 2) { const val = (parent.children[1].textContent || '').trim(); if (val && val !== t) return val; }
              }
              return null;
            };
            const bodyText = document.body.innerText || '';
            const phone = getText(/^phone number$/i) || (bodyText.match(/\b(07\d{8}|254\d{9}|\+254\d{9})\b/) || [])[1] || null;
            const name = getText(/^name$/i) || (() => {
              const m = bodyText.match(/(?:^|\n)[ \t]*Name[ \t]*\r?\n[ \t]*([A-Za-z][A-Za-z .'-]{2,60})[ \t]*(?:\r?\n|$)/m);
              return m ? m[1].trim() : null;
            })();
            const via = getText(/^transfer via$/i) || '';
            const ref = getText(/^reference message$/i);
            const amtEl = bodyText.match(/KSh\s*([\d,]+\.?\d*)/);
            const amount = amtEl ? parseFloat(amtEl[1].replace(/,/g, '')) : null;
            if (!phone || !amount) return null;
            const method = /i\s*&\s*m/i.test(via) ? 'im_bank' : /mpesa|safaricom|m-pesa/i.test(via) ? 'mpesa' : 'mpesa';
            const network = /airtel/i.test(via) ? 'airtel' : 'safaricom';
            return { method, phone, name: name || '', amount, reference: ref || null, network };
          }).catch(() => null);
          if (domResult) {
            if (!domResult.reference) domResult.reference = order_number;
            paymentDetails = domResult;
            console.log(`[SparkP2P] L1 DOM extracted phone: ${paymentDetails.phone}, amount: ${paymentDetails.amount}`);
          }
        } catch (_) {}
      }

      // L2: Vision fallback — only if DOM missed phone or amount
      const ss = (!paymentDetails || !paymentDetails.phone || !paymentDetails.amount) ? await page.screenshot({ encoding: 'base64' }).catch(() => null) : null;
      const domPhoneForVision = paymentDetails?.phone || null;

      if (!paymentDetails && ss && anthropicApiKey) {
        const extractRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 300,
            messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ss } },
              { type: 'text', text: `Extract the payment details from this Binance P2P buy order page.
Return JSON only (no other text):
{
  "method": "mpesa | im_bank | other_bank",
  "phone": "07XXXXXXXX or 254XXXXXXXXX â€" phone number if M-Pesa, else null",
  "account_number": "bank account number if paying to a bank account, else null",
  "bank_name": "bank name e.g. 'I & M Bank', 'Equity Bank', 'KCB' â€" if bank transfer, else null",
  "name": "seller full name",
  "amount": 1234,
  "network": "safaricom | airtel | null",
  "reference": "order number"
}

Method selection rules:
- "mpesa" → payment method is M-PESA / Safaricom (phone number shown)
- "im_bank" → payment method is I&M Bank AND an ACCOUNT NUMBER is shown
- "other_bank" → payment method is any other bank (Equity, KCB, Co-op, Absa, etc.) with an account number` },
            ]}],
          }),
        }).catch(() => null);

        if (extractRes?.ok) {
          const extractData = await extractRes.json();
          const jsonMatch = (extractData.content?.[0]?.text || '').match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try {
              const visionData = JSON.parse(jsonMatch[0]);
              // Always prefer DOM phone over Vision phone — DOM is exact, Vision can misread digits
              if (domPhoneForVision) visionData.phone = domPhoneForVision;
              paymentDetails = visionData;
            } catch (_) {}
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

      // â"€â"€ Validate payment details before attempting â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
      const _pm = (paymentDetails.method || 'mpesa').toLowerCase();
      const isBankTransfer = _pm === 'im_bank' || _pm === 'other_bank';
      const missingPhone = !isBankTransfer && (!paymentDetails.phone || paymentDetails.phone.trim() === '');
      const missingAccount = isBankTransfer && (!paymentDetails.account_number || !paymentDetails.bank_name);
      const missingAmount = !paymentDetails.amount || paymentDetails.amount <= 0;
      if (missingPhone || missingAccount || missingAmount) {
        const reason = missingPhone ? 'phone number is missing' : missingAccount ? 'bank account number or bank name is missing' : 'amount is zero/missing';
        console.error(`[SparkP2P] âŒ Buy order ${order_number} â€" payment details incomplete (${reason}), will retry next cycle`);
        await takeScreenshot(`Pay details incomplete â€" ${reason}: ${order_number}`);
        return; // retry next cycle â€" do NOT pause ad or send email
      }

      // â"€â"€ Step 1b: Send greeting once per order â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
      const MPESA_MAX = 250_000;
      const isSplitNeeded = !isBankTransfer && Math.floor(paymentDetails.amount) > MPESA_MAX;

      if (!buyGreetingSentOrders.has(order_number)) {
        buyGreetingSentOrders.add(order_number); _saveOrderFlag(order_number, 'greetingSent', true);
        const method = (paymentDetails.method || 'mpesa').toLowerCase();
        let greetMsg = '';
        const firstName = paymentDetails.name.split(' ')[0];
        const amt = Math.floor(parseFloat(paymentDetails.amount));
        if (method === 'mpesa') {
          if (isSplitNeeded) {
            const splitPart1 = MPESA_MAX;
            const splitPart2 = amt - MPESA_MAX;
            greetMsg = `Hello ${firstName}, I will be sending you KES ${amt.toLocaleString()} to your M-Pesa number ${paymentDetails.phone} in two transactions. M-Pesa allows a maximum of KES 250,000 per transaction, so you will first receive KES ${splitPart1.toLocaleString()} followed by KES ${splitPart2.toLocaleString()}. Please be ready to receive both. Thank you! 🙏`;
          } else {
            greetMsg = `Hello ${firstName}, I will be sending KES ${amt} to your M-Pesa number ${paymentDetails.phone} shortly. Please be ready to receive. Thank you! 🙏`;
          }
        } else if (method === 'im_bank' || method === 'other_bank') {
          greetMsg = `Hello ${firstName}, I will be sending KES ${amt} directly to your ${paymentDetails.bank_name || 'bank'} account (${paymentDetails.account_number || ''}) shortly. Thank you! 🙏`;
        }
        if (greetMsg) {
          await sendBinanceChatMessage(page, greetMsg);
          console.log(`[SparkP2P] ðŸ'‹ Greeting sent for buy order ${order_number} (method: ${method})`);
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      // Choice Bank payment (replaced I&M Bank) — Step 2
      const payMethod = (paymentDetails.method || "mpesa").toLowerCase();
      let imResult = { success: false, screenshot: null, referenceId: null };
      let imNameMismatchAborted = false;

      if (imPaymentDoneMap[order_number]) {
        console.log("[SparkP2P] Choice Bank payment already done for " + order_number + " - skipping");
        imResult = { success: true, ...imPaymentDoneMap[order_number] };
      } else if (imPaymentFailedOrders.has(order_number)) {
        console.log("[SparkP2P] Choice Bank payment previously failed for " + order_number + " - skipping");
        await fetch(API_BASE + "/ext/report-buy-expired", {
          method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
          body: JSON.stringify({ order_number, seller_name: paymentDetails.name, amount: paymentDetails.amount, minutes_waited: 0, reason: "Choice Bank payment previously failed. Please complete manually." })
        }).catch(function(){});
        return;
      } else {
        let verifiedName = "";

        if (!imNameMismatchAborted) {
          // ── Step 1: Request Telegram approval before touching Choice Bank ──
          let choiceBal2 = 0;
          try {
            const balRes2 = await fetch(`${API_BASE}/choice/balance/${traderChoiceAccountId}`, { headers: { 'Authorization': 'Bearer ' + token } }).catch(() => null);
            if (balRes2 && balRes2.ok) { const bd2 = await balRes2.json(); choiceBal2 = bd2.balance || 0; }
          } catch(_e2) {}

          let buyApproved2 = false;
          if (!buyApprovalRequestedOrders.has(order_number)) {
            const approvalRes2 = await fetch(API_BASE + '/telegram/request-buy-approval', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
              body: JSON.stringify({
                order_number,
                seller_name: verifiedName || paymentDetails.name,
                amount: paymentDetails.amount,
                method: payMethod,
                phone: paymentDetails.phone || '',
                account_number: paymentDetails.account_number || '',
                bank_name: paymentDetails.bank_name || '',
                choice_balance: choiceBal2,
              }),
            }).catch(() => null);
            const approvalData2 = approvalRes2?.ok ? await approvalRes2.json().catch(() => ({})) : {};
            if (approvalData2.auto_approved) {
              buyApproved2 = true;
              console.log(`[SparkP2P] Buy ${order_number} — Telegram not linked, auto-approving payment`);
            } else {
              buyApprovalRequestedOrders.add(order_number); _saveOrderFlag(order_number, 'approvalRequested', true);
              sendBotLog('info', `Buy order ${order_number} — waiting for Telegram payment approval`);
              return; // come back next poll cycle
            }
          } else {
            const statusRes2 = await fetch(
              `${API_BASE}/telegram/approval-status?order_number=${encodeURIComponent(order_number)}`,
              { headers: { 'Authorization': 'Bearer ' + token } }
            ).catch(() => null);
            const statusData2 = statusRes2?.ok ? await statusRes2.json().catch(() => ({})) : {};
            const approvalStatus2 = statusData2.status || 'pending';
            console.log(`[SparkP2P] Buy ${order_number} — Telegram approval status: ${approvalStatus2}`);
            if (approvalStatus2 === 'approved') {
              buyApproved2 = true;
              sendBotLog('success', `Buy order ${order_number} — approved, executing payment`);
            } else if (approvalStatus2 === 'rejected') {
              imPaymentFailedOrders.add(order_number); _saveOrderFlag(order_number, 'paymentFailed', true);
              sendBotLog('warning', `Buy order ${order_number} — payment declined on Telegram. Sending excuse to seller.`);
              if (!buyDeclineMsgSent.has(order_number)) {
                buyDeclineMsgSent.add(order_number);
                const buyDeclineMsg2 = `Hello, and thank you for your listing. I sincerely apologize, but I am currently experiencing a temporary technical issue with my payment system and I am unable to complete this payment at this time. I kindly request that you cancel this order on your end so you can continue trading without any delay. I am truly sorry for the inconvenience and I genuinely appreciate your patience and understanding.`;
                await sendBinanceChatMessage(page, buyDeclineMsg2).catch(() => {});
              }
              return;
            } else if (approvalStatus2 === 'timeout') {
              imPaymentFailedOrders.add(order_number); _saveOrderFlag(order_number, 'paymentFailed', true);
              sendBotLog('warning', `Buy order ${order_number} — Telegram approval timed out. Order will expire.`);
              return;
            } else {
              return; // still pending — retry next cycle
            }
          }
          if (!buyApproved2) return;

          // ── Step 2: Execute the Choice Bank payment ──
          try {
            imResult = await executeChoicePayment({
              phone: paymentDetails.phone, accountNumber: paymentDetails.account_number,
              bankCode: paymentDetails.bank_code||"", name: verifiedName||paymentDetails.name,
              amount: paymentDetails.amount, orderNumber: order_number, method: payMethod,
            });
            if (imResult.success) {
              imPaymentDoneMap[order_number] = { referenceId: imResult.referenceId||"" };
              savePaidOrder(order_number, { referenceId: imResult.referenceId||"" });
            }
          } catch(e) {
            console.error("[SparkP2P] Choice Bank payment failed for " + order_number + ": " + e.message);
            imPaymentFailedOrders.add(order_number); _saveOrderFlag(order_number, 'paymentFailed', true);
            await fetch(API_BASE + "/ext/report-buy-expired", {
              method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
              body: JSON.stringify({ order_number, seller_name: paymentDetails.name, amount: paymentDetails.amount,
                minutes_waited: 0, reason: "Choice Bank payment failed: " + e.message + ". Please complete manually." })
            }).catch(function(){});
          }
        }
      }
      // Payment failed / insufficient balance — do NOT tell the seller anything or click Transferred.
      if (!imResult.success) {
        console.log(`[SparkP2P] ⛔ Buy ${order_number} NOT paid (success=false) — skipping seller message & Transferred`);
        return;
      }

      buyOrderDetailsMap[order_number] = {
        sellerName: paymentDetails.name,
        amount: paymentDetails.amount,
        phone: paymentDetails.phone,
        method: paymentDetails.method || 'M-Pesa',
        orderNumber: order_number,
        referenceId: imResult.referenceId || null,
      };
      buyPaymentScreenshot = imResult.screenshot;
      buyPaymentSentAt[order_number] = Date.now();
      buyReminderSentOrders.delete(order_number);

      // Step 3: Switch back to Binance order page
      await page.bringToFront();
      await page.goto(`https://p2p.binance.com/en/fiatOrderDetail?orderNo=${order_number}`, {
        waitUntil: 'domcontentloaded', timeout: 15000,
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 3000));
      await dismissBinanceModals(page);

      // Step 4: Send post-payment chat message (once only â€" guard against retries)
      if (!buyPostPaymentMsgSentOrders.has(order_number)) {
        buyPostPaymentMsgSentOrders.add(order_number); _saveOrderFlag(order_number, 'postPaymentMsgSent', true);
        const payTime = new Date().toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
        const refPart = imResult.referenceId ? ` M-Pesa Ref: ${imResult.referenceId}.` : '';
        const chatMsg = `Hello ${paymentDetails.name.split(' ')[0]}, I have sent KSh ${paymentDetails.amount.toLocaleString()} to your ${paymentDetails.method === 'mpesa' ? 'M-Pesa' : 'account'} (${paymentDetails.phone || paymentDetails.account_number || ''}) at ${payTime}.${refPart} Please check and release the crypto. Thank you! 🙏`;
        await sendBinanceChatMessage(page, chatMsg);
      }

      // Step 5: Check if already in "Pending the Seller to Release" state (order already marked as paid)
      const alreadyPendingRelease = await page.evaluate(() => {
        const body = document.body.innerText || '';
        return body.toLowerCase().includes('pending the seller to release') ||
               body.toLowerCase().includes('waiting for seller to release') ||
               body.toLowerCase().includes('seller to release');
      }).catch(() => false);

      if (alreadyPendingRelease) {
        console.log(`[SparkP2P] âœ… Order ${order_number} already in "Pending Seller Release" state â€" skipping upload & Transferred button`);
      }

      // Step 5b: Upload payment proof (I&M receipt screenshot) + handle confirmation
      let proofConfirmed = alreadyPendingRelease; // if already pending release, treat as confirmed
      if (!alreadyPendingRelease && imResult.screenshot) {
        await new Promise(r => setTimeout(r, 1500));
        const uploadResult = await uploadPaymentProofToBinance(page, imResult.screenshot);
        proofConfirmed = uploadResult.confirmed;
      }

      // Step 6: If upload didn't complete the confirmation, click "Transferred, notify seller"
      // This handles the case where there was no screenshot or the upload failed
      if (!proofConfirmed) {
        const NOTIFY_MAX_RETRIES = 3;
        let notifyClicked = false;
        for (let attempt = 1; attempt <= NOTIFY_MAX_RETRIES; attempt++) {
          await dismissBinanceModals(page);
          await new Promise(r => setTimeout(r, 2000));
          // Re-check if page transitioned to "Pending Release" during retries
          const nowPending = await page.evaluate(() =>
            (document.body.innerText || '').toLowerCase().includes('pending the seller to release') ||
            (document.body.innerText || '').toLowerCase().includes('seller to release')
          ).catch(() => false);
          if (nowPending) {
            console.log(`[SparkP2P] âœ… Page moved to "Pending Release" â€" no need to click Transferred`);
            notifyClicked = true; break;
          }
          const clicked = await clickButton(page, 'transferred', 'notify seller', 'transferred, notify seller', 'payment done', 'i have paid');
          if (clicked) {
            notifyClicked = true;
            console.log(`[SparkP2P] âœ… "Transferred, notify seller" clicked on attempt ${attempt}`);
            await new Promise(r => setTimeout(r, 2500));
            await page.evaluate(() => {
              const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
              checkboxes.forEach(cb => { if (!cb.checked) cb.click(); });
            }).catch(() => {});
            await new Promise(r => setTimeout(r, 800));
            await clickButton(page, 'confirm', 'yes');
            await new Promise(r => setTimeout(r, 2000));
            await handleSecurityVerification(page);
            break;
          }
          console.log(`[SparkP2P] "Transferred" button not found on attempt ${attempt}/${NOTIFY_MAX_RETRIES}${attempt < NOTIFY_MAX_RETRIES ? ' â€" reloading page...' : ''}`);
          if (attempt < NOTIFY_MAX_RETRIES) {
            await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
            await new Promise(r => setTimeout(r, 3000));
          }
        }
        if (!notifyClicked) {
          console.log(`[SparkP2P] âš ï¸ Could not confirm payment after ${NOTIFY_MAX_RETRIES} attempts â€" seller will release once they see the chat message`);
          await takeScreenshot(`Transferred btn not found: ${order_number}`);
        }
      }

      await takeScreenshot(`Buy payment complete: order ${order_number}`);

      // Inject AI chat monitor so the bot can respond to the seller's questions
      // (e.g. "where did you send the money?") while we wait for crypto release
      await injectChatMonitor(page, {
        orderNumber: order_number,
        fiatAmount:  paymentDetails.amount,
        buyerName:   paymentDetails.name,
        orderSide:   'buy',
        paymentInfo: {
          method:         paymentDetails.method || 'mpesa',
          phone:          paymentDetails.phone || null,
          account_number: paymentDetails.account_number || null,
          referenceId:    imResult.referenceId || null,
        },
      });

      await fetch(`${API_BASE}/ext/report-payment-sent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ order_number, success: true, channel: (paymentDetails.method === 'mpesa') ? 'MPESA' : 'BANK' }),
      }).catch(() => {});

      stats.actions++;
      activeBuyOrderNumber = order_number;
      console.log(`[SparkP2P] ðŸ'€ Buy order ${order_number} â€" I&M paid, idleScan will monitor for seller release`);

    } else if (type === 'send_message') {
      // If buyer already paid (verify_payment state), skip payment instruction messages
      const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
      const alreadyPaid = pageText.toLowerCase().includes('verify payment') ||
                          pageText.toLowerCase().includes('payment received') ||
                          !!await page.evaluate(() => {
                            const btns = Array.from(document.querySelectorAll('button'));
                            return btns.some(b => (b.textContent || '').trim().toLowerCase().startsWith('payment received'));
                          }).catch(() => false);
      if (alreadyPaid) {
        console.log(`[SparkP2P] â­ Skipping send_message â€" buyer already paid (verify_payment state)`);
            } else {
        // -- Counterparty screening: CF filters + DD — both enforced before payment instructions --
        const needsScreening = (cfEnabled && (cfMin30d > 0 || cfMinAll > 0)) || ddEnabled;
        if (needsScreening && action.buyer_nickname) {
          // Primary: confirmed Binance stats via backend EP-19 (signed, server-side).
          // Fallback: browser scraping if the API call fails.
          let stats = null;
          try {
            const _csRes = await fetch(`${API_BASE}/ext/counterparty-stats?order_number=${encodeURIComponent(order_number)}`,
              { headers: { 'Authorization': `Bearer ${token}` } });
            if (_csRes.ok) {
              const _cs = await _csRes.json();
              if (_cs.ok) {
                stats = _cs;
                console.log(`[SparkP2P] EP-19 stats — 30d: ${_cs.trades_30d}, all: ${_cs.trades_all}, withUs30d: ${_cs.tradesWithUs30d}`);
              }
            }
          } catch (_) {}
          if (!stats) {
            console.log('[SparkP2P] EP-19 unavailable — falling back to browser scraping');
            stats = await fetchCounterpartyStats(page, order_number, 'buyer');
          }
          // Prefer Binance's own record of prior trades; fall back to SparkP2P history if inconclusive
          const isReturning = stats.tradedBefore !== null && stats.tradedBefore !== undefined
            ? stats.tradedBefore
            : await checkReturningBuyer(action.buyer_nickname);

          if (isReturning) {
            console.log(`[SparkP2P] Screening: ${action.buyer_nickname} is returning client -- bypassing`);
          } else {
            let failReason = null;

            // CF filter checks — both 30D AND All-time must be satisfied when set
            if (cfEnabled) {
              if (cfMin30d > 0 && stats.trades_30d !== null && stats.trades_30d < cfMin30d) {
                failReason = `insufficient 30-day trades (${stats.trades_30d}/${cfMin30d} required)`;
              }
              if (!failReason && cfMinAll > 0 && stats.trades_all !== null && stats.trades_all < cfMinAll) {
                failReason = `insufficient all-time trades (${stats.trades_all}/${cfMinAll} required)`;
              }
            }

            // DD checks (independent of CF)
            if (!failReason && ddEnabled) {
              if (ddAutoCancelNew && stats.trades_all !== null && stats.trades_all < 5) {
                failReason = `brand-new account (${stats.trades_all} all-time trades, minimum 5)`;
              }
              if (!failReason && stats.trades_30d !== null && stats.trades_30d < ddMin30d) {
                failReason = `low recent activity (${stats.trades_30d} trades in 30 days, minimum ${ddMin30d})`;
              }
              if (!failReason && ddMinAll > 0 && stats.trades_all !== null && stats.trades_all < ddMinAll) {
                failReason = `low total trades (${stats.trades_all} all-time, minimum ${ddMinAll})`;
              }
            }

            if (failReason) {
              console.log(`[SparkP2P] Screening FAILED: ${action.buyer_nickname} -- ${failReason}`);
              if (botFullAuto) {
                // Strict full-auto: auto-reject with NO manual approval. Flagging the order rejected
                // makes the idleScan send the polite cancel message (sell = never self-cancel).
                sellRejectedOrders.add(order_number);
                sendBotLog('info', `Sell order ${order_number} auto-rejected (full-auto) — ${failReason}`);
                await fetch(`${API_BASE}/ext/notify-trader`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                  body: JSON.stringify({ message: `🤖 Auto-rejected sell order ${order_number} (KES ${(action.fiat_amount || 0).toLocaleString()}) — buyer failed screening: ${failReason}. A polite cancel message was sent.` }),
                }).catch(() => {});
                console.log(`[SparkP2P] FULL-AUTO auto-reject ${order_number} — ${failReason}`);
                return;
              }
              // Manual mode: route through the Telegram approval flow — merchant decides YES/NO
              if (!sellApprovalRequestedOrders.has(order_number)) {
                const cfApprovalBody = {
                  order: {
                    orderNumber: order_number,
                    totalPrice: action.fiat_amount || 0,
                    buyerNickname: action.buyer_nickname || '',
                    counterparty: action.buyer_nickname || '',
                  },
                  buyer_stats: { ...stats, tradedBefore: isReturning },
                  advisory: `⚠️ Counterparty Filter Alert\nThis buyer FAILED your screening requirements:\n${failReason}\n\nYou may still approve or reject this order.`,
                };
                await fetch(`${API_BASE}/telegram/request-approval`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                  body: JSON.stringify(cfApprovalBody),
                }).catch(() => {});
                sellApprovalRequestedOrders.add(order_number);
                console.log(`[SparkP2P] CF filter alert sent to Telegram for ${action.buyer_nickname} — awaiting merchant decision`);
              }
              return; // Do NOT send payment details yet — idleScan handles approval/rejection
            }
            console.log(`[SparkP2P] Screening passed: ${action.buyer_nickname} (30d: ${stats.trades_30d ?? 'n/a'}, all: ${stats.trades_all ?? 'n/a'})`);
          }
        }

        // Send each detail as its own chat message (intro, paybill, account no., name) so the
        // buyer can copy each value cleanly. Falls back to the single combined message.
        const outMsgs = Array.isArray(action.messages) && action.messages.length
          ? action.messages
          : [action.message || ''];
        for (let i = 0; i < outMsgs.length; i++) {
          const m = outMsgs[i];
          if (!m) continue;
          await sendChatMessage(page, m);
          console.log(`[SparkP2P] Message ${i + 1}/${outMsgs.length} sent: ${m.substring(0, 60)}`);
          if (i < outMsgs.length - 1) await new Promise(r => setTimeout(r, 1000 + Math.random() * 800));  // human-like gap
        }
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
    price: o.price && o.price > 0 ? o.price : (o.totalPrice && o.amount ? o.totalPrice / o.amount : 130),
    asset: o.asset || 'USDT',
    orderStatus: statusCode,
    buyerNickname: o.counterparty || null,
  };
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// ── Choice Bank payment — replaces I&M Bank for all BUY order payments ────────
async function executeChoicePayment({ phone, accountNumber, bankCode, name, amount, orderNumber, method }) {
  if (!traderChoiceAccountId) throw new Error('Choice Bank account not linked. Complete KYC in Bank Account tab.');
  if (!amount || Number(amount) <= 0) throw new Error('Amount invalid: ' + amount);

  let payeeId;
  if (method === 'im_bank' || method === 'other_bank') {
    if (!accountNumber) throw new Error('Bank account number required for bank transfer');
    payeeId = String(accountNumber).replace(/\s/g, '');
  } else {
    if (!phone) throw new Error('Phone number required for M-Pesa payment');
    payeeId = String(phone).replace(/^(0|\+?254)/, '').replace(/\s/g, ''); // 9-digit
  }

  const amountRounded = Math.round(parseFloat(amount) * 100) / 100;
  console.log('[SparkP2P] Choice Bank payment: KSh ' + amountRounded + ' -> ' + name + ' (' + payeeId + ')');

  const res = await fetch(API_BASE + '/ext/choice-pay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({
      order_number: orderNumber,
      payee_account_id: payeeId,
      amount: amountRounded,
      payee_name: name || '',
      bank_code: bankCode || '',
      remark: 'SparkP2P BUY ' + orderNumber.slice(-12),
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(function() { return {}; });
    throw new Error(err.detail || 'Choice Bank payment failed HTTP ' + res.status);
  }

  const data = await res.json();

  // OTP required — read the emailed 4-digit code via IMAP then confirm
  if (data.status === 'otp_required') {
    console.log('[SparkP2P] Choice Bank OTP required for transfer applicationId=' + data.application_id);
    const sentAt = Date.now();
    const otp = await readChoiceOTPviaIMAP(sentAt);
    if (!otp) throw new Error('Choice Bank OTP email did not arrive within 8 minutes. Transfer cancelled.');

    const confirmRes = await fetch(API_BASE + '/ext/choice-confirm-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({
        application_id: data.application_id,
        otp,
        order_number: orderNumber,
        amount: data.amount,
        payee_account_id: data.payee,
        payee_name: name || '',
        bank_code: bankCode || '',
        remark: data.remark || '',
      }),
    });
    if (!confirmRes.ok) {
      const err = await confirmRes.json().catch(function() { return {}; });
      throw new Error(err.detail || 'Choice Bank OTP confirmation failed HTTP ' + confirmRes.status);
    }
    const confirmed = await confirmRes.json();
    console.log('[SparkP2P] Choice Bank OTP confirmed — txId=' + (confirmed.transaction_id || 'n/a'));
    return { success: true, referenceId: confirmed.transaction_id || '', screenshot: confirmed.receipt_image || null };
  }

  console.log('[SparkP2P] Choice Bank payment success txId=' + (data.transaction_id || 'n/a'));
  return { success: true, referenceId: data.transaction_id || '', screenshot: data.receipt_image || null };
}

// BUY ORDER â€" I&M PAYMENT EXECUTION
// Reads payment details from Binance, sends money via I&M Bank,
// takes a screenshot of success, and uploads proof to Binance chat.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

async function executeImPayment({ phone, name, amount, reference, network = 'safaricom' }) {
  if (!imPage || imPage.isClosed()) throw new Error('I&M Bank tab is not open. Please reconnect I&M Bank.');
  if (!imPin) throw new Error('I&M PIN not set. Please save your PIN in Settings → Binance tab.');
  if (!anthropicApiKey) throw new Error('Anthropic API key not set â€" Vision required for I&M payments.');
  if (!phone || String(phone).trim() === '') throw new Error('Phone number is empty â€" cannot send payment');
  if (!amount || Number(amount) <= 0) throw new Error(`Amount is invalid (${amount}) â€" cannot send payment`);

  imWithdrawalRunning = true;
  const cleanPhone = String(phone).replace(/^0/, '').replace(/\s/g, ''); // strip leading 0
  console.log(`[SparkP2P] ðŸ'³ Starting I&M Vision payment: KSh ${amount} → ${name} (+254${cleanPhone})`);

  await imPage.bringToFront();
  await imPage.goto('https://digital.imbank.com/inm-retail/transfers/send-money-to-mobile/form', {
    waitUntil: 'domcontentloaded', timeout: 20000,
  });
  await new Promise(r => setTimeout(r, 3000));

  // Set 80% zoom for full form visibility (same as BankTransfer + Binance)
  await setZoom80(imPage);
  await new Promise(r => setTimeout(r, 400));

  // DPR â€" only used for Vision screenshot coordinate division (NOT for DOM coords)
  let imDpr = await imPage.evaluate(() => window.devicePixelRatio || 1).catch(() => 1);
  console.log(`[I&M] DPR = ${imDpr}`);
  // Helper: click a radio button by label text â€" L1 DOM, L2 Vision fallback
  const clickRadio = async (labelText) => {
    // L1: dispatchEvent inside the page — Angular mat-radio-button ignores CDP mouse.click
    const clicked = await imPage.evaluate((txt) => {
      const els = Array.from(document.querySelectorAll(
        'mat-radio-button, [role="radio"], label, input[type="radio"]'
      ));
      for (const el of els) {
        if (!(el.textContent || el.value || '').toLowerCase().includes(txt.toLowerCase())) continue;
        // For input[type=radio], click its parent label or mat-radio-button
        const target = el.closest('mat-radio-button, label') || el;
        const r = target.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      return null;
    }, labelText).catch(() => null);

    if (clicked) {
      console.log(`[I&M] âœ… L1 radio "${labelText}" dispatchEvent at (${Math.round(clicked.x)}, ${Math.round(clicked.y)})`);
      return true;
    }
    // L2: Vision screenshot → coordinates
    const ss = await imPage.screenshot({ encoding: 'base64' }).catch(() => null);
    if (!ss || !anthropicApiKey) return false;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 100,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ss } },
          { type: 'text', text: `Find the "${labelText}" radio button on this form and return its center pixel coordinates as JSON: {"x":NNN,"y":NNN}` },
        ]}],
      }),
    }).catch(() => null);
    if (!res?.ok) return false;
    const rd = await res.json();
    const m = (rd.content?.[0]?.text || '').match(/\{[\s\S]*?\}/);
    let coords = null; try { if (m) coords = JSON.parse(m[0]); } catch (_) {}
    if (coords?.x && coords?.y) {
      await imPage.mouse.click(coords.x, coords.y);
      console.log(`[I&M] âœ… L2 radio "${labelText}" at (${Math.round(coords.x)}, ${Math.round(coords.y)})`);
      return true;
    }
    console.log(`[I&M] âŒ Radio "${labelText}" not found via L1 or L2`);
    return false;
  };

  // Click Other Phone + One-off Beneficiary before Vision loop
  const r1 = await clickRadio('Other Phone');
  await new Promise(r => setTimeout(r, 1200));
  const r2 = await clickRadio('One-off Beneficiary');
  await new Promise(r => setTimeout(r, 1000));

  // Only mark radios confirmed if BOTH clicks actually succeeded
  let radiosConfirmed = r1 && r2;
  const phoneL1Filled = false; // Vision handles phone entry
  console.log(`[I&M] Pre-radios done (otherPhone=${r1}, oneOff=${r2}, confirmed=${radiosConfirmed}) — handing off to Vision loop`);

  // I&M amount field only accepts whole numbers â€" truncate decimals
  const amountInt = Math.floor(parseFloat(amount));
  console.log(`[I&M Vision] Amount rounded: ${amount} → ${amountInt}`);

  const IM_MAX_STEPS = 25;
  let step = 0;
  let screenshot = null;
  let referenceId = null;
  let formFilled = false; // true once all fields are entered
  let accountSelected = false; // true once debit account has been chosen

  while (step < IM_MAX_STEPS) {
    step++;
    await new Promise(r => setTimeout(r, 1500));

    // ── Account dropdown (Layer 1 → Layer 2) ───────────────────────────────────
    if (!accountSelected) {
      // Scroll to top so the "Select an account" trigger is visible
      await imPage.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })).catch(() => {});
      await new Promise(r => setTimeout(r, 300));

      // L1a: Try to click the account option if the dropdown is already open
      const domCoords = await imPage.evaluate((acct) => {
        const search = acct || 'BONITO CHELUGET';
        const all = Array.from(document.querySelectorAll(
          'mat-option, .mat-option, [role="option"], li, div, span, td'
        ));
        for (const el of all) {
          const txt = el.textContent.trim();
          if (!txt.includes(search)) continue;
          if (txt.toLowerCase().includes('select an account')) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 80 && r.height > 10 && r.height < 120 && r.top > 0) {
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: txt.substring(0, 50), tag: el.tagName };
          }
        }
        return null;
      }, traderImAccount || '00108094726050').catch(() => null);

      if (domCoords && domCoords.x > 0 && domCoords.y > 0) {
        await imPage.mouse.click(domCoords.x, domCoords.y);
        console.log(`[I&M] ✅ L1 clicked <${domCoords.tag}> "${domCoords.text}" at (${Math.round(domCoords.x)}, ${Math.round(domCoords.y)})`);
        accountSelected = true;
        await new Promise(r => setTimeout(r, 1000));
        // Re-click radios — account selection resets the form to defaults
        const pa1 = await clickRadio('Other Phone');
        await new Promise(r => setTimeout(r, 600));
        const pa2 = await clickRadio('One-off Beneficiary');
        await new Promise(r => setTimeout(r, 400));
        if (pa1 && pa2) radiosConfirmed = true;
        console.log(`[I&M] Post-account radios: otherPhone=${pa1}, oneOff=${pa2}, confirmed=${radiosConfirmed}`);
        await imPage.evaluate(() => window.scrollBy(0, 400)).catch(() => {});
        await new Promise(r => setTimeout(r, 500));
        console.log('[I&M] Scrolled down after account selection');
        continue;
      }

      // L1b: Dropdown is not open yet — try to click the "Select an account" trigger
      const triggerClicked = await imPage.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll(
          'mat-select, .mat-select-trigger, [role="combobox"], [aria-haspopup="listbox"]'
        ));
        for (const el of candidates) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.top >= 0) { el.click(); return true; }
        }
        // Fallback: any element whose exact text is "Select an account"
        const all = Array.from(document.querySelectorAll('span, div, p'));
        for (const el of all) {
          if (el.textContent.trim().toLowerCase() === 'select an account') {
            el.click(); return true;
          }
        }
        return false;
      }).catch(() => false);

      if (triggerClicked) {
        console.log('[I&M] L1b clicked dropdown trigger — waiting for account list');
        await new Promise(r => setTimeout(r, 800));
        // Try L1a again immediately after opening
        const domCoords2 = await imPage.evaluate((acct) => {
          const search = acct || 'BONITO CHELUGET';
          const all = Array.from(document.querySelectorAll('mat-option, .mat-option, [role="option"]'));
          for (const el of all) {
            const txt = el.textContent.trim();
            if (!txt.includes(search)) continue;
            const r = el.getBoundingClientRect();
            if (r.width > 80 && r.height > 10 && r.top > 0) {
              return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: txt.substring(0, 50) };
            }
          }
          return null;
        }, traderImAccount || '00108094726050').catch(() => null);
        if (domCoords2) {
          await imPage.mouse.click(domCoords2.x, domCoords2.y);
          console.log(`[I&M] ✅ L1b selected account "${domCoords2.text}"`);
          accountSelected = true;
          await new Promise(r => setTimeout(r, 1000));
          // Re-click radios — account selection resets the form to defaults
          const pb1 = await clickRadio('Other Phone');
          await new Promise(r => setTimeout(r, 600));
          const pb2 = await clickRadio('One-off Beneficiary');
          await new Promise(r => setTimeout(r, 400));
          if (pb1 && pb2) radiosConfirmed = true;
          console.log(`[I&M] Post-account radios: otherPhone=${pb1}, oneOff=${pb2}, confirmed=${radiosConfirmed}`);
          await imPage.evaluate(() => window.scrollBy(0, 400)).catch(() => {});
          await new Promise(r => setTimeout(r, 500));
          continue;
        }
      }

      // L1 failed — let Vision handle it, staying at the top of the page
      console.log('[I&M] L1 account selection failed — handing to Vision (page top visible)');
    } // end !accountSelected

    // Scroll: top when account pending (Vision needs to see dropdown), bottom otherwise
    if (accountSelected) {
      await imPage.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' })).catch(() => {});
    }
    await new Promise(r => setTimeout(r, 300));

    screenshot = await imPage.screenshot({ encoding: 'base64' }).catch(() => null);
    if (!screenshot) { console.log('[I&M Vision] Could not take screenshot'); continue; }

    const pageText = await imPage.evaluate(() => document.body.innerText).catch(() => '');
    const lower = pageText.toLowerCase();

    // ── Auto-dismiss I&M phone validation popup ───────────────────────────────
    if (lower.includes('unable to validate the mobile number') || lower.includes('phone number validation')) {
      console.log('[I&M Vision] Phone validation popup detected — clicking Proceed');
      const clicked = await imPage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
        for (const btn of btns) {
          const t = (btn.textContent || '').trim().toLowerCase();
          if (t === 'proceed') { btn.click(); return true; }
        }
        return false;
      }).catch(() => false);
      if (clicked) { console.log('[I&M Vision] Proceed clicked — continuing'); await new Promise(r => setTimeout(r, 1500)); continue; }
    }

    // â"€â"€ Detect success â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    const isSuccess = lower.includes('payment success') || lower.includes('transaction successful') ||
                      lower.includes('transfer successful') || lower.includes('sent successfully') ||
                      lower.includes('transaction complete') || lower.includes('money sent') ||
                      lower.includes("you've sent") || lower.includes('you have sent');
    if (isSuccess) {
      const refMatch = pageText.match(/reference\s*id\s*(?:number)?[:\s]+([A-Z0-9]{8,12})/i);
      if (refMatch) { referenceId = refMatch[1].trim(); console.log(`[I&M Vision] âœ… Ref ID: ${referenceId}`); }
      console.log(`[I&M Vision] âœ… Payment SUCCESS at step ${step}`);
      const receiptSS = await takeImSuccessScreenshot(imPage) || screenshot;
      imWithdrawalRunning = false;
      return { success: true, screenshot: receiptSS, referenceId };
    }

    // â"€â"€ Ask Claude what screen we are on and what to do â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    const visionRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshot } },
          { type: 'text', text: `You are controlling an I&M Bank portal to send M-Pesa money.
Payment details: phone=+254${cleanPhone}, amount=${amountInt}, network=${network}, reference="${String(reference).substring(0,30)}"
Debit account to use: ${traderImAccount || 'first available account'}

Identify the current screen and return ONE action as JSON:

SCREENS:
- "account_list" = The debit account dropdown list is OPEN â€" you can see account rows like "SPARK FREELANCE SOLUTIONS" or "BONITO CHELUGET SAMOEI" listed below a Search box
- "form" = Send Money to Mobile form (has fields: debit account, phone, amount, etc.)
- "review" = Review/confirmation modal showing payment summary
- "pin" = Identity Validation / PIN entry screen
- "success" = Payment successful
- "dashboard" = Back on dashboard (something went wrong)
- "other" = Something else

ACTIONS (pick exactly one):
- {"screen":"account_list","action":"click","description":"${traderImAccount || 'BONITO CHELUGET SAMOEI'}","x":NNN,"y":NNN}
- {"screen":"form","action":"click","description":"exact visible label or text","x":NNN,"y":NNN}
- {"screen":"form","action":"type","description":"exact visible label of input","value":"text","x":NNN,"y":NNN}
- {"screen":"review","action":"click","description":"Submit","x":NNN,"y":NNN}
- {"screen":"pin","action":"type_pin","value":"****"}
- {"screen":"pin","action":"click","description":"Complete","x":NNN,"y":NNN}
- {"screen":"dashboard","action":"navigate"}
- {"screen":"success","action":"done"}

IMPORTANT: For "click" and "type" actions you MUST include "x" and "y" â€" the pixel coordinates of the CENTER of the element in the screenshot. These are used for mouse clicks.

FORM FILLING ORDER â€" do ONE action per response, strictly in this order:
0. If you see an open account list (screen="account_list", rows like "SPARK FREELANCE" or "BONITO CHELUGET" visible) → click the row containing "${traderImAccount || 'BONITO CHELUGET SAMOEI'}" â€" return screen="account_list"
1. If debit account shows "Select an account" and NO list is open → click the â–¼ dropdown arrow to open it
2. (account_list handled by step 0 above)
3. ${radiosConfirmed ? '⚠️ SKIP THIS STEP — "Other Phone" and "One-off Beneficiary" were already set programmatically. Do NOT click them again.' : 'CRITICAL — Check the "Other Phone" radio button. If "Own Phone" is still selected → click the "Other Phone" radio circle IMMEDIATELY.'}
4. ${radiosConfirmed ? '⚠️ SKIP THIS STEP — already handled.' : 'Check "One-off Beneficiary" radio. If "Saved Beneficiary" is selected instead → click the "One-off Beneficiary" radio circle.'}
5. ${phoneL1Filled ? `⚠️ SKIP — phone number was pre-filled by automation. The field already contains ${cleanPhone}. Do NOT type it again under any circumstances.` : `PHONE — Look carefully at the phone number field. If it contains ANY digits (e.g. 7XXXXXXXX), it is already filled — do NOT type again. Only type ${cleanPhone} if the field is completely empty.`}
5b. AUTOCOMPLETE — If a suggestion card (e.g. "Sophia Muthoni Munene") appears below the phone field, press Tab (action="press_key", value="Tab") first to dismiss it. After dismissing, re-check the phone — if it already has digits, do NOT retype.
6. If network (Safaricom/Airtel) not selected → click ${network}
7. If amount field is empty or shows 0 → type amount: ${amountInt}. If it shows ANY non-zero number (e.g. 1,930 or 1930) treat it as correctly filled â€" do NOT retype it
8. If reference/narration field is empty (shows 0/50 or nothing) → type reference: ${String(reference).substring(0,30)}
9. ONLY click Continue when ALL of the above are done: Other Phone selected, phone=${cleanPhone}, network selected, amount=${amountInt}, reference filled. If ANY field is missing, fix it first.

Return ONLY valid JSON, no other text.` },
        ]}],
      }),
    }).catch(() => null);

    if (!visionRes?.ok) {
      console.log(`[I&M Vision] API call failed at step ${step}`);
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }

    const vData = await visionRes.json();
    let action = null;
    try {
      const txt = vData.content?.[0]?.text || '';
      const match = txt.match(/\{[\s\S]*\}/);
      if (match) action = JSON.parse(match[0]);
    } catch (_) {}

    if (!action) { console.log(`[I&M Vision] Could not parse action at step ${step}`); continue; }
    console.log(`[I&M Vision] Step ${step}: screen="${action.screen}" action="${action.action}" desc="${action.description || ''}" val="${action.value || ''}"`);

    // â"€â"€ Guard: block Vision from re-clicking radio buttons already set by L1 â"€â"€
    if (radiosConfirmed && action.action === 'click') {
      const desc = (action.description || '').toLowerCase();
      if (desc.includes('other phone') || desc.includes('one-off') || desc.includes('one off') || desc.includes('beneficiary')) {
        console.log(`[I&M Vision] â›" Blocked redundant radio click "${action.description}" â€" radios already confirmed`);
        continue; // skip this step, take fresh screenshot next iteration
      }
    }

    // â"€â"€ Execute the action â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    if (action.screen === 'success' || action.action === 'done') {
      // Handled above by text detection â€" but catch it here too
      const receiptSS2 = await takeImSuccessScreenshot(imPage) || screenshot;
      imWithdrawalRunning = false;
      return { success: true, screenshot: receiptSS2, referenceId };
    }

    if (action.screen === 'dashboard' || action.action === 'navigate') {
      console.log('[I&M Vision] On dashboard â€" navigating back to form');
      await imPage.goto('https://digital.imbank.com/inm-retail/transfers/send-money-to-mobile/form',
        { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }

    if (action.action === 'type' && action.value) {
      // Layer 1: Vision gave us coordinates â€" click to focus the field
      if (action.x && action.y) {
        await imPage.mouse.click(action.x / imDpr, action.y / imDpr);
        await new Promise(r => setTimeout(r, 400));
        console.log(`[I&M Vision] Coord-clicked field at (${Math.round(action.x / imDpr)}, ${Math.round(action.y / imDpr)}) DPR=${imDpr}`);
      }

      // Layer 2: Angular native value setter on the focused active element
      const filled = await imPage.evaluate((val) => {
        const el = document.activeElement;
        if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return { found: false, reason: 'no active input' };
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
                          || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (nativeSetter) nativeSetter.call(el, val);
        else el.value = val;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur',   { bubbles: true }));
        return { found: true, tag: el.tagName, id: el.id || el.name || '' };
      }, String(action.value));

      if (filled.found) {
        await imPage.keyboard.press('Tab');
        console.log(`[I&M Vision] âœ… Set "${action.value}" into <${filled.tag}#${filled.id}>`);
        await new Promise(r => setTimeout(r, 1200));
      } else {
        // Fallback: label-text DOM search (no coordinates given)
        console.log(`[I&M Vision] Active element not an input (${filled.reason}) â€" trying label fallback`);
        const fallback = await imPage.evaluate((desc, val) => {
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          const setVal = (el) => {
            el.focus(); el.click();
            if (nativeSetter) nativeSetter.call(el, val); else el.value = val;
            el.dispatchEvent(new Event('input',  { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur',   { bubbles: true }));
          };
          if (desc) {
            const labels = Array.from(document.querySelectorAll('label, [class*="label"]'));
            for (const lbl of labels) {
              if (lbl.textContent.toLowerCase().includes(desc.toLowerCase())) {
                const forId = lbl.getAttribute('for');
                const inp = forId ? document.getElementById(forId)
                          : lbl.querySelector('input, textarea')
                         || lbl.nextElementSibling?.querySelector('input, textarea')
                         || lbl.parentElement?.querySelector('input, textarea');
                if (inp) { setVal(inp); return { found: true }; }
              }
            }
          }
          return { found: false };
        }, action.description || '', String(action.value));
        if (fallback.found) {
          await imPage.keyboard.press('Tab');
          console.log(`[I&M Vision] Set "${action.value}" via label fallback`);
          await new Promise(r => setTimeout(r, 1200));
        } else {
          console.log(`[I&M Vision] âŒ Could not set "${action.value}" â€" field not found`);
        }
      }

      // After typing the phone — verify I&M registered name matches Binance name
      if (String(action.value) === String(cleanPhone)) {
        await new Promise(r => setTimeout(r, 2500)); // wait for I&M name lookup
        const imVerifiedName = await imPage.evaluate(() => {
          // Try Angular Material autocomplete / verified beneficiary elements
          const opts = Array.from(document.querySelectorAll(
            'mat-option, .mat-option, [role="option"], .cdk-overlay-container mat-option'
          ));
          for (const el of opts) {
            const txt = (el.textContent || '').trim().replace(/\s+/g, ' ');
            const words = txt.split(' ');
            if (words.length >= 2 && words.length <= 6 && /^[A-Z]/.test(txt) && !/\d/.test(txt)) return txt;
          }
          // Fallback: scan bodyText for a standalone name line (all-caps or title-case, no digits)
          const lines = (document.body.innerText || '').split('\n').map(l => l.trim()).filter(l => l.length > 3 && l.length < 70);
          for (const line of lines) {
            if (/^[A-Z][A-Z\s]{4,50}$/.test(line) && line.split(' ').length >= 2 && !/\d/.test(line)) return line;
            if (/^[A-Z][a-z]+(\s+[A-Z][a-z]+){1,4}$/.test(line) && !/\d/.test(line)) return line;
          }
          return null;
        }).catch(() => null);

        if (imVerifiedName && name) {
          const norm = s => s.toUpperCase().replace(/[^A-Zs]/g, '').replace(/s+/g, ' ').trim().split(' ').filter(w => w.length > 1);
          const binanceParts = norm(name);
          const imParts = norm(imVerifiedName);
          const commonWords = binanceParts.filter(w => imParts.includes(w));
          if (commonWords.length === 0) {
            console.log(`[I&M] Name warning -- Binance: "${name}" | I&M verified: "${imVerifiedName}" -- proceeding anyway`);
          } else {
            console.log(`[I&M] Name verified OK -- I&M: "${imVerifiedName}" matches Binance "${name}" (${commonWords.length} word(s))`);
          }
        } else if (imVerifiedName) {
          console.log(`[I&M] I&M verified name: "${imVerifiedName}" (no Binance name to compare -- proceeding)`);
        } else {
          console.log(`[I&M] Could not read I&M verified name -- proceeding`);
        }
      }

      continue;
    }

    // Account list: Vision clicked an account row — set accountSelected and re-click radios
    if (action.screen === 'account_list' && action.action === 'click' && action.x && action.y) {
      await imPage.mouse.click(action.x / imDpr, action.y / imDpr);
      console.log(`[I&M Vision] Account row clicked at (${Math.round(action.x / imDpr)}, ${Math.round(action.y / imDpr)})`);
      accountSelected = true;
      await new Promise(r => setTimeout(r, 1200));
      // Re-click radios since account selection resets them
      const pv1 = await clickRadio('Other Phone');
      await new Promise(r => setTimeout(r, 600));
      const pv2 = await clickRadio('One-off Beneficiary');
      await new Promise(r => setTimeout(r, 400));
      if (pv1 && pv2) radiosConfirmed = true;
      console.log(`[I&M Vision] Post-account radios: otherPhone=${pv1}, oneOff=${pv2}, confirmed=${radiosConfirmed}`);
      await imPage.evaluate(() => window.scrollBy(0, 400)).catch(() => {});
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    if (action.action === 'press_key' && action.value) {
      await imPage.keyboard.press(action.value);
      console.log(`[I&M Vision] Pressed key: ${action.value}`);
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    if (action.action === 'type_pin') {
      // Enter PIN
      const pinInput = await imPage.$('input[type="password"], input[maxlength="4"], input[maxlength="6"]');
      if (pinInput) {
        await pinInput.click({ clickCount: 3 });
        await pinInput.type(imPin, { delay: 150 });
        console.log('[I&M Vision] PIN entered');
      } else {
        console.log('[I&M Vision] PIN input not found â€" trying keyboard');
        await imPage.keyboard.type(imPin, { delay: 150 });
      }
      await new Promise(r => setTimeout(r, 600));

      // Immediately click Complete after PIN â€" L1 DOM, L2 Vision
      const completeBtn = await imPage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"], a'));
        const btn = btns.find(b => (b.textContent || '').trim().toLowerCase() === 'complete');
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }).catch(() => null);

      if (completeBtn && completeBtn.x > 0) {
        await imPage.mouse.click(completeBtn.x, completeBtn.y);
        console.log(`[I&M Vision] âœ… Clicked Complete at (${Math.round(completeBtn.x)}, ${Math.round(completeBtn.y)})`);
      } else {
        // L2: Vision coordinates
        const pinSS = await imPage.screenshot({ encoding: 'base64' }).catch(() => null);
        if (pinSS && anthropicApiKey) {
          const pinRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001', max_tokens: 80,
              messages: [{ role: 'user', content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pinSS } },
                { type: 'text', text: 'Find the "Complete" button and return its center coordinates as JSON: {"x":NNN,"y":NNN}' },
              ]}],
            }),
          }).catch(() => null);
          if (pinRes?.ok) {
            const pd = await pinRes.json();
            const pm = (pd.content?.[0]?.text || '').match(/\{[\s\S]*?\}/);
            let pc = null; try { if (pm) pc = JSON.parse(pm[0]); } catch (_) {}
            if (pc?.x && pc?.y) {
              await imPage.mouse.click(pc.x / imDpr, pc.y / imDpr);
              console.log(`[I&M Vision] âœ… L2 clicked Complete at (${Math.round(pc.x / imDpr)}, ${Math.round(pc.y / imDpr)})`);
            }
          }
        }
      }
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }

    if (action.action === 'click' && action.description) {
      const descLower = action.description.toLowerCase();
      const isTransition = ['continue', 'submit', 'complete'].some(w => descLower.includes(w));
      const isContinue = descLower.includes('continue');

      // For "Continue" clicks: always try DOM-first (Vision coords unreliable at 80% zoom for below-fold buttons)
      if (isContinue) {
        // Guard: ensure reference/narration field is filled before clicking Continue
        const refStr = String(reference).substring(0, 30);
        const refFilled = await imPage.evaluate((ref) => {
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
                            || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
          const inputs = Array.from(document.querySelectorAll('input, textarea'));
          const refInput = inputs.find(el => {
            const id = (el.id || el.name || el.placeholder || '').toLowerCase();
            return id.includes('description') || id.includes('narration') || id.includes('reference') || id.includes('remark');
          });
          if (!refInput) return false;
          if ((refInput.value || '').trim()) return true; // already filled
          refInput.scrollIntoView({ block: 'center', behavior: 'instant' });
          refInput.focus(); refInput.click();
          if (nativeSetter) nativeSetter.call(refInput, ref); else refInput.value = ref;
          refInput.dispatchEvent(new Event('input', { bubbles: true }));
          refInput.dispatchEvent(new Event('change', { bubbles: true }));
          refInput.dispatchEvent(new Event('blur', { bubbles: true }));
          return true;
        }, refStr).catch(() => false);
        if (refFilled) {
          console.log(`[I&M Vision] âœ… Reference field filled via DOM guard: "${refStr}"`);
          await new Promise(r => setTimeout(r, 600));
        }
        const domClicked = await imPage.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, [role="button"], a'));
          const btn = btns.find(b => {
            const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
            const r = b.getBoundingClientRect();
            // Match "continue" or "next"; also match if it's the primary teal submit button with type="submit"
            return r.width > 0 && (txt.includes('continue') || txt.includes('next') ||
              (b.type === 'submit' && !txt.includes('cancel') && !txt.includes('clear')));
          });
          if (btn) {
            btn.scrollIntoView({ block: 'center', behavior: 'instant' });
            btn.click();
            return (btn.innerText || btn.textContent || '').trim() || 'button';
          }
          return null;
        }).catch(() => null);

        if (domClicked) {
          console.log(`[I&M Vision] âœ… DOM-clicked Continue button ("${domClicked}")`);
          await new Promise(r => setTimeout(r, 4000));
          continue;
        }
        // Fall through to coord click if DOM failed
        console.log('[I&M Vision] DOM Continue not found â€" falling back to coord click');
      }

      if (action.x && action.y) {
        // Layer 1: Coordinate-based click (Vision screenshot pixels → divide by DPR for CSS pixels)
        await imPage.mouse.click(action.x / imDpr, action.y / imDpr);
        console.log(`[I&M Vision] Coord-clicked "${action.description}" at (${Math.round(action.x / imDpr)}, ${Math.round(action.y / imDpr)})`);
        await new Promise(r => setTimeout(r, isTransition ? 4000 : 1000));
      } else {
        // Layer 2 fallback: DOM text search
        const clicked = await imPage.evaluate((desc) => {
          const candidates = Array.from(document.querySelectorAll('button, [role="button"], [role="option"], [role="radio"], label, a, li, div, span'));
          for (const el of candidates) {
            const txt = (el.textContent || '').trim();
            if (txt.toLowerCase().includes(desc.toLowerCase()) && el.getBoundingClientRect().width > 0) {
              el.click();
              return true;
            }
          }
          return false;
        }, action.description);

        if (clicked) {
          console.log(`[I&M Vision] DOM-clicked "${action.description}"`);
          await new Promise(r => setTimeout(r, isTransition ? 4000 : 1000));
        } else {
          console.log(`[I&M Vision] âŒ Element "${action.description}" not found`);
        }
      }
      continue;
    }
  }

  // Exceeded max steps
  const finalText = await imPage.evaluate(() => document.body.innerText).catch(() => '');
  screenshot = await imPage.screenshot({ encoding: 'base64' }).catch(() => null);
  imWithdrawalRunning = false;
  console.log(`[I&M Vision] âŒ Exceeded ${IM_MAX_STEPS} steps. Page: ${finalText.substring(0, 100)}`);
  return { success: false, screenshot, referenceId: null };
}

// executeImPesaLinkByPhone â€" REMOVED. Use executeImBankTransfer for all bank transfers.


// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// I&M LOCAL TRANSFER â€" I&M → I&M or I&M → other bank by account number
// Used when seller provides a bank account number (not phone-based PesaLink)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function executeImBankTransfer({ accountNumber, bankName, name, amount, reference }) {
  if (!imPage || imPage.isClosed()) throw new Error('I&M Bank tab is not open.');
  if (!imPin) throw new Error('I&M PIN not set.');
  if (!anthropicApiKey) throw new Error('Anthropic API key required for Vision.');
  if (!accountNumber) throw new Error('Account number missing for bank transfer.');
  if (!amount || Number(amount) <= 0) throw new Error(`Invalid amount: ${amount}`);
  imWithdrawalRunning = true;
  const amountInt = Math.floor(parseFloat(amount));
  const refStr = String(reference).substring(0, 50);
  const targetBank = (() => {
    const raw = (bankName || '').trim();
    const n = raw.toLowerCase().replace(/[&\s]/g, '');
    if (!n || n === 'im' || n === 'i&m' || n === 'imbank' || n === 'i&mbank') return 'I & M Bank Ltd';
    return raw;
  })();
  console.log(`[SparkP2P] ðŸ¦ Bank Transfer: KSh ${amountInt} → ${name} (${targetBank} A/C ${accountNumber})`);

  await imPage.bringToFront();
  await imPage.goto('https://digital.imbank.com/inm-retail/transfers/local-transfers/form', {
    waitUntil: 'domcontentloaded', timeout: 20000,
  });
  await new Promise(r => setTimeout(r, 3000));

  // Set page to 80% zoom using the same setZoom80() helper as Binance
  await setZoom80(imPage);
  await new Promise(r => setTimeout(r, 400));
  console.log('[BankTransfer] âœ… Page scale set to 80% via setZoom80()');

  let imDpr = await imPage.evaluate(() => window.devicePixelRatio || 1).catch(() => 1);
  console.log(`[BankTransfer] DPR = ${imDpr}`);

  // All form filling handled inside Vision loop after account selection

  // â"€â"€ Vision loop â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  const IM_MAX_STEPS = 30;
  let step = 0;
  let screenshot = null;
  let referenceId = null;
  let accountSelected = false;
  let formFilled = false;

  while (step < IM_MAX_STEPS) {
    step++;
    await new Promise(r => setTimeout(r, 1500));
    // Re-read DPR each iteration in case zoom changed
    imDpr = await imPage.evaluate(() => window.devicePixelRatio || 1).catch(() => imDpr);

    // â"€â"€ Account selection: type account number in dropdown search box â"€â"€â"€â"€â"€â"€â"€â"€
    if (!accountSelected) {
      // Check if the dropdown search box is visible (dropdown is open)
      const searchBox = await imPage.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input[type="search"], input[placeholder*="Search" i], input[placeholder*="search" i]'));
        for (const inp of inputs) {
          const r = inp.getBoundingClientRect();
          if (r.width > 50 && r.height > 0 && r.top > 100) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
        return null;
      }).catch(() => null);

      if (searchBox) {
        // Type account number into search box to filter results
        const searchTerm = traderImAccount || 'BONITO';
        await imPage.mouse.click(searchBox.x, searchBox.y);
        await new Promise(r => setTimeout(r, 300));
        await imPage.keyboard.type(searchTerm, { delay: 60 });
        await new Promise(r => setTimeout(r, 1200));

        // Now click the first (only) visible result
        const result = await imPage.evaluate(() => {
          const all = Array.from(document.querySelectorAll('*'));
          const rows = all.filter(el => {
            const txt = (el.textContent || '').trim();
            const r = el.getBoundingClientRect();
            return txt.includes('KES') && /\d{8,}/.test(txt) &&
                   r.width > 80 && r.height > 5 && r.height < 150 && r.top > 150;
          });
          // Pick smallest matching element (most specific, not a wrapper)
          rows.sort((a, b) => {
            const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
            return (ra.width * ra.height) - (rb.width * rb.height);
          });
          if (rows[0]) {
            const r = rows[0].getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: rows[0].tagName, txt: (rows[0].textContent || '').trim().substring(0, 60) };
          }
          return null;
        }).catch(() => null);

        if (result) {
          await imPage.mouse.click(result.x, result.y);
          console.log(`[BankTransfer] âœ… Account selected via search box: <${result.tag}> "${result.txt}"`);
          accountSelected = true;
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
      } else {
        // Dropdown not open yet — open it, or detect it's already selected
        const trigger = await imPage.evaluate(() => {
          const el = Array.from(document.querySelectorAll('*')).find(e =>
            (e.textContent || '').trim() === 'Select an account' && e.getBoundingClientRect().width > 100);
          if (el) { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
          return null;
        }).catch(() => null);
        if (trigger) {
          await imPage.mouse.click(trigger.x, trigger.y);
          console.log('[BankTransfer] Opening account dropdown...');
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
        // No search box and no "Select an account" trigger — an account is already selected.
        // This happens when the browser restores the last session state on page load.
        const alreadySelected = await imPage.evaluate(() => {
          // Look for an element showing a selected account (contains "KES ACC" or has account number format)
          return Array.from(document.querySelectorAll('*')).some(el => {
            const txt = (el.textContent || '').trim();
            const r = el.getBoundingClientRect();
            return r.width > 50 && r.width < 600 && r.height > 0 && r.height < 80 &&
                   (/KES ACC/i.test(txt) || /KES\s+[\d,]+/.test(txt)) && txt.length < 100;
          });
        }).catch(() => false);
        if (alreadySelected) {
          console.log('[BankTransfer] Debit account already selected — proceeding to form fill');
          accountSelected = true;
          continue;
        }
      }
    }

    // â"€â"€ Post-account-selection L1 fill (runs once after account confirmed) â"€â"€â"€
    if (accountSelected && !formFilled) {
      await new Promise(r => setTimeout(r, 1000));

      // One-off Beneficiary — use specific selectors, no size filters (size varies by screen resolution/zoom)
      const oneOffClicked = await imPage.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll(
          'mat-radio-button, [role="radio"], label, input[type="radio"]'
        ));
        for (const el of candidates) {
          if (!(el.textContent || el.value || '').toLowerCase().includes('one-off')) continue;
          const target = el.closest('mat-radio-button, label') || el;
          const r = target.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            // Also fire on the inner input to ensure Angular change detection triggers
            const input = target.querySelector('input[type="radio"]') || (el.type === 'radio' ? el : null);
            if (input) { input.click(); input.dispatchEvent(new Event('change', { bubbles: true })); }
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
        }
        return null;
      }).catch(() => null);
      if (oneOffClicked) {
        console.log(`[BankTransfer] One-off Beneficiary dispatchEvent at (${Math.round(oneOffClicked.x)}, ${Math.round(oneOffClicked.y)})`);
      } else {
        console.log('[BankTransfer] One-off Beneficiary element not found — will retry');
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      await new Promise(r => setTimeout(r, 1800));

      // Verify Angular registered the radio change.
      // The "Bank name" field is a mat-select (dropdown), not a plain <input>, so we check:
      //   1. The radio button aria-checked/mat-radio-checked state
      //   2. Visible label text that only appears in the One-off section
      //   3. Any mat-select element visible (bank name dropdown)
      //   4. Legacy input placeholder check as final fallback
      const oneOffVisible = await imPage.evaluate(() => {
        // Check 1: Angular radio state
        const radios = Array.from(document.querySelectorAll('mat-radio-button, [role="radio"]'));
        const oneOff = radios.find(r => (r.textContent || '').toLowerCase().includes('one-off'));
        if (oneOff) {
          const checked = oneOff.classList.contains('mat-radio-checked') ||
                          oneOff.classList.contains('mat-mdc-radio-checked') ||
                          oneOff.getAttribute('aria-checked') === 'true' ||
                          !!oneOff.querySelector('input[type="radio"]:checked');
          if (checked) return true;
        }
        // Check 2: field labels that only appear when One-off section is expanded
        const allEls = Array.from(document.querySelectorAll('*'));
        const hasFieldLabel = allEls.some(el => {
          const txt = (el.textContent || '').trim();
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.width < 400 && r.height > 0 &&
                 (txt === 'Account number' || txt === 'Account name' || txt === 'Bank code' || txt === 'Bank name');
        });
        if (hasFieldLabel) return true;
        // Check 3: mat-select visible (bank name dropdown)
        const matSels = Array.from(document.querySelectorAll('mat-select'));
        if (matSels.some(s => { const r = s.getBoundingClientRect(); return r.width > 0 && r.height > 0; })) return true;
        // Check 4: legacy input check
        const inputs = Array.from(document.querySelectorAll('input'));
        return inputs.some(i => {
          const ph = (i.placeholder || '').toLowerCase(), fc = (i.getAttribute('formcontrolname') || '').toLowerCase();
          return ph.includes('bank') || fc.includes('bank') || ph.includes('account number') || fc.includes('account');
        });
      }).catch(() => false);
      if (!oneOffVisible) {
        console.log('[BankTransfer] One-off fields not visible after click — retrying radio selection');
        await new Promise(r => setTimeout(r, 1000));
        continue; // retry on next iteration
      }
      formFilled = true;
      await new Promise(r => setTimeout(r, 500));

      // Bank name — supports mat-select (pure dropdown), native select, or input (autocomplete)
      const bankFieldInfo = await imPage.evaluate(() => {
        const allEls = Array.from(document.querySelectorAll('*'));
        const lbl = allEls.find(el => {
          const txt = (el.textContent || '').trim().toLowerCase();
          const r = el.getBoundingClientRect();
          return txt === 'bank name' && r.width > 0 && r.width < 300 && r.height > 0;
        });
        const container = lbl
          ? (lbl.closest('mat-form-field') || lbl.parentElement?.parentElement || lbl.parentElement)
          : null;
        const scope = container || document;
        const matSel = scope.querySelector('mat-select');
        if (matSel) { const r = matSel.getBoundingClientRect(); if (r.width > 0 && r.height > 0) return { type: 'mat-select', x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
        const sel = scope.querySelector('select');
        if (sel) { const r = sel.getBoundingClientRect(); if (r.width > 0 && r.height > 0) return { type: 'select', x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
        const inp = scope.querySelector('input');
        if (inp) { const r = inp.getBoundingClientRect(); if (r.width > 0 && r.height > 0) return { type: 'input', x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
        return null;
      }).catch(() => null);
      if (bankFieldInfo) {
        await imPage.mouse.click(bankFieldInfo.x, bankFieldInfo.y);
        await new Promise(r => setTimeout(r, 600));
        if (bankFieldInfo.type === 'input') {
          // Autocomplete: type the first chars of the exact bank name so autocomplete finds it
          const typePrefix = targetBank.substring(0, 5);
          await imPage.keyboard.type(typePrefix, { delay: 80 });
          await new Promise(r => setTimeout(r, 1800));
        } else {
          // mat-select / select: click opened the panel — wait for options to render
          await new Promise(r => setTimeout(r, 1200));
        }
        const bankSelected2 = await imPage.evaluate((bank) => {
          const opts = Array.from(document.querySelectorAll('mat-option, [role="option"], [class*="option" i], .ng-option, .dropdown-item'));
          const nm = s => s.toLowerCase().replace(/[&\s]/g, '');
          const match = opts.find(o => {
            const txt = (o.textContent || '').trim();
            const r = o.getBoundingClientRect();
            if (r.height <= 0) return false;
            const ntxt = nm(txt), nbank = nm(bank);
            return ntxt.includes(nbank.substring(0, 6)) || nbank.includes(ntxt.substring(0, 6));
          });
          if (match) { match.click(); return (match.textContent || '').trim(); }
          return null;
        }, targetBank).catch(() => null);
        if (bankSelected2) {
          console.log(`[BankTransfer] ✅ Bank selected: ${bankSelected2}`);
        } else {
          console.log(`[BankTransfer] ⚠️ Bank option not found for "${targetBank}" — Vision will handle`);
        }
        await new Promise(r => setTimeout(r, 1000));
      } else {
        console.log(`[BankTransfer] ⚠️ Bank name field not found — Vision will handle`);
      }

      // Account number + Validate
      const acctInput2 = await imPage.evaluate(() => {
        // Find input near "Account number" label (label-proximity approach)
        const labels = Array.from(document.querySelectorAll('label, div, span, p, h6, mat-label'));
        const lbl = labels.find(el => {
          const txt = (el.textContent || '').trim().toLowerCase().replace(/[*\s]+$/, '');
          return txt === 'account number' && el.getBoundingClientRect().width > 0;
        });
        if (lbl) {
          const parent = lbl.parentElement?.parentElement || lbl.parentElement;
          const inp = parent?.querySelector('input');
          if (inp) { const r = inp.getBoundingClientRect(); if (r.width > 50 && r.height > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
        }
        // Fallback: placeholder or formcontrolname
        const inputs = Array.from(document.querySelectorAll('input'));
        const i = inputs.find(inp =>
          (inp.placeholder || '').toLowerCase().includes('account number') ||
          (inp.getAttribute('formcontrolname') || '').toLowerCase().includes('accountnumber') ||
          (inp.getAttribute('formcontrolname') || '').toLowerCase().replace(/_/g, '') === 'account'
        );
        if (i) { const r = i.getBoundingClientRect(); if (r.width > 50 && r.height > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
        return null;
      }).catch(() => null);
      if (acctInput2) {
        await imPage.mouse.click(acctInput2.x, acctInput2.y);
        await new Promise(r => setTimeout(r, 300));
        await imPage.keyboard.type(String(accountNumber), { delay: 60 });
        console.log(`[BankTransfer] âœ… Account number typed: ${accountNumber}`);
        await new Promise(r => setTimeout(r, 800));
        const validated2 = await imPage.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim().toLowerCase() === 'validate' && !b.disabled);
          if (btn) { btn.click(); return true; }
          return false;
        }).catch(() => false);
        if (validated2) {
          console.log('[BankTransfer] ✅ Validate clicked');
          await new Promise(r => setTimeout(r, 3500));
          // Check for validation error (invalid account number)
          const validateFailed = await imPage.evaluate(() => {
            const text = (document.body.innerText || '').toLowerCase();
            return text.includes('account number entered is invalid') ||
                   text.includes('please confirm the account number') ||
                   text.includes('invalid account') ||
                   text.includes('account name is required');
          }).catch(() => false);
          if (validateFailed) {
            console.log('[BankTransfer] ❌ Validate failed — account number invalid or not resolved');
            imWithdrawalRunning = false;
            return { success: false, invalidAccount: true };
          }
        } else { console.log('[BankTransfer] ⚠️ Validate button not found or disabled'); }
      } else {
        console.log('[BankTransfer] âš ï¸ Account number input not found â€" skipped');
      }

      // KES currency â€" use Puppeteer page.select() for native <select>, fallback to click+keyboard
      const kesSetBySelect = await (async () => {
        try {
          // Find native <select> with KES option
          const selInfo = await imPage.evaluate(() => {
            const sels = Array.from(document.querySelectorAll('select'));
            for (const s of sels) {
              const opts = Array.from(s.options).map(o => o.text.trim());
              if (opts.includes('KES')) {
                const r = s.getBoundingClientRect();
                // Collect all option values to find KES
                const kesOpt = Array.from(s.options).find(o => o.text.trim() === 'KES');
                return { selector: true, value: kesOpt?.value || 'KES', x: r.left + r.width / 2, y: r.top + r.height / 2 };
              }
            }
            return null;
          }).catch(() => null);

          if (selInfo) {
            // Use Puppeteer's built-in select (sets value + dispatches change/input events)
            await imPage.select('select', selInfo.value);
            console.log(`[BankTransfer] âœ… Currency set to KES (page.select value="${selInfo.value}")`);
            return true;
          }
          return false;
        } catch (e) {
          console.log(`[BankTransfer] page.select failed: ${e.message}`);
          return false;
        }
      })();

      if (!kesSetBySelect) {
        // Fallback: find the select trigger visually and use OS click + keyboard K
        const currTrigger = await imPage.evaluate(() => {
          const vh = window.innerHeight;
          // Find any visible small element with text "-" (the currency trigger)
          const all = Array.from(document.querySelectorAll('select, mat-select, [role="combobox"]'));
          for (const el of all) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.width < 150 && r.height > 0 && r.top >= 0 && r.top < vh) {
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }
          }
          return null;
        }).catch(() => null);
        if (currTrigger) {
          await realMouseClick(imPage, currTrigger.x, currTrigger.y);
          await new Promise(r => setTimeout(r, 900));
          const psKes = `Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Threading;
public class KS2 { [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, int flags, int extra); public static void P(byte vk){keybd_event(vk,0,0,0);Thread.Sleep(80);keybd_event(vk,0,2,0);Thread.Sleep(80);} }
"@
[KS2]::P(0x4B); Start-Sleep -Milliseconds 400; [KS2]::P(0x0D); Write-Host "done"`;
          const psTmp = require('path').join(require('os').tmpdir(), 'sp2p_kes2.ps1');
          require('fs').writeFileSync(psTmp, psKes, 'utf8');
          await new Promise(resolve => { require('child_process').exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psTmp}"`, { timeout: 5000 }, resolve); });
          console.log('[BankTransfer] âœ… Currency KES via OS click+K fallback');
        } else {
          console.log('[BankTransfer] âš ï¸ Currency trigger not found â€" Vision will handle');
        }
      }

      // Amount â€" scroll it into view first, then fill
      const amtFilled2 = await imPage.evaluate((amt) => {
        const inputs = Array.from(document.querySelectorAll('input[type="number"],input[type="text"]'));
        const amtInput = inputs.find(i => {
          const ph = (i.placeholder || '').toLowerCase(), fc = (i.getAttribute('formcontrolname') || '').toLowerCase();
          if (ph.includes('bank') || fc.includes('bank') || ph.includes('account') || fc.includes('account') || ph.includes('reference') || fc.includes('reference') || fc.includes('narration')) return false;
          return i.value === '0' || i.placeholder === '0' || fc.includes('amount');
        });
        if (amtInput) {
          amtInput.scrollIntoView({ block: 'center', behavior: 'instant' });
          amtInput.click(); amtInput.select();
          const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (ns) ns.call(amtInput, String(amt));
          amtInput.dispatchEvent(new Event('input', { bubbles: true }));
          amtInput.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        return false;
      }, amountInt).catch(() => false);
      if (amtFilled2) console.log(`[BankTransfer] âœ… Amount: ${amountInt}`);
      await new Promise(r => setTimeout(r, 500));

      // Reference â€" scroll into view, then fill
      const refFilled2 = await imPage.evaluate((ref) => {
        const inputs = Array.from(document.querySelectorAll('input,textarea'));
        const i = inputs.find(inp => (inp.placeholder || '').toLowerCase().includes('payment description') || (inp.placeholder || '').toLowerCase().includes('reference') || (inp.getAttribute('formcontrolname') || '').toLowerCase().includes('reference') || (inp.getAttribute('formcontrolname') || '').toLowerCase().includes('narration'));
        if (i) {
          i.scrollIntoView({ block: 'center', behavior: 'instant' });
          i.click(); i.value = '';
          const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (ns) ns.call(i, ref);
          i.dispatchEvent(new Event('input', { bubbles: true }));
          i.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        return false;
      }, refStr).catch(() => false);
      if (refFilled2) console.log('[BankTransfer] âœ… Reference filled');
      await new Promise(r => setTimeout(r, 500));

      // Pesalink radio â€" scroll into view, then click
      await imPage.evaluate(() => {
        const all = Array.from(document.querySelectorAll('label, span, div, input[type="radio"]'));
        const el = all.find(e => (e.textContent || '').trim() === 'Pesalink' && e.getBoundingClientRect().width > 0);
        if (el) { el.scrollIntoView({ block: 'center', behavior: 'instant' }); el.click(); }
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 500));
      console.log('[BankTransfer] âœ… Pesalink selected');

      // Payment Purpose = Other — find by scanning all selects for the one with payment purpose options
      const purposeDone = await (async () => {
        try {
          const handles = await imPage.$$('select');
          if (!handles.length) { console.log('[BankTransfer] ⚠️ No <select> elements found'); return false; }

          // Find the payment purpose select by: aria-label/name/formcontrolname containing "purpose",
          // or by being the select whose options include "Other" after triggering Angular lazy load.
          // Do NOT rely on a hardcoded index — the count of selects varies by screen/form state.
          let handle = null;

          // Pass 1: find by attribute (no option loading needed)
          for (const h of handles) {
            const match = await h.evaluate(el => {
              const attrs = [el.name, el.id, el.getAttribute('formcontrolname'),
                             el.getAttribute('aria-label'), el.getAttribute('ng-reflect-name')];
              return attrs.some(a => a && a.toLowerCase().includes('purpose'));
            }).catch(() => false);
            if (match) { handle = h; console.log('[BankTransfer] Found purpose select by attribute'); break; }
          }

          // Pass 2: trigger each select and check if its options include "Other"
          if (!handle) {
            for (const h of handles) {
              await h.evaluate(el => {
                el.scrollIntoView({ block: 'center', behavior: 'instant' });
                el.focus();
                el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                el.dispatchEvent(new Event('focus', { bubbles: true }));
              }).catch(() => {});
              await new Promise(r => setTimeout(r, 800));
              await imPage.keyboard.press('Escape').catch(() => {});
              const opts = await h.evaluate(el =>
                Array.from(el.options).map(o => o.text.trim().toLowerCase())
              ).catch(() => []);
              if (opts.some(t => t.includes('other'))) {
                handle = h;
                console.log(`[BankTransfer] Found purpose select by options scan: [${opts.join(', ')}]`);
                break;
              }
            }
          }

          if (!handle) { console.log('[BankTransfer] ⚠️ Payment purpose select not found on any pass'); return false; }

          await handle.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
          await new Promise(r => setTimeout(r, 300));

          // Retry up to 3 times — Angular loads options lazily on focus/click
          let otherOpt = null;
          for (let attempt = 1; attempt <= 3; attempt++) {
            await handle.focus().catch(() => {});
            await handle.click().catch(() => {});
            await handle.evaluate(el => {
              el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
              el.dispatchEvent(new Event('focus', { bubbles: true }));
            }).catch(() => {});
            console.log(`[BankTransfer] Purpose select attempt ${attempt} — waiting for options`);

            await imPage.waitForFunction((h) => h.options.length > 1, { timeout: 4000 }, handle).catch(() => {});
            await imPage.keyboard.press('Escape').catch(() => {});
            await new Promise(r => setTimeout(r, 300));

            const opts = await handle.evaluate(el =>
              Array.from(el.options).map(o => ({ text: o.text.trim(), value: o.value }))
            ).catch(() => []);
            console.log(`[BankTransfer] Purpose options (attempt ${attempt}): ${JSON.stringify(opts)}`);

            otherOpt = opts.find(o => o.text.toLowerCase().includes('other'));
            if (otherOpt) break;
          }

          if (!otherOpt) { console.log('[BankTransfer] ⚠️ No "Other" option found after 3 attempts'); return false; }

          await handle.select(otherOpt.value);
          console.log(`[BankTransfer] ✅ Payment Purpose set to "${otherOpt.text}" (value="${otherOpt.value}")`);
          await new Promise(r => setTimeout(r, 400));
          return true;
        } catch (e) { console.log(`[BankTransfer] Purpose select err: ${e.message}`); }
        return false;
      })();
      // Scroll Continue button into view so Vision can see and click it
      await imPage.evaluate(() => {
        const all = Array.from(document.querySelectorAll('button, a'));
        const btn = all.find(e => (e.textContent || '').trim() === 'Continue' && e.getBoundingClientRect().width > 0);
        if (btn) btn.scrollIntoView({ block: 'center', behavior: 'instant' });
        else window.scrollTo(0, document.body.scrollHeight);
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 800));
      console.log('[BankTransfer] Post-account L1 fill done â€" Vision handles Continue/review/PIN');
      continue;
    }

    screenshot = await imPage.screenshot({ encoding: 'base64' }).catch(() => null);
    if (!screenshot) continue;

    const pageText = await imPage.evaluate(() => document.body.innerText).catch(() => '');
    const lower = pageText.toLowerCase();

    const isSuccess = lower.includes('payment success') || lower.includes('transaction successful') ||
                      lower.includes('transfer successful') || lower.includes('sent successfully') ||
                      lower.includes('transaction complete') || lower.includes("you've sent");
    if (isSuccess) {
      const refMatch = pageText.match(/reference\s*id\s*(?:number)?[:\s]+([A-Z0-9]{8,12})/i);
      if (refMatch) referenceId = refMatch[1].trim();
      console.log(`[BankTransfer] âœ… SUCCESS â€" Ref: ${referenceId}`);
      imWithdrawalRunning = false;
      return { success: true, screenshot: await imPage.screenshot({ encoding: 'base64' }).catch(() => screenshot), referenceId };
    }

    // â"€â"€ Pre-check: if currency dropdown is open, click KES directly â"€â"€â"€â"€â"€â"€â"€â"€â"€
    const openKES = await imPage.evaluate(() => {
      const all = Array.from(document.querySelectorAll('li, span, div, option, mat-option'));
      const leaf = all.filter(el => {
        if (el.children.length > 0) return false;
        const txt = (el.textContent || '').trim();
        if (txt !== 'KES') return false;
        const r = el.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0 && r.width < 200 && r.height < 60 && r.top > 50 && r.top < window.innerHeight)) return false;
        // Only match if EUR/USD also visible nearby (dropdown is truly open, not just selected state)
        const hasOtherCurrencies = Array.from(document.querySelectorAll('*')).some(e =>
          (e.textContent || '').trim() === 'EUR' && e.getBoundingClientRect().width > 0 && e.children.length === 0
        );
        return hasOtherCurrencies;
      });
      if (leaf[0]) { const r = leaf[0].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
      return null;
    }).catch(() => null);
    if (openKES) {
      // Dropdown is open â€" press K+Enter via OS keybd_event (type-ahead selects KES)
      const psKesVision = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Threading;
public class KesV { [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, int flags, int extra); public static void PressKey(byte vk) { keybd_event(vk,0,0,0); Thread.Sleep(80); keybd_event(vk,0,2,0); Thread.Sleep(80); } }
"@
[KesV]::PressKey(0x4B)
Start-Sleep -Milliseconds 400
[KesV]::PressKey(0x0D)
Write-Host "done"`;
      const psTmpV = require('path').join(require('os').tmpdir(), 'sp2p_kesv.ps1');
      require('fs').writeFileSync(psTmpV, psKesVision, 'utf8');
      await new Promise(resolve => { require('child_process').exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psTmpV}"`, { timeout: 5000 }, resolve); });
      console.log('[BankTransfer] âœ… KES selected via OS K+Enter (dropdown was open)');
      await new Promise(r => setTimeout(r, 800));
      continue;
    }

    const vRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 300,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshot } },
          { type: 'text', text: `You are controlling I&M Bank Local Transfers form. Look at the screenshot carefully and take ONE action.

TARGET PAYMENT:
- Debit account: ${traderImAccount || 'BONITO CHELUGET SAMOEI'} (choose account with higher KES balance)
- Bank: ${targetBank}
- Account number: ${accountNumber}
- Amount: KES ${amountInt}
- Reference: ${refStr}
- Payment mode: Pesalink (radio button)
- Payment purpose: Other

IMPORTANT: The following were already filled programmatically â€" do NOT re-fill them unless clearly wrong:
- "One-off Beneficiary" radio: ALREADY SELECTED
- Bank name: ALREADY SET to "${targetBank}"
- Account number: ALREADY TYPED (${accountNumber}) and Validated
- Amount: ALREADY SET to ${amountInt}
- Reference: ALREADY FILLED
- Pesalink radio: ALREADY SELECTED
- Payment Purpose: ALREADY SET to "Other"

CRITICAL: If the form still shows "Saved Beneficiary" selected OR any required field shows a validation error OR amount is empty → DO NOT click Continue. Instead return action="refill" so the bot can re-fill the form.

ALL form fields have been filled. Your ONLY jobs are:
1. If currency shows "-" → click the currency dropdown and select KES
2. If you see a green "Continue" button AND no red validation errors visible → click it
3. On review/confirmation screen → click "Submit" or "Confirm"
4. On PIN screen → action="type_pin"
5. After PIN → if you see "Okay" or "Complete" or "Done" button → click it. If not visible → action="scroll"
6. On success/completion screen → action="done"
7. If form has validation errors or fields are empty → action="refill"

If a button you need is not visible, return action="scroll" to scroll down.
DO NOT click Validate, DO NOT re-enter any fields.

Return ONLY JSON: {"screen":"form|account_list|review|pin|success","action":"click|type|type_pin|scroll|done","description":"what you are doing","value":"text if typing","x":NNN,"y":NNN}` },
        ]}],
      }),
    }).catch(() => null);

    if (!vRes?.ok) { await new Promise(r => setTimeout(r, 3000)); continue; }
    const vData = await vRes.json();
    let action = null;
    try { const m = (vData.content?.[0]?.text || '').match(/\{[\s\S]*\}/); if (m) action = JSON.parse(m[0]); } catch (_) {}
    if (!action) continue;

    console.log(`[BankTransfer] Step ${step}: screen="${action.screen}" action="${action.action}" desc="${action.description || ''}" val="${action.value || ''}"`);

    if (action.screen === 'success' || action.action === 'done') {
      imWithdrawalRunning = false;
      return { success: true, screenshot: await takeImSuccessScreenshot(imPage) || screenshot, referenceId };
    }
    if (action.action === 'refill') {
      console.log('[BankTransfer] Vision detected unfilled form — resetting formFilled to retry L1 fill');
      formFilled = false;
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }
    if (action.action === 'type_pin') {
      // Focus the PIN input first
      await imPage.evaluate(() => {
        const input = document.querySelector('input[type="password"], input[type="tel"]');
        if (input) { input.click(); input.focus(); }
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 300));
      for (const digit of String(imPin)) {
        await imPage.keyboard.press(digit);
        await new Promise(r => setTimeout(r, 150));
      }
      await new Promise(r => setTimeout(r, 800));
      // Click Complete immediately after PIN â€" don't wait for Vision to see it
      const completeClicked = await imPage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => (b.textContent || '').trim().toLowerCase() === 'complete');
        if (btn) { btn.scrollIntoView({ block: 'center', behavior: 'instant' }); btn.click(); return true; }
        return false;
      }).catch(() => false);
      if (completeClicked) console.log('[BankTransfer] âœ… PIN typed + Complete clicked');
      else console.log('[BankTransfer] âš ï¸ Complete button not found after PIN');
      await new Promise(r => setTimeout(r, 4000)); continue;
    }
    if (action.action === 'type' && action.value && action.x && action.y) {
      await imPage.mouse.click(action.x / imDpr, action.y / imDpr);
      await new Promise(r => setTimeout(r, 400));
      await imPage.keyboard.type(String(action.value), { delay: 40 });
      await new Promise(r => setTimeout(r, 800)); continue;
    }
    if (action.action === 'scroll') {
      // Try to find and click the target button via DOM â€" search inside modal first
      const domClicked = await imPage.evaluate((scrn) => {
        // Review screen: only Submit/Confirm inside the modal (NOT Continue from form behind)
        const reviewOnly = scrn === 'review';
        const container = document.querySelector('mat-dialog-container, [role="dialog"], .cdk-overlay-pane') || document.body;
        const btns = Array.from(container.querySelectorAll('button, a'));
        const target = btns.find(b => {
          const txt = (b.textContent || '').trim().toLowerCase();
          const r = b.getBoundingClientRect();
          if (r.width === 0) return false;
          if (reviewOnly) return txt === 'submit' || txt === 'confirm';
          return txt === 'submit' || txt === 'confirm' || txt === 'okay' || txt === 'ok' || txt === 'complete';
        });
        if (target) { target.scrollIntoView({ block: 'center', behavior: 'instant' }); target.click(); return (target.textContent || '').trim(); }
        return null;
      }, action.screen).catch(() => null);
      if (domClicked) {
        console.log(`[BankTransfer] âœ… DOM clicked "${domClicked}" instead of scrolling`);
        await new Promise(r => setTimeout(r, 3000));
      } else {
        await imPage.evaluate(() => window.scrollBy(0, 400)).catch(() => {});
        await new Promise(r => setTimeout(r, 800));
      }
      continue;
    }
    if (action.action === 'click' && action.x && action.y) {
      // For submit/confirm/continue on review screen, prefer DOM click over coordinates
      const desc = (action.description || '').toLowerCase();
      const isTransition = ['continue', 'submit', 'confirm', 'complete', 'okay'].some(w => desc.includes(w));
      if (isTransition && action.screen === 'review') {
        const domClicked = await imPage.evaluate(() => {
          // Search inside modal container only to avoid clicking form buttons behind the overlay
          const container = document.querySelector('mat-dialog-container, [role="dialog"], .cdk-overlay-pane') || document.body;
          const btns = Array.from(container.querySelectorAll('button, a'));
          const target = btns.find(b => {
            const txt = (b.textContent || '').trim().toLowerCase();
            return (txt === 'submit' || txt === 'confirm') && b.getBoundingClientRect().width > 0;
          });
          if (target) { target.scrollIntoView({ block: 'center', behavior: 'instant' }); target.click(); return (target.textContent || '').trim(); }
          return null;
        }).catch(() => null);
        if (domClicked) {
          console.log(`[BankTransfer] âœ… DOM clicked "${domClicked}" on review screen`);
          await new Promise(r => setTimeout(r, 3500)); continue;
        }
      }
      await imPage.mouse.click(action.x / imDpr, action.y / imDpr);
      const isTransition2 = ['continue', 'submit', 'confirm', 'complete'].some(w => desc.includes(w));
      // After clicking account dropdown row, try L1 CDK overlay selection before waiting
      if (action.screen === 'account_list' || desc.includes('bonito') || desc.includes('account') && desc.includes('row')) {
        await new Promise(r => setTimeout(r, 1500));
        // Try L1 CDK click in case Vision coords weren't precise
        const l1Picked = await imPage.evaluate((preferred) => {
          const overlay = document.querySelector('.cdk-overlay-container');
          if (!overlay) return null;
          const opts = Array.from(overlay.querySelectorAll('mat-option, .mat-option, [role="option"]'));
          for (const opt of opts) {
            const txt = (opt.textContent || '').trim();
            if (txt.toUpperCase().includes((preferred || 'BONITO CHELUGET').toUpperCase())) {
              const r = opt.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) { opt.click(); return txt.substring(0, 60); }
            }
          }
          return null;
        }, traderImAccount).catch(() => null);
        if (l1Picked) console.log(`[BankTransfer] âœ… L1 CDK account selected after Vision click: ${l1Picked}`);
        await new Promise(r => setTimeout(r, 1500));
      } else {
        await new Promise(r => setTimeout(r, isTransition2 ? 3500 : 1000));
      }
      continue;
    }
  }

  imWithdrawalRunning = false;
  console.log(`[BankTransfer] âŒ Exceeded ${IM_MAX_STEPS} steps`);
  return { success: false, screenshot: await imPage.screenshot({ encoding: 'base64' }).catch(() => null), referenceId: null };
}

// â"€â"€ Pause buy ad and notify trader when seller hasn't released after payment â"€â"€
// The trader will manually handle the appeal on Binance.
// Steps: navigate to My Ads → find the BUY ad → toggle it offline → notify trader.
async function pauseBuyAdAndNotify(page, orderNumber, orderDetails) {
  const { sellerName = 'Unknown', amount = 0 } = orderDetails || {};
  console.log(`[SparkP2P] â¸ï¸  Pausing buy ad for order ${orderNumber} â€" seller ${sellerName} has not released`);

  // Step 1: Navigate to My Ads and take the BUY ad offline
  let adPaused = false;
  try {
    await page.goto(MY_ADS_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));

    // The My Ads page shows each ad as a table row with a Status column.
    // Status shows "Online" text + a small icon right next to it â€" clicking
    // that icon shows an "Offline" tooltip and toggles the ad offline.
    // We find the BUY row, locate the element whose text is exactly "Online",
    // then click the icon/span sitting immediately beside it.
    adPaused = await page.evaluate(() => {
      // Walk every element looking for one whose direct text is "Online"
      // that lives inside a row also containing the word "Buy"
      const allEls = Array.from(document.querySelectorAll('*'));
      for (const el of allEls) {
        // Must have "Online" as its own visible text (not children text)
        const directText = Array.from(el.childNodes)
          .filter(n => n.nodeType === 3)
          .map(n => n.textContent.trim())
          .join('');
        if (directText !== 'Online') continue;

        // Confirm this element is inside the BUY ad row
        const row = el.closest('tr') || el.closest('[class*="table-row"]') ||
                    el.closest('[class*="adItem"]') || el.parentElement?.parentElement;
        if (!row) continue;
        if (!row.textContent.includes('Buy')) continue;

        // The clickable offline icon is the next sibling element of the "Online" span
        const icon = el.nextElementSibling || el.querySelector('span, svg, i');
        if (icon) { icon.click(); return true; }
        // Last resort â€" click the container of "Online"
        el.parentElement?.click();
        return true;
      }
      return false;
    });

    if (adPaused) {
      console.log('[SparkP2P] âœ… Buy ad toggled offline');
    } else {
      console.log('[SparkP2P] âš ï¸  Buy ad Online icon not found â€" may already be offline');
    }
    await new Promise(r => setTimeout(r, 1500));
  } catch (e) {
    console.log(`[SparkP2P] pauseBuyAd navigation error: ${e.message}`);
  }

  // Step 2: Report to backend â€" triggers email, SMS, and in-app notification to trader
  try {
    await fetch(`${API_BASE}/ext/report-buy-expired`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        order_number: orderNumber,
        seller_name: sellerName,
        amount,
        minutes_waited: buyPaymentSentAt[orderNumber]
          ? Math.floor((Date.now() - buyPaymentSentAt[orderNumber]) / 60000)
          : 15,
      }),
    }).catch(() => {});
    console.log('[SparkP2P] Trader notified via backend (email + SMS + in-app)');
  } catch (e) {
    console.log(`[SparkP2P] Notification failed: ${e.message}`);
  }
}

async function sendBinanceChatMessage(page, message) {
  // Delegate to sendChatMessage which handles React native setter + send button click correctly
  try {
    // Wait up to 10s for the chat panel to render before handing off
    let chatInput = null;
    for (let i = 0; i < 5; i++) {
      chatInput = await page.$('[placeholder*="message" i], [placeholder*="Enter message" i], [placeholder*="Type" i], textarea, div[contenteditable="true"]');
      if (chatInput) break;
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!chatInput) { console.log('[SparkP2P] Chat input not found after retries'); return false; }
    return await sendChatMessage(page, message);
  } catch (e) {
    console.log('[SparkP2P] Chat send error:', e.message);
    return false;
  }
}

// Returns { uploaded: bool, confirmed: bool }
// Flow: "Upload Payment Proof" btn → Payment Confirmation modal opens →
//       click circular upload icon inside modal → file picker → upload →
//       check "I have made the transfer" checkbox → Confirm
async function uploadPaymentProofToBinance(page, screenshotBase64) {
  const result = { uploaded: false, confirmed: false };
  let tmpPath = null;
  try {
    tmpPath = path.join(app.getPath('temp'), `im_receipt_${Date.now()}.jpg`);
    // Resize to 480px wide JPEG â€" fits any mobile screen without horizontal scrolling
    try {
      const { nativeImage } = require('electron');
      const img = nativeImage.createFromBuffer(Buffer.from(screenshotBase64, 'base64'));
      const size = img.getSize();
      const targetW = Math.min(480, size.width);
      const scale = targetW / size.width;
      const resized = img.resize({ width: targetW, height: Math.round(size.height * scale), quality: 'good' });
      fs.writeFileSync(tmpPath, resized.toJPEG(88));
      console.log(`[SparkP2P] Receipt: ${size.width}x${size.height} → ${targetW}x${Math.round(size.height * scale)} JPEG`);
    } catch (e) {
      console.log('[SparkP2P] nativeImage resize failed, using original:', e.message);
      tmpPath = path.join(app.getPath('temp'), `im_receipt_${Date.now()}.png`);
      fs.writeFileSync(tmpPath, Buffer.from(screenshotBase64, 'base64'));
    }

    // â"€â"€ Step A: Open the Payment Confirmation modal if not already open â"€â"€â"€â"€â"€â"€
    const modalAlreadyOpen = await page.evaluate(() =>
      !!document.querySelector('[class*="modal" i], [class*="dialog" i], [role="dialog"]') &&
      document.body.innerText.toLowerCase().includes('payment confirmation')
    ).catch(() => false);

    if (!modalAlreadyOpen) {
      const allBtns = await page.$$('button, [role="button"]');
      let uploadBtn = null;
      for (const btn of allBtns) {
        const txt = await page.evaluate(el => el.textContent, btn).catch(() => '');
        const tl = txt.toLowerCase();
        if (tl.includes('upload') || tl.includes('payment proof') ||
            tl.includes('transferred') || tl.includes('notify seller') || tl.includes('i have paid')) {
          uploadBtn = btn;
          break;
        }
      }
      if (!uploadBtn) { console.log('[SparkP2P] Payment Confirmation button not found — skipping modal upload'); return result; }
      await uploadBtn.click();
      console.log('[SparkP2P] Clicked payment button — waiting for modal...');
      await new Promise(r => setTimeout(r, 2500));
    } else {
      console.log('[SparkP2P] Payment Confirmation modal already open');
    }

    // â"€â"€ Step B: Click the "Upload" icon INSIDE the modal → FileChooser â"€â"€â"€â"€â"€â"€â"€â"€
    // Inject file into Binance modal using React-compatible DataTransfer
    // uploadFile() via CDP does not fire React's synthetic onChange — use base64 DataTransfer instead
    let uploaded = false;
    try {
      const fileBuffer = fs.readFileSync(tmpPath);
      const fileBase64 = fileBuffer.toString('base64');
      const fileName = require('path').basename(tmpPath);

      const reactUploaded = await page.evaluate(({ b64, name }) => {
        // Find the hidden file input inside the modal
        const input = document.querySelector('[role="dialog"] input[type="file"]') ||
                      document.querySelector('[class*="modal" i] input[type="file"]') ||
                      document.querySelector('input[type="file"]');
        if (!input) return false;
        // Build a File object from base64 data inside the browser context
        const binStr = atob(b64);
        const bytes = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
        const file = new File([bytes], name, { type: 'image/jpeg', lastModified: Date.now() });
        // Attach via DataTransfer so React sees it
        const dt = new DataTransfer();
        dt.items.add(file);
        Object.defineProperty(input, 'files', { value: dt.files, configurable: true });
        // Fire events React listens to
        input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        input.dispatchEvent(new InputEvent('input', { bubbles: true }));
        return true;
      }, { b64: fileBase64, name: fileName }).catch(() => false);

      if (reactUploaded) {
        uploaded = true;
        console.log('[SparkP2P] File injected via DataTransfer (React-compatible, no OS dialog)');
        await new Promise(r => setTimeout(r, 2500)); // wait for Binance to show preview
      } else {
        // L2: click the upload icon and intercept FileChooser
        const uploadIconCoords = await page.evaluate(() => {
          const selectors = [
            '[role="dialog"] label', '[role="dialog"] button',
            '[class*="modal" i] label', '[class*="modal" i] button',
            '[class*="upload" i]',
          ];
          for (const sel of selectors) {
            for (const el of Array.from(document.querySelectorAll(sel))) {
              const txt = (el.textContent || '').trim().toLowerCase();
              if ((txt === 'upload' || (txt.includes('upload') && txt.length < 15)) &&
                  !txt.includes('proof') && !txt.includes('confirm')) {
                const r = el.getBoundingClientRect();
                if (r.width > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
              }
            }
          }
          return null;
        }).catch(() => null);

        if (uploadIconCoords) {
          const [fileChooser] = await Promise.all([
            page.waitForFileChooser({ timeout: 8000 }),
            page.mouse.click(uploadIconCoords.x, uploadIconCoords.y),
          ]);
          await fileChooser.accept([tmpPath]);
          uploaded = true;
          console.log('[SparkP2P] Upload icon clicked via FileChooser fallback');
          await new Promise(r => setTimeout(r, 2500));
        } else {
          console.log('[SparkP2P] Upload input/icon not found inside modal');
        }
      }
    } catch (e) {
      console.log('[SparkP2P] Modal upload error:', e.message);
    }
    if (!uploaded) { console.log('[SparkP2P] Could not upload inside modal'); return result; }
    result.uploaded = true;

    // â"€â"€ Step C: Wait for preview, then click checkbox via mouse coords + Confirm â"€
    await new Promise(r => setTimeout(r, 3000));

    // â"€â"€ Checkbox click: Layer 1 DOM → Layer 2 Vision â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    const pageDpr = await page.evaluate(() => window.devicePixelRatio || 1).catch(() => 1);
    let cbClicked = false;

    // Layer 1: DOM â€" find the small visible checkbox square element
    const cbCoords = await page.evaluate(() => {
      // Try small square spans used by Ant Design / Binance checkboxes
      const squares = Array.from(document.querySelectorAll(
        '[class*="checkbox-inner"], [class*="checkmark"], [class*="check-inner"]'
      ));
      for (const el of squares) {
        const r = el.getBoundingClientRect();
        if (r.width >= 12 && r.width <= 32 && r.height >= 12 && r.top > 100)
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      // Try immediate parent of hidden checkbox input
      for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
        const p = cb.parentElement;
        if (p) {
          const r = p.getBoundingClientRect();
          if (r.width >= 12 && r.width <= 40 && r.height >= 12 && r.top > 100)
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      return null;
    }).catch(() => null);

    if (cbCoords) {
      await page.mouse.click(cbCoords.x, cbCoords.y);
      console.log('[SparkP2P] âœ… Checkbox clicked via Layer 1 DOM');
      cbClicked = true;
      await new Promise(r => setTimeout(r, 600));
    }

    // Layer 2: Vision â€" take screenshot and ask Claude Haiku for exact checkbox coordinates
    if (!cbClicked && anthropicApiKey) {
      const cbSS = await page.screenshot({ encoding: 'base64' }).catch(() => null);
      if (cbSS) {
        const cbRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 100,
            messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: cbSS } },
              { type: 'text', text: 'Find the small unchecked checkbox square (empty square box) in the Payment Confirmation modal next to the text "I have made the transfer". Return ONLY the center pixel coordinates of that checkbox square as JSON: {"x": number, "y": number}' },
            ]}],
          }),
        }).catch(() => null);
        if (cbRes?.ok) {
          const cbData = await cbRes.json();
          const match = (cbData.content?.[0]?.text || '').match(/\{[\s\S]*?\}/);
          if (match) {
            try {
              const { x, y } = JSON.parse(match[0]);
              if (x > 0 && y > 0) {
                await page.mouse.click(x / pageDpr, y / pageDpr);
                console.log(`[SparkP2P] âœ… Checkbox clicked via Layer 2 Vision at (${x}/${pageDpr}, ${y}/${pageDpr})`);
                cbClicked = true;
                await new Promise(r => setTimeout(r, 600));
              }
            } catch (_) {}
          }
        }
      }
    }

    if (!cbClicked) console.log('[SparkP2P] âš ï¸ Checkbox not found â€" confirming anyway');

    // â"€â"€ Confirm button: Layer 1 DOM → Layer 2 Vision â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    let confirmClicked = false;

    // Layer 1: DOM â€" find Confirm button inside the modal by text
    const confirmCoords = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const btn of btns) {
        const txt = (btn.textContent || '').trim().toLowerCase();
        if (txt === 'confirm' || txt === 'submit' || txt === 'yes') {
          const r = btn.getBoundingClientRect();
          if (r.width > 0 && r.top > 100) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      return null;
    }).catch(() => null);

    if (confirmCoords) {
      await page.mouse.click(confirmCoords.x, confirmCoords.y);
      console.log('[SparkP2P] âœ… Confirm clicked via Layer 1 DOM');
      confirmClicked = true;
    }

    // Layer 2: Vision â€" screenshot → Claude Haiku finds the Confirm button
    if (!confirmClicked && anthropicApiKey) {
      const cfSS = await page.screenshot({ encoding: 'base64' }).catch(() => null);
      if (cfSS) {
        const cfRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 100,
            messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: cfSS } },
              { type: 'text', text: 'Find the yellow "Confirm" button in the Payment Confirmation modal. Return ONLY its center pixel coordinates as JSON: {"x": number, "y": number}' },
            ]}],
          }),
        }).catch(() => null);
        if (cfRes?.ok) {
          const cfData = await cfRes.json();
          const match = (cfData.content?.[0]?.text || '').match(/\{[\s\S]*?\}/);
          if (match) {
            try {
              const { x, y } = JSON.parse(match[0]);
              if (x > 0 && y > 0) {
                await page.mouse.click(x / pageDpr, y / pageDpr);
                console.log(`[SparkP2P] âœ… Confirm clicked via Layer 2 Vision at (${x}/${pageDpr}, ${y}/${pageDpr})`);
                confirmClicked = true;
              }
            } catch (_) {}
          }
        }
      }
    }

    if (confirmClicked) {
      result.confirmed = true;
      console.log('[SparkP2P] âœ… Payment proof uploaded and Confirmed');
      await new Promise(r => setTimeout(r, 2000));
      await handleSecurityVerification(page);
    } else {
      console.log('[SparkP2P] âš ï¸ Could not click Confirm button');
    }

    return result;
  } catch (e) {
    console.log('[SparkP2P] Upload proof error:', e.message);
    return result;
  } finally {
    if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (_) {} }
  }
}

const buyLastSellerMsg     = {}; // orderNum → last seller message text we replied to (prevents duplicate replies)
const buyLastChatCheckAt   = {}; // orderNum → timestamp of last respondToBuyOrderChat Claude call (rate-limit)
let _cycleVision = 0; // Claude vision calls this scan cycle (reset each idleScan)
let _cycleDom    = 0; // Free DOM detections this scan cycle (reset each idleScan)

// Send an image file directly in the Binance P2P chat (not via the Payment Proof modal)
async function sendImageInBinanceChat(page, screenshotBase64) {
  let tmpPath = null;
  try {
    // Resize to 480px wide JPEG â€" fits any mobile screen without horizontal scrolling
    tmpPath = path.join(app.getPath('temp'), `chat_img_${Date.now()}.jpg`);
    try {
      const { nativeImage } = require('electron');
      const img = nativeImage.createFromBuffer(Buffer.from(screenshotBase64, 'base64'));
      const size = img.getSize();
      const targetW = Math.min(480, size.width);
      const scale = targetW / size.width;
      const resized = img.resize({ width: targetW, height: Math.round(size.height * scale), quality: 'good' });
      fs.writeFileSync(tmpPath, resized.toJPEG(88));
      console.log(`[SparkP2P] Chat img: ${size.width}x${size.height} → ${targetW}x${Math.round(size.height * scale)} JPEG`);
    } catch (e) {
      tmpPath = path.join(app.getPath('temp'), `chat_img_${Date.now()}.png`);
      fs.writeFileSync(tmpPath, Buffer.from(screenshotBase64, 'base64'));
    }

    // Find the image/attachment button in the chat input area
    // Binance chat has a small image icon (ðŸ"·) to the left of the text input
    const pageDpr = await page.evaluate(() => window.devicePixelRatio || 1).catch(() => 1);

    const attachCoords = await page.evaluate(() => {
      // Look for image/attachment button near the chat input area
      const selectors = [
        'label[for*="upload" i]', 'label[for*="image" i]', 'label[for*="file" i]',
        'input[type="file"] + label', '[class*="chat" i] label',
        '[class*="upload" i]:not([class*="modal" i]):not([class*="dialog" i])',
        '[class*="attach" i]', '[class*="image-upload" i]',
        'svg[class*="camera" i]', 'svg[class*="photo" i]',
      ];
      for (const sel of selectors) {
        const els = Array.from(document.querySelectorAll(sel));
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.width < 60 && r.height > 0 && r.height < 60) {
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
        }
      }
      // Fallback: find any small clickable element next to the chat textarea
      const textarea = document.querySelector('[placeholder*="message" i], [placeholder*="Enter message" i], textarea');
      if (!textarea) return null;
      const tr = textarea.getBoundingClientRect();
      // Look for small elements (icons) in the same row as the textarea
      const candidates = Array.from(document.querySelectorAll('button, label, [role="button"], svg'));
      for (const el of candidates) {
        const r = el.getBoundingClientRect();
        if (r.width > 5 && r.width < 50 && Math.abs(r.top - tr.top) < 40 && r.left < tr.left) {
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      return null;
    }).catch(() => null);

    if (attachCoords) {
      // Click the attachment button and intercept the FileChooser
      const [fileChooser] = await Promise.all([
        page.waitForFileChooser({ timeout: 5000 }),
        page.mouse.click(attachCoords.x / pageDpr, attachCoords.y / pageDpr),
      ]).catch(() => [null]);

      if (fileChooser) {
        await fileChooser.accept([tmpPath]);
        await new Promise(r => setTimeout(r, 2000));
        // Press Enter to send (some Binance versions auto-send, some need confirmation)
        await page.keyboard.press('Enter').catch(() => {});
        await new Promise(r => setTimeout(r, 1500));
        console.log('[SparkP2P] âœ… Screenshot sent directly in chat');
        return true;
      }
    }

    // Vision fallback: ask Claude to find the image/camera icon in the chat
    const chatSS = await page.screenshot({ encoding: 'base64' }).catch(() => null);
    if (chatSS && anthropicApiKey) {
      const vRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001', max_tokens: 80,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: chatSS } },
            { type: 'text', text: 'Find the image/camera/attachment icon in the chat input area (NOT the upload proof button â€" the small icon next to the message text box at the bottom of the page). Return its center coordinates as JSON: {"x":NNN,"y":NNN}. If not found return {"x":0,"y":0}' },
          ]}],
        }),
      }).catch(() => null);
      if (vRes?.ok) {
        const vd = await vRes.json();
        const vm = (vd.content?.[0]?.text || '').match(/\{[\s\S]*?\}/);
        let vc = null; try { if (vm) vc = JSON.parse(vm[0]); } catch (_) {}
        if (vc?.x && vc?.y && vc.x > 0) {
          const [fileChooser2] = await Promise.all([
            page.waitForFileChooser({ timeout: 5000 }),
            page.mouse.click(vc.x / pageDpr, vc.y / pageDpr),
          ]).catch(() => [null]);
          if (fileChooser2) {
            await fileChooser2.accept([tmpPath]);
            await new Promise(r => setTimeout(r, 2000));
            await page.keyboard.press('Enter').catch(() => {});
            await new Promise(r => setTimeout(r, 1500));
            console.log('[SparkP2P] âœ… Screenshot sent in chat via Vision');
            return true;
          }
        }
      }
    }

    console.log('[SparkP2P] âš ï¸ Could not find chat image button â€" screenshot not sent in chat');
    return false;
  } catch (e) {
    console.log('[SparkP2P] sendImageInBinanceChat error:', e.message);
    return false;
  } finally {
    if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (_) {} }
  }
}

async function respondToBuyOrderChat(page, orderDetails) {
  try {
    const orderNum = orderDetails.orderNumber;
    const isFirstCheck = !(orderNum in buyLastSellerMsg);
    const CHAT_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes between vision calls for same order
    const msSinceLastCheck = Date.now() - (buyLastChatCheckAt[orderNum] || 0);

    if (!isFirstCheck && msSinceLastCheck < CHAT_CHECK_INTERVAL) {
      console.log(`[SparkP2P] respondToBuyOrderChat: skipping Claude — checked ${Math.floor(msSinceLastCheck / 1000)}s ago (limit 5min)`);
      return;
    }
    buyLastChatCheckAt[orderNum] = Date.now();

    const ss = await page.screenshot({ encoding: 'base64' }).catch(() => null);
    if (!ss || !anthropicApiKey) return;
    const minutesSincePayment = buyPaymentSentAt[orderNum]
      ? Math.floor((Date.now() - buyPaymentSentAt[orderNum]) / 60000) : null;
    const timePhrase = minutesSincePayment !== null ? `${minutesSincePayment} minute(s) ago` : 'earlier';

    const prompt = `You are an AI assistant managing a Binance P2P buy order on behalf of the BUYER. Your goal is to get the seller to release the crypto after confirming they received payment.

Look at this screenshot of a Binance P2P order detail page. Find the chat panel on the right side of the screen.

Payment already sent:
- Amount: KSh ${orderDetails.amount}
- To: ${orderDetails.name} (${orderDetails.phone || 'N/A'})
- Via: ${orderDetails.method || 'M-Pesa'}
- M-Pesa Ref: ${orderDetails.referenceId || 'N/A'}
- Sent: ${timePhrase}

STEP 1 — Identify the last message:
- Seller messages are on the LEFT side of the chat panel
- Our messages (buyer) are on the RIGHT side (usually highlighted/colored)
- Extract the exact text of the seller's last visible message as "lastSellerText"
- If the last message is ours (right side) or is a system notification, set lastSellerText to "" and action to "none"

STEP 2 — Decide how to respond to the seller's message:
Use your judgment to compose a natural, professional reply (max 2 sentences). You have full context of the payment details above. Guidelines:
- Proof/confirmation requests → share the M-Pesa ref and amount, ask them to check and release
- Wants the ref typed out (can't read screenshot) → type it clearly: "Ref: ${orderDetails.referenceId || 'N/A'}, Amount: KSh ${orderDetails.amount}, To: ${orderDetails.name}"
- Wants another screenshot (blurry/unclear) → action: "resend_screenshot", message: "Sure, let me send a clearer one."
- Wants both typed details AND a new screenshot → action: "reply_and_resend"
- Asking how long / still waiting → reassure them, mention the ref and that it was sent ${timePhrase}
- Off-topic or business proposals (e.g. future trades, volume deals, personal contact) → politely decline and redirect: "Thanks! For now, please confirm receipt and release this order. We can explore future trades through the platform."
- Threats, pressure, or suspicious requests → stay calm and firm: "Payment has been sent. M-Pesa Ref: ${orderDetails.referenceId || 'N/A'}. Please check your account and release."
- Seller said thanks / already releasing / order done → action: "none"
- No unanswered seller message → action: "none"

Return ONLY valid JSON with this exact structure:
{
  "action": "reply" | "resend_screenshot" | "reply_and_resend" | "none",
  "message": "the reply to send (empty string if action is none or resend_screenshot only)",
  "lastSellerText": "exact text of seller's last message, or empty string"
}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
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
    const action = result.action || 'none';
    const replyMsg = (result.message || '').trim();
    const lastSellerText = (result.lastSellerText || '').trim();

    console.log(`[SparkP2P] Chat AI decision: action="${action}" lastSellerText="${lastSellerText.substring(0, 60)}" msg="${replyMsg.substring(0, 60)}"`);

    // Dedup: skip if we already replied to this exact seller message
    if (lastSellerText && buyLastSellerMsg[orderNum] === lastSellerText) {
      console.log(`[SparkP2P] Already replied to seller message — skipping`);
      return;
    }

    if (action === 'none') {
      if (lastSellerText) buyLastSellerMsg[orderNum] = lastSellerText;
      return;
    }

    // Resolve name — buyOrderDetailsMap stores it as sellerName, fallback objects use name
    const sellerName = orderDetails.name || orderDetails.sellerName || 'the seller';

    // Send text reply first if there is one
    if ((action === 'reply' || action === 'reply_and_resend') && replyMsg) {
      await sendBinanceChatMessage(page, replyMsg);
      await new Promise(r => setTimeout(r, 1000));
    }

    // Re-send screenshot directly in chat if needed
    if (action === 'resend_screenshot' || action === 'reply_and_resend') {
      // Check all screenshot sources: in-memory map, orderDetails (pd already has screenshot field)
      const storedScreenshot = imPaymentDoneMap[orderNum]?.screenshot || orderDetails.screenshot || null;

      if (storedScreenshot) {
        // Only announce "let me send a clearer screenshot" when we actually have one to send
        if (action === 'resend_screenshot' && replyMsg) {
          await sendBinanceChatMessage(page, replyMsg);
          await new Promise(r => setTimeout(r, 1000));
        }
        const sent = await sendImageInBinanceChat(page, storedScreenshot);
        if (sent) {
          console.log(`[SparkP2P] ✅ Re-sent payment screenshot in chat for order ${orderNum}`);
        } else {
          // Image send failed — fall back to typed details
          await sendBinanceChatMessage(page, `M-Pesa Ref: ${orderDetails.referenceId || 'N/A'} | Amount: KSh ${orderDetails.amount} | Sent to: ${sellerName} (${orderDetails.phone || 'N/A'}). Please check your M-Pesa and release. 🙏`);
        }
      } else {
        // No screenshot stored — skip the "let me send" preamble; just type the details clearly
        await sendBinanceChatMessage(page, `Payment details — M-Pesa Ref: ${orderDetails.referenceId || 'N/A'}, Amount: KSh ${orderDetails.amount}, Sent to: ${sellerName} (${orderDetails.phone || 'N/A'}). Kindly check your M-Pesa statement and release. 🙏`);
      }
    }

    if (lastSellerText) buyLastSellerMsg[orderNum] = lastSellerText;
  } catch (e) {
    console.log('[SparkP2P] Chat response error:', e.message);
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// I&M BANK AUTOMATION
// Opens as a new tab in the existing Binance browser â€" one browser, all tabs
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// Navigate to dashboard â€" triggers OAuth redirect to login page with correct PKCE params
const IM_URL = 'https://digital.imbank.com/inm-retail/dashboard';
const IM_TRANSFERS_URL = 'https://digital.imbank.com/inm-retail/transfers';
const IM_KEEP_ALIVE_INTERVAL = 60 * 1000; // ping every 1 min to prevent session timeout
let imKeepAliveTimer = null;
let imRecoveryTimer = null;

async function connectIm() {
  if (connectingIm) return;
  connectingIm = true;
  console.log('[SparkP2P] Opening I&M Bank tab...');
  try {
    // Ensure main browser is running â€" launch if needed
    if (!browser) {
      await launchChrome(IM_URL);
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
      // Restore saved session cookies before navigating â€" avoids login page if session still valid
      const savedCookies = loadImCookiesLocal();
      if (savedCookies) {
        await restoreCookiesToPage(imPage, savedCookies, 'https://digital.imbank.com');
        console.log('[SparkP2P] I&M saved session cookies restored â€" attempting silent reconnect');
      }
      await imPage.goto(IM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    await imPage.bringToFront();
    imPage.on('close', () => { imPage = null; });

    // Poll until Claude Vision confirms login — or 2 min of failures triggers offline mode
    let attempts = 0;
    let loginPageStreak = 0;
    let verifying = false;
    let navListenerDone = false;
    const IM_OFFLINE_THRESHOLD = 40; // 40 × 3s = 2 minutes of consecutive LOGIN_PAGE/error

    const onImLoggedIn = async () => {
      navListenerDone = true; // stop nav listener from double-firing
      console.log('[SparkP2P] I&M login confirmed by Vision! Syncing cookies...');
      await syncImCookies();
      const freshCookies = await imPage.cookies('https://digital.imbank.com').catch(() => []);
      if (freshCookies.length) saveImCookiesLocal(freshCookies);
      startImKeepAlive();
      // Only lock if M-Pesa portal is already confirmed connected.
      // If M-Pesa hasn't connected yet (connecting or not started), skip —
      // the M-Pesa handler calls lockChromeBrowser() when it finishes.
      if (mpesaPortalReady) await lockChromeBrowser().catch(() => {});
      connectingIm = false;
      mainWindow.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("im-connected"))').catch(() => {});
      sendBotLog('success', 'I&M Bank portal connected');
      // Always switch Chrome focus back to Binance — even if poller was already running
      const binancePage = await getPage('binance.com').catch(() => null);
      if (binancePage) await binancePage.bringToFront().catch(() => {});
      const setup = await checkSetupComplete();
      if (setup.complete && !pollerRunning) {
        pauseNavigation = false;
        mainWindow.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("setup-complete"))').catch(() => {});
        console.log('[SparkP2P] I&M logged in — starting scanner');
        sendBotLog('success', 'I&M connected — starting scanner');
        await initialScan().catch(e => { scanningInProgress = false; console.error('[SparkP2P] Initial scan error:', e.message?.substring(0, 60)); });
        startPoller();
      }
    };

    const declareImOffline = async () => {
      clearInterval(check);
      connectingIm = false;
      console.log('[SparkP2P] I&M offline — notifying trader and starting bot on Binance only');
      sendBotLog('warning', 'I&M Bank offline — bot running on Binance only');
      // Notify trader
      if (token) {
        await fetch(`${API_BASE}/ext/notify-trader`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ message: 'I&M digital platform seems to be offline. I am unable to connect to it. The bot will continue processing sell orders on Binance. Please contact your bank for more clarifications.' }),
        }).catch(() => {});
      }
      // Always switch Chrome focus back to Binance
      const binanceFallback = await getPage('binance.com').catch(() => null);
      if (binanceFallback) await binanceFallback.bringToFront().catch(() => {});
      // Start bot on Binance immediately — don't wait for I&M
      if (!pollerRunning) {
        pauseNavigation = false;
        mainWindow.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("setup-complete"))').catch(() => {});
        await initialScan().catch(e => { scanningInProgress = false; console.error('[SparkP2P] Initial scan error:', e.message?.substring(0, 60)); });
        startPoller();
      }
      // Start 5-min recovery poller to detect when I&M comes back
      startImRecoveryPoller();
    };

    const check = setInterval(async () => {
      attempts++;
      if (attempts > 600) { clearInterval(check); connectingIm = false; return; }
      if (verifying) return;
      try {
        if (!imPage || imPage.isClosed()) { clearInterval(check); connectingIm = false; return; }
        const url = imPage.url();
        if (url.includes('/openid-connect/') || url.includes('/auth/realms/')) {
          loginPageStreak++;
        } else if (!url.includes('imbank.com')) {
          loginPageStreak++;
        } else {
          // Check for 502/server error via page text before calling Vision
          const pageText = await imPage.evaluate(() => document.body?.innerText || '').catch(() => '');
          const isServerError = /bad gateway|502|503|service unavailable|upstream/i.test(pageText);
          if (isServerError) {
            loginPageStreak++;
            console.log(`[SparkP2P] I&M server error detected (streak: ${loginPageStreak})`);
            if (loginPageStreak >= IM_OFFLINE_THRESHOLD) { await declareImOffline(); return; }
            // Reload page every 2 minutes while waiting
            if (loginPageStreak % 40 === 0) {
              await imPage.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            }
            return;
          }

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
            await onImLoggedIn();
          } else {
            loginPageStreak++;
            if (loginPageStreak >= IM_OFFLINE_THRESHOLD) { await declareImOffline(); }
          }
        }

        if (loginPageStreak >= IM_OFFLINE_THRESHOLD) { await declareImOffline(); }
      } catch (e) { verifying = false; }
    }, 3000);

    // Instant-detect listener: fires the moment the user's browser navigates to I&M dashboard.
    // This survives declareImOffline() so a late login (after 2-min window) is caught immediately
    // without waiting for the 5-minute recovery poller.
    let navVerifying = false;
    const onImNav = async (frame) => {
      if (navListenerDone || navVerifying) return;
      if (!imPage || frame !== imPage.mainFrame()) return;
      const url = frame.url();
      const isDashboard = url.includes('imbank.com') &&
        !url.includes('/openid-connect/') &&
        !url.includes('/auth/realms/') &&
        !url.includes('login') &&
        !url.includes('Login');
      if (!isDashboard) return;
      navVerifying = true;
      await new Promise(r => setTimeout(r, 2000)); // let page render
      if (!imPage || imPage.isClosed() || navListenerDone) { navVerifying = false; return; }
      try {
        const ss = await imPage.screenshot({ encoding: 'base64' }).catch(() => null);
        if (!ss || !anthropicApiKey) { navVerifying = false; return; }
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001', max_tokens: 50,
            messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ss } },
              { type: 'text', text: 'Is this an I&M Bank online banking dashboard showing account information (logged in)? Or is it a login/QR code screen? Reply with only: LOGGED_IN or LOGIN_PAGE' },
            ]}],
          }),
        });
        const d = await resp.json();
        const verdict = (d.content?.[0]?.text || '').trim().toUpperCase();
        console.log(`[SparkP2P] I&M nav-listener Vision check: ${verdict}`);
        if (verdict === 'LOGGED_IN') {
          imPage.off('framenavigated', onImNav);
          clearInterval(check);
          if (imRecoveryTimer) { clearInterval(imRecoveryTimer); imRecoveryTimer = null; }
          await onImLoggedIn();
        }
      } catch (e) { console.log('[SparkP2P] I&M nav-listener error:', e.message); }
      navVerifying = false;
    };
    imPage.on('framenavigated', onImNav);

  } catch (e) {
    console.log('[SparkP2P] I&M connect error:', e.message);
    connectingIm = false;
  }
}

function startImRecoveryPoller() {
  if (imRecoveryTimer) return; // already polling
  console.log('[SparkP2P] I&M recovery poller started — checking every 5 minutes');
  imRecoveryTimer = setInterval(async () => {
    try {
      if (!imPage || imPage.isClosed()) return;
      const currentUrl = imPage.url();
      // Only reload if stuck on login/error page — don't disrupt an active or in-progress session
      const onLoginOrError = currentUrl.includes('/openid-connect/') || currentUrl.includes('/auth/realms/') ||
        currentUrl.includes('login') || !currentUrl.includes('imbank.com');
      if (onLoginOrError) {
        await imPage.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 2000));
      }
      const url = imPage.url();
      const pageText = await imPage.evaluate(() => document.body?.innerText || '').catch(() => '');
      const isServerError = /bad gateway|502|503|service unavailable|upstream/i.test(pageText);
      if (isServerError || !url.includes('imbank.com')) {
        console.log('[SparkP2P] I&M recovery check: still offline');
        return; // still down — keep waiting
      }
      // Site is reachable — take a screenshot and check if it's login or dashboard
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
      console.log(`[SparkP2P] I&M recovery Vision check: ${verdict}`);

      if (verdict === 'LOGGED_IN') {
        clearInterval(imRecoveryTimer); imRecoveryTimer = null;
        console.log('[SparkP2P] I&M back online and already logged in!');
        sendBotLog('success', 'I&M Bank is back online and logged in');
        // Resume normal I&M operation — sync cookies immediately so backend enables I&M payments now
        await syncImCookies();
        const kaCookies = await imPage.cookies('https://digital.imbank.com').catch(() => []);
        if (kaCookies.length) saveImCookiesLocal(kaCookies);
        startImKeepAlive();
        const binancePageRecovery = await getPage('binance.com').catch(() => null);
        if (binancePageRecovery) await binancePageRecovery.bringToFront().catch(() => {});
        mainWindow.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("im-connected"))').catch(() => {});
        if (token) {
          fetch(`${API_BASE}/ext/notify-trader`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ message: 'Great news! I&M Bank digital platform is back online and your session has been automatically restored. The bot is now fully operational including M-Pesa payments.' }),
          }).catch(() => {});
        }
      } else if (verdict === 'LOGIN_PAGE') {
        clearInterval(imRecoveryTimer); imRecoveryTimer = null;
        console.log('[SparkP2P] I&M back online — needs login, notifying trader');
        sendBotLog('warning', 'I&M Bank is back online — login required');
        if (token) {
          fetch(`${API_BASE}/ext/notify-trader`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ message: 'I&M Bank digital platform appears to be back online. However, you need to sign in to your account again to continue processing M-Pesa payments. Please open the app and log in to I&M Bank.' }),
          }).catch(() => {});
        }
        // Restart the login poller so the bot picks up when trader signs in
        connectingIm = false;
        connectIm().catch(() => {});
      }
    } catch (e) { console.log('[SparkP2P] I&M recovery check error:', e.message); }
  }, 5 * 60 * 1000); // every 5 minutes
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
    if (!imPage || imPage.isClosed()) {
      imPage = null;
      return;
    }
    try {
      const url = imPage.url();

      // Detect session expiry — clear the page reference but do NOT auto-reopen
      if (url.includes('/openid-connect/') || url.includes('/auth/realms/') ||
          url.includes('login') || url.includes('Login') ||
          !url.includes('imbank.com')) {
        imPage = null;
        if (imKeepAliveTimer) { clearInterval(imKeepAliveTimer); imKeepAliveTimer = null; }
        if (token) {
          await fetch(`${API_BASE}/traders/disconnect-im`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
          }).catch(() => {});
        }
        return;
      }

      // Skip keep-alive navigation if a withdrawal is currently running
      if (imWithdrawalRunning) {
        console.log('[SparkP2P] I&M keep-alive skipped â€" withdrawal in progress');
        return;
      }

      // Navigate to dashboard to refresh the I&M session timer (SPA navigation)
      await imPage.goto('https://digital.imbank.com/inm-retail/dashboard', {
        waitUntil: 'domcontentloaded', timeout: 15000
      }).catch(() => {});
      await syncImCookies();
      // Refresh locally saved cookies so next reconnect uses the latest tokens
      const kaCookies = await imPage.cookies('https://digital.imbank.com').catch(() => []);
      if (kaCookies.length) saveImCookiesLocal(kaCookies);
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
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $x = async xpath => imPage.$$('::-p-xpath(' + xpath + ')').catch(() => []);
  if (imWithdrawalRunning) return;
  if (!imPage || imPage.isClosed()) {
    console.log('[SparkP2P] I&M page not open — cannot execute withdrawal');
    return;
  }
  await imPage.bringToFront().catch(() => {});
  if (!imPin) {
    console.log('[SparkP2P] I&M PIN not set — cannot execute withdrawal');
    return;
  }
  imWithdrawalRunning = true;
  const FROM_ACCOUNT = '00108094726150'; // SPARK FREELANCE SOLUTIONS (M-Pesa sweep destination)
  const TO_ACCOUNT   = job.destination_account || '00108094726050'; // trader personal KES acc
  const EXPECTED_NAME = (job.destination_name || '').toUpperCase();
  console.log(`[SparkP2P] ðŸ'¸ I&M own-account transfer: KES ${job.amount} → ${TO_ACCOUNT}`);
  sendBotLog('info', `I&M Bank withdrawal started — KES ${job.amount}`);

  try {
    // â"€â"€ STEP 1: Navigate to Own Account Transfer form â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    await imPage.goto(
      'https://digital.imbank.com/inm-retail/transfers/own-account-transfer/form',
      { waitUntil: 'networkidle2', timeout: 30000 }
    );
    await sleep(2000);
    console.log('[SparkP2P] I&M: Loaded own-account-transfer form');

    // â"€â"€ STEP 2: Select FROM account (SPARK FREELANCE SOLUTIONS) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    // Click the From dropdown
    await imPage.waitForSelector('select, [class*="dropdown"], [class*="select"]', { timeout: 10000 }).catch(() => {});
    // Use Claude Vision to identify and click the From dropdown, then select correct account
    let ss = await imPage.screenshot({ encoding: 'base64' });
    let fromDone = false;
    // Try clicking the first dropdown (From) and selecting by account number text
    const fromDropdowns = await imPage.$$('ng-select, app-select, select').catch(() => []);
    if (fromDropdowns.length > 0) {
      await fromDropdowns[0].click().catch(() => {});
      await sleep(1000);
      // Find option containing FROM_ACCOUNT number
      const fromOption = await $x(`//*[contains(text(), '${FROM_ACCOUNT}') or contains(text(), 'SPARK FREELANCE')]`).catch(() => []);
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
    await sleep(1000);

    // â"€â"€ STEP 3: Select TO account (trader's personal account) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    const allDropdowns = await imPage.$$('ng-select, app-select, select').catch(() => []);
    let toDone = false;
    if (allDropdowns.length > 1) {
      await allDropdowns[1].click().catch(() => {});
      await sleep(1000);
      const toOption = await $x(`//*[contains(text(), '${TO_ACCOUNT}') or contains(text(), 'BONITO')]`).catch(() => []);
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
    await sleep(1000);

    // â"€â"€ STEP 4: Set currency to KES â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    // Click the currency dropdown and select KES
    const currencyDropdown = await imPage.$('select[formcontrolname*="currency"], [class*="currency"] select, select').catch(() => null);
    if (currencyDropdown) {
      await imPage.select('select', 'KES').catch(() => {});
    } else {
      // Try clicking currency button and picking KES from list
      const currencyBtn = await $x('//*[contains(text(), "KES") or contains(text(), "EUR") or contains(text(), "USD")]').catch(() => []);
      if (currencyBtn.length > 0) {
        await currencyBtn[0].click().catch(() => {});
        await sleep(500);
        const kesOption = await $x('//*[contains(text(), "KES")]').catch(() => []);
        if (kesOption.length > 0) await kesOption[0].click().catch(() => {});
      }
    }
    console.log('[SparkP2P] I&M: Currency set to KES');
    await sleep(500);

    // â"€â"€ STEP 5: Enter amount â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    // Amount field â€" type the whole number part (cents field stays 00)
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
    await sleep(500);

    // â"€â"€ STEP 6: Enter description (optional) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    const descInput = await imPage.$('textarea, input[formcontrolname*="description"], input[placeholder*="description" i]').catch(() => null);
    if (descInput) {
      await descInput.click();
      await descInput.type(`SparkP2P withdrawal ${job.id}`, { delay: 30 });
    }
    await sleep(500);

    // â"€â"€ STEP 7: Click Continue â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    const continueBtn = await $x('//button[contains(text(), "Continue")]').catch(() => []);
    if (continueBtn.length > 0) {
      await continueBtn[0].click();
    } else {
      await imPage.click('button[type="submit"], button.btn-primary').catch(() => {});
    }
    console.log('[SparkP2P] I&M: Clicked Continue');
    await sleep(3000);

    // â"€â"€ STEP 8: Review modal â€" verify account name then click Submit â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
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
      console.log(`[SparkP2P] âš ï¸ I&M review: account name mismatch! Expected "${EXPECTED_NAME}", found "${reviewCheck.found_name}" â€" discarding`);
      const discardBtn = await $x('//button[contains(text(), "Discard")] | //a[contains(text(), "Discard")]').catch(() => []);
      if (discardBtn.length > 0) await discardBtn[0].click().catch(() => {});
      throw new Error(`Account name mismatch: expected "${EXPECTED_NAME}", got "${reviewCheck.found_name}"`);
    }
    console.log(`[SparkP2P] I&M: Review verified (${reviewCheck?.found_name || 'name confirmed'}) â€" submitting`);

    // Click Submit
    const submitBtn = await $x('//button[contains(text(), "Submit")]').catch(() => []);
    if (submitBtn.length > 0) {
      await submitBtn[0].click();
    } else {
      await imPage.click('button[type="submit"]').catch(() => {});
    }
    await sleep(2000);
    console.log('[SparkP2P] I&M: Clicked Submit');

    // â"€â"€ STEP 9: Identity Validation â€" enter PIN â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    await imPage.waitForSelector('input[type="password"], input[placeholder*="PIN" i]', { timeout: 10000 });
    const pinInput = await imPage.$('input[type="password"], input[placeholder*="PIN" i]').catch(() => null);
    if (!pinInput) throw new Error('PIN input not found');
    await pinInput.click();
    await pinInput.type(imPin, { delay: 80 });
    console.log('[SparkP2P] I&M: Entered PIN');
    await sleep(500);

    // Click Complete button
    const completeBtn = await $x('//button[contains(text(), "Complete")]').catch(() => []);
    if (completeBtn.length > 0) {
      await completeBtn[0].click();
    } else {
      await imPage.click('button[type="submit"]').catch(() => {});
    }
    console.log('[SparkP2P] I&M: Clicked Complete');
    await sleep(4000);

    // â"€â"€ STEP 10: Verify success screen â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    ss = await imPage.screenshot({ encoding: 'base64' });
    const successCheck = await imVisionVerify(
      ss,
      `Does this screen show "Payment Success" with a green checkmark?
      Also extract the Reference ID number if visible.
      Respond JSON only: { "success": true/false, "reference": "ref number or null", "description": "brief" }`
    );

    if (successCheck && successCheck.success) {
      console.log(`[SparkP2P] âœ… I&M withdrawal KES ${job.amount} SUCCESS â€" ref: ${successCheck.reference || 'N/A'}`);
      sendBotLog('success', `I&M Bank withdrawal KES ${job.amount} completed — ref: ${successCheck.reference || 'N/A'}`);
      // Click Close to dismiss the success modal
      const closeBtn = await $x('//button[contains(text(), "Close")]').catch(() => []);
      if (closeBtn.length > 0) await closeBtn[0].click().catch(() => {});
      await sleep(1000);

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

// â"€â"€ Claude Vision helpers for I&M automation â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function _parseVisionJson(text) {
  // Strip markdown code fences before parsing
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object in response');
  return JSON.parse(match[0]);
}

async function imVisionClick(screenshotB64, instruction) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 300,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshotB64 } },
          { type: 'text', text: `${instruction}. Reply with JSON only, no markdown: {"x": <pixel x center of element>, "y": <pixel y center of element>, "description": "brief"}` },
        ]}],
      }),
    });
    const data = await res.json();
    const result = _parseVisionJson(data.content[0].text);
    if (result.x && result.y) {
      await imPage.mouse.click(Number(result.x), Number(result.y));
      await new Promise(r => setTimeout(r, 600));
    }
  } catch (e) { console.log('[SparkP2P] imVisionClick error:', e.message?.substring(0, 100)); }
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
          { type: 'text', text: `${instruction}. Reply with JSON only, no markdown: {"x": <pixel x center of input>, "y": <pixel y center of input>, "description": "brief"}` },
        ]}],
      }),
    });
    const data = await res.json();
    const result = _parseVisionJson(data.content[0].text);
    if (result.x && result.y) {
      await imPage.mouse.click(Number(result.x), Number(result.y), { clickCount: 3 });
      await new Promise(r => setTimeout(r, 200));
      await imPage.keyboard.type(text, { delay: 50 });
      await new Promise(r => setTimeout(r, 300));
    }
  } catch (e) { console.log('[SparkP2P] imVisionType error:', e.message?.substring(0, 100)); }
}

async function imVisionVerify(screenshotB64, instruction) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 500,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshotB64 } },
          { type: 'text', text: instruction + '\nReply with JSON only, no markdown.' },
        ]}],
      }),
    });
    const data = await res.json();
    return _parseVisionJson(data.content[0].text);
  } catch (e) {
    console.log('[SparkP2P] imVisionVerify error:', e.message?.substring(0, 100));
    return null;
  }
}

// Send a one-off admin alert SMS via the VPS API.
async function _alertAdminFromBot(message) {
  if (!token) return;
  try {
    await fetch(`${API_BASE}/admin/alert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ message }),
    }).catch(() => {});
    console.log(`[ImHealth] Admin alert sent: ${message.substring(0, 80)}`);
  } catch (e) {}
}

// Classify the current state of an I&M Bank page before attempting any operation.
// Returns: "ok" | "login_required" | "error" | "unreachable"
// Attempts cookie-based session recovery on login_required.
// Sends admin SMS immediately on error/unreachable so we fail fast.
async function checkImPageHealth(page) {
  const p = page || imPage;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  if (!p || p.isClosed()) {
    console.log('[ImHealth] I&M page is closed or null');
    await _alertAdminFromBot('I&M Bank tab closed — bot cannot execute transfers. Please reconnect I&M Bank in the desktop app.');
    return 'unreachable';
  }

  // URL check — catches complete navigation failure
  let url = '';
  try { url = p.url(); } catch (e) {}
  if (!url.includes('imbank.com')) {
    console.log(`[ImHealth] Unexpected URL: ${url.substring(0, 60)} — re-navigating`);
    try {
      await p.goto('https://digital.imbank.com/inm-retail/dashboard', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(3000);
      url = p.url();
    } catch (e) {
      console.log('[ImHealth] Re-navigation to I&M failed:', e.message?.substring(0, 60));
      await _alertAdminFromBot('I&M Bank portal unreachable — bot cannot load digital.imbank.com. Check VPS internet connectivity.');
      return 'unreachable';
    }
  }

  // Vision classification
  let ss;
  try { ss = await p.screenshot({ encoding: 'base64' }); } catch (e) {
    await _alertAdminFromBot('I&M Bank page screenshot failed — page may have crashed.');
    return 'unreachable';
  }

  let verdict = 'DASHBOARD';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 10,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ss } },
          { type: 'text', text:
            'Classify this I&M Bank browser page. Reply with ONLY one word:\n' +
            'DASHBOARD — account balances or transfer forms visible (logged in)\n' +
            'LOGIN — login form, QR code, username/password, or "sign in" button\n' +
            'SESSION_EXPIRED — session timeout message\n' +
            'ERROR — error page, 404, 500, maintenance, or blank white page\n' +
            'OTHER — anything else'
          },
        ]}],
      }),
    });
    const data = await res.json();
    verdict = (data.content?.[0]?.text || 'DASHBOARD').trim().toUpperCase().split(/\s/)[0];
  } catch (e) {
    console.log('[ImHealth] Vision call failed — assuming OK:', e.message?.substring(0, 60));
    return 'ok'; // Don't block on Vision API errors
  }

  console.log(`[ImHealth] Page state: ${verdict}`);

  if (verdict === 'DASHBOARD') return 'ok';

  if (verdict === 'LOGIN' || verdict === 'SESSION_EXPIRED') {
    sendBotLog('warning', 'I&M Bank session expired — attempting cookie restore');
    // Try restoring saved cookies
    const savedCookies = loadImCookiesLocal();
    if (savedCookies && p === imPage) {
      try {
        await restoreCookiesToPage(p, savedCookies, 'https://digital.imbank.com');
        await p.goto('https://digital.imbank.com/inm-retail/dashboard', { waitUntil: 'networkidle2', timeout: 20000 });
        await sleep(2000);
        const ss2 = await p.screenshot({ encoding: 'base64' });
        const r2 = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001', max_tokens: 10,
            messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ss2 } },
              { type: 'text', text: 'Is this the I&M Bank dashboard (logged in)? Reply LOGGED_IN or LOGIN_PAGE only.' },
            ]}],
          }),
        });
        const d2 = await r2.json();
        if ((d2.content?.[0]?.text || '').includes('LOGGED_IN')) {
          console.log('[ImHealth] Cookie restore succeeded');
          sendBotLog('success', 'I&M Bank session restored via saved cookies');
          return 'ok';
        }
      } catch (e) {
        console.log('[ImHealth] Cookie restore failed:', e.message?.substring(0, 60));
      }
    }
    await _alertAdminFromBot(
      'I&M Bank session has expired and could not be restored automatically. ' +
      'Please open the SparkP2P desktop app and re-connect I&M Bank. ' +
      'Batch disbursements are paused until you reconnect.'
    );
    sendBotLog('error', 'I&M session expired — manual reconnect required. Batch disbursements paused.');
    return 'login_required';
  }

  // ERROR or OTHER
  const pageText = await p.evaluate(() => (document.body?.innerText || '').substring(0, 150)).catch(() => '');
  await _alertAdminFromBot(
    `I&M Bank portal showing unexpected page (${verdict}). Bot cannot execute transfers. ` +
    `Check https://digital.imbank.com manually. Page snippet: "${pageText.substring(0, 100)}"`
  );
  sendBotLog('error', `I&M portal unexpected page (${verdict}) — transfers paused`);
  return 'error';
}

// â"€â"€ I&M Local Transfer (to any I&M account holder) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
// Used for all trader withdrawals to their I&M accounts
async function executeImLocalTransfer(job, _page = null) {
  // job = { id, amount, destination_account, destination_name }
  // For batch items: job = { item_id, wallet_tx_id, amount, destination_account, destination_name }
  const page = _page || imPage;
  const isBatchItem = !!job.item_id;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $x = async xpath => page.$$('::-p-xpath(' + xpath + ')').catch(() => []);
  if (!_page && imWithdrawalRunning) return;
  if (!page || page.isClosed()) {
    console.log('[SparkP2P] I&M page not open — cannot execute local transfer');
    return;
  }
  if (!_page) await page.bringToFront().catch(() => {});
  if (!imPin) {
    console.log('[SparkP2P] I&M PIN not set — cannot execute local transfer');
    return;
  }
  if (!_page) imWithdrawalRunning = true;
  // Page-specific Vision helpers that operate on the active page object
  const visionClick = async (screenshotB64, instruction) => {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 300,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshotB64 } },
            { type: 'text', text: instruction + '\nReply JSON only: {"x": pixel_x, "y": pixel_y, "found": bool}' },
          ]}] }),
      });
      const d = await res.json();
      const r = _parseVisionJson(d.content[0].text);
      if (r.x && r.y) { await page.mouse.click(Number(r.x), Number(r.y)); await sleep(600); }
    } catch (e) { console.log('[SparkP2P] visionClick error:', e.message?.substring(0, 100)); }
  };
  const visionType = async (screenshotB64, instruction, text) => {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 300,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshotB64 } },
            { type: 'text', text: instruction + '\nReply JSON only: {"x": pixel_x, "y": pixel_y}' },
          ]}] }),
      });
      const d = await res.json();
      const r = _parseVisionJson(d.content[0].text);
      if (r.x && r.y) { await page.mouse.click(Number(r.x), Number(r.y), { clickCount: 3 }); await sleep(200); await page.keyboard.type(text, { delay: 50 }); await sleep(300); }
    } catch (e) { console.log('[SparkP2P] visionType error:', e.message?.substring(0, 100)); }
  };
  const FROM_ACCOUNT  = '00108094726150'; // SPARK FREELANCE SOLUTIONS
  const TO_ACCOUNT    = job.destination_account;
  const EXPECTED_NAME = (job.destination_name || '').toUpperCase().trim();
  console.log(`[SparkP2P] ðŸ'¸ I&M local transfer: KES ${job.amount} → ${TO_ACCOUNT} (${EXPECTED_NAME})`);
  sendBotLog('info', `I&M Bank local transfer started — KES ${job.amount}`);

  let ss;
  try {
    // STEP 1: Navigate to Local Transfers form — go via dashboard first so Angular
    // fully destroys/recreates the form component on retry (avoids dirty state)
    await page.goto(
      'https://digital.imbank.com/inm-retail/dashboard',
      { waitUntil: 'networkidle2', timeout: 20000 }
    ).catch(() => {});
    await sleep(1000);
    await page.goto(
      'https://digital.imbank.com/inm-retail/transfers/local-transfers/form',
      { waitUntil: 'networkidle2', timeout: 30000 }
    );
    await sleep(2500);
    console.log('[SparkP2P] I&M: Loaded local-transfers form');

    // STEP 2: Select Debit Account (same pattern as executeImWithdrawal)
    await page.waitForSelector('ng-select, select', { timeout: 10000 }).catch(() => {});
    const ngSelectsInit = await page.$$('ng-select').catch(() => []);
    let debitDone = false;
    if (ngSelectsInit.length > 0) {
      await ngSelectsInit[0].click().catch(() => {});
      await sleep(1000);
      const debitOption = await $x(`//*[contains(text(), '${FROM_ACCOUNT}') or contains(text(), 'SPARK FREELANCE')]`).catch(() => []);
      if (debitOption.length > 0) {
        await debitOption[0].click().catch(() => {});
        debitDone = true;
        console.log('[SparkP2P] I&M: Selected debit account SPARK FREELANCE SOLUTIONS');
      }
    }
    if (!debitDone) {
      ss = await page.screenshot({ encoding: 'base64' });
      await visionClick(ss, `Click the Debit Account dropdown and select SPARK FREELANCE SOLUTIONS (${FROM_ACCOUNT})`);
      console.log('[SparkP2P] I&M: Selected debit account via Vision');
    }
    await sleep(1000);

    // STEP 3: Click "Saved Beneficiary" radio — XPath text search, no Vision
    let radioDone = false;
    const savedBenefEl = await $x('//*[contains(text(), "Saved Beneficiary")]').catch(() => []);
    if (savedBenefEl.length > 0) {
      await savedBenefEl[0].click().catch(() => {});
      radioDone = true;
    }
    if (!radioDone) {
      const radioInputs = await page.$$('input[type="radio"]').catch(() => []);
      if (radioInputs.length > 0) {
        await page.evaluate(el => el.click(), radioInputs[0]).catch(() => {});
        radioDone = true;
      }
    }
    if (!radioDone) {
      ss = await page.screenshot({ encoding: 'base64' });
      await visionClick(ss, 'Click the "Saved Beneficiary" radio button or label');
    }
    await sleep(1200);
    console.log('[SparkP2P] I&M: Clicked Saved Beneficiary');

    // STEP 4: Select beneficiary — index-based ng-select click + XPath option (mirrors own-account TO field)
    let benefDone = false;
    const allNgSelects = await page.$$('ng-select').catch(() => []);
    // Beneficiary ng-select is the 2nd one (index 1); debit account is index 0
    const benefDrop = allNgSelects.length > 1 ? allNgSelects[1] : allNgSelects[0];
    if (benefDrop) {
      await benefDrop.click().catch(() => {});
      await sleep(800);
      await page.keyboard.type(TO_ACCOUNT, { delay: 60 });
      await sleep(1500);
      const benefOption = await $x(
        `//*[contains(text(), '${TO_ACCOUNT}') or contains(text(), '${EXPECTED_NAME}')]`
      ).catch(() => []);
      if (benefOption.length > 0) {
        await benefOption[0].click().catch(() => {});
        benefDone = true;
      } else {
        await page.keyboard.press('Enter');
        benefDone = true;
      }
    }
    if (!benefDone) {
      ss = await page.screenshot({ encoding: 'base64' });
      await visionClick(ss, `Click the beneficiary dropdown and select ${TO_ACCOUNT} (${EXPECTED_NAME})`);
    }
    await sleep(1000);
    console.log(`[SparkP2P] I&M: Selected saved beneficiary ${TO_ACCOUNT} (${EXPECTED_NAME})`);

    // Click Validate button (required even for saved beneficiaries)
    const validated = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b =>
        (b.textContent || '').trim().toLowerCase() === 'validate' && !b.disabled
      );
      if (btn) { btn.scrollIntoView({ block: 'center', behavior: 'instant' }); btn.click(); return true; }
      return false;
    }).catch(() => false);
    if (validated) {
      console.log('[SparkP2P] I&M: Clicked Validate — waiting for confirmation...');
      await sleep(3500); // wait for validation API response
    } else {
      console.log('[SparkP2P] I&M: Validate button not found — continuing');
      await sleep(500);
    }

    // Scroll down to reveal Payment details (Amount, Reference, Purpose)
    await page.evaluate(() => window.scrollBy(0, 500)).catch(() => {});
    await sleep(800);

    // STEP 5: Currency = KES — same proven approach as executeImBankTransfer
    const currSelHandles = await page.$$('select');
    const currHandle = currSelHandles[0]; // first <select> on the page is the currency
    if (currHandle) {
      const selInfo = await page.evaluate(() => {
        const sels = Array.from(document.querySelectorAll('select'));
        for (const s of sels) {
          const kesOpt = Array.from(s.options).find(o => o.text.trim() === 'KES');
          if (kesOpt) return { value: kesOpt.value };
        }
        return null;
      }).catch(() => null);
      if (selInfo) {
        await page.select('select', selInfo.value).catch(() => {});
        console.log('[SparkP2P] I&M: Currency set to KES via page.select');
      }
    }
    await sleep(500);
    console.log('[SparkP2P] I&M: Currency set to KES');

    // STEP 6: Enter Amount (integer + cents) — Angular native setter
    const amountInt = Math.floor(job.amount);
    const amountCents = Math.round((job.amount - amountInt) * 100);
    const amountWhole = amountInt.toString();
    const amountCentsStr = amountCents.toString().padStart(2, '0');

    // Fill integer part
    const amtFilled = await page.evaluate((amt) => {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      const setVal = (el, v) => { if (nativeSetter) nativeSetter.call(el, v); else el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
      const inputs = Array.from(document.querySelectorAll('input[type="number"],input[type="text"]'));
      const amtInput = inputs.find(i => {
        const ph = (i.placeholder || '').toLowerCase();
        const fc = (i.getAttribute('formcontrolname') || '').toLowerCase();
        if (ph.includes('reference') || fc.includes('reference') || fc.includes('narration') ||
            ph.includes('account') || fc.includes('account') || ph.includes('description') || fc.includes('description')) return false;
        return i.value === '0' || i.placeholder === '0' || fc.includes('amount') || fc.includes('whole');
      });
      if (amtInput) {
        amtInput.scrollIntoView({ block: 'center', behavior: 'instant' });
        amtInput.click(); amtInput.select();
        setVal(amtInput, String(amt));
        return true;
      }
      return false;
    }, amountWhole).catch(() => false);
    if (!amtFilled) {
      ss = await page.screenshot({ encoding: 'base64' });
      await visionType(ss, `Type ${amountWhole} in the Amount whole number field`, amountWhole);
    }
    await sleep(300);

    // Fill cents part (the "00" field after the period separator)
    await page.evaluate((cents) => {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      const setVal = (el, v) => { if (nativeSetter) nativeSetter.call(el, v); else el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
      const inputs = Array.from(document.querySelectorAll('input[type="number"],input[type="text"]'));
      // Cents field has placeholder "00" or formcontrolname containing "cent" or "decimal"
      const centsInput = inputs.find(i => {
        const ph = (i.placeholder || '');
        const fc = (i.getAttribute('formcontrolname') || '').toLowerCase();
        return ph === '00' || fc.includes('cent') || fc.includes('decimal') || fc.includes('fraction');
      });
      if (centsInput) {
        centsInput.scrollIntoView({ block: 'center', behavior: 'instant' });
        centsInput.click(); centsInput.select();
        setVal(centsInput, cents);
      }
    }, amountCentsStr).catch(() => {});
    console.log(`[SparkP2P] I&M: Entered amount ${amountWhole}.${amountCentsStr}`);
    await sleep(500);

    // STEP 7: Payment Reference — Angular native setter
    const refText = `SPK-${String(job.id).padStart(6, '0')}`;
    await page.evaluate((ref) => {
      const inputs = Array.from(document.querySelectorAll('input,textarea'));
      const i = inputs.find(inp =>
        (inp.placeholder || '').toLowerCase().includes('payment description') ||
        (inp.placeholder || '').toLowerCase().includes('reference') ||
        (inp.getAttribute('formcontrolname') || '').toLowerCase().includes('reference') ||
        (inp.getAttribute('formcontrolname') || '').toLowerCase().includes('narration')
      );
      if (i) {
        i.scrollIntoView({ block: 'center', behavior: 'instant' });
        i.click(); i.value = '';
        const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (ns) ns.call(i, ref);
        i.dispatchEvent(new Event('input', { bubbles: true }));
        i.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, refText).catch(() => {});
    await sleep(500);

    // STEP 8: Payment Purpose = Other — select[1] with lazy-load wait (same as executeImBankTransfer)
    const purposeHandles = await page.$$('select');
    const purposeHandle = purposeHandles[1] || purposeHandles[0];
    let purposeSet = false;
    if (purposeHandle) {
      await purposeHandle.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' })).catch(() => {});
      await sleep(300);
      for (let attempt = 1; attempt <= 3; attempt++) {
        await purposeHandle.focus().catch(() => {});
        await purposeHandle.click().catch(() => {});
        await purposeHandle.evaluate(el => {
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          el.dispatchEvent(new Event('focus', { bubbles: true }));
        }).catch(() => {});
        await page.waitForFunction(() => {
          const sels = document.querySelectorAll('select');
          const target = sels[1] || sels[0];
          return target && target.options.length > 1;
        }, { timeout: 4000 }).catch(() => {});
        await page.keyboard.press('Escape').catch(() => {});
        await sleep(300);
        const opts = await purposeHandle.evaluate(el =>
          Array.from(el.options).map(o => ({ text: o.text.trim(), value: o.value }))
        ).catch(() => []);
        const otherOpt = opts.find(o => o.text.toLowerCase().includes('other'));
        if (otherOpt) {
          await purposeHandle.select(otherOpt.value);
          purposeSet = true;
          console.log(`[SparkP2P] I&M: Payment purpose set to "${otherOpt.text}"`);
          break;
        }
      }
    }
    if (!purposeSet) console.log('[SparkP2P] I&M: Payment purpose fallback — continuing anyway');
    console.log('[SparkP2P] I&M: Payment purpose set to Other');
    await sleep(500);

    // STEPS 9-12: Vision loop — handles Continue, Review modal, PIN, and Success
    // Using coordinate-based clicks throughout (same as buy side) for Angular reliability
    let txSuccess = false;
    let txReference = null;
    let postContinueSubmitted = false;
    for (let vStep = 0; vStep < 20; vStep++) {
      await sleep(vStep === 0 ? 500 : 2000);
      ss = await page.screenshot({ encoding: 'base64' });
      const vAction = await imVisionVerify(
        ss,
        `I&M Bank local transfer portal. What screen is currently showing?
        - "form" = the transfer form with Continue button at the bottom (no popup overlay)
        - "review" = a popup/modal overlay titled "Local Transfer - Review" with Back, Discard and Submit buttons
        - "pin" = PIN entry screen with a password/PIN input field
        - "success" = green checkmark or "Payment Successful" / "Transfer Successful" message
        - "other" = loading, error, or anything else
        If success, extract the reference/transaction number.
        JSON only: {"screen":"form|review|pin|success|other","reference":"ref or null","description":"brief"}`
      );
      if (!vAction) continue;
      console.log(`[SparkP2P] I&M Vision step ${vStep+1}: screen=${vAction.screen} — ${vAction.description}`);

      if (vAction.screen === 'success') {
        txSuccess = true;
        txReference = vAction.reference;
        break;
      }

      if (vAction.screen === 'form') {
        // Form visible — click Continue via coordinate-based mouse click
        const contCoords = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const btn = btns.find(b => (b.textContent || '').trim() === 'Continue' && !b.disabled);
          if (!btn) return null;
          btn.scrollIntoView({ block: 'center', behavior: 'instant' });
          const r = btn.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }).catch(() => null);
        if (contCoords && contCoords.x > 0) {
          await page.mouse.click(contCoords.x, contCoords.y);
          console.log(`[SparkP2P] I&M: Clicked Continue at (${Math.round(contCoords.x)}, ${Math.round(contCoords.y)})`);
        } else {
          const continueXp = await $x('//button[contains(text(), "Continue")]').catch(() => []);
          if (continueXp.length > 0) await continueXp[0].click().catch(() => {});
          console.log('[SparkP2P] I&M: Clicked Continue (XPath fallback)');
        }
        continue;
      }

      if (vAction.screen === 'review') {
        // Review modal — verify name then click Submit via coordinates
        const submCoords = await page.evaluate(() => {
          // Search inside modal/dialog first
          const container = document.querySelector('mat-dialog-container, [role="dialog"], .cdk-overlay-pane') || document.body;
          const btns = Array.from(container.querySelectorAll('button'));
          const btn = btns.find(b => (b.textContent || '').trim() === 'Submit');
          if (!btn) return null;
          btn.scrollIntoView({ block: 'center', behavior: 'instant' });
          const r = btn.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }).catch(() => null);
        if (submCoords && submCoords.x > 0) {
          await page.mouse.click(submCoords.x, submCoords.y);
          console.log(`[SparkP2P] I&M: Clicked Submit at (${Math.round(submCoords.x)}, ${Math.round(submCoords.y)})`);
          postContinueSubmitted = true;
        } else {
          const submitXp = await $x('//button[contains(text(), "Submit")]').catch(() => []);
          if (submitXp.length > 0) await submitXp[0].click().catch(() => {});
          console.log('[SparkP2P] I&M: Clicked Submit (XPath fallback)');
          postContinueSubmitted = true;
        }
        await sleep(3000);
        continue;
      }

      if (vAction.screen === 'pin') {
        // Mirror exact PIN approach from executeImBankTransfer Vision loop
        await page.evaluate(() => {
          const input = document.querySelector('input[type="password"], input[type="tel"]');
          if (input) { input.click(); input.focus(); }
        }).catch(() => {});
        await sleep(300);
        for (const digit of String(imPin)) {
          await page.keyboard.press(digit);
          await sleep(150);
        }
        await sleep(800);
        const completeClicked = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const btn = btns.find(b => (b.textContent || '').trim().toLowerCase() === 'complete');
          if (btn) { btn.scrollIntoView({ block: 'center', behavior: 'instant' }); btn.click(); return true; }
          return false;
        }).catch(() => false);
        console.log(`[SparkP2P] I&M: PIN entered + Complete clicked: ${completeClicked}`);
        await sleep(4000);
        continue;
      }
      // 'other' — loading/transition, just wait
    }

    if (txSuccess) {
      console.log(`[SparkP2P] I&M local transfer KES ${job.amount} SUCCESS — ref: ${txReference || 'N/A'}`);
      sendBotLog('success', `I&M Bank local transfer KES ${job.amount} completed — ref: ${txReference || 'N/A'}`);
      const closeBtn = await $x('//button[contains(text(), "Close")]').catch(() => []);
      if (closeBtn.length > 0) await closeBtn[0].click().catch(() => {});
      await sleep(1000);
      if (isBatchItem) {
        await fetch(`${API_BASE}/ext/batch-item-complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ item_id: job.item_id, reference: txReference }),
        }).catch(() => {});
      } else {
        await fetch(`${API_BASE}/ext/bank-withdrawal-complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ tx_id: job.id, reference: txReference }),
        }).catch(() => {});
        if (mpesaOrgPage && !mpesaOrgPage.isClosed()) await mpesaOrgPage.bringToFront().catch(() => {});
      }
    } else {
      throw new Error('Transfer did not complete: PIN/success screen not detected after 10 attempts');
    }

  } catch (e) {
    console.log('[SparkP2P] I&M local transfer error:', e.message);
    if (isBatchItem) {
      await fetch(`${API_BASE}/ext/batch-item-failed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ item_id: job.item_id, error: e.message }),
      }).catch(() => {});
    } else {
      await fetch(`${API_BASE}/ext/bank-withdrawal-failed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ tx_id: job.id, error: e.message }),
      }).catch(() => {});
      const resetRes = await fetch(`${API_BASE}/ext/reset-pending-sweep`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      }).catch(() => null);
      const resetData = resetRes ? await resetRes.json().catch(() => null) : null;
      if (resetData?.reset) {
        console.log(`[SparkP2P] Sweep ${resetData.sweep_id} reset to pending — will retry M-PESA → I&M flow`);
        sendBotLog('warning', `I&M transfer failed — retrying from M-PESA sweep #${resetData.sweep_id}`);
      }
      if (mpesaOrgPage && !mpesaOrgPage.isClosed()) await mpesaOrgPage.bringToFront().catch(() => {});
    }
  } finally {
    if (!_page) imWithdrawalRunning = false;
    await syncImCookies();
  }
}

// ── Pipeline helpers for batch disbursements ─────────────────────────────────
//
// The pipeline splits each transfer into two phases so that multiple tabs can
// fill forms concurrently while PIN entry stays strictly serial (one at a time):
//
//   Tab 1:  [Fill form] ──→ [HOLD at PIN] ──────────────────────── [Fill next] ──→ ...
//   Tab 2:       [Fill form] ──→ [HOLD at PIN] ──────────────────────── ...
//   Tab 3:            [Fill form] ──→ [HOLD at PIN] ──────────────────────── ...
//                                                ↑
//            PIN sequencer (serial): Tab1 PIN → confirm → Tab2 PIN → confirm → ...
//
// This eliminates session/PIN conflicts while keeping form-fill concurrent.

// Phase 1: fill all transfer form fields and navigate through Continue + Review
// modal, stopping the moment Vision detects the PIN screen.
// Returns { readyForPin: true } or { success: true, reference } (if portal
// somehow skips PIN) or throws on error.
async function _imFillUntilPin(job, page) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $x = async xpath => page.$$('::-p-xpath(' + xpath + ')').catch(() => []);
  const FROM_ACCOUNT = '00108094726150';
  const TO_ACCOUNT = job.destination_account;
  const EXPECTED_NAME = (job.destination_name || '').toUpperCase().trim();
  const refText = `SPK-${String(job.wallet_tx_id || job.id || '').padStart(6, '0')}`;
  let ss;

  const vClick = async (screenshotB64, instruction) => {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 300,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshotB64 } },
            { type: 'text', text: instruction + '\nReply JSON only: {"x": pixel_x, "y": pixel_y}' },
          ]}] }),
      });
      const d = await res.json();
      const r = _parseVisionJson(d.content[0].text);
      if (r.x && r.y) { await page.mouse.click(Number(r.x), Number(r.y)); await sleep(600); }
    } catch (e) {}
  };

  // Step 1: Navigate to form
  await page.goto('https://digital.imbank.com/inm-retail/dashboard', { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
  await sleep(800);
  await page.goto('https://digital.imbank.com/inm-retail/transfers/local-transfers/form', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(2500);

  // Step 2: Debit account = SPARK FREELANCE SOLUTIONS
  await page.waitForSelector('ng-select, select', { timeout: 10000 }).catch(() => {});
  const ngSelectsInit = await page.$$('ng-select').catch(() => []);
  let debitDone = false;
  if (ngSelectsInit.length > 0) {
    await ngSelectsInit[0].click().catch(() => {});
    await sleep(800);
    const opt = await $x(`//*[contains(text(), '${FROM_ACCOUNT}') or contains(text(), 'SPARK FREELANCE')]`);
    if (opt.length > 0) { await opt[0].click().catch(() => {}); debitDone = true; }
  }
  if (!debitDone) { ss = await page.screenshot({ encoding: 'base64' }); await vClick(ss, `Click Debit Account dropdown and select SPARK FREELANCE SOLUTIONS (${FROM_ACCOUNT})`); }
  await sleep(800);

  // Step 3: Saved Beneficiary radio
  const savedBenef = await $x('//*[contains(text(), "Saved Beneficiary")]');
  if (savedBenef.length > 0) { await savedBenef[0].click().catch(() => {}); }
  else {
    const radios = await page.$$('input[type="radio"]').catch(() => []);
    if (radios.length > 0) await page.evaluate(el => el.click(), radios[0]).catch(() => {});
  }
  await sleep(1200);

  // Step 4: Select beneficiary
  const allNgSelects = await page.$$('ng-select').catch(() => []);
  const benefDrop = allNgSelects.length > 1 ? allNgSelects[1] : allNgSelects[0];
  if (benefDrop) {
    await benefDrop.click().catch(() => {});
    await sleep(600);
    await page.keyboard.type(TO_ACCOUNT, { delay: 60 });
    await sleep(1500);
    const benefOpt = await $x(`//*[contains(text(), '${TO_ACCOUNT}') or contains(text(), '${EXPECTED_NAME}')]`);
    if (benefOpt.length > 0) await benefOpt[0].click().catch(() => {});
    else await page.keyboard.press('Enter');
  }
  await sleep(800);

  // Validate button
  const validated = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim().toLowerCase() === 'validate' && !b.disabled);
    if (btn) { btn.scrollIntoView({ block: 'center', behavior: 'instant' }); btn.click(); return true; }
    return false;
  }).catch(() => false);
  if (validated) await sleep(3500);
  await page.evaluate(() => window.scrollBy(0, 500)).catch(() => {});
  await sleep(600);

  // Step 5: Currency = KES
  await page.evaluate(() => {
    const sels = Array.from(document.querySelectorAll('select'));
    for (const s of sels) {
      const o = Array.from(s.options).find(opt => opt.text.trim() === 'KES');
      if (o) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); break; }
    }
  }).catch(() => {});
  await sleep(400);

  // Step 6: Amount
  const amountWhole = Math.floor(job.amount).toString();
  const amountCents = Math.round((job.amount - Math.floor(job.amount)) * 100).toString().padStart(2, '0');
  await page.evaluate((amt) => {
    const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    const set = (el, v) => { if (ns) ns.call(el, v); else el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    const inp = Array.from(document.querySelectorAll('input')).find(i => {
      const fc = (i.getAttribute('formcontrolname') || '').toLowerCase();
      const ph = (i.placeholder || '').toLowerCase();
      if (ph.includes('reference') || fc.includes('reference') || fc.includes('narration') || fc.includes('account')) return false;
      return i.value === '0' || fc.includes('amount') || fc.includes('whole') || i.placeholder === '0';
    });
    if (inp) { inp.scrollIntoView({ block: 'center', behavior: 'instant' }); inp.click(); inp.select(); set(inp, amt); }
  }, amountWhole).catch(() => {});
  await sleep(300);
  await page.evaluate((c) => {
    const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    const set = (el, v) => { if (ns) ns.call(el, v); else el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    const inp = Array.from(document.querySelectorAll('input')).find(i => i.placeholder === '00' || (i.getAttribute('formcontrolname') || '').toLowerCase().includes('cent'));
    if (inp) { inp.scrollIntoView({ block: 'center', behavior: 'instant' }); inp.click(); inp.select(); set(inp, c); }
  }, amountCents).catch(() => {});
  await sleep(300);

  // Step 7: Reference
  await page.evaluate((ref) => {
    const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    const inp = Array.from(document.querySelectorAll('input,textarea')).find(i =>
      (i.placeholder || '').toLowerCase().includes('reference') || (i.placeholder || '').toLowerCase().includes('description') ||
      (i.getAttribute('formcontrolname') || '').toLowerCase().includes('reference') || (i.getAttribute('formcontrolname') || '').toLowerCase().includes('narration')
    );
    if (inp) { inp.scrollIntoView({ block: 'center', behavior: 'instant' }); inp.click(); inp.value = ''; if (ns) ns.call(inp, ref); inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true })); }
  }, refText).catch(() => {});
  await sleep(400);

  // Step 8: Purpose = Other
  const purposeSels = await page.$$('select');
  const purposeHandle = purposeSels[1] || purposeSels[0];
  if (purposeHandle) {
    for (let a = 0; a < 3; a++) {
      await purposeHandle.focus().catch(() => {});
      await purposeHandle.click().catch(() => {});
      await page.waitForFunction(() => { const s = document.querySelectorAll('select'); const t = s[1] || s[0]; return t && t.options.length > 1; }, { timeout: 4000 }).catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(300);
      const opts = await purposeHandle.evaluate(el => Array.from(el.options).map(o => ({ text: o.text.trim(), value: o.value }))).catch(() => []);
      const other = opts.find(o => o.text.toLowerCase().includes('other'));
      if (other) { await purposeHandle.select(other.value); break; }
    }
  }
  await sleep(400);

  console.log(`[Pipeline] Tab filled: KES ${job.amount} → ${TO_ACCOUNT} (${EXPECTED_NAME})`);

  // Vision loop: handle Continue → Review → stop at PIN
  for (let step = 0; step < 15; step++) {
    await sleep(step === 0 ? 500 : 2000);
    ss = await page.screenshot({ encoding: 'base64' });
    const vAction = await imVisionVerify(ss,
      `I&M Bank local transfer. Current screen?
      - "form" = transfer form with Continue button
      - "review" = "Local Transfer - Review" modal with Submit button
      - "pin" = PIN entry screen
      - "success" = green checkmark or success message
      - "other" = loading or anything else
      JSON only: {"screen":"form|review|pin|success|other","reference":"ref or null"}`
    );
    if (!vAction) continue;

    if (vAction.screen === 'pin') {
      console.log(`[Pipeline] Tab at PIN screen — handing to sequencer`);
      return { readyForPin: true };
    }
    if (vAction.screen === 'success') return { success: true, reference: vAction.reference };

    if (vAction.screen === 'form') {
      const coords = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === 'Continue' && !b.disabled);
        if (!btn) return null;
        btn.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = btn.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }).catch(() => null);
      if (coords?.x > 0) await page.mouse.click(coords.x, coords.y);
      else { const xp = await $x('//button[contains(text(),"Continue")]'); if (xp.length) await xp[0].click().catch(() => {}); }
      continue;
    }
    if (vAction.screen === 'review') {
      const coords = await page.evaluate(() => {
        const container = document.querySelector('mat-dialog-container,[role="dialog"],.cdk-overlay-pane') || document.body;
        const btn = Array.from(container.querySelectorAll('button')).find(b => (b.textContent || '').trim() === 'Submit');
        if (!btn) return null;
        btn.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = btn.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }).catch(() => null);
      if (coords?.x > 0) await page.mouse.click(coords.x, coords.y);
      else { const xp = await $x('//button[contains(text(),"Submit")]'); if (xp.length) await xp[0].click().catch(() => {}); }
      await sleep(3000);
      continue;
    }
    // 'other' — loading/transition
  }
  throw new Error('Form phase: did not reach PIN screen after 15 Vision steps');
}

// Phase 2: enter PIN and confirm success (called serially — only one tab at a time).
// Returns { success: true, reference } or throws.
async function _imEnterPinAndConfirm(page) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $x = async xpath => page.$$('::-p-xpath(' + xpath + ')').catch(() => []);

  for (let step = 0; step < 12; step++) {
    await sleep(step === 0 ? 300 : 2000);
    const ss = await page.screenshot({ encoding: 'base64' });
    const vAction = await imVisionVerify(ss,
      `I&M Bank transfer. Current screen?
      - "pin" = PIN entry screen with password/PIN input
      - "success" = green checkmark or "Payment Successful" / "Transfer Successful"
      - "other" = loading, error, or anything else
      JSON only: {"screen":"pin|success|other","reference":"ref or null"}`
    );
    if (!vAction) continue;

    if (vAction.screen === 'success') {
      console.log(`[Pipeline] PIN confirmed — transfer success, ref: ${vAction.reference || 'N/A'}`);
      const closeBtn = await $x('//button[contains(text(),"Close")]').catch(() => []);
      if (closeBtn.length > 0) await closeBtn[0].click().catch(() => {});
      await sleep(800);
      return { success: true, reference: vAction.reference };
    }

    if (vAction.screen === 'pin') {
      await page.evaluate(() => {
        const inp = document.querySelector('input[type="password"],input[type="tel"]');
        if (inp) { inp.click(); inp.focus(); }
      }).catch(() => {});
      await sleep(300);
      for (const digit of String(imPin)) { await page.keyboard.press(digit); await sleep(150); }
      await sleep(800);
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim().toLowerCase() === 'complete');
        if (btn) { btn.scrollIntoView({ block: 'center', behavior: 'instant' }); btn.click(); }
      }).catch(() => {});
      console.log('[Pipeline] PIN entered + Complete clicked');
      await sleep(4000);
      continue;
    }
    // 'other' — loading/transition
  }
  throw new Error('PIN phase: success screen not detected after 12 steps');
}

// Pipeline coordinator: fills forms concurrently across tabs, enters PIN serially.
async function runBatchDisbursementsPipeline(batchId, jobs, pages) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const jobQueue = [...jobs]; // shared queue, pop from front
  let completedCount = 0;
  let failedCount = 0;

  // Per-tab state: idle → filling → ready_for_pin → pin_entering
  const tabs = pages.map((page, i) => ({
    page, index: i,
    state: 'idle',
    job: null,
    pinDoneResolve: null,
  }));

  const reportComplete = async (job, reference) => {
    completedCount++;
    sendBotLog('success', `Batch ${batchId}: KES ${job.amount} → ${job.destination_name || job.destination} complete (ref: ${reference || 'N/A'})`);
    await fetch(`${API_BASE}/ext/batch-item-complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ item_id: job.item_id, reference }),
    }).catch(() => {});
  };

  const reportFailed = async (job, error) => {
    failedCount++;
    sendBotLog('error', `Batch ${batchId}: item ${job.item_id} failed — ${error}`);
    await fetch(`${API_BASE}/ext/batch-item-failed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ item_id: job.item_id, error }),
    }).catch(() => {});
  };

  // Fill worker: one per tab, runs concurrently
  const fillWorker = async (tab) => {
    while (true) {
      const job = jobQueue.shift();
      if (!job) break;

      tab.state = 'filling';
      tab.job = job;
      console.log(`[Pipeline] Tab ${tab.index}: filling form for item ${job.item_id} KES ${job.amount} → ${job.destination}`);
      sendBotLog('info', `Tab ${tab.index + 1}: filling form — KES ${job.amount} → ${job.destination_name || job.destination}`);

      try {
        const result = await _imFillUntilPin(job, tab.page);

        if (result.success) {
          // Portal skipped PIN (very unusual) — report and continue
          await reportComplete(job, result.reference);
        } else if (result.readyForPin) {
          // Hand off to PIN sequencer
          tab.state = 'ready_for_pin';
          await new Promise(resolve => { tab.pinDoneResolve = resolve; });
          // pinDoneResolve called by sequencer after success/failure handled
        }
      } catch (e) {
        console.log(`[Pipeline] Tab ${tab.index}: fill error for item ${job.item_id}:`, e.message?.substring(0, 80));
        await reportFailed(job, e.message);
        // If tab ended up stuck at PIN somehow, release
        if (tab.state === 'ready_for_pin' && tab.pinDoneResolve) {
          tab.pinDoneResolve();
          tab.pinDoneResolve = null;
        }
      }

      tab.state = 'idle';
      tab.job = null;
    }
  };

  // PIN sequencer: runs serially, processes one tab at a time
  const pinSequencer = async () => {
    while (true) {
      const allDone = tabs.every(t => t.state === 'idle') && jobQueue.length === 0;
      if (allDone) break;

      const readyTab = tabs.find(t => t.state === 'ready_for_pin');
      if (!readyTab) { await sleep(300); continue; }

      readyTab.state = 'pin_entering';
      const job = readyTab.job;
      console.log(`[Pipeline] Sequencer: entering PIN for tab ${readyTab.index} — item ${job.item_id}`);
      sendBotLog('info', `Entering PIN for KES ${job.amount} → ${job.destination_name || job.destination}`);

      try {
        const result = await _imEnterPinAndConfirm(readyTab.page);
        await reportComplete(job, result.reference);
      } catch (e) {
        console.log(`[Pipeline] PIN failed for item ${job.item_id}:`, e.message?.substring(0, 80));
        await reportFailed(job, e.message);
      }

      // Signal fill worker to continue with next job
      if (readyTab.pinDoneResolve) {
        readyTab.pinDoneResolve();
        readyTab.pinDoneResolve = null;
      }
      readyTab.state = 'idle';
    }
  };

  // Run fill workers and sequencer concurrently
  await Promise.all([
    ...tabs.map(tab => fillWorker(tab)),
    pinSequencer(),
  ]);

  console.log(`[Pipeline] Batch ${batchId} complete — ${completedCount} ok, ${failedCount} failed`);
  sendBotLog(failedCount === 0 ? 'success' : 'warning',
    `Batch ${batchId}: ${completedCount}/${jobs.length} transfers complete${failedCount ? `, ${failedCount} failed` : ''}`
  );
}

// ── Batch Withdrawal Disbursement ──────────────────────────────────────────────
// Read the current KES balance of the SPARK FREELANCE SOLUTIONS I&M account.
// Navigates to the I&M dashboard and uses Vision to extract the balance figure.
async function readSparkImBalance() {
  if (!imPage || imPage.isClosed()) return null;
  // Health check before navigating — catches session expiry / portal down
  const health = await checkImPageHealth(imPage);
  if (health !== 'ok') {
    console.log(`[readSparkImBalance] I&M page unhealthy (${health}) — skipping balance read`);
    return null;
  }
  try {
    await imPage.bringToFront().catch(() => {});
    await imPage.goto('https://digital.imbank.com/inm-retail/dashboard', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 4000));
    const ss = await imPage.screenshot({ encoding: 'base64' });
    const prompt = `You are reading an I&M Bank internet banking dashboard screenshot.
Find the account named "SPARK FREELANCE SOLUTIONS" (account number 00108094726150).
Return ONLY a JSON object: {"balance": <number>} where balance is the KES available balance as a plain number (no commas, no currency symbol).
If you cannot find the account or the balance, return {"balance": null}.`;
    const result = await callVision(ss, prompt);
    const parsed = typeof result === 'string' ? JSON.parse(result) : result;
    const balance = parsed?.balance;
    if (balance !== null && balance !== undefined && !isNaN(Number(balance))) {
      console.log(`[SparkP2P] SPARK FREELANCE SOLUTIONS I&M balance: KES ${Number(balance).toLocaleString()}`);
      return Number(balance);
    }
    console.log('[SparkP2P] readSparkImBalance: could not parse balance from Vision response', result);
    return null;
  } catch (e) {
    console.error('[SparkP2P] readSparkImBalance error:', e.message?.substring(0, 80));
    return null;
  }
}

// After a batch M-PESA sweep completes, confirm the money reached Spark Freelance
// Solutions I&M Bank before triggering disbursements (3 attempts × 5 min apart).
async function verifyImBalanceAndDisburse(batchId, expectedAmount) {
  if (!token) return;
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 5 * 60 * 1000; // 5 minutes

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`[BatchVerify] Batch ${batchId}: checking I&M balance (attempt ${attempt}/${MAX_ATTEMPTS})...`);
    sendBotLog('info', `Batch ${batchId}: verifying I&M balance (attempt ${attempt}/${MAX_ATTEMPTS})`);

    // Wait 5 minutes on first attempt — sweep runs at :55, money reflects ~:00, disburse ~:01
    const waitMs = attempt === 1 ? 5 * 60 * 1000 : RETRY_DELAY_MS;
    await new Promise(r => setTimeout(r, waitMs));

    const balance = await readSparkImBalance();
    if (balance === null) {
      console.log(`[BatchVerify] Batch ${batchId}: could not read I&M balance — will retry`);
      continue;
    }

    try {
      const res = await fetch(`${API_BASE}/ext/batch-balance-verified`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ batch_id: batchId, im_balance: balance }),
      });
      const data = res.ok ? await res.json().catch(() => ({})) : {};

      if (data.verified) {
        console.log(`[BatchVerify] Batch ${batchId}: I&M balance KES ${balance.toLocaleString()} confirmed ✅ — starting disbursements`);
        sendBotLog('success', `Batch ${batchId}: I&M balance confirmed KES ${balance.toLocaleString()} — starting disbursements`);
        await runBatchDisbursements(batchId);
        return;
      } else {
        console.log(`[BatchVerify] Batch ${batchId}: balance KES ${balance.toLocaleString()} < required KES ${expectedAmount.toLocaleString()} — retrying in 5 min`);
        sendBotLog('warning', `Batch ${batchId}: I&M balance KES ${balance.toLocaleString()} not yet sufficient (need KES ${expectedAmount.toLocaleString()})`);
      }
    } catch (e) {
      console.error(`[BatchVerify] Batch ${batchId}: error reporting balance:`, e.message?.substring(0, 80));
    }
  }

  // All retries exhausted — the backend monitor will send an SMS alert after 1 hour
  console.error(`[BatchVerify] Batch ${batchId}: I&M balance not confirmed after ${MAX_ATTEMPTS} attempts. Admin will be alerted.`);
  sendBotLog('error', `Batch ${batchId}: I&M balance not confirmed after ${MAX_ATTEMPTS} attempts. Check Spark Freelance Solutions account.`);
}

// After a batch M-PESA sweep completes, open up to BATCH_PARALLEL_TABS I&M browser
// tabs and process all queued batch items concurrently.
const BATCH_PARALLEL_TABS = 3;

async function runBatchDisbursements(batchId) {
  if (!token) return;
  console.log(`[BatchDisburse] Batch ${batchId}: starting disbursements...`);
  sendBotLog('info', `Batch ${batchId}: starting I&M disbursements`);

  // Fetch all queued batch items (with retries)
  let jobs = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(`${API_BASE}/ext/pending-batch-disbursements`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (r.ok) { const d = await r.json(); jobs = d.jobs || []; break; }
    } catch (e) {}
    if (attempt < 3) await new Promise(r => setTimeout(r, 5000));
  }

  if (jobs.length === 0) {
    console.log(`[BatchDisburse] Batch ${batchId}: no items found`);
    return;
  }
  console.log(`[BatchDisburse] Batch ${batchId}: ${jobs.length} item(s) to disburse`);

  // Health check before opening parallel tabs — fail fast if portal is down
  const health = await checkImPageHealth(imPage);
  if (health !== 'ok') {
    console.log(`[BatchDisburse] Batch ${batchId}: I&M portal unhealthy (${health}) — aborting disbursements`);
    sendBotLog('error', `Batch ${batchId}: I&M portal issue (${health}) — disbursements paused. Admin has been alerted.`);
    return;
  }

  // Collect available I&M pages — start with the existing imPage
  const pages = [];
  if (imPage && !imPage.isClosed()) pages.push(imPage);

  // Open additional I&M tabs (share same browser session/cookies)
  const numParallel = Math.min(BATCH_PARALLEL_TABS, jobs.length);
  if (browser && pages.length < numParallel) {
    for (let i = pages.length; i < numParallel; i++) {
      try {
        const newPage = await browser.newPage();
        if (imPage && !imPage.isClosed()) {
          const cookies = await imPage.cookies('https://digital.imbank.com').catch(() => []);
          if (cookies.length) await newPage.setCookie(...cookies).catch(() => {});
        }
        await newPage.goto('https://digital.imbank.com/inm-retail/dashboard', {
          waitUntil: 'domcontentloaded', timeout: 20000,
        }).catch(() => {});
        pages.push(newPage);
        console.log(`[BatchDisburse] Opened extra I&M tab ${i + 1}`);
      } catch (e) {
        console.log(`[BatchDisburse] Could not open extra I&M tab:`, e.message?.substring(0, 60));
        break;
      }
    }
  }

  if (pages.length === 0) {
    console.log('[BatchDisburse] No I&M pages available — aborting');
    return;
  }

  // Run the pipeline: fill forms concurrently, enter PINs serially
  await runBatchDisbursementsPipeline(batchId, jobs, pages);

  // Close extra I&M tabs (keep the original imPage)
  for (let i = 1; i < pages.length; i++) {
    await pages[i].close().catch(() => {});
  }

  console.log(`[BatchDisburse] Batch ${batchId}: all ${jobs.length} item(s) processed`);
  sendBotLog('success', `Batch ${batchId}: all ${jobs.length} withdrawal(s) disbursed`);

  // Return focus to M-PESA portal
  if (mpesaOrgPage && !mpesaOrgPage.isClosed()) await mpesaOrgPage.bringToFront().catch(() => {});
}

// Poll VPS every 30s for pending bank withdrawals and execute them
setInterval(async () => {
  if (!token || !imPage || imPage.isClosed() || imWithdrawalRunning || !isOnline) return;
  try {
    const res = await fetch(`${API_BASE}/ext/pending-bank-withdrawals`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.jobs && data.jobs.length > 0) {
      console.log(`[SparkP2P] ${data.jobs.length} pending I&M withdrawal(s) found â€" executing first`);
      const job = data.jobs[0];
      await executeImLocalTransfer(job);
    }
  } catch (e) {}
}, 30 * 1000);

// Poll VPS every 60s for pending settlement disbursements (SPARK FREELANCE SOLUTIONS → trader I&M accounts)
setInterval(async () => {
  if (!token || !imPage || imPage.isClosed() || imWithdrawalRunning || !isOnline) return;
  try {
    const res = await fetch(`${API_BASE}/ext/pending-im-disbursements`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.disbursements || data.disbursements.length === 0) return;
    const d = data.disbursements[0];
    console.log(`[SparkP2P] Settlement disbursement: KES ${d.amount} → ${d.trader_name} (${d.account_number})`);
    const job = {
      id: d.disbursement_id,
      amount: d.amount,
      destination_account: d.account_number,
      destination_name: d.trader_name,
      reference: d.reference,
    };
    try {
      await executeImLocalTransfer(job);
      await fetch(`${API_BASE}/ext/im-disbursement-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ disbursement_id: d.disbursement_id, reference_id: job.reference }),
      }).catch(() => {});
    } catch (e) {
      await fetch(`${API_BASE}/ext/im-disbursement-failed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ disbursement_id: d.disbursement_id, error: e.message }),
      }).catch(() => {});
    }
  } catch (e) {}
}, 60 * 1000);

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// M-PESA ORG PORTAL AUTOMATION
// Automates org.ke.m-pesa.com to sweep funds from paybill 4041355
// → linked I&M Bank account (FREE â€" "No charge" confirmed in portal)
// Same approach as I&M Bank: real Chrome tab, cookie persistence, Vision
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// ── Connectivity Monitor ─────────────────────────────────────────────────────
// Detects internet loss/restore and recovers Chrome sessions automatically.
// On disconnect: logs warning, marks offline, prevents new automation.
// On reconnect: refreshes all Chrome tabs and resets stuck automation flags.

let isOnline = true;
let offlineSince = null;
let connectivityFailures = 0;
const CONNECTIVITY_FAILURES_NEEDED = 2;

async function checkConnectivity() {
  try {
    const r = await fetch(`${API_BASE}/health`, {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    return r.ok || r.status < 500;
  } catch {
    return false;
  }
}

async function recoverSessions() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  console.log('[SparkP2P] Backend restored — recovering Chrome sessions');
  sendBotLog('info', 'Backend restored — refreshing sessions and resuming automation');

  // Reset stuck automation flags from any interrupted operations
  if (mpesaSweepRunning) {
    console.log('[SparkP2P] Resetting stuck mpesaSweepRunning flag');
    mpesaSweepRunning = false;
    lastSweepCompletedAt = Date.now(); // enforce cooldown before next attempt
  }
  if (imWithdrawalRunning) {
    console.log('[SparkP2P] Resetting stuck imWithdrawalRunning flag');
    imWithdrawalRunning = false;
  }

  // Refresh M-PESA org portal tab
  if (mpesaOrgPage && !mpesaOrgPage.isClosed()) {
    try {
      await mpesaOrgPage.goto(MPESA_ORG_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
      console.log('[SparkP2P] M-PESA org portal tab refreshed');
    } catch (e) {
      console.log('[SparkP2P] M-PESA tab refresh failed:', e.message);
    }
    await sleep(1500);
  }

  // Refresh I&M Bank tab — go to dashboard to re-establish session
  if (imPage && !imPage.isClosed()) {
    try {
      await imPage.goto('https://digital.imbank.com/inm-retail/dashboard', { waitUntil: 'networkidle2', timeout: 25000 });
      await syncImCookies();
      console.log('[SparkP2P] I&M Bank tab refreshed and cookies synced');
    } catch (e) {
      console.log('[SparkP2P] I&M tab refresh failed:', e.message);
    }
  }

  // Reconcile Binance order state before resuming automation.
  // This syncs any orders the trader completed/cancelled manually during the outage
  // so the VPS DB matches Binance reality and the bot doesn't re-process them.
  sendBotLog('info', 'Reconciling Binance orders completed during outage...');
  try {
    const binancePage = await getPage('binance.com').catch(() => null);
    if (binancePage && pollerRunning) {
      await reconcileStuckOrders(binancePage);
      sendBotLog('success', 'Reconciliation done — bot resuming from current Binance state (manually handled orders are skipped)');
    } else {
      sendBotLog('info', 'Sessions recovered — automation resumed');
    }
  } catch (e) {
    console.log('[SparkP2P] Post-reconnect reconciliation error:', e.message);
    sendBotLog('success', 'Sessions recovered — automation resumed');
  }
}

setInterval(async () => {
  const online = await checkConnectivity();
  if (online) {
    connectivityFailures = 0;
    if (!isOnline) {
      const downtime = offlineSince ? Math.round((Date.now() - offlineSince) / 1000) : '?';
      console.log(`[SparkP2P] Backend reachable — restored after ${downtime}s`);
      isOnline = true;
      offlineSince = null;
      await recoverSessions();
    }
  } else {
    connectivityFailures++;
    if (connectivityFailures >= CONNECTIVITY_FAILURES_NEEDED && isOnline) {
      isOnline = false;
      offlineSince = Date.now();
      connectivityFailures = 0;
      console.log('[SparkP2P] Backend unreachable — automation paused');
      sendBotLog('warning', 'Backend unreachable — automation paused. Binance ads remain live.');
    } else if (connectivityFailures < CONNECTIVITY_FAILURES_NEEDED) {
      console.log(`[SparkP2P] Backend health check failed (${connectivityFailures}/${CONNECTIVITY_FAILURES_NEEDED}) — waiting to confirm`);
    }
  }
}, 15000);

// ─────────────────────────────────────────────────────────────────────────────

const MPESA_ORG_URL = 'https://org.ke.m-pesa.com';
const MPESA_ORG_REVENUE_URL = 'https://org.ke.m-pesa.com/#/mainPage/businessCenter/settlement/revenueSettlement/initiate';
const MPESA_ORG_INITIATE_URL = 'https://org.ke.m-pesa.com/#/mainPage/transactionCenter/initiate/initiateTransaction/list';
const MPESA_ORG_KEEP_ALIVE_INTERVAL = 2 * 60 * 1000; // ping every 2 min
let mpesaOrgKeepAliveTimer = null;

async function connectMpesaPortal() {
  if (connectingMpesa) return;
  connectingMpesa = true;
  console.log('[SparkP2P] Opening M-PESA org portal tab...');
  try {
    // Ensure main browser is running â€" launch if needed
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
      // Restore saved session cookies before navigating â€" avoids login page if session still valid
      const savedMpesaCookies = loadMpesaCookiesLocal();
      if (savedMpesaCookies) {
        await restoreCookiesToPage(mpesaOrgPage, savedMpesaCookies, MPESA_ORG_URL);
        console.log('[SparkP2P] M-PESA saved session cookies restored â€" attempting silent reconnect');
      }
      await mpesaOrgPage.goto(MPESA_ORG_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    }
    await mpesaOrgPage.bringToFront();
    mpesaOrgPage.on('close', () => { mpesaOrgPage = null; mpesaPortalReady = false; });

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
          mpesaPortalReady = true; // Portal confirmed logged in — sweeps may now execute
          console.log('[SparkP2P] M-PESA portal login confirmed! Starting keep-alive...');
          // Save cookies locally so next reconnect skips login page
          const mpesaFreshCookies = await mpesaOrgPage.cookies(MPESA_ORG_URL).catch(() => []);
          if (mpesaFreshCookies.length) saveMpesaCookiesLocal(mpesaFreshCookies);
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
          sendBotLog('success', 'M-Pesa Organization Portal connected');
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
      if (mpesaSweepRunning) return; // don't interrupt a sweep

      const currentUrl = mpesaOrgPage.url();

      // If portal has logged us out, reconnect automatically
      if (currentUrl.includes('/login') || currentUrl === MPESA_ORG_URL + '/' || currentUrl === MPESA_ORG_URL) {
        console.log('[SparkP2P] M-PESA portal session expired — reconnecting');
        sendBotLog('warning', 'M-Pesa portal session expired — reconnecting');
        mpesaPortalReady = false; // Block sweeps until re-login confirmed
        clearInterval(mpesaOrgKeepAliveTimer);
        mpesaOrgKeepAliveTimer = null;
        connectMpesaPortal().catch(() => {});
        return;
      }

      // Navigate to the initiate page to reset the server-side session timer.
      // A HEAD fetch is not enough — the portal (Huawei) only counts real page loads.
      await mpesaOrgPage.goto(MPESA_ORG_INITIATE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

      // Refresh locally saved cookies so next reconnect uses latest tokens
      const mpesaKaCookies = await mpesaOrgPage.cookies(MPESA_ORG_URL).catch(() => []);
      if (mpesaKaCookies.length) saveMpesaCookiesLocal(mpesaKaCookies);

      console.log('[SparkP2P] M-PESA portal keep-alive: navigated to initiate page');
    } catch (e) {
      console.log('[SparkP2P] M-PESA portal keep-alive error:', e.message);
    }
  }, MPESA_ORG_KEEP_ALIVE_INTERVAL);
}

// â"€â"€ Paybill Statement Scraper â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
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
    console.log(`[PaybillSync] Sync complete â€" inserted: ${pushData.inserted}, skipped: ${pushData.skipped}`);

  } catch (e) {
    console.error('[PaybillSync] Error:', e.message?.substring(0, 100));
  } finally {
    // Navigate back to portal home so the tab isn't left on the statement/404 page
    if (mpesaOrgPage && !mpesaOrgPage.isClosed()) {
      await mpesaOrgPage.goto(MPESA_ORG_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    }
  }
}

function startPaybillSync() {
  if (paybillSyncTimer) clearInterval(paybillSyncTimer);
  // First run after 30 min â€" don't navigate away from portal immediately after login
  paybillSyncTimer = setInterval(scrapePaybillStatement, 30 * 60 * 1000);
  console.log('[PaybillSync] Statement sync started (every 30 min, first run in 30 min)');
}

// â"€â"€ Shared helper: fill a form on the M-PESA org portal â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
// Fills Amount(KSH), Remark, and Reason (Input Manually) on the current page,
// then clicks Submit. Used by both Revenue Settlement and Org Withdrawal steps.
async function _fillAndSubmitMpesaForm(page, amount, remark, reason) {
  // M-PESA portal rejects amounts with more than 2 decimal places
  const amtStr = (Math.round(amount * 100) / 100).toFixed(2).replace(/\.00$/, '');
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
  }, amtStr).catch(() => false);

  if (!amountFilled) await fillFieldWithVision(page, 'Amount(KSH)', amtStr);
  console.log(`[SparkP2P] Amount filled: ${amountFilled} (${amtStr})`);

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
    // For custom dropdown already showing "Input Manually..." â€" nothing to do
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

// â"€â"€ Wait for "Operation succeeded." or "Transaction Budget" popup â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
async function _waitForMpesaSuccess(page, screenshotLabel) {
  await new Promise(r => setTimeout(r, 3000));

  // Check for success message first
  const succeeded = await page.evaluate(() => {
    const body = document.body.innerText.toLowerCase();
    return body.includes('operation succeeded') || body.includes('transaction has been processed') ||
           body.includes('successfully') || body.includes('success');
  }).catch(() => false);

  if (succeeded) {
    console.log(`[SparkP2P] âœ… ${screenshotLabel} â€" "Operation succeeded." detected`);
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
    await new Promise(r => setTimeout(r, 4000));
    await takeScreenshot(screenshotLabel + '_after_popup', page);
    // Verify success after popup dismissal
    const succeededAfterPopup = await page.evaluate(() => {
      const body = document.body.innerText.toLowerCase();
      return body.includes('operation succeeded') || body.includes('transaction has been processed') ||
             body.includes('successfully') || body.includes('success');
    }).catch(() => false);
    console.log(`[SparkP2P] Post-popup success: ${succeededAfterPopup}`);
    return true;
  }

  // Vision fallback â€" check what's on screen
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

// â"€â"€ Full sweep: Step 1 Revenue Settlement + Step 2 Org Withdrawal â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
async function executeMpesaSweep(sweepJob) {
  // sweepJob = { sweep_id, amount, reference }
  if (mpesaSweepRunning) return { success: false, error: 'sweep_in_progress' };
  if (!mpesaOrgPage || mpesaOrgPage.isClosed()) {
    // Lazy-connect: portal not open yet — try silent reconnect using saved cookies
    console.log('[SparkP2P] M-PESA org page not open — attempting lazy connect before sweep');
    sendBotLog('info', 'M-Pesa portal not connected — connecting now for sweep...');
    if (!connectingMpesa) connectMpesaPortal().catch(() => {});
    // Wait up to 90 seconds for portal tab to open AND Vision to confirm login
    let waited = 0;
    while ((!mpesaPortalReady) && waited < 90000) {
      await new Promise(r => setTimeout(r, 2000));
      waited += 2000;
    }
    if (!mpesaPortalReady || !mpesaOrgPage || mpesaOrgPage.isClosed()) {
      console.log('[SparkP2P] M-PESA portal not logged in after 90s — sweep aborted');
      sendBotLog('error', 'M-Pesa portal not connected — go to Settings to connect manually');
      return { success: false, error: 'portal_not_connected' };
    }
  }
  mpesaSweepRunning = true;
  const { sweep_id, reference } = sweepJob;
  const amount = Math.round(sweepJob.amount * 100) / 100; // round to 2 d.p. — portal rejects >2 decimals
  console.log(`[SparkP2P] === M-PESA SWEEP KES ${amount} (sweep #${sweep_id}) ===`);
  await mpesaOrgPage.bringToFront().catch(() => {});

  // Reload the portal page before each sweep — this clears all internal SPA tabs
  // (Initiate Revenue Settlement, Transaction, etc.) left over from previous sweeps.
  // Navigating to home doesn't clear them; a full reload does.
  console.log('[SparkP2P] Reloading portal to clear tab state...');
  await mpesaOrgPage.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

  const failSweep = async (error) => {
    mpesaSweepRunning = false;
    lastSweepCompletedAt = Date.now(); // cooldown applies even on failure
    await takeScreenshot('mpesa_sweep_error', mpesaOrgPage).catch(() => {});
    if (token) await fetch(`${API_BASE}/ext/mpesa-sweep-failed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ sweep_id, error }),
    }).catch(() => {});
    return { success: false, error };
  };

  try {
    // â"€â"€ STEP 1: Revenue Settlement (utility float → working account) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    // Navigate directly to initiate URL â€" "All organization" is pre-selected by default
    console.log('[SparkP2P] Step 1: Revenue Settlement...');
    // Retry up to 3 times — back-to-back sweeps can leave the portal transitioning
    // so the revenue form loads but Submit isn't rendered yet. Fresh navigation fixes it.
    let step1Submitted = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await mpesaOrgPage.goto(MPESA_ORG_REVENUE_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
      await new Promise(r => setTimeout(r, attempt === 1 ? 4000 : 6000));
      await takeScreenshot(`sweep_step1_revenue_form_attempt${attempt}`, mpesaOrgPage);

      await mpesaOrgPage.evaluate(() => {
        const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
        const allOrg = radios.find(r => {
          const label = r.closest('label')?.textContent || r.nextSibling?.textContent || '';
          return label.toLowerCase().includes('all organization') || label.toLowerCase().includes('all organisation');
        });
        if (allOrg && !allOrg.checked) allOrg.click();
      }).catch(() => {});

      await new Promise(r => setTimeout(r, 1000));

      step1Submitted = await mpesaOrgPage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
        const btn = btns.find(b => b.textContent.trim().toLowerCase() === 'submit' || b.value?.toLowerCase() === 'submit');
        if (btn) { btn.scrollIntoView({ block: 'center' }); btn.click(); return true; }
        return false;
      }).catch(() => false);

      if (step1Submitted) break;
      console.log(`[SparkP2P] Step 1: Submit not found (attempt ${attempt}/3) — retrying...`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 4000));
    }

    if (!step1Submitted) return failSweep('Revenue Settlement: Submit button not found after 3 attempts');
    console.log('[SparkP2P] Step 1: Submit clicked');

    await new Promise(r => setTimeout(r, 2000));

    // Confirm dialog: "Are you sure you want to continue?" → click Confirm
    const step1Confirmed = await mpesaOrgPage.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b => b.textContent.trim().toLowerCase() === 'confirm');
      if (btn) { btn.click(); return true; }
      return false;
    }).catch(() => false);
    console.log(`[SparkP2P] Step 1: Confirm dialog clicked: ${step1Confirmed}`);

    // Wait for "Operation succeeded."
    await new Promise(r => setTimeout(r, 4000));
    const step1Ok = await mpesaOrgPage.evaluate(() =>
      document.body.innerText.toLowerCase().includes('operation succeeded')
    ).catch(() => false);
    console.log(`[SparkP2P] Step 1 result: ${step1Ok ? 'âœ… Operation succeeded' : 'unknown â€" proceeding anyway'}`);
    await takeScreenshot('sweep_step1_revenue_result', mpesaOrgPage);

    await new Promise(r => setTimeout(r, 2000));

    // â"€â"€ STEP 2: Organization Withdrawal (working account → I&M Bank) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    // Transaction Center → Initiate Transaction → "Organization Withdrawal From MPESA-Real Time"
    console.log('[SparkP2P] Step 2: Org Withdrawal to I&M Bank...');
    await mpesaOrgPage.goto(MPESA_ORG_INITIATE_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));
    await takeScreenshot('sweep_step2_withdrawal_form', mpesaOrgPage);

    // Select "Organization Withdrawal From MPESA-Real Time" â€" must match "real time" exactly
    const serviceSelected = await mpesaOrgPage.evaluate(() => {
      // Try native <select> first
      for (const sel of document.querySelectorAll('select')) {
        const target = Array.from(sel.options).find(o =>
          o.text.toLowerCase().includes('real time') && o.text.toLowerCase().includes('withdrawal')
        );
        if (target) {
          sel.value = target.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return 'select:' + target.text;
        }
      }
      // Custom dropdown: click the trigger to open
      for (const t of document.querySelectorAll('[class*="select"],[role="combobox"]')) {
        if ((t.textContent || '').toLowerCase().includes('transaction service') ||
            (t.getAttribute('placeholder') || '').toLowerCase().includes('service') ||
            t.closest('[class*="form"]')) {
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
        const t = opts.find(o =>
          o.textContent.toLowerCase().includes('real time') && o.textContent.toLowerCase().includes('withdrawal')
        );
        if (t) t.click();
      }).catch(() => {});
    }

    // Wait for the form to fully load after service selection (fields render dynamically)
    await new Promise(r => setTimeout(r, 4000));

    // Scroll to bottom of page so all form fields render
    await mpesaOrgPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));
    await mpesaOrgPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));
    await takeScreenshot('sweep_step2_after_service_select', mpesaOrgPage);

    // Log all visible input fields to help debug if amount not found
    const allInputs = await mpesaOrgPage.evaluate(() =>
      Array.from(document.querySelectorAll('input')).map(el => ({
        placeholder: el.placeholder, name: el.name, id: el.id, type: el.type,
        label: el.closest('div,td,tr,label')?.textContent?.trim().substring(0, 60),
      }))
    ).catch(() => []);
    console.log('[SparkP2P] All inputs on page:', JSON.stringify(allInputs.slice(0, 20)));

    // Find Amount field â€" check placeholder, name, id, aria-label, and surrounding label text
    const amountHandle = await mpesaOrgPage.evaluateHandle((amt) => {
      const inputs = Array.from(document.querySelectorAll('input'));
      return inputs.find(el => {
        const ctx = [
          el.placeholder, el.getAttribute('aria-label'), el.name, el.id,
          el.closest('div,td,tr,label,th')?.textContent || '',
          el.closest('[class*="form-group"],[class*="field"],[class*="row"]')?.textContent || '',
        ].join(' ').toLowerCase();
        return ctx.includes('amount') || ctx.includes('ksh') || ctx.includes('kes');
      }) || null;
    }, amount).catch(() => null);

    const amountEl = amountHandle?.asElement ? amountHandle.asElement() : null;

    let amountFilled = false;
    if (amountEl) {
      await amountEl.scrollIntoView().catch(() => {});
      await new Promise(r => setTimeout(r, 500));
      await amountEl.click({ clickCount: 3 }).catch(() => {}); // select all
      await amountEl.type(String(amount), { delay: 80 });
      await mpesaOrgPage.evaluate(el => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, amountEl).catch(() => {});
      amountFilled = true;
      console.log('[SparkP2P] Step 2: Amount filled via element handle');
    }

    if (!amountFilled) {
      // Fallback: try clicking each input and checking label, then type
      amountFilled = await mpesaOrgPage.evaluate((amt) => {
        const inputs = Array.from(document.querySelectorAll('input'));
        for (const inp of inputs) {
          const rect = inp.getBoundingClientRect();
          if (rect.width === 0) continue; // skip hidden
          const ctx = [
            inp.placeholder, inp.getAttribute('aria-label'), inp.name, inp.id,
            inp.closest('div,td,tr,label,th')?.textContent || '',
          ].join(' ').toLowerCase();
          if (ctx.includes('amount') || ctx.includes('ksh') || ctx.includes('kes')) {
            inp.scrollIntoView({ block: 'center' });
            inp.focus();
            inp.value = String(amt);
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        return false;
      }, amount).catch(() => false);
    }

    console.log(`[SparkP2P] Step 2: Amount filled: ${amountFilled}`);
    if (!amountFilled) return failSweep('Org Withdrawal: Amount field not found');

    await new Promise(r => setTimeout(r, 400));

    // Fill Remark textarea
    await mpesaOrgPage.evaluate(() => {
      const ta = Array.from(document.querySelectorAll('textarea'));
      const remark = ta.find(el => (el.placeholder || '').toLowerCase().includes('remark'));
      if (remark) { remark.value = 'I&M transactions'; remark.dispatchEvent(new Event('input', { bubbles: true })); }
    }).catch(() => {});

    await new Promise(r => setTimeout(r, 300));

    // Fill "Enter The Reason..." textarea (Reason field â€" "Input Manually..." already selected)
    await mpesaOrgPage.evaluate(() => {
      const ta = Array.from(document.querySelectorAll('textarea'));
      const reason = ta.find(el => (el.placeholder || '').toLowerCase().includes('reason'));
      if (reason) { reason.value = 'I&M transactions'; reason.dispatchEvent(new Event('input', { bubbles: true })); }
    }).catch(() => {});

    await new Promise(r => setTimeout(r, 300));

    // Fill "Comment to Customer" textarea
    await mpesaOrgPage.evaluate(() => {
      const ta = Array.from(document.querySelectorAll('textarea'));
      const comment = ta.find(el => (el.placeholder || '').toLowerCase().includes('comment'));
      if (comment) { comment.value = 'I&M transactions'; comment.dispatchEvent(new Event('input', { bubbles: true })); }
    }).catch(() => {});

    await new Promise(r => setTimeout(r, 400));
    await takeScreenshot('sweep_step2_before_submit', mpesaOrgPage);

    // Click Submit (bottom right)
    const step2Submitted = await mpesaOrgPage.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
      const btn = btns.find(b => b.textContent.trim().toLowerCase() === 'submit' || b.value?.toLowerCase() === 'submit');
      if (btn) { btn.scrollIntoView({ block: 'center' }); btn.click(); return true; }
      return false;
    }).catch(() => false);

    if (!step2Submitted) return failSweep('Org Withdrawal: Submit button not found');
    console.log('[SparkP2P] Step 2: Submit clicked');

    // Wait for result (success or OTP prompt)
    await new Promise(r => setTimeout(r, 4000));
    const step2Ok = await _waitForMpesaSuccess(mpesaOrgPage, 'sweep_step2_withdrawal');
    console.log(`[SparkP2P] Step 2 result: ${step2Ok ? '✅ success' : '❌ not confirmed'}`);

    if (!step2Ok) {
      // Dismiss any error popup before failing (e.g. "insufficient balance" modal with Confirm button)
      await mpesaOrgPage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const confirmBtn = btns.find(b => b.textContent.trim().toLowerCase() === 'confirm' || b.textContent.trim().toLowerCase() === 'ok');
        if (confirmBtn) confirmBtn.click();
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 1000));
      // Extract error description from the page if visible
      const errText = await mpesaOrgPage.evaluate(() => {
        const el = document.querySelector('.exception-description, [class*="exception"], [class*="error-desc"]');
        return el ? el.textContent.trim().substring(0, 200) : null;
      }).catch(() => null);
      return failSweep(errText || 'Org Withdrawal: success not confirmed after submit');
    }

    // Report to backend only after confirmed success
    let sweepResponse = null;
    if (token) {
      const sweepRes = await fetch(`${API_BASE}/ext/mpesa-sweep-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ sweep_id, amount, reference }),
      }).catch(() => null);
      if (sweepRes?.ok) sweepResponse = await sweepRes.json().catch(() => null);
    }

    console.log(`[SparkP2P] ✅ M-PESA sweep KES ${amount} complete`);
    sendBotLog('success', `M-Pesa paybill sweep KES ${amount} complete — funds transferred to I&M`);
    mpesaSweepRunning = false;
    lastSweepCompletedAt = Date.now();

    // Switch to I&M tab immediately
    if (imPage && !imPage.isClosed()) await imPage.bringToFront().catch(() => {});

    if (sweepResponse?.is_batch && sweepResponse?.batch_id) {
      // Batch sweep — verify money reached I&M before disbursing
      const expectedAmt = sweepResponse.expected_amount || sweep.amount || amount;
      console.log(`[SparkP2P] Batch sweep complete — verifying I&M balance before batch ${sweepResponse.batch_id} disbursements`);
      verifyImBalanceAndDisburse(sweepResponse.batch_id, expectedAmt);
    } else {
      // Individual withdrawal sweep — trigger single I&M transfer (legacy flow)
      const triggerImTransfer = async (attempt) => {
        if (!token) { console.log('[SparkP2P] Post-sweep: no token, skipping I&M trigger'); return; }
        if (!imPage || imPage.isClosed()) { console.log('[SparkP2P] Post-sweep: I&M page closed, skipping'); return; }
        if (imWithdrawalRunning) { console.log('[SparkP2P] Post-sweep: I&M transfer already in progress'); return; }
        try {
          const r = await fetch(`${API_BASE}/ext/pending-bank-withdrawals`, {
            headers: { 'Authorization': `Bearer ${token}` },
          });
          if (!r.ok) {
            if (attempt < 3) setTimeout(() => triggerImTransfer(attempt + 1), 10000);
            return;
          }
          const d = await r.json();
          if (d.jobs && d.jobs.length > 0) {
            const job = d.jobs[0];
            console.log(`[SparkP2P] Auto-triggering I&M transfer after sweep — KES ${job.amount}`);
            await imPage.bringToFront().catch(() => {});
            await executeImLocalTransfer(job);
          } else {
            if (attempt < 3) setTimeout(() => triggerImTransfer(attempt + 1), 10000);
          }
        } catch (e) {
          console.log(`[SparkP2P] Post-sweep trigger error (attempt ${attempt}):`, e.message);
          if (attempt < 3) setTimeout(() => triggerImTransfer(attempt + 1), 10000);
        }
      };
      setTimeout(() => triggerImTransfer(1), 5000);
    }

    return { success: true };

  } catch (e) {
    console.error('[SparkP2P] executeMpesaSweep error:', e.message?.substring(0, 80));
    return failSweep(e.message);
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
const SWEEP_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes between sweeps — portal needs to reset
setInterval(async () => {
  if (!token || !mpesaOrgPage || mpesaOrgPage.isClosed() || mpesaSweepRunning) return;
  if (!mpesaPortalReady) return; // Wait for Vision to confirm portal login before sweeping
  if (Date.now() - lastSweepCompletedAt < SWEEP_COOLDOWN_MS) return; // cooldown
  try {
    const res = await fetch(`${API_BASE}/ext/pending-mpesa-sweeps`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.sweeps && data.sweeps.length > 0) {
      console.log(`[SparkP2P] ${data.sweeps.length} pending M-PESA sweep(s) found â€" executing first`);
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
ipcMain.handle('pause-navigation', async () => { pauseNavigation = true; scanningInProgress = false; await unlockChromeBrowser(); startPauseInactivityTimer(); console.log('[SparkP2P] Navigation PAUSED â€" Chrome unlocked for manual use'); return { ok: true }; });
ipcMain.handle('resume-navigation', async () => { pauseNavigation = false; clearPauseInactivityTimer(); await lockChromeBrowser(); console.log('[SparkP2P] Navigation RESUMED â€" Chrome locked back to bot'); return { ok: true }; });
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
ipcMain.handle('set-token', (_, t) => {
  const isNew = !token && !!t;
  token = t;
  if (isNew && t) {
    // Token just arrived (admin portal login or page reload) â€" reset stale portal flags
    fetch(`${API_BASE}/traders/disconnect-im`, { method: 'POST', headers: { 'Authorization': `Bearer ${t}` } }).catch(() => {});
    fetch(`${API_BASE}/traders/disconnect-mpesa-portal`, { method: 'POST', headers: { 'Authorization': `Bearer ${t}` } }).catch(() => {});
    // Auto-connect M-Pesa portal using persisted Chrome cookies (I&M tab no longer auto-opened)
    if (browser) {
      setTimeout(() => connectMpesaPortal().catch(() => {}), 7000);
    }
  }
  return { ok: true };
});
ipcMain.handle('set-pin', (_, pin) => { traderPin = pin; console.log('[SparkP2P] Fund password configured'); return { ok: true }; });
ipcMain.handle('save-im-pin', (_, pin) => { saveImPin(pin); return { ok: true }; });
ipcMain.handle('clear-im-pin', () => { clearImPin(); return { ok: true }; });
ipcMain.handle('has-im-pin', () => ({ hasPin: !!imPin }));
ipcMain.handle('save-gmail-credentials', (_e, email, appPassword) => { saveGmailCredentials(email, appPassword); return true; });
ipcMain.handle('load-gmail-credentials', () => { const c = loadGmailCredentials(); return c ? { email: c.email, hasPassword: !!c.appPassword } : null; });
ipcMain.handle('clear-gmail-credentials', () => { clearGmailCredentials(); return true; });
ipcMain.handle('set-totp-secret', (_, secret) => { totpSecret = secret ? secret.toUpperCase().replace(/\s/g, '') : null; console.log('[SparkP2P] TOTP secret configured'); return { ok: true }; });
ipcMain.handle('verify-lock-totp', async (_, code) => {
  // Verify against SparkP2P TOTP (Settings -> Security) not the Binance 2FA secret
  if (token) {
    try {
      const res = await fetch(`${API_BASE}/traders/verify-totp`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: String(code).replace(/[^0-9]/g, '') }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          screenLocked = false;
          console.log('[SparkP2P] Screen unlocked via SparkP2P TOTP');
          return true;
        }
      }
    } catch (e) {
      console.log('[SparkP2P] Lock TOTP backend verify error:', e.message ? e.message.substring(0, 60) : '');
    }
  }
  // Fallback: no network or token — try local Binance TOTP so app is never permanently locked
  if (totpSecret) {
    const valid = verifyTOTP(totpSecret, String(code));
    if (valid) { screenLocked = false; console.log('[SparkP2P] Screen unlocked via fallback local TOTP'); return true; }
  } else {
    screenLocked = false;
    return true;
  }
  console.log('[SparkP2P] Lock screen: wrong TOTP attempt');
  return false;
});
ipcMain.handle('set-ai-key', (_, key) => { aiApiKey = key; console.log('[SparkP2P] AI key set (legacy)'); return { ok: true }; });
ipcMain.handle('set-anthropic-key', (_, key) => { anthropicApiKey = key; saveAnthropicKey(key); aiScanner.initAI(key); console.log('[SparkP2P] Claude configured and saved to disk'); return { ok: true }; });
ipcMain.handle('get-bot-status', () => ({ running: pollerRunning, stats, hasPin: !!traderPin, hasTOTP: !!totpSecret, hasAI: !!anthropicApiKey, hasVision: !!anthropicApiKey, version: app.getVersion() }));
ipcMain.handle('get-bot-logs', () => botLogBuffer);
ipcMain.handle('take-screenshot', async () => { const ss = await takeScreenshot('Manual request'); return { screenshot: ss }; });
ipcMain.handle('run-ai-scan', async () => { await aiScan(); return { ok: true }; });
ipcMain.handle('restart-app', () => { autoUpdater.quitAndInstall(); });
ipcMain.handle('check-for-updates', () => { autoUpdater?.checkForUpdatesAndNotify().catch(() => {}); return { ok: true }; });
ipcMain.handle('open-external', (_, url) => { shell.openExternal(url); return { ok: true }; });
ipcMain.handle('manual-mpesa-sweep', async (_, amount) => {
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) return { ok: false, error: 'Invalid amount' };
  if (!mpesaOrgPage || mpesaOrgPage.isClosed()) return { ok: false, error: 'M-PESA portal not connected' };
  if (mpesaSweepRunning) return { ok: false, error: 'Sweep already in progress' };
  console.log(`[SparkP2P] Manual M-PESA sweep triggered â€" KES ${amt}`);
  const result = await executeMpesaSweep({ sweep_id: 'manual', amount: amt, reference: 'Manual-' + Date.now() });
  return { ok: result?.success !== false, error: result?.error || null };
});