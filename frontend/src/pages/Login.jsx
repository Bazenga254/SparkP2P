import { useState, useEffect } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { login, register, sendVerificationCode } from '../services/api';

const PASSWORD_RULES = [
  { label: 'At least 8 characters', test: (p) => p.length >= 8 },
  { label: '2 uppercase letters', test: (p) => (p.match(/[A-Z]/g) || []).length >= 2 },
  { label: '2 lowercase letters', test: (p) => (p.match(/[a-z]/g) || []).length >= 2 },
  { label: '2 numbers', test: (p) => (p.match(/[0-9]/g) || []).length >= 2 },
  { label: '2 special characters (!@#$%...)', test: (p) => (p.match(/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/g) || []).length >= 2 },
];

export default function Login() {
  const [isRegister, setIsRegister] = useState(false);
  const [form, setForm] = useState({
    first_name: '', last_name: '', email: '', phone: '', password: '', confirm_password: '', email_code: '',
    security_question: '', security_answer: '',
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [otpRequired, setOtpRequired] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [phoneHint, setPhoneHint] = useState('');
  const [lockoutUntil, setLockoutUntil] = useState(null); // Date object
  const [lockoutCountdown, setLockoutCountdown] = useState('');
  const [attemptsRemaining, setAttemptsRemaining] = useState(null);
  const [resendCooldown, setResendCooldown] = useState(0); // seconds
  const [showReset, setShowReset] = useState(false);
  const [googleProfile, setGoogleProfile] = useState(null); // {token, name, id, role} — needs phone+KYC
  const [profileForm, setProfileForm] = useState({ full_name: '', phone: '' });
  const [savingProfile, setSavingProfile] = useState(false);
  const { loginUser } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Show inactivity message if redirected
  const inactivityLogout = searchParams.get('reason') === 'inactivity';

  // Handle Google OAuth callback
  useEffect(() => {
    const googleToken = searchParams.get('google_token');
    if (googleToken) {
      const name = searchParams.get('name') || '';
      const id = searchParams.get('id') || '';
      const role = searchParams.get('role') || 'trader';
      const needsProfile = searchParams.get('needs_profile') === '1';

      if (needsProfile) {
        // Show profile completion form
        setGoogleProfile({ token: googleToken, name, id, role });
        setProfileForm({ full_name: name.toUpperCase(), phone: '' });
      } else {
        loginUser(googleToken, { id, full_name: name, role });
        navigate('/dashboard');
      }
    }
    const googleError = searchParams.get('error');
    if (googleError) {
      setError(`Google login failed: ${googleError}`);
    }
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  // Lockout countdown ticker
  useEffect(() => {
    if (!lockoutUntil) return;
    const tick = () => {
      const diff = lockoutUntil - Date.now();
      if (diff <= 0) {
        setLockoutUntil(null);
        setLockoutCountdown('');
        return;
      }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setLockoutCountdown(
        `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [lockoutUntil]);

  const handleCompleteProfile = async (e) => {
    e.preventDefault();
    if (!profileForm.full_name || !profileForm.phone) {
      setError('Full name and phone number are required');
      return;
    }
    if (!/^(07|01|2547|2541)\d{7,8}$/.test(profileForm.phone.replace(/\s/g, ''))) {
      setError('Enter a valid Kenyan phone number (e.g., 0712345678)');
      return;
    }
    setSavingProfile(true);
    setError('');
    try {
      const res = await fetch('/api/traders/complete-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleProfile.token}` },
        body: JSON.stringify({ full_name: profileForm.full_name.toUpperCase(), phone: profileForm.phone }),
      });
      if (res.ok) {
        loginUser(googleProfile.token, { id: googleProfile.id, full_name: profileForm.full_name, role: googleProfile.role });
        navigate('/dashboard');
      } else {
        const data = await res.json();
        setError(data.detail || 'Failed to save profile');
      }
    } catch (err) {
      setError('Network error');
    }
    setSavingProfile(false);
  };

  const updateForm = (field, value) => setForm({ ...form, [field]: value });

  const handleSendCode = async () => {
    if (!form.email) { setError('Enter your email first'); return; }
    setSendingCode(true);
    setError('');
    try {
      await sendVerificationCode(form.email);
      setCodeSent(true);
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to send code');
    }
    setSendingCode(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (isRegister) {
      // Validate password
      const failedRules = PASSWORD_RULES.filter((r) => !r.test(form.password));
      if (failedRules.length > 0) {
        setError(`Password missing: ${failedRules.map((r) => r.label).join(', ')}`);
        return;
      }
      if (form.password !== form.confirm_password) {
        setError('Passwords do not match');
        return;
      }
      if (!form.email_code) {
        setError('Enter the verification code sent to your email');
        return;
      }
    }

  const handleResendOtp = async () => {
    if (resendCooldown > 0) return;
    setError('');
    try {
      await login(form.email, form.password);
      setOtpCode('');
      setError('');
      // Start 30s cooldown
      setResendCooldown(30);
      const interval = setInterval(() => {
        setResendCooldown(prev => {
          if (prev <= 1) { clearInterval(interval); return 0; }
          return prev - 1;
        });
      }, 1000);
    } catch (err) {
      setError('Failed to resend code. Please try again.');
    }
  };

    setLoading(true);
    try {
      if (isRegister) {
        if (!form.security_question || !form.security_answer) {
          setError('Please select a security question and provide an answer');
          setLoading(false);
          return;
        }
        const res = await register({
          full_name: form.full_name,
          email: form.email,
          phone: form.phone,
          password: form.password,
          email_code: form.email_code,
          security_question: form.security_question,
          security_answer: form.security_answer,
        });
        const role = res.data.role || 'trader';
        loginUser(res.data.access_token, { id: res.data.trader_id, full_name: res.data.full_name, role });
        navigate(role === 'employee' ? '/employee' : '/dashboard');
      } else {
        // Login with optional OTP
        const res = await login(form.email, form.password, otpRequired ? otpCode : undefined);

        if (res.data.otp_required) {
          // Step 1: OTP sent to phone
          setOtpRequired(true);
          setPhoneHint(res.data.phone_hint || '');
          setError('');
        } else {
          // Step 2: OTP verified, got token
          const role = res.data.role || 'trader';
          loginUser(res.data.access_token, { id: res.data.trader_id, full_name: res.data.full_name, role });
          navigate(role === 'employee' ? '/employee' : '/dashboard');
        }
      }
    } catch (err) {
      const detail = err.response?.data?.detail;
      const httpStatus = err.response?.status;
      if (httpStatus === 423 || detail?.code === 'account_locked') {
        const until = detail?.locked_until ? new Date(detail.locked_until) : new Date(Date.now() + 24 * 60 * 60 * 1000);
        setLockoutUntil(until);
        setAttemptsRemaining(null);
        setError('');
      } else if (detail?.code === 'invalid_credentials') {
        setAttemptsRemaining(detail.attempts_remaining ?? null);
        setShowReset(detail.show_reset || false);
        setError(detail.message || 'Invalid email or password');
      } else if (Array.isArray(detail)) {
        setError(detail.map((d) => d.msg).join('. '));
      } else {
        setError(typeof detail === 'string' ? detail : detail?.message || 'Something went wrong');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-split">
      <div className="login-left">
        <Link to="/" className="login-left-brand">
          <img src="/logo.png" alt="SparkP2P" className="login-left-logo" />
          <span className="login-left-name">SparkP2P</span>
        </Link>
        <div className="login-left-content">
          <h2>Automate Your<br />Binance P2P Trading</h2>
          <p>Payments verified. Crypto released. All on autopilot.</p>
        </div>
        <div className="login-left-illustration">
          <img src="/trading-illustration.jpg" alt="P2P Trading" loading="eager" />
        </div>
        <div className="login-left-footer">Powered by Spark AI</div>
      </div>

      <div className="login-right">
        <Link to="/" className="login-back-home">Back to Homepage</Link>
        <div className="login-right-inner">

          {/* Google Profile Completion */}
          {googleProfile ? (
            <>
              <h1>Complete Your Profile</h1>
              <p className="login-right-sub">
                Enter your details to finish setting up your account
              </p>

              {error && <div className="login-error">{error}</div>}

              <form onSubmit={handleCompleteProfile}>
                <div className="login-disclaimer">
                  Enter your full name exactly as it appears on your Binance KYC. This is shown to buyers during P2P payment verification.
                </div>

                <div className="login-field">
                  <label>Full Name (as on Binance KYC)</label>
                  <input
                    type="text"
                    placeholder="JOE ANTONY WANDABWA"
                    value={profileForm.full_name}
                    onChange={(e) => setProfileForm({ ...profileForm, full_name: e.target.value.toUpperCase() })}
                    required
                    style={{ textTransform: 'uppercase' }}
                  />
                </div>

                <div className="login-field">
                  <label>Phone Number (M-Pesa)</label>
                  <input
                    type="tel"
                    placeholder="0712345678"
                    value={profileForm.phone}
                    onChange={(e) => setProfileForm({ ...profileForm, phone: e.target.value })}
                    required
                  />
                </div>

                <button type="submit" disabled={savingProfile} className="login-submit-btn">
                  {savingProfile ? 'Saving...' : 'Continue to Dashboard'}
                </button>
              </form>
            </>
          ) : (
          <>
          <h1>{isRegister ? 'Create Account' : 'Welcome to SparkP2P'}</h1>
          <p className="login-right-sub">
            {isRegister ? 'Register to start automating your trades' : 'Sign in to your account'}
          </p>

          <form onSubmit={handleSubmit}>
            {isRegister && (
              <>
                {/* Name disclaimer */}
                <div className="login-disclaimer">
                  Enter your full name exactly as it appears on your Binance KYC. This is shown to buyers during P2P payment verification.
                </div>

                <div className="login-field">
                  <label>Full Name (as on Binance KYC)</label>
                  <input
                    type="text"
                    placeholder="JOE ANTONY WANDABWA"
                    value={form.full_name}
                    onChange={(e) => updateForm('full_name', e.target.value.toUpperCase())}
                    required
                    style={{ textTransform: 'uppercase' }}
                  />
                </div>

                <div className="login-field">
                  <label>Phone Number</label>
                  <input
                    type="tel"
                    placeholder="0712345678"
                    value={form.phone}
                    onChange={(e) => updateForm('phone', e.target.value)}
                    required
                  />
                  <span className="login-field-hint">M-Pesa registered number</span>
                </div>
              </>
            )}

            <div className="login-field">
              <label>Email Address</label>
              <div className="login-field-with-btn">
                <input
                  type="email"
                  placeholder="you@example.com"
                  value={form.email}
                  onChange={(e) => updateForm('email', e.target.value)}
                  required
                />
                {isRegister && (
                  <button
                    type="button"
                    className="login-verify-btn"
                    onClick={handleSendCode}
                    disabled={sendingCode || !form.email}
                  >
                    {sendingCode ? 'Sending...' : codeSent ? 'Resend' : 'Verify'}
                  </button>
                )}
              </div>
            </div>

            {isRegister && codeSent && (
              <div className="login-field">
                <label>Verification Code</label>
                <input
                  type="text"
                  placeholder="Enter 6-digit code"
                  value={form.email_code}
                  onChange={(e) => updateForm('email_code', e.target.value)}
                  maxLength={6}
                  required
                />
                <span className="login-field-hint">Check your email for the code</span>
              </div>
            )}

            <div className="login-field">
              <label>Password</label>
              <div className="login-field-with-btn">
                <input
                  type={showPassword ? 'text' : 'password'}
                  placeholder={isRegister ? 'Create a strong password' : 'Enter your password'}
                  value={form.password}
                  onChange={(e) => updateForm('password', e.target.value)}
                  required
                />
                <button
                  type="button"
                  className="login-toggle-pw"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>

            {isRegister && form.password && (
              <>
                <div className="password-rules">
                  {PASSWORD_RULES.map((rule, i) => (
                    <div key={i} className={`pw-rule ${rule.test(form.password) ? 'pass' : 'fail'}`}>
                      <span className="pw-rule-icon">{rule.test(form.password) ? '✓' : '✗'}</span>
                      {rule.label}
                    </div>
                  ))}
                </div>

                <div className="login-field">
                  <label>Confirm Password</label>
                  <input
                    type="password"
                    placeholder="Re-enter your password"
                    value={form.confirm_password}
                    onChange={(e) => updateForm('confirm_password', e.target.value)}
                    required
                  />
                  {form.confirm_password && form.password !== form.confirm_password && (
                    <span className="login-field-error">Passwords do not match</span>
                  )}
                </div>

                {/* Security Question */}
                <div className="login-field">
                  <label>Security Question</label>
                  <select
                    value={form.security_question}
                    onChange={(e) => updateForm('security_question', e.target.value)}
                    required
                    style={{
                      width: '100%', padding: '12px 14px', borderRadius: 10,
                      border: '1px solid #d1d5db', background: '#fff', color: '#111',
                      fontSize: 14, appearance: 'auto',
                    }}
                  >
                    <option value="">Select a security question</option>
                    <option value="What is your mother's maiden name?">What is your mother's maiden name?</option>
                    <option value="What was the name of your first pet?">What was the name of your first pet?</option>
                    <option value="What city were you born in?">What city were you born in?</option>
                    <option value="What is the name of your primary school?">What is the name of your primary school?</option>
                    <option value="What was your childhood nickname?">What was your childhood nickname?</option>
                  </select>
                  <span className="login-field-hint" style={{ color: '#ef4444' }}>
                    This cannot be changed after registration. Choose carefully.
                  </span>
                </div>

                <div className="login-field">
                  <label>Security Answer</label>
                  <input
                    type="text"
                    placeholder="Your answer (case-insensitive)"
                    value={form.security_answer}
                    onChange={(e) => updateForm('security_answer', e.target.value)}
                    required
                  />
                  <span className="login-field-hint">
                    You'll need this to change your payment method. Remember it.
                  </span>
                </div>
              </>
            )}

            {/* Login OTP Step */}
            {!isRegister && otpRequired && (
              <div className="login-field">
                <label>Verification Code</label>
                <input
                  type="text"
                  placeholder="Enter 6-digit OTP"
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value)}
                  maxLength={6}
                  autoFocus
                  required
                />
                <span className="login-field-hint">
                  Code sent to {phoneHint}
                </span>
              </div>
            )}

            {/* Inactivity logout banner */}
            {inactivityLogout && (
              <div style={{ background: '#1e3a2f', border: '1px solid #059669', borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 13, color: '#6ee7b7', display: 'flex', gap: 8, alignItems: 'center' }}>
                🔐 You were logged out after 30 minutes of inactivity.
              </div>
            )}

            {/* Account lockout banner */}
            {lockoutUntil && (
              <div className="login-lockout-banner">
                <div className="login-lockout-icon">🔒</div>
                <div className="login-lockout-text">
                  <strong>Account Locked</strong>
                  <p>Too many failed attempts. Try again in:</p>
                  <div className="login-lockout-timer">{lockoutCountdown}</div>
                  <p style={{ fontSize: 12, marginTop: 6, color: '#9ca3af' }}>
                    Or{' '}
                    <a href="/reset-password" style={{ color: '#f59e0b', textDecoration: 'underline' }}>
                      reset your password
                    </a>{' '}
                    to regain access.
                  </p>
                </div>
              </div>
            )}

            {error && <div className="login-error">{error}</div>}

            {/* Attempts remaining warning */}
            {!isRegister && attemptsRemaining !== null && attemptsRemaining > 0 && (
              <div className="login-attempts-warning">
                {attemptsRemaining === 1
                  ? 'Warning: 1 attempt remaining before your account is locked for 24 hours.'
                  : `${attemptsRemaining} attempts remaining before lockout.`}
              </div>
            )}

            {/* Reset password hint after first failure */}
            {!isRegister && showReset && !lockoutUntil && (
              <p style={{ fontSize: 13, textAlign: 'center', marginTop: 4, marginBottom: 4 }}>
                Forgot your password?{' '}
                <a href="/reset-password" style={{ color: '#f59e0b', fontWeight: 600, textDecoration: 'underline' }}>
                  Reset Password
                </a>
              </p>
            )}

            <button type="submit" className="login-submit" disabled={loading || !!lockoutUntil}>
              {loading ? 'Please wait...' : isRegister ? 'Create Account' : otpRequired ? 'Verify & Sign In' : 'Sign In'}
            </button>

            {!isRegister && otpRequired && (
              <p style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center', marginTop: 8 }}>
                Didn't receive code?{' '}
                <span
                  onClick={resendCooldown > 0 ? undefined : handleResendOtp}
                  style={{
                    color: resendCooldown > 0 ? '#6b7280' : '#f59e0b',
                    cursor: resendCooldown > 0 ? 'default' : 'pointer',
                  }}
                >
                  {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Try again'}
                </span>
              </p>
            )}
          </form>

          <div className="login-divider">
            <span>or</span>
          </div>

          <button
            type="button"
            className="login-google-btn"
            onClick={() => {
              window.location.href = `${import.meta.env.VITE_API_URL || ''}/api/auth/google`;
            }}
          >
            <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
            {isRegister ? 'Sign up with Google' : 'Continue with Google'}
          </button>

          <p className="login-toggle" onClick={() => { setIsRegister(!isRegister); setError(''); setCodeSent(false); setAttemptsRemaining(null); setShowReset(false); setLockoutUntil(null); }}>
            {isRegister ? 'Already have an account? ' : "Don't have an account? "}
            <span>{isRegister ? 'Sign in' : 'Register'}</span>
          </p>
          </>
          )}
        </div>
      </div>
    </div>
  );
}
