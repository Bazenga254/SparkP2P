import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
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
  const { loginUser } = useAuth();
  const navigate = useNavigate();

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
      if (Array.isArray(detail)) {
        setError(detail.map((d) => d.msg).join('. '));
      } else {
        setError(detail || 'Something went wrong');
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
                    placeholder="BONITO CHELUGET SAMOEI"
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

            {error && <div className="login-error">{error}</div>}

            <button type="submit" className="login-submit" disabled={loading}>
              {loading ? 'Please wait...' : isRegister ? 'Create Account' : otpRequired ? 'Verify & Sign In' : 'Sign In'}
            </button>

            {!isRegister && otpRequired && (
              <p style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center', marginTop: 8, cursor: 'pointer' }}
                onClick={() => { setOtpRequired(false); setOtpCode(''); setError(''); }}>
                Didn't receive code? <span style={{ color: '#f59e0b' }}>Try again</span>
              </p>
            )}
          </form>

          <p className="login-toggle" onClick={() => { setIsRegister(!isRegister); setError(''); setCodeSent(false); }}>
            {isRegister ? 'Already have an account? ' : "Don't have an account? "}
            <span>{isRegister ? 'Sign in' : 'Register'}</span>
          </p>
        </div>
      </div>
    </div>
  );
}
