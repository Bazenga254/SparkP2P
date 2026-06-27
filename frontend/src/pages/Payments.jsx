import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
  choiceGetBalance,
  cbSendMoneyInitiate, cbSendMoneyConfirm,
  cbPaybillInitiate, cbPaybillConfirm, cbLookupShortcode,
  cbGetBanks, cbLookupBankAccount, cbLookupMpesaName,
  cbBankTransferInitiate, cbBankTransferConfirm,
  cbRtgsInitiate, cbRtgsConfirm,
  cbMpesaToBank,
} from '../services/api';

const fmtKES = (n) => 'KES ' + Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
  deposit:  <><path d="M12 3v12m0 0l-4-4m4 4l4-4" /><path d="M3 19h18" /></>,
};

const UTILITY_SERVICES = {
  kplc_tok:  { name: 'KPLC Tokens',    paybill: '888880', acctLabel: 'Meter number',    acctHint: 'e.g. 01234567890' },
  kplc_post: { name: 'KPLC Post Paid', paybill: '888882', acctLabel: 'Account number',  acctHint: 'e.g. 0123456789' },
  dstv:      { name: 'DSTV',           paybill: '444001', acctLabel: 'Customer number', acctHint: 'e.g. 1234567890' },
  gotv:      { name: 'GOtv',           paybill: '444400', acctLabel: 'Customer number', acctHint: 'e.g. 1234567890' },
  startimes: { name: 'StarTimes',      paybill: '290290', acctLabel: 'Smart card no.',  acctHint: 'e.g. 1234567890' },
  zuku:      { name: 'Zuku',           paybill: '303030', acctLabel: 'Account number',  acctHint: 'e.g. 1234567890' },
  water:     { name: 'Nairobi Water',  paybill: '444700', acctLabel: 'Account number',  acctHint: 'e.g. 1234567890' },
};

const SECTIONS = {
  mobile: [
    { title: 'Send Money', items: [
      { key: 'send',      label: 'Send to M-Pesa',     icon: 'send',     bg: '#16a34a', ready: true },
      { key: 'airtel',    label: 'Send to Airtel',     icon: 'mpesa',    bg: '#dc2626', ready: true },
    ]},
    { title: 'Buy Goods & Pay Bills', items: [
      { key: 'paybill',   label: 'M-PESA Paybill',     icon: 'paybill',  bg: '#15803d', ready: true },
      { key: 'buygoods',  label: 'M-PESA Buy Goods',   icon: 'buygoods', bg: '#15803d', ready: true },
      { key: 'airtime',   label: 'Buy Airtime',        icon: 'airtime',  bg: '#0e7490', ready: false },
    ]},
    { title: 'Utility Bills', items: [
      { key: 'kplc_tok',  label: 'KPLC Tokens',        icon: 'bulb',     bg: '#1d4ed8', ready: true },
      { key: 'kplc_post', label: 'KPLC Post Paid',     icon: 'bulb',     bg: '#1d4ed8', ready: true },
      { key: 'dstv',      label: 'DSTV',               icon: 'tv',       bg: '#0b3d91', ready: true },
      { key: 'gotv',      label: 'GOtv',               icon: 'tv',       bg: '#ea580c', ready: true },
      { key: 'startimes', label: 'StarTimes',          icon: 'tv',       bg: '#2563eb', ready: true },
      { key: 'zuku',      label: 'Zuku',               icon: 'tv',       bg: '#7c3aed', ready: true },
      { key: 'water',     label: 'Nairobi Water',      icon: 'water',    bg: '#0891b2', ready: true },
    ]},
  ],
  bank: [
    { title: 'Transfers', items: [
      { key: 'own',       label: 'To Own Account',     icon: 'person',   bg: '#f59e0b', ready: true },
      { key: 'other',     label: 'To Other Accounts',  icon: 'people',   bg: '#f59e0b', ready: true },
      { key: 'pesalink',  label: 'PesaLink',           icon: 'pesalink', bg: '#2563eb', ready: true },
      { key: 'mp2bank',   label: 'M-Pesa to Bank',     icon: 'deposit',  bg: '#16a34a', ready: true },
      { key: 'rtgs',      label: 'RTGS',               icon: 'globe',    bg: '#16a34a', ready: true },
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
  useEffect(() => { loadBalance(); }, [user?.id]);  // eslint-disable-line react-hooks/exhaustive-deps

  const onItem = (it) => {
    if (!it.ready) { setToast(`${it.label} — coming soon`); setTimeout(() => setToast(''), 2200); return; }
    setActive(it.key);
  };

  const done = () => { setActive(null); loadBalance(); };
  const cancel = () => setActive(null);

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
          <SendMoney network="mpesa" onDone={done} onCancel={cancel} />
        ) : active === 'airtel' ? (
          <SendMoney network="airtel" onDone={done} onCancel={cancel} />
        ) : active === 'paybill' ? (
          <Paybill onDone={done} onCancel={cancel} />
        ) : active === 'buygoods' ? (
          <Paybill defaultTill onDone={done} onCancel={cancel} />
        ) : UTILITY_SERVICES[active] ? (
          <UtilityBill service={active} onDone={done} onCancel={cancel} />
        ) : active === 'own' ? (
          <BankTransfer type="own" title="To Own Account" onDone={done} onCancel={cancel} />
        ) : active === 'other' ? (
          <BankTransfer type="other" title="To Other Accounts" onDone={done} onCancel={cancel} />
        ) : active === 'pesalink' ? (
          <BankTransfer type="pesalink" title="PesaLink Transfer" onDone={done} onCancel={cancel} />
        ) : active === 'mp2bank' ? (
          <MpesaToBank onDone={done} onCancel={cancel} />
        ) : active === 'rtgs' ? (
          <RTGSTransfer onDone={done} onCancel={cancel} />
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

// ── Reusable bank selector ────────────────────────────────────────────────────

function BankSelector({ value, onChange }) {
  const [banks, setBanks] = useState([]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const ref = useRef(null);

  useEffect(() => {
    cbGetBanks()
      .then((r) => setBanks(r.data || []))
      .catch(() => setBanks([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = banks.filter((b) => b.name.toLowerCase().includes(query.toLowerCase()) || b.code.includes(query));

  const select = (b) => { onChange(b); setQuery(b.name); setOpen(false); };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <input
        className="pm-inp"
        placeholder={loading ? 'Loading banks…' : 'Search bank…'}
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); onChange(null); setOpen(true); }}
      />
      {open && filtered.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
          background: '#12161d', border: '1px solid #20262f', borderRadius: 11,
          maxHeight: 220, overflowY: 'auto', marginTop: 4, boxShadow: '0 8px 32px rgba(0,0,0,.5)',
        }}>
          {filtered.map((b) => (
            <button key={b.code} type="button" onClick={() => select(b)}
              style={{ display: 'block', width: '100%', padding: '10px 14px', background: 'none',
                border: 'none', textAlign: 'left', cursor: 'pointer', color: '#e2e8f0', fontSize: 13.5,
                borderBottom: '1px solid #1a2030' }}>
              <span style={{ color: '#9aa4b2', fontSize: 11.5, marginRight: 8 }}>{b.code}</span>{b.name}
            </button>
          ))}
        </div>
      )}
      {value && (
        <div style={{ marginTop: 8, padding: '9px 12px', borderRadius: 9, background: 'rgba(16,185,129,0.10)', border: '1px solid rgba(16,185,129,0.3)' }}>
          <span style={{ color: '#9aa4b2', fontSize: 11.5 }}>Selected bank</span>
          <div style={{ color: '#10b981', fontWeight: 800, fontSize: 14 }}>✓ {value.name}</div>
        </div>
      )}
    </div>
  );
}

// ── BankTransfer (own / other / pesalink) ─────────────────────────────────────

function BankTransfer({ type, title, onDone, onCancel }) {
  const isInternal = type === 'own';
  const [step, setStep] = useState('form');
  const [bank, setBank] = useState(null);
  const [account, setAccount] = useState('');
  const [beneficiaryName, setBeneficiaryName] = useState('');
  const [amount, setAmount] = useState('');
  const [remark, setRemark] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [payee, setPayee] = useState({ status: 'idle', name: '' });

  // Confirmation-of-payee lookup
  useEffect(() => {
    const acc = account.trim();
    if (!acc || (!isInternal && !bank)) { setPayee({ status: 'idle', name: '' }); return; }
    let cancel = false;
    setPayee({ status: 'checking', name: '' });
    const t = setTimeout(async () => {
      try {
        const r = await cbLookupBankAccount(acc, bank?.code || '');
        if (!cancel) {
          setBeneficiaryName(r.data?.name || '');
          setPayee({ status: 'ok', name: r.data?.name || '' });
        }
      } catch (e) {
        if (!cancel) setPayee({ status: 'fail', name: e.response?.data?.detail || 'Could not verify account' });
      }
    }, 700);
    return () => { cancel = true; clearTimeout(t); };
  }, [account, bank, isInternal]);

  const validForm = account.trim().length > 0 && beneficiaryName.trim().length > 0
    && (isInternal || !!bank) && Number(amount) > 0;

  const initiate = async () => {
    setError(''); setBusy(true);
    try {
      const res = await cbBankTransferInitiate({
        beneficiary_account: account.trim(),
        beneficiary_name: beneficiaryName.trim(),
        bank_code: bank?.code || '',
        bank_name: bank?.name || '',
        amount: Number(amount),
        remark: remark.trim(),
      });
      setInfo(res.data?.message || 'OTP sent.');
      setStep('otp');
    } catch (e) { setError(e.response?.data?.detail || 'Could not start transfer. Try again.'); }
    finally { setBusy(false); }
  };

  const confirm = async () => {
    setError(''); setBusy(true);
    try { await cbBankTransferConfirm(otp.trim()); setStep('done'); }
    catch (e) { setError(e.response?.data?.detail || 'OTP confirmation failed.'); }
    finally { setBusy(false); }
  };

  if (step === 'done') return (
    <div className="pm-flow pm-success">
      <div style={{ fontSize: 56 }}>✅</div>
      <h2>Transfer sent</h2>
      <p>{fmtKES(amount)} transferred to {beneficiaryName}{bank ? ` (${bank.name})` : ''}.</p>
      <button className="pm-btn" onClick={onDone}>Done</button>
    </div>
  );

  return (
    <div className="pm-flow">
      <div className="pm-flow-head">
        <button className="pm-flow-back" onClick={step === 'otp' ? () => setStep('form') : onCancel}>← Back</button>
        <h2>{title}</h2>
      </div>
      {step === 'form' && (
        <>
          {!isInternal && (
            <div className="pm-field"><label>Destination bank</label>
              <BankSelector value={bank} onChange={setBank} />
            </div>
          )}
          <div className="pm-field"><label>Account number</label>
            <input className="pm-inp" placeholder={isInternal ? 'Choice Bank account number' : 'Bank account number'} value={account}
              onChange={(e) => setAccount(e.target.value.trim())} />
            {payee.status === 'checking' && <div style={{ marginTop: 6, fontSize: 12.5, color: '#9aa4b2' }}>⏳ Verifying account…</div>}
            {payee.status === 'ok' && (
              <div style={{ marginTop: 8, padding: '9px 12px', borderRadius: 9, background: 'rgba(16,185,129,0.10)', border: '1px solid rgba(16,185,129,0.3)' }}>
                <span style={{ color: '#9aa4b2', fontSize: 11.5 }}>Account holder</span>
                <div style={{ color: '#10b981', fontWeight: 800, fontSize: 14.5 }}>✓ {payee.name}</div>
              </div>
            )}
            {payee.status === 'fail' && <div style={{ marginTop: 6, fontSize: 12.5, color: '#d97706' }}>⚠️ {payee.name} — you can still enter the name manually</div>}
          </div>
          <div className="pm-field"><label>Beneficiary name</label>
            <input className="pm-inp" placeholder="Account holder name" value={beneficiaryName}
              onChange={(e) => setBeneficiaryName(e.target.value)} />
          </div>
          <div className="pm-field"><label>Amount (KES)</label>
            <input className="pm-inp" inputMode="numeric" placeholder="0" value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
            {!isInternal && <div style={{ marginTop: 5, fontSize: 12, color: '#6b7280' }}>Max KES 999,999 via PesaLink. Use RTGS for larger amounts.</div>}
          </div>
          <div className="pm-field"><label>Remark <span style={{ color: '#6b7280' }}>(optional)</span></label>
            <input className="pm-inp" placeholder="e.g. Rent payment" value={remark} onChange={(e) => setRemark(e.target.value)} />
          </div>
          {error && <div className="pm-error">{error}</div>}
          <button className="pm-btn" disabled={!validForm || busy} onClick={initiate}>{busy ? 'Starting…' : 'Continue'}</button>
        </>
      )}
      {step === 'otp' && (
        <>
          <p className="pm-otpinfo">{info}</p>
          <div className="pm-field"><label>OTP code</label>
            <input className="pm-inp" inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="Enter the code"
              value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} /></div>
          {error && <div className="pm-error">{error}</div>}
          <button className="pm-btn" disabled={!otp || busy} onClick={confirm}>{busy ? 'Confirming…' : `Transfer ${fmtKES(amount)}`}</button>
        </>
      )}
    </div>
  );
}

// ── RTGSTransfer ──────────────────────────────────────────────────────────────

function RTGSTransfer({ onDone, onCancel }) {
  const [step, setStep] = useState('form');
  const [bank, setBank] = useState(null);
  const [account, setAccount] = useState('');
  const [beneficiaryName, setBeneficiaryName] = useState('');
  const [amount, setAmount] = useState('');
  const [purpose, setPurpose] = useState('');
  const [remark, setRemark] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const validForm = !!bank && account.trim().length > 0 && beneficiaryName.trim().length > 0 && Number(amount) > 0;

  const initiate = async () => {
    setError(''); setBusy(true);
    try {
      const res = await cbRtgsInitiate({
        beneficiary_account: account.trim(),
        beneficiary_name: beneficiaryName.trim(),
        bank_code: bank?.code || '',
        bank_name: bank?.name || '',
        amount: Number(amount),
        payment_purpose: purpose.trim() || 'SparkP2P transfer',
        remark: remark.trim(),
      });
      setInfo(res.data?.message || 'OTP sent.');
      setStep('otp');
    } catch (e) { setError(e.response?.data?.detail || 'Could not start RTGS transfer. Try again.'); }
    finally { setBusy(false); }
  };

  const confirm = async () => {
    setError(''); setBusy(true);
    try { await cbRtgsConfirm(otp.trim()); setStep('done'); }
    catch (e) { setError(e.response?.data?.detail || 'OTP confirmation failed.'); }
    finally { setBusy(false); }
  };

  if (step === 'done') return (
    <div className="pm-flow pm-success">
      <div style={{ fontSize: 56 }}>✅</div>
      <h2>RTGS transfer sent</h2>
      <p>{fmtKES(amount)} to {beneficiaryName} at {bank?.name}. Real-time settlement.</p>
      <button className="pm-btn" onClick={onDone}>Done</button>
    </div>
  );

  return (
    <div className="pm-flow">
      <div className="pm-flow-head">
        <button className="pm-flow-back" onClick={step === 'otp' ? () => setStep('form') : onCancel}>← Back</button>
        <h2>RTGS Transfer</h2>
      </div>
      {step === 'form' && (
        <>
          <div style={{ padding: '10px 14px', borderRadius: 10, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', marginBottom: 18 }}>
            <div style={{ color: '#f59e0b', fontWeight: 700, fontSize: 13 }}>Real-Time Gross Settlement</div>
            <div style={{ color: '#9aa4b2', fontSize: 12.5, marginTop: 3 }}>Instant interbank transfers — no amount limit. Processed immediately during banking hours.</div>
          </div>
          <div className="pm-field"><label>Destination bank</label>
            <BankSelector value={bank} onChange={setBank} />
          </div>
          <div className="pm-field"><label>Account number</label>
            <input className="pm-inp" placeholder="Beneficiary bank account number" value={account}
              onChange={(e) => setAccount(e.target.value.trim())} />
          </div>
          <div className="pm-field"><label>Beneficiary name</label>
            <input className="pm-inp" placeholder="Full name on the account" value={beneficiaryName}
              onChange={(e) => setBeneficiaryName(e.target.value)} />
          </div>
          <div className="pm-field"><label>Amount (KES)</label>
            <input className="pm-inp" inputMode="numeric" placeholder="0" value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
          </div>
          <div className="pm-field"><label>Payment purpose <span style={{ color: '#6b7280' }}>(optional)</span></label>
            <input className="pm-inp" placeholder="e.g. Invoice payment" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
          </div>
          <div className="pm-field"><label>Message to beneficiary <span style={{ color: '#6b7280' }}>(optional)</span></label>
            <input className="pm-inp" placeholder="Note for the recipient" value={remark} onChange={(e) => setRemark(e.target.value)} />
          </div>
          {error && <div className="pm-error">{error}</div>}
          <button className="pm-btn" disabled={!validForm || busy} onClick={initiate}>{busy ? 'Starting…' : 'Continue'}</button>
        </>
      )}
      {step === 'otp' && (
        <>
          <p className="pm-otpinfo">{info}</p>
          <div className="pm-field"><label>OTP code</label>
            <input className="pm-inp" inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="Enter the code"
              value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} /></div>
          {error && <div className="pm-error">{error}</div>}
          <button className="pm-btn" disabled={!otp || busy} onClick={confirm}>{busy ? 'Confirming…' : `Send ${fmtKES(amount)} via RTGS`}</button>
        </>
      )}
    </div>
  );
}

// ── MpesaToBank ───────────────────────────────────────────────────────────────

function MpesaToBank({ onDone, onCancel }) {
  const [step, setStep] = useState('form');
  const [phone, setPhone] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const validForm = /^(0?7|0?1|7|1)\d{8}$/.test(phone.replace(/\s/g, '')) && Number(amount) > 0;

  const submit = async () => {
    setError(''); setBusy(true);
    try {
      const res = await cbMpesaToBank({ mobile: phone.trim(), amount: Math.round(Number(amount)) });
      setInfo(res.data?.message || 'STK push sent — check your phone.');
      setStep('pending');
    } catch (e) { setError(e.response?.data?.detail || 'STK push failed. Try again.'); }
    finally { setBusy(false); }
  };

  if (step === 'pending') return (
    <div className="pm-flow pm-success">
      <div style={{ fontSize: 56 }}>📱</div>
      <h2>Check your phone</h2>
      <p style={{ textAlign: 'center', lineHeight: 1.6 }}>{info}</p>
      <p style={{ color: '#6b7280', fontSize: 13, textAlign: 'center', marginTop: 8 }}>
        Your Choice Bank balance will update once M-Pesa confirms the payment.
      </p>
      <button className="pm-btn" onClick={onDone} style={{ marginTop: 24 }}>Done</button>
    </div>
  );

  return (
    <div className="pm-flow">
      <div className="pm-flow-head">
        <button className="pm-flow-back" onClick={onCancel}>← Back</button>
        <h2>M-Pesa to Bank</h2>
      </div>
      <div style={{ padding: '10px 14px', borderRadius: 10, background: 'rgba(22,163,74,0.08)', border: '1px solid rgba(22,163,74,0.25)', marginBottom: 18 }}>
        <div style={{ color: '#16a34a', fontWeight: 700, fontSize: 13 }}>Deposit from M-Pesa</div>
        <div style={{ color: '#9aa4b2', fontSize: 12.5, marginTop: 3 }}>We'll send an M-Pesa prompt to your phone. Approve it to deposit funds into your Choice Bank account.</div>
      </div>
      <div className="pm-field"><label>M-Pesa phone number</label>
        <input className="pm-inp" inputMode="tel" placeholder="07XX XXX XXX" value={phone}
          onChange={(e) => setPhone(e.target.value)} />
      </div>
      <div className="pm-field"><label>Amount (KES)</label>
        <input className="pm-inp" inputMode="numeric" placeholder="0" value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))} />
        <div style={{ marginTop: 5, fontSize: 12, color: '#6b7280' }}>Max KES 150,000 per transaction.</div>
      </div>
      {error && <div className="pm-error">{error}</div>}
      <button className="pm-btn" disabled={!validForm || busy} onClick={submit}>
        {busy ? 'Sending prompt…' : 'Deposit via M-Pesa'}
      </button>
    </div>
  );
}

// ── SendMoney (M-Pesa + Airtel, with Hakikisha name lookup for M-Pesa) ─────────

function SendMoney({ network = 'mpesa', onDone, onCancel }) {
  const isMpesa = network === 'mpesa';
  const title = isMpesa ? 'Send to M-Pesa' : 'Send to Airtel';
  const limit = isMpesa ? 250000 : 70000;

  const [step, setStep] = useState('form');
  const [phone, setPhone] = useState('');
  const [amount, setAmount] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [payee, setPayee] = useState({ status: 'idle', name: '' }); // Hakikisha

  const rawPhone = phone.replace(/\s/g, '');
  const validPhone = /^(0?7|0?1|7|1)\d{8}$/.test(rawPhone);
  const validForm = validPhone && Number(amount) > 0 && Number(amount) <= limit;

  // Hakikisha: live name lookup for M-Pesa numbers as user types
  useEffect(() => {
    if (!isMpesa || !validPhone) { setPayee({ status: 'idle', name: '' }); return; }
    let cancel = false;
    setPayee({ status: 'checking', name: '' });
    const t = setTimeout(async () => {
      try {
        const r = await cbLookupMpesaName(rawPhone);
        if (!cancel) setPayee({ status: 'ok', name: r.data?.name || '' });
      } catch {
        if (!cancel) setPayee({ status: 'fail', name: '' });
      }
    }, 700);
    return () => { cancel = true; clearTimeout(t); };
  }, [rawPhone, isMpesa, validPhone]);  // eslint-disable-line react-hooks/exhaustive-deps

  const initiate = async () => {
    setError(''); setBusy(true);
    try {
      const res = await cbSendMoneyInitiate({
        payee_phone: phone.trim(),
        amount: Number(amount),
        payee_name: payee.name || '',
        network,
      });
      setInfo(res.data?.message || 'OTP sent.');
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
      <p>{fmtKES(amount)} is on its way to {payee.name || phone}.</p>
      <button className="pm-btn" onClick={onDone}>Done</button>
    </div>
  );

  return (
    <div className="pm-flow">
      <div className="pm-flow-head">
        <button className="pm-flow-back" onClick={step === 'otp' ? () => setStep('form') : onCancel}>← Back</button>
        <h2>{title}</h2>
      </div>
      {step === 'form' && (
        <>
          <div className="pm-field">
            <label>Recipient phone ({isMpesa ? 'M-Pesa' : 'Airtel Money'})</label>
            <input className="pm-inp" inputMode="tel" placeholder="07XX XXX XXX" value={phone}
              onChange={(e) => setPhone(e.target.value)} />
            {/* Hakikisha name lookup */}
            {isMpesa && payee.status === 'checking' && (
              <div style={{ marginTop: 6, fontSize: 12.5, color: '#9aa4b2' }}>⏳ Verifying name…</div>
            )}
            {isMpesa && payee.status === 'ok' && payee.name && (
              <div style={{ marginTop: 8, padding: '9px 12px', borderRadius: 9, background: 'rgba(16,185,129,0.10)', border: '1px solid rgba(16,185,129,0.3)' }}>
                <span style={{ color: '#9aa4b2', fontSize: 11.5 }}>Sending to (Hakikisha)</span>
                <div style={{ color: '#10b981', fontWeight: 800, fontSize: 14.5 }}>✓ {payee.name}</div>
              </div>
            )}
            {isMpesa && payee.status === 'fail' && (
              <div style={{ marginTop: 6, fontSize: 12.5, color: '#d97706' }}>⚠️ Could not verify name — check the number is correct</div>
            )}
          </div>
          <div className="pm-field"><label>Amount (KES)</label>
            <input className="pm-inp" inputMode="numeric" placeholder="0" value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
            <div style={{ marginTop: 5, fontSize: 12, color: '#6b7280' }}>Max {fmtKES(limit)} per transaction.</div>
          </div>
          {error && <div className="pm-error">{error}</div>}
          <button className="pm-btn" disabled={!validForm || busy} onClick={initiate}>{busy ? 'Starting…' : 'Continue'}</button>
        </>
      )}
      {step === 'otp' && (
        <>
          <p className="pm-otpinfo">{info}</p>
          <div className="pm-field"><label>OTP code</label>
            <input className="pm-inp" inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="Enter the code"
              value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} /></div>
          {error && <div className="pm-error">{error}</div>}
          <button className="pm-btn" disabled={!otp || busy} onClick={confirm}>{busy ? 'Confirming…' : `Send ${fmtKES(amount)}`}</button>
        </>
      )}
    </div>
  );
}

// ── Paybill ───────────────────────────────────────────────────────────────────

function Paybill({ onDone, onCancel, defaultTill = false }) {
  const [step, setStep] = useState('form');
  const [isPaybill, setIsPaybill] = useState(!defaultTill);
  const [biz, setBiz] = useState('');
  const [acct, setAcct] = useState('');
  const [amount, setAmount] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [payee, setPayee] = useState({ status: 'idle', name: '' });

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
            {payee.status === 'checking' && <div style={{ marginTop: 6, fontSize: 12.5, color: '#9aa4b2' }}>⏳ Verifying name…</div>}
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

// ── UtilityBill (KPLC, DSTV, GOtv, StarTimes, Zuku, Nairobi Water) ───────────

function UtilityBill({ service, onDone, onCancel }) {
  const cfg = UTILITY_SERVICES[service];
  const [step, setStep] = useState('form');
  const [acct, setAcct] = useState('');
  const [amount, setAmount] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const validForm = acct.trim().length > 0 && Number(amount) > 0;

  const initiate = async () => {
    setError(''); setBusy(true);
    try {
      const res = await cbPaybillInitiate({
        business_number: cfg.paybill,
        amount: Number(amount),
        account_number: acct.trim(),
        is_paybill: true,
      });
      setInfo(res.data?.message || 'OTP sent to your registered phone.');
      setStep('otp');
    } catch (e) { setError(e.response?.data?.detail || 'Could not start payment. Try again.'); }
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
      <p>{fmtKES(amount)} paid to {cfg.name} ({cfg.acctLabel.toLowerCase()}: {acct}).</p>
      <button className="pm-btn" onClick={onDone}>Done</button>
    </div>
  );

  return (
    <div className="pm-flow">
      <div className="pm-flow-head">
        <button className="pm-flow-back" onClick={step === 'otp' ? () => setStep('form') : onCancel}>← Back</button>
        <h2>{cfg.name}</h2>
      </div>
      {step === 'form' && (
        <>
          <div style={{ padding: '9px 13px', borderRadius: 9, background: '#12161d', border: '1px solid #20262f', marginBottom: 16 }}>
            <span style={{ color: '#6b7280', fontSize: 12 }}>Paybill </span>
            <span style={{ color: '#e2e8f0', fontWeight: 700 }}>{cfg.paybill}</span>
          </div>
          <div className="pm-field"><label>{cfg.acctLabel}</label>
            <input className="pm-inp" inputMode="numeric" placeholder={cfg.acctHint} value={acct}
              onChange={(e) => setAcct(e.target.value.trim())} />
          </div>
          <div className="pm-field"><label>Amount (KES)</label>
            <input className="pm-inp" inputMode="numeric" placeholder="0" value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
          </div>
          {error && <div className="pm-error">{error}</div>}
          <button className="pm-btn" disabled={!validForm || busy} onClick={initiate}>{busy ? 'Starting…' : 'Continue'}</button>
        </>
      )}
      {step === 'otp' && (
        <>
          <p className="pm-otpinfo">{info}</p>
          <div className="pm-field"><label>OTP code</label>
            <input className="pm-inp" inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="Enter the code"
              value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} /></div>
          {error && <div className="pm-error">{error}</div>}
          <button className="pm-btn" disabled={!otp || busy} onClick={confirm}>{busy ? 'Confirming…' : `Pay ${fmtKES(amount)}`}</button>
        </>
      )}
    </div>
  );
}
