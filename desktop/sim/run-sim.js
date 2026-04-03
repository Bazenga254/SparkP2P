/**
 * SparkP2P Bot Simulator
 * Run with: node sim/run-sim.js
 *
 * Tests the bot's AI vision and click logic against local mock HTML pages.
 * No real Binance account or order needed.
 */

const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const aiScanner = require('../ai-scanner');

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg, type = 'info') {
  const icons = { info: '  ', pass: '✅', fail: '❌', warn: '⚠️ ', step: '▶ ' };
  console.log(`${icons[type] || '  '} ${msg}`);
}

function pageFile(name) {
  return `file:///${path.join(__dirname, name).replace(/\\/g, '/')}`;
}

async function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

async function clickButton(page, ...textOptions) {
  const clicked = await page.evaluate((options) => {
    for (const text of options) {
      const btn = Array.from(document.querySelectorAll('button, a[role="button"], [class*="btn"], [role="button"]'))
        .find(b => {
          const t = (b.textContent || '').toLowerCase().trim();
          return t === text.toLowerCase() || t.includes(text.toLowerCase());
        });
      if (btn) { btn.click(); return text; }
    }
    return null;
  }, textOptions);
  return !!clicked;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function testOrderWaiting(page) {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('TEST 1: Order Waiting for Payment', 'step');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  await page.goto(pageFile('order-waiting.html'), { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 500));

  const screenshot = await page.screenshot({ type: 'jpeg', quality: 80 });
  log('Screenshot taken — asking AI to analyze...');

  const ai = await aiScanner.analyzeScreenshot(screenshot, `
    This is a Binance P2P sell order detail page.
    Look carefully and tell me:
    {
      "status": one of "waiting_for_payment" | "buyer_paid" | "completed" | "cancelled" | "unknown",
      "has_release_button": true/false,
      "buyer_has_paid_indicator": true/false,
      "order_amount_usdt": number or null,
      "order_amount_fiat": number or null,
      "latest_chat_message": "most recent buyer chat message or null",
      "chat_needs_reply": true/false
    }
  `);

  console.log('\n  AI Response:', JSON.stringify(ai, null, 2).replace(/\n/g, '\n  '));

  const pass = ai?.status === 'waiting_for_payment' && ai?.has_release_button === false;
  log(`Status correctly identified as "waiting_for_payment": ${ai?.status === 'waiting_for_payment' ? 'YES' : 'NO — got: ' + ai?.status}`, ai?.status === 'waiting_for_payment' ? 'pass' : 'fail');
  log(`Release button correctly absent: ${ai?.has_release_button === false ? 'YES' : 'NO'}`, ai?.has_release_button === false ? 'pass' : 'fail');
  log(`Detected order amount: ${ai?.order_amount_usdt} USDT / KES ${ai?.order_amount_fiat}`, ai?.order_amount_usdt ? 'pass' : 'warn');
  log(`Chat message detected: "${ai?.latest_chat_message}"`, ai?.latest_chat_message ? 'pass' : 'warn');

  return pass;
}

async function testOrderPaid(page) {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('TEST 2: Order — Buyer Has Paid', 'step');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  await page.goto(pageFile('order-paid.html'), { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 500));

  const screenshot = await page.screenshot({ type: 'jpeg', quality: 80 });
  log('Screenshot taken — asking AI to analyze...');

  const ai = await aiScanner.analyzeScreenshot(screenshot, `
    This is a Binance P2P sell order detail page. The buyer has paid.
    {
      "status": one of "waiting_for_payment" | "buyer_paid" | "completed" | "cancelled" | "unknown",
      "has_release_button": true/false,
      "release_button_text": "exact text on the release button, or null",
      "buyer_has_paid_indicator": true/false,
      "order_amount_usdt": number or null,
      "order_amount_fiat": number or null,
      "latest_chat_message": "most recent buyer chat message or null",
      "chat_needs_reply": true/false
    }
  `);

  console.log('\n  AI Response:', JSON.stringify(ai, null, 2).replace(/\n/g, '\n  '));

  log(`Status correctly identified as "buyer_paid": ${ai?.status === 'buyer_paid' ? 'YES' : 'NO — got: ' + ai?.status}`, ai?.status === 'buyer_paid' ? 'pass' : 'fail');
  log(`Release button detected: ${ai?.has_release_button ? 'YES' : 'NO'}`, ai?.has_release_button ? 'pass' : 'fail');
  log(`Release button text: "${ai?.release_button_text}"`, ai?.release_button_text ? 'pass' : 'warn');
  log(`Buyer paid indicator: ${ai?.buyer_has_paid_indicator ? 'YES' : 'NO'}`, ai?.buyer_has_paid_indicator ? 'pass' : 'fail');

  // Now test actual button click
  log('\n  Testing button click...');
  const releaseTexts = [ai?.release_button_text, 'Release Crypto', 'Release USDT', 'Release'].filter(Boolean);
  const clicked = await clickButton(page, ...releaseTexts);
  log(`Clicked release button: ${clicked ? 'YES' : 'NO'}`, clicked ? 'pass' : 'fail');

  return ai?.status === 'buyer_paid' && ai?.has_release_button;
}

async function testConfirmDialog(page) {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('TEST 3: "Are You Sure?" Confirmation Dialog', 'step');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  await page.goto(pageFile('confirm-dialog.html'), { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 500));

  const screenshot = await page.screenshot({ type: 'jpeg', quality: 80 });
  log('Screenshot taken — asking AI to analyze...');

  const ai = await aiScanner.analyzeScreenshot(screenshot, `
    Binance just showed a confirmation dialog after I clicked Release.
    It asks me to confirm that I have received payment before releasing crypto.
    {
      "dialog_visible": true/false,
      "confirm_button_text": "exact text of the confirm/yes/proceed button",
      "cancel_button_text": "exact text of the cancel button",
      "warning_text": "any warning message shown (short summary)"
    }
  `);

  console.log('\n  AI Response:', JSON.stringify(ai, null, 2).replace(/\n/g, '\n  '));

  log(`Dialog detected: ${ai?.dialog_visible ? 'YES' : 'NO'}`, ai?.dialog_visible ? 'pass' : 'fail');
  log(`Confirm button text: "${ai?.confirm_button_text}"`, ai?.confirm_button_text ? 'pass' : 'warn');

  const confirmTexts = [ai?.confirm_button_text, 'Confirm Release', 'Confirm', 'Yes', 'Proceed'].filter(Boolean);
  const clicked = await clickButton(page, ...confirmTexts);
  log(`Clicked confirm button: ${clicked ? 'YES' : 'NO'}`, clicked ? 'pass' : 'fail');

  return ai?.dialog_visible && !!ai?.confirm_button_text;
}

async function testVerification(page) {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('TEST 4: Security Verification (Email + Google Auth)', 'step');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  await page.goto(pageFile('verification.html'), { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 500));

  const screenshot = await page.screenshot({ type: 'jpeg', quality: 80 });
  log('Screenshot taken — asking AI to analyze...');

  const ai = await aiScanner.analyzeScreenshot(screenshot, `
    This is a Binance security verification page shown when releasing crypto.
    {
      "has_email_otp": true/false,
      "has_google_auth": true/false,
      "has_fund_password": true/false,
      "email_section_label": "exact label text above the email OTP boxes",
      "auth_section_label": "exact label text above the Google Auth boxes",
      "submit_button_text": "exact text of the submit/confirm button",
      "input_count": number
    }
  `);

  console.log('\n  AI Response:', JSON.stringify(ai, null, 2).replace(/\n/g, '\n  '));

  log(`Email OTP section detected: ${ai?.has_email_otp ? 'YES' : 'NO'}`, ai?.has_email_otp ? 'pass' : 'fail');
  log(`Google Auth section detected: ${ai?.has_google_auth ? 'YES' : 'NO'}`, ai?.has_google_auth ? 'pass' : 'fail');
  log(`Submit button text: "${ai?.submit_button_text}"`, ai?.submit_button_text ? 'pass' : 'warn');

  // Test typing into the email OTP boxes
  log('\n  Testing code entry into Email OTP boxes...');
  const emailBoxes = await page.$$('input[maxlength="1"]');
  const testCode = '123456';
  let typed = 0;
  for (let i = 0; i < Math.min(6, emailBoxes.length); i++) {
    await emailBoxes[i].click();
    await emailBoxes[i].type(testCode[i], { delay: 60 });
    typed++;
  }
  log(`Typed ${typed}/6 digits into first OTP group`, typed === 6 ? 'pass' : 'fail');

  // Test typing into the Google Auth boxes (second group of 6)
  if (emailBoxes.length >= 12) {
    log('  Testing code entry into Google Auth boxes...');
    const authCode = '654321';
    let authTyped = 0;
    for (let i = 6; i < 12; i++) {
      await emailBoxes[i].click();
      await emailBoxes[i].type(authCode[i - 6], { delay: 60 });
      authTyped++;
    }
    log(`Typed ${authTyped}/6 digits into second OTP group`, authTyped === 6 ? 'pass' : 'fail');
  }

  // Take final screenshot showing filled codes
  const filledSS = await page.screenshot({ type: 'jpeg', quality: 80 });
  const filledPath = path.join(__dirname, 'result-verification-filled.jpg');
  fs.writeFileSync(filledPath, filledSS);
  log(`Screenshot with filled codes saved: sim/result-verification-filled.jpg`, 'pass');

  return ai?.has_email_otp && ai?.has_google_auth;
}

async function testOrderCompleted(page) {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('TEST 5: Order Completed State', 'step');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  await page.goto(pageFile('order-completed.html'), { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 500));

  const screenshot = await page.screenshot({ type: 'jpeg', quality: 80 });
  const ai = await aiScanner.analyzeScreenshot(screenshot, `
    This is a Binance P2P order page.
    {
      "status": one of "waiting_for_payment" | "buyer_paid" | "completed" | "cancelled" | "unknown",
      "has_release_button": true/false,
      "completion_message": "summary of what the page says"
    }
  `);

  console.log('\n  AI Response:', JSON.stringify(ai, null, 2).replace(/\n/g, '\n  '));
  log(`Status correctly identified as "completed": ${ai?.status === 'completed' ? 'YES' : 'NO — got: ' + ai?.status}`, ai?.status === 'completed' ? 'pass' : 'fail');
  return ai?.status === 'completed';
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║   SparkP2P Bot Simulator             ║');
  console.log('║   Testing AI vision + click logic    ║');
  console.log('╚══════════════════════════════════════╝\n');

  // Init AI
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { log('OPENAI_API_KEY not found in .env', 'fail'); process.exit(1); }
  const aiOk = aiScanner.initAI(apiKey);
  log(`GPT-4o initialized: ${aiOk ? 'YES' : 'NO'}`, aiOk ? 'pass' : 'fail');

  // Launch Chrome
  const chromePath = await findChrome();
  if (!chromePath) { log('Chrome not found', 'fail'); process.exit(1); }
  log(`Chrome: ${chromePath}`, 'pass');

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false, // Show the browser so you can watch what happens
    defaultViewport: { width: 1200, height: 800 },
    args: ['--no-sandbox'],
  });

  const page = await browser.newPage();
  const results = [];

  try {
    results.push({ name: 'Order Waiting', pass: await testOrderWaiting(page) });
    results.push({ name: 'Order Paid + Click Release', pass: await testOrderPaid(page) });
    results.push({ name: 'Confirm Dialog + Click Confirm', pass: await testConfirmDialog(page) });
    results.push({ name: 'Verification + Type Codes', pass: await testVerification(page) });
    results.push({ name: 'Order Completed', pass: await testOrderCompleted(page) });
  } catch (e) {
    log(`Test error: ${e.message}`, 'fail');
    console.error(e);
  }

  // Summary
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║           RESULTS SUMMARY            ║');
  console.log('╠══════════════════════════════════════╣');
  let passed = 0;
  for (const r of results) {
    const icon = r.pass ? '✅' : '❌';
    console.log(`║ ${icon} ${r.name.padEnd(34)} ║`);
    if (r.pass) passed++;
  }
  console.log('╠══════════════════════════════════════╣');
  console.log(`║ Passed: ${passed}/${results.length}${' '.repeat(30 - String(passed).length)}║`);
  console.log('╚══════════════════════════════════════╝\n');

  log('Browser will stay open for 10 seconds so you can inspect...');
  await new Promise(r => setTimeout(r, 10000));
  await browser.close();
}

main().catch(console.error);
