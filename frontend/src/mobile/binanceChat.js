// SparkP2P mobile chat-send bridge.
//
// Binance P2P has no REST chat API (DOM/WebSocket only), so on mobile we mirror the desktop: the
// native BinanceChatPlugin loads the order page in an app WebView (reusing the Binance session the
// merchant logged into) and injects JS that types into the chat box and clicks Send.
//
// Only active inside the native Android wrapper. In a plain browser these are inert no-ops.

const plugin = () =>
  (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BinanceChat) || null;

export const hasBinanceChat = () => !!plugin();

// Open the visible Binance web-login WebView. Merchant logs in once; cookies persist.
export async function openBinanceLogin() {
  const p = plugin();
  if (!p) return { ok: false, error: 'not native' };
  try { await p.openLogin(); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
}

// Is there a stored Binance session in the app WebView?
export async function binanceChatStatus() {
  const p = plugin();
  if (!p) return { loggedIn: false, native: false };
  try { const r = await p.status(); return { loggedIn: !!r.loggedIn, native: true }; }
  catch (_) { return { loggedIn: false, native: true }; }
}

// Send a chat message to an order. Resolves { ok, detail }.
export async function sendBinanceChat(orderNumber, message) {
  const p = plugin();
  if (!p) return { ok: false, detail: 'not native' };
  try { return await p.sendMessage({ orderNumber: String(orderNumber), message: String(message) }); }
  catch (e) { return { ok: false, detail: String(e && e.message ? e.message : e) }; }
}

export async function binanceChatLogout() {
  const p = plugin();
  if (!p) return;
  try { await p.logout(); } catch (_) {}
}
