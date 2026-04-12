import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { updateSettlement, updateTradingConfig, updateProfile, setSecurityQuestion, requestChangePasswordOtp, changePassword, getProfile, updateVerification, getTotpSetup, verifyAndSaveTotp, removeTotp } from '../services/api';
import { QRCodeSVG } from 'qrcode.react';
import api from '../services/api';
import RemoteBrowser from './RemoteBrowser';

// Request OTP for settlement change
const requestSettlementOTP = () => api.post('/traders/settlement/request-otp');

const BANK_PAYBILLS = {
  KCB: '522522',
  Equity: '247247',
  'Co-op': '400200',
  'I&M': '542542',
  Stanbic: '600100',
  NCBA: '880100',
  'Family Bank': '222111',
  Absa: '303030',
};

export default function SettingsPanel({ profile, onUpdate }) {
  const navigate = useNavigate();
  const [activeSection, setActiveSection] = useState('binance');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [connecting, setConnecting] = useState(false);
  const connectPollRef = useRef(null);

  // Gmail session
  const [gmailConfigured, setGmailConfigured] = useState(false);

  // I&M Bank connection
  const [imConnecting, setImConnecting] = useState(false);
  const imPollRef = useRef(null);

  // M-PESA org portal connection
  const [mpesaConnecting, setMpesaConnecting] = useState(false);
  const mpesaPollRef = useRef(null);

  // Pause Bot 2FA modal
  const [showPauseModal, setShowPauseModal] = useState(false);
  const [pauseStep, setPauseStep] = useState('warning'); // warning | otp | done
  const [pauseOtpSent, setPauseOtpSent] = useState(false);
  const [pauseOtpCode, setPauseOtpCode] = useState('');
  const [pauseSecQ, setPauseSecQ] = useState('');
  const [pauseSecAnswer, setPauseSecAnswer] = useState('');
  const [pauseLoading, setPauseLoading] = useState(false);
  const [pauseMsg, setPauseMsg] = useState('');

  // Binance
  const [showRemoteBrowser, setShowRemoteBrowser] = useState(false);

  // Fee breakdown popup
  const [showFeeInfo, setShowFeeInfo] = useState(false);
  const feeInfoRef = useRef(null);

  // Close fee popup on outside click
  useEffect(() => {
    if (!showFeeInfo) return;
    const handler = (e) => { if (feeInfoRef.current && !feeInfoRef.current.contains(e.target)) setShowFeeInfo(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showFeeInfo]);

  // Settlement
  const [settlementMethod, setSettlementMethod] = useState(profile?.settlement_method || 'mpesa');
  const [settlementPhone, setSettlementPhone] = useState('');
  const [selectedBank, setSelectedBank] = useState('');
  const [showChangeForm, setShowChangeForm] = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const [settlementOtp, setSettlementOtp] = useState('');
  const [securityAnswer, setSecurityAnswer] = useState('');
  const [settleSQ, setSettleSQ] = useState('');
  const [bankAccount, setBankAccount] = useState('');
  const [customPaybill, setCustomPaybill] = useState('');
  const [paybillAccount, setPaybillAccount] = useState('');

  // Binance verification method — pre-populate from profile
  const [verifyMethod, setVerifyMethod] = useState(profile?.binance_verify_method || 'none');
  const [verifyInput, setVerifyInput] = useState('');
  const [verifySaved, setVerifySaved] = useState(
    !!(profile?.binance_verify_method && profile.binance_verify_method !== 'none')
  );

  // Security / Profile
  const [editName, setEditName] = useState(profile?.full_name || '');
  const [savingName, setSavingName] = useState(false);
  // Security question (set once)
  const [sqQuestion, setSqQuestion] = useState('');
  const [sqAnswer, setSqAnswer] = useState('');
  const [savingSq, setSavingSq] = useState(false);
  const [sqJustSaved, setSqJustSaved] = useState(null); // question text right after save
  // Google Authenticator (TOTP) setup
  const [totpSetup, setTotpSetup] = useState(null); // { secret, uri }
  const [totpLoading, setTotpLoading] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [totpMsg, setTotpMsg] = useState('');
  const [totpSaving, setTotpSaving] = useState(false);
  const [totpEnabled, setTotpEnabled] = useState(false);
  // Change password
  const [cpStep, setCpStep] = useState(0); // 0=idle, 1=otp-sent, 2=done
  const [cpOtp, setCpOtp] = useState('');
  const [cpNewPw, setCpNewPw] = useState('');
  const [cpConfirm, setCpConfirm] = useState('');
  const [cpPhoneHint, setCpPhoneHint] = useState('');
  const [cpShowPw, setCpShowPw] = useState(false);
  const [cpLoading, setCpLoading] = useState(false);
  const [cpCooldownUntil, setCpCooldownUntil] = useState(
    profile?.password_change_cooldown_until ? new Date(profile.password_change_cooldown_until) : null
  );
  const [cpCooldown, setCpCooldown] = useState('');

  // Settlement cooldown countdown
  const [settleCooldown, setSettleCooldown] = useState('');

  const PW_RULES = [
    { label: 'At least 8 characters', test: (p) => p.length >= 8 },
    { label: '2 uppercase letters', test: (p) => (p.match(/[A-Z]/g) || []).length >= 2 },
    { label: '2 lowercase letters', test: (p) => (p.match(/[a-z]/g) || []).length >= 2 },
    { label: '2 numbers', test: (p) => (p.match(/[0-9]/g) || []).length >= 2 },
    { label: '2 special chars (!@#$%...)', test: (p) => (p.match(/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/g) || []).length >= 2 },
  ];

  // Sync profile data into local state once profile loads (useState only runs once at mount)
  useEffect(() => {
    if (profile?.full_name) setEditName(profile.full_name);
  }, [profile?.full_name]);

  useEffect(() => {
    if (profile?.security_question) setSqJustSaved(profile.security_question);
  }, [profile?.security_question]);

  useEffect(() => {
    setTotpEnabled(!!profile?.has_totp);
  }, [profile?.has_totp]);

  useEffect(() => {
    if (profile?.password_change_cooldown_until) {
      setCpCooldownUntil((prev) => prev || new Date(profile.password_change_cooldown_until));
    }
  }, [profile?.password_change_cooldown_until]);

  // Countdown ticker for password change cooldown
  useEffect(() => {
    if (!cpCooldownUntil) return;
    const tick = () => {
      const diff = cpCooldownUntil - Date.now();
      if (diff <= 0) { setCpCooldownUntil(null); setCpCooldown(''); return; }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setCpCooldown(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [cpCooldownUntil]);

  // Countdown ticker for settlement method cooldown
  useEffect(() => {
    if (!profile?.settlement_cooldown_until) return;
    const until = new Date(profile.settlement_cooldown_until);
    const tick = () => {
      const diff = until - Date.now();
      if (diff <= 0) { setSettleCooldown(''); return; }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setSettleCooldown(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [profile?.settlement_cooldown_until]);

  // Trading
  const [autoRelease, setAutoRelease] = useState(profile?.auto_release_enabled ?? true);
  const [autoPay, setAutoPay] = useState(profile?.auto_pay_enabled ?? true);
  const [dailyLimit, setDailyLimit] = useState(profile?.daily_trade_limit || 200);
  const [maxTrade, setMaxTrade] = useState(profile?.max_single_trade || 500000);
  const [batchEnabled, setBatchEnabled] = useState(true);
  const [batchThreshold, setBatchThreshold] = useState(50000);

  const showMsg = (msg) => {
    setMessage(msg);
    setTimeout(() => setMessage(''), 3000);
  };

  const handleConnectBinance = () => {
    if (window.sparkp2p?.isDesktop) {
      window.sparkp2p.connectBinance();
    }
    setConnecting(true);
    if (!window.sparkp2p?.isDesktop) {
      setShowRemoteBrowser(true);
    }
  };

  // Poll until binance_connected = true, then navigate to dashboard with scanning state
  useEffect(() => {
    if (!connecting) return;
    connectPollRef.current = setInterval(async () => {
      try {
        const res = await getProfile();
        if (res.data.binance_connected) {
          clearInterval(connectPollRef.current);
          setConnecting(false);
          navigate('/dashboard?scanning=1');
        }
      } catch (_) {}
    }, 3000);
    return () => clearInterval(connectPollRef.current);
  }, [connecting]);

  // Auto-resume notification
  useEffect(() => {
    const handler = (e) => {
      if (e.detail?.reason === 'inactivity') {
        setMessage('Bot automatically resumed and all sessions locked after 30 seconds of inactivity.');
        setTimeout(() => setMessage(''), 6000);
      }
    };
    window.addEventListener('bot-resumed', handler);
    return () => window.removeEventListener('bot-resumed', handler);
  }, []);

  // Load Gmail status on mount + re-check when desktop app confirms login
  useEffect(() => {
    const checkGmail = () => {
      api.get('/traders/gmail-credentials').then(r => {
        setGmailConfigured(r.data.configured);
      }).catch(() => {});
    };
    checkGmail();
    window.addEventListener('gmail-connected', checkGmail);
    return () => window.removeEventListener('gmail-connected', checkGmail);
  }, []);

  // React to desktop app confirming M-PESA portal login
  useEffect(() => {
    const handler = async () => {
      setMpesaConnecting(false);
      if (onUpdate) { const r = await getProfile(); onUpdate(r.data); }
    };
    window.addEventListener('mpesa-portal-connected', handler);
    return () => window.removeEventListener('mpesa-portal-connected', handler);
  }, []);

  const handleRequestPauseOtp = async () => {
    setPauseLoading(true); setPauseMsg('');
    try {
      const res = await api.post('/traders/pause-bot/request-otp');
      setPauseSecQ(res.data.security_question);
      setPauseOtpSent(true);
      setPauseStep('otp');
      setPauseMsg(res.data.message);
    } catch (err) {
      setPauseMsg(err.response?.data?.detail || 'Failed to send OTP');
    }
    setPauseLoading(false);
  };

  const handleConfirmPause = async () => {
    if (!pauseOtpCode || !pauseSecAnswer) { setPauseMsg('Please fill in all fields.'); return; }
    setPauseLoading(true); setPauseMsg('');
    try {
      await api.post('/traders/pause-bot/confirm', { otp_code: pauseOtpCode, security_answer: pauseSecAnswer });
      // Authorized — actually pause the bot
      await fetch('http://127.0.0.1:9223/pause').catch(() => {});
      setShowPauseModal(false);
      setPauseStep('warning'); setPauseOtpCode(''); setPauseSecAnswer(''); setPauseMsg('');
    } catch (err) {
      setPauseMsg(err.response?.data?.detail || 'Verification failed.');
    }
    setPauseLoading(false);
  };

  const handleConnectIm = () => {
    if (window.sparkp2p?.isDesktop) {
      window.sparkp2p.connectIm();
    }
    setImConnecting(true);
  };

  // Poll until im_connected = true
  useEffect(() => {
    if (!imConnecting) return;
    imPollRef.current = setInterval(async () => {
      try {
        const res = await getProfile();
        if (res.data.im_connected) {
          clearInterval(imPollRef.current);
          setImConnecting(false);
          if (onUpdate) onUpdate(res.data);
        }
      } catch (_) {}
    }, 3000);
    return () => clearInterval(imPollRef.current);
  }, [imConnecting]);

  const handleConnectMpesa = () => {
    if (window.sparkp2p?.isDesktop) {
      window.sparkp2p.connectMpesa();
    }
    setMpesaConnecting(true);
  };

  // Poll until mpesa_portal_connected = true
  useEffect(() => {
    if (!mpesaConnecting) return;
    mpesaPollRef.current = setInterval(async () => {
      try {
        const res = await getProfile();
        if (res.data.mpesa_portal_connected) {
          clearInterval(mpesaPollRef.current);
          setMpesaConnecting(false);
          if (onUpdate) onUpdate(res.data);
        }
      } catch (_) {}
    }, 3000);
    return () => clearInterval(mpesaPollRef.current);
  }, [mpesaConnecting]);

  const handleRequestOTP = async () => {
    setLoading(true);
    try {
      const res = await requestSettlementOTP();
      setOtpSent(true);
      setSettleSQ(res.data.security_question || '');
      showMsg(res.data.message || 'OTP sent');
    } catch (err) {
      showMsg(err.response?.data?.detail || 'Failed to send OTP');
    }
    setLoading(false);
  };

  const handleSaveSettlement = async (e) => {
    e.preventDefault();
    if (!settlementOtp) { showMsg('Enter the OTP code sent to your phone'); return; }
    if (!securityAnswer) { showMsg('Enter your security answer'); return; }
    setLoading(true);
    try {
      const data = {
        method: settlementMethod,
        otp_code: settlementOtp,
        security_answer: securityAnswer,
      };
      if (settlementMethod === 'mpesa') {
        data.phone = settlementPhone;
      } else if (settlementMethod === 'bank_paybill') {
        data.paybill = BANK_PAYBILLS[selectedBank] || customPaybill;
        data.account = bankAccount;
        data.bank_name = selectedBank;
      } else if (settlementMethod === 'till') {
        data.paybill = customPaybill;
      } else if (settlementMethod === 'paybill') {
        data.paybill = customPaybill;
        data.account = paybillAccount;
      }
      const res = await updateSettlement(data);
      showMsg(res.data.message || 'Settlement method updated! 48-hour cooldown applies.');
      setShowChangeForm(false);
      setOtpSent(false);
      setSettlementOtp('');
      setSecurityAnswer('');
      onUpdate();
    } catch (err) {
      showMsg(err.response?.data?.detail || 'Failed to save settlement settings');
    }
    setLoading(false);
  };

  const handleSaveTrading = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await updateTradingConfig({
        auto_release_enabled: autoRelease,
        auto_pay_enabled: autoPay,
        daily_trade_limit: dailyLimit,
        max_single_trade: maxTrade,
        batch_settlement_enabled: batchEnabled,
        batch_threshold: batchThreshold,
      });
      showMsg('Trading settings saved!');
      onUpdate();
    } catch (err) {
      showMsg('Failed to save trading settings');
    }
    setLoading(false);
  };

  return (
    <div className="settings-panel">
      {message && <div className="settings-msg">{message}</div>}

      <div className="settings-nav">
        {[['binance', 'Binance'], ['settlement', 'Settlement'], ['trading', 'Trading'], ['security', 'Profile & Security']].map(([key, label]) => (
          <button
            key={key}
            className={activeSection === key ? 'active' : ''}
            onClick={() => setActiveSection(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {activeSection === 'binance' && (
        <div className="card">
          <h3>Connect Binance</h3>

          {profile?.binance_connected ? (
            <div className="name-verify-box match">
              <h4>Binance Connected</h4>
              {profile.binance_username && (
                <div className="name-verify-row">
                  <span>Binance Name:</span>
                  <strong>{profile.binance_username}</strong>
                </div>
              )}
              <p style={{ fontSize: 13, color: '#9ca3af', marginTop: 8 }}>
                Your Binance session is saved. The bot can trade on your behalf 24/7.
              </p>
              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                <button
                  onClick={handleConnectBinance}
                  style={{
                    padding: '10px 20px', borderRadius: 8,
                    border: '1px solid #f59e0b', background: 'transparent',
                    color: '#f59e0b', cursor: 'pointer', fontSize: 13,
                  }}
                >
                  Re-connect (if session expired)
                </button>
                <button
                  onClick={() => { setShowPauseModal(true); setPauseStep('warning'); setPauseMsg(''); }}
                  style={{
                    padding: '10px 20px', borderRadius: 8,
                    border: '1px solid #6b7280', background: 'transparent',
                    color: '#9ca3af', cursor: 'pointer', fontSize: 13,
                  }}
                >
                  Pause Bot
                </button>
                <button
                  onClick={() => fetch('http://127.0.0.1:9223/resume').catch(() => {})}
                  style={{
                    padding: '10px 20px', borderRadius: 8,
                    border: '1px solid #6b7280', background: 'transparent',
                    color: '#9ca3af', cursor: 'pointer', fontSize: 13,
                  }}
                >
                  Resume Bot
                </button>
              </div>
            </div>
          ) : (
            <div style={{
              textAlign: 'center', padding: '30px 20px',
              background: 'var(--bg)', borderRadius: 12,
              border: '1px dashed var(--border)',
            }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>&#128279;</div>
              <h4 style={{ color: '#fff', marginBottom: 8 }}>Link Your Binance Account</h4>
              <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 20, maxWidth: 400, margin: '0 auto 20px' }}>
                A secure browser will open where you log into Binance directly.
                Once logged in, the bot takes over and trades for you 24/7.
                No passwords are stored — only session cookies.
              </p>
              {connecting ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                  <div style={{
                    width: 36, height: 36, border: '3px solid rgba(245,158,11,0.2)',
                    borderTop: '3px solid #f59e0b', borderRadius: '50%',
                    animation: 'spin 0.8s linear infinite',
                  }} />
                  <span style={{ color: '#f59e0b', fontSize: 13 }}>Waiting for Binance login...</span>
                </div>
              ) : (
                <button
                  onClick={handleConnectBinance}
                  style={{
                    padding: '14px 32px', borderRadius: 10, border: 'none',
                    background: '#f59e0b', color: '#000', fontWeight: 700,
                    cursor: 'pointer', fontSize: 15,
                  }}
                >
                  Connect Binance
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Gmail Account */}
      {activeSection === 'binance' && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3 style={{ marginBottom: 4 }}>Gmail Account</h3>
          <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 12 }}>
            Used for email OTP verification during order release. The desktop app opens Gmail alongside Binance automatically.
          </p>
          {gmailConfigured ? (
            <div className="name-verify-box match">
              <h4>Gmail Connected</h4>
              <p style={{ fontSize: 13, color: '#9ca3af', marginTop: 8 }}>
                Gmail session is active. The bot will read OTP codes automatically during order release.
              </p>
              <button
                onClick={() => {
                  window.sparkp2p?.openGmailTab();
                }}
                style={{
                  marginTop: 12, padding: '10px 20px', borderRadius: 8,
                  border: '1px solid #f59e0b', background: 'transparent',
                  color: '#f59e0b', cursor: 'pointer', fontSize: 13,
                }}
              >
                Re-connect Gmail (if session expired)
              </button>
            </div>
          ) : (
            <div style={{
              textAlign: 'center', padding: '30px 20px',
              background: 'var(--bg)', borderRadius: 12,
              border: '1px dashed var(--border)',
            }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>✉️</div>
              <h4 style={{ marginBottom: 8 }}>Link Your Gmail Account</h4>
              <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 20 }}>
                Opens Gmail in the bot's Chrome window. Log in once and the session is saved permanently.
              </p>
              <button
                className="btn-primary"
                onClick={() => {
                  window.sparkp2p?.openGmailTab();
                }}
              >
                Connect Gmail
              </button>
            </div>
          )}
        </div>
      )}

      {activeSection === 'binance' && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Release Verification</h3>
          <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 16 }}>
            When releasing crypto, Binance asks for identity verification. Choose your method so the bot can automate it.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
            {[
              { value: 'fund_password', label: 'Fund Password', desc: 'Your Binance trade/fund password' },
              { value: 'totp', label: 'Google Authenticator (TOTP)', desc: 'Auto-generate 2FA codes from your secret key' },
            ].map(opt => (
              <div key={opt.value}
                onClick={() => { setVerifyMethod(opt.value); setVerifyInput(''); setVerifySaved(false); }}
                style={{
                  padding: '12px 14px', borderRadius: 10, cursor: 'pointer',
                  border: `1px solid ${verifyMethod === opt.value ? '#f59e0b' : 'var(--border)'}`,
                  background: verifyMethod === opt.value ? 'rgba(245,158,11,0.08)' : 'var(--bg)',
                  display: 'flex', alignItems: 'center', gap: 12,
                }}>
                <div style={{
                  width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
                  border: `2px solid ${verifyMethod === opt.value ? '#f59e0b' : '#4b5563'}`,
                  background: verifyMethod === opt.value ? '#f59e0b' : 'transparent',
                }} />
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>{opt.label}</div>
                  <div style={{ fontSize: 12, color: '#9ca3af' }}>{opt.desc}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Already configured — show status, allow update */}
          {verifySaved && !verifyInput && (
            <div style={{ padding: '12px 14px', borderRadius: 8, background: 'rgba(16,185,129,0.08)', border: '1px solid #10b981', fontSize: 13, color: '#10b981', marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>✓ {verifyMethod === 'totp' ? 'Google Authenticator secret' : 'Fund password'} is configured</span>
              <button
                onClick={() => setVerifyInput(' ')}
                style={{ background: 'none', border: '1px solid #10b981', borderRadius: 6, color: '#10b981', fontSize: 12, padding: '4px 10px', cursor: 'pointer' }}
              >
                Update
              </button>
            </div>
          )}

          {/* Input — only shown when updating */}
          {(!verifySaved || verifyInput) && verifyMethod === 'totp' && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ background: '#1a1d27', border: '1px solid #2a2d3a', borderRadius: 10, padding: 14, marginBottom: 12, fontSize: 12, color: '#9ca3af', lineHeight: 1.8 }}>
                <strong style={{ color: '#f59e0b', display: 'block', marginBottom: 6 }}>How to get your TOTP Secret Key:</strong>
                <ol style={{ paddingLeft: 16, margin: 0 }}>
                  <li>Open Binance → <strong style={{ color: '#e4e4e7' }}>Profile → Security</strong></li>
                  <li>Tap <strong style={{ color: '#e4e4e7' }}>Google Authenticator → Manage</strong></li>
                  <li>Select <strong style={{ color: '#e4e4e7' }}>Change Authenticator</strong> or <strong style={{ color: '#e4e4e7' }}>View Key</strong></li>
                  <li>Copy the <strong style={{ color: '#f59e0b' }}>Secret Key</strong> (looks like: JBSWY3DPEHPK3PXP)</li>
                </ol>
                <p style={{ margin: '8px 0 0', color: '#ef4444', fontSize: 11 }}>⚠️ If you reset your GA, you must re-add Binance to your Google Authenticator app.</p>
              </div>
              <label style={{ display: 'block', fontSize: 13, color: '#9ca3af', marginBottom: 4 }}>TOTP Secret Key</label>
              <input
                type="password"
                placeholder="e.g. JBSWY3DPEHPK3PXP"
                value={verifyInput.trim()}
                onChange={e => setVerifyInput(e.target.value)}
                style={{ width: '100%', boxSizing: 'border-box', letterSpacing: 2 }}
                autoFocus
              />
            </div>
          )}

          {(!verifySaved || verifyInput) && verifyMethod === 'fund_password' && (
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 13, color: '#9ca3af', marginBottom: 4 }}>Fund Password</label>
              <input
                type="password"
                placeholder="Your Binance fund/trade password"
                value={verifyInput.trim()}
                onChange={e => setVerifyInput(e.target.value)}
                maxLength={8}
                style={{ width: '100%', boxSizing: 'border-box' }}
                autoFocus
              />
            </div>
          )}

          {(!verifySaved || verifyInput.trim()) && (
            <div style={{ display: 'flex', gap: 8 }}>
              {verifySaved && (
                <button
                  onClick={() => setVerifyInput('')}
                  style={{ padding: '11px 18px', borderRadius: 8, border: '1px solid #374151', background: 'transparent', color: '#9ca3af', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
                >
                  Cancel
                </button>
              )}
              <button
                disabled={!verifyInput.trim() || loading}
                onClick={async () => {
                  const val = verifyInput.trim();
                  setLoading(true);
                  try {
                    await updateVerification({
                      verify_method: verifyMethod,
                      totp_secret: verifyMethod === 'totp' ? val : null,
                      fund_password: verifyMethod === 'fund_password' ? val : null,
                    });
                    setVerifySaved(true);
                    setVerifyInput('');
                    if (window.sparkp2p?.isDesktop) {
                      if (verifyMethod === 'totp') window.sparkp2p.setTotpSecret(val);
                      if (verifyMethod === 'fund_password') window.sparkp2p.setPin(val);
                    }
                  } catch (e) {
                    showMsg('Failed to save verification method');
                  }
                  setLoading(false);
                }}
                style={{
                  flex: 1, padding: '11px 24px', borderRadius: 8, border: 'none',
                  background: verifyInput.trim() ? '#f59e0b' : '#374151',
                  color: verifyInput.trim() ? '#000' : '#6b7280',
                  fontWeight: 700, fontSize: 13, cursor: verifyInput.trim() ? 'pointer' : 'not-allowed',
                }}
              >
                {loading ? 'Saving...' : 'Save Verification Method'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Remote Browser Modal */}
      {showRemoteBrowser && (
        <RemoteBrowser
          onConnected={() => {
            setShowRemoteBrowser(false);
            setConnecting(true);
          }}
          onClose={() => { setShowRemoteBrowser(false); setConnecting(false); }}
        />
      )}

      {/* I&M Bank Connection */}
      {activeSection === 'binance' && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3 style={{ marginBottom: 4 }}>I&amp;M Bank Account</h3>
          <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 12 }}>
            Used to automatically execute bank withdrawals for traders. Log in once, the session stays alive 24/7.
          </p>
          {profile?.im_connected ? (
            <div className="name-verify-box match">
              <h4>I&amp;M Bank Connected</h4>
              <p style={{ fontSize: 13, color: '#9ca3af', marginTop: 8 }}>
                Session is active. Bank withdrawals will execute automatically when approved.
              </p>
              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                <button
                  onClick={handleConnectIm}
                  style={{ padding: '10px 20px', borderRadius: 8, border: '1px solid #f59e0b', background: 'transparent', color: '#f59e0b', cursor: 'pointer', fontSize: 13 }}
                >
                  Re-connect (if session expired)
                </button>
                <button
                  onClick={async () => { await api.post('/traders/disconnect-im'); if (onUpdate) { const r = await getProfile(); onUpdate(r.data); } }}
                  style={{ padding: '10px 20px', borderRadius: 8, border: '1px solid #ef4444', background: 'transparent', color: '#ef4444', cursor: 'pointer', fontSize: 13 }}
                >
                  Disconnect
                </button>
              </div>
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '30px 20px', background: 'var(--bg)', borderRadius: 12, border: '1px dashed var(--border)' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>🏦</div>
              <h4 style={{ color: '#fff', marginBottom: 8 }}>Link Your I&amp;M Bank Account</h4>
              <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 20, maxWidth: 400, margin: '0 auto 20px' }}>
                A secure browser will open I&amp;M digital banking. Log in manually — the app captures your session and keeps it alive so bank transfers execute automatically.
              </p>
              {imConnecting ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 36, height: 36, border: '3px solid rgba(99,102,241,0.2)', borderTop: '3px solid #6366f1', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                  <span style={{ color: '#6366f1', fontSize: 13 }}>Waiting for I&amp;M login...</span>
                </div>
              ) : (
                <button
                  onClick={handleConnectIm}
                  style={{ padding: '14px 32px', borderRadius: 10, border: 'none', background: '#6366f1', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 15 }}
                >
                  Connect I&amp;M Bank
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* M-PESA Org Portal Connection — admin only */}
      {activeSection === 'binance' && profile?.is_admin && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3 style={{ marginBottom: 4 }}>M-PESA Org Portal</h3>
          <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 12 }}>
            Automates <strong style={{ color: '#e5e7eb' }}>org.ke.m-pesa.com</strong> to sweep funds from paybill 4041355 to your I&amp;M Bank account automatically when traders withdraw — <strong style={{ color: '#10b981' }}>completely free</strong>.
          </p>
          {profile?.mpesa_portal_connected ? (
            <div className="name-verify-box match">
              <h4>M-PESA Portal Connected</h4>
              <p style={{ fontSize: 13, color: '#9ca3af', marginTop: 8 }}>
                Session is active. Funds will sweep to I&amp;M Bank automatically on each trader withdrawal.
              </p>
              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                <button
                  onClick={handleConnectMpesa}
                  style={{ padding: '10px 20px', borderRadius: 8, border: '1px solid #f59e0b', background: 'transparent', color: '#f59e0b', cursor: 'pointer', fontSize: 13 }}
                >
                  Re-connect (if session expired)
                </button>
                <button
                  onClick={async () => { await api.post('/traders/disconnect-mpesa-portal'); if (onUpdate) { const r = await getProfile(); onUpdate(r.data); } }}
                  style={{ padding: '10px 20px', borderRadius: 8, border: '1px solid #ef4444', background: 'transparent', color: '#ef4444', cursor: 'pointer', fontSize: 13 }}
                >
                  Disconnect
                </button>
              </div>
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '30px 20px', background: 'var(--bg)', borderRadius: 12, border: '1px dashed var(--border)' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>📱</div>
              <h4 style={{ color: '#fff', marginBottom: 8 }}>Connect M-PESA Org Portal</h4>
              <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 20, maxWidth: 420, margin: '0 auto 20px' }}>
                A browser tab will open <strong style={{ color: '#e5e7eb' }}>org.ke.m-pesa.com</strong>. Log in manually — the app will then automate fund sweeps from paybill 4041355 to your linked I&amp;M account at zero cost.
              </p>
              {mpesaConnecting ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 36, height: 36, border: '3px solid rgba(16,185,129,0.2)', borderTop: '3px solid #10b981', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                  <span style={{ color: '#10b981', fontSize: 13 }}>Waiting for M-PESA portal login...</span>
                </div>
              ) : (
                <button
                  onClick={handleConnectMpesa}
                  style={{ padding: '14px 32px', borderRadius: 10, border: 'none', background: '#10b981', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 15 }}
                >
                  Connect M-PESA Portal
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {activeSection === 'settlement' && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <h3 style={{ margin: 0 }}>Settlement Method</h3>
            <div style={{ position: 'relative' }} ref={feeInfoRef}>
              <button
                onClick={() => setShowFeeInfo(v => !v)}
                title="View withdrawal fee breakdown"
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center' }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
              </button>
              {showFeeInfo && (
                <div style={{
                  position: 'absolute', top: 26, left: 0, zIndex: 100,
                  background: '#1e2240', border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 12, padding: 16, width: 300,
                  boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#f59e0b', marginBottom: 12 }}>Withdrawal Fee Breakdown</div>

                  {/* M-Pesa */}
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#10b981', marginBottom: 6 }}>📱 M-Pesa (Instant)</div>
                    <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ color: '#9ca3af' }}>
                          <th style={{ textAlign: 'left', paddingBottom: 4 }}>Amount</th>
                          <th style={{ textAlign: 'right', paddingBottom: 4 }}>Fee</th>
                        </tr>
                      </thead>
                      <tbody style={{ color: '#e5e7eb' }}>
                        {[
                          ['KES 1 – 500', 'KES 29'],
                          ['KES 501 – 1,000', 'KES 34'],
                          ['KES 1,001 – 2,500', 'KES 44'],
                          ['KES 2,501 – 5,000', 'KES 58'],
                          ['KES 5,001 – 10,000', 'KES 71'],
                          ['KES 10,001 – 25,000', 'KES 90'],
                          ['KES 25,001 – 50,000', 'KES 130'],
                          ['KES 50,001 – 150,000', 'KES 130'],
                        ].map(([range, fee]) => (
                          <tr key={range}>
                            <td style={{ padding: '2px 0' }}>{range}</td>
                            <td style={{ textAlign: 'right', color: '#f59e0b' }}>{fee}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', marginBottom: 12 }} />

                  {/* I&M Bank */}
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#60a5fa', marginBottom: 6 }}>🏦 I&M Bank (~1 hour)</div>
                    <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ color: '#9ca3af' }}>
                          <th style={{ textAlign: 'left', paddingBottom: 4 }}>Min. Amount</th>
                          <th style={{ textAlign: 'right', paddingBottom: 4 }}>Fee</th>
                        </tr>
                      </thead>
                      <tbody style={{ color: '#e5e7eb' }}>
                        {[
                          ['KES 1,000+', '0.05%'],
                        ].map(([range, fee]) => (
                          <tr key={range}>
                            <td style={{ padding: '2px 0' }}>{range}</td>
                            <td style={{ textAlign: 'right', color: '#f59e0b' }}>{fee}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div style={{ fontSize: 10, color: '#6b7280', marginTop: 4 }}>Flat 0.05% fee on all I&M Bank withdrawals</div>
                  </div>
                </div>
              )}
            </div>
          </div>
          <p className="help-text">How you want to receive your funds after trades.</p>

          {/* Current Settlement Display */}
          <div style={{ background: 'var(--bg)', borderRadius: 10, padding: 16, marginBottom: 16, border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 8 }}>Current Method</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#10b981' }}>
              {profile?.settlement_method === 'mpesa' ? 'M-Pesa' :
               profile?.settlement_method === 'bank_paybill' ? 'Bank Account' :
               profile?.settlement_method === 'till' ? 'Till Number' :
               profile?.settlement_method === 'paybill' ? 'Paybill' : 'Not set'}
            </div>
            <div style={{ fontSize: 13, color: '#fff', marginTop: 4 }}>
              {profile?.settlement_destination
                ? profile.settlement_destination.replace(/^(.*)(.{4})$/, (_, start, end) => '*'.repeat(start.length) + end)
                : 'No destination configured'}
            </div>
            {profile?.settlement_cooldown_until && settleCooldown && (
              <div style={{
                marginTop: 10, padding: 12, borderRadius: 8,
                background: 'rgba(245,158,11,0.1)', border: '1px solid #f59e0b',
                fontSize: 12, color: '#f59e0b',
              }}>
                <div style={{ marginBottom: 6 }}>Security cooldown — active for withdrawals in:</div>
                <div style={{ fontFamily: 'monospace', fontSize: 28, fontWeight: 700, letterSpacing: 2, color: '#f59e0b', textAlign: 'center' }}>
                  {settleCooldown}
                </div>
                <div style={{ marginTop: 4, textAlign: 'center', fontSize: 10, color: '#9ca3af' }}>
                  hh : mm : ss
                </div>
              </div>
            )}
          </div>

          {!showChangeForm ? (
            <button
              onClick={() => !profile?.settlement_cooldown_until && setShowChangeForm(true)}
              disabled={!!profile?.settlement_cooldown_until}
              style={{
                padding: '10px 20px', borderRadius: 8, border: '1px solid var(--border)',
                background: 'transparent',
                color: profile?.settlement_cooldown_until ? '#6b7280' : '#f59e0b',
                cursor: profile?.settlement_cooldown_until ? 'not-allowed' : 'pointer',
                fontSize: 13,
                opacity: profile?.settlement_cooldown_until ? 0.6 : 1,
              }}
            >
              {profile?.settlement_cooldown_until && settleCooldown ? `Locked — ${settleCooldown}` : 'Change Payment Method'}
            </button>
          ) : (
            <>
              {/* Step 1: Request OTP */}
              {!otpSent ? (
                <div style={{ marginTop: 16 }}>
                  <div style={{
                    padding: 14, borderRadius: 8, background: 'rgba(245,158,11,0.1)',
                    border: '1px solid #f59e0b', marginBottom: 16, fontSize: 13, color: '#f59e0b',
                  }}>
                    For security, changing your payment method requires phone OTP verification and your security answer.
                    The new method will have a 48-hour cooldown before it can be used for withdrawals.
                  </div>
                  <button
                    onClick={handleRequestOTP}
                    disabled={loading}
                    style={{
                      padding: '12px 24px', borderRadius: 8, border: 'none',
                      background: '#f59e0b', color: '#000', fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    {loading ? 'Sending OTP...' : 'Send Verification Code'}
                  </button>
                  <button
                    onClick={() => setShowChangeForm(false)}
                    style={{
                      marginLeft: 10, padding: '12px 24px', borderRadius: 8,
                      border: '1px solid var(--border)', background: 'transparent',
                      color: '#9ca3af', cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                /* Step 2: OTP + Security Answer + New Method */
                <form onSubmit={handleSaveSettlement} style={{ marginTop: 16 }}>
                  <label>New Method</label>
                  <select value={settlementMethod} onChange={(e) => setSettlementMethod(e.target.value)}>
                    <option value="mpesa">M-Pesa (B2C)</option>
                    <option value="bank_paybill">Bank Account (via Bank Paybill)</option>
                    <option value="till">Till Number (Buy Goods)</option>
                    <option value="paybill">My Own Paybill</option>
                  </select>

                  {settlementMethod === 'mpesa' && (
                    <>
                      <label>M-Pesa Phone Number</label>
                      <input type="tel" placeholder="0712345678" value={settlementPhone}
                        onChange={(e) => setSettlementPhone(e.target.value)} required />
                    </>
                  )}
                  {settlementMethod === 'bank_paybill' && (
                    <>
                      <label>Bank</label>
                      <select value={selectedBank} onChange={(e) => setSelectedBank(e.target.value)} required>
                        <option value="">Select Bank</option>
                        {Object.keys(BANK_PAYBILLS).map((bank) => (
                          <option key={bank} value={bank}>{bank} ({BANK_PAYBILLS[bank]})</option>
                        ))}
                      </select>
                      <label>Account Number</label>
                      <input type="text" placeholder="Your bank account number" value={bankAccount}
                        onChange={(e) => setBankAccount(e.target.value)} required />
                    </>
                  )}
                  {settlementMethod === 'till' && (
                    <>
                      <label>Till Number</label>
                      <input type="text" placeholder="Your Till number" value={customPaybill}
                        onChange={(e) => setCustomPaybill(e.target.value)} required />
                    </>
                  )}
                  {settlementMethod === 'paybill' && (
                    <>
                      <label>Paybill Number</label>
                      <input type="text" placeholder="Your Paybill shortcode" value={customPaybill}
                        onChange={(e) => setCustomPaybill(e.target.value)} required />
                      <label>Account Number</label>
                      <input type="text" placeholder="Account number" value={paybillAccount}
                        onChange={(e) => setPaybillAccount(e.target.value)} />
                    </>
                  )}

                  <div style={{ marginTop: 16, padding: 16, background: 'var(--bg)', borderRadius: 10, border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <div>
                      <label style={{ display: 'block', fontSize: 13, color: '#f59e0b', marginBottom: 6, fontWeight: 600 }}>Verification Code (OTP)</label>
                      <input type="text" placeholder="Enter 6-digit code" value={settlementOtp}
                        onChange={(e) => setSettlementOtp(e.target.value)} maxLength={6} required
                        style={{ width: '100%', boxSizing: 'border-box' }} />
                      <span style={{ fontSize: 11, color: '#6b7280', marginTop: 4, display: 'block' }}>Check your phone and email for the code</span>
                    </div>

                    <div>
                      <label style={{ display: 'block', fontSize: 13, color: '#f59e0b', marginBottom: 6, fontWeight: 600 }}>
                        Security Question
                      </label>
                      <p style={{ fontSize: 13, color: '#9ca3af', margin: '0 0 6px', fontStyle: 'italic' }}>
                        {settleSQ || profile?.security_question || 'Not set'}
                      </p>
                      <input type="text" placeholder="Your security answer" value={securityAnswer}
                        onChange={(e) => setSecurityAnswer(e.target.value)} required
                        style={{ width: '100%', boxSizing: 'border-box' }} />
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
                    <button type="submit" disabled={loading}>
                      {loading ? 'Saving...' : 'Update Payment Method'}
                    </button>
                    <button type="button"
                      onClick={() => { setShowChangeForm(false); setOtpSent(false); setSettlementOtp(''); setSecurityAnswer(''); }}
                      style={{
                        padding: '10px 20px', borderRadius: 8, border: '1px solid var(--border)',
                        background: 'transparent', color: '#9ca3af', cursor: 'pointer',
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </>
          )}
        </div>
      )}

      {activeSection === 'security' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* ── Profile Details ─────────────────────────────── */}
          <div className="card">
            <h3 style={{ marginBottom: 4 }}>Profile Details</h3>
            <p className="help-text" style={{ marginBottom: 16 }}>Update your display name as it appears on trades.</p>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
              <div>
                <label style={{ fontSize: 12, color: '#9ca3af', display: 'block', marginBottom: 4 }}>Email</label>
                <div style={{ fontSize: 14, color: '#e5e7eb', padding: '10px 14px', background: 'var(--bg)', borderRadius: 8, border: '1px solid var(--border)' }}>
                  {profile?.email || '—'}
                </div>
              </div>
              <div>
                <label style={{ fontSize: 12, color: '#9ca3af', display: 'block', marginBottom: 4 }}>Phone</label>
                <div style={{ fontSize: 14, color: '#e5e7eb', padding: '10px 14px', background: 'var(--bg)', borderRadius: 8, border: '1px solid var(--border)' }}>
                  {profile?.phone ? `***${profile.phone.slice(-4)}` : '—'}
                </div>
              </div>
            </div>

            <label style={{ fontSize: 13, color: '#9ca3af', display: 'block', marginBottom: 6 }}>
              Full Name <span style={{ fontSize: 11, color: '#6b7280' }}>(as on Binance KYC)</span>
            </label>
            <div style={{ display: 'flex', gap: 10 }}>
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value.toUpperCase())}
                style={{ flex: 1, textTransform: 'uppercase' }}
                placeholder="JOHN DOE MWANGI"
              />
              <button
                onClick={async () => {
                  if (!editName.trim() || editName.trim().length < 3) { showMsg('Name must be at least 3 characters'); return; }
                  setSavingName(true);
                  try {
                    await updateProfile({ full_name: editName.trim() });
                    showMsg('Name updated successfully');
                    onUpdate();
                  } catch (err) {
                    showMsg(err.response?.data?.detail || 'Failed to update name');
                  }
                  setSavingName(false);
                }}
                disabled={savingName}
                style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: '#f59e0b', color: '#000', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}
              >
                {savingName ? 'Saving...' : 'Save Name'}
              </button>
            </div>
          </div>

          {/* ── Security Question ───────────────────────────── */}
          <div className="card">
            <h3 style={{ marginBottom: 4 }}>Security Question</h3>
            <p className="help-text" style={{ marginBottom: 16 }}>
              Used to verify your identity when changing payment methods. <strong style={{ color: '#ef4444' }}>Cannot be changed once set.</strong>
            </p>

            {(profile?.security_question || sqJustSaved) ? (
              <div style={{ padding: 16, background: 'var(--bg)', borderRadius: 10, border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 18 }}>🔒</span>
                  <span style={{ fontSize: 13, color: '#10b981', fontWeight: 600 }}>Security question is set</span>
                </div>
                <p style={{ fontSize: 13, color: '#9ca3af', margin: 0 }}>{profile?.security_question || sqJustSaved}</p>
                <p style={{ fontSize: 11, color: '#6b7280', margin: '8px 0 0' }}>Your answer is securely hashed and cannot be viewed.</p>
              </div>
            ) : (
              <form onSubmit={async (e) => {
                e.preventDefault();
                if (!sqQuestion || !sqAnswer.trim()) { showMsg('Select a question and provide an answer'); return; }
                setSavingSq(true);
                try {
                  await setSecurityQuestion({ security_question: sqQuestion, security_answer: sqAnswer.trim() });
                  setSqJustSaved(sqQuestion);
                  showMsg('Security question saved!');
                  onUpdate();
                } catch (err) {
                  showMsg(err.response?.data?.detail || 'Failed to save security question');
                }
                setSavingSq(false);
              }}>
                <div style={{ padding: 12, borderRadius: 8, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', fontSize: 13, color: '#f59e0b', marginBottom: 16 }}>
                  Choose carefully — this question cannot be changed after saving.
                </div>
                <label style={{ fontSize: 13, color: '#9ca3af', display: 'block', marginBottom: 6 }}>Security Question</label>
                <select value={sqQuestion} onChange={(e) => setSqQuestion(e.target.value)} required style={{ width: '100%', marginBottom: 14 }}>
                  <option value="">Select a question</option>
                  <option value="What is your mother's maiden name?">What is your mother's maiden name?</option>
                  <option value="What was the name of your first pet?">What was the name of your first pet?</option>
                  <option value="What city were you born in?">What city were you born in?</option>
                  <option value="What is the name of your primary school?">What is the name of your primary school?</option>
                  <option value="What was your childhood nickname?">What was your childhood nickname?</option>
                </select>
                <label style={{ fontSize: 13, color: '#9ca3af', display: 'block', marginBottom: 6 }}>Your Answer</label>
                <input
                  type="text"
                  placeholder="Answer (case-insensitive)"
                  value={sqAnswer}
                  onChange={(e) => setSqAnswer(e.target.value)}
                  required
                  style={{ marginBottom: 14 }}
                />
                <button type="submit" disabled={savingSq} style={{ padding: '12px 24px', borderRadius: 8, border: 'none', background: '#f59e0b', color: '#000', fontWeight: 600, cursor: 'pointer' }}>
                  {savingSq ? 'Saving...' : 'Save Security Question'}
                </button>
              </form>
            )}
          </div>

          {/* ── Google Authenticator (TOTP) ─────────────────── */}
          <div className="card">
            <h3 style={{ marginBottom: 4 }}>Google Authenticator</h3>
            <p className="help-text" style={{ marginBottom: 16 }}>
              Adds a 6-digit code from Google Authenticator as a third factor when pausing or resuming the bot.
            </p>

            {totpEnabled ? (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: 'rgba(16,185,129,0.08)', borderRadius: 10, border: '1px solid rgba(16,185,129,0.25)', marginBottom: 16 }}>
                  <span style={{ fontSize: 20 }}>✅</span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#10b981' }}>Google Authenticator is linked</div>
                    <div style={{ fontSize: 12, color: '#6b7280' }}>Your account is protected with TOTP 2FA.</div>
                  </div>
                </div>
                <button
                  onClick={async () => {
                    if (!confirm('Remove Google Authenticator from your account?')) return;
                    await removeTotp();
                    setTotpEnabled(false);
                    setTotpSetup(null);
                    if (onUpdate) { const r = await getProfile(); onUpdate(r.data); }
                  }}
                  style={{ padding: '10px 20px', borderRadius: 8, border: '1px solid rgba(239,68,68,0.4)', background: 'transparent', color: '#ef4444', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                  Remove Authenticator
                </button>
              </div>
            ) : (
              <div>
                {!totpSetup ? (
                  <button
                    disabled={totpLoading}
                    onClick={async () => {
                      setTotpLoading(true); setTotpMsg('');
                      try {
                        const res = await getTotpSetup();
                        setTotpSetup(res.data);
                      } catch { setTotpMsg('Failed to generate QR code.'); }
                      setTotpLoading(false);
                    }}
                    style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: '#f59e0b', color: '#000', fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>
                    {totpLoading ? 'Generating...' : 'Set Up Google Authenticator'}
                  </button>
                ) : (
                  <div>
                    <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 16 }}>
                      Scan the QR code below with the <strong style={{ color: '#fff' }}>Google Authenticator</strong> app, then enter the 6-digit code to confirm.
                    </p>

                    {/* QR Code */}
                    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
                      <div style={{ background: '#fff', padding: 16, borderRadius: 12 }}>
                        <QRCodeSVG value={totpSetup.uri} size={180} />
                      </div>
                    </div>

                    {/* Manual entry fallback */}
                    <div style={{ padding: '10px 14px', background: 'rgba(255,255,255,0.04)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', marginBottom: 20 }}>
                      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Can't scan? Enter this key manually in Google Authenticator:</div>
                      <div style={{ fontFamily: 'monospace', fontSize: 14, color: '#f59e0b', letterSpacing: 2, wordBreak: 'break-all' }}>{totpSetup.secret}</div>
                    </div>

                    {/* Verify */}
                    <div style={{ marginBottom: 12 }}>
                      <label style={{ fontSize: 13, color: '#9ca3af', display: 'block', marginBottom: 6 }}>Enter 6-digit code from Google Authenticator</label>
                      <input
                        type="text" inputMode="numeric" maxLength={6} placeholder="000000"
                        value={totpCode} onChange={e => setTotpCode(e.target.value.replace(/\D/g, ''))}
                        style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: '#0d0f1e', color: '#fff', fontSize: 18, letterSpacing: 6, textAlign: 'center', boxSizing: 'border-box' }}
                      />
                    </div>

                    {totpMsg && <p style={{ fontSize: 12, color: totpMsg.includes('success') || totpMsg.includes('linked') ? '#10b981' : '#ef4444', marginBottom: 10 }}>{totpMsg}</p>}

                    <div style={{ display: 'flex', gap: 10 }}>
                      <button onClick={() => { setTotpSetup(null); setTotpCode(''); setTotpMsg(''); }}
                        style={{ padding: '10px 20px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: '#9ca3af', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                        Cancel
                      </button>
                      <button
                        disabled={totpSaving || totpCode.length !== 6}
                        onClick={async () => {
                          setTotpSaving(true); setTotpMsg('');
                          try {
                            await verifyAndSaveTotp({ secret: totpSetup.secret, code: totpCode });
                            setTotpEnabled(true);
                            setTotpSetup(null);
                            setTotpCode('');
                            setTotpMsg('Google Authenticator linked successfully!');
                            if (onUpdate) { const r = await getProfile(); onUpdate(r.data); }
                          } catch (err) {
                            setTotpMsg(err.response?.data?.detail || 'Invalid code. Try again.');
                          }
                          setTotpSaving(false);
                        }}
                        style={{ flex: 1, padding: '10px 20px', borderRadius: 8, border: 'none', background: totpCode.length === 6 ? '#10b981' : '#374151', color: '#fff', fontWeight: 700, cursor: totpCode.length === 6 ? 'pointer' : 'not-allowed', fontSize: 13 }}>
                        {totpSaving ? 'Verifying...' : 'Confirm & Link'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Change Password ──────────────────────────────── */}
          <div className="card">
            <h3 style={{ marginBottom: 4 }}>Change Password</h3>
            <p className="help-text" style={{ marginBottom: 16 }}>
              An OTP will be sent to your registered phone number to authorize the change.
            </p>

            {cpCooldownUntil ? (
              <div style={{ padding: 16, background: 'rgba(245,158,11,0.06)', borderRadius: 10, border: '1px solid rgba(245,158,11,0.25)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <span style={{ fontSize: 20 }}>⏳</span>
                  <span style={{ fontSize: 13, color: '#f59e0b', fontWeight: 600 }}>Password change locked</span>
                </div>
                <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 10px' }}>
                  For your security, you can only change your password once every 48 hours.
                </p>
                <div style={{ fontSize: 30, fontWeight: 800, color: '#f59e0b', fontVariantNumeric: 'tabular-nums', letterSpacing: 2 }}>
                  {cpCooldown}
                </div>
                <p style={{ fontSize: 11, color: '#6b7280', marginTop: 6 }}>Time remaining until you can change your password again.</p>
              </div>
            ) : cpStep === 0 ? (
              <button
                onClick={async () => {
                  setCpLoading(true);
                  try {
                    const res = await requestChangePasswordOtp();
                    setCpPhoneHint(res.data.phone_hint || '');
                    setCpStep(1);
                    showMsg(res.data.message || 'OTP sent to your phone');
                  } catch (err) {
                    const detail = err.response?.data?.detail;
                    if (detail?.code === 'password_change_cooldown') {
                      setCpCooldownUntil(new Date(detail.cooldown_until));
                    } else {
                      showMsg(typeof detail === 'string' ? detail : 'Failed to send OTP');
                    }
                  }
                  setCpLoading(false);
                }}
                disabled={cpLoading}
                style={{ padding: '12px 24px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: '#f59e0b', fontWeight: 600, cursor: 'pointer' }}
              >
                {cpLoading ? 'Sending OTP...' : 'Change Password'}
              </button>
            ) : null}

            {cpStep === 1 && (
              <form onSubmit={async (e) => {
                e.preventDefault();
                const failed = PW_RULES.filter((r) => !r.test(cpNewPw));
                if (failed.length > 0) { showMsg(`Password missing: ${failed.map((r) => r.label).join(', ')}`); return; }
                if (cpNewPw !== cpConfirm) { showMsg('Passwords do not match'); return; }
                setCpLoading(true);
                try {
                  const res = await changePassword(cpOtp, cpNewPw);
                  if (res.data.cooldown_until) {
                    setCpCooldownUntil(new Date(res.data.cooldown_until));
                  }
                  setCpStep(2);
                  showMsg('Password changed successfully!');
                  setCpOtp(''); setCpNewPw(''); setCpConfirm('');
                } catch (err) {
                  showMsg(err.response?.data?.detail || 'Failed to change password');
                }
                setCpLoading(false);
              }}>
                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 13, color: '#9ca3af', display: 'block', marginBottom: 6 }}>
                    OTP Code <span style={{ color: '#6b7280' }}>(sent to {cpPhoneHint})</span>
                  </label>
                  <input type="text" placeholder="6-digit code" value={cpOtp} onChange={(e) => setCpOtp(e.target.value)} maxLength={6} autoFocus required />
                </div>

                <div style={{ marginBottom: 8 }}>
                  <label style={{ fontSize: 13, color: '#9ca3af', display: 'block', marginBottom: 6 }}>New Password</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input type={cpShowPw ? 'text' : 'password'} placeholder="Create a strong password" value={cpNewPw} onChange={(e) => setCpNewPw(e.target.value)} required style={{ flex: 1 }} />
                    <button type="button" onClick={() => setCpShowPw(!cpShowPw)} style={{ padding: '0 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: '#9ca3af', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                      {cpShowPw ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </div>

                {cpNewPw && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginBottom: 12, padding: '10px 12px', background: 'var(--bg)', borderRadius: 8, border: '1px solid var(--border)' }}>
                    {PW_RULES.map((rule, i) => (
                      <span key={i} style={{ fontSize: 11, color: rule.test(cpNewPw) ? '#10b981' : '#6b7280' }}>
                        {rule.test(cpNewPw) ? '✓' : '✗'} {rule.label}
                      </span>
                    ))}
                  </div>
                )}

                <div style={{ marginBottom: 16 }}>
                  <label style={{ fontSize: 13, color: '#9ca3af', display: 'block', marginBottom: 6 }}>Confirm New Password</label>
                  <input type="password" placeholder="Re-enter new password" value={cpConfirm} onChange={(e) => setCpConfirm(e.target.value)} required />
                  {cpConfirm && cpNewPw !== cpConfirm && (
                    <span style={{ fontSize: 12, color: '#ef4444', marginTop: 4, display: 'block' }}>Passwords do not match</span>
                  )}
                </div>

                <div style={{ display: 'flex', gap: 10 }}>
                  <button type="submit" disabled={cpLoading || !cpOtp || !cpNewPw || cpNewPw !== cpConfirm} style={{ padding: '12px 24px', borderRadius: 8, border: 'none', background: '#f59e0b', color: '#000', fontWeight: 600, cursor: 'pointer' }}>
                    {cpLoading ? 'Saving...' : 'Set New Password'}
                  </button>
                  <button type="button" onClick={() => { setCpStep(0); setCpOtp(''); setCpNewPw(''); setCpConfirm(''); }}
                    style={{ padding: '12px 24px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: '#9ca3af', cursor: 'pointer' }}>
                    Cancel
                  </button>
                </div>
              </form>
            )}

            {cpStep === 2 && !cpCooldownUntil && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 16, background: 'rgba(16,185,129,0.08)', borderRadius: 10, border: '1px solid #10b981' }}>
                <span style={{ fontSize: 24 }}>✅</span>
                <div>
                  <div style={{ fontWeight: 600, color: '#10b981', fontSize: 14 }}>Password changed successfully</div>
                  <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>Your new password is active.</div>
                </div>
              </div>
            )}
          </div>

        </div>
      )}

      {activeSection === 'trading' && (
        <div className="card">
          <h3>Trading Configuration</h3>
          <form onSubmit={handleSaveTrading}>
            <div className="toggle-row">
              <label>Auto-Release (Sell Side)</label>
              <input type="checkbox" checked={autoRelease} onChange={(e) => setAutoRelease(e.target.checked)} />
            </div>
            <p className="help-text">Automatically release crypto when payment is confirmed.</p>

            <div className="toggle-row">
              <label>Auto-Pay (Buy Side)</label>
              <input type="checkbox" checked={autoPay} onChange={(e) => setAutoPay(e.target.checked)} />
            </div>
            <p className="help-text">Automatically pay sellers when you place a buy order.</p>

            <label>Daily Trade Limit</label>
            <input type="number" value={dailyLimit} onChange={(e) => setDailyLimit(Number(e.target.value))} />

            <label>Max Single Trade (KES)</label>
            <input type="number" value={maxTrade} onChange={(e) => setMaxTrade(Number(e.target.value))} />

            <div className="toggle-row">
              <label>Batch Settlement</label>
              <input type="checkbox" checked={batchEnabled} onChange={(e) => setBatchEnabled(e.target.checked)} />
            </div>
            <p className="help-text">Accumulate funds and settle in batches to save on fees.</p>

            {batchEnabled && (
              <>
                <label>Batch Threshold (KES)</label>
                <input
                  type="number"
                  value={batchThreshold}
                  onChange={(e) => setBatchThreshold(Number(e.target.value))}
                />
                <p className="help-text">Auto-settle when balance reaches this amount.</p>
              </>
            )}

            <button type="submit" disabled={loading}>
              {loading ? 'Saving...' : 'Save Trading Settings'}
            </button>
          </form>
        </div>
      )}
      {/* Pause Bot 2FA Modal */}
      {showPauseModal && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div style={{ background: '#1a1d27', borderRadius: 16, padding: 28, maxWidth: 480, width: '100%', border: '1px solid rgba(255,255,255,0.1)' }}>

            {pauseStep === 'warning' && (<>
              <div style={{ fontSize: 32, marginBottom: 12, textAlign: 'center' }}>⚠️</div>
              <h3 style={{ color: '#f59e0b', textAlign: 'center', marginBottom: 16 }}>Pause Bot — Security Notice</h3>
              <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 10, padding: '14px 16px', marginBottom: 20, fontSize: 13, color: '#fca5a5', lineHeight: 1.7 }}>
                <strong style={{ color: '#ef4444', display: 'block', marginBottom: 6 }}>Important: Understand the risks before proceeding.</strong>
                Pausing the bot disables the automated lock on your Binance and I&M Bank browser sessions.
                During this window, anyone with physical or remote access to this device could interact with
                your trading and banking accounts directly.<br /><br />
                <strong style={{ color: '#fca5a5' }}>We strongly recommend pausing only when absolutely necessary</strong> — for example, to update your
                configuration or troubleshoot an issue — and resuming immediately once done. The system will
                automatically resume and re-lock all sessions after <strong>30 seconds of inactivity</strong>.
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={() => setShowPauseModal(false)}
                  style={{ flex: 1, padding: '11px 0', borderRadius: 8, border: '1px solid #374151', background: 'transparent', color: '#9ca3af', cursor: 'pointer', fontSize: 14 }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleRequestPauseOtp}
                  disabled={pauseLoading}
                  style={{ flex: 1, padding: '11px 0', borderRadius: 8, border: 'none', background: '#f59e0b', color: '#000', fontWeight: 700, cursor: 'pointer', fontSize: 14 }}
                >
                  {pauseLoading ? 'Sending OTP...' : 'I Understand — Proceed'}
                </button>
              </div>
            </>)}

            {pauseStep === 'otp' && (<>
              <h3 style={{ color: '#fff', marginBottom: 6 }}>Verify Identity</h3>
              <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 16 }}>Enter the OTP sent to your phone and your security answer to confirm.</p>

              {pauseMsg && (
                <div style={{ padding: '8px 12px', borderRadius: 8, marginBottom: 12, fontSize: 13,
                  background: pauseMsg.includes('sent') ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)',
                  color: pauseMsg.includes('sent') ? '#4ade80' : '#f87171',
                  border: `1px solid ${pauseMsg.includes('sent') ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}`,
                }}>
                  {pauseMsg}
                </div>
              )}

              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 4 }}>OTP Code</label>
                <input
                  type="text" maxLength={6} placeholder="6-digit code"
                  value={pauseOtpCode} onChange={e => setPauseOtpCode(e.target.value)}
                  className="adm-input" style={{ width: '100%' }}
                />
              </div>

              {pauseSecQ && (
                <div style={{ marginBottom: 16 }}>
                  <label style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 4 }}>{pauseSecQ}</label>
                  <input
                    type="text" placeholder="Your answer"
                    value={pauseSecAnswer} onChange={e => setPauseSecAnswer(e.target.value)}
                    className="adm-input" style={{ width: '100%' }}
                  />
                </div>
              )}

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={() => { setShowPauseModal(false); setPauseStep('warning'); }}
                  style={{ flex: 1, padding: '11px 0', borderRadius: 8, border: '1px solid #374151', background: 'transparent', color: '#9ca3af', cursor: 'pointer', fontSize: 14 }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmPause}
                  disabled={pauseLoading}
                  style={{ flex: 1, padding: '11px 0', borderRadius: 8, border: 'none', background: '#ef4444', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 14 }}
                >
                  {pauseLoading ? 'Verifying...' : 'Confirm Pause'}
                </button>
              </div>
            </>)}

          </div>
        </div>
      )}
    </div>
  );
}
