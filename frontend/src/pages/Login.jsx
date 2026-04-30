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
    first_name: '', last_name: '', email: localStorage.getItem('remembered_email') || '', phone: '', password: '', confirm_password: '', email_code: '',
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
  const [resendCount, setResendCount] = useState(0);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [showTermsModal, setShowTermsModal] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [rememberMe, setRememberMe] = useState(() => !!localStorage.getItem('remembered_email'));
  const [googleProfile, setGoogleProfile] = useState(null); // {token, name, id, role} — needs phone+KYC
  const [profileForm, setProfileForm] = useState({ full_name: '', phone: '' });
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileOtpSent, setProfileOtpSent] = useState(false);
  const [profileOtpCode, setProfileOtpCode] = useState('');
  const [sendingProfileOtp, setSendingProfileOtp] = useState(false);
  const [profilePhoneHint, setProfilePhoneHint] = useState('');
  const [profileOtpCooldown, setProfileOtpCooldown] = useState(0);
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

  const handleSendProfileOtp = async () => {
    if (!profileForm.phone) { setError('Enter your phone number first'); return; }
    if (!/^(07|01|2547|2541)\d{7,8}$/.test(profileForm.phone.replace(/\s/g, ''))) {
      setError('Enter a valid Kenyan phone number (e.g., 0712345678)');
      return;
    }
    setSendingProfileOtp(true);
    setError('');
    try {
      const res = await fetch('/api/traders/send-profile-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleProfile.token}` },
        body: JSON.stringify({ phone: profileForm.phone }),
      });
      const data = await res.json();
      if (res.ok) {
        setProfileOtpSent(true);
        setProfilePhoneHint(data.phone_hint || '');
        setProfileOtpCode('');
        setProfileOtpCooldown(30);
        const interval = setInterval(() => {
          setProfileOtpCooldown(prev => {
            if (prev <= 1) { clearInterval(interval); return 0; }
            return prev - 1;
          });
        }, 1000);
      } else {
        setError(data.detail || 'Failed to send OTP');
      }
    } catch {
      setError('Network error');
    }
    setSendingProfileOtp(false);
  };

  const handleCompleteProfile = async (e) => {
    e.preventDefault();
    if (!profileForm.full_name || !profileForm.phone) {
      setError('Full name and phone number are required');
      return;
    }
    if (!profileOtpSent) {
      setError('Please verify your phone number first');
      return;
    }
    if (!profileOtpCode) {
      setError('Enter the OTP sent to your phone');
      return;
    }
    setSavingProfile(true);
    setError('');
    try {
      const res = await fetch('/api/traders/complete-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleProfile.token}` },
        body: JSON.stringify({ full_name: profileForm.full_name.toUpperCase(), phone: profileForm.phone, otp_code: profileOtpCode }),
      });
      if (res.ok) {
        loginUser(googleProfile.token, { id: googleProfile.id, full_name: profileForm.full_name, role: googleProfile.role });
        navigate('/dashboard');
      } else {
        const data = await res.json();
        setError(data.detail || 'Failed to save profile');
      }
    } catch {
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

  const handleResendOtp = async () => {
    if (resendCooldown > 0) return;
    setError('');
    try {
      await login(form.email, form.password);
      setOtpCode('');
      setError('');
      setResendCount(prev => prev + 1);
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

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (isRegister) {
      if (!agreedToTerms) {
        setError('You must read and agree to the Terms & Conditions to create an account.');
        return;
      }
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
          setResendCount(0);
          setError('');
        } else {
          // Step 2: OTP verified, got token
          const role = res.data.role || 'trader';
          if (rememberMe) localStorage.setItem('remembered_email', form.email);
          else localStorage.removeItem('remembered_email');
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
      {/* Mobile-only hero panel */}
      <div className="login-mobile-hero">
        <Link to="/" className="login-mobile-hero-brand">
          <img src="/logo.png" alt="SparkP2P" style={{ width: 36, height: 36, borderRadius: 9, objectFit: 'contain' }} />
          <span>SparkP2P</span>
        </Link>
        <div className="login-mobile-hero-content">
          <h1>Automate Your<br />Binance P2P Trading</h1>
          <p>Payments verified. Crypto released. All on autopilot.</p>
        </div>
      </div>

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
                  <div className="login-field-with-btn">
                    <input
                      type="tel"
                      placeholder="0712345678"
                      value={profileForm.phone}
                      onChange={(e) => { setProfileForm({ ...profileForm, phone: e.target.value }); setProfileOtpSent(false); setProfileOtpCode(''); }}
                      required
                      disabled={profileOtpSent}
                    />
                    <button
                      type="button"
                      className="login-send-code-btn"
                      onClick={handleSendProfileOtp}
                      disabled={sendingProfileOtp || profileOtpCooldown > 0}
                    >
                      {sendingProfileOtp ? 'Sending...' : profileOtpCooldown > 0 ? `Resend (${profileOtpCooldown}s)` : profileOtpSent ? 'Resend OTP' : 'Send OTP'}
                    </button>
                  </div>
                  {profileOtpSent && <span className="login-field-hint">OTP sent to {profilePhoneHint}</span>}
                </div>

                {profileOtpSent && (
                  <div className="login-field">
                    <label>OTP Code</label>
                    <input
                      type="text"
                      placeholder="Enter 6-digit OTP"
                      value={profileOtpCode}
                      onChange={(e) => setProfileOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      maxLength={6}
                      inputMode="numeric"
                      autoFocus
                      required
                    />
                    <span className="login-field-hint">Enter the code sent to your Safaricom number</span>
                  </div>
                )}

                <button type="submit" disabled={savingProfile || !profileOtpSent} className="login-submit">
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

                {/* Terms & Conditions checkbox */}
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, margin: '14px 0 4px' }}>
                  <input
                    type="checkbox"
                    id="agree-terms"
                    checked={agreedToTerms}
                    onChange={e => setAgreedToTerms(e.target.checked)}
                    style={{ marginTop: 3, width: 16, height: 16, accentColor: '#f59e0b', cursor: 'pointer', flexShrink: 0 }}
                  />
                  <label htmlFor="agree-terms" style={{ fontSize: 13, color: '#6b7280', cursor: 'pointer', userSelect: 'none', lineHeight: 1.5 }}>
                    I have read and agree to the{' '}
                    <span
                      onClick={e => { e.preventDefault(); setShowTermsModal(true); }}
                      style={{ color: '#f59e0b', textDecoration: 'underline', cursor: 'pointer', fontWeight: 600 }}
                    >
                      Terms & Conditions
                    </span>
                    {' '}and acknowledge all risks associated with automated P2P trading.
                  </label>
                </div>
              </>
            )}

            {/* Remember Me */}
            {!isRegister && !otpRequired && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 12px' }}>
                <input
                  type="checkbox"
                  id="remember-me"
                  checked={rememberMe}
                  onChange={e => setRememberMe(e.target.checked)}
                  style={{ width: 16, height: 16, accentColor: '#f59e0b', cursor: 'pointer' }}
                />
                <label htmlFor="remember-me" style={{ fontSize: 13, color: '#6b7280', cursor: 'pointer', userSelect: 'none' }}>
                  Remember me
                </label>
              </div>
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
                  SMS code sent to {phoneHint}. You can also enter your <strong>Google Authenticator</strong> code in the same box above.
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

            {!isRegister && otpRequired && resendCount >= 2 && (
              <div style={{
                background: '#1c1f2e',
                border: '1px solid rgba(245,158,11,0.4)',
                borderRadius: 10,
                padding: '12px 14px',
                marginTop: 4,
                display: 'flex',
                gap: 10,
                alignItems: 'flex-start',
              }}>
                <span style={{ fontSize: 18, lineHeight: 1 }}>🔐</span>
                <div>
                  <p style={{ fontSize: 13, color: '#f59e0b', fontWeight: 600, marginBottom: 3 }}>
                    Still no code? Use Google Authenticator
                  </p>
                  <p style={{ fontSize: 12, color: '#9ca3af', margin: 0 }}>
                    Open your Authenticator app, find <strong style={{ color: '#d1d5db' }}>SparkP2P</strong>, and enter the 6-digit code above instead.
                  </p>
                </div>
              </div>
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

      {/* Terms & Conditions Modal */}
      {showTermsModal && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 9999,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
          }}
          onClick={() => setShowTermsModal(false)}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#111827', border: '1px solid #374151', borderRadius: 16,
              maxWidth: 680, width: '100%', maxHeight: '88vh', display: 'flex', flexDirection: 'column',
              boxShadow: '0 25px 60px rgba(0,0,0,0.6)',
            }}
          >
            {/* Header */}
            <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid #1f2937', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 18, color: '#f9fafb', fontWeight: 700 }}>Terms & Conditions</h2>
                <p style={{ margin: '4px 0 0', fontSize: 12, color: '#6b7280' }}>SparkP2P Automated P2P Trading Platform — Last updated: April 2026</p>
              </div>
              <button onClick={() => setShowTermsModal(false)} style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: 22, cursor: 'pointer', lineHeight: 1, padding: 4 }}>×</button>
            </div>

            {/* Scrollable body */}
            <div style={{ overflowY: 'auto', padding: '20px 24px', flex: 1, fontSize: 13.5, color: '#d1d5db', lineHeight: 1.75 }}>

              <p style={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 10, padding: '12px 16px', color: '#f59e0b', fontSize: 13, marginBottom: 20 }}>
                <strong>IMPORTANT:</strong> Please read these Terms carefully before creating an account. By registering, you agree to be legally bound by these Terms. If you do not agree, do not create an account.
              </p>

              <Section title="1. Acceptance of Terms">
                By accessing or using SparkP2P ("the Platform", "we", "our", "us"), you confirm that you are at least 18 years of age, have legal capacity to enter into binding contracts, and agree to be bound by these Terms & Conditions ("Terms"), our Privacy Policy, and all applicable laws and regulations of the Republic of Kenya. These Terms constitute a legally binding agreement between you ("User", "you") and SparkP2P.
              </Section>

              <Section title="2. Account Security & Unauthorized Access">
                <strong>You are solely responsible for the security of your SparkP2P account.</strong> SparkP2P shall not be liable for any losses, damages, trades executed, or funds transferred as a result of unauthorized access to your account by any third party, including but not limited to:
                <ul style={{ paddingLeft: 20, marginTop: 8 }}>
                  <li>Sharing your login credentials with another person (knowingly or unknowingly)</li>
                  <li>Allowing a friend, family member, colleague, or any third party to use your account</li>
                  <li>Failing to log out of your account on a shared or public device</li>
                  <li>Weak or reused passwords that allow unauthorized access</li>
                  <li>Account takeover as a result of phishing, social engineering, or other external attacks on you personally</li>
                </ul>
                You agree to immediately notify us at support@sparkp2p.com if you suspect unauthorized access. Any trades or transactions that occur before we can suspend the account remain your sole responsibility.
              </Section>

              <Section title="3. No Password Storage on Our Servers">
                SparkP2P does <strong>not</strong> store your Binance account password, M-Pesa PIN, banking PINs, or any other external account credentials on our servers. The SparkP2P platform authenticates via session cookies/tokens provided by your browser's interaction with Binance. We have no access to your financial institution credentials at any time. You are responsible for maintaining the security of all credentials you use in connection with our platform.
              </Section>

              <Section title="4. Stolen or Lost Device">
                If your device (computer, phone, or any other hardware) is stolen, lost, or accessed by an unauthorized person, SparkP2P <strong>will not be liable</strong> for any financial losses, unauthorized trades, or unauthorized account access that results therefrom. You are strongly advised to:
                <ul style={{ paddingLeft: 20, marginTop: 8 }}>
                  <li>Enable full-disk encryption on your device</li>
                  <li>Use a strong device PIN, password, or biometric lock</li>
                  <li>Never save your SparkP2P password in an unsecured location on your device</li>
                  <li>Enable Google Authenticator (TOTP) as a second factor on your SparkP2P account</li>
                  <li>Contact us immediately at support@sparkp2p.com to suspend your account if your device is stolen</li>
                </ul>
              </Section>

              <Section title="5. Trading Losses & Financial Risk">
                Peer-to-peer cryptocurrency trading involves <strong>substantial financial risk</strong>. SparkP2P is an automation tool and does not provide financial advice, investment advice, or trading recommendations. You acknowledge and accept that:
                <ul style={{ paddingLeft: 20, marginTop: 8 }}>
                  <li>Cryptocurrency markets are highly volatile and prices may change rapidly</li>
                  <li>You may lose some or all of the funds involved in your P2P trades</li>
                  <li>SparkP2P is not responsible for any trading losses, missed opportunities, or adverse market movements</li>
                  <li>The platform automates the payment verification and release process; it does not guarantee profitability or the suitability of any trade</li>
                  <li>You are solely responsible for the trading decisions you make on Binance P2P</li>
                  <li>Any prices, spreads, or profit projections we display are illustrative only and not guaranteed</li>
                </ul>
              </Section>

              <Section title="6. Bot Automation & Technical Risks">
                SparkP2P automates actions on the Binance P2P platform on your behalf. By using our automation features, you acknowledge that:
                <ul style={{ paddingLeft: 20, marginTop: 8 }}>
                  <li>Automated bots may malfunction, encounter errors, or fail to execute due to changes in third-party website structures, internet connectivity issues, or software bugs</li>
                  <li>SparkP2P shall not be liable for failed, missed, or incorrectly executed transactions caused by automation errors, system downtime, or API failures</li>
                  <li>Binance P2P may modify its platform at any time, which may temporarily or permanently affect our bot's functionality</li>
                  <li>You are responsible for monitoring your active trades and ensuring funds are appropriately managed</li>
                  <li>Running automation bots may violate Binance's Terms of Service; you accept all risks and consequences associated with this, and SparkP2P takes no responsibility for any account suspension or ban by Binance</li>
                  <li>You are responsible for ensuring sufficient float (crypto balance) for your configured trade orders</li>
                </ul>
              </Section>

              <Section title="7. Third-Party Services">
                SparkP2P integrates with and relies on third-party services including but not limited to Binance, M-Pesa (Safaricom), I&M Bank, and other payment providers. SparkP2P is <strong>not affiliated with</strong> and <strong>not endorsed by</strong> any of these companies. We are not liable for:
                <ul style={{ paddingLeft: 20, marginTop: 8 }}>
                  <li>Downtime, outages, or changes to Binance P2P, M-Pesa, or banking services</li>
                  <li>Payment delays, reversals, or failures caused by M-Pesa, banks, or other payment processors</li>
                  <li>Actions taken by Binance against your account, including freezes, bans, or trade cancellations</li>
                  <li>Any fees charged by third-party payment processors</li>
                  <li>Changes to Binance's P2P policies that affect your trading</li>
                </ul>
              </Section>

              <Section title="8. No Financial or Investment Advice">
                Nothing on the SparkP2P platform constitutes financial advice, investment advice, trading advice, or any other kind of advice. We do not recommend any specific cryptocurrency, trading strategy, or P2P ad configuration. All decisions are made entirely at your own discretion and risk. You should seek independent financial advice if you are uncertain about any trading decision.
              </Section>

              <Section title="9. Service Availability & Modifications">
                SparkP2P does not guarantee uninterrupted or error-free service. We reserve the right to:
                <ul style={{ paddingLeft: 20, marginTop: 8 }}>
                  <li>Modify, suspend, or discontinue the platform (or any feature) at any time, with or without notice</li>
                  <li>Change subscription pricing with reasonable advance notice to registered users</li>
                  <li>Perform scheduled or emergency maintenance that may temporarily interrupt service</li>
                </ul>
                We shall not be liable for any loss or damage arising from service interruptions, modifications, or discontinuation.
              </Section>

              <Section title="10. Subscription & Refund Policy">
                SparkP2P operates on a subscription basis. Subscriptions are charged in advance and are <strong>non-refundable</strong> except where required by applicable Kenyan consumer protection law. If you believe you are entitled to a refund, contact us within 7 days of the charge at support@sparkp2p.com. We reserve the right to suspend or terminate your subscription for violation of these Terms without refund.
              </Section>

              <Section title="11. Account Termination">
                SparkP2P reserves the right to suspend or permanently terminate your account at any time, without notice, if you:
                <ul style={{ paddingLeft: 20, marginTop: 8 }}>
                  <li>Violate any provision of these Terms</li>
                  <li>Engage in fraudulent, abusive, or illegal activity through the platform</li>
                  <li>Attempt to reverse-engineer, scrape, or exploit the platform</li>
                  <li>Fail to pay subscription fees when due</li>
                  <li>Pose a security or legal risk to SparkP2P or other users</li>
                </ul>
                Upon termination, your right to access the platform ceases immediately. Any active trades remain your responsibility to manage manually.
              </Section>

              <Section title="12. Limitation of Liability">
                To the maximum extent permitted by applicable law, SparkP2P, its directors, employees, agents, and affiliates shall <strong>not be liable</strong> for any:
                <ul style={{ paddingLeft: 20, marginTop: 8 }}>
                  <li>Direct, indirect, incidental, special, consequential, or punitive damages</li>
                  <li>Loss of profits, revenue, data, goodwill, or other intangible losses</li>
                  <li>Damages arising from unauthorized account access, stolen devices, third-party failures, or automation errors</li>
                  <li>Any amount exceeding the total subscription fees you paid to SparkP2P in the 3 months preceding the claim</li>
                </ul>
                These limitations apply regardless of the theory of liability (contract, tort, negligence, or otherwise) and even if SparkP2P has been advised of the possibility of such damages.
              </Section>

              <Section title="13. Indemnification">
                You agree to indemnify, defend, and hold harmless SparkP2P and its officers, directors, employees, and agents from and against any claims, liabilities, damages, judgments, awards, losses, costs, and expenses (including legal fees) arising out of or relating to:
                <ul style={{ paddingLeft: 20, marginTop: 8 }}>
                  <li>Your use or misuse of the platform</li>
                  <li>Your violation of these Terms</li>
                  <li>Your violation of any applicable law or regulation</li>
                  <li>Any unauthorized access to your account that you failed to prevent or report</li>
                  <li>Any third-party claims arising from your P2P trading activities</li>
                </ul>
              </Section>

              <Section title="14. Data Protection & Privacy">
                SparkP2P collects and processes personal data (name, email, phone number) solely for the purpose of providing the platform's services. We do not sell your personal data to third parties. Data is stored securely and in accordance with applicable Kenyan data protection legislation, including the Data Protection Act, 2019. For full details, refer to our Privacy Policy. By registering, you consent to the collection and processing of your personal data as described.
              </Section>

              <Section title="15. Governing Law & Dispute Resolution">
                These Terms shall be governed by and construed in accordance with the laws of the <strong>Republic of Kenya</strong>. Any disputes arising from or in connection with these Terms shall first be attempted to be resolved through good-faith negotiation. If unresolved within 30 days, disputes shall be subject to the exclusive jurisdiction of the courts of Nairobi, Kenya. You waive any right to a jury trial or class action proceedings to the maximum extent permitted by law.
              </Section>

              <Section title="16. Amendments to Terms">
                SparkP2P reserves the right to update or modify these Terms at any time. Material changes will be communicated via email or a notice on the platform at least 7 days before taking effect. Your continued use of the platform after such notice constitutes acceptance of the revised Terms. If you do not agree to the revised Terms, you must stop using the platform and contact us to close your account.
              </Section>

              <Section title="17. Entire Agreement">
                These Terms, together with our Privacy Policy, constitute the entire agreement between you and SparkP2P with respect to the platform and supersede all prior agreements, representations, and understandings. If any provision of these Terms is found to be invalid or unenforceable, the remaining provisions shall continue in full force and effect.
              </Section>

              <p style={{ marginTop: 24, padding: '12px 16px', background: '#1f2937', borderRadius: 10, fontSize: 12, color: '#9ca3af', border: '1px solid #374151' }}>
                For questions about these Terms, contact us at <strong style={{ color: '#d1d5db' }}>support@sparkp2p.com</strong>. SparkP2P is operated in Nairobi, Kenya.
              </p>
            </div>

            {/* Footer */}
            <div style={{ padding: '16px 24px', borderTop: '1px solid #1f2937', display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowTermsModal(false)}
                style={{ padding: '10px 20px', borderRadius: 10, border: '1px solid #374151', background: 'transparent', color: '#9ca3af', fontSize: 14, cursor: 'pointer' }}
              >
                Close
              </button>
              <button
                onClick={() => { setAgreedToTerms(true); setShowTermsModal(false); }}
                style={{ padding: '10px 24px', borderRadius: 10, border: 'none', background: '#f59e0b', color: '#000', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
              >
                I Agree
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h3 style={{ color: '#f9fafb', fontSize: 14, fontWeight: 700, marginBottom: 8, marginTop: 0 }}>{title}</h3>
      <div style={{ color: '#d1d5db' }}>{children}</div>
    </div>
  );
}
