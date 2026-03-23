import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';

export default function AdminLogin() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { loginUser } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await api.post('/admin/login', { password });
      loginUser(res.data.access_token, {
        id: res.data.trader_id,
        full_name: res.data.full_name,
        is_admin: true,
      });
      navigate('/admin');
    } catch (err) {
      setError(err.response?.data?.detail || 'Invalid password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="admin-login-page">
      <div className="admin-login-card">
        <img src="/logo.png" alt="SparkP2P" className="admin-login-logo" />
        <h1>Admin Panel</h1>
        <p className="admin-login-sub">Enter admin password to continue</p>

        <form onSubmit={handleSubmit}>
          <div className="login-field">
            <label>Password</label>
            <input
              type="password"
              placeholder="Admin password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
            />
          </div>

          {error && <div className="login-error">{error}</div>}

          <button type="submit" className="login-submit" disabled={loading}>
            {loading ? 'Authenticating...' : 'Access Admin'}
          </button>
        </form>
      </div>
    </div>
  );
}
