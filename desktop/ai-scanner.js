/**
 * AI-Powered Browser Scanner (GPT-4o Vision)
 *
 * Takes screenshots of Binance pages → sends to GPT-4o → gets structured data.
 * The "brain" of the bot — reads any page like a human would.
 */

const OpenAI = require('openai');

let client = null;

function initAI(apiKey) {
  if (!apiKey) return false;
  try {
    client = new OpenAI({ apiKey });
    console.log('[AI Scanner] GPT-4o initialized');
    return true;
  } catch (e) {
    console.error('[AI Scanner] Init failed:', e.message);
    return false;
  }
}

async function analyzeScreenshot(screenshotBuffer, prompt) {
  if (!client) return null;
  try {
    const base64 = screenshotBuffer.toString('base64');
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'low' } },
          { type: 'text', text: prompt + '\n\nRespond ONLY with valid JSON. No markdown, no explanation.' },
        ],
      }],
    });
    const text = response.choices[0]?.message?.content || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch (e) {
    console.error('[AI Scanner] Error:', e.message?.substring(0, 80));
    return null;
  }
}

async function scanWallet(page) {
  await page.goto('https://www.binance.com/en/my/wallet/account/overview', { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 4000));
  const screenshot = await page.screenshot({ type: 'jpeg', quality: 80 });
  const data = await analyzeScreenshot(screenshot, `
    Look at this Binance wallet page. Extract:
    {
      "estimated_balance_usd": number or null,
      "balances": [{ "asset": "USDT", "total": number, "available": number }],
      "username": "string or null"
    }
    Extract ALL visible crypto balances with their amounts.
  `);
  console.log('[AI Scanner] Wallet:', JSON.stringify(data)?.substring(0, 200));
  return data;
}

async function scanP2PAds(page) {
  await page.goto('https://p2p.binance.com/en/myad', { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));
  const screenshot = await page.screenshot({ type: 'jpeg', quality: 80 });
  const data = await analyzeScreenshot(screenshot, `
    Look at this Binance P2P "My Ads" page. Extract:
    {
      "ads": [{
        "type": "BUY" or "SELL", "asset": "USDT", "price": number, "currency": "KES",
        "available_amount": number, "min_limit": number, "max_limit": number,
        "status": "Online" or "Offline", "payment_methods": ["M-Pesa"]
      }],
      "total_ads": number
    }
    If no ads, return {"ads": [], "total_ads": 0}.
  `);
  console.log('[AI Scanner] Ads:', JSON.stringify(data)?.substring(0, 200));
  return data;
}

async function scanOrders(page) {
  await page.goto('https://p2p.binance.com/en/fiatOrder', { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));
  const screenshot = await page.screenshot({ type: 'jpeg', quality: 80 });
  const data = await analyzeScreenshot(screenshot, `
    Look at this Binance P2P orders page. Extract:
    {
      "pending_orders": [{
        "order_number": "string", "type": "BUY" or "SELL",
        "amount_crypto": number, "amount_fiat": number, "price": number,
        "asset": "USDT", "currency": "KES", "counterparty": "string",
        "status": "Paid" or "Unpaid" or "Completed"
      }],
      "has_orders": true/false
    }
    If "No records" or empty, return {"pending_orders": [], "has_orders": false}.
  `);
  console.log('[AI Scanner] Orders:', JSON.stringify(data)?.substring(0, 200));
  return data;
}

async function scanProfile(page) {
  await page.goto('https://p2p.binance.com/en/advertiserDetail', { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));
  const screenshot = await page.screenshot({ type: 'jpeg', quality: 80 });
  const data = await analyzeScreenshot(screenshot, `
    Look at this Binance P2P profile page. Extract:
    {
      "nickname": "string", "total_orders": number or null,
      "completion_rate": "string" or null, "is_merchant": true/false
    }
  `);
  console.log('[AI Scanner] Profile:', JSON.stringify(data)?.substring(0, 200));
  return data;
}

async function analyzeOrderPage(page) {
  const screenshot = await page.screenshot({ type: 'jpeg', quality: 80 });
  const data = await analyzeScreenshot(screenshot, `
    Look at this Binance P2P order page. Extract:
    {
      "order_number": "string", "type": "BUY" or "SELL", "status": "string",
      "amount_crypto": number, "amount_fiat": number, "counterparty": "string",
      "has_release_button": true/false, "has_payment_button": true/false,
      "needs_verification": true/false, "available_buttons": ["list of button texts"]
    }
  `);
  console.log('[AI Scanner] Order:', JSON.stringify(data)?.substring(0, 200));
  return data;
}

async function fullScan(page) {
  console.log('[AI Scanner] Starting full scan...');
  const wallet = await scanWallet(page);
  const profile = await scanProfile(page);
  const ads = await scanP2PAds(page);
  const orders = await scanOrders(page);

  const result = {
    wallet: wallet || { balances: [] },
    profile: profile || { nickname: '' },
    ads: ads || { ads: [] },
    orders: orders || { pending_orders: [] },
    scanned_at: new Date().toISOString(),
  };
  console.log(`[AI Scanner] Done: ${result.wallet.balances?.length || 0} bal, ${result.ads.ads?.length || 0} ads, ${result.orders.pending_orders?.length || 0} orders`);
  return result;
}

module.exports = { initAI, analyzeScreenshot, scanWallet, scanP2PAds, scanOrders, scanProfile, analyzeOrderPage, fullScan };
