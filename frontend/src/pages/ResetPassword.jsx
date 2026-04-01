import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { requestPasswordReset, confirmPasswordReset } from '../services/api';

const PASSWORD_RULES = [
  { label: 'At least 8 characters', test: (p) => p.length >= 8 },
  { label: '2 uppercase letters', test: (p) => (p.match(/[A-Z]/g) || []).length >= 2 },
  { label: '2 lowercase letters', test: (p) => (p.match(/[a-z]/g) || []).length >= 2 },
  { label: '2 numbers', test: (p) => (p.match(/[0-9]/g) || []).length >= 2 },
  { label: '2 special characters (!@#$%...)', test: (p) => (p.match(/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/g) || []).length >= 2 },
];

export default function ResetPassword() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1); // 1=email, 2=otp+newpw, 3=done
  const [email, setEmail] = useState('');
  const [phoneHint, setPhoneHint] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleRequestOtp = async (e) => {
    e.preventDefault();
    if (!email) return;
    setLoading(true);
    setError('');
    try {
      const res = await requestPasswordReset(email);
      setPhoneHint(res.data.phone_hint || '');
      setStep(2);
    } catch (err) {
      const detail = err.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : 'Failed to send OTP. Try again.');
    }
    setLoading(false);
  };

  const handleConfirm = async (e) => {
    e.preventDefault();
    setError('');

    const failedRules = PASSWORD_RULES.filter((r) => !r.test(newPassword));
    if (failedRules.length > 0) {
      setError(`Password missing: ${failedRules.map((r) => r.label).join(', ')}`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    try {
      await confirmPasswordReset(email, otpCode, newPassword);
      setStep(3);
    } catch (err) {
      const detail = err.response?.data?.detail;
      if (Array.isArray(detail)) {
        setError(detail.map((d) => d.msg).join('. '));
      } else {
        setError(typeof detail === 'string' ? detail : detail?.message || 'Something went wrong');
      }
    }
    setLoading(false);
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
        <Link to="/login" className="login-back-home">Back to Sign In</Link>
        <div className="login-right-inner">

          {step === 1 && (
            <>
              <h1>Reset Password</h1>
              <p className="login-right-sub">
                Enter your registered email. We'll send a one-time code to your linked phone number.
              </p>
              {error && <div className="login-error">{error}</div>}
              <form onSubmit={handleRequestOtp}>
                <div className="login-field">
                  <label>Email Address</label>
                  <input
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoFocus
                  />
                </div>
                <button type="submit" className="login-submit" disabled={loading || !email}>
                  {loading ? 'Sending...' : 'Send OTP to Phone'}
                </button>
              </form>
            </>
          )}

          {step === 2 && (
            <>
              <h1>Verify & Set New Password</h1>
              <p className="login-right-sub">
                Enter the code sent to <strong>{phoneHint || 'your phone'}</strong> and choose a new password.
              </p>
              {error && <div className="login-error">{error}</div>}
              <form onSubmit={handleConfirm}>
                <div className="login-field">
                  <label>OTP Code</label>
                  <input
                    type="text"
                    placeholder="Enter 6-digit code"
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value)}
                    maxLength={6}
                    autoFocus
                    required
                  />
                  <span className="login-field-hint">
                    Code sent to {phoneHint}{' '}
                    <span
                      style={{ color: '#f59e0b', cursor: 'pointer', textDecoration: 'underline' }}
                      onClick={async () => {
                        setError('');
                        try {
                          const res = await requestPasswordReset(email);
                          setPhoneHint(res.data.phone_hint || phoneHint);
                        } catch {}
                      }}
                    >
                      Resend
                    </span>
                  </span>
                </div>

                <div className="login-field">
                  <label>New Password</label>
                  <div className="login-field-with-btn">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      placeholder="Create a strong password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      required
                    />
                    <button type="button" className="login-toggle-pw" onClick={() => setShowPassword(!showPassword)}>
                      {showPassword ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </div>

                {newPassword && (
                  <div className="password-rules">
                    {PASSWORD_RULES.map((rule, i) => (
                      <div key={i} className={`pw-rule ${rule.test(newPassword) ? 'pass' : 'fail'}`}>
                        <span className="pw-rule-icon">{rule.test(newPassword) ? '✓' : '✗'}</span>
                        {rule.label}
                      </div>
                    ))}
                  </div>
                )}

                <div className="login-field">
                  <label>Confirm New Password</label>
                  <input
                    type="password"
                    placeholder="Re-enter your new password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                  />
                  {confirmPassword && newPassword !== confirmPassword && (
                    <span className="login-field-error">Passwords do not match</span>
                  )}
                </div>

                <button
                  type="submit"
                  className="login-submit"
                  disabled={loading || !otpCode || !newPassword || newPassword !== confirmPassword}
                >
                  {loading ? 'Saving...' : 'Reset Password'}
                </button>

                <p style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center', marginTop: 8 }}>
                  Remembered it?{' '}
                  <Link to="/login" style={{ color: '#f59e0b' }}>Sign in instead</Link>
                </p>
              </form>
            </>
          )}

          {step === 3 && (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
              <h1 style={{ marginBottom: 8 }}>Password Reset!</h1>
              <p className="login-right-sub">
                Your password has been updated successfully. You can now sign in with your new password.
              </p>
              <button className="login-submit" style={{ marginTop: 24 }} onClick={() => navigate('/login')}>
                Go to Sign In
              </button>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
