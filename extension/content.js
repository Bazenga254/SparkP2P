/**
 * SparkP2P Content Script
 * Injects a page-level script that intercepts XHR/fetch to capture
 * csrftoken and bnc-uuid headers from Binance's own API calls.
 */

// Inject script into the PAGE context (not isolated world)
// This allows us to intercept the actual XMLHttpRequest/fetch calls
const script = document.createElement('script');
script.textContent = `
(function() {
  'use strict';

  const SPARKP2P_DATA = { csrf: '', uuid: '', deviceInfo: '', fvideoId: '' };

  // Intercept XMLHttpRequest.setRequestHeader
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    const n = name.toLowerCase();
    if (n === 'csrftoken' && value) SPARKP2P_DATA.csrf = value;
    if (n === 'bnc-uuid' && value) SPARKP2P_DATA.uuid = value;
    if (n === 'device-info' && value) SPARKP2P_DATA.deviceInfo = value;
    if (n === 'fvideo-id' && value) SPARKP2P_DATA.fvideoId = value;

    // Store on window for content script to read
    window.__SPARKP2P__ = SPARKP2P_DATA;

    return origSetHeader.call(this, name, value);
  };

  // Also intercept fetch
  const origFetch = window.fetch;
  window.fetch = function(input, init) {
    if (init && init.headers) {
      let headers = init.headers;
      if (headers instanceof Headers) {
        const csrf = headers.get('csrftoken');
        const uuid = headers.get('bnc-uuid');
        if (csrf) SPARKP2P_DATA.csrf = csrf;
        if (uuid) SPARKP2P_DATA.uuid = uuid;
      } else if (typeof headers === 'object') {
        Object.entries(headers).forEach(([k, v]) => {
          const n = k.toLowerCase();
          if (n === 'csrftoken' && v) SPARKP2P_DATA.csrf = v;
          if (n === 'bnc-uuid' && v) SPARKP2P_DATA.uuid = v;
        });
      }
      window.__SPARKP2P__ = SPARKP2P_DATA;
    }
    return origFetch.apply(this, arguments);
  };

  console.log('[SparkP2P] Page interceptor loaded');
})();
`;
document.documentElement.appendChild(script);
script.remove();

// Listen for messages from popup/background
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_BINANCE_DATA') {
    // Read captured data from page context
    const data = {
      csrf: '',
      uuid: '',
      cookies: document.cookie,
    };

    // Access window.__SPARKP2P__ via a DOM trick
    // (content scripts can't directly access page JS variables)
    const bridge = document.createElement('script');
    bridge.textContent = `
      document.dispatchEvent(new CustomEvent('__sparkp2p_response__', {
        detail: JSON.stringify(window.__SPARKP2P__ || {})
      }));
    `;

    const handler = (e) => {
      try {
        const pageData = JSON.parse(e.detail);
        data.csrf = pageData.csrf || '';
        data.uuid = pageData.uuid || '';
      } catch (err) {}
      document.removeEventListener('__sparkp2p_response__', handler);
      sendResponse(data);
    };

    document.addEventListener('__sparkp2p_response__', handler);
    document.documentElement.appendChild(bridge);
    bridge.remove();

    // Timeout fallback
    setTimeout(() => {
      document.removeEventListener('__sparkp2p_response__', handler);
      sendResponse(data);
    }, 1000);

    return true; // async response
  }

  if (msg.type === 'TRIGGER_BINANCE_REQUEST') {
    // Trigger a lightweight Binance API call so the interceptor captures headers
    const bridge = document.createElement('script');
    bridge.textContent = `
      fetch('https://c2c.binance.com/bapi/c2c/v2/friendly/c2c/portal/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        credentials: 'include'
      }).catch(() => {});
    `;
    document.documentElement.appendChild(bridge);
    bridge.remove();
    sendResponse({ triggered: true });
    return false;
  }
});

console.log('[SparkP2P] Content script loaded');
