import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { login, register } from '../services/api';

export default function Login() {
  const [isRegister, setIsRegister] = useState(false);
  const [form, setForm] = useState({ email: '', password: '', full_name: '', phone: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { loginUser } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = isRegister
        ? await register(form)
        : await login(form.email, form.password);

      loginUser(res.data.access_token, {
        id: res.data.trader_id,
        full_name: res.data.full_name,
      });
      navigate('/dashboard');
    } catch (err) {
      setError(err.response?.data?.detail || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-split">
      {/* Left side — branding */}
      <div className="login-left">
        <Link to="/" className="login-left-brand">
          <img src="/logo.png" alt="SparkP2P" className="login-left-logo" />
          <span className="login-left-name">SparkP2P</span>
        </Link>
        <div className="login-left-content">
          <h2>Automate Your<br />Binance P2P Trading</h2>
          <p>Payments verified. Crypto released. All on autopilot.</p>
        </div>
        {/* Decorative shapes */}
        <div className="login-left-decor">
          <div className="login-decor-circle login-decor-c1"></div>
          <div className="login-decor-circle login-decor-c2"></div>
          <div className="login-decor-circle login-decor-c3"></div>
          <div className="login-decor-grid"></div>
        </div>
        <div className="login-left-footer">Powered by Spark AI</div>
      </div>

      {/* Right side — form */}
      <div className="login-right">
        <div className="login-right-inner">
          <h1>{isRegister ? 'Create Account' : 'Welcome to SparkP2P'}</h1>
          <p className="login-right-sub">
            {isRegister ? 'Register to start automating your trades' : 'Sign in to your account'}
          </p>

          <form onSubmit={handleSubmit}>
            {isRegister && (
              <>
                <div className="login-field">
                  <label>Full Name</label>
                  <input
                    type="text"
                    placeholder="John Doe"
                    value={form.full_name}
                    onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                    required
                  />
                </div>
                <div className="login-field">
                  <label>Phone Number</label>
                  <input
                    type="tel"
                    placeholder="0712345678"
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    required
                  />
                </div>
              </>
            )}
            <div className="login-field">
              <label>Email Address</label>
              <input
                type="email"
                placeholder="you@example.com"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                required
              />
            </div>
            <div className="login-field">
              <label>Password</label>
              <input
                type="password"
                placeholder="Enter your password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                required
              />
            </div>

            {error && <div className="login-error">{error}</div>}

            <button type="submit" className="login-submit" disabled={loading}>
              {loading ? 'Please wait...' : isRegister ? 'Create Account' : 'Sign In'}
            </button>
          </form>

          <p className="login-toggle" onClick={() => setIsRegister(!isRegister)}>
            {isRegister ? 'Already have an account? ' : "Don't have an account? "}
            <span>{isRegister ? 'Sign in' : 'Register'}</span>
          </p>
        </div>
      </div>
    </div>
  );
}
