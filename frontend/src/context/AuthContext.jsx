import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { getProfile } from '../services/api';

const AuthContext = createContext(null);

const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes (web/desktop only)
const ACTIVITY_EVENTS = ['mousedown', 'keydown', 'touchstart', 'scroll', 'api-activity'];
const LAST_ACTIVE_KEY = 'sparkp2p_last_active';
// In the native mobile app users stay logged in (like any phone app); the idle auto-logout is
// web/desktop-only. The relay also runs independently of the UI session.
const isNativeApp = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

// Public, token-based pages that must NEVER be hijacked by the session redirect. The mobile KYC
// page (/kyc/:token) is opened on a phone that may still carry a stale login token from an earlier
// (e.g. Google) sign-in; validating that token here would bounce the merchant to /login before the
// KYC form can render — the "QR redirects to sparkp2p.com instead of the KYC page" bug.
const isPublicSelfAuthPath = () => {
  const p = window.location.pathname || '';
  return p.startsWith('/kyc/') || p.startsWith('/verify-kyc') || p.startsWith('/account/');
};

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const inactivityTimer = useRef(null);

  const logout = useCallback(() => {
    localStorage.removeItem('token');
    localStorage.removeItem(LAST_ACTIVE_KEY);
    setUser(null);
    if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
  }, []);

  const resetInactivityTimer = useCallback(() => {
    if (!localStorage.getItem('token')) return;
    localStorage.setItem(LAST_ACTIVE_KEY, Date.now().toString());
    if (isNativeApp()) return;   // mobile app: never idle-logout
    if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    inactivityTimer.current = setTimeout(() => {
      logout();
      window.location.href = '/login?reason=inactivity';
    }, INACTIVITY_TIMEOUT_MS);
  }, [logout]);

  // Attach activity listeners when user is logged in
  useEffect(() => {
    if (!user) return;
    resetInactivityTimer();
    ACTIVITY_EVENTS.forEach(event => window.addEventListener(event, resetInactivityTimer, { passive: true }));
    return () => {
      ACTIVITY_EVENTS.forEach(event => window.removeEventListener(event, resetInactivityTimer));
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    };
  }, [user, resetInactivityTimer]);

  const checkAuth = () => {
    // Never run the session check / redirect on a public token-based page (mobile KYC) — it would
    // hijack a phone that carries a stale token and throw it to /login instead of the KYC form.
    if (isPublicSelfAuthPath()) { setLoading(false); return; }
    const token = localStorage.getItem('token');
    if (token) {
      // Check if session expired due to inactivity while app was closed
      const lastActive = localStorage.getItem(LAST_ACTIVE_KEY);
      if (lastActive && !isNativeApp()) {
        const elapsed = Date.now() - parseInt(lastActive, 10);
        if (elapsed > INACTIVITY_TIMEOUT_MS) {
          localStorage.removeItem('token');
          localStorage.removeItem(LAST_ACTIVE_KEY);
          setLoading(false);
          window.location.href = '/login?reason=inactivity';
          return;
        }
      }
      getProfile()
        .then((res) => {
          setUser(res.data);
          // Keep the fingerprint sign-in token fresh so biometric login always works (even after
          // logging out or restarting the phone), for native users who enabled it.
          try {
            if (isNativeApp() && localStorage.getItem('bio_enabled') === '1') {
              localStorage.setItem('bio_token', token);
            }
          } catch (_) { /* ignore */ }
          setLoading(false);
        })
        .catch(() => {
          localStorage.removeItem('token');
          localStorage.removeItem('bio_token');   // saved fingerprint sign-in is stale too
          localStorage.removeItem(LAST_ACTIVE_KEY);
          setLoading(false);
          window.location.href = '/login';
        });
    } else {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkAuth();
  }, []);

  const loginUser = async (token, userData) => {
    localStorage.setItem('token', token);
    setUser(userData);                 // instant minimal user (id/name/role) so the UI reacts now
    // Upgrade to the FULL profile so onboarding_complete (and the rest) is known
    // immediately — the onboarding gate relies on it right after sign-up/login.
    try {
      const res = await getProfile();
      setUser(res.data);
      return res.data;
    } catch {
      return userData;                 // network hiccup: keep the minimal user, gate falls back safely
    }
  };

  // Re-pull the profile into context (e.g. after finishing onboarding) so the
  // onboarding gate immediately sees onboarding_complete=true and doesn't bounce.
  const refreshUser = useCallback(async () => {
    try {
      const res = await getProfile();
      setUser(res.data);
      return res.data;
    } catch {
      return null;
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, loginUser, logout, setUser, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
