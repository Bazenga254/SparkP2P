import { useState } from 'react';
import { updateSettlement, updateTradingConfig } from '../services/api';
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
        {['binance', 'settlement', 'trading'].map((s) => (
          <button
            key={s}
            className={activeSection === s ? 'active' : ''}
            onClick={() => setActiveSection(s)}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
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
