import { useState } from 'react';
import { connectBinance, updateSettlement, updateTradingConfig } from '../services/api';

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
  const [cookies, setCookies] = useState('');
  const [csrfToken, setCsrfToken] = useState('');
  const [totpSecret, setTotpSecret] = useState('');

  // Settlement
  const [settlementMethod, setSettlementMethod] = useState(profile?.settlement_method || 'mpesa');
  const [settlementPhone, setSettlementPhone] = useState('');
  const [selectedBank, setSelectedBank] = useState('');
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

  const handleConnectBinance = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const cookieObj = JSON.parse(cookies);
      await connectBinance({
        cookies: cookieObj,
        csrf_token: csrfToken,
        totp_secret: totpSecret || null,
      });
      showMsg('Binance connected successfully!');
      onUpdate();
    } catch (err) {
      showMsg(err.response?.data?.detail || 'Failed to connect Binance');
    }
    setLoading(false);
  };

  const handleSaveSettlement = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const data = { method: settlementMethod };
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
      await updateSettlement(data);
      showMsg('Settlement settings saved!');
      onUpdate();
    } catch (err) {
      showMsg('Failed to save settlement settings');
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
          <p className="help-text">
            Open Binance P2P in Chrome → DevTools (F12) → Network tab →
            perform any action → copy cookies and csrftoken from request headers.
          </p>
          <form onSubmit={handleConnectBinance}>
            <label>Cookies (JSON format)</label>
            <textarea
              rows={5}
              placeholder='{"p20t": "...", "csrftoken": "...", ...}'
              value={cookies}
              onChange={(e) => setCookies(e.target.value)}
              required
            />
            <label>CSRF Token</label>
            <input
              type="text"
              placeholder="csrftoken value"
              value={csrfToken}
              onChange={(e) => setCsrfToken(e.target.value)}
              required
            />
            <label>2FA Secret (optional - for auto-release)</label>
            <input
              type="password"
              placeholder="TOTP secret from Google Authenticator setup"
              value={totpSecret}
              onChange={(e) => setTotpSecret(e.target.value)}
            />
            <button type="submit" disabled={loading}>
              {loading ? 'Connecting...' : 'Connect Binance'}
            </button>
          </form>
        </div>
      )}

      {activeSection === 'settlement' && (
        <div className="card">
          <h3>Settlement Method</h3>
          <p className="help-text">How you want to receive your funds after trades.</p>
          <form onSubmit={handleSaveSettlement}>
            <label>Method</label>
            <select value={settlementMethod} onChange={(e) => setSettlementMethod(e.target.value)}>
              <option value="mpesa">M-Pesa (B2C)</option>
              <option value="bank_paybill">Bank Account (via Bank Paybill)</option>
              <option value="till">Till Number (Buy Goods)</option>
              <option value="paybill">My Own Paybill</option>
            </select>

            {settlementMethod === 'mpesa' && (
              <>
                <label>M-Pesa Phone Number</label>
                <input
                  type="tel"
                  placeholder="0712345678"
                  value={settlementPhone}
                  onChange={(e) => setSettlementPhone(e.target.value)}
                  required
                />
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
                <input
                  type="text"
                  placeholder="Your bank account number"
                  value={bankAccount}
                  onChange={(e) => setBankAccount(e.target.value)}
                  required
                />
              </>
            )}

            {settlementMethod === 'till' && (
              <>
                <label>Till Number</label>
                <input
                  type="text"
                  placeholder="Your Till number"
                  value={customPaybill}
                  onChange={(e) => setCustomPaybill(e.target.value)}
                  required
                />
              </>
            )}

            {settlementMethod === 'paybill' && (
              <>
                <label>Paybill Number</label>
                <input
                  type="text"
                  placeholder="Your Paybill shortcode"
                  value={customPaybill}
                  onChange={(e) => setCustomPaybill(e.target.value)}
                  required
                />
                <label>Account Number</label>
                <input
                  type="text"
                  placeholder="Account number"
                  value={paybillAccount}
                  onChange={(e) => setPaybillAccount(e.target.value)}
                />
              </>
            )}

            <button type="submit" disabled={loading}>
              {loading ? 'Saving...' : 'Save Settlement Settings'}
            </button>
          </form>
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
