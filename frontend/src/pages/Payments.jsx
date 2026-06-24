import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { choiceGetBalance, cbSendMoneyInitiate, cbSendMoneyConfirm, cbPaybillInitiate, cbPaybillConfirm, cbLookupShortcode } from '../services/api';

const fmtKES = (n) => 'KES ' + Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── White line icons (sit inside the round coloured chips) ──────────────────
const ICON = {
  mpesa:    <><rect x="7" y="3" width="10" height="18" rx="2" /><path d="M11 18h2" /></>,
  airtime:  <><path d="M12 19a7 7 0 0 0 0-14" opacity=".5" /><path d="M12 15a3 3 0 0 0 0-6" /><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" /></>,
  paybill:  <><rect x="4" y="6" width="16" height="13" rx="1.5" /><path d="M8 6V4h8v2M8 11h8M8 15h5" /></>,
  buygoods: <><path d="M4 8h16l-1 4H5z" /><path d="M5 12v7h14v-7" /><path d="M9 4v4M15 4v4" /></>,
  bulb:     <><path d="M12 3a6 6 0 0 0-3 11v2h6v-2a6 6 0 0 0-3-11z" /><path d="M10 21h4" /></>,
  tv:       <><rect x="3" y="5" width="18" height="12" rx="1.5" /><path d="M8 21h8M12 17v4" /></>,
  water:    <path d="M12 3s6 6.5 6 10a6 6 0 0 1-12 0c0-3.5 6-10 6-10z" />,
  person:   <><circle cx="12" cy="8" r="4" /><path d="M5 20a7 7 0 0 1 14 0" /></>,
  people:   <><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><path d="M16 6.2a3.2 3.2 0 0 1 0 6M20.5 19a5.5 5.5 0 0 0-4-5.3" /></>,
  pesalink: <path d="M8 4v12m0 0l-3-3m3 3l3-3M16 20V8m0 0l-3 3m3-3l3 3" />,
  globe:    <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>,
  send:     <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />,
};

// Brand-recognisable chip colours; the THEME (header/tabs/buttons) is SparkP2P amber.
const SECTIONS = {
  mobile: [
    { title: 'Send Money', items: [
      { key: 'send',      label: 'Send to M-Pesa',     icon: 'send',     bg: '#16a34a', ready: true },
      { key: 'airtel',    label: 'Send to Airtel',     icon: 'mpesa',    bg: '#dc2626', ready: false },
    ]},
    { title: 'Buy Goods & Pay Bills', items: [
      { key: 'paybill',   label: 'M-PESA Paybill',     icon: 'paybill',  bg: '#15803d', ready: true },
      { key: 'buygoods',  label: 'M-PESA Buy Goods',   icon: 'buygoods', bg: '#15803d', ready: false },
      { key: 'airtime',   label: 'Buy Airtime',        icon: 'airtime',  bg: '#0e7490', ready: false },
    ]},
    { title: 'Utility Bills', items: [
      { key: 'kplc_tok',  label: 'KPLC Tokens',        icon: 'bulb',     bg: '#1d4ed8', ready: false },
      { key: 'kplc_post', label: 'KPLC Post Paid',     icon: 'bulb',     bg: '#1d4ed8', ready: false },
      { key: 'dstv',      label: 'DSTV',               icon: 'tv',       bg: '#0b3d91', ready: false },
      { key: 'gotv',      label: 'GOtv',               icon: 'tv',       bg: '#ea580c', ready: false },
      { key: 'startimes', label: 'StarTimes',          icon: 'tv',       bg: '#2563eb', ready: false },
      { key: 'zuku',      label: 'Zuku',               icon: 'tv',       bg: '#7c3aed', ready: false },
      { key: 'water',     label: 'Nairobi Water',      icon: 'water',    bg: '#0891b2', ready: false },
    ]},
  ],
  bank: [
    { title: 'Transfers', items: [
      { key: 'own',       label: 'To Own Account',     icon: 'person',   bg: '#f59e0b', ready: false },
      { key: 'other',     label: 'To Other Accounts',  icon: 'people',   bg: '#f59e0b', ready: false },
      { key: 'pesalink',  label: 'PesaLink',           icon: 'pesalink', bg: '#2563eb', ready: false },
      { key: 'mp2bank',   label: 'M-Pesa to Bank',     icon: 'mpesa',    bg: '#16a34a', ready: false },
      { key: 'rtgs',      label: 'RTGS',               icon: 'globe',    bg: '#16a34a', ready: false },
    ]},
    { title: 'International', items: [
      { key: 'swift',     label: 'SWIFT',              icon: 'globe',    bg: '#2563eb', ready: false },
    ]},
  ],
};

export default function Payments() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [balance, setBalance] = useState(null);
  const [tab, setTab] = useState('mobile');
  const [active, setActive] = useState(null);
  const [toast, setToast] = useState('');

  const loadBalance = () => {
    if (!user?.id) return;
    choiceGetBalance(user.id)
      .then((r) => { const d = r.data || {}; setBalance(d.balance ?? d.available ?? d.kes ?? d.availableBalance ?? null); })
      .catch(() => {});
  };
  useEffect(() => { loadBalance(); }, [user?.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  const onItem = (it) => {
    if (!it.ready) { setToast(`${it.label} — coming soon`); setTimeout(() => setToast(''), 2200); return; }
    setActive(it.key);
  };

  return (
    <div className="pm">
      <div className="pm-head">
        <button className="pm-back" onClick={() => (active ? setActive(null) : navigate(-1))} aria-label="Back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
        <div className="pm-logo">
          <svg viewBox="0 0 24 24" fill="none" stroke="#10131a" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1" /><path d="M3 7v10a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H6" /><circle cx="16" cy="13" r="1.4" fill="#10131a" stroke="none" /></svg>
        </div>
        <h1>Payments</h1>
        <div className="pm-bal">{balance == null ? 'KES ••••••' : fmtKES(balance)}<span>Choice Bank balance</span></div>
      </div>

      <div className="pm-sheet">
        {active === 'send' ? (
          <SendMoney onDone={() => { setActive(null); loadBalance(); }} onCancel={() => setActive(null)} />
        ) : active === 'paybill' ? (
          <Paybill onDone={() => { setActive(null); loadBalance(); }} onCancel={() => setActive(null)} />
        ) : (
          <>
            <div className="pm-tabs">
              {[['mobile', 'Mobile'], ['bank', 'Bank']].map(([k, lbl]) => (
                <button key={k} className={`pm-tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{lbl}</button>
              ))}
            </div>
            {SECTIONS[tab].map((sec) => (
              <div className="pm-section" key={sec.title}>
                <div className="pm-section-title">{sec.title}</div>
                <div className="pm-cards">
                  {sec.items.map((it) => (
                    <button key={it.key} className="pm-card" onClick={() => onItem(it)}>
                      <span className="pm-chip" style={{ background: it.bg }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{ICON[it.icon]}</svg>
                      </span>
                      <span className="pm-card-lbl">{it.label}</span>
                      {!it.ready && <span className="pm-soon">Soon</span>}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {toast && <div className="pm-toast">{toast}</div>}
    </div>
  );
}

function SendMoney({ onDone, onCancel }) {
  const [step, setStep] = useState('form');
  const [phone, setPhone] = useState('');
  const [amount, setAmount] = useState('');
  const [name, setName] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const validForm = /^(0?7|0?1|7|1)\d{8}$/.test(phone.replace(/\s/g, '')) && Number(amount) > 0;

  const initiate = async () => {
    setError(''); setBusy(true);
    try {
      const res = await cbSendMoneyInitiate({ payee_phone: phone.trim(), amount: Number(amount), payee_name: name.trim() });
      setInfo(res.data?.message || 'OTP sent to your registered phone.');
      setStep('otp');
    } catch (e) { setError(e.response?.data?.detail || 'Could not start the transfer. Please try again.'); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    setError(''); setBusy(true);
    try { await cbSendMoneyConfirm(otp.trim()); setStep('done'); }
    catch (e) { setError(e.response?.data?.detail || 'OTP confirmation failed.'); }
    finally { setBusy(false); }
  };

  if (step === 'done') return (
    <div className="pm-flow pm-success">
      <div style={{ fontSize: 56 }}>✅</div>
      <h2>Money sent</h2>
      <p>{fmtKES(amount)} is on its way to {name || ('0' + phone.replace(/^0/, ''))}.</p>
      <button className="pm-btn" onClick={onDone}>Done</button>
    </div>
  );

  return (
    <div className="pm-flow">
      <div className="pm-flow-head">
        <button className="pm-flow-back" onClick={step === 'otp' ? () => setStep('form') : onCancel}>← Back</button>
        <h2>Send to M-Pesa</h2>
      </div>
      {step === 'form' && (
        <>
          <div className="pm-field"><label>Recipient phone (M-Pesa)</label>
            <input className="pm-inp" inputMode="tel" placeholder="07XX XXX XXX" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
          <div className="pm-field"><label>Amount (KES)</label>
            <input className="pm-inp" inputMode="numeric" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} /></div>
          <div className="pm-field"><label>Recipient name <span style={{ color: '#6b7280' }}>(optional)</span></label>
            <input className="pm-inp" placeholder="e.g. John Doe" value={name} onChange={(e) => setName(e.target.value)} /></div>
          {error && <div className="pm-error">{error}</div>}
          <button className="pm-btn" disabled={!validForm || busy} onClick={initiate}>{busy ? 'Starting…' : 'Continue'}</button>
        </>
      )}
      {step === 'otp' && (
        <>
          <p className="pm-otpinfo">{info}</p>
          <div className="pm-field"><label>OTP code</label>
            <input className="pm-inp" inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="Enter the code" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} /></div>
          {error && <div className="pm-error">{error}</div>}
          <button className="pm-btn" disabled={!otp || busy} onClick={confirm}>{busy ? 'Confirming…' : `Send ${fmtKES(amount)}`}</button>
        </>
      )}
    </div>
  );
}

function Paybill({ onDone, onCancel }) {
  const [step, setStep] = useState('form');
  const [isPaybill, setIsPaybill] = useState(true);
  const [biz, setBiz] = useState('');
  const [acct, setAcct] = useState('');
  const [amount, setAmount] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [payee, setPayee] = useState({ status: 'idle', name: '' }); // idle|checking|ok|fail

  // Confirmation-of-payee: look up the Paybill/Till business name as the user types (debounced).
  useEffect(() => {
    const code = biz.trim();
    if (!/^\d{5,7}$/.test(code)) { setPayee({ status: 'idle', name: '' }); return; }
    let cancel = false;
    setPayee({ status: 'checking', name: '' });
    const t = setTimeout(async () => {
      try {
        const r = await cbLookupShortcode(code);
        if (!cancel) setPayee({ status: 'ok', name: r.data?.name || '' });
      } catch (e) {
        if (!cancel) setPayee({ status: 'fail', name: e.response?.data?.detail || 'Could not verify this number' });
      }
    }, 600);
    return () => { cancel = true; clearTimeout(t); };
  }, [biz]);

  // Paybill must be name-verified before sending (reliable lookup); Till shows the name if found
  // but isn't blocked on it.
  const validForm = /^\d{5,7}$/.test(biz.trim()) && (!isPaybill || acct.trim().length > 0)
    && Number(amount) > 0 && (!isPaybill || payee.status === 'ok');

  const initiate = async () => {
    setError(''); setBusy(true);
    try {
      const res = await cbPaybillInitiate({ business_number: biz.trim(), amount: Number(amount), account_number: acct.trim(), is_paybill: isPaybill });
      setInfo(res.data?.message || 'OTP sent to your registered phone.');
      setStep('otp');
    } catch (e) { setError(e.response?.data?.detail || 'Could not start the payment. Please try again.'); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    setError(''); setBusy(true);
    try { await cbPaybillConfirm(otp.trim()); setStep('done'); }
    catch (e) { setError(e.response?.data?.detail || 'OTP confirmation failed.'); }
    finally { setBusy(false); }
  };

  if (step === 'done') return (
    <div className="pm-flow pm-success">
      <div style={{ fontSize: 56 }}>✅</div>
      <h2>Payment sent</h2>
      <p>{fmtKES(amount)} paid to {isPaybill ? `Paybill ${biz} (acc ${acct})` : `Till ${biz}`}.</p>
      <button className="pm-btn" onClick={onDone}>Done</button>
    </div>
  );

  return (
    <div className="pm-flow">
      <div className="pm-flow-head">
        <button className="pm-flow-back" onClick={step === 'otp' ? () => setStep('form') : onCancel}>← Back</button>
        <h2>Pay Paybill / Till</h2>
      </div>
      {step === 'form' && (
        <>
          <div className="pm-field">
            <label>Payment type</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {[[true, 'Paybill'], [false, 'Till / Buy Goods']].map(([v, l]) => (
                <button key={l} type="button" onClick={() => setIsPaybill(v)}
                  style={{ flex: 1, height: 46, borderRadius: 11, cursor: 'pointer', fontWeight: 700, fontSize: 13.5,
                    border: isPaybill === v ? '1px solid #f59e0b' : '1px solid #20262f',
                    background: isPaybill === v ? 'rgba(245,158,11,.12)' : '#0a0d12',
                    color: isPaybill === v ? '#f59e0b' : '#9aa4b2' }}>{l}</button>
              ))}
            </div>
          </div>
          <div className="pm-field"><label>{isPaybill ? 'Paybill number' : 'Till / Buy Goods number'}</label>
            <input className="pm-inp" inputMode="numeric" placeholder="e.g. 247247" value={biz} onChange={(e) => setBiz(e.target.value.replace(/\D/g, ''))} />
            {/* Confirmation of payee — verify the registered name before paying */}
            {payee.status === 'checking' && (
              <div style={{ marginTop: 6, fontSize: 12.5, color: '#9aa4b2' }}>⏳ Verifying name…</div>
            )}
            {payee.status === 'ok' && (
              <div style={{ marginTop: 8, padding: '9px 12px', borderRadius: 9, background: 'rgba(16,185,129,0.10)', border: '1px solid rgba(16,185,129,0.3)' }}>
                <span style={{ color: '#9aa4b2', fontSize: 11.5 }}>Paying to</span>
                <div style={{ color: '#10b981', fontWeight: 800, fontSize: 14.5 }}>✓ {payee.name}</div>
              </div>
            )}
            {payee.status === 'fail' && (
              <div style={{ marginTop: 6, fontSize: 12.5, color: isPaybill ? '#ef4444' : '#d97706' }}>
                ⚠️ {payee.name}{!isPaybill && ' — you can still proceed for Till payments.'}
              </div>
            )}
          </div>
          {isPaybill && (
            <div className="pm-field"><label>Account number</label>
              <input className="pm-inp" placeholder="e.g. your account / phone" value={acct} onChange={(e) => setAcct(e.target.value)} /></div>
          )}
          <div className="pm-field"><label>Amount (KES)</label>
            <input className="pm-inp" inputMode="numeric" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} /></div>
          {error && <div className="pm-error">{error}</div>}
          <button className="pm-btn" disabled={!validForm || busy} onClick={initiate}>{busy ? 'Starting…' : 'Continue'}</button>
        </>
      )}
      {step === 'otp' && (
        <>
          <p className="pm-otpinfo">{info}</p>
          <div className="pm-field"><label>OTP code</label>
            <input className="pm-inp" inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="Enter the code" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} /></div>
          {error && <div className="pm-error">{error}</div>}
          <button className="pm-btn" disabled={!otp || busy} onClick={confirm}>{busy ? 'Confirming…' : `Pay ${fmtKES(amount)}`}</button>
        </>
      )}
    </div>
  );
}
