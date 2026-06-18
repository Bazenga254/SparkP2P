import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { login as apiLogin } from '../services/api';
import { isNative } from '../mobile/relayAgent';
import { bioAuthenticate, bioAvailable, bioEnabled } from '../mobile/biometric';

const APP_VER = '2.0.0';
const greet = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };
const firstName = (n) => (n || '').trim().split(/\s+/)[0] || '';

/**
 * CIC-style mobile entry screen — personalized greeting, password, and (when a session can be
 * resumed) a fingerprint "Tap to login". Used in two modes:
 *  - mode="login"  : no token yet — full sign-in (calls the login API).
 *  - mode="lock"   : a token exists but the app is locked — fingerprint resumes, or re-enter the
 *                    password to unlock. onUnlock() is called on success.
 */
export default function MobileLogin({ mode = 'login', onUnlock, onRegister }) {
  const navigate = useNavigate();
  const { loginUser } = useAuth();
  const isLock = mode === 'lock';

  const [name] = useState(() => localStorage.getItem('remembered_name') || '');
  const [email, setEmail] = useState(() => localStorage.getItem('remembered_email') || '');
  const [editEmail, setEditEmail] = useState(() => !localStorage.getItem('remembered_email'));
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [otpRequired, setOtpRequired] = useState(false);
  const [otp, setOtp] = useState('');
  const [phoneHint, setPhoneHint] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [bioOn, setBioOn] = useState(false);
  const [bioBusy, setBioBusy] = useState(false);

  // Fingerprint only appears where it can resume a kept session (lock mode + enabled + available).
  useEffect(() => {
    if (isLock && isNative() && bioEnabled()) bioAvailable().then((av) => setBioOn(!!av));
  }, [isLock]);

  const doBio = useCallback(async () => {
    if (bioBusy) return;
    setError(''); setBioBusy(true);
    const ok = await bioAuthenticate('Log in to SparkP2P');
    setBioBusy(false);
    if (ok) onUnlock && onUnlock();
    else setError('Fingerprint not recognized — try again or use your password.');
  }, [bioBusy, onUnlock]);

  // Auto-offer fingerprint the moment the locked screen appears.
  useEffect(() => { if (bioOn) doBio(); }, [bioOn]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (editEmail && !email) { setError('Enter your email'); return; }
    if (!password) { setError('Enter your password'); return; }
    setLoading(true);
    try {
      const res = await apiLogin(email, password, otpRequired ? otp : undefined);
      if (res.data.otp_required) {
        setOtpRequired(true); setPhoneHint(res.data.phone_hint || ''); setError('');
      } else {
        const role = res.data.role || 'trader';
        localStorage.setItem('remembered_email', email);
        if (res.data.full_name) localStorage.setItem('remembered_name', res.data.full_name);
        loginUser(res.data.access_token, { id: res.data.trader_id, full_name: res.data.full_name, role });
        if (isLock && onUnlock) onUnlock();
        navigate(role === 'employee' ? '/employee' : '/dashboard');
      }
    } catch (err) {
      const d = err.response?.data?.detail;
      setError(typeof d === 'string' ? d : d?.message || 'Invalid email or password');
    } finally { setLoading(false); }
  };

  const googleLogin = () => { window.location.href = `${import.meta.env.VITE_API_URL || ''}/api/auth/google`; };

  const notYou = () => {
    localStorage.removeItem('remembered_name');
    localStorage.removeItem('remembered_email');
    if (isLock) { localStorage.removeItem('token'); window.location.href = '/login'; }
    else { setEmail(''); setEditEmail(true); setPassword(''); setError(''); }
  };

  const knownUser = !!name && !editEmail;
  const initial = (name || email || 'S').trim().charAt(0).toUpperCase();

  return (
    <div className="mlogin">
      <div className="mlogin-topbar">
        <button className="mlogin-icon-btn" onClick={() => (isLock ? notYou() : navigate('/'))} aria-label="Back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
        </button>
        <div className="mlogin-brand">
          <img src="/logo.png" alt="SparkP2P" />
          <span>SparkP2P</span>
        </div>
        <button className="mlogin-icon-btn" onClick={() => navigate('/contact')} aria-label="Help">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></svg>
        </button>
      </div>

      <div className="mlogin-body">
        <h1 className="mlogin-title">Welcome Back</h1>

        <div className="mlogin-greet">
          <div className="mlogin-avatar">{initial}</div>
          <div className="mlogin-greet-text">
            <div className="mlogin-greet-hi">{knownUser ? `${greet()}, ${firstName(name)}!` : greet() + '!'}</div>
            <div className="mlogin-greet-sub">{knownUser ? 'Enter your password to continue' : 'Sign in to continue'}</div>
            {knownUser && <button className="mlogin-link mlogin-notyou" onClick={notYou}>Not you?</button>}
          </div>
        </div>

        <form onSubmit={submit} className="mlogin-form">
          {editEmail && (
            <div className="mlogin-input-wrap">
              <input className="mlogin-input" type="email" inputMode="email" autoComplete="email"
                placeholder="Email address" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
          )}

          <div className="mlogin-input-wrap">
            <input className="mlogin-input" type={showPw ? 'text' : 'password'} autoComplete="current-password"
              placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <button type="button" className="mlogin-eye" onClick={() => setShowPw((s) => !s)} aria-label="Show password">
              {showPw
                ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8" /><path d="M9.4 5.2A9.5 9.5 0 0 1 12 5c5 0 9 5 9 7a12 12 0 0 1-2.2 2.7M6.3 6.3A12.4 12.4 0 0 0 3 12c0 2 4 7 9 7a9 9 0 0 0 3.3-.6" /></svg>
                : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>}
            </button>
          </div>

          {otpRequired && (
            <div className="mlogin-input-wrap">
              <input className="mlogin-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                placeholder="6-digit code" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} autoFocus />
            </div>
          )}
          {otpRequired && <div className="mlogin-hint">Code sent to {phoneHint || 'your phone'} — or use your Google Authenticator code.</div>}

          <div className="mlogin-forgot">
            <button type="button" className="mlogin-link" onClick={() => navigate('/reset-password')}>Create/Forgot Password?</button>
          </div>

          {error && <div className="mlogin-error">{error}</div>}

          <button type="submit" className="mlogin-submit" disabled={loading}>
            {loading ? 'Please wait…' : otpRequired ? 'Verify & Continue' : 'Login'}
          </button>
        </form>

        {!isLock && (
          <>
            <div className="mlogin-create">
              Don't have an account?{' '}
              <button className="mlogin-link" onClick={() => (onRegister ? onRegister() : navigate('/login'))}>Create Account</button>
            </div>
            <div className="mlogin-or"><span>or</span></div>
            <button type="button" className="mlogin-google" onClick={googleLogin}>
              <svg width="20" height="20" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
              Continue with Google
            </button>
          </>
        )}

        {isLock && bioOn && (
          <>
            <div className="mlogin-or"><span>or</span></div>
            <div className="mlogin-bio">
              <button className="mlogin-bio-btn" onClick={doBio} disabled={bioBusy} aria-label="Login with fingerprint">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 11c-1.5 0-2.5 1-2.5 3s.5 4 1 5" /><path d="M7 18c-.5-1.5-.7-3-.5-5 .3-2.7 2.4-4.5 5.5-4.5s5.2 1.8 5.5 4.5c.1 1 .1 2 0 3" /><path d="M4.5 14c-.2-1.5-.2-3 .2-4.5C5.6 5.8 8.4 4 12 4s6.4 1.8 7.3 5.5" /><path d="M12 14v3c0 1.5.3 2.7.7 3.5" />
                </svg>
              </button>
              <div className="mlogin-bio-label">{bioBusy ? 'Waiting…' : 'Tap to login'}</div>
            </div>
          </>
        )}
      </div>

      <div className="mlogin-version">SparkP2P · v{APP_VER}</div>
    </div>
  );
}
