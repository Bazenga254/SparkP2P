'use strict';
/**
 * SparkP2P Settlement Bot
 * =======================
 * Phase 1 — M-Pesa Org Portal: Transfer paybill balance → Spark Freelance I&M (FREE)
 * Phase 2 — I&M Bank: Disburse to each trader's I&M account (0.05% fee deducted by VPS)
 *
 * Admin logs in to org.ke.m-pesa.com manually once + completes OTP.
 * Bot keeps session alive indefinitely and executes sweeps when triggered.
 */

const puppeteer  = require('puppeteer-core');
const fetch      = require('node-fetch');
const path       = require('path');
const fs         = require('fs');

// ── Configuration (set via environment variables on the Windows VPS) ──────────
const API_BASE        = process.env.SPARKP2P_API_BASE  || 'https://sparkp2p.com/api';
const BOT_TOKEN       = process.env.SPARKP2P_BOT_TOKEN || '';   // Trader JWT for ext API
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY  || '';
const CHROME_PATH     = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const IM_PIN          = process.env.IM_PIN || '';                // I&M Bank PIN
const IM_ACCOUNT      = process.env.IM_SPARK_ACCOUNT || '';      // Spark Freelance I&M account

const MPESA_PORTAL_URL = 'https://org.ke.m-pesa.com/#/login?service=https%3A%2F%2Forg.ke.m-pesa.com%2Forgportal%2Fv1%2Fsso%2Fhome';
const IM_URL           = 'https://digital.imbank.com/inm-retail/transfers/local-transfers/form';

const POLL_INTERVAL_MS     = 60_000;   // Check for pending sweeps every 60s
const KEEPALIVE_INTERVAL_MS = 4 * 60 * 1000; // Re-ping portal every 4 min to stay logged in

// ── State ─────────────────────────────────────────────────────────────────────
let browser      = null;
let mpesaPage    = null;   // org.ke.m-pesa.com tab
let imPage       = null;   // digital.imbank.com tab
let mpesaReady   = false;  // True once admin has logged in and we detected a live session
let settlementRunning = false;

// ── CDP zoom session store (per page) ─────────────────────────────────────────
const _zoomSessions = new WeakMap();

async function setZoom80(page) {
  try {
    let s = _zoomSessions.get(page);
    if (!s || !s._connection) { s = await page.createCDPSession(); _zoomSessions.set(page, s); }
    await s.send('Emulation.setPageScaleFactor', { pageScaleFactor: 0.8 });
  } catch (_) {
    try { await page.evaluate(() => { document.documentElement.style.zoom = '80%'; }); } catch (__) {}
  }
}

async function resetZoom(page) {
  try {
    let s = _zoomSessions.get(page);
    if (!s || !s._connection) { s = await page.createCDPSession(); _zoomSessions.set(page, s); }
    await s.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
  } catch (_) {
    try { await page.evaluate(() => { document.documentElement.style.zoom = '100%'; }); } catch (__) {}
  }
}

// ── Vision helper ─────────────────────────────────────────────────────────────
async function askVision(imageBase64, prompt, maxTokens = 300) {
  if (!ANTHROPIC_KEY) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: prompt },
      ]}],
    }),
  }).catch(() => null);
  if (!res?.ok) return null;
  const data = await res.json();
  const txt = data.content?.[0]?.text || '';
  const m = txt.match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : null; } catch (_) { return null; }
}

// ── VPS API helpers ────────────────────────────────────────────────────────────
async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${BOT_TOKEN}` },
  }).catch(() => null);
  if (!res?.ok) return null;
  return res.json().catch(() => null);
}

async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!res?.ok) return null;
  return res.json().catch(() => null);
}

// ── Browser init ───────────────────────────────────────────────────────────────
async function initBrowser() {
  console.log('[Settlement] Launching browser...');
  browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,
    defaultViewport: null,
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
  });

  const pages = await browser.pages();
  mpesaPage = pages[0] || await browser.newPage();
  imPage = await browser.newPage();

  // Navigate both tabs
  await mpesaPage.goto(MPESA_PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await imPage.goto(IM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

  console.log('[Settlement] Browser ready. Please log in to M-Pesa portal and complete OTP.');
  console.log('[Settlement] Bot will start executing sweeps once login is detected.');
}

// ── M-Pesa portal session check ────────────────────────────────────────────────
async function checkMpesaSession() {
  if (!mpesaPage || mpesaPage.isClosed()) return false;
  try {
    const url = mpesaPage.url();
    if (url.includes('login')) return false;
    const text = await mpesaPage.evaluate(() => document.body.innerText).catch(() => '');
    // Logged in if we can see dashboard elements (not the login page)
    return !text.toLowerCase().includes('sign in') && !text.toLowerCase().includes('username') &&
           text.length > 200;
  } catch (_) {
    return false;
  }
}

// ── M-Pesa portal keep-alive ───────────────────────────────────────────────────
async function keepMpesaAlive() {
  if (!mpesaPage || mpesaPage.isClosed()) return;
  try {
    // Scroll slightly to trigger activity
    await mpesaPage.evaluate(() => window.scrollBy(0, 1)).catch(() => {});
    const alive = await checkMpesaSession();
    if (!alive) {
      console.log('[Settlement] ⚠️  M-Pesa portal session expired — please log in again');
      mpesaReady = false;
      await mpesaPage.goto(MPESA_PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    }
  } catch (_) {}
}

// ── M-Pesa portal: Execute sweep (paybill → I&M) ──────────────────────────────
// NOTE: Vision prompts below are PLACEHOLDERS.
// The admin will guide us through the actual portal flow via screenshots.
async function executeMpesaSweep(sweep) {
  const { sweep_id, amount, reference } = sweep;
  console.log(`[Sweep] Executing sweep ${sweep_id}: KES ${amount} (ref: ${reference})`);

  try {
    await mpesaPage.bringToFront();
    await setZoom80(mpesaPage);
    await new Promise(r => setTimeout(r, 500));

    const MAX_STEPS = 20;
    for (let step = 1; step <= MAX_STEPS; step++) {
      await new Promise(r => setTimeout(r, 2000));
      const dpr = await mpesaPage.evaluate(() => window.devicePixelRatio || 1).catch(() => 1);
      const ss = await mpesaPage.screenshot({ type: 'jpeg', quality: 85, encoding: 'base64' }).catch(() => null);
      if (!ss) continue;

      const action = await askVision(ss, `
You are controlling the M-Pesa Business Portal (org.ke.m-pesa.com) to transfer KES ${amount} from the paybill to Spark Freelance I&M Bank account.
Reference: ${reference}

Identify the current screen and return ONE action as JSON.

SCREENS & ACTIONS:
- "dashboard" → navigate to the withdrawal/transfer menu
- "transfer_menu" → select the correct transfer type (Organization Withdrawal From MPESA-Real Time)
- "transfer_form" → fill in amount: ${amount}, account details
- "confirm" → confirm/submit the transfer
- "otp" → OTP has been sent, waiting for admin to enter (action: "wait")
- "success" → transfer completed successfully

Return JSON: {"screen":"...","action":"...","description":"...","x":NNN,"y":NNN}
For wait: {"screen":"otp","action":"wait"}
For success: {"screen":"success","action":"done"}
      `, 200);

      if (!action) continue;
      console.log(`[Sweep] Step ${step}: screen=${action.screen} action=${action.action}`);

      if (action.screen === 'success' || action.action === 'done') {
        await resetZoom(mpesaPage);
        await apiPost('/ext/mpesa-sweep-complete', { sweep_id, amount, reference });
        console.log(`[Sweep] ✅ Sweep ${sweep_id} complete`);
        return true;
      }

      if (action.action === 'wait') {
        console.log('[Sweep] Waiting for admin OTP entry...');
        await new Promise(r => setTimeout(r, 10000));
        continue;
      }

      if (action.x && action.y) {
        await mpesaPage.mouse.click(action.x / dpr, action.y / dpr);
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    await apiPost('/ext/mpesa-sweep-failed', { sweep_id, error: 'Max steps exceeded' });
    return false;
  } catch (e) {
    console.error(`[Sweep] Error: ${e.message}`);
    await apiPost('/ext/mpesa-sweep-failed', { sweep_id, error: e.message });
    return false;
  }
}

// ── I&M disbursement: Transfer to trader's I&M account ────────────────────────
// Reuses the same Vision loop pattern from the main SparkP2P bot
async function executeImDisbursement(disbursement) {
  const { disbursement_id, trader_name, account_number, bank_name, amount, reference } = disbursement;
  console.log(`[Disburse] Sending KES ${amount} → ${trader_name} (${account_number})`);

  try {
    await imPage.bringToFront();
    await imPage.goto(IM_URL, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));
    await setZoom80(imPage);
    await new Promise(r => setTimeout(r, 400));

    const amountInt = Math.floor(parseFloat(amount));
    const refStr = String(reference).substring(0, 50);
    let referenceId = null;

    const MAX_STEPS = 25;
    for (let step = 1; step <= MAX_STEPS; step++) {
      await new Promise(r => setTimeout(r, 2000));
      const dpr = await imPage.evaluate(() => window.devicePixelRatio || 1).catch(() => 1);

      // Check success via page text first
      const pageText = await imPage.evaluate(() => document.body.innerText).catch(() => '');
      const lower = pageText.toLowerCase();
      if (lower.includes('transaction successful') || lower.includes('transfer successful') ||
          lower.includes('payment success') || lower.includes('transaction complete')) {
        const refMatch = pageText.match(/reference\s*(?:id|number)?[:\s]+([A-Z0-9]{8,20})/i);
        if (refMatch) referenceId = refMatch[1].trim();
        console.log(`[Disburse] ✅ Transfer SUCCESS — ref: ${referenceId}`);
        await resetZoom(imPage);
        await new Promise(r => setTimeout(r, 400));
        const ss = await imPage.screenshot({ encoding: 'base64' }).catch(() => null);
        await apiPost('/ext/im-disbursement-complete', { disbursement_id, reference_id: referenceId });
        return { success: true, screenshot: ss, referenceId };
      }

      const ss = await imPage.screenshot({ type: 'jpeg', quality: 85, encoding: 'base64' }).catch(() => null);
      if (!ss) continue;

      const action = await askVision(ss, `
You are controlling I&M Bank portal to make a local bank transfer.
Transfer: KES ${amountInt} to account ${account_number} at ${bank_name}
Beneficiary name: ${trader_name}
Reference: ${refStr}
Debit account: Spark Freelance Solutions (use first available if not shown)

Identify current screen and return ONE action as JSON.

SCREENS:
- "form" = Local transfer form (account number field, beneficiary name, amount, reference)
- "review" = Review/confirmation screen showing transfer summary
- "pin" = PIN/Identity verification screen
- "success" = Transfer successful

ACTIONS:
- {"screen":"form","action":"click","description":"field label","x":NNN,"y":NNN}
- {"screen":"form","action":"type","description":"field label","value":"text","x":NNN,"y":NNN}
- {"screen":"form","action":"continue"} — when ALL fields filled
- {"screen":"review","action":"submit","x":NNN,"y":NNN}
- {"screen":"pin","action":"type_pin"}
- {"screen":"success","action":"done"}

Return ONLY valid JSON.
      `, 400);

      if (!action) continue;
      console.log(`[Disburse] Step ${step}: screen=${action.screen} action=${action.action}`);

      // PIN entry — type directly via keyboard then DOM-click Complete
      if (action.action === 'type_pin') {
        await imPage.evaluate(() => {
          const inp = document.querySelector('input[type="password"], input[type="tel"]');
          if (inp) { inp.click(); inp.focus(); }
        }).catch(() => {});
        await new Promise(r => setTimeout(r, 300));
        for (const digit of String(IM_PIN)) {
          await imPage.keyboard.press(digit);
          await new Promise(r => setTimeout(r, 150));
        }
        await new Promise(r => setTimeout(r, 800));
        await imPage.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button'))
            .find(b => (b.textContent || '').trim().toLowerCase() === 'complete');
          if (btn) { btn.scrollIntoView({ block: 'center', behavior: 'instant' }); btn.click(); }
        }).catch(() => {});
        await new Promise(r => setTimeout(r, 4000));
        continue;
      }

      // Continue / Submit — DOM-first approach
      if (action.action === 'continue' || (action.action === 'click' && (action.description || '').toLowerCase().includes('continue'))) {
        const domClicked = await imPage.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
          const btn = btns.find(b => {
            const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
            const r = b.getBoundingClientRect();
            return r.width > 0 && (txt.includes('continue') || txt.includes('next') || b.type === 'submit');
          });
          if (btn) { btn.scrollIntoView({ block: 'center', behavior: 'instant' }); btn.click(); return true; }
          return false;
        }).catch(() => false);
        if (domClicked) { await new Promise(r => setTimeout(r, 4000)); continue; }
      }

      // Submit on review screen (inside modal)
      if (action.action === 'submit' || (action.screen === 'review' && action.action === 'click')) {
        await imPage.evaluate(() => {
          const container = document.querySelector('mat-dialog-container, [role="dialog"]') || document.body;
          const btn = Array.from(container.querySelectorAll('button'))
            .find(b => { const t = (b.textContent || '').trim().toLowerCase(); return t === 'submit' || t === 'confirm'; });
          if (btn) { btn.scrollIntoView({ block: 'center', behavior: 'instant' }); btn.click(); }
        }).catch(() => {});
        await new Promise(r => setTimeout(r, 4000));
        continue;
      }

      // Type into field
      if (action.action === 'type' && action.value) {
        if (action.x && action.y) {
          await imPage.mouse.click(action.x / dpr, action.y / dpr);
          await new Promise(r => setTimeout(r, 400));
        }
        const filled = await imPage.evaluate((val) => {
          const el = document.activeElement;
          if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return false;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(el, val); else el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true }));
          return true;
        }, String(action.value)).catch(() => false);
        if (filled) { await imPage.keyboard.press('Tab'); }
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      // Generic coordinate click
      if (action.x && action.y) {
        await imPage.mouse.click(action.x / dpr, action.y / dpr);
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    await apiPost('/ext/im-disbursement-failed', { disbursement_id, error: 'Max steps exceeded' });
    return { success: false };
  } catch (e) {
    console.error(`[Disburse] Error: ${e.message}`);
    await apiPost('/ext/im-disbursement-failed', { disbursement_id, error: e.message });
    return { success: false };
  }
}

// ── Main poll cycle ────────────────────────────────────────────────────────────
async function pollCycle() {
  if (settlementRunning) return;

  // 1. Check M-Pesa session
  const sessionAlive = await checkMpesaSession();
  if (!sessionAlive && !mpesaReady) {
    console.log('[Settlement] Waiting for admin to log in to M-Pesa portal...');
    return;
  }
  if (sessionAlive && !mpesaReady) {
    console.log('[Settlement] ✅ M-Pesa portal session detected — bot is active');
    mpesaReady = true;
  }

  // 2. Check for pending M-Pesa sweeps
  const sweepsData = await apiGet('/ext/pending-mpesa-sweeps');
  const sweeps = sweepsData?.sweeps || [];
  if (sweeps.length > 0) {
    settlementRunning = true;
    console.log(`[Settlement] ${sweeps.length} pending sweep(s) found`);
    for (const sweep of sweeps) {
      await executeMpesaSweep(sweep);
    }
    settlementRunning = false;
  }

  // 3. Check for pending I&M disbursements
  const disbData = await apiGet('/ext/pending-im-disbursements');
  const disbursements = disbData?.disbursements || [];
  if (disbursements.length > 0) {
    settlementRunning = true;
    console.log(`[Settlement] ${disbursements.length} pending disbursement(s) found`);
    for (const d of disbursements) {
      await executeImDisbursement(d);
    }
    settlementRunning = false;
  }

  if (sweeps.length === 0 && disbursements.length === 0) {
    console.log(`[Settlement] Poll complete — no pending work (${new Date().toLocaleTimeString()})`);
  }
}

// ── Entry point ────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   SparkP2P Settlement Bot  v1.0          ║');
  console.log('╚══════════════════════════════════════════╝');

  if (!BOT_TOKEN) { console.error('[Settlement] ❌ SPARKP2P_BOT_TOKEN not set'); process.exit(1); }
  if (!ANTHROPIC_KEY) { console.error('[Settlement] ❌ ANTHROPIC_API_KEY not set'); process.exit(1); }
  if (!IM_PIN) { console.error('[Settlement] ❌ IM_PIN not set'); process.exit(1); }

  await initBrowser();

  // Keep-alive timer for M-Pesa portal
  setInterval(keepMpesaAlive, KEEPALIVE_INTERVAL_MS);

  // Main poll loop
  setInterval(async () => {
    try { await pollCycle(); } catch (e) { console.error('[Settlement] Poll error:', e.message); }
  }, POLL_INTERVAL_MS);

  // First poll after 5s (give browser time to load)
  setTimeout(async () => {
    try { await pollCycle(); } catch (e) {}
  }, 5000);
}

main().catch(e => {
  console.error('[Settlement] Fatal error:', e);
  process.exit(1);
});
