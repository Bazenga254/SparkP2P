import { useState, useEffect } from 'react';
import { isNative } from '../mobile/relayAgent';
import { bioEnabled } from '../mobile/biometric';
import MobileLogin from './MobileLogin';

// Wraps the app inside the native mobile app. When the trader has enabled biometric unlock (from
// Settings), the app locks on open / after a spell in the background and unlocks with
// fingerprint/face — no password. Inert on the web (isNative() === false).
export default function BiometricGate({ children }) {
  const native = isNative();
  const hasToken = () => !!localStorage.getItem('token');
  // While a Google login is being completed (google_token in the URL), do NOT lock — Login.jsx must
  // mount to consume that token. Otherwise the gate renders its own lock screen, swallows the token,
  // and the Google sign-in silently fails (you bounce back to login).
  const finishingOAuth = () => {
    try { return new URLSearchParams(window.location.search).has('google_token'); } catch (_) { return false; }
  };
  // Don't lock during the in-app KYC flow: capturing ID/selfie photos backgrounds the app (camera),
  // and re-locking mid-verification would dump the user back to "sign in" and lose their progress.
  const onVerifyRoute = () => {
    try { const p = window.location.pathname; return p.startsWith('/kyc/') || p.startsWith('/verify-kyc') || p.startsWith('/account/'); } catch (_) { return false; }
  };
  const skipLock = () => finishingOAuth() || onVerifyRoute();
  const [locked, setLocked] = useState(() => native && bioEnabled() && hasToken() && !skipLock());

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
        if (bioEnabled() && hasToken() && hiddenAt && (Date.now() - hiddenAt) > GRACE_MS && !onVerifyRoute()) {
          setLocked(true);
        }
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [native]);

  // ── Locked screen — CIC-style entry (fingerprint resume + password fallback) ──
  if (native && bioEnabled() && locked && hasToken() && !skipLock()) {
    return <MobileLogin mode="lock" onUnlock={() => setLocked(false)} />;
  }

  return children;
}
