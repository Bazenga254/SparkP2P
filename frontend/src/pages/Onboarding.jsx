import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
  getProfile,
  connectBinance,
  updateSettlement,
  initiateSubscription,
  getSubscriptionStatus,
} from '../services/api';
import api from '../services/api';
import {
  Download,
  Link2,
  Banknote,
  CreditCard,
  Check,
  ChevronRight,
  ChevronLeft,
  Puzzle,
  Zap,
  Crown,
  PartyPopper,
} from 'lucide-react';

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

const STEPS = [
  { key: 'extension', title: 'Install Extension', icon: Puzzle },
  { key: 'binance', title: 'Connect Binance', icon: Link2 },
  { key: 'settlement', title: 'Settlement', icon: Banknote },
  { key: 'subscribe', title: 'Subscribe', icon: CreditCard },
];

export default function Onboarding() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();

  const [currentStep, setCurrentStep] = useState(0);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [completed, setCompleted] = useState(false);

  // Extension step
  const [extensionInstalled, setExtensionInstalled] = useState(false);

  // Binance step
  const [cookies, setCookies] = useState('');
  const [csrfToken, setCsrfToken] = useState('');
  const [totpSecret, setTotpSecret] = useState('');
  const [binanceLoading, setBinanceLoading] = useState(false);
  const [binanceMsg, setBinanceMsg] = useState(null);
  const [nameVerification, setNameVerification] = useState(null);

  // Settlement step
  const [settlementMethod, setSettlementMethod] = useState('mpesa');
  const [settlementPhone, setSettlementPhone] = useState('');
  const [selectedBank, setSelectedBank] = useState('');
  const [bankAccount, setBankAccount] = useState('');
  const [customPaybill, setCustomPaybill] = useState('');
  const [paybillAccount, setPaybillAccount] = useState('');
  const [settlementLoading, setSettlementLoading] = useState(false);
  const [settlementMsg, setSettlementMsg] = useState(null);
  const [settlementSaved, setSettlementSaved] = useState(false);

  // Subscribe step
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [subPhone, setSubPhone] = useState('');
  const [subLoading, setSubLoading] = useState(false);
  const [subPolling, setSubPolling] = useState(false);
  const [subMsg, setSubMsg] = useState(null);
  const [subError, setSubError] = useState(null);

  useEffect(() => {
    loadProfile();
  }, []);

  const loadProfile = async () => {
    try {
      const res = await getProfile();
      setProfile(res.data);
      if (res.data.onboarding_complete) {
        navigate('/dashboard');
        return;
      }
      // Determine starting step based on existing progress
      if (res.data.settlement_method) setSettlementSaved(true);
      if (res.data.subscription_plan) {
        // All done
        setCompleted(true);
      }
    } catch (err) {
      console.error('Failed to load profile', err);
    }
    setLoading(false);
  };

  const refreshProfile = async () => {
    try {
      const res = await getProfile();
      setProfile(res.data);
      setUser(res.data);
      return res.data;
    } catch (err) {
      return profile;
    }
  };

  // --- Step 1: Extension ---
  const handleExtensionInstalled = () => {
    setExtensionInstalled(true);
    setCurrentStep(1);
  };

  const handleSkipExtension = () => {
    setCurrentStep(1);
  };

  // --- Step 2: Binance ---
  const handleConnectBinance = async (e) => {
    e.preventDefault();
    setBinanceLoading(true);
    setBinanceMsg(null);
    try {
      const cookieObj = JSON.parse(cookies);
      const res = await connectBinance({
        cookies: cookieObj,
        csrf_token: csrfToken,
        totp_secret: totpSecret || null,
      });
      setNameVerification(res.data);
      setBinanceMsg({ type: 'success', text: 'Binance connected successfully!' });
      await refreshProfile();
    } catch (err) {
      setBinanceMsg({
        type: 'error',
        text: err.response?.data?.detail || 'Failed to connect Binance',
      });
    }
    setBinanceLoading(false);
  };

  // --- Step 3: Settlement ---
  const handleSaveSettlement = async (e) => {
    e.preventDefault();
    setSettlementLoading(true);
    setSettlementMsg(null);
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
      setSettlementMsg({ type: 'success', text: 'Settlement settings saved!' });
      setSettlementSaved(true);
      await refreshProfile();
    } catch (err) {
      setSettlementMsg({
        type: 'error',
        text: 'Failed to save settlement settings',
      });
    }
    setSettlementLoading(false);
  };

  // --- Step 4: Subscribe ---
  const handleSubscribe = async () => {
    if (!selectedPlan || !subPhone) {
      setSubError('Please select a plan and enter your M-Pesa phone number.');
      return;
    }
    setSubError(null);
    setSubMsg(null);
    setSubLoading(true);
    try {
      const res = await initiateSubscription(selectedPlan, subPhone);
      setSubMsg({ type: 'info', text: res.data.message });
      setSubPolling(true);
    } catch (err) {
      setSubError(err.response?.data?.detail || 'Failed to initiate payment.');
    }
    setSubLoading(false);
  };

  // Poll for subscription confirmation
  useEffect(() => {
    if (!subPolling) return;
    const interval = setInterval(async () => {
      try {
        const res = await getSubscriptionStatus();
        if (res.data.has_subscription) {
          setSubPolling(false);
          setSubMsg({ type: 'success', text: 'Subscription activated!' });
          await refreshProfile();
          setTimeout(() => setCompleted(true), 500);
        }
      } catch (err) {
        // keep polling
      }
    }, 5000);
    const timeout = setTimeout(() => {
      setSubPolling(false);
      setSubMsg({
        type: 'warning',
        text: 'Payment confirmation timeout. If you paid, refresh the page.',
      });
    }, 120000);
    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [subPolling]);

  const handleSkipSubscribe = async () => {
    setCompleted(true);
  };

  const handleGoToDashboard = () => {
    navigate('/dashboard');
  };

  const canAdvanceStep2 = profile?.binance_connected;
  const canAdvanceStep3 = settlementSaved || profile?.settlement_method;

  if (loading) {
    return (
      <div className="onb-container">
        <div className="loading">Loading...</div>
      </div>
    );
  }

  if (completed) {
    return (
      <div className="onb-container">
        <div className="onb-completion">
          <div className="onb-completion-icon">&#127881;</div>
          <h1>You're all set!</h1>
          <p>
            Your SparkP2P account is ready.
            {!profile?.subscription_plan && (
              <span className="onb-note">
                {' '}Note: Automation won't work until you subscribe.
              </span>
            )}
          </p>
          <button className="onb-btn-primary" onClick={handleGoToDashboard}>
            Go to Dashboard
            <ChevronRight size={18} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="onb-container">
      <div className="onb-header">
        <img src="/logo.png" alt="SparkP2P" className="onb-logo" />
        <h1>Setup Your Account</h1>
        <p>Complete these steps to start automating your P2P trades</p>
      </div>

      {/* Progress Bar */}
      <div className="onb-progress">
        {STEPS.map((step, i) => {
          const StepIcon = step.icon;
          let state = 'pending';
          if (i < currentStep) state = 'complete';
          else if (i === currentStep) state = 'active';
          return (
            <div key={step.key} className="onb-progress-item">
              <div
                className={`onb-step ${state}`}
                onClick={() => i <= currentStep && setCurrentStep(i)}
              >
                {state === 'complete' ? <Check size={16} /> : <StepIcon size={16} />}
              </div>
              <span className={`onb-step-label ${state}`}>{step.title}</span>
              {i < STEPS.length - 1 && <div className={`onb-step-line ${i < currentStep ? 'complete' : ''}`} />}
            </div>
          );
        })}
      </div>

      {/* Step Content */}
      <div className="onb-content">
        {/* Step 1: Extension */}
        {currentStep === 0 && (
          <div className="onb-step-content">
            <div className="onb-step-header">
              <Puzzle size={28} className="onb-step-icon" />
              <div>
                <h2>Install SparkP2P Extension</h2>
                <p>Install our Chrome extension for seamless Binance integration</p>
              </div>
            </div>

            <div className="onb-card">
              <div className="onb-ext-info">
                <div className="onb-ext-icon">
                  <Download size={32} />
                </div>
                <div>
                  <h3>SparkP2P Chrome Extension</h3>
                  <p>
                    The extension automatically syncs your Binance session, so you
                    never have to manually copy cookies. It runs in the background
                    and keeps your connection alive.
                  </p>
                </div>
              </div>
              <a
                href="https://chrome.google.com/webstore/detail/sparkp2p/placeholder"
                target="_blank"
                rel="noopener noreferrer"
                className="onb-btn-secondary"
              >
                <Download size={16} />
                Install from Chrome Web Store
              </a>
            </div>

            <div className="onb-actions">
              <button className="onb-btn-primary" onClick={handleExtensionInstalled}>
                I've installed it
                <ChevronRight size={18} />
              </button>
              <button className="onb-btn-link" onClick={handleSkipExtension}>
                Skip for now (manual setup)
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Connect Binance */}
        {currentStep === 1 && (
          <div className="onb-step-content">
            <div className="onb-step-header">
              <Link2 size={28} className="onb-step-icon" />
              <div>
                <h2>Connect Your Binance Account</h2>
                <p>Connect your Binance P2P account to start automating</p>
              </div>
            </div>

            {profile?.binance_connected ? (
              <div className="onb-card onb-success-card">
                <Check size={24} className="onb-success-icon" />
                <div>
                  <h3>Binance Connected</h3>
                  {profile.binance_username && (
                    <p>Connected as: <strong>{profile.binance_username}</strong></p>
                  )}
                </div>
              </div>
            ) : (
              <>
                {extensionInstalled && (
                  <div className="onb-card">
                    <h3>Option 1: Use Extension</h3>
                    <p>
                      Click the SparkP2P icon in your Chrome toolbar, then click
                      <strong> Sync</strong> to automatically connect your Binance
                      session.
                    </p>
                  </div>
                )}

                <div className="onb-card">
                  <h3>{extensionInstalled ? 'Option 2: Manual Setup' : 'Manual Setup'}</h3>
                  <p className="onb-help-text">
                    Open Binance P2P in Chrome, open DevTools (F12), go to Network tab,
                    perform any action, and copy the cookies and csrftoken from request headers.
                  </p>
                  <form onSubmit={handleConnectBinance} className="onb-form">
                    <label>Cookies (JSON format)</label>
                    <textarea
                      rows={4}
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
                    <label>2FA Secret (optional)</label>
                    <input
                      type="password"
                      placeholder="TOTP secret from authenticator setup"
                      value={totpSecret}
                      onChange={(e) => setTotpSecret(e.target.value)}
                    />
                    <button type="submit" className="onb-btn-primary" disabled={binanceLoading}>
                      {binanceLoading ? 'Connecting...' : 'Connect Binance'}
                    </button>
                  </form>
                </div>

                {binanceMsg && (
                  <div className={`onb-msg ${binanceMsg.type}`}>{binanceMsg.text}</div>
                )}

                {nameVerification && nameVerification.binance_name && !nameVerification.name_match && (
                  <div className="onb-card onb-warning-card">
                    <h4>Name Mismatch</h4>
                    <p>Registered: <strong>{nameVerification.registered_name}</strong></p>
                    <p>Binance: <strong>{nameVerification.binance_name}</strong></p>
                    <button
                      className="onb-btn-secondary"
                      onClick={async () => {
                        try {
                          await api.post('/traders/update-name');
                          setNameVerification({ ...nameVerification, name_match: true });
                          await refreshProfile();
                        } catch (err) {
                          // ignore
                        }
                      }}
                    >
                      Update to: {nameVerification.binance_name}
                    </button>
                  </div>
                )}
              </>
            )}

            <div className="onb-actions">
              <button className="onb-btn-ghost" onClick={() => setCurrentStep(0)}>
                <ChevronLeft size={18} />
                Back
              </button>
              <button
                className="onb-btn-primary"
                onClick={() => setCurrentStep(2)}
                disabled={!canAdvanceStep2}
              >
                Next
                <ChevronRight size={18} />
              </button>
              {!canAdvanceStep2 && (
                <button className="onb-btn-link" onClick={() => setCurrentStep(2)}>
                  Skip for now
                </button>
              )}
            </div>
          </div>
        )}

        {/* Step 3: Settlement */}
        {currentStep === 2 && (
          <div className="onb-step-content">
            <div className="onb-step-header">
              <Banknote size={28} className="onb-step-icon" />
              <div>
                <h2>How do you want to receive payments?</h2>
                <p>Choose where your earnings will be sent</p>
              </div>
            </div>

            {profile?.settlement_method && settlementSaved ? (
              <div className="onb-card onb-success-card">
                <Check size={24} className="onb-success-icon" />
                <div>
                  <h3>Settlement Configured</h3>
                  <p>
                    Method: <strong>{profile.settlement_method}</strong>
                    {profile.settlement_destination && (
                      <> &mdash; {profile.settlement_destination}</>
                    )}
                  </p>
                  <button
                    className="onb-btn-link"
                    onClick={() => setSettlementSaved(false)}
                    style={{ marginTop: 8 }}
                  >
                    Change settings
                  </button>
                </div>
              </div>
            ) : (
              <div className="onb-card">
                <form onSubmit={handleSaveSettlement} className="onb-form">
                  <label>Settlement Method</label>
                  <select
                    value={settlementMethod}
                    onChange={(e) => setSettlementMethod(e.target.value)}
                  >
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
                      <select
                        value={selectedBank}
                        onChange={(e) => setSelectedBank(e.target.value)}
                        required
                      >
                        <option value="">Select Bank</option>
                        {Object.keys(BANK_PAYBILLS).map((bank) => (
                          <option key={bank} value={bank}>
                            {bank} ({BANK_PAYBILLS[bank]})
                          </option>
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

                  {settlementMsg && (
                    <div className={`onb-msg ${settlementMsg.type}`}>
                      {settlementMsg.text}
                    </div>
                  )}

                  <button
                    type="submit"
                    className="onb-btn-primary"
                    disabled={settlementLoading}
                  >
                    {settlementLoading ? 'Saving...' : 'Save Settlement Settings'}
                  </button>
                </form>
              </div>
            )}

            <div className="onb-actions">
              <button className="onb-btn-ghost" onClick={() => setCurrentStep(1)}>
                <ChevronLeft size={18} />
                Back
              </button>
              <button
                className="onb-btn-primary"
                onClick={() => setCurrentStep(3)}
                disabled={!canAdvanceStep3}
              >
                Next
                <ChevronRight size={18} />
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Subscribe */}
        {currentStep === 3 && (
          <div className="onb-step-content">
            <div className="onb-step-header">
              <CreditCard size={28} className="onb-step-icon" />
              <div>
                <h2>Choose Your Plan</h2>
                <p>Select a plan to activate your automation</p>
              </div>
            </div>

            {profile?.subscription_plan ? (
              <div className="onb-card onb-success-card">
                <Check size={24} className="onb-success-icon" />
                <div>
                  <h3>Subscribed - {profile.subscription_plan} Plan</h3>
                  <p>Your automation is ready to go.</p>
                </div>
              </div>
            ) : (
              <>
                <div className="onb-plan-cards">
                  <div
                    className={`onb-plan-card ${selectedPlan === 'starter' ? 'selected' : ''}`}
                    onClick={() => setSelectedPlan('starter')}
                  >
                    <div className="onb-plan-icon">
                      <Zap size={24} />
                    </div>
                    <h3>Starter</h3>
                    <div className="onb-plan-price">
                      <span className="onb-price-amount">KES 5,000</span>
                      <span className="onb-price-period">/month</span>
                    </div>
                    <ul className="onb-plan-features">
                      <li><Check size={14} /> Sell-side automation</li>
                      <li><Check size={14} /> Auto crypto release</li>
                      <li><Check size={14} /> Payment matching</li>
                      <li><Check size={14} /> Chat notifications</li>
                    </ul>
                    <div className="onb-plan-select">
                      {selectedPlan === 'starter' ? 'Selected' : 'Select'}
                    </div>
                  </div>

                  <div
                    className={`onb-plan-card pro ${selectedPlan === 'pro' ? 'selected' : ''}`}
                    onClick={() => setSelectedPlan('pro')}
                  >
                    <div className="onb-plan-badge">Popular</div>
                    <div className="onb-plan-icon">
                      <Crown size={24} />
                    </div>
                    <h3>Pro</h3>
                    <div className="onb-plan-price">
                      <span className="onb-price-amount">KES 10,000</span>
                      <span className="onb-price-period">/month</span>
                    </div>
                    <ul className="onb-plan-features">
                      <li><Check size={14} /> Everything in Starter</li>
                      <li><Check size={14} /> Buy-side auto-pay</li>
                      <li><Check size={14} /> Priority settlement</li>
                      <li><Check size={14} /> Advanced analytics</li>
                      <li><Check size={14} /> Priority support</li>
                    </ul>
                    <div className="onb-plan-select">
                      {selectedPlan === 'pro' ? 'Selected' : 'Select'}
                    </div>
                  </div>
                </div>

                {selectedPlan && (
                  <div className="onb-card onb-pay-card">
                    <h3>Pay with M-Pesa</h3>
                    <p className="onb-pay-summary">
                      {selectedPlan === 'pro' ? 'Pro' : 'Starter'} Plan &mdash; KES{' '}
                      {selectedPlan === 'pro' ? '10,000' : '5,000'}
                    </p>
                    <div className="onb-form">
                      <label>M-Pesa Phone Number</label>
                      <input
                        type="tel"
                        placeholder="e.g. 0712345678"
                        value={subPhone}
                        onChange={(e) => setSubPhone(e.target.value)}
                        disabled={subLoading || subPolling}
                      />
                    </div>

                    {subError && <div className="onb-msg error">{subError}</div>}
                    {subMsg && (
                      <div className={`onb-msg ${subMsg.type}`}>{subMsg.text}</div>
                    )}

                    <button
                      className="onb-btn-primary onb-pay-btn"
                      onClick={handleSubscribe}
                      disabled={subLoading || subPolling || !subPhone}
                    >
                      {subPolling
                        ? 'Waiting for payment...'
                        : subLoading
                        ? 'Sending STK Push...'
                        : `Pay KES ${selectedPlan === 'pro' ? '10,000' : '5,000'}`}
                    </button>

                    {subPolling && (
                      <p className="onb-polling-hint">
                        Check your phone for the M-Pesa prompt. Enter your PIN to
                        complete payment.
                      </p>
                    )}
                  </div>
                )}
              </>
            )}

            <div className="onb-actions">
              <button className="onb-btn-ghost" onClick={() => setCurrentStep(2)}>
                <ChevronLeft size={18} />
                Back
              </button>
              {profile?.subscription_plan ? (
                <button className="onb-btn-primary" onClick={() => setCompleted(true)}>
                  Finish Setup
                  <ChevronRight size={18} />
                </button>
              ) : (
                <button className="onb-btn-link" onClick={handleSkipSubscribe}>
                  Subscribe Later
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
