import { useState, useEffect } from 'react';
import { updateSettlement, updateTradingConfig, updateProfile, setSecurityQuestion, requestChangePasswordOtp, changePassword } from '../services/api';
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
  const [activeSection, setActiveSection] = useState('binance');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  // Binance
  const [showRemoteBrowser, setShowRemoteBrowser] = useState(false);

  // Settlement
  const [settlementMethod, setSettlementMethod] = useState(profile?.settlement_method || 'mpesa');
  const [settlementPhone, setSettlementPhone] = useState('');
  const [selectedBank, setSelectedBank] = useState('');
  const [showChangeForm, setShowChangeForm] = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const [settlementOtp, setSettlementOtp] = useState('');
  const [securityAnswer, setSecurityAnswer] = useState('');
  const [securityQuestion, setSecurityQuestion] = useState('');
  const [bankAccount, setBankAccount] = useState('');
  const [customPaybill, setCustomPaybill] = useState('');
  const [paybillAccount, setPaybillAccount] = useState('');

  // Security / Profile
  const [editName, setEditName] = useState(profile?.full_name || '');
  const [savingName, setSavingName] = useState(false);
  // Security question (set once)
  const [sqQuestion, setSqQuestion] = useState('');
  const [sqAnswer, setSqAnswer] = useState('');
  const [savingSq, setSavingSq] = useState(false);
  const [sqJustSaved, setSqJustSaved] = useState(null); // question text right after save
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
    // If running in Electron desktop app, use real Chrome browser
    if (window.sparkp2p?.isDesktop) {
      window.sparkp2p.connectBinance();
      showMsg('Opening Chrome browser for Binance login...');
      return;
    }
    // Web fallback: use remote browser stream
    setShowRemoteBrowser(true);
  };

  const handleRequestOTP = async () => {
    setLoading(true);
    try {
      const res = await requestSettlementOTP();
      setOtpSent(true);
      setSecurityQuestion(res.data.security_question || '');
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
              <button
                onClick={handleConnectBinance}
                style={{
                  marginTop: 12, padding: '10px 20px', borderRadius: 8,
                  border: '1px solid #f59e0b', background: 'transparent',
                  color: '#f59e0b', cursor: 'pointer', fontSize: 13,
                }}
              >
                Re-connect (if session expired)
              </button>
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
            </div>
          )}
        </div>
      )}

      {/* Remote Browser Modal */}
      {showRemoteBrowser && (
        <RemoteBrowser
          onConnected={() => {
            showMsg('Binance connected! Bot session saved.');
            onUpdate();
          }}
          onClose={() => setShowRemoteBrowser(false)}
        />
      )}

      {activeSection === 'settlement' && (
        <div className="card">
          <h3>Settlement Method</h3>
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
            {profile?.settlement_cooldown_until && (
              <div style={{
                marginTop: 10, padding: 10, borderRadius: 8,
                background: 'rgba(245,158,11,0.1)', border: '1px solid #f59e0b',
                fontSize: 12, color: '#f59e0b',
              }}>
                Due to security reasons, this payment method will be active for withdrawals after{' '}
                {new Date(profile.settlement_cooldown_until).toLocaleString()}.
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
              {profile?.settlement_cooldown_until ? 'Change Blocked (48hr cooldown)' : 'Change Payment Method'}
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
                        {securityQuestion || profile?.security_question || 'Not set'}
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
    </div>
  );
}
