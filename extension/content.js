/**
 * SparkP2P Content Script — Binance API Executor
 *
 * Runs on Binance pages. Makes all Binance C2C API calls using the
 * browser's own credentials (cookies sent automatically via
 * credentials: 'include'). This ensures requests come from the
 * user's IP, not the VPS.
 *
 * The background script orchestrates; this script executes.
 */

(() => {
  'use strict';

  console.log('[SparkP2P] Content script loaded on', window.location.href);

  // ── Message handler ────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

    // Generic Binance API request
    if (msg.type === 'BINANCE_REQUEST') {
      makeBinanceRequest(msg.endpoint, msg.payload)
        .then(data => sendResponse({ success: true, data }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // async response
    }

    // Ping — check if content script is alive
    if (msg.type === 'PING') {
      sendResponse({ alive: true, url: window.location.href });
      return false;
    }

    // Get page cookies (for cookie sync)
    if (msg.type === 'GET_PAGE_COOKIES') {
      sendResponse({ cookies: document.cookie });
      return false;
    }
  });

  // ── Binance API caller ─────────────────────────────────────────

  async function makeBinanceRequest(endpoint, payload) {
    const url = `https://c2c.binance.com/bapi/c2c/v2/private${endpoint}`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Clienttype': 'web',
        'C2ctype': 'c2c_web',
      },
      body: JSON.stringify(payload || {}),
      credentials: 'include',  // Browser sends all cookies automatically
    });

    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`Binance session expired (HTTP ${resp.status})`);
    }

    const data = await resp.json();

    // Binance returns {"code": "000000", "data": {...}} on success
    if (data.code && data.code !== '000000') {
      throw new Error(`Binance API error ${data.code}: ${data.message || 'Unknown'}`);
    }

    return data;
  }

  // ── Notify background that content script is ready ─────────────

  chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY', url: window.location.href });

})();
