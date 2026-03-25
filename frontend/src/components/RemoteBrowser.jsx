import { useState, useRef } from 'react';
import api from '../services/api';

const STEPS = {
  idle: { title: 'Connect Binance', color: '#6b7280' },
  starting: { title: 'Launching browser...', color: '#f59e0b' },
  email: { title: 'Step 1: Enter Email', color: '#3b82f6' },
  password: { title: 'Step 2: Enter Password', color: '#3b82f6' },
  captcha: { title: 'Step 3: Solve CAPTCHA', color: '#f59e0b' },
  '2fa': { title: 'Step 4: Verification Code', color: '#8b5cf6' },
  logged_in: { title: 'Login Successful!', color: '#10b981' },
  saving: { title: 'Saving session...', color: '#f59e0b' },
  done: { title: 'Binance Connected!', color: '#10b981' },
  error: { title: 'Error', color: '#ef4444' },
};

export default function RemoteBrowser({ onConnected, onClose }) {
  const [step, setStep] = useState('idle');
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code2fa, setCode2fa] = useState('');
  const [faType, setFaType] = useState('');
  const [screenshot, setScreenshot] = useState(null);
  const [loading, setLoading] = useState(false);
  const [cookieCount, setCookieCount] = useState(0);
  const imgRef = useRef(null);

  const callApi = async (endpoint, body = {}) => {
    setLoading(true);
    try {
      const res = await api.post(`/browser${endpoint}`, body);
      const data = res.data;

      if (data.screenshot) setScreenshot(data.screenshot);
      if (data.step) setStep(data.step);
      if (data.message) setMessage(data.message);
      if (data.fa_type) setFaType(data.fa_type);
      if (data.cookie_count) setCookieCount(data.cookie_count);

      return data;
    } catch (err) {
      const detail = err.response?.data?.detail || err.message;
      setMessage(detail);
      setStep('error');
      return null;
    } finally {
      setLoading(false);
    }
  };

  const handleStart = async () => {
    setStep('starting');
    setMessage('Launching secure browser...');
    setScreenshot(null);
    const data = await callApi('/login/start');
    if (data) {
      setStep(data.step);
      setMessage(data.message);
    }
  };

  const handleSubmitEmail = async (e) => {
    e.preventDefault();
    if (!email.trim()) return;
    await callApi('/login/email', { email: email.trim() });
  };

  const handleSubmitPassword = async (e) => {
    e.preventDefault();
    if (!password) return;
    await callApi('/login/password', { password });
    setPassword('');  // Clear password immediately
  };

  const handleSubmit2FA = async (e) => {
    e.preventDefault();
    if (!code2fa.trim()) return;
    await callApi('/login/2fa', { code: code2fa.trim() });
  };

  // Drag state for CAPTCHA slider
  const [dragStart, setDragStart] = useState(null);
  const [sliderOffset, setSliderOffset] = useState(0);

  const getScaledCoords = (e) => {
    if (!imgRef.current) return { x: 0, y: 0 };
    const rect = imgRef.current.getBoundingClientRect();
    return {
      x: Math.round((e.clientX - rect.left) * (1280 / rect.width)),
      y: Math.round((e.clientY - rect.top) * (800 / rect.height)),
    };
  };

  const handleCaptchaMouseDown = (e) => {
    e.preventDefault();
    const coords = getScaledCoords(e);
    setDragStart(coords);
    setSliderOffset(0);
  };

  const handleCaptchaMouseMove = (e) => {
    if (!dragStart) return;
    const coords = getScaledCoords(e);
    setSliderOffset(coords.x - dragStart.x);
  };

  const handleCaptchaMouseUp = async (e) => {
    if (!dragStart) return;
    const coords = getScaledCoords(e);
    const endX = coords.x;

    setLoading(true);
    await callApi('/login/captcha/drag', {
      start_x: dragStart.x,
      start_y: dragStart.y,
      end_x: endX,
      end_y: dragStart.y,
    });
    setDragStart(null);
    setSliderOffset(0);
    setLoading(false);
  };

  const handleCaptchaClick = async (e) => {
    const coords = getScaledCoords(e);
    await callApi('/login/captcha/click', { x: coords.x, y: coords.y });
  };

  const handleSave = async () => {
    setStep('saving');
    setMessage('Saving session...');
    const data = await callApi('/login/save');
    if (data) {
      setStep('done');
      setCookieCount(data.cookie_count || 0);
      if (onConnected) onConnected();
    }
  };

  const handleCancel = async () => {
    try { await api.post('/browser/login/cancel'); } catch (_) {}
    if (onClose) onClose();
  };

  const handleRefreshScreenshot = async () => {
    try {
      const res = await api.get('/browser/login/screenshot');
      if (res.data.screenshot) setScreenshot(res.data.screenshot);
    } catch (_) {}
  };

  const stepInfo = STEPS[step] || STEPS.idle;

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.9)', zIndex: 9999,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: '#1a1a2e', borderRadius: 16, width: '100%', maxWidth: 480,
        padding: 32, position: 'relative', maxHeight: '90vh', overflowY: 'auto',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 10, height: 10, borderRadius: '50%',
              background: stepInfo.color,
              boxShadow: `0 0 8px ${stepInfo.color}`,
            }} />
            <h3 style={{ margin: 0, color: '#fff', fontSize: 18 }}>{stepInfo.title}</h3>
          </div>
          <button onClick={handleCancel} style={{
            background: 'transparent', border: 'none', color: '#6b7280',
            fontSize: 20, cursor: 'pointer', padding: '4px 8px',
          }}>✕</button>
        </div>

        {message && (
          <div style={{
            padding: '10px 14px', borderRadius: 8, marginBottom: 16,
            background: step === 'error' ? 'rgba(239,68,68,0.1)' : 'rgba(59,130,246,0.1)',
            border: `1px solid ${step === 'error' ? '#ef4444' : '#3b82f6'}`,
            color: step === 'error' ? '#ef4444' : '#93c5fd',
            fontSize: 13,
          }}>
            {message}
          </div>
        )}

        {/* Step: idle — start button */}
        {step === 'idle' && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <p style={{ color: '#9ca3af', fontSize: 14, marginBottom: 20 }}>
              Log into your Binance account securely. Your credentials go directly to Binance — they are never stored.
            </p>
            <button onClick={handleStart} disabled={loading} style={{
              padding: '14px 40px', borderRadius: 10, border: 'none',
              background: '#f59e0b', color: '#000', fontWeight: 700,
              fontSize: 15, cursor: 'pointer', opacity: loading ? 0.6 : 1,
            }}>
              {loading ? 'Launching...' : 'Start Login'}
            </button>
          </div>
        )}

        {step === 'starting' && (
          <div style={{ textAlign: 'center', padding: '30px 0', color: '#9ca3af' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>&#9203;</div>
            Opening Binance login page...
          </div>
        )}

        {/* Step: email */}
        {step === 'email' && (
          <form onSubmit={handleSubmitEmail}>
            <label style={{ display: 'block', color: '#9ca3af', fontSize: 13, marginBottom: 6 }}>
              Binance Email or Phone
            </label>
            <input
              type="text"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              autoFocus
              style={{
                width: '100%', padding: '12px 14px', borderRadius: 8,
                border: '1px solid #374151', background: '#0f172a',
                color: '#fff', fontSize: 15, marginBottom: 16,
                boxSizing: 'border-box',
              }}
            />
            <button type="submit" disabled={loading || !email.trim()} style={{
              width: '100%', padding: '12px', borderRadius: 8, border: 'none',
              background: '#f59e0b', color: '#000', fontWeight: 600,
              fontSize: 14, cursor: 'pointer', opacity: loading ? 0.6 : 1,
            }}>
              {loading ? 'Submitting...' : 'Continue'}
            </button>
          </form>
        )}

        {/* Step: password */}
        {(step === 'password' || step === 'check') && (
          <form onSubmit={handleSubmitPassword}>
            <div style={{ color: '#9ca3af', fontSize: 13, marginBottom: 6 }}>
              Email: <strong style={{ color: '#fff' }}>{email}</strong>
            </div>
            <label style={{ display: 'block', color: '#9ca3af', fontSize: 13, marginBottom: 6, marginTop: 12 }}>
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Your Binance password"
              autoFocus
              style={{
                width: '100%', padding: '12px 14px', borderRadius: 8,
                border: '1px solid #374151', background: '#0f172a',
                color: '#fff', fontSize: 15, marginBottom: 16,
                boxSizing: 'border-box',
              }}
            />
            <button type="submit" disabled={loading || !password} style={{
              width: '100%', padding: '12px', borderRadius: 8, border: 'none',
              background: '#f59e0b', color: '#000', fontWeight: 600,
              fontSize: 14, cursor: 'pointer', opacity: loading ? 0.6 : 1,
            }}>
              {loading ? 'Logging in...' : 'Log In'}
            </button>
            <p style={{ fontSize: 11, color: '#4b5563', marginTop: 10, textAlign: 'center' }}>
              Your password is sent directly to Binance and is never stored.
            </p>
          </form>
        )}

        {/* Step: captcha */}
        {step === 'captcha' && (
          <div>
            <p style={{ color: '#9ca3af', fontSize: 13, marginBottom: 12 }}>
              Drag the puzzle slider to solve the CAPTCHA, or click on it.
            </p>
            {screenshot && (
              <img
                ref={imgRef}
                src={`data:image/jpeg;base64,${screenshot}`}
                onMouseDown={handleCaptchaMouseDown}
                onMouseMove={handleCaptchaMouseMove}
                onMouseUp={handleCaptchaMouseUp}
                onMouseLeave={() => { if (dragStart) { setDragStart(null); setSliderOffset(0); } }}
                onClick={handleCaptchaClick}
                draggable={false}
                style={{
                  width: '100%', borderRadius: 8,
                  cursor: dragStart ? 'grabbing' : 'grab',
                  border: '1px solid #374151',
                  userSelect: 'none',
                }}
                alt="CAPTCHA"
              />
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button onClick={handleRefreshScreenshot} disabled={loading} style={{
                flex: 1, padding: '10px', borderRadius: 8, border: '1px solid #374151',
                background: 'transparent', color: '#9ca3af', cursor: 'pointer', fontSize: 13,
              }}>
                {loading ? 'Processing...' : 'Refresh Screenshot'}
              </button>
            </div>
          </div>
        )}

        {/* Step: 2FA */}
        {step === '2fa' && (
          <form onSubmit={handleSubmit2FA}>
            <p style={{ color: '#9ca3af', fontSize: 13, marginBottom: 12 }}>
              {faType === 'authenticator' && 'Enter the 6-digit code from your Authenticator app.'}
              {faType === 'sms' && 'Enter the verification code sent to your phone.'}
              {faType === 'email' && 'Enter the verification code sent to your email.'}
              {!faType && 'Enter your verification code.'}
            </p>
            {screenshot && (
              <img
                src={`data:image/jpeg;base64,${screenshot}`}
                style={{
                  width: '100%', borderRadius: 8, marginBottom: 12,
                  border: '1px solid #374151',
                }}
                alt="2FA prompt"
              />
            )}
            <input
              type="text"
              value={code2fa}
              onChange={(e) => setCode2fa(e.target.value)}
              placeholder="Enter 6-digit code"
              maxLength={6}
              autoFocus
              style={{
                width: '100%', padding: '14px', borderRadius: 8,
                border: '1px solid #374151', background: '#0f172a',
                color: '#fff', fontSize: 24, textAlign: 'center',
                letterSpacing: '0.5em', marginBottom: 16,
                boxSizing: 'border-box',
              }}
            />
            <button type="submit" disabled={loading || code2fa.length < 6} style={{
              width: '100%', padding: '12px', borderRadius: 8, border: 'none',
              background: '#8b5cf6', color: '#fff', fontWeight: 600,
              fontSize: 14, cursor: 'pointer', opacity: loading ? 0.6 : 1,
            }}>
              {loading ? 'Verifying...' : 'Verify'}
            </button>
          </form>
        )}

        {/* Step: logged_in — save button */}
        {step === 'logged_in' && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ fontSize: 48, marginBottom: 12, color: '#10b981' }}>&#10003;</div>
            <p style={{ color: '#d1d5db', fontSize: 15, marginBottom: 4 }}>
              Successfully logged into Binance!
            </p>
            <p style={{ color: '#6b7280', fontSize: 13, marginBottom: 24 }}>
              {cookieCount > 0 ? `${cookieCount} session cookies captured.` : 'Session ready to save.'}
            </p>
            <button onClick={handleSave} disabled={loading} style={{
              width: '100%', padding: '14px', borderRadius: 10, border: 'none',
              background: '#10b981', color: '#fff', fontWeight: 700,
              fontSize: 15, cursor: 'pointer', opacity: loading ? 0.6 : 1,
            }}>
              {loading ? 'Saving...' : 'Save & Activate Bot'}
            </button>
          </div>
        )}

        {/* Step: done */}
        {step === 'done' && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ fontSize: 48, marginBottom: 12, color: '#10b981' }}>&#10003;</div>
            <p style={{ color: '#10b981', fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
              Binance Connected!
            </p>
            <p style={{ color: '#9ca3af', fontSize: 13, marginBottom: 24 }}>
              {cookieCount} cookies saved. Your trading bot is ready to run 24/7.
            </p>
            <button onClick={handleCancel} style={{
              width: '100%', padding: '14px', borderRadius: 10, border: 'none',
              background: '#10b981', color: '#fff', fontWeight: 600,
              fontSize: 14, cursor: 'pointer',
            }}>
              Done
            </button>
          </div>
        )}

        {/* Step: unknown — show screenshot */}
        {step === 'unknown' && screenshot && (
          <div>
            <p style={{ color: '#f59e0b', fontSize: 13, marginBottom: 12 }}>
              Unexpected page. See screenshot below:
            </p>
            <img
              src={`data:image/jpeg;base64,${screenshot}`}
              style={{ width: '100%', borderRadius: 8, border: '1px solid #374151' }}
              alt="Page screenshot"
            />
            <button onClick={handleRefreshScreenshot} style={{
              marginTop: 12, width: '100%', padding: '10px', borderRadius: 8,
              border: '1px solid #374151', background: 'transparent',
              color: '#9ca3af', cursor: 'pointer', fontSize: 13,
            }}>
              Refresh
            </button>
          </div>
        )}

        {/* Error — retry */}
        {step === 'error' && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <button onClick={handleStart} style={{
              padding: '12px 30px', borderRadius: 8, border: 'none',
              background: '#f59e0b', color: '#000', fontWeight: 600,
              cursor: 'pointer', fontSize: 14,
            }}>
              Try Again
            </button>
          </div>
        )}

        {/* Loading indicator */}
        {step === 'saving' && (
          <div style={{ textAlign: 'center', padding: '30px 0', color: '#9ca3af' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>&#9203;</div>
            Saving your session...
          </div>
        )}
      </div>
    </div>
  );
}
