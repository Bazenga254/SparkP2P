/**
 * SparkP2P Content Script — runs on Binance pages
 *
 * This script intercepts XHR/fetch requests to capture cookies and headers
 * that are sent by the browser (including httpOnly cookies).
 * It also captures the csrftoken from the page's request headers.
 */

(function() {
  'use strict';

  let capturedHeaders = {};
  let capturedCookies = '';

  // Intercept XMLHttpRequest to capture headers
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  const headerStore = new WeakMap();

  XMLHttpRequest.prototype.open = function(method, url) {
    if (url && url.includes('/bapi/c2c/')) {
      headerStore.set(this, { url, headers: {} });
    }
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    const store = headerStore.get(this);
    if (store) {
      store.headers[name.toLowerCase()] = value;
    }
    return origSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function() {
    const store = headerStore.get(this);
    if (store && Object.keys(store.headers).length > 0) {
      // Found a C2C API request — capture headers
      capturedHeaders = { ...store.headers };

      // Send to extension background
      window.postMessage({
        type: 'SPARKP2P_HEADERS_CAPTURED',
        headers: capturedHeaders,
        url: store.url,
      }, '*');
    }
    return origSend.apply(this, arguments);
  };

  // Also intercept fetch
  const origFetch = window.fetch;
  window.fetch = function(url, options) {
    if (typeof url === 'string' && url.includes('/bapi/c2c/')) {
      const headers = {};
      if (options && options.headers) {
        if (options.headers instanceof Headers) {
          options.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
        } else if (typeof options.headers === 'object') {
          Object.entries(options.headers).forEach(([k, v]) => { headers[k.toLowerCase()] = v; });
        }
      }
      if (Object.keys(headers).length > 0) {
        capturedHeaders = headers;
        window.postMessage({
          type: 'SPARKP2P_HEADERS_CAPTURED',
          headers: capturedHeaders,
          url: url,
        }, '*');
      }
    }
    return origFetch.apply(this, arguments);
  };

  // Listen for messages from the popup/background asking for data
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'GET_CAPTURED_HEADERS') {
      // Also get document.cookie (non-httpOnly cookies)
      sendResponse({
        headers: capturedHeaders,
        documentCookies: document.cookie,
      });
    }
    if (msg.type === 'TRIGGER_CAPTURE') {
      // Force a request to Binance to capture fresh headers
      // Make a lightweight API call that will trigger the interceptor
      fetch('https://c2c.binance.com/bapi/c2c/v2/private/c2c/order-match/order-list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: 1, rows: 1, tradeType: 'SELL', orderStatusList: [1] }),
        credentials: 'include',
      }).then(r => r.json()).then(data => {
        sendResponse({ success: data.code === '000000', data });
      }).catch(e => {
        sendResponse({ success: false, error: e.message });
      });
      return true; // async response
    }
  });

  console.log('[SparkP2P] Content script loaded on', window.location.hostname);
})();
