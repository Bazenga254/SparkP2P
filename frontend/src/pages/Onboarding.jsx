import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
  getProfile,
  connectBinance,
  updateSettlement,
  updateVerification,
  initiateSubscription,
  getSubscriptionStatus,
  getTotpSetup,
  verifyAndSaveTotp,
} from '../services/api';
import { QRCodeSVG } from 'qrcode.react';
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
  Shield,
  Key,
  Lock,
  Smartphone,
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
  { key: 'extension', title: 'Install App', icon: Download },
  { key: 'binance', title: 'Connect Binance', icon: Link2 },
  { key: 'verification', title: 'Verification', icon: Shield },
  { key: 'settlement', title: 'Settlement', icon: Banknote },
  { key: 'authenticator', title: '2FA Setup', icon: Smartphone },
  { key: 'im_pin', title: 'I&M PIN', icon: Shield },
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

  // Verification step
  const [verifyMethod, setVerifyMethod] = useState('fund_password');
  const [fundPassword, setFundPassword] = useState('');

  // Settlement step
  const [settlementMethod, setSettlementMethod] = useState('mpesa');
  const [settlementPhone, setSettlementPhone] = useState('');
  const [selectedBank, setSelectedBank] = useState('');
  const [bankAccount, setBankAccount] = useState('');
  const [bankAccountName, setBankAccountName] = useState('');
  const [nameVerified, setNameVerified] = useState(null); // null, true, false
  const [mpesaVerifying, setMpesaVerifying] = useState(false);
  const [mpesaName, setMpesaName] = useState(null); // { name, match }
  const [mpesaVerifyMsg, setMpesaVerifyMsg] = useState('');
  const [verifyAttempts, setVerifyAttempts] = useState(parseInt(localStorage.getItem('sparkp2p_verify_attempts') || '0'));
  const [accountSuspended, setAccountSuspended] = useState(localStorage.getItem('sparkp2p_suspended') === 'true');
  const [customPaybill, setCustomPaybill] = useState('');
  const [paybillAccount, setPaybillAccount] = useState('');
  const [settlementLoading, setSettlementLoading] = useState(false);
  const [settlementMsg, setSettlementMsg] = useState(null);
  const [settlementSaved, setSettlementSaved] = useState(false);

  // Security setup step (security question + Google Authenticator — both mandatory)
  const [secSubStep, setSecSubStep] = useState('question'); // 'question' | 'totp'
  const [sqQuestion, setSqQuestion] = useState('');
  const [sqAnswer, setSqAnswer] = useState('');
  const [sqSaving, setSqSaving] = useState(false);
  const [sqMsg, setSqMsg] = useState('');
  const [sqDone, setSqDone] = useState(false);
  const [totpSetupData, setTotpSetupData] = useState(null); // { secret, uri }
  const [totpSetupLoading, setTotpSetupLoading] = useState(false);
  const [totpSetupCode, setTotpSetupCode] = useState('');
  const [totpSetupMsg, setTotpSetupMsg] = useState('');
  const [totpSetupSaving, setTotpSetupSaving] = useState(false);
  const [totpSetupDone, setTotpSetupDone] = useState(false);

  // I&M PIN step
  const [onbImPin, setOnbImPin] = useState('');
  const [onbImPinSaved, setOnbImPinSaved] = useState(false);
  const [onbImPinSaving, setOnbImPinSaving] = useState(false);
  const [onbImPinMsg, setOnbImPinMsg] = useState('');

  const handleSaveOnbImPin = async () => {
    if (!onbImPin || onbImPin.length < 4) { setOnbImPinMsg('PIN must be at least 4 digits.'); return; }
    if (!window.sparkp2p?.saveImPin) { setOnbImPinMsg('PIN can only be saved from the desktop app.'); return; }
    setOnbImPinSaving(true);
    setOnbImPinMsg('');
    try {
      await window.sparkp2p.saveImPin(onbImPin);
      setOnbImPinSaved(true);
      setOnbImPin('');
      setOnbImPinMsg('PIN saved securely on this device.');
    } catch { setOnbImPinMsg('Failed to save PIN. Please try again.'); }
    setOnbImPinSaving(false);
  };

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

  // Auto-poll profile on Binance step to detect extension sync
  useEffect(() => {
    if (currentStep === 1 && profile && !profile.binance_connected) {
      const interval = setInterval(async () => {
        try {
          const res = await getProfile();
          setProfile(res.data);
          if (res.data.binance_connected) {
            clearInterval(interval);
          }
        } catch {}
      }, 3000); // Check every 3 seconds
      return () => clearInterval(interval);
    }
  }, [currentStep, profile?.binance_connected]);

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
    navigate('/dashboard?scanning=1');
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
          <p>Your SparkP2P account is ready. Start automating your trades.</p>
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
              <Download size={28} className="onb-step-icon" />
              <div>
                <h2>Download SparkP2P Desktop App</h2>
                <p>Install our desktop app to automate your Binance P2P trading</p>
              </div>
            </div>

            <div className="onb-card">
              <div className="onb-ext-info">
                <div className="onb-ext-icon">
                  <Zap size={32} />
                </div>
                <div>
                  <h3>SparkP2P for Windows</h3>
                  <p>
                    The desktop app connects to your Chrome browser, logs into Binance,
                    and trades automatically 24/7.
                  </p>
                </div>
              </div>
              <a
                href="https://sparkp2p.com/SparkP2P-Setup.exe"
                download
                className="onb-btn-secondary"
              >
                <Download size={16} />
                Download for Windows
              </a>
              <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 10, lineHeight: 1.6 }}>
                <strong>How to install:</strong><br />
                1. Download and run SparkP2P-Setup.exe<br />
                2. If Chrome blocks the download, click <strong>⋮ → Keep</strong><br />
                3. Open SparkP2P and log in with your account<br />
                4. Click <strong>Connect Binance</strong> — Chrome opens automatically<br />
                5. Log into Binance — the bot takes over
              </div>
            </div>

            <div className="onb-actions">
              <button className="onb-btn-primary" onClick={handleExtensionInstalled}>
                I've installed it
                <ChevronRight size={18} />
              </button>
              <button className="onb-btn-link" onClick={handleSkipExtension}>
                Skip for now
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
                <div className="onb-card">
                  <div className="onb-ext-info">
                    <div className="onb-ext-icon">
                      <Zap size={32} />
                    </div>
                    <div>
                      <h3>Connect via Desktop App</h3>
                      <p>
                        Open the SparkP2P desktop app, click <strong>Connect Binance</strong>,
                        and log into your Binance account in the Chrome window that opens.
                        The bot will detect your login and start automatically.
                      </p>
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 12, lineHeight: 1.6 }}>
                    <strong>Steps:</strong><br />
                    1. Open SparkP2P desktop app<br />
                    2. Go to <strong>Settings → Binance → Connect Binance</strong><br />
                    3. Chrome opens — log into Binance (Google, email, etc.)<br />
                    4. Bot detects login and starts trading automatically
                  </div>
                  <a
                    href="https://sparkp2p.com/SparkP2P-Setup.exe"
                    download
                    className="onb-btn-secondary"
                    style={{ marginTop: 16 }}
                  >
                    <Download size={16} />
                    Download Desktop App
                  </a>
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

        {/* Step 3: Verification */}
        {currentStep === 2 && (
          <div className="onb-step-content">
            <div className="onb-step-header">
              <Shield size={28} className="onb-step-icon" />
              <div>
                <h2>Release Verification</h2>
                <p>How do you verify releases on Binance?</p>
              </div>
            </div>

            <div className="onb-card">
              <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 16 }}>
                When releasing crypto on Binance P2P, a verification step is required. Choose your method so we can automate it.
              </p>

              {[
                { value: 'fund_password', icon: Lock, title: 'Fund Password', desc: 'Your Binance trade/fund password (4-6 digit PIN)', recommended: true },
                { value: 'totp', icon: Smartphone, title: 'Google Authenticator (TOTP)', desc: 'Auto-generate 2FA codes. Requires your TOTP secret key.' },
              ].map((option) => (
                <div
                  key={option.value}
                  className={`onb-verify-option ${verifyMethod === option.value ? 'selected' : ''}`}
                  onClick={() => setVerifyMethod(option.value)}
                >
                  <div className="onb-verify-option-left">
                    <option.icon size={20} />
                    <div>
                      <strong>{option.title}</strong>
                      {option.recommended && <span className="onb-verify-badge">Recommended</span>}
                      <p>{option.desc}</p>
                    </div>
                  </div>
                  <div className={`onb-verify-radio ${verifyMethod === option.value ? 'checked' : ''}`} />
                </div>
              ))}

              {verifyMethod === 'fund_password' && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ background: '#1a1d27', border: '1px solid #2a2d3a', borderRadius: 10, padding: 16, marginBottom: 16 }}>
                    <strong style={{ color: '#f59e0b', fontSize: 14 }}>How to find your Fund Password:</strong>
                    <ol style={{ fontSize: 12, color: '#9ca3af', marginTop: 8, paddingLeft: 18, lineHeight: 1.8 }}>
                      <li>Open <strong style={{ color: '#e4e4e7' }}>Binance App</strong> or website</li>
                      <li>Go to <strong style={{ color: '#e4e4e7' }}>Profile → Security</strong></li>
                      <li>Look for <strong style={{ color: '#e4e4e7' }}>Fund Password</strong> (also called Trade Password)</li>
                      <li>If not set up, click <strong style={{ color: '#e4e4e7' }}>Create Fund Password</strong> and set a 6-digit PIN</li>
                      <li>Enter that same PIN below</li>
                    </ol>
                    <p style={{ fontSize: 11, color: '#6b7280', marginTop: 8 }}>This is the PIN Binance asks when you release crypto. Not your login password.</p>
                  </div>
                  <label style={{ display: 'block', fontSize: 13, color: '#9ca3af', marginBottom: 4 }}>Fund Password</label>
                  <input
                    type="password"
                    placeholder="Enter your 6-digit fund password"
                    value={fundPassword}
                    onChange={(e) => setFundPassword(e.target.value)}
                    className="onb-input"
                    maxLength={6}
                  />
                  <p style={{ fontSize: 11, color: '#10b981', marginTop: 4 }}>🔒 Stored securely with encryption. Never shared with anyone.</p>
                  <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 8, padding: 10, marginTop: 10 }}>
                    <p style={{ fontSize: 11, color: '#ef4444' }}>⚠️ <strong>Important:</strong> Make sure this is the exact PIN you enter when releasing crypto on Binance. If incorrect, auto-release will be disabled until you update it and your payments will delay.</p>
                  </div>
                </div>
              )}

              {verifyMethod === 'totp' && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ background: '#1a1d27', border: '1px solid #2a2d3a', borderRadius: 10, padding: 16, marginBottom: 16 }}>
                    <strong style={{ color: '#f59e0b', fontSize: 14 }}>How to get your TOTP Secret Key:</strong>
                    <ol style={{ fontSize: 12, color: '#9ca3af', marginTop: 8, paddingLeft: 18, lineHeight: 1.8 }}>
                      <li>Open <strong style={{ color: '#e4e4e7' }}>Binance App</strong> → <strong style={{ color: '#e4e4e7' }}>Profile → Security</strong></li>
                      <li>Click <strong style={{ color: '#e4e4e7' }}>Google Authenticator → Manage</strong></li>
                      <li>Click <strong style={{ color: '#e4e4e7' }}>Change Authenticator</strong> or <strong style={{ color: '#e4e4e7' }}>Reset</strong></li>
                      <li>Binance will show a <strong style={{ color: '#e4e4e7' }}>QR code</strong> and a text key below it</li>
                      <li>Copy the <strong style={{ color: '#e4e4e7' }}>text key</strong> (looks like: JBSWY3DPEHPK3PXP)</li>
                      <li>Scan the QR code with Google Authenticator as normal</li>
                      <li>Paste the text key below</li>
                    </ol>
                    <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 8, padding: 10, marginTop: 10 }}>
                      <p style={{ fontSize: 11, color: '#ef4444' }}>⚠️ If you already set up Google Authenticator and didn't save the key, you'll need to reset it on Binance to see the key again. Consider using Fund Password instead — it's simpler.</p>
                    </div>
                  </div>
                  <label style={{ display: 'block', fontSize: 13, color: '#9ca3af', marginBottom: 4 }}>TOTP Secret Key</label>
                  <input
                    type="password"
                    placeholder="e.g. JBSWY3DPEHPK3PXP"
                    value={totpSecret}
                    onChange={(e) => setTotpSecret(e.target.value)}
                    className="onb-input"
                  />
                  <p style={{ fontSize: 11, color: '#10b981', marginTop: 4 }}>🔒 Stored securely with encryption. Never shared with anyone.</p>
                </div>
              )}

            </div>

            <div className="onb-actions">
              <button className="onb-btn-primary" onClick={async () => {
                if (verifyMethod === 'fund_password' && !fundPassword) {
                  return;
                }
                if (verifyMethod === 'totp' && !totpSecret) {
                  return;
                }
                try {
                  await updateVerification({
                    verify_method: verifyMethod,
                    totp_secret: verifyMethod === 'totp' ? totpSecret : null,
                    fund_password: verifyMethod === 'fund_password' ? fundPassword : null,
                  });
                  setCurrentStep(3);
                } catch (err) {
                  console.error('Verification save failed:', err);
                }
              }}>
                Next <ChevronRight size={16} />
              </button>
              <button className="onb-btn-text" onClick={() => setCurrentStep(3)}>
                Skip for now
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Settlement */}
        {currentStep === 3 && (
          <div className="onb-step-content">
            <div className="onb-step-header">
              <Banknote size={28} className="onb-step-icon" />
              <div>
                <h2>How do you want to receive payments?</h2>
                <p>Choose where your earnings will be sent</p>
              </div>
            </div>

            {profile?.settlement_method && profile?.settlement_phone_verified && settlementSaved ? (
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
                    <option value="mpesa">M-Pesa</option>
                    <option value="bank_paybill">I&M Bank Account</option>
                  </select>

                  {accountSuspended && (
                    <div style={{ padding: 16, background: 'rgba(239,68,68,0.1)', border: '1px solid #ef4444', borderRadius: 10, color: '#ef4444', textAlign: 'center' }}>
                      <strong>Account Suspended</strong>
                      <p style={{ marginTop: 8, fontSize: 13 }}>
                        Your account has been suspended due to 3 failed settlement verification attempts.
                        Contact support at <strong>support@sparkp2p.com</strong> to resolve this.
                      </p>
                    </div>
                  )}

                  {!accountSuspended && settlementMethod === 'mpesa' && (
                    <>
                      {verifyAttempts > 0 && verifyAttempts < 3 && (
                        <div style={{ padding: '8px 12px', background: 'rgba(239,68,68,0.1)', borderRadius: 8, fontSize: 13, color: '#ef4444', marginBottom: 8 }}>
                          Warning: {3 - verifyAttempts} attempt{3 - verifyAttempts === 1 ? '' : 's'} remaining. Your account will be permanently suspended after 3 failed verifications.
                        </div>
                      )}
                      <label>M-Pesa Phone Number</label>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <input
                          type="tel"
                          placeholder="0712345678"
                          value={settlementPhone}
                          onChange={(e) => { setSettlementPhone(e.target.value); setMpesaName(null); setMpesaVerifyMsg(''); }}
                          required
                          style={{ flex: 1 }}
                        />
                        <button
                          type="button"
                          className="onb-btn-secondary"
                          style={{ padding: '8px 16px', whiteSpace: 'nowrap' }}
                          disabled={mpesaVerifying || !settlementPhone || settlementPhone.length < 10}
                          onClick={async () => {
                            setMpesaVerifying(true);
                            setMpesaName(null);
                            setMpesaVerifyMsg('Sending KES 1 to verify...');
                            try {
                              const token = localStorage.getItem('token');
                              const res = await fetch('/api/traders/verify-phone', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                                body: JSON.stringify({ phone: settlementPhone }),
                              });
                              if (!res.ok) { const d = await res.json(); setMpesaVerifyMsg(d.detail || 'Failed'); setMpesaVerifying(false); return; }
                              setMpesaVerifyMsg('KES 1 sent. Waiting for M-Pesa confirmation...');

                              // Poll for result every 3 seconds, up to 30 seconds
                              let attempts = 0;
                              const poll = setInterval(async () => {
                                attempts++;
                                if (attempts > 10) { clearInterval(poll); setMpesaVerifying(false); setMpesaVerifyMsg('Timeout — try again'); return; }
                                const r = await fetch(`/api/traders/verify-phone/result?phone=${settlementPhone}`, {
                                  headers: { 'Authorization': `Bearer ${token}` },
                                });
                                const d = await r.json();
                                if (d.status === 'verified') {
                                  clearInterval(poll);
                                  setMpesaVerifying(false);
                                  setMpesaName({ name: d.mpesa_name, match: d.name_match });
                                  setMpesaVerifyMsg('');
                                  if (!d.name_match) {
                                    const newAttempts = verifyAttempts + 1;
                                    setVerifyAttempts(newAttempts);
                                    localStorage.setItem('sparkp2p_verify_attempts', String(newAttempts));
                                    if (newAttempts >= 3) {
                                      setAccountSuspended(true);
                                      localStorage.setItem('sparkp2p_suspended', 'true');
                                      // Notify backend to suspend account
                                      fetch('/api/traders/suspend-self', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                                        body: JSON.stringify({ reason: 'Settlement verification failed 3 times — name mismatch' }),
                                      }).catch(() => {});
                                    }
                                  } else {
                                    // Reset attempts on success
                                    setVerifyAttempts(0);
                                    localStorage.setItem('sparkp2p_verify_attempts', '0');
                                  }
                                }
                              }, 3000);
                            } catch (e) {
                              setMpesaVerifyMsg('Error: ' + e.message);
                              setMpesaVerifying(false);
                            }
                          }}
                        >
                          {mpesaVerifying ? 'Verifying...' : 'Verify'}
                        </button>
                      </div>

                      {mpesaVerifyMsg && (
                        <div style={{ fontSize: 12, color: '#f59e0b', marginTop: 4 }}>{mpesaVerifyMsg}</div>
                      )}

                      {mpesaName && mpesaName.match && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', background: 'rgba(16,185,129,0.1)', borderRadius: 8, fontSize: 13, color: '#10b981', marginTop: 8 }}>
                          <Check size={16} />
                          M-Pesa name: <strong>{mpesaName.name}</strong> — matches your account
                        </div>
                      )}
                      {mpesaName && !mpesaName.match && (
                        <div style={{ padding: '8px 12px', background: 'rgba(239,68,68,0.1)', borderRadius: 8, fontSize: 13, color: '#ef4444', marginTop: 8 }}>
                          <strong>Name mismatch!</strong> M-Pesa name: <strong>{mpesaName.name}</strong><br />
                          Your registered name: <strong>{profile?.full_name}</strong>. Settlement phone must be registered under your name.
                        </div>
                      )}

                      <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>
                        We send KES 10 to verify the phone is registered under your name.
                      </div>
                    </>
                  )}

                  {!accountSuspended && settlementMethod === 'bank_paybill' && (
                    <>
                      <label>I&M Bank Account Number</label>
                      <input
                        type="text"
                        placeholder="Your I&M Bank account number"
                        value={bankAccount}
                        onChange={(e) => { setBankAccount(e.target.value); setNameVerified(null); }}
                        required
                      />

                      <label>Account Holder Name (as on bank statement)</label>
                      <input
                        type="text"
                        placeholder="BONITO CHELUGET SAMOEI"
                        value={bankAccountName}
                        onChange={(e) => {
                          const val = e.target.value.toUpperCase();
                          setBankAccountName(val);
                          // Auto-compare with registered name
                          if (val.length > 3 && profile?.full_name) {
                            const registered = profile.full_name.toUpperCase().trim();
                            const entered = val.trim();
                            // Check if names match (allow partial — first+last name match)
                            const regParts = registered.split(/\s+/);
                            const entParts = entered.split(/\s+/);
                            const matchCount = regParts.filter(p => entParts.includes(p)).length;
                            setNameVerified(matchCount >= 2 || registered === entered);
                          } else {
                            setNameVerified(null);
                          }
                        }}
                        required
                        style={{ textTransform: 'uppercase' }}
                      />

                      {/* Name verification result */}
                      {nameVerified === true && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', background: 'rgba(16,185,129,0.1)', borderRadius: 8, fontSize: 13, color: '#10b981', marginTop: 4 }}>
                          <Check size={16} />
                          Name matches your registered name: <strong>{profile?.full_name}</strong>
                        </div>
                      )}
                      {nameVerified === false && (
                        <div style={{ padding: '8px 12px', background: 'rgba(239,68,68,0.1)', borderRadius: 8, fontSize: 13, color: '#ef4444', marginTop: 4 }}>
                          <strong>Name mismatch!</strong> Your registered name is <strong>{profile?.full_name}</strong>.
                          Bank account name must match your Binance KYC name for security.
                        </div>
                      )}

                      <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>
                        Settlements are sent to your I&M account or M-Pesa for free. Fees: KES 10-50 depending on amount.
                      </div>
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
                onClick={() => {
                  setCurrentStep(4);
                  // Auto-generate QR on entering step
                  if (!totpSetupData && !totpSetupDone) {
                    setTotpSetupLoading(true);
                    getTotpSetup().then(r => setTotpSetupData(r.data)).catch(() => {}).finally(() => setTotpSetupLoading(false));
                  }
                }}
                disabled={!canAdvanceStep3}
              >
                Continue
                <ChevronRight size={18} />
              </button>
            </div>
          </div>
        )}

        {/* ── Step 5: Security Setup (mandatory — security question + Google Authenticator) ── */}
        {currentStep === 4 && (
          <div className="onb-step-content">
            <div className="onb-step-header">
              <Smartphone size={28} className="onb-step-icon" />
              <h2>Security Setup</h2>
              <p>Both steps below are required before you can access your account.</p>
            </div>

            {/* Progress pills */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 28, justifyContent: 'center' }}>
              {[['question', '1. Security Question'], ['totp', '2. Google Authenticator']].map(([key, label]) => {
                const done = key === 'question' ? sqDone : totpSetupDone;
                const active = secSubStep === key;
                return (
                  <div key={key} style={{
                    padding: '6px 16px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                    background: done ? 'rgba(16,185,129,0.15)' : active ? 'rgba(245,158,11,0.15)' : 'rgba(255,255,255,0.05)',
                    color: done ? '#10b981' : active ? '#f59e0b' : '#6b7280',
                    border: `1px solid ${done ? 'rgba(16,185,129,0.3)' : active ? 'rgba(245,158,11,0.3)' : 'rgba(255,255,255,0.08)'}`,
                  }}>
                    {done ? '✓ ' : ''}{label}
                  </div>
                );
              })}
            </div>

            {/* ── Sub-step 1: Security Question ── */}
            {secSubStep === 'question' && (
              <div>
                {sqDone ? (
                  <div style={{ textAlign: 'center', padding: '16px 0 24px' }}>
                    <div style={{ fontSize: 40, marginBottom: 8 }}>✅</div>
                    <p style={{ color: '#10b981', fontWeight: 600 }}>Security question saved!</p>
                  </div>
                ) : (
                  <div>
                    <p style={{ fontSize: 14, color: '#9ca3af', marginBottom: 20 }}>
                      This question is used to verify your identity when performing sensitive actions like pausing the bot.
                    </p>
                    <div style={{ marginBottom: 14 }}>
                      <label style={{ fontSize: 13, color: '#9ca3af', display: 'block', marginBottom: 6 }}>Security Question</label>
                      <select
                        value={sqQuestion} onChange={e => setSqQuestion(e.target.value)}
                        style={{ width: '100%', padding: '11px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: '#0d0f1e', color: sqQuestion ? '#fff' : '#6b7280', fontSize: 14, boxSizing: 'border-box' }}>
                        <option value="">— Choose a question —</option>
                        <option>What is your mother's maiden name?</option>
                        <option>What was the name of your first pet?</option>
                        <option>What city were you born in?</option>
                        <option>What was the name of your primary school?</option>
                        <option>What is your oldest sibling's middle name?</option>
                        <option>What was the make of your first car?</option>
                      </select>
                    </div>
                    <div style={{ marginBottom: 16 }}>
                      <label style={{ fontSize: 13, color: '#9ca3af', display: 'block', marginBottom: 6 }}>Your Answer</label>
                      <input
                        type="text" placeholder="Answer (case-insensitive)"
                        value={sqAnswer} onChange={e => setSqAnswer(e.target.value)}
                        style={{ width: '100%', padding: '11px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: '#0d0f1e', color: '#fff', fontSize: 14, boxSizing: 'border-box' }}
                      />
                    </div>
                    {sqMsg && <p style={{ fontSize: 12, color: '#ef4444', marginBottom: 10 }}>{sqMsg}</p>}
                    <button
                      className="onb-btn-primary"
                      disabled={sqSaving || !sqQuestion || !sqAnswer.trim()}
                      style={{ width: '100%', opacity: !sqQuestion || !sqAnswer.trim() ? 0.5 : 1 }}
                      onClick={async () => {
                        setSqSaving(true); setSqMsg('');
                        try {
                          await api.post('/traders/security-question', { security_question: sqQuestion, security_answer: sqAnswer.trim() });
                          setSqDone(true);
                          // Auto-advance to TOTP sub-step
                          setTimeout(() => {
                            setSecSubStep('totp');
                            if (!totpSetupData) {
                              setTotpSetupLoading(true);
                              getTotpSetup().then(r => setTotpSetupData(r.data)).catch(() => {}).finally(() => setTotpSetupLoading(false));
                            }
                          }, 800);
                        } catch (err) {
                          setSqMsg(err.response?.data?.detail || 'Failed to save. Try again.');
                        }
                        setSqSaving(false);
                      }}
                    >
                      {sqSaving ? 'Saving...' : 'Save & Continue'}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ── Sub-step 2: Google Authenticator ── */}
            {secSubStep === 'totp' && (
              <div>
                {totpSetupDone ? (
                  <div style={{ textAlign: 'center', padding: '16px 0 24px' }}>
                    <div style={{ fontSize: 40, marginBottom: 8 }}>✅</div>
                    <p style={{ color: '#10b981', fontWeight: 600 }}>Google Authenticator linked!</p>
                    <p style={{ color: '#9ca3af', fontSize: 13, marginTop: 4 }}>Your account is fully secured. You can now access your dashboard.</p>
                  </div>
                ) : (
                  <div>
                    {totpSetupLoading ? (
                      <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>Generating QR code...</div>
                    ) : totpSetupData ? (
                      <div>
                        <p style={{ fontSize: 14, color: '#9ca3af', marginBottom: 20, textAlign: 'center' }}>
                          Open <strong style={{ color: '#fff' }}>Google Authenticator</strong> on your phone, tap <strong style={{ color: '#fff' }}>+</strong> → Scan QR code.
                        </p>
                        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
                          <div style={{ background: '#fff', padding: 16, borderRadius: 12 }}>
                            <QRCodeSVG value={totpSetupData.uri} size={200} />
                          </div>
                        </div>
                        <div style={{ padding: '12px 16px', background: 'rgba(255,255,255,0.04)', borderRadius: 10, border: '1px solid rgba(255,255,255,0.08)', marginBottom: 20, textAlign: 'center' }}>
                          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Can't scan? Enter this key manually in Google Authenticator:</div>
                          <div style={{ fontFamily: 'monospace', fontSize: 14, color: '#f59e0b', letterSpacing: 2, wordBreak: 'break-all' }}>{totpSetupData.secret}</div>
                        </div>
                        <label style={{ fontSize: 13, color: '#9ca3af', display: 'block', marginBottom: 8, textAlign: 'center' }}>
                          Enter the 6-digit code from Google Authenticator
                        </label>
                        <input
                          type="text" inputMode="numeric" maxLength={6} placeholder="000000"
                          value={totpSetupCode} onChange={e => setTotpSetupCode(e.target.value.replace(/\D/g, ''))}
                          style={{ width: '100%', padding: '14px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.15)', background: '#0d0f1e', color: '#fff', fontSize: 24, letterSpacing: 8, textAlign: 'center', boxSizing: 'border-box', marginBottom: 12 }}
                        />
                        {totpSetupMsg && <p style={{ fontSize: 13, color: '#ef4444', textAlign: 'center', marginBottom: 10 }}>{totpSetupMsg}</p>}
                        <button
                          className="onb-btn-primary"
                          disabled={totpSetupSaving || totpSetupCode.length !== 6}
                          style={{ width: '100%', opacity: totpSetupCode.length !== 6 ? 0.5 : 1 }}
                          onClick={async () => {
                            setTotpSetupSaving(true); setTotpSetupMsg('');
                            try {
                              await verifyAndSaveTotp({ secret: totpSetupData.secret, code: totpSetupCode });
                              setTotpSetupDone(true);
                            } catch (err) {
                              setTotpSetupMsg(err.response?.data?.detail || 'Invalid code. Try again.');
                            }
                            setTotpSetupSaving(false);
                          }}
                        >
                          {totpSetupSaving ? 'Verifying...' : 'Confirm & Link Authenticator'}
                        </button>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            )}

            <div className="onb-actions" style={{ marginTop: 28 }}>
              <button className="onb-btn-ghost" onClick={() => secSubStep === 'totp' && sqDone ? setSecSubStep('question') : setCurrentStep(3)}>
                <ChevronLeft size={18} />
                Back
              </button>
              <button
                className="onb-btn-primary"
                disabled={!sqDone || !totpSetupDone}
                style={{ opacity: sqDone && totpSetupDone ? 1 : 0.4, cursor: sqDone && totpSetupDone ? 'pointer' : 'not-allowed' }}
                onClick={() => setCurrentStep(5)}
              >
                Next
                <ChevronRight size={18} />
              </button>
            </div>
            {(!sqDone || !totpSetupDone) && (
              <p style={{ textAlign: 'center', fontSize: 12, color: '#6b7280', marginTop: 10 }}>
                Both security question and Google Authenticator must be completed to continue.
              </p>
            )}
          </div>
        )}

        {/* Step 6: I&M Online Banking PIN */}
        {currentStep === 5 && (
          <div className="onb-step-content">
            <div style={{ textAlign: 'center', marginBottom: 28 }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>🏦</div>
              <h2>Set Your I&amp;M Online Banking PIN</h2>
              <p style={{ color: '#9ca3af', fontSize: 14, maxWidth: 440, margin: '8px auto 0' }}>
                The bot uses this PIN to authorise payments on your behalf. It is encrypted using your OS keychain and stored <strong style={{ color: '#e4e4e7' }}>only on this device</strong> — never on our servers.
              </p>
            </div>

            <div style={{ maxWidth: 420, margin: '0 auto' }}>
              {onbImPinSaved ? (
                <div style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: 12, padding: 20, textAlign: 'center', marginBottom: 20 }}>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>✅</div>
                  <p style={{ color: '#10b981', fontWeight: 600, margin: 0 }}>PIN saved securely on this device</p>
                  <p style={{ color: '#6b7280', fontSize: 12, marginTop: 4 }}>You can change it anytime in Settings.</p>
                </div>
              ) : (
                <div style={{ background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 12, padding: 20, marginBottom: 20 }}>
                  <label style={{ display: 'block', fontSize: 13, color: '#9ca3af', marginBottom: 8 }}>Enter your I&amp;M Online Banking PIN</label>
                  <input
                    type="password"
                    placeholder="PIN (dots only — never shown)"
                    value={onbImPin}
                    onChange={e => { setOnbImPin(e.target.value); setOnbImPinMsg(''); }}
                    maxLength={8} inputMode="numeric"
                    className="onb-input"
                    style={{ width: '100%', letterSpacing: '0.3em', marginBottom: 12 }}
                    onKeyDown={e => e.key === 'Enter' && handleSaveOnbImPin()}
                  />
                  <button
                    className="onb-btn-primary"
                    style={{ width: '100%', opacity: onbImPinSaving || !onbImPin ? 0.5 : 1, cursor: onbImPinSaving || !onbImPin ? 'not-allowed' : 'pointer' }}
                    disabled={onbImPinSaving || !onbImPin}
                    onClick={handleSaveOnbImPin}
                  >
                    {onbImPinSaving ? 'Saving...' : 'Save PIN Securely'}
                  </button>
                  {onbImPinMsg && (
                    <p style={{ fontSize: 12, marginTop: 10, color: '#ef4444', textAlign: 'center' }}>{onbImPinMsg}</p>
                  )}
                </div>
              )}

              <p style={{ fontSize: 11, color: '#4b5563', textAlign: 'center', lineHeight: 1.5 }}>
                🔒 Encrypted with Windows Credential Store · Never transmitted · Only accessible on this device
              </p>
            </div>

            <div className="onb-actions" style={{ marginTop: 28 }}>
              <button className="onb-btn-ghost" onClick={() => setCurrentStep(4)}>
                <ChevronLeft size={18} />
                Back
              </button>
              <button
                className="onb-btn-primary"
                onClick={() => setCompleted(true)}
              >
                {onbImPinSaved ? 'Finish Setup' : 'Skip for now'}
                <ChevronRight size={18} />
              </button>
            </div>
            {!onbImPinSaved && (
              <p style={{ textAlign: 'center', fontSize: 12, color: '#6b7280', marginTop: 10 }}>
                You can add your PIN later in Settings → Binance tab.
              </p>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
