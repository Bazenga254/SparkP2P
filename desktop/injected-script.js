// This script is injected into the Binance page via CDP.
// It runs IN the page context with full cookie access — same as the Chrome Extension content script.
// It polls orders, reports to VPS, and executes actions.

(async function SparkP2PBot() {
  if (window.__sparkp2p_running) return;
  window.__sparkp2p_running = true;

  const API_BASE = 'https://sparkp2p.com/api';
  const POLL_INTERVAL = 10000;
  let token = null;
  let stats = { polls: 0, actions: 0, errors: 0 };

  console.log('[SparkP2P Bot] Injected into', window.location.href);

  // Get token from Electron via a hidden element
  function getToken() {
    const el = document.getElementById('__sparkp2p_token');
    return el ? el.textContent : token;
  }

  async function binanceFetch(endpoint, payload) {
    try {
      const resp = await fetch('https://c2c.binance.com/bapi/c2c/v2/private' + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Clienttype': 'web', 'C2ctype': 'c2c_web' },
        body: JSON.stringify(payload),
        credentials: 'include',
      });
      return await resp.json();
    } catch (e) {
      return { error: e.message };
    }
  }

  async function vpsFetch(path, body) {
    const t = getToken();
    if (!t) return null;
    try {
      const res = await fetch(API_BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t },
        body: JSON.stringify(body),
      });
      return await res.json();
    } catch (e) { return null; }
  }

  function normalize(o) {
    return {
      orderNumber: o.orderNumber || '', advNo: o.advNo || null, tradeType: o.tradeType || '',
      totalPrice: parseFloat(o.totalPrice || 0), amount: parseFloat(o.amount || 0),
      price: parseFloat(o.price || 0), asset: o.asset || 'USDT',
      buyerNickname: o.buyerNickname || null, sellerNickname: o.sellerNickname || null,
      orderStatus: o.orderStatus || null,
    };
  }

  async function pollCycle() {
    const t = getToken();
    if (!t) { console.log('[SparkP2P Bot] No token yet'); return; }

    try {
      // Fetch orders from Binance
      const sell = await binanceFetch('/c2c/order-match/order-list', { page: 1, rows: 20, tradeType: 'SELL', orderStatusList: [1, 2, 3] });
      const buy = await binanceFetch('/c2c/order-match/order-list', { page: 1, rows: 20, tradeType: 'BUY', orderStatusList: [1, 2, 3] });

      const sellData = sell?.code === '000000' ? (sell.data || []) : [];
      const buyData = buy?.code === '000000' ? (buy.data || []) : [];

      console.log('[SparkP2P Bot] Orders:', sellData.length, 'sell,', buyData.length, 'buy');

      // Report to VPS
      const report = await vpsFetch('/ext/report-orders', {
        sell_orders: sellData.map(normalize),
        buy_orders: buyData.map(normalize),
      });

      // Execute actions
      for (const action of (report?.actions || [])) {
        if (action.action === 'release') {
          const r = await binanceFetch('/c2c/order-match/confirm-order', { orderNumber: action.order_number });
          await vpsFetch('/ext/report-release', { order_number: action.order_number, success: r?.code === '000000', error: r?.error });
          if (r?.code === '000000') stats.actions++;
        } else if (action.action === 'pay' || action.action === 'mark_as_paid') {
          const r = await binanceFetch('/c2c/order-match/buyer-confirm-pay', { orderNumber: action.order_number });
          await vpsFetch('/ext/report-payment-sent', { order_number: action.order_number, success: r?.code === '000000', error: r?.error });
          if (r?.code === '000000') stats.actions++;
        } else if (action.action === 'send_message') {
          await binanceFetch('/c2c/chat/send-message', { orderNumber: action.order_number, message: action.message || '', msgType: 1 });
        }
      }

      stats.polls++;

      // Heartbeat
      if (stats.polls % 3 === 0) {
        vpsFetch('/ext/heartbeat', {}).catch(() => {});
      }

      // Account data every 5th poll
      if (stats.polls % 5 === 0) {
        try {
          const balance = await binanceFetch('/c2c/asset/query-user-asset', {});
          const compSell = await binanceFetch('/c2c/order-match/order-list', { page: 1, rows: 20, tradeType: 'SELL', orderStatusList: [4] });
          const compBuy = await binanceFetch('/c2c/order-match/order-list', { page: 1, rows: 20, tradeType: 'BUY', orderStatusList: [4] });
          const ads = await binanceFetch('/c2c/adv/search', { page: 1, rows: 20 });
          const pm = await binanceFetch('/c2c/pay-method/user-paymethods', {});

          const balances = [];
          if (balance?.code === '000000' && balance.data) {
            const arr = Array.isArray(balance.data) ? balance.data : [balance.data];
            for (const a of arr) {
              if (a.asset || a.coin) balances.push({ asset: a.asset || a.coin || 'USDT', free: parseFloat(a.available || a.free || 0), locked: parseFloat(a.freeze || a.locked || 0), total: parseFloat(a.available || a.free || 0) + parseFloat(a.freeze || a.locked || 0) });
            }
          }

          const completed = [...((compSell?.code === '000000' ? compSell.data : []) || []), ...((compBuy?.code === '000000' ? compBuy.data : []) || [])].sort((a, b) => (b.createTime || 0) - (a.createTime || 0)).slice(0, 20).map(o => ({ orderNumber: o.orderNumber, tradeType: o.tradeType, totalPrice: parseFloat(o.totalPrice || 0), amount: parseFloat(o.amount || 0), price: parseFloat(o.price || 0), asset: o.asset || 'USDT', fiat: o.fiat || 'KES', counterparty: o.buyerNickname || o.sellerNickname || '', status: o.orderStatus, createTime: o.createTime }));
          const activeAds = (ads?.code === '000000' ? ads.data : []).map(a => ({ advNo: a.advNo, tradeType: a.tradeType, asset: a.asset, fiat: a.fiatUnit, price: parseFloat(a.price || 0), amount: parseFloat(a.surplusAmount || 0), minLimit: parseFloat(a.minSingleTransAmount || 0), maxLimit: parseFloat(a.maxSingleTransAmount || 0), status: a.advStatus }));
          const pms = (pm?.code === '000000' ? pm.data : []).map(p => ({ id: p.id, type: p.identifier, name: (p.fields || []).find(f => (f.fieldName || '').toLowerCase().includes('name'))?.fieldValue || '' }));

          await vpsFetch('/ext/report-account-data', { balances, completed_orders: completed, active_ads: activeAds, payment_methods: pms });
          console.log('[SparkP2P Bot] Account data:', balances.length, 'bal,', completed.length, 'orders,', activeAds.length, 'ads');
        } catch (e) {
          console.log('[SparkP2P Bot] Account data error:', e.message);
        }
      }

      // Report status back to Electron
      window.__sparkp2p_status = { polls: stats.polls, actions: stats.actions, errors: stats.errors, sellOrders: sellData.length, buyOrders: buyData.length, lastPoll: new Date().toISOString() };

    } catch (err) {
      stats.errors++;
      console.error('[SparkP2P Bot] Poll error:', err.message);
    }
  }

  // Start polling
  console.log('[SparkP2P Bot] Starting poll cycle...');
  pollCycle();
  setInterval(pollCycle, POLL_INTERVAL);
})();
