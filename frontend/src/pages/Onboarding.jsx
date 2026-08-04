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
  saveBinanceApiKey,
  submitOnboarding,
  choiceOnboardWallet,
  choiceConfirmOtp,
} from '../services/api';
import { QRCodeSVG } from 'qrcode.react';
import api from '../services/api';
import RelayConnectStatus from '../components/RelayConnectStatus';
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
  Landmark,
  Clock,
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
  { key: 'choice', title: 'Choice Bank', icon: Landmark },
  { key: 'imbot', title: 'I&M Bot', icon: Download },
];

export default function Onboarding() {
  const { user, setUser, refreshUser } = useAuth();
  const navigate = useNavigate();

  const [currentStep, setCurrentStep] = useState(0);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [completed, setCompleted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState('');

  // Choice Bank onboarding (step 5)
  const [cbForm, setCbForm] = useState({ firstName: '', lastName: '', middleName: '', mobile: '', idNumber: '', birthday: '', gender: '1', email: '', address: '' });
  const [cbFiles, setCbFiles] = useState({});
  const [cbStage, setCbStage] = useState('form'); // form | otp
  const [cbReqId, setCbReqId] = useState('');
  const [cbOtp, setCbOtp] = useState('');
  const [cbBusy, setCbBusy] = useState(false);
  const [cbMsg, setCbMsg] = useState(null);
  // I&M Bot connect check (step 6)
  const [imChecking, setImChecking] = useState(false);

  // Extension step
  const [extensionInstalled, setExtensionInstalled] = useState(false);

  // Binance step
  const [cookies, setCookies] = useState('');
  const [csrfToken, setCsrfToken] = useState('');
  const [totpSecret, setTotpSecret] = useState('');
  const [binanceLoading, setBinanceLoading] = useState(false);
  const [binanceMsg, setBinanceMsg] = useState(null);
  const [nameVerification, setNameVerification] = useState(null);

  // Connect via API key (primary method — desktop app stays on as the residential relay)
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [apiKeyMsg, setApiKeyMsg] = useState(null); // { type, text }
  const [relayOnline, setRelayOnline] = useState(null); // null=unknown, true, false

  const handleConnectApiKey = async () => {
    if (!apiKey.trim() || !apiSecret.trim()) {
      setApiKeyMsg({ type: 'error', text: 'Enter both your API key and secret key.' });
      return;
    }
    setApiKeySaving(true);
    setApiKeyMsg({ type: 'info', text: 'Testing connection to Binance…' });
    try {
      const res = await saveBinanceApiKey({ api_key: apiKey.trim(), api_secret: apiSecret.trim() });
      const capable = res.data?.merchant_capable;
      const adsFound = res.data?.ads_found ?? 0;
      setApiKeyMsg({
        type: 'success',
        text: capable
          ? `Connection verified — Gold Merchant detected (${adsFound} ad${adsFound === 1 ? '' : 's'} found). Binance connected!`
          : `Connection verified (${adsFound} ad${adsFound === 1 ? '' : 's'} found). Binance connected!`,
      });
      setApiKey('');
      setApiSecret('');
      await refreshProfile();
    } catch (err) {
      const detail = err.response?.data?.detail || 'Could not verify your API credentials.';
      const hint = /verify|fetch ads|no response|offline|relay/i.test(detail)
        ? ' Your relay isn’t online. Turn on the relay on this phone (or run the SparkP2P desktop app) so we can reach Binance, then test again.'
        : '';
      setApiKeyMsg({ type: 'error', text: detail + hint });
    }
    setApiKeySaving(false);
  };

  // Verification step
  const [verifyMethod, setVerifyMethod] = useState('totp');
  const [fundPassword, setFundPassword] = useState('');
  const [verifyExpanded, setVerifyExpanded] = useState(false); // merchant chose to set up TOTP anyway

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
  // Settlement phone OTP verification (replaces the old B2C name-match check)
  const [otpSent, setOtpSent] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [otpConfirmed, setOtpConfirmed] = useState(false);
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

  // Name correction (settlement mismatch)
  const [correctedName, setCorrectedName] = useState('');
  const [savingCorrectedName, setSavingCorrectedName] = useState(false);
  const [correctedNameMsg, setCorrectedNameMsg] = useState('');

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
      const p = res.data;
      setProfile(p);
      // Approved → into the app. Submitted → the waiting screen renders (below),
      // so don't route anywhere. Otherwise resume at the first incomplete step.
      if (p.onboarding_status === 'approved') {
        navigate('/dashboard');
        return;
      }
      if (p.onboarding_status === 'submitted') {
        setLoading(false);
        return;
      }
      // Resume at the first incomplete step (now includes Choice Bank + I&M Bot).
      const s = p.onboarding_steps || {};
      const merchantSkipVerify = p.binance_api_key_saved && !p.binance_api_key_invalid;
      if (p.settlement_method) setSettlementSaved(true);
      // Mark the 2FA sub-steps done if they were already set on a previous visit —
      // otherwise a returning user whose security question / authenticator is
      // already saved is stuck (can't re-save, and Continue stays disabled).
      const sqAlready = !!(s.security_question || p.security_question);
      const totpAlready = !!(s.totp || p.has_totp);
      if (sqAlready) setSqDone(true);
      if (totpAlready) setTotpSetupDone(true);
      let step;
      if (!s.binance) step = 1;
      else if (!s.settlement && !(p.verify_method || merchantSkipVerify)) step = 2;   // verification
      else if (!s.settlement) step = 3;                                                // settlement
      else if (!s.security_question || !s.totp) step = 4;                              // 2FA
      else if (!s.choice_bank) step = 5;                                               // Choice Bank
      else step = 6;                                                                   // I&M Bot / submit
      setCurrentStep(step);
      if (step === 4) {
        // If the security question is already set, land on the Authenticator sub-step.
        if (sqAlready && !totpAlready) setSecSubStep('totp');
        getTotpSetup().then(r => setTotpSetupData(r.data)).catch(() => {});
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
  const saveSettlement = async (phoneOverride) => {
    setSettlementLoading(true);
    setSettlementMsg(null);
    try {
      const data = { method: settlementMethod };
      if (settlementMethod === 'mpesa') {
        data.phone = phoneOverride || settlementPhone;
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
      setSettlementSaved(true);
      await refreshProfile();
      return true;
    } catch (err) {
      setSettlementMsg({ type: 'error', text: 'Failed to save settlement settings' });
      return false;
    } finally {
      setSettlementLoading(false);
    }
  };

  const handleSaveSettlement = async (e) => {
    e.preventDefault();
    await saveSettlement();
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

  const handleGoToDashboard = async () => {
    // Refresh the profile into auth context FIRST so the onboarding gate sees
    // the approved status and lets us onto the dashboard (otherwise the
    // still-stale user would bounce us straight back here).
    await refreshUser();
    navigate('/dashboard?scanning=1');
  };

  // Final step: submit the finished setup for admin approval.
  const handleSubmitForReview = async () => {
    setSubmitting(true); setSubmitErr('');
    try {
      await submitOnboarding();
      await refreshProfile();   // onboarding_status becomes 'submitted' → waiting screen renders
    } catch (err) {
      const d = err.response?.data?.detail;
      setSubmitErr((d && d.message) || 'Could not submit — please make sure every step is complete.');
    }
    setSubmitting(false);
  };

  // While waiting for approval, poll: the moment an admin approves, drop the
  // waiting screen and go to the dashboard. A rejection drops back to the steps.
  useEffect(() => {
    if (profile?.onboarding_status !== 'submitted') return;
    const iv = setInterval(async () => {
      try {
        const res = await getProfile();
        setProfile(res.data);
        if (res.data.onboarding_status === 'approved') {
          clearInterval(iv);
          await refreshUser();
          navigate('/dashboard?scanning=1');
        } else if (res.data.onboarding_status === 'rejected') {
          clearInterval(iv);
        }
      } catch { /* keep polling */ }
    }, 5000);
    return () => clearInterval(iv);
  }, [profile?.onboarding_status]);

  // --- Step 5: Choice Bank onboarding (compact reuse of the Settings KYC flow) ---
  const cbFileToB64 = (file) => new Promise((res, rej) => {
    const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.onerror = rej; r.readAsDataURL(file);
  });
  const handleCbFile = async (e, key) => {
    const f = e.target.files?.[0]; if (!f) return;
    const b64 = await cbFileToB64(f);
    setCbFiles(prev => ({ ...prev, [key]: b64 }));
  };
  const handleCbSubmit = async () => {
    const { firstName, lastName, mobile, idNumber, birthday } = cbForm;
    if (!firstName || !lastName || !mobile || !idNumber || !birthday) { setCbMsg({ type: 'error', text: 'Please fill in all required fields.' }); return; }
    if (!cbFiles.front || !cbFiles.back || !cbFiles.selfie) { setCbMsg({ type: 'error', text: 'Please upload ID front, ID back and a selfie.' }); return; }
    setCbBusy(true); setCbMsg(null);
    try {
      const res = await choiceOnboardWallet({
        trader_id: profile.id, first_name: firstName, last_name: lastName, middle_name: cbForm.middleName,
        mobile: mobile.replace(/^(254|0)/, ''), id_number: idNumber, birthday, gender: parseInt(cbForm.gender),
        email: cbForm.email, address: cbForm.address,
        front_photo_b64: cbFiles.front, back_photo_b64: cbFiles.back, selfie_b64: cbFiles.selfie,
      });
      setCbReqId(res.data.onboardingRequestId);
      setCbStage('otp');
      setCbMsg({ type: 'info', text: 'An OTP has been sent to your phone. Enter it below to finish.' });
    } catch (err) {
      setCbMsg({ type: 'error', text: err.response?.data?.detail || 'Could not start Choice Bank onboarding. Try again.' });
    }
    setCbBusy(false);
  };
  const handleCbOtp = async () => {
    setCbBusy(true); setCbMsg(null);
    try {
      await choiceConfirmOtp({ trader_id: profile.id, onboarding_request_id: cbReqId, otp: cbOtp.trim() });
      setCbMsg({ type: 'success', text: 'Choice Bank account submitted — KYC review is now underway.' });
      await refreshProfile();
    } catch (err) {
      setCbMsg({ type: 'error', text: err.response?.data?.detail || 'Invalid OTP. Try again.' });
    }
    setCbBusy(false);
  };
  const handleImCheck = async () => { setImChecking(true); await refreshProfile(); setImChecking(false); };

  const canAdvanceStep2 = profile?.binance_connected;
  const canAdvanceStep3 = settlementSaved || profile?.settlement_method;
  // A verified Binance merchant (connected via API key) doesn't need the TOTP release step —
  // releases go through the merchant API. Only non-merchants (browser login) must set up TOTP.
  const isMerchant = profile?.binance_api_key_saved && !profile?.binance_api_key_invalid;

  if (loading) {
    return (
      <div className="onb-container">
        <div className="loading">Loading...</div>
      </div>
    );
  }

  // Submitted → waiting for an admin to approve. Polls in the background; the
  // moment it's approved this disappears and we go to the dashboard.
  if (profile?.onboarding_status === 'submitted') {
    return (
      <div className="onb-container">
        <div className="onb-completion">
          <div className="onb-completion-icon"><Clock size={56} color="#f59e0b" /></div>
          <h1>Waiting for admin approval</h1>
          <p>
            Your setup is complete and has been sent to our team for review. This
            usually takes a short while — you don&rsquo;t need to do anything. The
            moment it&rsquo;s approved, this screen will take you straight to your
            dashboard.
          </p>
          <p style={{ fontSize: 13, color: '#9ca3af', marginTop: 8 }}>
            Checking automatically… you can leave this page open.
          </p>
        </div>
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
        {profile?.onboarding_status === 'rejected' && (
          <div style={{ marginTop: 12, padding: '10px 14px', background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.4)', borderRadius: 8, color: '#fca5a5', fontSize: 13, maxWidth: 520, marginLeft: 'auto', marginRight: 'auto' }}>
            <strong>Your submission was sent back:</strong> {profile.onboarding_reject_reason || 'Please review your setup and resubmit.'}
          </div>
        )}
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
                href="/api/download/latest"
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
                {/* Primary: connect with a Binance API key + secret */}
                <div className="onb-card">
                  <div className="onb-ext-info">
                    <div className="onb-ext-icon">
                      <Key size={28} />
                    </div>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <h3 style={{ margin: 0 }}>Connect via Binance API</h3>
                        <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 9px', borderRadius: 20, background: 'rgba(245,158,11,0.18)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.35)', letterSpacing: '0.4px', whiteSpace: 'nowrap' }}>★ RECOMMENDED · FOR MERCHANTS</span>
                      </div>
                      <p>
                        Best for verified Binance merchants. Create a Binance API key, paste it below
                        with its secret, and test the connection — this links your account without a
                        Chrome login.
                      </p>
                    </div>
                  </div>

                  {/* Required key permissions */}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '14px 0 16px' }}>
                    {[
                      { label: 'Enable Reading', ok: true },
                      { label: 'Enable Spot & Margin Trading', ok: true },
                      { label: 'Enable Withdrawals — keep OFF', ok: false },
                    ].map(({ label, ok }) => (
                      <span key={label} style={{
                        display: 'inline-flex', alignItems: 'center', gap: 5,
                        fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 20,
                        background: ok ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
                        border: `1px solid ${ok ? 'rgba(16,185,129,0.25)' : 'rgba(239,68,68,0.25)'}`,
                        color: ok ? '#10b981' : '#ef4444',
                      }}>
                        {ok ? '✓' : '✕'} {label}
                      </span>
                    ))}
                  </div>

                  <label style={{ display: 'block', fontSize: 13, color: '#9ca3af', marginBottom: 4 }}>API Key</label>
                  <input
                    type="text"
                    placeholder="Paste your Binance API key"
                    value={apiKey}
                    onChange={(e) => { setApiKey(e.target.value); setApiKeyMsg(null); }}
                    className="onb-input"
                    style={{ fontFamily: 'monospace', marginBottom: 12 }}
                  />

                  <label style={{ display: 'block', fontSize: 13, color: '#9ca3af', marginBottom: 4 }}>Secret Key</label>
                  <div style={{ position: 'relative', marginBottom: 6 }}>
                    <input
                      type={showSecret ? 'text' : 'password'}
                      placeholder="Paste your API secret"
                      value={apiSecret}
                      onChange={(e) => { setApiSecret(e.target.value); setApiKeyMsg(null); }}
                      className="onb-input"
                      style={{ fontFamily: 'monospace', paddingRight: 64, width: '100%', boxSizing: 'border-box' }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowSecret((v) => !v)}
                      style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', padding: '4px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', color: '#9ca3af', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
                    >
                      {showSecret ? 'Hide' : 'Show'}
                    </button>
                  </div>
                  <p style={{ fontSize: 11, color: '#10b981', marginTop: 0, marginBottom: 14 }}>
                    🔒 Encrypted at rest. Withdrawals stay disabled — the bot can never move your funds.
                    {' '}
                    <a href="https://www.binance.com/en/support/faq/360002502072" target="_blank" rel="noreferrer" style={{ color: '#f59e0b', textDecoration: 'none' }}>
                      Where do I find these?
                    </a>
                  </p>

                  <RelayConnectStatus onStatus={setRelayOnline} />

                  {apiKeyMsg && (
                    <div className={`onb-msg ${apiKeyMsg.type}`} style={{ marginBottom: 12 }}>{apiKeyMsg.text}</div>
                  )}

                  <button
                    className="onb-btn-primary"
                    style={{ width: '100%', opacity: apiKeySaving || !apiKey.trim() || !apiSecret.trim() ? 0.5 : 1 }}
                    disabled={apiKeySaving || !apiKey.trim() || !apiSecret.trim()}
                    onClick={handleConnectApiKey}
                  >
                    {apiKeySaving ? 'Testing…' : 'Test Connection & Connect'}
                  </button>

                  <p style={{ fontSize: 11, color: '#6b7280', marginTop: 10, lineHeight: 1.5 }}>
                    Verifying needs your relay running — the phone relay (in this app) or the SparkP2P
                    desktop app — so the connection to Binance comes from your own device.
                  </p>
                </div>

                {/* Alternative: legacy desktop Chrome-login flow */}
                <div className="onb-card">
                  <div className="onb-ext-info">
                    <div className="onb-ext-icon">
                      <Zap size={32} />
                    </div>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <h3 style={{ margin: 0 }}>Or connect via Desktop App</h3>
                        <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 9px', borderRadius: 20, background: 'rgba(99,102,241,0.18)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.35)', letterSpacing: '0.4px', whiteSpace: 'nowrap' }}>FOR NON-MERCHANTS</span>
                      </div>
                      <p>
                        {window.sparkp2p?.isDesktop
                          ? <>Click <strong>Connect Binance</strong> below and log into your Binance account in the Chrome window that opens. The bot will detect your login and start automatically.</>
                          : <>Open the SparkP2P desktop app, click <strong>Connect Binance</strong>, and log into your Binance account in the Chrome window that opens. The bot will detect your login and start automatically.</>
                        }
                      </p>
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 12, lineHeight: 1.6 }}>
                    <strong>Steps:</strong><br />
                    1. Click <strong>Connect Binance</strong> below<br />
                    2. Chrome opens — log into Binance (Google, email, etc.)<br />
                    3. Bot detects login and starts trading automatically
                  </div>
                  {window.sparkp2p?.isDesktop ? (
                    <button
                      className="onb-btn-secondary"
                      style={{ marginTop: 16 }}
                      onClick={() => window.sparkp2p.connectBinance()}
                    >
                      <Link2 size={16} />
                      Connect Binance
                    </button>
                  ) : (
                    <a
                      href="https://sparkp2p.com/SparkP2P-Setup.exe"
                      download
                      className="onb-btn-secondary"
                      style={{ marginTop: 16 }}
                    >
                      <Download size={16} />
                      Download Desktop App
                    </a>
                  )}
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
                <p>
                  {isMerchant
                    ? 'Optional for merchant accounts — your releases go through the Binance merchant API.'
                    : 'Recommended: Google Authenticator (TOTP) lets the bot release crypto automatically.'}
                </p>
              </div>
            </div>

            {/* Merchant: not required — they can skip. Non-merchant: required. */}
            {isMerchant && !verifyExpanded ? (
              <>
                <div className="onb-card onb-success-card">
                  <Check size={24} className="onb-success-icon" />
                  <div>
                    <h3>Not required for your account</h3>
                    <p>
                      You're connected as a verified Binance{' '}
                      {profile?.binance_merchant_tier ? <strong style={{ textTransform: 'capitalize' }}>{profile.binance_merchant_tier} merchant</strong> : 'merchant'}.
                      {' '}Crypto releases are handled through the merchant API, so you don't need to
                      set up a Google Authenticator code here. You can skip this step.
                    </p>
                    <button
                      className="onb-btn-link"
                      style={{ marginTop: 8 }}
                      onClick={() => {
                        setVerifyExpanded(true);
                        getTotpSetup().then(r => setTotpSetupData(r.data)).catch(() => {});
                      }}
                    >
                      Set up Google Authenticator anyway
                    </button>
                  </div>
                </div>

                <div className="onb-actions">
                  <button className="onb-btn-ghost" onClick={() => setCurrentStep(1)}>
                    <ChevronLeft size={18} />
                    Back
                  </button>
                  <button className="onb-btn-primary" onClick={() => setCurrentStep(3)}>
                    Continue
                    <ChevronRight size={18} />
                  </button>
                </div>
              </>
            ) : (
            <>
            <div className="onb-card">
              <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 16 }}>
                When releasing crypto on Binance P2P, Binance asks for a Google Authenticator code. Enter your TOTP secret key below so the bot can generate codes automatically.
              </p>

              <div style={{ background: '#1a1d27', border: '1px solid #2a2d3a', borderRadius: 10, padding: 16, marginBottom: 16 }}>
                <strong style={{ color: '#f59e0b', fontSize: 14 }}>How to get your Google Authenticator secret key:</strong>

                <div style={{ marginTop: 12 }}>
                  <p style={{ fontSize: 12, color: '#e4e4e7', marginBottom: 6 }}>
                    <strong>Step 1:</strong> Go to <strong>Binance → Account → Security</strong> and click <strong>Manage</strong> next to <strong>Authenticator App</strong>
                  </p>
                  <img
                    src="/binance-totp-step1.jpg"
                    alt="Binance Security page showing Authenticator App"
                    style={{ width: '100%', borderRadius: 8, border: '1px solid #2a2d3a', marginBottom: 14 }}
                  />

                  <p style={{ fontSize: 12, color: '#e4e4e7', marginBottom: 6 }}>
                    <strong>Step 2:</strong> Binance shows a QR code with a <strong>text key</strong> below it (circled). This is for the <strong>Google Authenticator</strong> app — open <strong>Google Authenticator</strong> on your phone, tap <strong>+</strong>, and scan that QR code. Then copy the text key shown below it and paste it here so the bot can generate the same Google Authenticator codes automatically.
                  </p>
                  <img
                    src="/binance-totp-step2.jpg"
                    alt="Binance Link an Authenticator dialog showing QR code and text key"
                    style={{ width: '100%', borderRadius: 8, border: '1px solid #2a2d3a', marginBottom: 14 }}
                  />
                </div>

                <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 8, padding: 10 }}>
                  <p style={{ fontSize: 11, color: '#ef4444' }}>⚠️ If Authenticator App is already ON, click <strong>Manage → Change Authenticator</strong> to reset it and reveal the text key. Make sure to scan the new QR code in your <strong>Google Authenticator</strong> app after resetting.</p>
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

            <div className="onb-actions">
              <button className="onb-btn-ghost" onClick={() => isMerchant ? setVerifyExpanded(false) : setCurrentStep(1)}>
                <ChevronLeft size={18} />
                Back
              </button>
              <button
                className="onb-btn-primary"
                disabled={!totpSecret}
                style={{ opacity: totpSecret ? 1 : 0.5, cursor: totpSecret ? 'pointer' : 'not-allowed' }}
                onClick={async () => {
                  if (!totpSecret) return;
                  try {
                    await updateVerification({
                      verify_method: 'totp',
                      totp_secret: totpSecret,
                      fund_password: null,
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
            {!isMerchant && (
              <p style={{ textAlign: 'center', fontSize: 12, color: '#6b7280', marginTop: 10 }}>
                {totpSecret
                  ? 'Click Next to save your authenticator key.'
                  : 'Recommended for browser-connected accounts — without it you’ll approve crypto releases manually. You can add it later in Settings.'}
              </p>
            )}
            </>
            )}
          </div>
        )}

        {/* Step 4: Settlement */}
        {currentStep === 3 && (
          <div className="onb-step-content">
            <div className="onb-step-header">
              <Banknote size={28} className="onb-step-icon" />
              <div>
                <h2>Verify your Safaricom phone number</h2>
                <p>We'll text a one-time code to confirm it's yours. This is where your settlements are paid out from your bank.</p>
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
                  <select value={settlementMethod} onChange={(e) => setSettlementMethod(e.target.value)}>
                    <option value="mpesa">M-Pesa</option>
                  </select>
                  <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4, marginBottom: 8 }}>
                    You can switch to I&M Bank Account in Settings after completing setup — no waiting period for your first change.
                  </div>

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
                      <label>M-Pesa Phone Number</label>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <input
                          type="tel"
                          placeholder="0712345678"
                          value={settlementPhone}
                          onChange={(e) => {
                            setSettlementPhone(e.target.value);
                            // Editing the number invalidates any sent/confirmed code
                            setOtpSent(false); setOtpConfirmed(false); setOtpCode(''); setMpesaVerifyMsg('');
                          }}
                          required
                          readOnly={otpConfirmed}
                          style={{ flex: 1, opacity: otpConfirmed ? 0.7 : 1 }}
                        />
                        {!otpConfirmed && (
                          <button
                            type="button"
                            className="onb-btn-secondary"
                            style={{ padding: '8px 16px', whiteSpace: 'nowrap' }}
                            disabled={mpesaVerifying || !settlementPhone || settlementPhone.length < 10}
                            onClick={async () => {
                              setMpesaVerifying(true);
                              setMpesaVerifyMsg('Sending code...');
                              try {
                                const token = localStorage.getItem('token');
                                const res = await fetch('/api/traders/settlement/send-phone-otp', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                                  body: JSON.stringify({ phone: settlementPhone }),
                                });
                                const d = await res.json();
                                if (!res.ok) { setMpesaVerifyMsg(d.detail || 'Could not send the code.'); setMpesaVerifying(false); return; }
                                setOtpSent(true);
                                setOtpCode('');
                                setMpesaVerifyMsg(d.message ? `${d.message}. Enter it below.` : 'Code sent. Enter it below.');
                              } catch (e) {
                                setMpesaVerifyMsg('Error: ' + e.message);
                              }
                              setMpesaVerifying(false);
                            }}
                          >
                            {mpesaVerifying ? 'Sending...' : (otpSent ? 'Resend' : 'Send code')}
                          </button>
                        )}
                      </div>

                      {/* OTP entry */}
                      {otpSent && !otpConfirmed && (
                        <div style={{ marginTop: 10 }}>
                          <label>Enter the 6-digit code sent to your phone</label>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <input
                              type="text"
                              inputMode="numeric"
                              maxLength={6}
                              placeholder="000000"
                              value={otpCode}
                              onChange={(e) => { setOtpCode(e.target.value.replace(/\D/g, '')); setMpesaVerifyMsg(''); }}
                              style={{ flex: 1, letterSpacing: 6, textAlign: 'center', fontSize: 18 }}
                            />
                            <button
                              type="button"
                              className="onb-btn-secondary"
                              style={{ padding: '8px 16px', whiteSpace: 'nowrap' }}
                              disabled={mpesaVerifying || otpCode.length !== 6}
                              onClick={async () => {
                                setMpesaVerifying(true);
                                setMpesaVerifyMsg('Verifying code...');
                                try {
                                  const token = localStorage.getItem('token');
                                  const res = await fetch('/api/traders/settlement/verify-phone-otp', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                                    body: JSON.stringify({ phone: settlementPhone, code: otpCode }),
                                  });
                                  const d = await res.json();
                                  if (!res.ok) { setMpesaVerifyMsg(d.detail || 'Incorrect code.'); setMpesaVerifying(false); return; }
                                  // Confirmed — save settlement and advance
                                  setOtpConfirmed(true);
                                  setMpesaVerifyMsg('Number verified! Saving and continuing...');
                                  const ok = await saveSettlement(settlementPhone);
                                  if (ok) {
                                    setTimeout(() => {
                                      setCurrentStep(4);
                                      getTotpSetup().then(r => setTotpSetupData(r.data)).catch(() => {});
                                    }, 800);
                                  }
                                } catch (e) {
                                  setMpesaVerifyMsg('Error: ' + e.message);
                                }
                                setMpesaVerifying(false);
                              }}
                            >
                              {mpesaVerifying ? 'Verifying...' : 'Confirm'}
                            </button>
                          </div>
                        </div>
                      )}

                      {mpesaVerifyMsg && (
                        <div style={{ fontSize: 12, color: otpConfirmed ? '#10b981' : '#f59e0b', marginTop: 6 }}>{mpesaVerifyMsg}</div>
                      )}

                      {otpConfirmed && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', background: 'rgba(16,185,129,0.1)', borderRadius: 8, fontSize: 13, color: '#10b981', marginTop: 8 }}>
                          <Check size={16} />
                          Number verified
                        </div>
                      )}

                      <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 8 }}>
                        We send a one-time code to confirm this number is yours. Your settlements are paid out here from your bank.
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
                          const msg = err.response?.data?.detail || '';
                          if (/already set/i.test(msg)) {
                            // Already saved on a previous visit — that counts as done, so advance
                            // instead of trapping the user on this step.
                            setSqDone(true);
                            setSecSubStep('totp');
                            if (!totpSetupData) {
                              setTotpSetupLoading(true);
                              getTotpSetup().then(r => setTotpSetupData(r.data)).catch(() => {}).finally(() => setTotpSetupLoading(false));
                            }
                          } else {
                            setSqMsg(msg || 'Failed to save. Try again.');
                          }
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
                Continue
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

        {/* Step 5 — Choice Bank onboarding */}
        {currentStep === 5 && (
          <div className="onb-step-content">
            <div className="onb-step-icon"><Landmark size={28} /></div>
            <h2>Choice Bank account</h2>
            <p className="onb-step-desc">
              This is the account that receives M-Pesa payments from your buyers. Set it up once —
              final KYC approval can finish in the background.
            </p>

            {profile?.onboarding_steps?.choice_bank ? (
              <div style={{ padding: 16, background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.4)', borderRadius: 10, textAlign: 'center', marginBottom: 20 }}>
                <Check size={26} color="#34d399" />
                <div style={{ color: '#34d399', fontWeight: 700, marginTop: 6 }}>Choice Bank onboarding submitted</div>
                <div style={{ color: '#9ca3af', fontSize: 13, marginTop: 4 }}>
                  Status: {profile.choice_kyc_status || 'submitted'} · KYC approval is tracked separately and won&rsquo;t hold up your setup.
                </div>
              </div>
            ) : cbStage === 'otp' ? (
              <div style={{ maxWidth: 360, margin: '0 auto 20px' }}>
                <label style={{ fontSize: 13, color: '#9ca3af', display: 'block', marginBottom: 8 }}>Enter the OTP sent to your phone</label>
                <input type="text" inputMode="numeric" value={cbOtp} onChange={e => setCbOtp(e.target.value.replace(/\D/g, ''))} placeholder="000000"
                  style={{ width: '100%', padding: 14, borderRadius: 10, border: '1px solid rgba(255,255,255,0.15)', background: '#0d0f1e', color: '#fff', fontSize: 22, letterSpacing: 6, textAlign: 'center', boxSizing: 'border-box', marginBottom: 12 }} />
                <button className="onb-btn-primary" style={{ width: '100%' }} disabled={cbBusy || cbOtp.length < 4} onClick={handleCbOtp}>
                  {cbBusy ? 'Confirming…' : 'Confirm OTP'}
                </button>
              </div>
            ) : (
              <div style={{ maxWidth: 460, margin: '0 auto 20px', display: 'grid', gap: 10 }}>
                {[['firstName', 'First name*'], ['lastName', 'Last name*'], ['middleName', 'Middle name'], ['mobile', 'M-Pesa phone*'], ['idNumber', 'National ID number*'], ['email', 'Email'], ['address', 'Address']].map(([k, label]) => (
                  <input key={k} placeholder={label} value={cbForm[k]} onChange={e => setCbForm(f => ({ ...f, [k]: e.target.value }))}
                    style={{ width: '100%', padding: 12, borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: '#0d0f1e', color: '#fff', boxSizing: 'border-box' }} />
                ))}
                <label style={{ fontSize: 12, color: '#9ca3af' }}>Date of birth*</label>
                <input type="date" value={cbForm.birthday} onChange={e => setCbForm(f => ({ ...f, birthday: e.target.value }))}
                  style={{ width: '100%', padding: 12, borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: '#0d0f1e', color: '#fff', boxSizing: 'border-box' }} />
                <select value={cbForm.gender} onChange={e => setCbForm(f => ({ ...f, gender: e.target.value }))}
                  style={{ width: '100%', padding: 12, borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: '#0d0f1e', color: '#fff', boxSizing: 'border-box' }}>
                  <option value="1">Male</option><option value="2">Female</option>
                </select>
                {[['front', 'ID front*'], ['back', 'ID back*'], ['selfie', 'Selfie*']].map(([k, label]) => (
                  <label key={k} style={{ fontSize: 13, color: cbFiles[k] ? '#34d399' : '#9ca3af', display: 'flex', alignItems: 'center', gap: 8 }}>
                    {cbFiles[k] ? <Check size={15} /> : null}{label}: <input type="file" accept="image/*" onChange={e => handleCbFile(e, k)} />
                  </label>
                ))}
                {cbMsg && <p style={{ fontSize: 13, color: cbMsg.type === 'error' ? '#ef4444' : cbMsg.type === 'success' ? '#34d399' : '#9ca3af' }}>{cbMsg.text}</p>}
                <button className="onb-btn-primary" style={{ width: '100%' }} disabled={cbBusy} onClick={handleCbSubmit}>
                  {cbBusy ? 'Submitting…' : 'Submit Choice Bank details'}
                </button>
              </div>
            )}
            {cbMsg && cbStage === 'otp' && <p style={{ textAlign: 'center', fontSize: 13, color: cbMsg.type === 'error' ? '#ef4444' : '#9ca3af' }}>{cbMsg.text}</p>}

            <div className="onb-actions" style={{ marginTop: 20 }}>
              <button className="onb-btn-ghost" onClick={() => setCurrentStep(4)}><ChevronLeft size={18} /> Back</button>
              <button className="onb-btn-primary" disabled={!profile?.onboarding_steps?.choice_bank}
                style={{ opacity: profile?.onboarding_steps?.choice_bank ? 1 : 0.4, cursor: profile?.onboarding_steps?.choice_bank ? 'pointer' : 'not-allowed' }}
                onClick={() => setCurrentStep(6)}>
                Continue <ChevronRight size={18} />
              </button>
            </div>
          </div>
        )}

        {/* Step 6 — I&M Bot download + connect, then submit for review */}
        {currentStep === 6 && (
          <div className="onb-step-content">
            <div className="onb-step-icon"><Download size={28} /></div>
            <h2>Download &amp; connect the I&amp;M Bot</h2>
            <p className="onb-step-desc">
              The I&amp;M Bot runs on your computer and pays sellers from your own I&amp;M account.
              Download it, sign in with your SparkP2P account, and it will link automatically.
            </p>

            {profile?.onboarding_steps?.im_bot ? (
              <div style={{ padding: 16, background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.4)', borderRadius: 10, textAlign: 'center', marginBottom: 20 }}>
                <Check size={26} color="#34d399" />
                <div style={{ color: '#34d399', fontWeight: 700, marginTop: 6 }}>I&amp;M Bot connected to SparkP2P</div>
              </div>
            ) : (
              <div style={{ maxWidth: 460, margin: '0 auto 16px' }}>
                <a href="/api/download/im-bot" className="onb-btn-primary" style={{ display: 'inline-flex', textDecoration: 'none', marginBottom: 14 }}>
                  <Download size={18} /> Download I&amp;M Bot for Windows
                </a>
                <ol style={{ textAlign: 'left', color: '#c7cbd6', fontSize: 13.5, lineHeight: 1.7, paddingLeft: 18 }}>
                  <li>Install and open the I&amp;M Bot on your computer.</li>
                  <li>Choose <strong>Continue with SparkP2P</strong> and sign in with this account.</li>
                  <li>Come back here and click <strong>Check connection</strong>.</li>
                </ol>
                <button className="onb-btn-ghost" style={{ width: '100%', marginTop: 12 }} disabled={imChecking} onClick={handleImCheck}>
                  {imChecking ? 'Checking…' : 'Check connection'}
                </button>
                <p style={{ fontSize: 12.5, color: '#6b7280', marginTop: 8, textAlign: 'center' }}>
                  We&rsquo;ll detect it the moment the bot signs in with your account.
                </p>
              </div>
            )}

            {submitErr && <p style={{ textAlign: 'center', fontSize: 13, color: '#ef4444', marginTop: 6 }}>{submitErr}</p>}

            <div className="onb-actions" style={{ marginTop: 20 }}>
              <button className="onb-btn-ghost" onClick={() => setCurrentStep(5)}><ChevronLeft size={18} /> Back</button>
              <button className="onb-btn-primary" disabled={!profile?.onboarding_steps?.im_bot || submitting}
                style={{ opacity: profile?.onboarding_steps?.im_bot && !submitting ? 1 : 0.4, cursor: profile?.onboarding_steps?.im_bot && !submitting ? 'pointer' : 'not-allowed' }}
                onClick={handleSubmitForReview}>
                {submitting ? 'Submitting…' : 'Submit for review'} <ChevronRight size={18} />
              </button>
            </div>
            {!profile?.onboarding_steps?.im_bot && (
              <p style={{ textAlign: 'center', fontSize: 12, color: '#6b7280', marginTop: 10 }}>
                Connect the I&amp;M Bot to submit your account for approval.
              </p>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
