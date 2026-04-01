import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { getProfile } from '../services/api';

const AuthContext = createContext(null);

const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const ACTIVITY_EVENTS = ['mousedown', 'keydown', 'touchstart', 'scroll', 'api-activity'];

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const inactivityTimer = useRef(null);

  const logout = useCallback(() => {
    localStorage.removeItem('token');
    setUser(null);
    if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
  }, []);

  const resetInactivityTimer = useCallback(() => {
    if (!localStorage.getItem('token')) return;
    if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    inactivityTimer.current = setTimeout(() => {
      logout();
      // Redirect to login with message
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
      getProfile()
        .then((res) => {
          setUser(res.data);
          setLoading(false);
        })
        .catch(() => {
          // Token is invalid or expired — clear it and redirect to login
          localStorage.removeItem('token');
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
