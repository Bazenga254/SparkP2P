import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { register, sendVerificationCode } from '../services/api';
import OtpInput from './OtpInput';
import TermsModal from './TermsModal';
import { startGoogleLogin } from '../mobile/oauth';

const PASSWORD_RULES = [
  { label: '8+ characters', test: (p) => p.length >= 8 },
  { label: '2 uppercase', test: (p) => (p.match(/[A-Z]/g) || []).length >= 2 },
  { label: '2 lowercase', test: (p) => (p.match(/[a-z]/g) || []).length >= 2 },
  { label: '2 numbers', test: (p) => (p.match(/[0-9]/g) || []).length >= 2 },
  { label: '2 special chars', test: (p) => (p.match(/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/g) || []).length >= 2 },
];

const SECURITY_QUESTIONS = [
  "What was the name of your first pet?",
  "What is your mother's maiden name?",
  "What city were you born in?",
  "What is the name of your primary school?",
  "What was your childhood nickname?",
];

const STEPS = [
  { title: 'Your name', sub: 'This is what buyers see during payment verification.' },
  { title: 'How we reach you', sub: 'We’ll use these for OTPs, alerts and M-Pesa.' },
  { title: 'Verify your email', sub: 'Enter the 6-digit code we sent to your inbox.' },
  { title: 'Secure your account', sub: 'Pick a strong password you don’t use anywhere else.' },
  { title: 'Almost done', sub: 'One recovery question, then you’re in.' },
];

// store as 0XXXXXXXXX (Safaricom local format the backend already accepts)
const normalizePhone = (local) => '0' + (local || '').replace(/\D/g, '').replace(/^0+/, '');
const phoneValid = (local) => /^(07|01)\d{8}$/.test(normalizePhone(local));
const emailValid = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '');

export default function RegisterWizard({ referralCode = '', referralName = '', onSignIn }) {
  const { loginUser } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    full_name: '', phoneLocal: '', email: '', email_code: '',
    password: '', confirm_password: '',
    security_question: '', security_answer: '', referral: referralCode,
  });
  const [showPassword, setShowPassword] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const last = STEPS.length - 1;

  const sendCode = async () => {
    if (!emailValid(form.email)) { setError('Enter a valid email first'); return false; }
    setSendingCode(true); setError('');
    try {
      await sendVerificationCode(form.email);
      setCodeSent(true);
      return true;
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to send code');
      return false;
    } finally {
      setSendingCode(false);
    }
  };

  // can the user advance from the current step?
  const canAdvance = () => {
    switch (step) {
      case 0: return form.full_name.trim().length >= 2;
      case 1: return phoneValid(form.phoneLocal) && emailValid(form.email);
      case 2: return form.email_code.length === 6;
      case 3: return PASSWORD_RULES.every((r) => r.test(form.password)) && form.password === form.confirm_password;
      case 4: return !!form.security_question && form.security_answer.trim().length > 0 && agreedToTerms;
      default: return false;
    }
  };

  const next = async () => {
    setError('');
    if (!canAdvance()) return;
    if (step === 1 && !codeSent) {
      const ok = await sendCode();
      if (!ok) return;
    }
    if (step === last) { return submit(); }
    setStep((s) => Math.min(last, s + 1));
  };

  const back = () => {
    setError('');
    if (step === 0) { onSignIn ? onSignIn() : navigate('/'); return; }
    setStep((s) => Math.max(0, s - 1));
  };

  const submit = async () => {
    setLoading(true); setError('');
    try {
      const res = await register({
        full_name: form.full_name.toUpperCase(),
        email: form.email,
        phone: normalizePhone(form.phoneLocal),
        password: form.password,
        email_code: form.email_code,
        security_question: form.security_question,
        security_answer: form.security_answer,
        ...(form.referral ? { referral_code: form.referral } : {}),
      });
      const role = res.data.role || 'trader';
      loginUser(res.data.access_token, { id: res.data.trader_id, full_name: res.data.full_name, role });
      navigate(role === 'employee' ? '/employee' : '/dashboard');
    } catch (err) {
      const detail = err.response?.data?.detail;
      setError(Array.isArray(detail) ? detail.map((d) => d.msg).join('. ') : (typeof detail === 'string' ? detail : detail?.message || 'Something went wrong'));
      // jump back to the step that owns the failing field where helpful
      if (typeof detail === 'string' && /code/i.test(detail)) setStep(2);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rw">
      <div className="rw-phone">
        {/* header */}
        <div className="rw-top">
          <button className="rw-back" onClick={back} aria-label="Back">
            <svg viewBox="0 0 24 24" fill="none" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <h1>Let&rsquo;s get started</h1>
          <div className="rw-brand"><img src="/spark-icon.svg" alt="" /><span>SparkP2P</span></div>
        </div>

        {/* progress */}
        <div className="rw-steplabel">Step {step + 1} of {STEPS.length}</div>
        <div className="rw-bars">
          {STEPS.map((_, i) => (
            <i key={i} className={i < step ? 'done' : i === step ? 'on' : ''} />
          ))}
        </div>

        <h2 className="rw-title">{STEPS[step].title}</h2>
        <p className="rw-sub">{STEPS[step].sub}</p>

        {referralCode && step === 0 && (
          <div className="rw-hint" style={{ borderLeftColor: '#f59e0b' }}>
            🎁 {referralName ? <>You were invited by <b>{referralName}</b></> : 'You’re signing up via a referral link'} — your referrer earns a commission when you trade.
          </div>
        )}

        {/* STEP 1 — name */}
        {step === 0 && (
          <>
            <div className="rw-hint">Enter your full name <b>exactly as it appears on your Binance KYC</b>. It&rsquo;s shown to buyers when you verify their P2P payment.</div>
            <div className="rw-field">
              <label>Full Name (as on Binance KYC)</label>
              <input className="rw-inp" style={{ textTransform: 'uppercase' }} placeholder="JOE ANTONY WANDABWA"
                value={form.full_name} onChange={(e) => set('full_name', e.target.value.toUpperCase())} autoFocus />
            </div>
          </>
        )}

        {/* STEP 2 — contact */}
        {step === 1 && (
          <>
            <div className="rw-hint">We&rsquo;ll send a one-time code to confirm your email. Use your <b>M-Pesa registered number</b>.</div>
            <div className="rw-field">
              <label>Phone Number</label>
              <div className="rw-row">
                <div className="rw-cc">🇰🇪 +254</div>
                <input className="rw-inp" inputMode="tel" placeholder="712345678"
                  value={form.phoneLocal} onChange={(e) => set('phoneLocal', e.target.value.replace(/\D/g, '').slice(0, 10))} />
              </div>
              <div className="rw-fieldhint">M-Pesa registered number</div>
            </div>
            <div className="rw-field">
              <label>Email Address</label>
              <div className="rw-withbtn">
                <input className="rw-inp" type="email" placeholder="you@example.com"
                  value={form.email} onChange={(e) => { set('email', e.target.value); setCodeSent(false); }} />
                <button type="button" className="rw-ibtn" disabled={sendingCode || !emailValid(form.email)} onClick={sendCode}>
                  {sendingCode ? '…' : codeSent ? 'Resent' : 'Verify'}
                </button>
              </div>
              {codeSent && <div className="rw-fieldhint" style={{ color: '#34d399' }}>Code sent — you&rsquo;ll enter it next.</div>}
            </div>
          </>
        )}

        {/* STEP 3 — otp */}
        {step === 2 && (
          <>
            <div className="rw-hint">Didn&rsquo;t get it? Check spam, or tap <b>Resend</b> below. The code expires in 10 minutes.</div>
            <OtpInput value={form.email_code} onChange={(v) => set('email_code', v)} length={6} />
            <p className="rw-resend">
              Didn&rsquo;t receive it?{' '}
              <b onClick={sendingCode ? undefined : sendCode} style={{ opacity: sendingCode ? 0.5 : 1 }}>
                {sendingCode ? 'Sending…' : 'Resend code'}
              </b>
            </p>
          </>
        )}

        {/* STEP 4 — password */}
        {step === 3 && (
          <>
            <div className="rw-field">
              <label>Password</label>
              <div className="rw-withbtn">
                <input className="rw-inp" type={showPassword ? 'text' : 'password'} placeholder="Create a strong password"
                  value={form.password} onChange={(e) => set('password', e.target.value)} autoFocus />
                <button type="button" className="rw-ibtn" onClick={() => setShowPassword((s) => !s)}>{showPassword ? 'Hide' : 'Show'}</button>
              </div>
            </div>
            <div className="rw-rules">
              {PASSWORD_RULES.map((r, i) => {
                const ok = r.test(form.password);
                return <div key={i} className={`rw-rule ${ok ? 'ok' : ''}`}><b>{ok ? '✓' : '✗'}</b> {r.label}</div>;
              })}
            </div>
            <div className="rw-field" style={{ marginTop: 14 }}>
              <label>Confirm Password</label>
              <input className="rw-inp" type="password" placeholder="Re-enter your password"
                value={form.confirm_password} onChange={(e) => set('confirm_password', e.target.value)} />
              {form.confirm_password && form.password !== form.confirm_password && (
                <div className="rw-fieldhint" style={{ color: '#f87171' }}>Passwords do not match</div>
              )}
            </div>
          </>
        )}

        {/* STEP 5 — security + terms */}
        {step === 4 && (
          <>
            <div className="rw-field">
              <label>Security Question</label>
              <select className="rw-inp rw-select" value={form.security_question} onChange={(e) => set('security_question', e.target.value)}>
                <option value="">Select a question…</option>
                {SECURITY_QUESTIONS.map((q) => <option key={q} value={q}>{q}</option>)}
              </select>
              <div className="rw-fieldhint" style={{ color: '#f87171' }}>Can&rsquo;t be changed later — choose carefully.</div>
            </div>
            <div className="rw-field">
              <label>Security Answer</label>
              <input className="rw-inp" placeholder="Your answer (case-insensitive)"
                value={form.security_answer} onChange={(e) => set('security_answer', e.target.value)} />
              <div className="rw-fieldhint">You&rsquo;ll need this to change your payment method.</div>
            </div>
            <div className="rw-field">
              <label>Referral Code <span style={{ color: '#6b7480', fontWeight: 500 }}>(optional)</span></label>
              <input className="rw-inp" placeholder="Enter referral code if you have one"
                value={form.referral} onChange={(e) => set('referral', e.target.value)} />
            </div>
            <label className="rw-check">
              <input type="checkbox" checked={agreedToTerms} onChange={(e) => setAgreedToTerms(e.target.checked)} />
              <span>I have read and agree to the{' '}
                <a onClick={(e) => { e.preventDefault(); setShowTerms(true); }}>Terms &amp; Conditions</a>
                {' '}and accept the risks of automated P2P trading.</span>
            </label>
          </>
        )}

        {error && <div className="rw-error">{error}</div>}

        <div className="rw-grow" />

        <button className="rw-cta" disabled={!canAdvance() || loading || sendingCode} onClick={next}>
          {loading ? 'Creating…' : step === last ? 'Create Account' : 'Continue'}
        </button>

        {step === 0 && (
          <>
            <div className="rw-or">or</div>
            <button type="button" className="rw-google" onClick={() => startGoogleLogin()}>
              <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" /><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" /><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" /><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" /></svg>
              Sign up with Google
            </button>
            <p className="rw-alt">Already have an account? <b onClick={() => (onSignIn ? onSignIn() : navigate('/login'))}>Sign in</b></p>
          </>
        )}
      </div>

      <TermsModal open={showTerms} onClose={() => setShowTerms(false)} onAgree={() => { setAgreedToTerms(true); setShowTerms(false); }} />
    </div>
  );
}
