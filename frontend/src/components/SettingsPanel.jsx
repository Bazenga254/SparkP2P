import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { updateSettlement, updateTradingConfig, updateProfile, setSecurityQuestion, requestChangePasswordOtp, changePassword, getProfile, updateVerification, saveBinance2fa, getTotpSetup, verifyAndSaveTotp, removeTotp, choiceOnboardWallet, choiceConfirmOtp, choiceOnboardStatus, choiceGetBalance, kycCreateSession, getCbWithdrawalBank, saveCbWithdrawalBank, verifyBankAccount, getCbAutoWithdraw, setCbAutoWithdraw } from '../services/api';
import { QRCodeSVG } from 'qrcode.react';
import api from '../services/api';
import RemoteBrowser from './RemoteBrowser';
import RelayConnectStatus from './RelayConnectStatus';
import { isNative } from '../mobile/relayAgent';
import { bioAvailable, bioAuthenticate, bioEnabled, setBioEnabled } from '../mobile/biometric';
import '@smile_identity/smart-camera-web';

function BiometricSetting() {
  const [avail, setAvail] = useState(false);
  const [on, setOn] = useState(bioEnabled());
  useEffect(() => { if (isNative()) bioAvailable().then(setAvail); }, []);
  if (!isNative()) return null;   // hidden only on the web browser; always visible in the app
  const toggle = async () => {
    if (!avail) return;   // no fingerprint enrolled — hint shown instead
    if (on) { setBioEnabled(false); localStorage.removeItem('bio_token'); setOn(false); return; }
    const ok = await bioAuthenticate('Confirm to enable fingerprint unlock');
    if (ok) {
      setBioEnabled(true);
      // Save the current sign-in so fingerprint can log you in later, even after you log out.
      const t = localStorage.getItem('token'); if (t) localStorage.setItem('bio_token', t);
      setOn(true);
    }
  };
  return (
    <div className="card" style={{ marginBottom: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ width: 42, height: 42, borderRadius: 11, background: 'rgba(245,176,20,0.14)', color: '#f5b014', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 11c-1.5 0-2.5 1-2.5 3s.5 4 1 5"/><path d="M7 18c-.5-1.5-.7-3-.5-5 .3-2.7 2.4-4.5 5.5-4.5s5.2 1.8 5.5 4.5c.1 1 .1 2 0 3"/><path d="M4.5 14c-.2-1.5-.2-3 .2-4.5C5.6 5.8 8.4 4 12 4s6.4 1.8 7.3 5.5"/><path d="M12 14v3c0 1.5.3 2.7.7 3.5"/></svg>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, color: '#f3f4f6', fontSize: 15 }}>Fingerprint unlock</div>
          <div style={{ color: '#9ca3af', fontSize: 12.5, marginTop: 2 }}>
            {avail
              ? 'Unlock the app with your fingerprint or face instead of a password.'
              : 'Add a fingerprint or face lock in your phone settings, then turn this on.'}
          </div>
        </div>
        <div onClick={toggle} title={avail ? '' : 'No fingerprint set up on this device'}
          style={{ width: 46, height: 26, borderRadius: 20, background: on ? '#33C27A' : '#3a414d', position: 'relative', flex: '0 0 auto', cursor: avail ? 'pointer' : 'not-allowed', opacity: avail ? 1 : 0.45, transition: '.2s' }}>
          <span style={{ position: 'absolute', top: 3, left: on ? 23 : 3, width: 20, height: 20, borderRadius: '50%', background: '#fff', transition: '.2s' }} />
        </div>
      </div>
    </div>
  );
}

const saveBinanceApiKey = (data) => api.put('/traders/binance-api-key', data);
const deleteBinanceApiKey = () => api.delete('/traders/binance-api-key');

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

export default function SettingsPanel({ profile, onUpdate, initialSection }) {
  const navigate = useNavigate();
  const [activeSection, setActiveSection] = useState(initialSection || 'binance');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [showKycGate, setShowKycGate] = useState(false);
  const [kycLinkLoading, setKycLinkLoading] = useState(false);
  const connectPollRef = useRef(null);
  const wasConnectingRef = useRef(false); // true once any connection was made this session

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
  const [pauseTotpCode, setPauseTotpCode] = useState('');
  const [pauseHasTotp, setPauseHasTotp] = useState(false);
  const [pauseLoading, setPauseLoading] = useState(false);
  const [pauseMsg, setPauseMsg] = useState('');
  const [pauseDuration, setPauseDuration] = useState(3 * 60 * 1000); // chosen pause length (ms)
  const [pausedUntil, setPausedUntil] = useState(() => {
    const v = parseInt(localStorage.getItem('sparkPausedUntil') || '0', 10);
    return v && v > Date.now() ? v : null;
  });
  const [nowTick, setNowTick] = useState(Date.now());

  // I&M PIN
  const [imPinValue, setImPinValue] = useState('');
  const [imPinSaved, setImPinSaved] = useState(false);
  const [imPinSaving, setImPinSaving] = useState(false);
  const [imPinMsg, setImPinMsg] = useState('');
  // I&M PIN verification modal (2FA gate before setting/replacing PIN)
  const [showImPinModal, setShowImPinModal] = useState(false);
  const [imPinVerifStep, setImPinVerifStep] = useState('send'); // 'send' | 'verify' | 'enter'
  const [imPinOtp, setImPinOtp] = useState('');
  const [imPinTotp, setImPinTotp] = useState('');
  const [imPinVerifLoading, setImPinVerifLoading] = useState(false);
  const [imPinVerifMsg, setImPinVerifMsg] = useState('');
  const [imPinResending, setImPinResending] = useState(false);

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

  // Settlement — dual method (I&M primary, M-Pesa fallback)
  const [settleEdit, setSettleEdit] = useState(null); // null | 'im' | 'mpesa'
  const [settleImInput, setSettleImInput] = useState('');
  const [settleMpesaInput, setSettleMpesaInput] = useState('');
  const [settleOtpSent, setSettleOtpSent] = useState(false);
  const [settleOtp, setSettleOtp] = useState('');
  const [settleSecAnswer, setSettleSecAnswer] = useState('');
  const [settleSQ, setSettleSQ] = useState('');
  // Legacy state (kept to avoid breaking handleSaveSettlement references in fee info section)
  const [settlementMethod] = useState(profile?.settlement_method || 'mpesa');
  const [showChangeForm] = useState(false);

  // Binance verification method — pre-populate from profile
  // This card is TOTP-only, so the method is ALWAYS 'totp'. It used to default to
  // 'none', and the secret-key help + the "current 6-digit code" field only
  // rendered when it was 'totp' — so a client who had never set it up (method
  // null/'none') saw a broken half-form with no code field and couldn't
  // configure. Hard-wire 'totp' so every client always sees the full form.
  const [verifyMethod] = useState('totp');
  const [verifyInput, setVerifyInput] = useState('');
  const [verifyCode, setVerifyCode] = useState('');   // current Binance 6-digit code, to confirm the secret
  const [verifySaved, setVerifySaved] = useState(
    !!(profile?.binance_verify_method && profile.binance_verify_method !== 'none')
  );

  // Sync the "Configured / Not set" badge when the profile loads (starts null, arrives async).
  useEffect(() => {
    if (!profile?.binance_verify_method) return;
    if (!verifySaved) {
      setVerifySaved(profile.binance_verify_method !== 'none');
    }
  }, [profile?.binance_verify_method]);

  // Choice Bank onboarding
  const [cbStep, setCbStep] = useState('form'); // 'form' | 'otp' | 'polling' | 'done'
  const [cbForm, setCbForm] = useState({ firstName: '', lastName: '', middleName: '', mobile: '', idNumber: '', birthday: '', gender: '1', email: '', address: '' });
  const [cbFiles, setCbFiles] = useState({ front: '', back: '', selfie: '' });
  const [cbRequestId, setCbRequestId] = useState('');
  const [cbOtp, setCbOtp] = useState('');
  const [cbLoading, setCbLoading] = useState(false);
  const [cbMsg, setCbMsg] = useState(null); // { type: 'error'|'success'|'info', text: '' }
  const [cbBalance, setCbBalance] = useState(null);
  const [cbSmileOpen, setCbSmileOpen] = useState(false);
  const smileCamRef = useRef(null);

  useEffect(() => {
    const cam = smileCamRef.current;
    if (!cam) return;
    const onCapture = (e) => {
      const imgs = ((e.detail) || {}).images || [];
      const img = imgs[0];
      if (img && img.image) {
        setCbFiles(f => ({ ...f, selfie: img.image }));
        setCbSmileOpen(false);
      }
    };
    cam.addEventListener('imagesComputed', onCapture);
    return () => cam.removeEventListener('imagesComputed', onCapture);
  }, [cbSmileOpen]);

  // Security / Profile
  const [editName, setEditName] = useState(profile?.full_name || '');
  const [savingName, setSavingName] = useState(false);
  // Security question (set once)
  const [sqQuestion, setSqQuestion] = useState('');
  const [sqAnswer, setSqAnswer] = useState('');
  const [savingSq, setSavingSq] = useState(false);
  const [sqJustSaved, setSqJustSaved] = useState(null); // question text right after save
  // Telegram connection
  const [tgConnected, setTgConnected] = useState(false);
  const [tgCode, setTgCode] = useState(null);      // { code, expires_in }
  const [tgCodeLoading, setTgCodeLoading] = useState(false);
  const [tgDisconnecting, setTgDisconnecting] = useState(false);
  const [tgTesting, setTgTesting] = useState(false);
  const [tgTestResult, setTgTestResult] = useState(null); // 'ok' | 'error'

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

  // Sync batch settlement settings when profile loads
  useEffect(() => {
    if (profile?.batch_threshold) setBatchThreshold(profile.batch_threshold);
    if (profile?.batch_settlement_enabled !== undefined) setBatchEnabled(profile.batch_settlement_enabled);
  }, [profile?.batch_threshold, profile?.batch_settlement_enabled]);

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

  // Load Telegram connection status on mount
  useEffect(() => {
    api.get('/telegram/status').then(r => setTgConnected(r.data.connected === true)).catch(() => {});
  }, []);

  // ── I&M Bot link ──────────────────────────────────────────────────────────
  // The bot runs on the MERCHANT's own machine and polls us; "online" is simply
  // whether it has polled recently (its API key's last_used_at is the heartbeat).
  const [imBot, setImBot] = useState(null);          // { has_key, online, last_seen_at, ... }
  const [imBotOpen, setImBotOpen] = useState(false);
  const [imBotKeys, setImBotKeys] = useState([]);
  const [imBotNewKey, setImBotNewKey] = useState(''); // plaintext — shown ONCE, never refetchable
  const [imBotBusy, setImBotBusy] = useState(false);
  const [imBotCopied, setImBotCopied] = useState('');

  const loadImBot = () =>
    api.get('/im-bot/link-status').then(r => setImBot(r.data)).catch(() => {});

  // One-click launch: mint a short-lived handoff code, then open the desktop app
  // via its im-automation:// deep link. The app exchanges the code for its key and
  // signs the user in automatically — they just connect their I&M and go.
  const [imLaunching, setImLaunching] = useState(false);
  const [imLaunchMsg, setImLaunchMsg] = useState('');
  const launchImBot = async () => {
    setImLaunching(true); setImLaunchMsg('');
    try {
      const r = await api.post('/im-bot/handoff');
      const link = r.data?.deeplink;
      if (!link) throw new Error('no link');
      // Opening the custom scheme hands off to the OS, which launches the app.
      window.location.href = link;
      setImLaunchMsg("✓ Opening I&M Automation… If nothing happens, the app isn't installed — download it, then click Launch again.");
    } catch (e) {
      setImLaunchMsg('Could not start the launch. Please try again.');
    } finally {
      setTimeout(() => setImLaunching(false), 1500);
    }
  };

  // Choose how BUY orders are paid: the merchant's own I&M Bot, or Choice Bank.
  const [payoutBusy, setPayoutBusy] = useState(false);
  const setPayoutMethod = async (viaIm) => {
    if (payoutBusy || (imBot?.buy_payout_via_im ?? false) === viaIm) return;
    setPayoutBusy(true);
    try {
      await api.post('/im-bot/payout-method', { via_im: viaIm });
      await loadImBot();
    } catch (e) {
      alert(e?.response?.data?.detail || 'Could not change your payout method. Please try again.');
    } finally {
      setPayoutBusy(false);
    }
  };

  useEffect(() => {
    loadImBot();
    // Offline is the state that costs money: the merchant chose "hold + alert",
    // so a buy order waits while the bot is down. Keep this honest, not stale.
    const t = setInterval(loadImBot, 30000);
    return () => clearInterval(t);
  }, []);

  const openImBot = async () => {
    setImBotOpen(true);
    setImBotNewKey('');
    try {
      const r = await api.get('/im-bot/keys');
      setImBotKeys(r.data.keys || []);
    } catch { setImBotKeys([]); }
  };

  const generateImBotKey = async () => {
    setImBotBusy(true);
    try {
      const r = await api.post('/im-bot/keys', { name: 'I&M Bot' });
      setImBotNewKey(r.data.key);   // the only time this value ever exists here
      const l = await api.get('/im-bot/keys');
      setImBotKeys(l.data.keys || []);
      loadImBot();
    } catch (e) {
      alert(e?.response?.data?.detail || 'Could not generate a key');
    } finally { setImBotBusy(false); }
  };

  const revokeImBotKey = async (id) => {
    if (!window.confirm('Revoke this key? A bot using it will stop being able to pull orders.')) return;
    try {
      await api.delete(`/im-bot/keys/${id}`);
      const l = await api.get('/im-bot/keys');
      setImBotKeys(l.data.keys || []);
      loadImBot();
    } catch (e) {
      alert(e?.response?.data?.detail || 'Could not revoke');
    }
  };

  const copyImBot = (text, what) => {
    navigator.clipboard?.writeText(text);
    setImBotCopied(what);
    setTimeout(() => setImBotCopied(''), 1500);
  };

  const imBotSeen = (iso) => {
    if (!iso) return 'never';
    const s = Math.floor((Date.now() - new Date(iso)) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return new Date(iso).toLocaleDateString();
  };

  // Check if I&M PIN is already saved on this device
  useEffect(() => {
    if (window.sparkp2p?.hasImPin) {
      window.sparkp2p.hasImPin().then(r => setImPinSaved(!!r?.hasPin));
    }
  }, []);

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


  // Binance API key
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [apiKeyMsg, setApiKeyMsg] = useState('');

  // Counterparty filters
  const [cfEnabled, setCfEnabled] = useState(profile?.cf_filters_enabled ?? false);
  const [cfRateMin, setCfRateMin] = useState(Math.round((profile?.cf_completion_rate_min || 0) * 100));
  const [cfRateWindow, setCfRateWindow] = useState(profile?.cf_completion_rate_window ?? 2);
  const [cfAllTradesMin, setCfAllTradesMin] = useState(profile?.cf_all_trades_min ?? 0);
  const [cfTradeCountWindow, setCfTradeCountWindow] = useState(profile?.cf_trade_count_window ?? 2);
  const [cfCompletedMin, setCfCompletedMin] = useState(profile?.cf_completed_trades_min ?? 0);
  const [cfBuyMin, setCfBuyMin] = useState(profile?.cf_buy_trades_min ?? 0);
  const [cfSellMin, setCfSellMin] = useState(profile?.cf_sell_trades_min ?? 0);
  const [cfVolumeMin, setCfVolumeMin] = useState(profile?.cf_volume_min ?? 0);
  const [cfVolumeWindow, setCfVolumeWindow] = useState(profile?.cf_volume_window ?? 2);

  // Trading
  const [autoRelease, setAutoRelease] = useState(profile?.auto_release_enabled ?? true);
  const [autoPay, setAutoPay] = useState(profile?.auto_pay_enabled ?? true);
  const [dailyLimit, setDailyLimit] = useState(profile?.daily_trade_limit || 200);
  const [maxTrade, setMaxTrade] = useState(profile?.max_single_trade || 500000);
  const [batchEnabled, setBatchEnabled] = useState(profile?.batch_settlement_enabled ?? true);
  const [cbBank, setCbBank] = useState({ bank_name: '', bank_code: '', account: '', account_name: '' });
  const [cbBankLoaded, setCbBankLoaded] = useState(false);
  const [cbBankSaving, setCbBankSaving] = useState(false);
  const [cbBankMsg, setCbBankMsg] = useState('');
  const [cbBankVerifyStep, setCbBankVerifyStep] = useState(false);
  const [cbBankTotp, setCbBankTotp] = useState('');
  const [cbBankSecAnswer, setCbBankSecAnswer] = useState('');
  const [cbBankCooldownUntil, setCbBankCooldownUntil] = useState(null);
  const [cbBankCooldown, setCbBankCooldown] = useState('');
  const [cbBankFirstChange, setCbBankFirstChange] = useState(true);
  const [cbBankVerifying, setCbBankVerifying] = useState(false);
  const [cbBankVerified, setCbBankVerified]   = useState(false);
  const [cbBankLookupRef, setCbBankLookupRef] = useState({ timer: null });
  // Auto-sweep to bank
  const [autoWd, setAutoWd] = useState({ enabled: false, threshold: '', bank_configured: false });
  const [autoWdLoaded, setAutoWdLoaded] = useState(false);
  const [autoWdSaving, setAutoWdSaving] = useState(false);
  const [autoWdMsg, setAutoWdMsg] = useState('');

  // CB withdrawal bank cooldown countdown — placed AFTER all cbBank states
  useEffect(() => {
    if (!cbBankCooldownUntil) { setCbBankCooldown(''); return; }
    const tick = () => {
      const diff = new Date(cbBankCooldownUntil) - new Date();
      if (diff <= 0) { setCbBankCooldown(''); setCbBankCooldownUntil(null); return; }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setCbBankCooldown(`${String(h).padStart(2,'0')} : ${String(m).padStart(2,'0')} : ${String(s).padStart(2,'0')}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [cbBankCooldownUntil]);
  const [batchThreshold, setBatchThreshold] = useState(profile?.batch_threshold || 50000);


  const showMsg = (msg) => {
    setMessage(msg);
    setTimeout(() => setMessage(''), 3000);
  };

  const handleOpenKycBrowser = async () => {
    setKycLinkLoading(true);
    try {
      const res = await kycCreateSession();
      const token = res.data.token;
      if (isNative()) {
        // In-app: go straight to the mobile KYC flow. No external browser → no biometric lock /
        // "sign in again", and we skip /verify-kyc (a desktop→phone QR bridge that's pointless here).
        navigate(`/kyc/${token}`);
      } else {
        const url = `${window.location.origin}/verify-kyc?t=${token}`;
        if (window.sparkp2p?.openExternal) window.sparkp2p.openExternal(url);
        else window.open(url, '_blank');
      }
      setShowKycGate(false);
    } catch {
      setShowKycGate(false);
      setActiveSection('bank');
    } finally {
      setKycLinkLoading(false);
    }
  };

  const handleConnectBinance = () => {
    if (!profile?.choice_account_id) { setShowKycGate(true); return; }
    if (window.sparkp2p?.isDesktop) {
      window.sparkp2p.connectBinance();
    }
    wasConnectingRef.current = true;
    setConnecting(true);
    if (!window.sparkp2p?.isDesktop) {
      setShowRemoteBrowser(true);
    }
  };

  // Poll until binance_connected = true, then update profile
  useEffect(() => {
    if (!connecting) return;
    connectPollRef.current = setInterval(async () => {
      try {
        const res = await getProfile();
        if (res.data.binance_connected) {
          clearInterval(connectPollRef.current);
          setConnecting(false);
          if (onUpdate) onUpdate(res.data);
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

  // Redirect to dashboard once all three accounts are connected
  useEffect(() => {
    if (!wasConnectingRef.current) return;
    if (profile?.binance_connected && gmailConfigured) {
      navigate('/dashboard?scanning=1');
    }
  }, [profile?.binance_connected, gmailConfigured]);

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
    setPauseLoading(true);
    setPauseMsg('');
    try {
      const res = await api.post('/traders/pause-bot/request-otp');
      setPauseSecQ(res.data.security_question || '');
      setPauseHasTotp(!!res.data.has_totp);
      setPauseStep('otp');
    } catch (err) {
      setPauseMsg(err.response?.data?.detail || 'Failed to load verification. Please try again.');
    }
    setPauseLoading(false);
  };

  const handleConfirmPause = async () => {
    if (pauseSecQ && !pauseSecAnswer) { setPauseMsg('Enter your security answer.'); return; }
    if (pauseHasTotp && !pauseTotpCode) { setPauseMsg('Enter your Google Authenticator code.'); return; }
    setPauseLoading(true);
    setPauseMsg('');
    try {
      await api.post('/traders/pause-bot/confirm', {
        security_answer: pauseSecAnswer,
        totp_code: pauseTotpCode,
      });
      // Verification passed — now actually pause for the chosen duration
      let until = pauseDuration ? Date.now() + pauseDuration : null;
      if (window.sparkp2p?.pauseNavigation) {
        const res = await window.sparkp2p.pauseNavigation(pauseDuration);
        if (res && res.until) until = res.until;        // desktop is source of truth
        else if (res && res.until === null) until = null; // old desktop = legacy sliding pause
      } else {
        await fetch('http://127.0.0.1:9223/pause?ms=' + (pauseDuration || 0)).catch(() => {});
      }
      if (until) { setPausedUntil(until); localStorage.setItem('sparkPausedUntil', String(until)); }
      setShowPauseModal(false);
      setPauseStep('warning'); setPauseOtpCode(''); setPauseSecAnswer(''); setPauseTotpCode(''); setPauseMsg('');
    } catch (err) {
      setPauseMsg(err.response?.data?.detail || 'Verification failed. Check your codes and try again.');
    }
    setPauseLoading(false);
  };

  // Resume the bot early (before the chosen timer elapses).
  const handleResumeBot = async () => {
    try {
      if (window.sparkp2p?.resumeNavigation) await window.sparkp2p.resumeNavigation();
      else await fetch('http://127.0.0.1:9223/resume').catch(() => {});
    } catch { /* re-lock is best-effort; clear the UI state regardless */ }
    setPausedUntil(null);
    localStorage.removeItem('sparkPausedUntil');
  };

  // Tick every second while paused so the countdown updates.
  useEffect(() => {
    if (!pausedUntil) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pausedUntil]);

  // When the countdown reaches zero, the desktop has auto-resumed + re-locked;
  // clear the UI state to match.
  useEffect(() => {
    if (pausedUntil && pausedUntil <= nowTick) {
      setPausedUntil(null);
      localStorage.removeItem('sparkPausedUntil');
    }
  }, [nowTick, pausedUntil]);

  const fmtRemaining = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  };

  const handleConnectIm = () => {
    if (window.sparkp2p?.isDesktop) {
      window.sparkp2p.connectIm();
    }
    wasConnectingRef.current = true;
    setImConnecting(true);
  };

  // I&M Bank polling removed — no longer used

  const handleOpenImPinModal = async () => {
    setShowImPinModal(true);
    setImPinVerifStep('send');
    setImPinOtp(''); setImPinTotp(''); setImPinVerifMsg(''); setImPinValue('');
    // Auto-send OTP
    setImPinVerifLoading(true);
    try {
      await api.post('/traders/pause-bot/request-otp');
      setImPinVerifStep('verify');
      setImPinVerifMsg('OTP sent to your phone.');
    } catch { setImPinVerifMsg('Failed to send OTP. Please try again.'); }
    setImPinVerifLoading(false);
  };

  const handleResendOtp = async () => {
    setImPinResending(true);
    setImPinVerifMsg('');
    try {
      await api.post('/traders/pause-bot/request-otp');
      setImPinVerifMsg('OTP resent to your phone.');
    } catch { setImPinVerifMsg('Failed to resend OTP. Please try again.'); }
    setImPinResending(false);
  };

  const handleVerifyImPin = async () => {
    if (!imPinOtp) { setImPinVerifMsg('Enter the OTP sent to your phone.'); return; }
    setImPinVerifLoading(true);
    setImPinVerifMsg('');
    try {
      await api.post('/traders/verify-pin-change', { otp_code: imPinOtp, totp_code: imPinTotp || undefined });
      setImPinVerifStep('enter');
      setImPinVerifMsg('');
    } catch (e) {
      setImPinVerifMsg(e.response?.data?.detail || 'Verification failed. Check your codes and try again.');
    }
    setImPinVerifLoading(false);
  };

  const handleSaveImPin = async () => {
    if (!imPinValue || imPinValue.length < 4) { setImPinVerifMsg('PIN must be at least 4 digits.'); return; }
    if (!window.sparkp2p?.saveImPin) { setImPinVerifMsg('PIN can only be saved from the desktop app.'); return; }
    setImPinSaving(true);
    setImPinVerifMsg('');
    try {
      await window.sparkp2p.saveImPin(imPinValue);
      setImPinSaved(true);
      setImPinValue('');
      setShowImPinModal(false);
    } catch { setImPinVerifMsg('Failed to save PIN. Please try again.'); }
    setImPinSaving(false);
  };

  const handleClearImPin = async () => {
    if (!window.sparkp2p?.clearImPin) return;
    await window.sparkp2p.clearImPin();
    setImPinSaved(false);
  };

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

  const handleSettleRequestOTP = async () => {
    setLoading(true);
    try {
      const res = await requestSettlementOTP();
      setSettleOtpSent(true);
      setSettleSQ(res.data.security_question || '');
      showMsg(res.data.message || 'OTP sent to your phone');
    } catch (err) {
      showMsg(err.response?.data?.detail || 'Failed to send OTP');
    }
    setLoading(false);
  };

  const handleSaveSettle = async (e) => {
    e.preventDefault();
    const isFreeChange = profile?.settlement_first_change_free;
    if (!isFreeChange) {
      if (!settleOtp) { showMsg('Enter the OTP code sent to your phone'); return; }
      if (!settleSecAnswer) { showMsg('Enter your security answer'); return; }
    }
    setLoading(true);
    try {
      const payload = {};
      if (!isFreeChange) {
        payload.otp_code = settleOtp;
        payload.security_answer = settleSecAnswer;
      }
      if (settleEdit === 'im') {
        if (!settleImInput.trim()) { showMsg('Enter your I&M Bank account number'); setLoading(false); return; }
        payload.method = 'bank_paybill';
        payload.account = settleImInput.trim();
        payload.bank_name = 'I&M';
      } else {
        if (!settleMpesaInput.trim()) { showMsg('Enter your M-Pesa phone number'); setLoading(false); return; }
        payload.method = 'mpesa';
        payload.phone = settleMpesaInput.trim().replace(/^0/, '254');
      }
      const res = await updateSettlement(payload);
      showMsg(res.data.message || 'Payment method updated!');
      setSettleEdit(null);
      setSettleOtpSent(false);
      setSettleOtp('');
      setSettleSecAnswer('');
      onUpdate();
    } catch (err) {
      showMsg(err.response?.data?.detail || 'Failed to save settlement settings');
    }
    setLoading(false);
  };

  // Legacy stub — kept so fee-info section that references handleSaveSettlement still compiles
  const handleSaveSettlement = handleSaveSettle;
  const handleRequestOTP = handleSettleRequestOTP;

  const handleGenerateTgCode = async () => {
    setTgCodeLoading(true);
    setTgCode(null);
    try {
      const r = await api.post('/telegram/generate-link-code');
      setTgCode(r.data);
      // Poll for connection every 5s for up to 3 minutes
      const poll = setInterval(async () => {
        try {
          const s = await api.get('/telegram/status');
          if (s.data.connected) {
            setTgConnected(true);
            setTgCode(null);
            clearInterval(poll);
          }
        } catch (e) {}
      }, 5000);
      setTimeout(() => clearInterval(poll), 180000);
    } catch (e) {
      showMsg('Failed to generate code — please try again');
    } finally {
      setTgCodeLoading(false);
    }
  };

  const handleDisconnectTelegram = async () => {
    setTgDisconnecting(true);
    try {
      await api.post('/telegram/disconnect');
      setTgConnected(false);
      setTgCode(null);
    } catch (e) {
      showMsg('Failed to disconnect — please try again');
    } finally {
      setTgDisconnecting(false);
    }
  };

  const handleTestTelegram = async () => {
    setTgTesting(true);
    setTgTestResult(null);
    try {
      // In the desktop app use IPC (main process has the token and can reach backend)
      // In the web browser fall back to the normal API call
      if (window.sparkp2p?.sendTelegramTest) {
        const result = await window.sparkp2p.sendTelegramTest();
        if (result?.ok) {
          setTgTestResult('ok');
        } else {
          setTgTestResult('error');
        }
      } else {
        await api.post('/telegram/test');
        setTgTestResult('ok');
      }
    } catch (e) {
      setTgTestResult('error');
    } finally {
      setTgTesting(false);
      setTimeout(() => setTgTestResult(null), 5000);
    }
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
      showMsg(err.response?.data?.detail || 'Failed to save trading settings');
    }
    setLoading(false);
  };

  return (
    <div className="settings-panel">
      {/* Page header */}
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: '#fff', margin: '0 0 4px' }}>Settings</h2>
        <p style={{ color: '#6b7280', fontSize: 13, margin: 0 }}>Connections, security, and trading preferences</p>
      </div>

      {message && <div className="settings-msg">{message}</div>}

      <div className="settings-nav">
        {[['binance', 'Binance'], ['trading', 'Trading'], ['security', 'Profile & Security'], ['notifications', 'Notifications'], ['bank', 'Bank Account']].map(([key, label]) => (
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Disconnect alert banner */}
          {!profile?.binance_connected && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '14px 20px', borderRadius: 12, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(239,68,68,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#ef4444' }} />
                </div>
                <div>
                  <div style={{ color: '#ef4444', fontWeight: 700, fontSize: 14, marginBottom: 2 }}>Binance disconnected — trading is paused</div>
                  <div style={{ color: '#9ca3af', fontSize: 12 }}>Reconnect to resume automatic trading. No passwords stored — only session cookies.</div>
                </div>
              </div>
              <button onClick={handleConnectBinance} disabled={connecting}
                style={{ flexShrink: 0, padding: '9px 20px', borderRadius: 8, border: 'none', background: '#f59e0b', color: '#000', fontWeight: 700, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                {connecting ? 'Connecting...' : 'Reconnect now'}
              </button>
            </div>
          )}

          {/* connection cards — 3-across on desktop, stacked on mobile so all are reachable */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: 14 }}>

            {/* Binance account */}
            <div className="card">
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
                <div style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(107,114,128,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ width: 22, height: 22, borderRadius: 4, background: '#4b5563' }} />
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
                  background: profile?.binance_connected ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                  color: profile?.binance_connected ? '#10b981' : '#ef4444' }}>
                  {profile?.binance_connected ? 'Connected' : 'Disconnected'}
                </span>
              </div>
              <div style={{ fontWeight: 700, color: '#fff', fontSize: 15, marginBottom: 6 }}>Binance account</div>
              <div style={{ color: '#6b7280', fontSize: 12, lineHeight: 1.5, marginBottom: 16 }}>
                Bot logs into Binance directly via secure browser. Only session cookies are stored.
              </div>
              {profile?.binance_connected ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <button onClick={handleConnectBinance}
                    style={{ width: '100%', padding: '9px 0', borderRadius: 8, border: '1px solid #f59e0b', background: 'transparent', color: '#f59e0b', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                    Re-connect
                  </button>
                  {pausedUntil ? (
                    <button onClick={handleResumeBot}
                      style={{ width: '100%', padding: '9px 0', borderRadius: 8, border: '1px solid #10b981', background: 'rgba(16,185,129,0.12)', color: '#10b981', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                      ▶ Resume Bot · {fmtRemaining(pausedUntil - nowTick)} left
                    </button>
                  ) : (
                    <button onClick={() => { setShowPauseModal(true); setPauseStep('warning'); setPauseMsg(''); setPauseDuration(3 * 60 * 1000); }}
                      style={{ width: '100%', padding: '9px 0', borderRadius: 8, border: '1px solid #374151', background: 'transparent', color: '#9ca3af', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                      Pause Bot
                    </button>
                  )}
                </div>
              ) : (
                <button onClick={handleConnectBinance} disabled={connecting}
                  style={{ width: '100%', padding: '10px 0', borderRadius: 8, border: 'none', background: '#f59e0b', color: '#000', fontWeight: 700, fontSize: 13, cursor: connecting ? 'not-allowed' : 'pointer' }}>
                  {connecting ? 'Connecting...' : 'Connect'}
                </button>
              )}
              {showKycGate && (
                <div style={{ marginTop: 12, padding: '12px 14px', borderRadius: 8, background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.2)', textAlign: 'center' }}>
                  <div style={{ color: '#fff', fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Bank Verification Required</div>
                  <div style={{ color: '#9ca3af', fontSize: 12, marginBottom: 10 }}>Complete Choice Bank verification first.</div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={handleOpenKycBrowser} disabled={kycLinkLoading}
                      style={{ flex: 1, padding: '8px 0', borderRadius: 7, border: 'none', background: '#10b981', color: '#fff', fontWeight: 700, fontSize: 12, cursor: kycLinkLoading ? 'not-allowed' : 'pointer' }}>
                      {kycLinkLoading ? 'Opening...' : 'Verify'}
                    </button>
                    <button onClick={() => setShowKycGate(false)}
                      style={{ flex: 1, padding: '8px 0', borderRadius: 7, border: '1px solid #374151', background: 'transparent', color: '#9ca3af', fontSize: 12, cursor: 'pointer' }}>
                      Dismiss
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Gmail OTP reader */}
            <div className="card">
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
                <div style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(16,185,129,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ width: 22, height: 16, borderRadius: 3, background: 'rgba(16,185,129,0.2)', border: '1.5px solid #10b981' }} />
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
                  background: gmailConfigured ? 'rgba(16,185,129,0.15)' : 'rgba(107,114,128,0.12)',
                  color: gmailConfigured ? '#10b981' : '#6b7280' }}>
                  {gmailConfigured ? 'Connected' : 'Not set'}
                </span>
              </div>
              <div style={{ fontWeight: 700, color: '#fff', fontSize: 15, marginBottom: 6 }}>Gmail OTP reader</div>
              <div style={{ color: '#6b7280', fontSize: 12, lineHeight: 1.5, marginBottom: 16 }}>
                Reads Binance email verification codes via a connected browser session.
              </div>
              <button onClick={() => { if (!profile?.choice_account_id) { setShowKycGate(true); return; } wasConnectingRef.current = true; window.sparkp2p?.openGmailTab(); }}
                style={{ width: '100%', padding: '9px 0', borderRadius: 8, border: '1px solid #374151', background: 'transparent', color: '#d1d5db', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                {gmailConfigured ? 'Re-connect Gmail' : 'Connect Gmail'}
              </button>
            </div>

            {/* I&M Bot — the merchant's own downloadable payout bot.
                Status is a HEARTBEAT, not a setting: it says whether their bot
                is actually running right now, because when it isn't, buy orders
                sit and wait (they chose hold-and-alert over silently switching
                rails). So this card must never look "fine" when the bot is down. */}
            <div className="card">
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
                <div style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(59,130,246,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ width: 20, height: 20, borderRadius: 4, background: 'rgba(59,130,246,0.2)', border: '1.5px solid #3b82f6' }} />
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
                  background: imBot?.online ? 'rgba(16,185,129,0.15)' : imBot?.has_key ? 'rgba(245,158,11,0.15)' : 'rgba(107,114,128,0.12)',
                  color: imBot?.online ? '#10b981' : imBot?.has_key ? '#f59e0b' : '#6b7280' }}>
                  {imBot?.online ? 'Connected' : imBot?.has_key ? 'Offline' : 'Not set'}
                </span>
              </div>
              <div style={{ fontWeight: 700, color: '#fff', fontSize: 15, marginBottom: 6 }}>I&amp;M Bot</div>
              <div style={{ color: '#6b7280', fontSize: 12, lineHeight: 1.5, marginBottom: 10 }}>
                Pays buy orders from your own I&amp;M account, on your own machine.
                <strong style={{ color: '#9ca3af' }}> Buy orders only</strong> — sells stay on Choice Bank.
              </div>
              {imBot?.has_key && (
                <div style={{ fontSize: 11, color: imBot?.online ? '#10b981' : '#f59e0b', marginBottom: 10 }}>
                  {imBot?.online
                    ? `Bot online · seen ${imBotSeen(imBot.last_seen_at)}`
                    : `Bot not running · last seen ${imBotSeen(imBot.last_seen_at)} — buy orders will wait`}
                </div>
              )}
              {/* One-click launch: mint a handoff code, then open the desktop app
                  via its deep link. The app exchanges the code and lands signed in —
                  no second login. */}
              <button onClick={launchImBot} disabled={imLaunching}
                style={{ width: '100%', padding: '9px 0', borderRadius: 8, marginBottom: 8,
                  border: 'none', background: '#3b82f6', color: '#fff', fontWeight: 700, fontSize: 13,
                  cursor: imLaunching ? 'wait' : 'pointer' }}>
                {imLaunching ? 'Launching…' : '🚀 Launch I&M Bot'}
              </button>
              {imLaunchMsg && (
                <div style={{ fontSize: 11, color: imLaunchMsg.startsWith('✓') ? '#10b981' : '#f59e0b', marginBottom: 8, lineHeight: 1.5 }}>
                  {imLaunchMsg}
                </div>
              )}
              <button onClick={openImBot}
                style={{ width: '100%', padding: '9px 0', borderRadius: 8,
                  border: '1px solid #374151', background: 'transparent',
                  color: '#d1d5db', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                {imBot?.has_key ? 'Manage keys' : 'Set up manually'}
              </button>
            </div>

            {/* Binance TOTP verification */}
            <div className="card">
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
                <div style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(139,92,246,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ width: 20, height: 20, borderRadius: '50%', background: 'rgba(139,92,246,0.2)', border: '1.5px solid #8b5cf6' }} />
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
                  background: verifySaved ? 'rgba(16,185,129,0.15)' : 'rgba(107,114,128,0.12)',
                  color: verifySaved ? '#10b981' : '#6b7280' }}>
                  {verifySaved ? 'Configured' : 'Not set'}
                </span>
              </div>
              <div style={{ fontWeight: 700, color: '#fff', fontSize: 15, marginBottom: 6 }}>Binance TOTP verification</div>
              <div style={{ color: '#6b7280', fontSize: 12, lineHeight: 1.5, marginBottom: 16 }}>
                Method bot uses when Binance asks for identity verification on release.
              </div>
              {verifySaved && !verifyInput ? (
                <button onClick={() => setVerifyInput(' ')}
                  style={{ width: '100%', padding: '9px 0', borderRadius: 8, border: '1px solid #374151', background: 'transparent', color: '#d1d5db', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                  Update
                </button>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {verifyMethod === 'totp' && (
                    <div style={{ background: '#1a1d27', border: '1px solid #2a2d3a', borderRadius: 8, padding: '10px 12px', fontSize: 11, color: '#9ca3af', lineHeight: 1.7 }}>
                      <strong style={{ color: '#f59e0b', display: 'block', marginBottom: 4 }}>How to get your TOTP Secret Key:</strong>
                      <ol style={{ paddingLeft: 14, margin: 0 }}>
                        <li>Binance → Profile → Security</li>
                        <li>Google Authenticator → Manage → View Key</li>
                        <li>Copy the <strong style={{ color: '#f59e0b' }}>Secret Key</strong></li>
                      </ol>
                    </div>
                  )}
                  <input type="password" placeholder="TOTP Secret Key (e.g. JBSWY3DPEHPK3PXP)"
                    value={verifyInput.trim()} onChange={e => setVerifyInput(e.target.value)}
                    style={{ width: '100%', boxSizing: 'border-box', letterSpacing: 2, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, color: '#fff', padding: '8px 12px', fontSize: 13 }} />
                  {verifyMethod === 'totp' && (
                    <input inputMode="numeric" maxLength={6} placeholder="Current 6-digit code from Binance"
                      value={verifyCode} onChange={e => setVerifyCode(e.target.value.replace(/\D/g, ''))}
                      style={{ width: '100%', boxSizing: 'border-box', letterSpacing: 3, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, color: '#fff', padding: '8px 12px', fontSize: 13 }} />
                  )}
                  <div style={{ display: 'flex', gap: 6 }}>
                    {verifySaved && (
                      <button onClick={() => { setVerifyInput(''); setVerifyCode(''); }}
                        style={{ flex: 1, padding: '9px 0', borderRadius: 8, border: '1px solid #374151', background: 'transparent', color: '#9ca3af', fontSize: 13, cursor: 'pointer' }}>
                        Cancel
                      </button>
                    )}
                    <button disabled={!verifyInput.trim() || (verifyMethod === 'totp' && verifyCode.length !== 6) || loading}
                      onClick={async () => {
                        const val = verifyInput.trim(); setLoading(true);
                        try {
                          if (verifyMethod === 'totp') {
                            // Verify the code matches the secret server-side BEFORE saving (rejects a wrong key).
                            await saveBinance2fa(val, verifyCode.trim());
                          } else {
                            await updateVerification({ verify_method: verifyMethod, totp_secret: val, fund_password: null });
                          }
                          setVerifySaved(true); setVerifyInput(''); setVerifyCode('');
                          if (window.sparkp2p?.isDesktop) window.sparkp2p.setTotpSecret(val);
                        } catch (e) { showMsg(e.response?.data?.detail || 'Failed to save verification method'); }
                        setLoading(false);
                      }}
                      style={{ flex: 1, padding: '9px 0', borderRadius: 8, border: 'none',
                        background: verifyInput.trim() ? '#f59e0b' : '#374151',
                        color: verifyInput.trim() ? '#000' : '#6b7280', fontWeight: 700, fontSize: 13, cursor: verifyInput.trim() ? 'pointer' : 'not-allowed' }}>
                      {loading ? 'Verifying…' : 'Set up'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Trading limits summary */}
          <div className="card" style={{ border: '1px solid rgba(245,158,11,0.18)', background: '#09090f' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 34, height: 34, borderRadius: 9, background: 'rgba(245,158,11,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, flexShrink: 0 }}>🛡️</div>
                <div>
                  <div style={{ fontWeight: 700, color: '#fff', fontSize: 15 }}>Trading limits</div>
                  <div style={{ color: '#f59e0b', fontSize: 11, marginTop: 1 }}>Daily caps to control exposure</div>
                </div>
              </div>
              <button onClick={() => setActiveSection('trading')}
                style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 14px', borderRadius: 20, background: 'transparent', border: '1px solid rgba(245,158,11,0.35)', color: '#f59e0b', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                Edit ✎
              </button>
            </div>
            {/* Rows */}
            {(() => {
              const maxOrder = profile?.max_single_trade || 0;
              const dailyCnt = profile?.daily_trade_limit || 0;
              const dailyVol = maxOrder * dailyCnt;
              const short = n => n >= 1e9 ? Math.round(n/1e9)+'B' : n >= 1e6 ? Math.round(n/1e6)+'M' : n >= 1e3 ? Math.round(n/1e3)+'K' : String(n);
              const rows = [
                { icon: '🎯', bg: 'rgba(245,158,11,0.12)', label: 'Max per order',  sub: 'Cap on a single trade',     main: `KES ${maxOrder.toLocaleString()}`,    foot: null,                    color: '#f59e0b' },
                { icon: '📊', bg: 'rgba(59,130,246,0.12)',  label: 'Daily volume',   sub: 'Total daily trading cap',  main: `KES ${short(dailyVol)}`,              foot: dailyVol.toLocaleString(), color: '#3b82f6' },
                { icon: '📋', bg: 'rgba(139,92,246,0.12)',  label: 'Daily orders',   sub: 'Max number per day',       main: String(dailyCnt),                      foot: 'ORDERS',                color: '#8b5cf6' },
              ];
              return rows.map(({ icon, bg, label, sub, main, foot, color }, i) => (
                <div key={label} style={{ display: 'flex', alignItems: 'center', padding: '12px 0', borderBottom: i < rows.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
                  <div style={{ width: 38, height: 38, borderRadius: '50%', background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0, marginRight: 12 }}>
                    {icon}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: '#e5e7eb', fontWeight: 600, fontSize: 13 }}>{label}</div>
                    <div style={{ color: '#6b7280', fontSize: 11 }}>{sub}</div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ color: color, fontWeight: 800, fontSize: 15 }}>{main}</div>
                    {foot && <div style={{ color: color, fontSize: 10, fontWeight: 600, opacity: 0.75, letterSpacing: '0.4px' }}>{foot}</div>}
                  </div>
                </div>
              ));
            })()}
            {/* Footer note */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12, color: '#6b7280', fontSize: 11 }}>
              <span style={{ fontSize: 13, lineHeight: 1 }}>ⓘ</span>
              <span>Limits reset every 24 hours at 00:00 EAT</span>
            </div>
          </div>

          {/* ── Payout method ─────────────────────────────────────────────────── */}
          <div className="card" style={{ border: '1px solid rgba(139,92,246,0.18)', background: '#09090f' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <div style={{ width: 34, height: 34, borderRadius: 9, background: 'rgba(139,92,246,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, flexShrink: 0 }}>💸</div>
              <div>
                <div style={{ fontWeight: 700, color: '#fff', fontSize: 15 }}>Payout method</div>
                <div style={{ color: '#8b5cf6', fontSize: 11, marginTop: 1 }}>Which rail pays your buy orders</div>
              </div>
            </div>
            <div style={{ color: '#6b7280', fontSize: 12, margin: '4px 0 14px', lineHeight: 1.5 }}>
              Choose how sellers are paid on your <b style={{ color: '#9ca3af' }}>buy</b> orders. Selling always settles on Choice Bank.
            </div>

            {(() => {
              const rail = imBot?.payout_rail || (imBot?.buy_payout_via_im ? 'im_bot' : 'choice_bank');
              const onB2c = !!imBot?.on_b2c_plan || rail === 'own_paybill';
              const viaIm = rail === 'im_bot';
              const hasBot = !!imBot?.has_key;
              const online = !!imBot?.online;
              const pill = (text, color) => (
                <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: `${color}22`, color, letterSpacing: '.3px', flexShrink: 0 }}>{text}</span>
              );
              const Option = ({ selected, disabled, onClick, accent, icon, title, desc, badge }) => (
                <button type="button" onClick={disabled ? undefined : onClick} disabled={disabled || payoutBusy}
                  style={{
                    width: '100%', textAlign: 'left', display: 'flex', alignItems: 'flex-start', gap: 12,
                    padding: '14px 16px', marginBottom: 10, borderRadius: 12,
                    cursor: disabled ? 'not-allowed' : (payoutBusy ? 'wait' : 'pointer'),
                    border: `1.5px solid ${selected ? accent : 'rgba(255,255,255,0.08)'}`,
                    background: selected ? `${accent}14` : 'rgba(255,255,255,0.02)',
                    opacity: disabled ? 0.5 : 1, transition: 'border-color .15s, background .15s',
                  }}>
                  <div style={{ width: 20, height: 20, borderRadius: '50%', flexShrink: 0, marginTop: 2, border: `2px solid ${selected ? accent : '#4b5563'}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {selected && <div style={{ width: 10, height: 10, borderRadius: '50%', background: accent }} />}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 15, lineHeight: 1 }}>{icon}</span>
                      <span style={{ color: '#fff', fontWeight: 700, fontSize: 14 }}>{title}</span>
                      {badge}
                    </div>
                    <div style={{ color: '#9ca3af', fontSize: 12, marginTop: 4, lineHeight: 1.5 }}>{desc}</div>
                  </div>
                </button>
              );
              // On the B2C plan, the rail is part of what they pay for — it's
              // admin-managed, so every option is locked and they're pointed at
              // support. Otherwise they freely pick Choice Bank or I&M.
              return (
                <>
                  <Option selected={rail === 'choice_bank'} disabled={onB2c} accent="#3b82f6" icon="🏦" onClick={() => setPayoutMethod(false)}
                    title="Choice Bank"
                    badge={rail === 'choice_bank' ? pill('ACTIVE', '#3b82f6') : pill('Default', '#6b7280')}
                    desc="We pay sellers from your Choice Bank balance automatically. No setup — always available." />

                  <Option selected={viaIm} disabled={onB2c || !hasBot} accent="#f59e0b" icon="🤖" onClick={() => setPayoutMethod(true)}
                    title="I&M Bot — your own I&M account"
                    badge={viaIm ? pill('ACTIVE', '#f59e0b') : (!hasBot ? pill('Connect bot first', '#6b7280') : null)}
                    desc={hasBot
                      ? 'Your downloadable bot pays sellers from your own I&M account, on your machine. Buy orders only.'
                      : 'Connect your I&M Bot in the card above, then choose this to pay buy orders from your own I&M account.'} />

                  {/* B2C own-paybill — admin-managed (a paid plan). Active if they're on it. */}
                  <Option selected={onB2c} disabled accent="#10b981" icon="📲"
                    title="M-Pesa B2C — your own Paybill"
                    badge={onB2c ? pill('ACTIVE', '#10b981') : pill('B2C plan', '#10b981')}
                    desc={onB2c
                      ? 'Buy orders are paid from your own M-Pesa Paybill on your B2C plan. Managed with support.'
                      : 'Pay sellers straight from your own M-Pesa Paybill. Available on the B2C plan — contact support to set it up.'} />

                  {onB2c && (
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 4, padding: '10px 12px', borderRadius: 10, background: 'rgba(16,185,129,0.07)', border: '1px solid rgba(16,185,129,0.2)' }}>
                      <span style={{ fontSize: 13, lineHeight: 1.3 }}>🔒</span>
                      <span style={{ color: '#10b981', fontSize: 12, lineHeight: 1.5 }}>
                        Your payout rail is set by your <b>B2C plan</b>. Contact support to change it.
                      </span>
                    </div>
                  )}

                  {viaIm && !online && (
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 4, padding: '10px 12px', borderRadius: 10, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)' }}>
                      <span style={{ fontSize: 13, lineHeight: 1.3 }}>⚠️</span>
                      <span style={{ color: '#f59e0b', fontSize: 12, lineHeight: 1.5 }}>
                        Your I&amp;M Bot is offline, so buy orders will <b>wait</b> until it's running. Start the bot on your machine, or switch back to Choice Bank to pay now.
                      </span>
                    </div>
                  )}
                </>
              );
            })()}
          </div>

          {/* ── Binance API Key Card ──────────────────────────────────────────── */}
          <div style={{
            borderRadius: 16,
            background: 'linear-gradient(135deg, rgba(245,158,11,0.06) 0%, rgba(30,32,40,0.95) 60%)',
            border: '1px solid rgba(245,158,11,0.25)',
            borderTop: '2px solid #f59e0b',
            padding: '22px 24px 20px',
            position: 'relative',
            overflow: 'hidden',
          }}>
            {/* Decorative glow */}
            <div style={{ position: 'absolute', top: -40, right: -40, width: 120, height: 120, borderRadius: '50%', background: 'rgba(245,158,11,0.06)', pointerEvents: 'none' }} />

            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="8" cy="15" r="4"/><path d="M15 8l-1.5 1.5M20 3l-5 5M18.5 4.5l1 1M17 6l1 1"/><path d="M12 12l-4 3"/>
                </svg>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ color: '#f3f4f6', fontWeight: 700, fontSize: 15 }}>Binance API Key</span>
                  {profile?.binance_api_key_saved && (
                    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: 'rgba(16,185,129,0.15)', color: '#10b981', letterSpacing: '0.4px' }}>✓ SAVED</span>
                  )}
                  {profile?.binance_api_key_saved && profile?.binance_merchant_tier === 'gold' && (
                    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: 'rgba(245,158,11,0.18)', color: '#f59e0b', letterSpacing: '0.4px', border: '1px solid rgba(245,158,11,0.35)' }}>⭐ GOLD MERCHANT</span>
                  )}
                  {profile?.binance_api_key_saved && profile?.binance_merchant_tier !== 'gold' && (
                    <span title="Counterparty filters require a Binance Gold Merchant account" style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: 'rgba(107,114,128,0.15)', color: '#9ca3af', letterSpacing: '0.4px', border: '1px solid rgba(107,114,128,0.25)', cursor: 'help' }}>STANDARD ACCOUNT</span>
                  )}
                </div>
                <div style={{ color: '#9ca3af', fontSize: 12, marginTop: 2 }}>
                  {profile?.binance_api_key_saved && profile?.binance_merchant_tier !== 'gold'
                    ? 'Counterparty filters require a Binance Gold Merchant account'
                    : 'Enables counterparty filters on your live ads'}
                </div>
              </div>
            </div>

            {/* Permission chips */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
              {[
                { label: 'Read', ok: true },
                { label: 'Enable Spot & Margin Trading', ok: true },
                { label: 'Withdrawals — keep OFF', ok: false },
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

            {/* Relay must be online to verify keys (server can't reach Binance directly) */}
            <RelayConnectStatus />

            {/* Inputs */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 18 }}>
              {/* API Key */}
              <div>
                <label style={{ display: 'block', color: '#9ca3af', fontSize: 11, fontWeight: 600, marginBottom: 6, letterSpacing: '0.4px' }}>API KEY</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#6b7280' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="8" cy="15" r="4"/><path d="M15 8l-1.5 1.5M20 3l-5 5"/>
                    </svg>
                  </span>
                  <input
                    type="text"
                    placeholder={profile?.binance_api_key_saved ? '••••••••••••••••••••••••  (saved)' : 'Paste your Binance API key'}
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                    style={{
                      width: '100%', boxSizing: 'border-box',
                      paddingLeft: 36, paddingRight: 80, paddingTop: 10, paddingBottom: 10,
                      borderRadius: 10, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                      color: '#e5e7eb', fontSize: 13, fontFamily: 'monospace', outline: 'none',
                    }}
                  />
                  <button
                    onClick={() => navigator.clipboard.readText().then(t => setApiKey(t)).catch(() => {})}
                    style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', padding: '4px 10px', borderRadius: 6, background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.25)', color: '#f59e0b', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                    Paste
                  </button>
                </div>
              </div>

              {/* Secret Key */}
              <div>
                <label style={{ display: 'block', color: '#9ca3af', fontSize: 11, fontWeight: 600, marginBottom: 6, letterSpacing: '0.4px' }}>SECRET KEY</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#6b7280' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                    </svg>
                  </span>
                  <input
                    type={showSecret ? 'text' : 'password'}
                    placeholder={profile?.binance_api_key_saved ? '••••••••••••••••••••••••  (saved)' : 'Paste your API secret'}
                    value={apiSecret}
                    onChange={e => setApiSecret(e.target.value)}
                    style={{
                      width: '100%', boxSizing: 'border-box',
                      paddingLeft: 36, paddingRight: 120, paddingTop: 10, paddingBottom: 10,
                      borderRadius: 10, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                      color: '#e5e7eb', fontSize: 13, fontFamily: 'monospace', outline: 'none',
                    }}
                  />
                  <div style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', display: 'flex', gap: 6 }}>
                    <button
                      onClick={() => setShowSecret(v => !v)}
                      style={{ padding: '4px 8px', borderRadius: 6, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#9ca3af', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                      {showSecret ? 'Hide' : 'Show'}
                    </button>
                    <button
                      onClick={() => navigator.clipboard.readText().then(t => setApiSecret(t)).catch(() => {})}
                      style={{ padding: '4px 10px', borderRadius: 6, background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.25)', color: '#f59e0b', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                      Paste
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Message */}
            {apiKeyMsg && (
              <div style={{ marginBottom: 12, padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                background: apiKeyMsg.startsWith('✓') ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)',
                color: apiKeyMsg.startsWith('✓') ? '#10b981' : '#ef4444',
                border: `1px solid ${apiKeyMsg.startsWith('✓') ? 'rgba(16,185,129,0.25)' : 'rgba(239,68,68,0.25)'}`,
              }}>
                {apiKeyMsg}
              </div>
            )}

            {/* Footer */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#6b7280', fontSize: 11 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
                <span>Keys are encrypted and stored securely.</span>
                <a href="https://www.binance.com/en/support/faq/360002502072" target="_blank" rel="noreferrer"
                  style={{ color: '#f59e0b', textDecoration: 'none', fontWeight: 600 }}>
                  Where do I find these?
                </a>
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button
                  disabled={!apiKey.trim() || !apiSecret.trim() || apiKeySaving}
                  onClick={async () => {
                    setApiKeySaving(true);
                    setApiKeyMsg('');
                    try {
                      await saveBinanceApiKey({ api_key: apiKey.trim(), api_secret: apiSecret.trim(), test_only: true });
                      setApiKeyMsg('✓ Connection verified');
                    } catch (err) {
                      setApiKeyMsg(err.response?.data?.detail || 'Connection test failed');
                    } finally {
                      setApiKeySaving(false);
                    }
                  }}
                  style={{
                    padding: '9px 18px', borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                    background: 'transparent', border: '1px solid rgba(245,158,11,0.35)', color: '#f59e0b',
                    opacity: !apiKey.trim() || !apiSecret.trim() || apiKeySaving ? 0.4 : 1,
                  }}>
                  Test connection
                </button>
                <button
                  disabled={!apiKey.trim() || !apiSecret.trim() || apiKeySaving}
                  onClick={async () => {
                    setApiKeySaving(true);
                    setApiKeyMsg('');
                    try {
                      const res = await saveBinanceApiKey({ api_key: apiKey.trim(), api_secret: apiSecret.trim() });
                      const capable = res.data?.merchant_capable;
                      setApiKeyMsg(capable
                        ? '✓ API key saved — Gold Merchant account detected'
                        : '✓ API key saved — Standard account (counterparty filters require Gold Merchant)');
                      setApiKey('');
                      setApiSecret('');
                      onUpdate();
                    } catch (err) {
                      setApiKeyMsg(err.response?.data?.detail || 'Failed to save API key');
                    } finally {
                      setApiKeySaving(false);
                    }
                  }}
                  style={{
                    padding: '9px 22px', borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: 'pointer',
                    background: !apiKey.trim() || !apiSecret.trim() || apiKeySaving ? 'rgba(245,158,11,0.3)' : '#f59e0b',
                    border: 'none', color: '#000',
                    opacity: !apiKey.trim() || !apiSecret.trim() || apiKeySaving ? 0.5 : 1,
                  }}>
                  {apiKeySaving ? 'Saving…' : 'Save API Key'}
                </button>
                {profile?.binance_api_key_saved && (
                  <button
                    disabled={apiKeySaving}
                    onClick={async () => {
                      if (!window.confirm('Remove this Binance API key from this account?\n\nThe key is deleted from the server completely, so you can connect it to a different SparkP2P account. This account will have no key until you connect one again.')) return;
                      setApiKeySaving(true);
                      setApiKeyMsg('');
                      try {
                        await deleteBinanceApiKey();
                        setApiKeyMsg('✓ API key removed — this account is now neutral');
                        setApiKey('');
                        setApiSecret('');
                        onUpdate();
                      } catch (err) {
                        setApiKeyMsg(err.response?.data?.detail || 'Failed to remove API key');
                      } finally {
                        setApiKeySaving(false);
                      }
                    }}
                    style={{
                      padding: '9px 18px', borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                      background: 'transparent', border: '1px solid rgba(239,68,68,0.5)', color: '#ef4444',
                      opacity: apiKeySaving ? 0.5 : 1, marginLeft: 'auto',
                    }}>
                    Delete Key
                  </button>
                )}
              </div>
            </div>
          </div>

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

      {activeSection === 'security' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

          {/* ── Biometric unlock (native app only) ──────────── */}
          <BiometricSetting />

          {/* ── Profile Details ─────────────────────────────── */}
          <div className="card" style={{ marginBottom: 0 }}>
            {/* Card header */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 20 }}>
              <div style={{ width: 42, height: 42, borderRadius: 11, background: 'rgba(245,176,20,0.14)', color: '#f5b014', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
                </svg>
              </div>
              <div>
                <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>Profile Details</div>
                <div style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.5 }}>Your display name as it appears on trades. Must match your Binance KYC.</div>
              </div>
            </div>

            {/* 2-col form grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginBottom: 16 }}>
              {/* Email */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  Email <span style={{ fontWeight: 400, color: 'var(--text-dim)', fontSize: 11.5 }}>verified</span>
                </label>
                <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 11 }}>
                  <input type="email" value={profile?.email || ''} readOnly
                    style={{ flex: 1, background: 'none', border: 0, outline: 0, color: 'var(--text)', fontFamily: 'monospace', fontSize: 13, padding: '12px 14px', minWidth: 0 }} />
                  <span style={{ padding: '0 12px', color: '#27c281', display: 'flex', alignItems: 'center' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                  </span>
                </div>
              </div>

              {/* Phone */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  Phone <span style={{ fontWeight: 400, color: 'var(--text-dim)', fontSize: 11.5 }}>verified</span>
                </label>
                <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 11 }}>
                  <span style={{ padding: '0 0 0 13px', color: 'var(--text-dim)', fontFamily: 'monospace', fontSize: 12.5, whiteSpace: 'nowrap' }}>🇰🇪 +254</span>
                  <input type="text" value={profile?.phone ? `••• ••• ${profile.phone.slice(-4)}` : ''} readOnly
                    style={{ flex: 1, background: 'none', border: 0, outline: 0, color: 'var(--text)', fontFamily: 'monospace', fontSize: 13, padding: '12px 14px', minWidth: 0 }} />
                  <span style={{ padding: '0 12px', color: '#27c281', display: 'flex', alignItems: 'center' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                  </span>
                </div>
              </div>

              {/* Full name — spans full width */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, gridColumn: '1 / -1' }}>
                <label style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  Full Name <span style={{ fontWeight: 400, color: 'var(--text-dim)', fontSize: 11.5 }}>as on Binance KYC</span>
                </label>
                <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 11 }}>
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value.toUpperCase())}
                    placeholder="JOHN DOE MWANGI"
                    style={{ flex: 1, background: 'none', border: 0, outline: 0, color: 'var(--text)', fontSize: 13.5, padding: '12px 14px', minWidth: 0, textTransform: 'uppercase' }}
                  />
                </div>
              </div>
            </div>

            {/* Form actions */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, paddingTop: 6, borderTop: '1px dashed rgba(255,255,255,0.07)', marginTop: 4 }}>
              <button
                onClick={() => setEditName(profile?.full_name || '')}
                style={{ padding: '10px 18px', borderRadius: 10, border: '1px solid var(--border)', background: 'rgba(255,255,255,0.04)', color: 'var(--text)', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                Cancel
              </button>
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
                style={{ padding: '10px 20px', borderRadius: 10, border: 'none', background: 'linear-gradient(180deg,#ffc234,#f5b014)', color: '#1a1300', fontWeight: 700, fontSize: 13, cursor: 'pointer', boxShadow: '0 6px 18px -10px rgba(245,176,20,0.7)' }}>
                {savingName ? 'Saving...' : 'Save Name'}
              </button>
            </div>
          </div>

          {/* ── Security Question ───────────────────────────── */}
          <div className="card" style={{ marginBottom: 0 }}>
            {/* Card header */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 20 }}>
              <div style={{ width: 42, height: 42, borderRadius: 11, background: 'rgba(142,123,243,0.16)', color: '#8e7bf3', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
                  <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)' }}>Security Question</span>
                  {(profile?.security_question || sqJustSaved)
                    ? <span style={{ fontSize: 10.5, fontWeight: 700, padding: '4px 9px', borderRadius: 99, background: 'rgba(245,176,20,0.14)', color: '#f5b014', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Set</span>
                    : <span style={{ fontSize: 10.5, fontWeight: 700, padding: '4px 9px', borderRadius: 99, background: 'rgba(255,93,93,0.13)', color: '#ff5d5d', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Not Set</span>
                  }
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                  Used to verify your identity when changing payment methods.{' '}
                  <strong style={{ color: '#ff5d5d', fontWeight: 700 }}>Cannot be changed once set.</strong>
                </div>
              </div>
            </div>

            {(profile?.security_question || sqJustSaved) ? (
              /* ── Set state: sq-box ── */
              <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)', borderRadius: 13, padding: 16, display: 'flex', gap: 13 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, flexShrink: 0, background: 'rgba(39,194,129,0.14)', color: '#27c281', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                </div>
                <div>
                  <div style={{ color: '#27c281', fontWeight: 700, fontSize: 13, marginBottom: 6, letterSpacing: '0.02em' }}>Security question is set</div>
                  <div style={{ color: 'var(--text)', fontSize: 13.5, fontWeight: 500, marginBottom: 6 }}>{profile?.security_question || sqJustSaved}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>Your answer is securely hashed and cannot be viewed. To reset, contact support with your KYC documents.</div>
                </div>
              </div>
            ) : (
              /* ── Not set: setup form ── */
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
                <div style={{ padding: '10px 14px', borderRadius: 10, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', fontSize: 13, color: '#f5b014', marginBottom: 16 }}>
                  Choose carefully — this question cannot be changed after saving.
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <label style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>Security Question</label>
                    <select value={sqQuestion} onChange={(e) => setSqQuestion(e.target.value)} required style={{ width: '100%', padding: '11px 14px', borderRadius: 11, background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 13.5, outline: 'none' }}>
                      <option value="">Select a question</option>
                      <option>What is your mother's maiden name?</option>
                      <option>What was the name of your first pet?</option>
                      <option>What city were you born in?</option>
                      <option>What is the name of your primary school?</option>
                      <option>What was your childhood nickname?</option>
                    </select>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <label style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>Your Answer</label>
                    <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 11 }}>
                      <input type="text" placeholder="Answer (case-insensitive)" value={sqAnswer} onChange={(e) => setSqAnswer(e.target.value)} required
                        style={{ flex: 1, background: 'none', border: 0, outline: 0, color: 'var(--text)', fontSize: 13.5, padding: '12px 14px' }} />
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 4, borderTop: '1px dashed rgba(255,255,255,0.07)' }}>
                    <button type="submit" disabled={savingSq}
                      style={{ padding: '11px 22px', borderRadius: 10, border: 'none', background: 'linear-gradient(180deg,#ffc234,#f5b014)', color: '#1a1300', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                      {savingSq ? 'Saving...' : 'Save Security Question'}
                    </button>
                  </div>
                </div>
              </form>
            )}
          </div>

          {/* ── Google Authenticator (TOTP) ─────────────────── */}
          <div className="card" style={{ marginBottom: 0 }}>
            {/* Card header */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 20 }}>
              <div style={{ width: 42, height: 42, borderRadius: 11, background: 'rgba(39,194,129,0.14)', color: '#27c281', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                </svg>
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
                  <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)' }}>Google Authenticator</span>
                  {totpEnabled
                    ? <span style={{ fontSize: 10.5, fontWeight: 700, padding: '4px 9px', borderRadius: 99, background: 'rgba(39,194,129,0.14)', color: '#27c281', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Enabled</span>
                    : <span style={{ fontSize: 10.5, fontWeight: 700, padding: '4px 9px', borderRadius: 99, background: 'rgba(255,93,93,0.13)', color: '#ff5d5d', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Not set</span>
                  }
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.5 }}>Adds a 6-digit code from Google Authenticator as a second factor when releasing crypto.</div>
              </div>
            </div>

            {totpEnabled ? (
              /* ── Enabled state ── */
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 18, alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>Two-factor authentication</div>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600, background: 'rgba(39,194,129,0.14)', color: '#27c281', padding: '6px 11px', borderRadius: 99, marginTop: 6 }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'currentColor', display: 'inline-block' }} />
                    Authenticator linked
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
                  style={{ padding: '10px 18px', borderRadius: 10, border: '1px solid rgba(255,93,93,0.3)', background: 'transparent', color: '#ff5d5d', cursor: 'pointer', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>
                  Remove
                </button>
              </div>
            ) : !totpSetup ? (
              /* ── Not configured, no setup in progress ── */
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>Two-factor authentication</div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>Strongly recommended. Without 2FA, releases above KES 100,000 require email OTP each time.</div>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600, background: 'rgba(255,93,93,0.13)', color: '#ff5d5d', padding: '6px 11px', borderRadius: 99, marginTop: 10 }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'currentColor', display: 'inline-block' }} />
                    Not configured
                  </div>
                </div>
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
                  style={{ padding: '11px 18px', borderRadius: 10, border: 'none', background: 'linear-gradient(180deg,#ffc234,#f5b014)', color: '#1a1300', fontWeight: 700, fontSize: 13, cursor: 'pointer', boxShadow: '0 6px 18px -10px rgba(245,176,20,0.7)', whiteSpace: 'nowrap' }}>
                  {totpLoading ? 'Generating...' : 'Set up 2FA'}
                </button>
              </div>
            ) : (
              /* ── Setup in progress: QR + verify ── */
              <div>
                <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 16 }}>
                  Scan the QR code with <strong style={{ color: 'var(--text)' }}>Google Authenticator</strong>, then enter the 6-digit code to confirm.
                </p>
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
                  <div style={{ background: '#fff', padding: 16, borderRadius: 12 }}>
                    <QRCodeSVG value={totpSetup.uri} size={180} />
                  </div>
                </div>
                <div style={{ padding: '10px 14px', background: 'rgba(255,255,255,0.04)', borderRadius: 10, border: '1px solid rgba(255,255,255,0.08)', marginBottom: 20 }}>
                  <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Can't scan? Enter this key manually:</div>
                  <div style={{ fontFamily: 'monospace', fontSize: 14, color: '#f5b014', letterSpacing: 2, wordBreak: 'break-all' }}>{totpSetup.secret}</div>
                </div>
                <div style={{ marginBottom: 12 }}>
                  <label style={{ fontSize: 13, color: '#9ca3af', display: 'block', marginBottom: 6 }}>6-digit code from Google Authenticator</label>
                  <input type="text" inputMode="numeric" maxLength={6} placeholder="000000"
                    value={totpCode} onChange={e => setTotpCode(e.target.value.replace(/\D/g, ''))}
                    style={{ width: '100%', padding: '12px 14px', borderRadius: 11, border: '1px solid rgba(255,255,255,0.15)', background: 'var(--bg)', color: '#fff', fontSize: 20, letterSpacing: 8, textAlign: 'center', boxSizing: 'border-box', outline: 'none' }} />
                </div>
                {totpMsg && <p style={{ fontSize: 12, color: totpMsg.includes('success') || totpMsg.includes('linked') ? '#27c281' : '#ff5d5d', marginBottom: 12 }}>{totpMsg}</p>}
                <div style={{ display: 'flex', gap: 10 }}>
                  <button onClick={() => { setTotpSetup(null); setTotpCode(''); setTotpMsg(''); }}
                    style={{ padding: '10px 20px', borderRadius: 10, border: '1px solid var(--border)', background: 'rgba(255,255,255,0.04)', color: '#9ca3af', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                    Cancel
                  </button>
                  <button disabled={totpSaving || totpCode.length !== 6}
                    onClick={async () => {
                      setTotpSaving(true); setTotpMsg('');
                      try {
                        await verifyAndSaveTotp({ secret: totpSetup.secret, code: totpCode });
                        setTotpEnabled(true); setTotpSetup(null); setTotpCode('');
                        setTotpMsg('Google Authenticator linked successfully!');
                        if (onUpdate) { const r = await getProfile(); onUpdate(r.data); }
                      } catch (err) {
                        setTotpMsg(err.response?.data?.detail || 'Invalid code. Try again.');
                      }
                      setTotpSaving(false);
                    }}
                    style={{ flex: 1, padding: '10px 20px', borderRadius: 10, border: 'none', background: totpCode.length === 6 ? '#27c281' : '#374151', color: '#fff', fontWeight: 700, cursor: totpCode.length === 6 ? 'pointer' : 'not-allowed', fontSize: 13 }}>
                    {totpSaving ? 'Verifying...' : 'Confirm & Link'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* ── Password & Sessions ──────────────────────────── */}
          <div className="card" style={{ marginBottom: 0 }}>
            {/* Card header */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 20 }}>
              <div style={{ width: 42, height: 42, borderRadius: 11, background: 'rgba(79,142,247,0.14)', color: '#4f8ef7', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
              </div>
              <div>
                <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>Password &amp; Sessions</div>
                <div style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.5 }}>Change password, sign out other devices, view recent login activity.</div>
              </div>
            </div>

            {/* Step 0: idle — last login + action buttons */}
            {cpStep === 0 && !cpCooldownUntil && (
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 18, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>Last login</div>
                  <div style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text-dim)' }}>
                    {profile?.last_login ? new Date(profile.last_login).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short' }) + ' EAT' : 'Unknown'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
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
                    style={{ padding: '10px 18px', borderRadius: 10, border: '1px solid var(--border)', background: 'rgba(255,255,255,0.04)', color: 'var(--text)', fontWeight: 600, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    {cpLoading ? 'Sending OTP...' : 'Change password'}
                  </button>
                  <button
                    onClick={async () => {
                      try {
                        await api.post('/auth/logout-all');
                        showMsg('Signed out of all other sessions');
                      } catch { showMsg('Failed — please try again'); }
                    }}
                    style={{ padding: '10px 18px', borderRadius: 10, border: '1px solid var(--border)', background: 'rgba(255,255,255,0.04)', color: 'var(--text)', fontWeight: 600, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    Sign out other devices
                  </button>
                </div>
              </div>
            )}

            {/* Cooldown state */}
            {cpCooldownUntil && (
              <div style={{ padding: 16, background: 'rgba(245,158,11,0.06)', borderRadius: 10, border: '1px solid rgba(245,158,11,0.25)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <span style={{ fontSize: 20 }}>⏳</span>
                  <span style={{ fontSize: 13, color: '#f5b014', fontWeight: 600 }}>Password change locked</span>
                </div>
                <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 10px' }}>For your security, you can only change your password once every 48 hours.</p>
                <div style={{ fontSize: 30, fontWeight: 800, color: '#f5b014', fontVariantNumeric: 'tabular-nums', letterSpacing: 2 }}>{cpCooldown}</div>
                <p style={{ fontSize: 11, color: '#6b7280', marginTop: 6 }}>Time remaining until you can change your password again.</p>
              </div>
            )}

            {/* Step 1: OTP + new password form */}
            {cpStep === 1 && (
              <form onSubmit={async (e) => {
                e.preventDefault();
                const failed = PW_RULES.filter((r) => !r.test(cpNewPw));
                if (failed.length > 0) { showMsg(`Password missing: ${failed.map((r) => r.label).join(', ')}`); return; }
                if (cpNewPw !== cpConfirm) { showMsg('Passwords do not match'); return; }
                setCpLoading(true);
                try {
                  const res = await changePassword(cpOtp, cpNewPw);
                  if (res.data.cooldown_until) setCpCooldownUntil(new Date(res.data.cooldown_until));
                  setCpStep(2);
                  showMsg('Password changed successfully!');
                  setCpOtp(''); setCpNewPw(''); setCpConfirm('');
                } catch (err) {
                  showMsg(err.response?.data?.detail || 'Failed to change password');
                }
                setCpLoading(false);
              }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <label style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>
                      OTP Code <span style={{ fontWeight: 400, color: 'var(--text-dim)', fontSize: 11.5 }}>(sent to {cpPhoneHint})</span>
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 11 }}>
                      <input type="text" placeholder="6-digit code" value={cpOtp} onChange={(e) => setCpOtp(e.target.value)} maxLength={6} autoFocus required
                        style={{ flex: 1, background: 'none', border: 0, outline: 0, color: 'var(--text)', fontSize: 13.5, padding: '12px 14px' }} />
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <label style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>New Password</label>
                    <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 11 }}>
                      <input type={cpShowPw ? 'text' : 'password'} placeholder="Create a strong password" value={cpNewPw} onChange={(e) => setCpNewPw(e.target.value)} required
                        style={{ flex: 1, background: 'none', border: 0, outline: 0, color: 'var(--text)', fontSize: 13.5, padding: '12px 14px' }} />
                      <button type="button" onClick={() => setCpShowPw(!cpShowPw)}
                        style={{ padding: '0 14px', background: 'none', border: 0, color: '#9ca3af', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                        {cpShowPw ? 'Hide' : 'Show'}
                      </button>
                    </div>
                  </div>
                  {cpNewPw && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', padding: '10px 12px', background: 'var(--bg)', borderRadius: 10, border: '1px solid var(--border)' }}>
                      {PW_RULES.map((rule, i) => (
                        <span key={i} style={{ fontSize: 11, color: rule.test(cpNewPw) ? '#27c281' : '#6b7280' }}>
                          {rule.test(cpNewPw) ? '✓' : '✗'} {rule.label}
                        </span>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <label style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>Confirm New Password</label>
                    <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 11 }}>
                      <input type="password" placeholder="Re-enter new password" value={cpConfirm} onChange={(e) => setCpConfirm(e.target.value)} required
                        style={{ flex: 1, background: 'none', border: 0, outline: 0, color: 'var(--text)', fontSize: 13.5, padding: '12px 14px' }} />
                    </div>
                    {cpConfirm && cpNewPw !== cpConfirm && (
                      <span style={{ fontSize: 12, color: '#ff5d5d', display: 'block' }}>Passwords do not match</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 4, borderTop: '1px dashed rgba(255,255,255,0.07)' }}>
                    <button type="button" onClick={() => { setCpStep(0); setCpOtp(''); setCpNewPw(''); setCpConfirm(''); }}
                      style={{ padding: '10px 18px', borderRadius: 10, border: '1px solid var(--border)', background: 'rgba(255,255,255,0.04)', color: '#9ca3af', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                      Cancel
                    </button>
                    <button type="submit" disabled={cpLoading || !cpOtp || !cpNewPw || cpNewPw !== cpConfirm}
                      style={{ padding: '10px 22px', borderRadius: 10, border: 'none', background: 'linear-gradient(180deg,#ffc234,#f5b014)', color: '#1a1300', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                      {cpLoading ? 'Saving...' : 'Set New Password'}
                    </button>
                  </div>
                </div>
              </form>
            )}

            {/* Step 2: success */}
            {cpStep === 2 && !cpCooldownUntil && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 16, background: 'rgba(39,194,129,0.08)', borderRadius: 10, border: '1px solid rgba(39,194,129,0.3)' }}>
                <span style={{ fontSize: 24 }}>✅</span>
                <div>
                  <div style={{ fontWeight: 600, color: '#27c281', fontSize: 14 }}>Password changed successfully</div>
                  <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>Your new password is active.</div>
                </div>
              </div>
            )}
          </div>

          {/* ── Danger Zone ──────────────────────────────────── */}
          <div className="card" style={{ marginBottom: 0, borderColor: 'rgba(255,93,93,0.25)' }}>
            {/* Card header */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 20 }}>
              <div style={{ width: 42, height: 42, borderRadius: 11, background: 'rgba(255,93,93,0.13)', color: '#ff5d5d', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                  <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
              </div>
              <div>
                <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>Danger zone</div>
                <div style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.5 }}>Pause trading or close your account. These actions are irreversible.</div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 18, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>Close SparkP2P account</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>All open orders cancelled. Trade history retained for 7 years for compliance.</div>
              </div>
              <button
                onClick={() => showMsg('Account closure must be requested via support. Email support@sparkp2p.com')}
                style={{ padding: '10px 18px', borderRadius: 10, background: 'transparent', border: '1px solid rgba(255,93,93,0.3)', color: '#ff5d5d', fontWeight: 600, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}>
                Request closure
              </button>
            </div>
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
            <input
              type="text"
              value={Number(dailyLimit).toLocaleString()}
              onChange={(e) => {
                const raw = e.target.value.replace(/[^0-9]/g, '');
                setDailyLimit(raw === '' ? 0 : parseInt(raw, 10));
              }}
            />

            <label>Max Single Trade (KES)</label>
            <input
              type="text"
              value={Number(maxTrade).toLocaleString()}
              onChange={(e) => {
                const raw = e.target.value.replace(/[^0-9]/g, '');
                setMaxTrade(raw === '' ? 0 : parseInt(raw, 10));
              }}
            />

            <div className="toggle-row">
              <label>Batch Settlement</label>
              <input type="checkbox" checked={batchEnabled} onChange={(e) => setBatchEnabled(e.target.checked)} />
            </div>
            <p className="help-text">Accumulate earnings until your threshold is reached, then disburse in the next hourly cycle.</p>
            {!batchEnabled && (
              <p className="help-text" style={{ color: '#f59e0b', marginTop: '4px' }}>
                ⚠️ Batch Settlement is OFF — M-Pesa users can withdraw any amount at any time. Only one withdrawal can be pending at a time; the next will auto-initiate for your full balance once the current one completes. I&M Bank users should enable Batch Settlement to control disbursement timing.
              </p>
            )}

            {batchEnabled && (
              <>
                <label>Batch Threshold (KES)</label>
                <input
                  type="text"
                  value={Number(batchThreshold).toLocaleString()}
                  onChange={(e) => {
                    const raw = e.target.value.replace(/[^0-9]/g, '');
                    setBatchThreshold(raw === '' ? 0 : parseInt(raw, 10));
                  }}
                />
                <p className="help-text">
                  Earnings accumulate until this amount is reached, then queue for the next hourly disbursement.
                  Only one disbursement runs at a time — if one is pending, the next will fire automatically for your full balance once it completes.
                </p>
              </>
            )}

            <button type="submit" disabled={loading}>
              {loading ? 'Saving...' : 'Save Trading Settings'}
            </button>
          </form>
        </div>
      )}
      {activeSection === 'notifications' && (
        <div className="card">
          <h3>Telegram Notifications</h3>
          <p className="help-text" style={{ marginBottom: 16 }}>
            Connect your Telegram account to receive sell order approval requests directly in Telegram.
            For each new sell order you will get a message with the buyer's stats and YES/NO buttons to approve or reject before payment details are sent.
          </p>

          {tgConnected ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, padding: '14px 16px', background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: 10 }}>
                <span style={{ fontSize: 22 }}>✅</span>
                <div>
                  <div style={{ color: '#10b981', fontWeight: 700, fontSize: 15 }}>Telegram Connected</div>
                  <div style={{ color: '#6b7280', fontSize: 13, marginTop: 2 }}>You will receive sell order approval requests in @Sparkp2p_bot</div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  onClick={handleTestTelegram}
                  disabled={tgTesting}
                  style={{ padding: '10px 20px', borderRadius: 8, border: '1px solid #10b981', background: 'transparent', color: '#10b981', cursor: 'pointer', fontSize: 14 }}
                >
                  {tgTesting ? 'Sending...' : 'Send Test Message'}
                </button>
                <button
                  onClick={handleDisconnectTelegram}
                  disabled={tgDisconnecting}
                  style={{ padding: '10px 20px', borderRadius: 8, border: '1px solid #ef4444', background: 'transparent', color: '#ef4444', cursor: 'pointer', fontSize: 14 }}
                >
                  {tgDisconnecting ? 'Disconnecting...' : 'Disconnect Telegram'}
                </button>
                {tgTestResult === 'ok' && (
                  <span style={{ color: '#10b981', fontSize: 13 }}>Message sent — check your Telegram</span>
                )}
                {tgTestResult === 'error' && (
                  <span style={{ color: '#ef4444', fontSize: 13 }}>Failed to send — check bot connection</span>
                )}
              </div>
            </div>
          ) : (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, padding: '14px 16px', background: 'rgba(107,114,128,0.08)', border: '1px solid rgba(107,114,128,0.3)', borderRadius: 10 }}>
                <span style={{ fontSize: 22 }}>🔔</span>
                <div>
                  <div style={{ color: '#9ca3af', fontWeight: 700, fontSize: 15 }}>Not Connected</div>
                  <div style={{ color: '#6b7280', fontSize: 13, marginTop: 2 }}>Connect Telegram to enable sell order approval gates</div>
                </div>
              </div>

              {tgCode ? (
                <div style={{ padding: '18px 20px', background: 'rgba(79,70,229,0.08)', border: '1px solid rgba(79,70,229,0.3)', borderRadius: 12, marginBottom: 20 }}>
                  <div style={{ color: '#a5b4fc', fontWeight: 600, marginBottom: 10, fontSize: 14 }}>Follow these steps:</div>
                  <ol style={{ color: '#d1d5db', fontSize: 14, lineHeight: 2, paddingLeft: 20, margin: 0 }}>
                    <li>Open Telegram and search for <strong style={{ color: '#fff' }}>@Sparkp2p_bot</strong></li>
                    <li>Start the bot by tapping <strong style={{ color: '#fff' }}>Start</strong></li>
                    <li>Send this message to the bot:</li>
                  </ol>
                  <div style={{ margin: '12px 0', padding: '12px 16px', background: '#0f1117', borderRadius: 8, fontFamily: 'monospace', fontSize: 18, fontWeight: 700, color: '#a5b4fc', textAlign: 'center', letterSpacing: 4 }}>
                    /link {tgCode.code}
                  </div>
                  <div style={{ color: '#6b7280', fontSize: 12, textAlign: 'center' }}>
                    Code expires in {Math.floor(tgCode.expires_in / 60)} minutes. This page will update automatically once connected.
                  </div>
                </div>
              ) : (
                <button
                  onClick={handleGenerateTgCode}
                  disabled={tgCodeLoading}
                  style={{ padding: '12px 24px', borderRadius: 8, border: 'none', background: '#4f46e5', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 14 }}
                >
                  {tgCodeLoading ? 'Generating...' : 'Connect Telegram'}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Pause Bot 2FA Modal */}
      {/* ── I&M Bot connect ────────────────────────────────────────────────
          Hands the merchant the two things their bot needs (URL + key) and
          nothing else. The key is shown ONCE: we store only its hash, so this
          modal is the only moment it exists anywhere outside their machine. */}
      {imBotOpen && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }} onClick={(e) => { if (e.target === e.currentTarget) setImBotOpen(false); }}>
          <div style={{ background: '#12141c', border: '1px solid #2a2d3a', borderRadius: 14, padding: 24, width: '100%', maxWidth: 560, maxHeight: '88vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <div style={{ fontWeight: 800, color: '#fff', fontSize: 17 }}>Connect your I&amp;M Bot</div>
              <button onClick={() => setImBotOpen(false)}
                style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: 22, cursor: 'pointer', lineHeight: 1 }}>×</button>
            </div>
            <div style={{ color: '#6b7280', fontSize: 12, marginBottom: 16 }}>
              The bot runs on your own computer, logged into your own I&amp;M account. SparkP2P never logs into your bank.
            </div>

            <div style={{ background: 'rgba(245,158,11,0.06)', borderLeft: '3px solid #f59e0b', borderRadius: '0 8px 8px 0', padding: '10px 12px', marginBottom: 18 }}>
              <div style={{ color: '#f59e0b', fontWeight: 700, fontSize: 12, marginBottom: 2 }}>Buy orders only</div>
              <div style={{ color: '#9ca3af', fontSize: 12, lineHeight: 1.5 }}>
                I&amp;M can only send money out, so the bot pays sellers when you <strong>buy</strong> crypto.
                Sell orders keep using the Choice Bank gateway.
              </div>
            </div>

            {/* Step 1 — URL */}
            <div style={{ color: '#9ca3af', fontSize: 11, fontWeight: 700, letterSpacing: 0.5, marginBottom: 6 }}>1 · SPARKP2P URL</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
              <input readOnly value={window.location.origin}
                style={{ flex: 1, padding: '9px 11px', borderRadius: 8, border: '1px solid #2a2d3a', background: '#0d0f16', color: '#d1d5db', fontFamily: 'monospace', fontSize: 12 }} />
              <button onClick={() => copyImBot(window.location.origin, 'url')}
                style={{ padding: '9px 14px', borderRadius: 8, border: '1px solid #374151', background: 'transparent', color: '#d1d5db', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                {imBotCopied === 'url' ? 'Copied' : 'Copy'}
              </button>
            </div>

            {/* Step 2 — key */}
            <div style={{ color: '#9ca3af', fontSize: 11, fontWeight: 700, letterSpacing: 0.5, marginBottom: 6 }}>2 · MERCHANT API KEY</div>
            {imBotNewKey ? (
              <div style={{ marginBottom: 18 }}>
                <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                  <input readOnly value={imBotNewKey}
                    style={{ flex: 1, padding: '9px 11px', borderRadius: 8, border: '1px solid #10b981', background: '#0d0f16', color: '#10b981', fontFamily: 'monospace', fontSize: 12 }} />
                  <button onClick={() => copyImBot(imBotNewKey, 'key')}
                    style={{ padding: '9px 14px', borderRadius: 8, border: 'none', background: '#10b981', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                    {imBotCopied === 'key' ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <div style={{ color: '#f59e0b', fontSize: 11, lineHeight: 1.5 }}>
                  Copy it now — this is the only time it will be shown. We store only a hash of it,
                  so it cannot be shown again. If you lose it, generate a new one and revoke this.
                </div>
              </div>
            ) : (
              <button onClick={generateImBotKey} disabled={imBotBusy}
                style={{ width: '100%', padding: '10px 0', borderRadius: 8, border: 'none', background: '#3b82f6', color: '#fff', fontWeight: 700, fontSize: 13, cursor: imBotBusy ? 'not-allowed' : 'pointer', marginBottom: 18 }}>
                {imBotBusy ? 'Generating…' : 'Generate API key'}
              </button>
            )}

            {/* Step 3 — paste */}
            <div style={{ color: '#9ca3af', fontSize: 11, fontWeight: 700, letterSpacing: 0.5, marginBottom: 6 }}>3 · PASTE THEM INTO THE BOT</div>
            <div style={{ color: '#6b7280', fontSize: 12, lineHeight: 1.6, marginBottom: 18 }}>
              Open your I&amp;M Bot (<span style={{ fontFamily: 'monospace', color: '#9ca3af' }}>127.0.0.1:8010</span>) →
              <strong style={{ color: '#9ca3af' }}> Connection</strong> tab → paste both, tick
              <strong style={{ color: '#9ca3af' }}> Enable the link</strong>, then
              <strong style={{ color: '#9ca3af' }}> Test connection</strong>. It should show the account it linked to.
            </div>

            {/* Existing keys */}
            {imBotKeys.length > 0 && (
              <>
                <div style={{ color: '#9ca3af', fontSize: 11, fontWeight: 700, letterSpacing: 0.5, marginBottom: 6 }}>YOUR KEYS</div>
                <div style={{ marginBottom: 6 }}>
                  {imBotKeys.map(k => (
                    <div key={k.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 11px', border: '1px solid #2a2d3a', borderRadius: 8, marginBottom: 6, opacity: k.revoked ? 0.45 : 1 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#d1d5db' }}>{k.prefix}…</div>
                        <div style={{ fontSize: 11, color: '#6b7280' }}>
                          {k.revoked ? 'revoked' : `last used ${imBotSeen(k.last_used_at)}`}
                          {k.last_used_ip && !k.revoked ? ` · from ${k.last_used_ip}` : ''}
                        </div>
                      </div>
                      {!k.revoked && (
                        <button onClick={() => revokeImBotKey(k.id)}
                          style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid rgba(239,68,68,0.4)', background: 'transparent', color: '#ef4444', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                          Revoke
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <div style={{ color: '#6b7280', fontSize: 11, lineHeight: 1.5 }}>
                  Revoking takes effect on the bot's next poll. Generate a new key before revoking the old one
                  if a bot is currently running.
                </div>
              </>
            )}
          </div>
        </div>
      )}

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
                configuration or troubleshoot an issue — and resuming immediately once done. The bot stays paused for the time you pick below, then
                automatically resumes and re-locks all sessions. You can resume earlier anytime with <strong>Resume Bot</strong>.
              </div>
              <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 8, textAlign: 'center' }}>How long should the bot stay paused?</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                {[['3 min', 3 * 60 * 1000], ['10 min', 10 * 60 * 1000], ['30 min', 30 * 60 * 1000], ['1 hour', 60 * 60 * 1000]].map(([label, ms]) => (
                  <button
                    key={ms}
                    disabled={pauseLoading}
                    onClick={() => { setPauseDuration(ms); handleRequestPauseOtp(); }}
                    style={{ padding: '12px 0', borderRadius: 8, border: '1px solid #f59e0b', background: pauseDuration === ms ? '#f59e0b' : 'transparent', color: pauseDuration === ms ? '#000' : '#f59e0b', fontWeight: 700, cursor: pauseLoading ? 'not-allowed' : 'pointer', fontSize: 14 }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {pauseLoading && (
                <div style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center', marginBottom: 8 }}>
                  {profile?.has_totp ? 'Loading verification…' : 'Sending OTP…'}
                </div>
              )}
              <button
                onClick={() => setShowPauseModal(false)}
                style={{ width: '100%', padding: '11px 0', borderRadius: 8, border: '1px solid #374151', background: 'transparent', color: '#9ca3af', cursor: 'pointer', fontSize: 14 }}
              >
                Cancel
              </button>
            </>)}

            {pauseStep === 'otp' && (<>
              <h3 style={{ color: '#fff', marginBottom: 6 }}>Verify Identity</h3>
              <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 16 }}>
                {pauseHasTotp
                  ? 'Enter your security answer and Google Authenticator code to confirm.'
                  : 'Enter your security answer to confirm.'}
              </p>

              {pauseMsg && (
                <div style={{ padding: '8px 12px', borderRadius: 8, marginBottom: 12, fontSize: 13,
                  background: 'rgba(239,68,68,0.08)', color: '#f87171',
                  border: '1px solid rgba(239,68,68,0.3)',
                }}>
                  {pauseMsg}
                </div>
              )}

              {pauseSecQ && (
                <div style={{ marginBottom: 12 }}>
                  <label style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 4 }}>{pauseSecQ}</label>
                  <input
                    type="text" placeholder="Your answer"
                    value={pauseSecAnswer} onChange={e => setPauseSecAnswer(e.target.value)}
                    className="adm-input" style={{ width: '100%' }}
                  />
                </div>
              )}

              {pauseHasTotp && (
                <div style={{ marginBottom: 16 }}>
                  <label style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 4 }}>Google Authenticator Code</label>
                  <input
                    type="text" maxLength={6} placeholder="6-digit code from your app"
                    value={pauseTotpCode} onChange={e => setPauseTotpCode(e.target.value)}
                    className="adm-input" style={{ width: '100%' }}
                  />
                </div>
              )}

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={() => { setShowPauseModal(false); setPauseStep('warning'); setPauseOtpCode(''); setPauseSecAnswer(''); setPauseTotpCode(''); setPauseHasTotp(false); setPauseMsg(''); }}
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

      {/* Choice Bank Withdrawal Account */}
      {activeSection === 'bank' && !cbBankLoaded && (() => {
        getCbWithdrawalBank().then(r => {
          if (r.data) {
            setCbBank(r.data);
            setCbBankFirstChange(r.data.first_change !== false);
            if (r.data.cooldown_until) setCbBankCooldownUntil(r.data.cooldown_until);
          }
          setCbBankLoaded(true);
        }).catch(() => setCbBankLoaded(true));
        return null;
      })()}

      {activeSection === 'bank' && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <h3 style={{ margin: 0 }}>🏦 Choice Bank Withdrawal Account</h3>
            {cbBankCooldown && (
              <span style={{ fontSize: 10, background: 'rgba(245,158,11,0.15)', color: '#f59e0b', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>LOCKED</span>
            )}
          </div>
          <p style={{ color: '#6b7280', fontSize: 13, marginBottom: cbBankCooldown ? 12 : 18 }}>
            Set the bank account where you want to receive funds withdrawn from your Choice Microfinance sub-account via Pesalink.
          </p>

          {/* 48-hour security cooldown banner */}
          {cbBankCooldown && (
            <div style={{ marginBottom: 16, padding: 12, borderRadius: 8, background: 'rgba(245,158,11,0.1)', border: '1px solid #f59e0b', fontSize: 12, color: '#f59e0b' }}>
              <div style={{ marginBottom: 6, fontWeight: 600 }}>Security lock — next change available in:</div>
              <div style={{ fontFamily: 'monospace', fontSize: 22, fontWeight: 700, letterSpacing: 2, color: '#f59e0b', textAlign: 'center' }}>{cbBankCooldown}</div>
              <div style={{ marginTop: 4, textAlign: 'center', fontSize: 10, color: '#9ca3af' }}>hh : mm : ss</div>
            </div>
          )}

          {/* TOTP not configured warning */}
          {!cbBankCooldown && !profile?.has_totp && (
            <div style={{ marginBottom: 14, padding: 10, borderRadius: 8, background: 'rgba(239,68,68,0.1)', border: '1px solid #ef4444', fontSize: 12, color: '#ef4444' }}>
              Google Authenticator not set up. Please configure it in <strong>Profile &amp; Security</strong> before saving a bank account.
            </div>
          )}

          {/* Bank details form */}
          {!cbBankVerifyStep ? (
            <>
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 6 }}>Bank</label>
                <select
                  value={cbBank.bank_code}
                  disabled={!!cbBankCooldown}
                  onChange={e => {
                    const banks = [
                      ['01', 'Kenya Commercial Bank (KCB)'],['68', 'Equity Bank'],['11', 'Co-operative Bank'],
                      ['07', 'NCBA Bank'],['02', 'Standard Chartered'],['03', 'Absa Bank Kenya'],
                      ['31', 'Stanbic Bank'],['57', 'I&M Bank'],['63', 'Diamond Trust Bank (DTB)'],
                      ['12', 'National Bank of Kenya'],['70', 'Family Bank'],['66', 'Sidian Bank'],
                      ['35', 'African Banking Corporation (ABC)'],['10', 'Prime Bank'],['53', 'Guaranty Trust Bank'],
                    ];
                    const b = banks.find(([code]) => code === e.target.value);
                    const newCode = e.target.value;
                    setCbBank(prev => ({ ...prev, bank_code: newCode, bank_name: b ? b[1] : '' }));
                    setCbBankVerified(false);
                    if (cbBank.account && cbBank.account.length >= 4) {
                      setCbBankVerifying(true);
                      if (cbBankLookupRef.timer) clearTimeout(cbBankLookupRef.timer);
                      const timer = setTimeout(async () => {
                        try {
                          const res = await verifyBankAccount(newCode, cbBank.account);
                          const name = res.data?.account_name || '';
                          if (name) { setCbBank(prev => ({ ...prev, account_name: name.toUpperCase() })); setCbBankVerified(true); }
                          else { setCbBankMsg('Name lookup returned no result — type manually'); }
                        } catch (err) {
                          const status = err?.response?.status;
                          const msg = err?.response?.data?.detail || '';
                          if (status === 503 || msg.toLowerCase().includes('unavailable') || msg.includes('busy')) {
                            setCbBankMsg('Auto-lookup unavailable — type the account holder name below');
                          } else {
                            setCbBankMsg('Could not verify — double-check the account number, or type the name manually');
                          }
                        }
                        setCbBankVerifying(false);
                      }, 1000);
                      setCbBankLookupRef({ timer });
                    }
                  }}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #374151', background: '#111827', color: cbBank.bank_code ? '#fff' : '#6b7280', fontSize: 13, opacity: cbBankCooldown ? 0.5 : 1 }}
                >
                  <option value="">Select your bank…</option>
                  {[
                    ['01', 'Kenya Commercial Bank (KCB)'],['68', 'Equity Bank'],['11', 'Co-operative Bank'],
                    ['07', 'NCBA Bank'],['02', 'Standard Chartered'],['03', 'Absa Bank Kenya'],
                    ['31', 'Stanbic Bank'],['57', 'I&M Bank'],['63', 'Diamond Trust Bank (DTB)'],
                    ['12', 'National Bank of Kenya'],['70', 'Family Bank'],['66', 'Sidian Bank'],
                    ['35', 'African Banking Corporation (ABC)'],['10', 'Prime Bank'],['53', 'Guaranty Trust Bank'],
                  ].map(([code, name]) => <option key={code} value={code}>{name}</option>)}
                </select>
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 6 }}>Account Number</label>
                <input type="text" placeholder="e.g. 1234567890"
                  value={cbBank.account || ''}
                  disabled={!!cbBankCooldown}
                  onChange={e => {
                    const val = e.target.value;
                    setCbBank(prev => ({ ...prev, account: val }));
                    setCbBankVerified(false);
                    setCbBankMsg('');
                    if (cbBankLookupRef.timer) clearTimeout(cbBankLookupRef.timer);
                    if (cbBank.bank_code && val.length >= 4) {
                      setCbBankVerifying(true);
                      const timer = setTimeout(async () => {
                        try {
                          const res = await verifyBankAccount(cbBank.bank_code, val);
                          const name = res.data?.account_name || '';
                          if (name) { setCbBank(prev => ({ ...prev, account_name: name.toUpperCase() })); setCbBankVerified(true); }
                          else { setCbBankMsg('Name lookup returned no result — type manually'); }
                        } catch (err) {
                          const status = err?.response?.status;
                          const msg = err?.response?.data?.detail || '';
                          if (status === 503 || msg.toLowerCase().includes('unavailable') || msg.includes('busy')) {
                            setCbBankMsg('Auto-lookup unavailable — type the account holder name below');
                          } else {
                            setCbBankMsg('Could not verify — double-check the account number, or type the name manually');
                          }
                        }
                        setCbBankVerifying(false);
                      }, 1000);
                      setCbBankLookupRef({ timer });
                    }
                  }}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #374151', background: '#111827', color: '#fff', fontSize: 13, boxSizing: 'border-box', opacity: cbBankCooldown ? 0.5 : 1 }}
                />
              </div>

              <div style={{ marginBottom: 20 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#9ca3af', marginBottom: 6 }}>
                  Account Holder Name
                  {cbBankVerifying && <span style={{ fontSize: 11, color: '#6b7280' }}>Looking up…</span>}
                  {cbBankVerified && !cbBankVerifying && <span style={{ fontSize: 11, color: '#10b981', fontWeight: 600 }}>✓ Verified by bank</span>}
                </label>
                <input type="text" placeholder="Auto-filled after lookup, or type manually…"
                  value={cbBank.account_name || ''}
                  readOnly={cbBankVerified}
                  disabled={!!cbBankCooldown}
                  onChange={e => { if (!cbBankVerified) setCbBank(prev => ({ ...prev, account_name: e.target.value.toUpperCase() })); }}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: cbBankVerified ? '1px solid rgba(16,185,129,0.5)' : '1px solid #374151', background: cbBankVerified ? 'rgba(16,185,129,0.06)' : '#111827', color: '#fff', fontSize: 13, boxSizing: 'border-box', opacity: cbBankCooldown ? 0.5 : 1 }}
                />
                {cbBankVerified && (
                  <button onClick={() => { setCbBankVerified(false); setCbBank(prev => ({ ...prev, account_name: '' })); }}
                    style={{ marginTop: 4, background: 'none', border: 'none', color: '#6b7280', fontSize: 11, cursor: 'pointer', padding: 0 }}>
                    Override manually
                  </button>
                )}
              </div>

              {cbBankMsg && <p style={{ color: cbBankMsg.includes('✓') ? '#10b981' : '#ef4444', fontSize: 12, marginBottom: 10 }}>{cbBankMsg}</p>}

              <button
                disabled={!!cbBankCooldown || !cbBank.bank_code || !cbBank.account || !cbBank.account_name || !profile?.has_totp}
                onClick={() => { setCbBankMsg(''); setCbBankTotp(''); setCbBankSecAnswer(''); setCbBankVerifyStep(true); }}
                style={{ width: '100%', padding: '11px 0', borderRadius: 8, border: 'none', background: (!cbBankCooldown && cbBank.bank_code && cbBank.account && cbBank.account_name && profile?.has_totp) ? 'linear-gradient(135deg,#10b981,#059669)' : '#374151', color: '#fff', fontWeight: 700, fontSize: 14, cursor: (!cbBankCooldown && cbBank.bank_code && cbBank.account && cbBank.account_name && profile?.has_totp) ? 'pointer' : 'not-allowed' }}
              >
                Save Withdrawal Account
              </button>

              {profile?.settlement_mpesa_phone && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, padding: '10px 12px', borderRadius: 8, background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.2)' }}>
                  <span style={{ fontSize: 15 }}>📱</span>
                  <div style={{ fontSize: 12, color: '#9ca3af', lineHeight: 1.4 }}>
                    M-Pesa withdrawals are also available to <strong style={{ color: '#e5e7eb' }}>{profile.settlement_mpesa_phone}</strong> (your onboarding number).
                    Choose M-Pesa at withdrawal time — limit KES 250,000 per transaction.
                  </div>
                </div>
              )}
            </>
          ) : (
            /* ── Identity verification step ── */
            <div style={{ background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: 10, padding: 18 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#a5b4fc', marginBottom: 4 }}>Verify Your Identity</div>
              <p style={{ fontSize: 12, color: '#9ca3af', marginBottom: 16 }}>
                Enter your Google Authenticator code and security answer to confirm this change.
                {!cbBankFirstChange && ' After saving, a 48-hour security lock will prevent further changes.'}
              </p>

              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 6 }}>Google Authenticator Code</label>
                <input
                  type="text" inputMode="numeric" maxLength={6} placeholder="6-digit code"
                  value={cbBankTotp}
                  onChange={e => setCbBankTotp(e.target.value.replace(/\D/g, ''))}
                  autoFocus
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #6366f1', background: '#111827', color: '#fff', fontSize: 18, letterSpacing: 6, textAlign: 'center', boxSizing: 'border-box' }}
                />
              </div>

              <div style={{ marginBottom: 18 }}>
                <label style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 6 }}>
                  {profile?.security_question || 'Security Question'}
                </label>
                <input
                  type="text" placeholder="Your answer"
                  value={cbBankSecAnswer}
                  onChange={e => setCbBankSecAnswer(e.target.value)}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #374151', background: '#111827', color: '#fff', fontSize: 13, boxSizing: 'border-box' }}
                />
              </div>

              {cbBankMsg && <p style={{ color: cbBankMsg.includes('✓') ? '#10b981' : '#ef4444', fontSize: 12, marginBottom: 12 }}>{cbBankMsg}</p>}

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  disabled={cbBankSaving || cbBankTotp.length !== 6 || !cbBankSecAnswer.trim()}
                  onClick={async () => {
                    setCbBankSaving(true); setCbBankMsg('');
                    try {
                      const res = await saveCbWithdrawalBank({
                        ...cbBank,
                        totp_code: cbBankTotp,
                        security_answer: cbBankSecAnswer,
                      });
                      const data = res.data;
                      if (data.cooldown_until) setCbBankCooldownUntil(data.cooldown_until);
                      setCbBankFirstChange(false);
                      setCbBankVerifyStep(false);
                      setCbBankMsg(data.first_change
                        ? '✓ Bank withdrawal account saved.'
                        : '✓ Bank account updated. Next change available in 48 hours.');
                    } catch(e) {
                      setCbBankMsg(e.response?.data?.detail || 'Failed to save. Please try again.');
                    }
                    setCbBankSaving(false);
                  }}
                  style={{ flex: 1, padding: '11px 0', borderRadius: 8, border: 'none', background: (!cbBankSaving && cbBankTotp.length === 6 && cbBankSecAnswer.trim()) ? 'linear-gradient(135deg,#6366f1,#4f46e5)' : '#374151', color: '#fff', fontWeight: 700, fontSize: 13, cursor: (!cbBankSaving && cbBankTotp.length === 6 && cbBankSecAnswer.trim()) ? 'pointer' : 'not-allowed' }}
                >
                  {cbBankSaving ? 'Saving...' : 'Confirm & Save'}
                </button>
                <button
                  onClick={() => { setCbBankVerifyStep(false); setCbBankMsg(''); }}
                  style={{ padding: '11px 18px', borderRadius: 8, border: '1px solid #374151', background: 'transparent', color: '#9ca3af', cursor: 'pointer', fontSize: 13 }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Auto-withdraw (sweep to bank at a threshold) ─────────────────────── */}
      {activeSection === 'bank' && !autoWdLoaded && (() => {
        getCbAutoWithdraw().then(r => {
          if (r.data) setAutoWd({
            enabled: !!r.data.enabled,
            threshold: r.data.threshold ? String(r.data.threshold) : '',
            bank_configured: !!r.data.bank_configured,
          });
          setAutoWdLoaded(true);
        }).catch(() => setAutoWdLoaded(true));
        return null;
      })()}

      {activeSection === 'bank' && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <h3 style={{ margin: 0 }}>⚡ Auto-withdraw to bank</h3>
            {autoWd.enabled && (
              <span style={{ fontSize: 10, background: 'rgba(16,185,129,0.15)', color: '#10b981', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>ON</span>
            )}
          </div>
          <p style={{ color: '#6b7280', fontSize: 13, marginBottom: 16 }}>
            When your Choice Bank balance reaches the amount below, the <b style={{ color: '#9ca3af' }}>whole balance</b> is
            swept to your withdrawal bank account over <b style={{ color: '#9ca3af' }}>PesaLink</b> automatically — the OTP is
            confirmed for you from the SMS. M-Pesa is never used.
          </p>

          {!autoWd.bank_configured ? (
            <div style={{ padding: 12, borderRadius: 8, background: 'rgba(245,158,11,0.1)', border: '1px solid #f59e0b', fontSize: 12, color: '#f59e0b' }}>
              Save a <b>withdrawal bank account</b> above first — the sweep sends there.
            </div>
          ) : (
            <>
              <label style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 6 }}>Sweep when balance reaches (KES)</label>
              <input
                type="text" inputMode="numeric" placeholder="e.g. 500000"
                value={autoWd.threshold ? Number(autoWd.threshold).toLocaleString('en-KE') : ''}
                onChange={e => setAutoWd(s => ({ ...s, threshold: e.target.value.replace(/[^\d]/g, '') }))}
                style={{ width: '100%', padding: '11px 14px', borderRadius: 8, border: '1px solid #374151', background: '#111827', color: '#fff', fontSize: 16, fontWeight: 700, boxSizing: 'border-box', marginBottom: 10 }}
              />
              <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
                {[100000, 500000, 900000].map(v => (
                  <button key={v} onClick={() => setAutoWd(s => ({ ...s, threshold: String(v) }))}
                    style={{ padding: '6px 14px', borderRadius: 20, border: '1px solid', borderColor: String(v) === autoWd.threshold ? '#10b981' : 'var(--border)', background: String(v) === autoWd.threshold ? 'rgba(16,185,129,0.15)' : 'transparent', color: String(v) === autoWd.threshold ? '#10b981' : '#9ca3af', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                    KES {v.toLocaleString('en-KE')}
                  </button>
                ))}
              </div>

              {autoWdMsg && (
                <p style={{ color: autoWdMsg.includes('ON') || autoWdMsg.includes('off') ? '#10b981' : '#ef4444', fontSize: 12, marginBottom: 10 }}>{autoWdMsg}</p>
              )}

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  disabled={autoWdSaving || (!autoWd.enabled && (!autoWd.threshold || Number(autoWd.threshold) < 1000))}
                  onClick={async () => {
                    setAutoWdSaving(true); setAutoWdMsg('');
                    try {
                      const turnOn = !autoWd.enabled;
                      const r = await setCbAutoWithdraw(turnOn, turnOn ? Number(autoWd.threshold) : null);
                      setAutoWd(s => ({ ...s, enabled: !!r.data.enabled, threshold: r.data.threshold ? String(r.data.threshold) : s.threshold }));
                      setAutoWdMsg(r.data.message || 'Saved.');
                    } catch (e) { setAutoWdMsg(e.response?.data?.detail || 'Could not save'); }
                    setAutoWdSaving(false);
                  }}
                  style={{ flex: 1, padding: '11px 0', borderRadius: 8, border: 'none', background: autoWd.enabled ? 'linear-gradient(135deg,#ef4444,#dc2626)' : 'linear-gradient(135deg,#10b981,#059669)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}
                >
                  {autoWdSaving ? 'Saving…' : autoWd.enabled ? 'Turn OFF auto-withdraw' : 'Turn ON auto-withdraw'}
                </button>
                {autoWd.enabled && (
                  <button
                    disabled={autoWdSaving || !autoWd.threshold || Number(autoWd.threshold) < 1000}
                    onClick={async () => {
                      setAutoWdSaving(true); setAutoWdMsg('');
                      try {
                        const r = await setCbAutoWithdraw(true, Number(autoWd.threshold));
                        setAutoWdMsg(r.data.message || 'Threshold updated.');
                      } catch (e) { setAutoWdMsg(e.response?.data?.detail || 'Could not update'); }
                      setAutoWdSaving(false);
                    }}
                    style={{ padding: '11px 18px', borderRadius: 8, border: '1px solid #374151', background: 'transparent', color: '#9ca3af', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
                  >Update threshold</button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {activeSection === 'bank' && (() => {
        const already = profile?.choice_account_id;

        const toB64 = (file) => new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result.split(',')[1]);
          r.onerror = rej;
          r.readAsDataURL(file);
        });

        const handleFile = async (e, key) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const b64 = await toB64(file);
          setCbFiles(f => ({ ...f, [key]: b64 }));
        };

        const handleSubmit = async () => {
          const { firstName, lastName, mobile, idNumber, birthday, gender } = cbForm;
          if (!firstName || !lastName || !mobile || !idNumber || !birthday) {
            setCbMsg({ type: 'error', text: 'Please fill in all required fields.' }); return;
          }
          if (!cbFiles.front || !cbFiles.back || !cbFiles.selfie) {
            setCbMsg({ type: 'error', text: 'Please upload ID front, ID back, and selfie.' }); return;
          }
          setCbLoading(true); setCbMsg(null);
          try {
            const res = await choiceOnboardWallet({
              trader_id: profile.id,
              first_name: firstName,
              last_name: lastName,
              middle_name: cbForm.middleName,
              mobile: mobile.replace(/^(254|0)/, ''),
              id_number: idNumber,
              birthday,
              gender: parseInt(gender),
              email: cbForm.email,
              address: cbForm.address,
              front_photo_b64: cbFiles.front,
              back_photo_b64: cbFiles.back,
              selfie_b64: cbFiles.selfie,
            });
            setCbRequestId(res.data.onboardingRequestId);
            setCbStep('otp');
            setCbMsg({ type: 'info', text: 'An OTP has been sent to your phone. Enter it below.' });
          } catch (err) {
            setCbMsg({ type: 'error', text: err?.response?.data?.detail || 'Onboarding failed. Try again.' });
          }
          setCbLoading(false);
        };

        const handleOtp = async () => {
          if (!cbOtp.trim()) { setCbMsg({ type: 'error', text: 'Enter the OTP.' }); return; }
          setCbLoading(true); setCbMsg(null);
          try {
            await choiceConfirmOtp({ trader_id: profile.id, onboarding_request_id: cbRequestId, otp: cbOtp.trim() });
            setCbStep('polling');
            setCbMsg({ type: 'info', text: 'OTP confirmed. Waiting for KYC approval (this may take a few minutes)...' });
            let attempts = 0;
            const poll = setInterval(async () => {
              attempts++;
              try {
                const s = await choiceOnboardStatus(cbRequestId, profile.id);
                if ([3, 7, '3', '7'].includes(s.data.status)) {
                  clearInterval(poll);
                  if (typeof onUpdate === 'function') { const r = await getProfile(); onUpdate(r.data); }
                  setCbStep('done');
                  setCbMsg({ type: 'success', text: 'Your Choice Bank account is now active!' });
                  try { const b = await choiceGetBalance(profile.id); setCbBalance(b.data); } catch {}
                }
              } catch {}
              if (attempts >= 24) { clearInterval(poll); setCbMsg({ type: 'error', text: 'KYC is taking longer than expected. Check back later.' }); }
            }, 10000);
          } catch (err) {
            setCbMsg({ type: 'error', text: err?.response?.data?.detail || 'OTP confirmation failed.' });
          }
          setCbLoading(false);
        };

        const inp = (label, key, type = 'text', required = true, placeholder = '') => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: '1 1 200px' }}>
            <label style={{ color: '#9ca3af', fontSize: 12 }}>{label}{required && <span style={{ color: '#ef4444' }}> *</span>}</label>
            <input type={type} value={cbForm[key]} onChange={e => setCbForm(f => ({ ...f, [key]: e.target.value }))}
              placeholder={placeholder}
              style={{ background: '#13151f', border: '1px solid #374151', borderRadius: 8, color: '#fff', padding: '10px 12px', fontSize: 14, outline: 'none' }} />
          </div>
        );

        const fileInp = (label, key, done) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: '1 1 180px' }}>
            <label style={{ color: '#9ca3af', fontSize: 12 }}>{label} <span style={{ color: '#ef4444' }}>*</span></label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 8, border: `1px solid ${done ? '#10b981' : '#374151'}`, background: '#13151f', cursor: 'pointer', fontSize: 13, color: done ? '#10b981' : '#6b7280' }}>
              <span>{done ? '✓ Uploaded' : 'Choose file'}</span>
              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => handleFile(e, key)} />
            </label>
          </div>
        );

        return (
          <div className="settings-section">
            <h3 style={{ color: '#fff', marginBottom: 4 }}>Choice Microfinance Bank</h3>
            <p style={{ color: '#6b7280', fontSize: 13, marginBottom: 24 }}>
              Link your Choice Bank sub-account to receive M-Pesa payments from buyers and track your balance.
            </p>

            {cbMsg && (
              <div style={{ marginBottom: 20, padding: '10px 16px', borderRadius: 9, fontSize: 13,
                background: cbMsg.type === 'success' ? 'rgba(16,185,129,0.1)' : cbMsg.type === 'error' ? 'rgba(239,68,68,0.1)' : 'rgba(59,130,246,0.08)',
                color: cbMsg.type === 'success' ? '#10b981' : cbMsg.type === 'error' ? '#ef4444' : '#60a5fa',
                border: `1px solid ${cbMsg.type === 'success' ? 'rgba(16,185,129,0.25)' : cbMsg.type === 'error' ? 'rgba(239,68,68,0.25)' : 'rgba(59,130,246,0.15)'}` }}>
                {cbMsg.text}
              </div>
            )}

            {(already || cbStep === 'done') ? (
              <div style={{ background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: 14, padding: 24 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                  <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(16,185,129,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>🏦</div>
                  <div>
                    <div style={{ color: '#10b981', fontWeight: 700, fontSize: 15 }}>Choice Bank — Active</div>
                    <div style={{ color: '#6b7280', fontSize: 12 }}>Sub-account linked and receiving payments</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                  <div><div style={{ color: '#6b7280', fontSize: 11, marginBottom: 3 }}>Account Number</div>
                    <div style={{ color: '#fff', fontWeight: 700, fontSize: 16, fontFamily: 'monospace' }}>{profile?.choice_account_number || '—'}</div></div>
                  <div><div style={{ color: '#6b7280', fontSize: 11, marginBottom: 3 }}>Account ID</div>
                    <div style={{ color: '#9ca3af', fontSize: 13, fontFamily: 'monospace' }}>{profile?.choice_account_id || '—'}</div></div>
                  {cbBalance && <div><div style={{ color: '#6b7280', fontSize: 11, marginBottom: 3 }}>Live Balance</div>
                    <div style={{ color: '#10b981', fontWeight: 800, fontSize: 18 }}>KES {Number(cbBalance.balance || 0).toLocaleString()}</div></div>}
                </div>
                {!cbBalance && profile?.choice_account_id && (
                  <button onClick={async () => { try { const b = await choiceGetBalance(profile.id); setCbBalance(b.data); } catch { setCbMsg({ type: 'error', text: 'Could not fetch balance.' }); } }}
                    style={{ marginTop: 16, padding: '8px 20px', borderRadius: 8, border: '1px solid rgba(16,185,129,0.4)', background: 'transparent', color: '#10b981', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                    Check Balance
                  </button>
                )}
              </div>
            ) : cbStep === 'polling' ? (
              <div style={{ textAlign: 'center', padding: '48px 0' }}>
                <div style={{ width: 48, height: 48, border: '4px solid rgba(16,185,129,0.2)', borderTop: '4px solid #10b981', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 20px' }} />
                <div style={{ color: '#d1d5db', fontWeight: 600, marginBottom: 8 }}>KYC Review in Progress</div>
                <div style={{ color: '#6b7280', fontSize: 13 }}>Choice Bank is reviewing your documents. This usually takes 2–5 minutes.</div>
              </div>
            ) : cbStep === 'otp' ? (
              <div style={{ maxWidth: 400 }}>
                <p style={{ color: '#9ca3af', fontSize: 13, marginBottom: 20 }}>Enter the OTP sent to your registered phone number to confirm your identity.</p>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <input type="text" placeholder="6-digit OTP" value={cbOtp} onChange={e => setCbOtp(e.target.value)} maxLength={6}
                    style={{ flex: 1, background: '#13151f', border: '1px solid #374151', borderRadius: 8, color: '#fff', padding: '12px 14px', fontSize: 18, letterSpacing: 6, textAlign: 'center', outline: 'none' }} />
                  <button onClick={handleOtp} disabled={cbLoading}
                    style={{ padding: '12px 24px', borderRadius: 8, border: 'none', background: cbLoading ? '#1f2937' : '#10b981', color: cbLoading ? '#6b7280' : '#000', fontWeight: 700, fontSize: 14, cursor: cbLoading ? 'not-allowed' : 'pointer' }}>
                    {cbLoading ? 'Verifying...' : 'Confirm'}
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '48px 24px', background: '#0d1117', border: '1px solid #1f2937', borderRadius: 14 }}>
                <div style={{ fontSize: 52, marginBottom: 16 }}>&#128241;</div>
                <div style={{ color: '#fff', fontWeight: 700, fontSize: 18, marginBottom: 10 }}>Verification is done on your phone</div>
                <div style={{ color: '#9ca3af', fontSize: 14, maxWidth: 380, margin: '0 auto 28px', lineHeight: 1.7 }}>
                  Click below to open a secure verification link in your browser. Complete the steps on your phone — you'll need your National ID, KRA PIN certificate, and a selfie.
                </div>
                <button onClick={handleOpenKycBrowser} disabled={kycLinkLoading}
                  style={{ padding: '14px 36px', borderRadius: 10, border: 'none', background: kycLinkLoading ? '#1f2937' : 'linear-gradient(135deg,#10b981,#059669)', color: kycLinkLoading ? '#6b7280' : '#fff', fontWeight: 800, fontSize: 15, cursor: kycLinkLoading ? 'not-allowed' : 'pointer' }}>
                  {kycLinkLoading ? 'Opening...' : 'Open Verification Link'}
                </button>
                <div style={{ color: '#4b5563', fontSize: 12, marginTop: 16 }}>Link expires in 30 minutes</div>
              </div>
            )}
          </div>
        );
      })()}

    </div>
  );
}
