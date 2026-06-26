import { useState, useEffect } from 'react';
import { isNative } from '../mobile/relayAgent';
import { hasBinanceChat, openBinanceLogin, binanceChatStatus, sendBinanceChat, binanceChatLogout, checkBinanceAuth } from '../mobile/binanceChat';
import { hasChoiceSms, requestSmsPermission, smsPermissionStatus } from '../mobile/choiceSms';

// Phase-1 test panel for mobile chat-send (BinanceChatPlugin). Lets the merchant log into Binance
// inside the app, confirm the session, and manually send a test message to an order — proving the
// WebView + JS-injection chat path on the device before it's wired into the automated flow.
// Native-only; renders nothing on the web or if the plugin isn't present.
export default function BinanceChatTest() {
  const [native, setNative] = useState(isNative());
  const [loggedIn, setLoggedIn] = useState(false);
  const [order, setOrder] = useState('');
  const [msg, setMsg] = useState('Hello — test message from SparkP2P mobile.');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const [smsGranted, setSmsGranted] = useState(false);

  useEffect(() => {
    if (native) return;
    let n = 0;
    const id = setInterval(() => { if (isNative()) { setNative(true); clearInterval(id); } else if (++n > 20) clearInterval(id); }, 500);
    return () => clearInterval(id);
  }, [native]);

  const refresh = async () => { const s = await binanceChatStatus(); setLoggedIn(!!s.loggedIn); };
  useEffect(() => { if (native) refresh(); }, [native]);

  const refreshSms = async () => { const s = await smsPermissionStatus(); setSmsGranted(!!s.granted); };
  useEffect(() => { if (native && hasChoiceSms()) refreshSms(); }, [native]);
  const grantSms = async () => { await requestSmsPermission(); setTimeout(refreshSms, 1500); };

  if (!native || !hasBinanceChat()) return null;

  const connect = async () => { await openBinanceLogin(); setTimeout(refresh, 1500); };
  const send = async () => {
    if (!order.trim()) { setResult('Enter an order number'); return; }
    setBusy(true); setResult('Loading order + sending…');
    const r = await sendBinanceChat(order.trim(), msg);
    setResult((r.ok ? '✅ ' : '⚠️ ') + (r.detail || JSON.stringify(r)));
    setBusy(false);
  };

  const check = async () => {
    setBusy(true); setResult('Checking login (no order placed)…');
    const r = await checkBinanceAuth();
    const li = (r.detail || '').startsWith('LOGGED_IN');
    setResult((li ? '✅ ' : '⚠️ ') + (r.detail || JSON.stringify(r)));
    setBusy(false);
  };

  return (
    <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(245,166,35,0.30)', borderRadius: 12, padding: 14, marginBottom: 14 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: '#fbbf24', marginBottom: 4 }}>📱 Mobile chat-send (test)</div>
      <div style={{ fontSize: 12, color: '#9ca3af', lineHeight: 1.5, marginBottom: 10 }}>
        Log into Binance inside the app, then send a test message to one of your orders — this proves
        chat works on the phone with no laptop.
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: loggedIn ? '#10b981' : '#f59e0b' }} />
        <span style={{ fontSize: 12.5, color: loggedIn ? '#6ee7b7' : '#fbbf24', fontWeight: 600 }}>
          {loggedIn ? 'Binance session active' : 'Not logged in to Binance'}
        </span>
        <button type="button" onClick={refresh} style={miniBtn}>Refresh</button>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <button type="button" onClick={connect} style={btn}>
          {loggedIn ? 'Re-connect Binance' : 'Connect Binance'}
        </button>
        {loggedIn && <button type="button" onClick={async () => { await binanceChatLogout(); refresh(); }} style={{ ...miniBtn, padding: '10px 12px' }}>Log out</button>}
      </div>

      <button type="button" onClick={check} disabled={busy} style={{ ...btn, width: '100%', marginBottom: 10, background: 'rgba(16,185,129,0.18)', color: '#6ee7b7', border: '1px solid rgba(16,185,129,0.4)' }}>
        {busy ? 'Working…' : '1. Check login (safe — no order)'}
      </button>

      <input value={order} onChange={(e) => setOrder(e.target.value)} placeholder="Order number"
        style={input} inputMode="numeric" />
      <textarea value={msg} onChange={(e) => setMsg(e.target.value)} rows={2} placeholder="Message"
        style={{ ...input, resize: 'vertical' }} />
      <button type="button" onClick={send} disabled={busy} style={{ ...btn, opacity: busy ? 0.6 : 1 }}>
        {busy ? 'Sending…' : 'Send test message'}
      </button>

      {result && <div style={{ fontSize: 11.5, color: '#d1d5db', marginTop: 10, wordBreak: 'break-word', fontFamily: 'monospace' }}>{result}</div>}

      {hasChoiceSms() && (
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#fbbf24', marginBottom: 4 }}>📩 Choice SMS-OTP reader</div>
          <div style={{ fontSize: 11.5, color: '#9ca3af', lineHeight: 1.5, marginBottom: 10 }}>
            Lets the app read Choice Bank transaction OTPs from SMS and confirm payouts automatically.
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: smsGranted ? '#10b981' : '#f59e0b' }} />
            <span style={{ fontSize: 12.5, color: smsGranted ? '#6ee7b7' : '#fbbf24', fontWeight: 600, flex: 1 }}>
              {smsGranted ? 'SMS permission granted' : 'SMS permission needed'}
            </span>
            {!smsGranted && <button type="button" onClick={grantSms} style={btn}>Grant SMS permission</button>}
          </div>
        </div>
      )}
    </div>
  );
}

const btn = { flex: 1, background: 'linear-gradient(135deg,#FFC85A,#D9760C)', color: '#1a1206', fontWeight: 700, fontSize: 13.5, border: 'none', borderRadius: 10, padding: '11px 14px', cursor: 'pointer' };
const miniBtn = { background: 'rgba(255,255,255,0.08)', color: '#d1d5db', fontSize: 12, border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, padding: '6px 10px', cursor: 'pointer' };
const input = { width: '100%', boxSizing: 'border-box', background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, padding: '10px 12px', color: '#fff', fontSize: 13, marginBottom: 8 };
