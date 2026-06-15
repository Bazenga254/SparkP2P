import { useState, useEffect, useRef } from 'react';
import { getRelayOnline } from '../services/api';
import { isNative, startRelay, platformName } from '../mobile/relayAgent';

// Shows whether THIS trader's relay (desktop app or phone) is online — which the API-key test
// needs, because the server can't reach Binance directly. In the native phone app it offers a
// one-tap "Turn on relay"; otherwise it points to the app/desktop. Reports status up via onStatus
// so the parent can gate the "Test Connection" button.
export default function RelayConnectStatus({ onStatus }) {
  const [online, setOnline] = useState(null); // null = checking, true, false
  const [starting, setStarting] = useState(false);
  // The Capacitor bridge can attach a moment after first paint on some WebViews, so re-check for
  // a few seconds rather than trusting a single render-time read.
  const [native, setNative] = useState(isNative());
  const fastRef = useRef(null);

  useEffect(() => {
    if (native) return;
    let n = 0;
    const id = setInterval(() => {
      if (isNative()) { setNative(true); clearInterval(id); }
      else if (++n > 20) clearInterval(id); // ~10s
    }, 500);
    return () => clearInterval(id);
  }, [native]);

  const check = async () => {
    try {
      const r = await getRelayOnline();
      const v = !!r.data?.online;
      setOnline(v);
      onStatus && onStatus(v);
      if (v && fastRef.current) { clearInterval(fastRef.current); fastRef.current = null; }
    } catch (_) { /* keep last known */ }
  };

  useEffect(() => {
    check();
    const id = setInterval(check, 4000);
    return () => { clearInterval(id); if (fastRef.current) clearInterval(fastRef.current); };
  }, []);

  const enable = async () => {
    setStarting(true);
    try { localStorage.setItem('sparkp2p_relay_on', '1'); await startRelay(); } catch (_) {}
    if (!fastRef.current) {
      let tries = 0;
      fastRef.current = setInterval(() => { tries++; check(); if (tries > 20) { clearInterval(fastRef.current); fastRef.current = null; } }, 1500);
    }
    setTimeout(() => setStarting(false), 5000);
  };

  // ── Online ──────────────────────────────────────────────
  if (online === true) {
    return (
      <div style={box('rgba(16,185,129,0.10)', 'rgba(16,185,129,0.30)')}>
        <span style={dot('#10b981')} />
        <div style={{ fontSize: 13, color: '#6ee7b7', fontWeight: 600 }}>
          Relay online — ready to verify your API keys.
        </div>
      </div>
    );
  }

  // ── Checking ────────────────────────────────────────────
  if (online === null) {
    return (
      <div style={box('rgba(255,255,255,0.04)', 'rgba(255,255,255,0.10)')}>
        <span style={dot('#6b7280')} />
        <div style={{ fontSize: 13, color: '#9ca3af' }}>Checking your relay…</div>
      </div>
    );
  }

  // ── Offline ─────────────────────────────────────────────
  return (
    <div style={{ ...box('rgba(245,166,35,0.10)', 'rgba(245,166,35,0.30)'), flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={dot('#f59e0b')} />
        <div style={{ fontSize: 13.5, color: '#fbbf24', fontWeight: 700 }}>
          Turn on your relay first
        </div>
      </div>

      {native ? (
        <>
          <div style={{ fontSize: 12.5, color: '#d4b483', lineHeight: 1.55 }}>
            Verifying your API keys needs the relay running on this phone — it securely reaches Binance from
            your own connection. Tap below, then test again.
          </div>
          <button
            type="button"
            onClick={enable}
            disabled={starting}
            style={{ background: 'linear-gradient(135deg,#FFC85A,#D9760C)', color: '#1a1206', fontWeight: 700, fontSize: 14, border: 'none', borderRadius: 10, padding: '11px 14px', cursor: starting ? 'default' : 'pointer', opacity: starting ? 0.7 : 1 }}
          >
            {starting ? 'Starting relay…' : 'Turn on phone relay'}
          </button>
          <div style={{ fontSize: 11, color: '#9ca3af', lineHeight: 1.5 }}>
            Allow the notification &amp; battery prompts so it stays online in the background.
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 12.5, color: '#d4b483', lineHeight: 1.55 }}>
            Verifying your API keys needs the SparkP2P relay running on your device.
          </div>
          <a
            href="/api/download/android"
            style={{ display: 'block', textAlign: 'center', background: 'linear-gradient(135deg,#FFC85A,#D9760C)', color: '#1a1206', fontWeight: 700, fontSize: 14, borderRadius: 10, padding: '11px 14px', textDecoration: 'none' }}
          >
            Download the SparkP2P Android app
          </a>
          <div style={{ fontSize: 11.5, color: '#9ca3af', lineHeight: 1.55 }}>
            <strong>Already installed the app and still seeing this?</strong> Update <strong>Android
            System WebView</strong> and Chrome in the Play Store, then fully close and reopen the SparkP2P
            app. (On a computer, run the SparkP2P desktop app instead.)
          </div>
        </>
      )}

      <div style={{ fontSize: 10.5, color: '#6b7280', marginTop: 2 }}>Relay agent: {platformName()}</div>
    </div>
  );
}

const box = (bg, border) => ({
  background: bg, border: `1px solid ${border}`, borderRadius: 12,
  padding: '12px 14px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10,
});
const dot = (c) => ({ width: 9, height: 9, borderRadius: '50%', background: c, flex: '0 0 auto', boxShadow: `0 0 6px ${c}` });
