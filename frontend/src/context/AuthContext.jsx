import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { getProfile } from '../services/api';

const AuthContext = createContext(null);

const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const ACTIVITY_EVENTS = ['mousedown', 'keydown', 'touchstart', 'scroll', 'api-activity'];
const LAST_ACTIVE_KEY = 'sparkp2p_last_active';

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
    const token = localStorage.getItem('token');
    if (token) {
      // Check if session expired due to inactivity while app was closed
      const lastActive = localStorage.getItem(LAST_ACTIVE_KEY);
      if (lastActive) {
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
          setLoading(false);
        })
        .catch(() => {
          localStorage.removeItem('token');
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

  const loginUser = (token, userData) => {
    localStorage.setItem('token', token);
    setUser(userData);
  };

  return (
    <AuthContext.Provider value={{ user, loading, loginUser, logout, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
