import { useState, useEffect } from 'react';
import { isNative } from '../mobile/relayAgent';
import { bioAuthenticate, bioAvailable, bioEnabled, setBioEnabled, bioAsked, markBioAsked } from '../mobile/biometric';
import MobileLogin from './MobileLogin';

// Wraps the app inside the native mobile app. When the trader has enabled biometric unlock, the app
// locks on open / when returning to foreground and unlocks with fingerprint/face — no password.
// Also offers to turn it on once, after the first login. Inert on the web (isNative() === false).
export default function BiometricGate({ children }) {
  const native = isNative();
  const hasToken = () => !!localStorage.getItem('token');
  const [locked, setLocked] = useState(() => native && bioEnabled() && hasToken());
  const [busy, setBusy] = useState(false);
  const [askEnable, setAskEnable] = useState(false);

  // Re-lock when the app returns to the foreground — but only after a grace period away, so a
  // quick switch out and back (e.g. to copy an OTP) doesn't force a fingerprint every time.
  useEffect(() => {
    if (!native) return;
    const GRACE_MS = 60000;   // 1 minute
    let hiddenAt = 0;
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
      } else if (document.visibilityState === 'visible') {
        if (bioEnabled() && hasToken() && hiddenAt && (Date.now() - hiddenAt) > GRACE_MS) {
          setLocked(true);
        }
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [native]);

  // Offer to enable biometrics once, after the trader is logged in.
  useEffect(() => {
    if (!native || !hasToken() || bioEnabled() || bioAsked()) return;
    bioAvailable().then((av) => { if (av) setAskEnable(true); });
  }, [native]);

  const doEnable = async () => {
    setBusy(true);
    const ok = await bioAuthenticate('Confirm to enable fingerprint unlock');
    setBusy(false);
    markBioAsked();
    if (ok) setBioEnabled(true);
    setAskEnable(false);
  };
  const skipEnable = () => { markBioAsked(); setAskEnable(false); };

  // ── Locked screen — CIC-style entry (fingerprint resume + password fallback) ──
  if (native && bioEnabled() && locked && hasToken()) {
    return <MobileLogin mode="lock" onUnlock={() => setLocked(false)} />;
  }

  // ── Children (+ one-time enable prompt) ─────────────────
  return (
    <>
      {children}
      {askEnable && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(7,13,28,0.72)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div style={{ width: '100%', maxWidth: 440, background: '#121a2e', borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: '26px 24px 30px', boxShadow: '0 -10px 40px rgba(0,0,0,0.5)', fontFamily: 'Inter, system-ui, sans-serif' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: 'rgba(245,166,35,0.15)', border: '1px solid rgba(245,166,35,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#F5A623" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 11c-1.5 0-2.5 1-2.5 3s.5 4 1 5"/><path d="M7 18c-.5-1.5-.7-3-.5-5 .3-2.7 2.4-4.5 5.5-4.5s5.2 1.8 5.5 4.5c.1 1 .1 2 0 3"/><path d="M4.5 14c-.2-1.5-.2-3 .2-4.5C5.6 5.8 8.4 4 12 4s6.4 1.8 7.3 5.5"/><path d="M12 14v3c0 1.5.3 2.7.7 3.5"/></svg>
              </div>
              <div style={{ fontSize: 18, fontWeight: 800, color: '#fff' }}>Enable fingerprint unlock?</div>
            </div>
            <div style={{ fontSize: 13.5, color: '#9fb0c9', lineHeight: 1.6, marginBottom: 20 }}>
              Stay signed in and unlock SparkP2P with your fingerprint or face — no password needed next time.
            </div>
            <button onClick={doEnable} disabled={busy}
              style={{ width: '100%', padding: '14px', border: 'none', borderRadius: 12, background: 'linear-gradient(135deg,#FFC85A,#F5A623)', color: '#1a1206', fontSize: 16, fontWeight: 800, cursor: 'pointer', opacity: busy ? 0.7 : 1 }}>
              {busy ? 'Confirming…' : 'Enable fingerprint unlock'}
            </button>
            <button onClick={skipEnable} disabled={busy}
              style={{ width: '100%', marginTop: 10, padding: '12px', background: 'none', border: 'none', color: '#9fb0c9', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
              Not now
            </button>
          </div>
        </div>
      )}
    </>
  );
}
