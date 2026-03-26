/**
 * AI-Powered Browser Scanner
 *
 * Uses Claude AI vision to understand Binance pages like a human.
 * Takes screenshots → sends to Claude → gets structured data back.
 *
 * This is the "brain" of the bot — it can read any page, find any data,
 * and understand context without brittle DOM selectors.
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

let client = null;

function initAI(apiKey) {
  if (!apiKey) return false;
  try {
    client = new Anthropic({ apiKey });
    console.log('[AI Scanner] Claude AI initialized');
    return true;
  } catch (e) {
    console.error('[AI Scanner] Init failed:', e.message);
    return false;
  }
}

/**
 * Ask Claude to analyze a screenshot and extract structured data.
 * @param {Buffer} screenshotBuffer - JPEG screenshot buffer
 * @param {string} prompt - What to extract from the page
 * @returns {object} Parsed JSON response from Claude
 */
async function analyzeScreenshot(screenshotBuffer, prompt) {
  if (!client) return null;

  try {
    const base64 = screenshotBuffer.toString('base64');

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: base64 },
          },
          {
            type: 'text',
            text: prompt + '\n\nRespond ONLY with valid JSON. No markdown, no explanation, just the JSON object.',
          },
        ],
      }],
    });

    const text = response.content[0]?.text || '';
    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return null;
  } catch (e) {
    console.error('[AI Scanner] Error:', e.message?.substring(0, 80));
    return null;
  }
}

/**
 * Scan the wallet page for balance information.
 */
async function scanWallet(page) {
  await page.goto('https://www.binance.com/en/my/wallet/account/overview', { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 4000));

  const screenshot = await page.screenshot({ type: 'jpeg', quality: 80 });

  const data = await analyzeScreenshot(screenshot, `
    Look at this Binance wallet overview page. Extract:
    {
      "estimated_balance_usd": number or null,
      "balances": [
        { "asset": "USDT", "total": number, "available": number, "locked": number }
      ],
      "username": "string or null",
      "is_logged_in": true/false
    }
    Extract ALL visible crypto balances. If you see "USDT 3.39" that means 3.39 USDT.
    If you see an estimated total balance in USD, include it.
    If you see a username or account name anywhere on the page, include it.
  `);

  console.log('[AI Scanner] Wallet:', JSON.stringify(data)?.substring(0, 200));
  return data;
}

/**
 * Scan the P2P page for active ads.
 */
async function scanP2PAds(page) {
  await page.goto('https://p2p.binance.com/en/myad', { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

  const screenshot = await page.screenshot({ type: 'jpeg', quality: 80 });

  const data = await analyzeScreenshot(screenshot, `
    Look at this Binance P2P "My Ads" page. Extract:
    {
      "ads": [
        {
          "type": "BUY" or "SELL",
          "asset": "USDT",
          "price": number,
          "currency": "KES",
          "available_amount": number,
          "min_limit": number,
          "max_limit": number,
          "status": "Online" or "Offline",
          "payment_methods": ["M-Pesa", "Bank Transfer"]
        }
      ],
      "total_ads": number
    }
    If there are no ads, return {"ads": [], "total_ads": 0}.
    Extract every visible ad with all its details.
  `);

  console.log('[AI Scanner] Ads:', JSON.stringify(data)?.substring(0, 200));
  return data;
}

/**
 * Scan the P2P orders page for pending orders.
 */
async function scanOrders(page) {
  await page.goto('https://p2p.binance.com/en/fiatOrder', { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

  const screenshot = await page.screenshot({ type: 'jpeg', quality: 80 });

  const data = await analyzeScreenshot(screenshot, `
    Look at this Binance P2P orders page. Extract:
    {
      "pending_orders": [
        {
          "order_number": "string",
          "type": "BUY" or "SELL",
          "amount_crypto": number,
          "amount_fiat": number,
          "price": number,
          "asset": "USDT",
          "currency": "KES",
          "counterparty": "string",
          "status": "Paid" or "Unpaid" or "Appeal in Progress" or "Completed",
          "time": "string"
        }
      ],
      "has_orders": true/false
    }
    If the page shows "No records" or no orders, return {"pending_orders": [], "has_orders": false}.
    Extract every visible order with all details.
  `);

  console.log('[AI Scanner] Orders:', JSON.stringify(data)?.substring(0, 200));
  return data;
}

/**
 * Scan the user profile to get username and account info.
 */
async function scanProfile(page) {
  await page.goto('https://p2p.binance.com/en/advertiserDetail', { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

  const screenshot = await page.screenshot({ type: 'jpeg', quality: 80 });

  const data = await analyzeScreenshot(screenshot, `
    Look at this Binance P2P advertiser/profile page. Extract:
    {
      "nickname": "string",
      "total_orders": number or null,
      "completion_rate": "string like 98.5%" or null,
      "positive_feedback": "string like 99.2%" or null,
      "registered_days": number or null,
      "is_merchant": true/false,
      "verified": true/false
    }
    If you can see any username, nickname, or account identifier, include it.
  `);

  console.log('[AI Scanner] Profile:', JSON.stringify(data)?.substring(0, 200));
  return data;
}

/**
 * Analyze an order page to decide what action to take.
 */
async function analyzeOrderPage(page, orderNumber) {
  const screenshot = await page.screenshot({ type: 'jpeg', quality: 80 });

  const data = await analyzeScreenshot(screenshot, `
    Look at this Binance P2P order page. Extract:
    {
      "order_number": "string",
      "type": "BUY" or "SELL",
      "status": "string",
      "amount_crypto": number,
      "amount_fiat": number,
      "counterparty": "string",
      "payment_method": "string",
      "available_actions": ["Release", "Confirm Payment", "Cancel", "Appeal"],
      "has_release_button": true/false,
      "has_payment_button": true/false,
      "has_chat": true/false,
      "needs_verification": true/false,
      "verification_type": "PIN" or "2FA" or "Email" or "None"
    }
    List exactly which buttons/actions are visible on the page.
  `);

  console.log('[AI Scanner] Order analysis:', JSON.stringify(data)?.substring(0, 200));
  return data;
}

/**
 * Full scan — visit all pages and collect comprehensive data.
 */
async function fullScan(page) {
  console.log('[AI Scanner] Starting full scan...');

  const wallet = await scanWallet(page);
  const profile = await scanProfile(page);
  const ads = await scanP2PAds(page);
  const orders = await scanOrders(page);

  const result = {
    wallet: wallet || { balances: [], estimated_balance_usd: null },
    profile: profile || { nickname: '' },
    ads: ads || { ads: [], total_ads: 0 },
    orders: orders || { pending_orders: [], has_orders: false },
    scanned_at: new Date().toISOString(),
  };

  console.log(`[AI Scanner] Full scan complete: ${result.wallet.balances?.length || 0} balances, ${result.ads.ads?.length || 0} ads, ${result.orders.pending_orders?.length || 0} orders`);
  return result;
}

module.exports = {
  initAI,
  analyzeScreenshot,
  scanWallet,
  scanP2PAds,
  scanOrders,
  scanProfile,
  analyzeOrderPage,
  fullScan,
};
