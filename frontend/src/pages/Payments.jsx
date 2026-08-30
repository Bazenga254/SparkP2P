import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import StandingOrders from '../components/StandingOrders';
import SmeOnboardWizard from '../components/SmeOnboardWizard';
import {
  choiceListAccounts, choiceSwitchAccount,
  choiceGetBalance,
  cbSendMoneyQuote, cbSendMoneyInitiate, cbSendMoneyConfirm, cbSendMoneyConfirmSms, cbSendMoneyResendEmail,
  cbEmailVerifyStatus, cbEmailVerifyStart, cbEmailVerifyConfirm,
  cbPaybillInitiate, cbPaybillConfirm, cbLookupShortcode,
  cbGetBanks, cbLookupBankAccount, cbLookupMpesaName,
  cbBankTransferInitiate, cbBankTransferConfirm, cbBankTransferConfirmSms,
  cbRtgsInitiate, cbRtgsConfirm, cbRtgsConfirmSms,
  cbMpesaToBank, cbResendOtp,
} from '../services/api';

const fmtKES = (n) => 'KES ' + Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── OTP resend timer — shows countdown then "Resend OTP" link ─────────────────
function OtpResend({ flow }) {
  const [secs, setSecs] = useState(60);
  const [status, setStatus] = useState('idle'); // idle | sending | sent | error
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (secs <= 0) return;
    const t = setTimeout(() => setSecs(s => s - 1), 1000);
    return () => clearTimeout(t);
  }, [secs]);

  const resend = async () => {
    setStatus('sending'); setMsg('');
    try {
      const r = await cbResendOtp(flow);
      setMsg(r.data?.message || 'New OTP sent.');
      setStatus('sent');
      setSecs(60);
    } catch (e) {
      setMsg(e.response?.data?.detail || 'Could not resend. Please try again.');
      setStatus('error');
    }
  };

  if (secs > 0) return (
    <div style={{ marginTop: 10, fontSize: 12.5, color: '#6b7280', textAlign: 'center' }}>
      Resend OTP in <span style={{ color: '#9aa4b2', fontWeight: 600 }}>{secs}s</span>
    </div>
  );

  return (
    <div style={{ marginTop: 10, textAlign: 'center' }}>
      {status === 'sending' && <span style={{ fontSize: 12.5, color: '#9aa4b2' }}>Resending…</span>}
      {status === 'sent'    && <span style={{ fontSize: 12.5, color: '#10b981' }}>✓ {msg}</span>}
      {status === 'error'   && <span style={{ fontSize: 12.5, color: '#ef4444' }}>{msg}</span>}
      {status !== 'sending' && (
        <button onClick={resend} style={{ background: 'none', border: 'none', color: '#f59e0b', fontSize: 13, cursor: 'pointer', textDecoration: 'underline', padding: 0, marginTop: status === 'error' ? 6 : 0 }}>
          {status === 'sent' ? 'Resend again' : "Didn't get the OTP? Resend"}
        </button>
      )}
    </div>
  );
}

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
  const [active, setActive] = useState('send');   // rail layout opens on Send to M-Pesa
  const [toast, setToast] = useState('');
  const [accounts, setAccounts] = useState([]);   // multiple Choice accounts
  const [acctMenu, setAcctMenu] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [mobileDetail, setMobileDetail] = useState(false);  // mobile only: hub (list) vs detail (form)

  const loadBalance = () => {
    if (!user?.id) return;
    choiceGetBalance(user.id)
      .then((r) => { const d = r.data || {}; setBalance(d.balance ?? d.available ?? d.kes ?? d.availableBalance ?? null); })
      .catch(() => {});
  };
  const loadAccounts = () => {
    choiceListAccounts().then((r) => setAccounts(r.data?.accounts || [])).catch(() => {});
  };
  useEffect(() => { loadBalance(); loadAccounts(); }, [user?.id]);  // eslint-disable-line react-hooks/exhaustive-deps

  const switchTo = async (row) => {
    setAcctMenu(false);
    if (row.is_active) return;
    try {
      await choiceSwitchAccount(row.id);
      setBalance(null);
      loadAccounts();
      loadBalance();
      setToast(`Switched to ${row.label || row.account_number}`);
      setTimeout(() => setToast(''), 2200);
    } catch (e) {
      setToast(e.response?.data?.detail || 'Could not switch account');
      setTimeout(() => setToast(''), 2600);
    }
  };
  const activeAcct = accounts.find((a) => a.is_active);

  const onItem = (it) => {
    if (!it.ready) { setToast(`${it.label} — coming soon`); setTimeout(() => setToast(''), 2200); return; }
    setActive(it.key);
    setMobileDetail(true);   // on mobile, open the form full-screen
    setAcctMenu(false);
  };

  const done = () => { loadBalance(); };
  const cancel = () => { setActive('send'); setMobileDetail(false); };

  // ── Rail-based layout (SparkP2P Payments redesign) ──────────────────────────
  const C = { ink:'#0D1620', ink2:'#131F2B', ink3:'#1A2836', ink4:'#22323F', line:'#22333F', lineSoft:'#1B2A36', paper:'#E9F2F8', muted:'#93AABA', dim:'#64798A', spark:'#F8A81C', sparkSoft:'#FBD07A', ok:'#3FD07A' };
  const RAIL = [
    { group: 'Mobile money', items: [
      { key:'send', label:'Send to M-Pesa', icon:'send', ready:true },
      { key:'airtel', label:'Send to Airtel', icon:'mpesa', ready:true },
      { key:'paybill', label:'M-PESA Paybill', icon:'paybill', ready:true },
      { key:'buygoods', label:'M-PESA Buy Goods', icon:'buygoods', ready:true },
      { key:'airtime', label:'Buy Airtime', icon:'airtime', ready:false },
    ]},
    { group: 'Utility bills', items: [
      { key:'kplc_tok', label:'KPLC Tokens', icon:'bulb', ready:true },
      { key:'kplc_post', label:'KPLC Post Paid', icon:'bulb', ready:true },
      { key:'dstv', label:'DSTV', icon:'tv', ready:true },
      { key:'gotv', label:'GOtv', icon:'tv', ready:true },
      { key:'startimes', label:'StarTimes', icon:'tv', ready:true },
      { key:'zuku', label:'Zuku', icon:'tv', ready:true },
      { key:'water', label:'Nairobi Water', icon:'water', ready:true },
    ]},
    { group: 'Bank', items: [
      { key:'own', label:'To own account', icon:'person', ready:true },
      { key:'other', label:'To other accounts', icon:'people', ready:true },
      { key:'pesalink', label:'PesaLink', icon:'pesalink', ready:true },
      { key:'mp2bank', label:'M-Pesa to bank', icon:'deposit', ready:true },
      { key:'rtgs', label:'RTGS', icon:'globe', ready:true },
    ]},
    { group: 'Automation', items: [
      { key:'standing', label:'Standing orders', icon:'globe', ready:true },
    ]},
  ];
  const allItems = RAIL.flatMap((g) => g.items);
  const crumb = (allItems.find((i) => i.key === active) || {}).label || (UTILITY_SERVICES[active] ? 'Utility bill' : '');
  const flow =
    active === 'send' ? <SendMoney network="mpesa" balance={balance} onDone={done} onCancel={cancel} />
    : active === 'airtel' ? <SendMoney network="airtel" balance={balance} onDone={done} onCancel={cancel} />
    : active === 'paybill' ? <Paybill balance={balance} onDone={done} onCancel={cancel} />
    : active === 'buygoods' ? <Paybill defaultTill balance={balance} onDone={done} onCancel={cancel} />
    : UTILITY_SERVICES[active] ? <UtilityBill service={active} onDone={done} onCancel={cancel} />
    : active === 'own' ? <BankTransfer type="own" title="To Own Account" balance={balance} onDone={done} onCancel={cancel} />
    : active === 'other' ? <BankTransfer type="other" title="To Other Accounts" balance={balance} onDone={done} onCancel={cancel} />
    : active === 'pesalink' ? <BankTransfer type="pesalink" title="PesaLink Transfer" balance={balance} onDone={done} onCancel={cancel} />
    : active === 'mp2bank' ? <MpesaToBank balance={balance} onDone={done} onCancel={cancel} />
    : active === 'rtgs' ? <RTGSTransfer balance={balance} onDone={done} onCancel={cancel} />
    : active === 'standing' ? <StandingOrders onCancel={cancel} />
    : <div style={{ color:C.muted, padding:'40px 0' }}>Select a payment from the left.</div>;

  const glClass = (group) => group === 'Utility bills' ? 'b' : group === 'Bank' ? 'g' : group === 'Automation' ? 'p' : '';

  return (
    <div className={'pmx-app' + (mobileDetail ? ' pmx-inDetail' : '')}>
      <style>{PMX_CSS}</style>

      {/* ── sticky top: title + account switcher ── */}
      <header className="pmx-top">
        <div className="pmx-toprow">
          <button className="pmx-back" aria-label="Back"
            onClick={() => { if (mobileDetail) setMobileDetail(false); else navigate(-1); }}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <div className="pmx-mid">
            <div className="pmx-title">{mobileDetail ? (crumb || 'Payment') : 'Payments'}</div>
            <div className="pmx-sub">Choice Bank</div>
          </div>
          <button className="pmx-acct" onClick={() => setAcctMenu((v) => !v)}>
            <i className="dot" />
            <span className="nm">{activeAcct ? (activeAcct.label || activeAcct.account_number) : 'Primary'}</span>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
          </button>
        </div>
        {/* balance bar */}
        <div className="pmx-balbar">
          <div className="pmx-balwrap">
            <div className="pmx-ballab">Choice Bank balance</div>
            <div className="pmx-balval"><small>KES</small> {balance == null ? '••••••' : Number(balance).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          </div>
          <div className="pmx-balbtns">
            <button className="pmx-refresh" aria-label="Refresh balance" onClick={loadBalance}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5" /></svg>
            </button>
            <button className="pmx-topup" onClick={() => { setToast('Deposit to your Choice Bank Paybill to add funds.'); setTimeout(() => setToast(''), 2600); }}>Top up</button>
          </div>
        </div>
      </header>

      {/* account switch menu */}
      {acctMenu && (
        <>
          <div className="pmx-scrim" onClick={() => setAcctMenu(false)} />
          <div className="pmx-acctmenu">
            <div className="pmx-amlab">Your Choice accounts</div>
            {accounts.length === 0 && <div className="pmx-amempty">No accounts linked yet.</div>}
            {accounts.map((a) => (
              <button key={a.id} className={'pmx-amitem' + (a.is_active ? ' on' : '')} onClick={() => switchTo(a)} disabled={a.is_active}>
                <span className="dot" style={{ background: a.is_active ? '#3ECF8E' : '#22323F' }} />
                <span className="tx">
                  <b>{a.label || 'Account'}</b>
                  <span>{a.account_number} · {a.account_type === 'sme' ? 'SME' : 'Personal'}</span>
                </span>
                {a.is_active && <span className="act">Active</span>}
              </button>
            ))}
            <button className="pmx-amadd" onClick={() => { setAcctMenu(false); setShowWizard(true); }}>
              <span className="pl">+</span> Add SME account
            </button>
          </div>
        </>
      )}

      {/* ── body: hub list (mobile) / sidebar (desktop) + detail ── */}
      <div className="pmx-body">
        <aside className="pmx-side">
          {RAIL.map((g) => (
            <div className="pmx-group" key={g.group}>
              <div className="pmx-grouplab">{g.group}</div>
              <div className="pmx-list">
                {g.items.map((it) => (
                  <button key={it.key}
                    className={'pmx-item' + (active === it.key ? ' active' : '') + (it.ready ? '' : ' soon')}
                    onClick={() => onItem(it)}>
                    <span className={'gl ' + glClass(g.group)}>
                      <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{ICON[it.icon]}</svg>
                    </span>
                    <span className="tx"><b>{it.label}</b></span>
                    {it.ready ? <span className="ch" aria-hidden="true">›</span> : <span className="pmx-soon">SOON</span>}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="pmx-sidefoot">Payments run on your linked Choice Bank account. Codes are sent to your registered phone.</div>
        </aside>

        <main className="pmx-main">
          <div className="pmx-mainwrap">
            {flow}
            {(active === 'send' || active === 'pesalink' || active === 'other') && <EmailOtpBackup />}
          </div>
        </main>
      </div>

      {toast && <div className="pm-toast">{toast}</div>}
      {showWizard && (
        <SmeOnboardWizard
          onClose={() => { setShowWizard(false); loadAccounts(); }}
          onDone={() => { loadAccounts(); loadBalance(); }}
        />
      )}
    </div>
  );
}

// Mobile-first shell styling for the Payments page. Mobile: hub (method list) and
// detail (the selected form) are swapped full-screen via the .pmx-inDetail class.
// Desktop (≥900px): sidebar list + content shown side-by-side, .pmx-inDetail is a no-op.
const PMX_CSS = `
.pmx-app{min-height:100vh;background:#0A0D13;color:#E9EDF4;display:flex;flex-direction:column;
  font-family:'IBM Plex Sans',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;-webkit-tap-highlight-color:transparent}
.pmx-app *{box-sizing:border-box}
.pmx-top{position:sticky;top:0;z-index:40;background:rgba(10,13,19,.94);backdrop-filter:blur(12px);
  -webkit-backdrop-filter:blur(12px);border-bottom:1px solid #212938}
.pmx-toprow{display:flex;align-items:center;gap:10px;height:58px;padding:0 12px}
.pmx-back{width:40px;height:40px;flex:0 0 auto;border:0;background:transparent;color:#E9EDF4;border-radius:12px;
  cursor:pointer;display:none;align-items:center;justify-content:center}
.pmx-back:active{background:#171E2B}
.pmx-app.pmx-inDetail .pmx-back{display:flex}
.pmx-mid{flex:1 1 auto;min-width:0}
.pmx-title{font-weight:800;font-size:17px;letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pmx-sub{font-size:12px;color:#8B94A7;margin-top:1px}
.pmx-acct{flex:0 0 auto;display:inline-flex;align-items:center;gap:8px;height:38px;max-width:190px;padding:0 13px;
  border-radius:999px;border:1px solid #232B3A;background:#121722;color:#E9EDF4;font-size:13px;cursor:pointer}
.pmx-acct .dot{width:7px;height:7px;flex:0 0 auto;border-radius:50%;background:#3ECF8E;display:block}
.pmx-acct .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pmx-balbar{display:flex;align-items:center;gap:12px;padding:11px 16px;
  background:linear-gradient(90deg,rgba(255,165,31,.10),rgba(255,165,31,.02));border-top:1px solid #171E2B}
.pmx-balwrap{min-width:0}
.pmx-ballab{font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:10.5px;letter-spacing:.14em;
  text-transform:uppercase;color:#FFA51F}
.pmx-balval{font-family:'IBM Plex Mono',ui-monospace,monospace;font-weight:600;font-size:22px;letter-spacing:-.02em;
  line-height:1.15;color:#fff;margin-top:2px}
.pmx-balval small{font-size:12px;color:#8B94A7;font-weight:400;margin-right:2px}
.pmx-balbtns{margin-left:auto;display:flex;align-items:center;gap:8px;flex:0 0 auto}
.pmx-refresh{width:40px;height:40px;border-radius:11px;border:1px solid #232B3A;background:#121722;color:#8B94A7;
  cursor:pointer;display:flex;align-items:center;justify-content:center}
.pmx-refresh:active{background:#171E2B}
.pmx-topup{height:40px;padding:0 18px;border-radius:11px;border:0;background:#FFA51F;color:#160F00;font-size:14px;
  font-weight:700;cursor:pointer}
.pmx-topup:active{filter:brightness(.94)}

.pmx-scrim{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:55}
.pmx-acctmenu{position:absolute;top:64px;right:12px;width:320px;max-width:calc(100vw - 24px);background:#121722;
  border:1px solid #232B3A;border-radius:14px;box-shadow:0 22px 54px rgba(0,0,0,.55);z-index:60;overflow:hidden;
  animation:pmxpop .12s ease}
@keyframes pmxpop{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
.pmx-amlab{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;
  color:#8B94A7;padding:13px 16px 7px}
.pmx-amempty{padding:4px 16px 14px;color:#8B94A7;font-size:13px}
.pmx-amitem{display:flex;align-items:center;gap:11px;width:100%;text-align:left;padding:11px 16px;border:0;
  background:transparent;cursor:pointer;color:#E9EDF4}
.pmx-amitem.on{cursor:default}
.pmx-amitem:not(.on):active{background:#171E2B}
.pmx-amitem .dot{width:8px;height:8px;flex:0 0 auto;border-radius:50%;display:block}
.pmx-amitem .tx{flex:1 1 auto;min-width:0}
.pmx-amitem .tx b{display:block;font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pmx-amitem .tx span{display:block;font-size:12px;color:#8B94A7;margin-top:1px}
.pmx-amitem .act{font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:.08em;text-transform:uppercase;
  font-weight:700;color:#3ECF8E;flex:0 0 auto}
.pmx-amadd{display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:13px 16px;
  border:0;border-top:1px solid #232B3A;background:transparent;color:#FFA51F;font-size:14px;font-weight:700;cursor:pointer}
.pmx-amadd .pl{font-size:18px;line-height:1}

.pmx-body{display:flex;flex:1 1 auto;min-height:0}
.pmx-side{width:100%;padding:8px 14px 40px;overflow-y:auto}
.pmx-main{display:none;flex:1 1 auto;min-width:0;overflow-y:auto;padding:16px 14px 72px}
.pmx-app.pmx-inDetail .pmx-side{display:none}
.pmx-app.pmx-inDetail .pmx-main{display:block}
.pmx-mainwrap{max-width:1120px;margin:0 auto}
.pmx-grouplab{font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;
  color:#8B94A7;margin:20px 4px 10px}
.pmx-group:first-child .pmx-grouplab{margin-top:12px}
.pmx-list{background:#121722;border:1px solid #232B3A;border-radius:16px;overflow:hidden}
.pmx-item{display:flex;align-items:center;gap:14px;width:100%;min-height:60px;padding:11px 15px;background:transparent;
  border:0;border-bottom:1px solid #1B2230;text-align:left;cursor:pointer;color:#E9EDF4}
.pmx-item:last-child{border-bottom:0}
.pmx-item:not(.soon):active{background:#171E2B}
.pmx-item .gl{width:40px;height:40px;flex:0 0 auto;border-radius:12px;display:flex;align-items:center;
  justify-content:center;background:rgba(255,165,31,.13);color:#FFA51F}
.pmx-item .gl.b{background:rgba(91,141,239,.14);color:#5B8DEF}
.pmx-item .gl.g{background:rgba(62,207,142,.14);color:#3ECF8E}
.pmx-item .gl.p{background:rgba(168,127,239,.14);color:#A87FEF}
.pmx-item .tx{flex:1 1 auto;min-width:0}
.pmx-item .tx b{display:block;font-weight:600;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pmx-item .ch{color:#5B6577;font-size:20px;flex:0 0 auto;line-height:1}
.pmx-item.soon{opacity:.5}
.pmx-soon{font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:.08em;padding:4px 8px;border-radius:7px;
  background:#171E2B;color:#8B94A7;flex:0 0 auto}
.pmx-sidefoot{color:#5B6577;font-size:12px;line-height:1.5;margin:22px 6px 0}

@media (min-width:900px){
  .pmx-back{display:none !important}
  .pmx-app.pmx-inDetail .pmx-back{display:none !important}
  .pmx-title{font-size:18px}
  .pmx-balbar{padding:11px 26px}
  .pmx-toprow{padding:0 20px}
  .pmx-body{display:grid;grid-template-columns:300px 1fr;align-items:start}
  .pmx-side{border-right:1px solid #171E2B;padding:10px 16px 40px;position:sticky;top:114px;
    max-height:calc(100vh - 114px);align-self:start}
  .pmx-main,.pmx-app.pmx-inDetail .pmx-main{display:block}
  .pmx-app.pmx-inDetail .pmx-side{display:block}
  .pmx-main{padding:26px 30px 60px}
  .pmx-list{background:transparent;border:0;border-radius:0}
  .pmx-item{min-height:44px;padding:8px 11px;border-bottom:0;border-radius:10px;gap:11px}
  .pmx-item.active{background:#171E2B}
  .pmx-item .gl{width:32px;height:32px;border-radius:9px}
  .pmx-item .tx b{font-size:14px}
  .pmx-item .ch{display:none}
  .pmx-grouplab{margin:16px 6px 6px}
  .pmx-group:first-child .pmx-grouplab{margin-top:4px}
}
`;

// ── Email-OTP backup: verify the account email so email codes can be used ─────
// SMS OTPs sometimes don't arrive; once the email is verified, transfers offer a
// "get the code by email" fallback. Merchant-triggered, one-time.
function EmailOtpBackup() {
  const [status, setStatus] = useState(null);   // {verified, email, need_id_number}
  const [step, setStep] = useState('idle');     // idle | id | otp | done
  const [idNumber, setIdNumber] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');

  useEffect(() => {
    cbEmailVerifyStatus().then((r) => setStatus(r.data || {})).catch(() => setStatus(null));
  }, []);

  if (!status || status.verified) {
    if (status?.verified) return (
      <div className="pm-section">
        <div className="pm-eo pm-eo-ok">
          <span className="pm-eo-ic">✅</span>
          <div><b>Email OTP backup is on</b><span>If an SMS code doesn't arrive, get it by email instead.</span></div>
        </div>
      </div>
    );
    return null;  // status not loaded yet
  }

  const begin = () => {
    setErr(''); setInfo('');
    setStep(status.need_id_number ? 'id' : 'sending');
    if (!status.need_id_number) sendCode('');
  };

  const sendCode = async (idn) => {
    setErr(''); setInfo(''); setBusy(true);
    try {
      const r = await cbEmailVerifyStart(idn);
      setInfo(r.data?.message || 'We sent a code to your email. Enter it below.');
      setStep('otp');
    } catch (e) {
      setErr(e.response?.data?.detail || 'Could not start email verification.');
      setStep(status.need_id_number ? 'id' : 'idle');
    } finally { setBusy(false); }
  };

  const confirm = async () => {
    setErr(''); setInfo(''); setBusy(true);
    try {
      const r = await cbEmailVerifyConfirm(otp.trim());
      setInfo(r.data?.message || 'Email verified.');
      setStep('done');
      setStatus((s) => ({ ...(s || {}), verified: true }));
    } catch (e) {
      setErr(e.response?.data?.detail || 'Invalid or expired code.');
    } finally { setBusy(false); }
  };

  return (
    <div className="pm-section">
      <div className="pm-eo">
        <span className="pm-eo-ic">📧</span>
        <div className="pm-eo-body">
          <b>Set up email OTP backup</b>
          <span>SMS codes sometimes don't arrive. Verify your email once so you can get transfer codes by email.</span>

          {err && <div className="pm-eo-err">{err}</div>}
          {info && <div className="pm-eo-info">{info}</div>}

          {step === 'idle' && (
            <button className="pm-eo-btn" onClick={begin} disabled={busy}>Enable email backup</button>
          )}

          {step === 'id' && (
            <div className="pm-eo-row">
              <input className="pm-inp" placeholder="National ID number" value={idNumber}
                     inputMode="numeric" onChange={(e) => setIdNumber(e.target.value.replace(/\D/g, ''))} />
              <button className="pm-eo-btn" onClick={() => sendCode(idNumber)} disabled={busy || !idNumber}>
                {busy ? 'Sending…' : 'Send code'}
              </button>
            </div>
          )}

          {step === 'sending' && <div className="pm-eo-info">Sending code…</div>}

          {step === 'otp' && (
            <div className="pm-eo-row">
              <input className="pm-inp" placeholder="Email code" value={otp}
                     inputMode="numeric" onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} />
              <button className="pm-eo-btn" onClick={confirm} disabled={busy || !otp}>
                {busy ? 'Verifying…' : 'Verify'}
              </button>
            </div>
          )}
        </div>
      </div>
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

function BankTransfer({ type, title, onDone, onCancel, balance = null }) {
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
      setStep('waiting');
      try {
        await cbBankTransferConfirmSms();
        setStep('done');
      } catch (e2) {
        setInfo('OTP not auto-captured — enter the code from your phone manually.');
        setStep('otp');
      }
    } catch (e) { setError(e.response?.data?.detail || 'Could not start transfer. Try again.'); }
    finally { setBusy(false); }
  };

  const confirm = async () => {
    setError(''); setBusy(true);
    try { await cbBankTransferConfirm(otp.trim()); setStep('done'); }
    catch (e) { setError(e.response?.data?.detail || 'OTP confirmation failed.'); }
    finally { setBusy(false); }
  };

  const amtNum = Number(amount) || 0;
  const n2 = (v) => Number(v || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const afterBal = balance != null ? balance - amtNum : null;
  const short = afterBal != null && afterBal < 0;

  if (step === 'done') return (
    <div className="pm-flow pm-success">
      <div style={{ fontSize: 56 }}>✅</div>
      <h2>Transfer sent</h2>
      <p>{fmtKES(amount)} transferred to {beneficiaryName}{bank ? ` (${bank.name})` : ''}.</p>
      <button className="pm-btn" onClick={onDone}>Done</button>
    </div>
  );

  if (step === 'form') return (
    <div>
      <div className="px-vh"><h2>{title}</h2><p>{isInternal ? 'Move money between the accounts you hold at Choice Bank.' : 'Send to any Kenyan bank account in seconds. The name is checked before the money moves.'}</p></div>
      <div className="px-cols">
        <div>
          <div className="px-card">
            <div className="px-card-head"><h3>Transfer details</h3>{!isInternal && <span className="r">Max KES 999,999 per transfer</span>}</div>
            <div className="px-card-body">
              {!isInternal && (
                <div className="px-field"><label>Beneficiary bank</label><BankSelector value={bank} onChange={setBank} /></div>
              )}
              <div className="px-field">
                <label>Account number</label>
                <input className="px-in" placeholder={isInternal ? 'Choice Bank account number' : 'Bank account number'} value={account} onChange={(e) => setAccount(e.target.value.trim())} />
                {payee.status === 'checking' && <span className="hint">Verifying account…</span>}
                {payee.status === 'ok' && (
                  <div className="px-verified"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#3FD07A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5 9.5 17 19 7" /></svg> Account belongs to <b>{payee.name}</b></div>
                )}
                {payee.status === 'fail' && <span className="hint" style={{ color: '#E4C58A' }}>{payee.name} — you can still enter the name manually.</span>}
                {!isInternal && <span className="hint">Always check the name before you send — a bank transfer can't be reversed.</span>}
              </div>
              <div className="px-field"><label>Beneficiary name</label>
                <input className="px-in" placeholder="Account holder name" value={beneficiaryName} onChange={(e) => setBeneficiaryName(e.target.value)} /></div>
              <div className="px-field"><label>Amount</label>
                <div className="px-amt"><span className="cur">KES</span><input className="px-in amount" inputMode="numeric" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} /></div>
              </div>
              <div className="px-field"><label>Reference <span className="opt">Optional</span></label>
                <input className="px-in" placeholder="Shows on the recipient's statement" value={remark} onChange={(e) => setRemark(e.target.value)} /></div>
            </div>
          </div>
        </div>

        <aside className="px-review">
          <div className="px-review-head"><h3>Before you send</h3></div>
          <div className="px-review-body">
            <dl>
              <div className="px-rrow"><dt>Method</dt><dd>{isInternal ? 'Choice transfer' : (type === 'pesalink' ? 'PesaLink' : title)}</dd></div>
              {!isInternal && <div className="px-rrow"><dt>Bank</dt><dd className={bank ? '' : 'empty'}>{bank ? bank.name : 'Select a bank'}</dd></div>}
              <div className="px-rrow"><dt>Account</dt><dd className={account ? '' : 'empty'}>{account || 'Add a number'}</dd></div>
              <div className="px-rrow"><dt>Name</dt><dd className={beneficiaryName ? '' : 'empty'}>{beneficiaryName || '—'}</dd></div>
              <div className="px-rrow big"><dt>Amount</dt><dd className={amtNum === 0 ? 'empty' : ''}><span className="u">KES</span>{n2(amtNum)}</dd></div>
              <div className="px-rrow"><dt>Arrives</dt><dd>{isInternal ? 'Instantly' : 'In seconds'}</dd></div>
              <div className="px-rrow after"><dt>Balance after</dt><dd className={short ? 'short' : ''}>{afterBal == null ? '—' : short ? ('Short by KES ' + n2(Math.abs(afterBal))) : ('KES ' + n2(afterBal))}</dd></div>
            </dl>
          </div>
          <div className="px-review-foot">
            {short && <div className="px-note bad"><span>Not enough in your balance to send this amount.</span></div>}
            {error && <div className="px-note bad"><span>{error}</span></div>}
            <button className="px-btn spark block" disabled={!validForm || busy || short} onClick={initiate}>{busy ? 'Starting…' : 'Continue'}</button>
            <span className="px-sms"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4.5" y="10" width="15" height="10.5" rx="2.2" /><path d="M8 10V7.5a4 4 0 0 1 8 0V10" /></svg> You'll confirm with a code sent by SMS.</span>
          </div>
        </aside>
      </div>
    </div>
  );

  return (
    <div className="pm-flow">
      <div className="pm-flow-head">
        <button className="pm-flow-back" onClick={step === 'otp' ? () => setStep('form') : onCancel}>← Back</button>
        <h2>{title}</h2>
      </div>
      {step === 'waiting' && (
        <div style={{ textAlign: 'center', padding: '32px 0' }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>📲</div>
          <div style={{ color: '#f5a623', fontWeight: 700, fontSize: 16, marginBottom: 8 }}>Waiting for OTP…</div>
          <div style={{ color: '#9aa4b2', fontSize: 13 }}>Choice Bank sent an OTP to your phone.<br />It will be captured automatically.</div>
        </div>
      )}
      {step === 'otp' && (
        <>
          <p className="pm-otpinfo">{info}</p>
          <div className="pm-field"><label>OTP code</label>
            <input className="pm-inp" inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="Enter the code"
              value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} /></div>
          {error && <div className="pm-error">{error}</div>}
          <button className="pm-btn" disabled={!otp || busy} onClick={confirm}>{busy ? 'Confirming…' : `Transfer ${fmtKES(amount)}`}</button>
          <OtpResend flow="bank_transfer" />
        </>
      )}
    </div>
  );
}

// ── RTGSTransfer ──────────────────────────────────────────────────────────────

function RTGSTransfer({ onDone, onCancel, balance = null }) {
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
      setStep('waiting');
      try {
        await cbRtgsConfirmSms();
        setStep('done');
      } catch (e2) {
        setInfo('OTP not auto-captured — enter the code from your phone manually.');
        setStep('otp');
      }
    } catch (e) { setError(e.response?.data?.detail || 'Could not start RTGS transfer. Try again.'); }
    finally { setBusy(false); }
  };

  const confirm = async () => {
    setError(''); setBusy(true);
    try { await cbRtgsConfirm(otp.trim()); setStep('done'); }
    catch (e) { setError(e.response?.data?.detail || 'OTP confirmation failed.'); }
    finally { setBusy(false); }
  };

  const amtNum = Number(amount) || 0;
  const n2 = (v) => Number(v || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const afterBal = balance != null ? balance - amtNum : null;
  const short = afterBal != null && afterBal < 0;

  if (step === 'done') return (
    <div className="pm-flow pm-success">
      <div style={{ fontSize: 56 }}>✅</div>
      <h2>RTGS transfer sent</h2>
      <p>{fmtKES(amount)} to {beneficiaryName} at {bank?.name}. Real-time settlement.</p>
      <button className="pm-btn" onClick={onDone}>Done</button>
    </div>
  );

  if (step === 'form') return (
    <div>
      <div className="px-vh"><h2>RTGS</h2><p>For large transfers. Real-time interbank settlement with no upper limit, processed during bank working hours.</p></div>
      <div className="px-cols">
        <div>
          <div className="px-card">
            <div className="px-card-head"><h3>Transfer details</h3><span className="r">No amount limit</span></div>
            <div className="px-card-body">
              <div className="px-note warn" style={{ marginBottom: 18 }}>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5M12 7.6v.6" /></svg>
                <span><b>Real-Time Gross Settlement.</b> Best for large amounts. Processed immediately during banking hours only.</span>
              </div>
              <div className="px-field"><label>Beneficiary bank</label><BankSelector value={bank} onChange={setBank} /></div>
              <div className="px-field"><label>Account number</label>
                <input className="px-in" placeholder="Beneficiary bank account number" value={account} onChange={(e) => setAccount(e.target.value.trim())} /></div>
              <div className="px-field"><label>Beneficiary name</label>
                <input className="px-in" placeholder="Full name on the account" value={beneficiaryName} onChange={(e) => setBeneficiaryName(e.target.value)} /></div>
              <div className="px-field"><label>Amount</label>
                <div className="px-amt"><span className="cur">KES</span><input className="px-in amount" inputMode="numeric" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} /></div>
              </div>
              <div className="px-row2">
                <div className="px-field"><label>Payment purpose <span className="opt">Optional</span></label>
                  <input className="px-in" placeholder="e.g. Invoice payment" value={purpose} onChange={(e) => setPurpose(e.target.value)} /></div>
                <div className="px-field"><label>Message <span className="opt">Optional</span></label>
                  <input className="px-in" placeholder="Note for the recipient" value={remark} onChange={(e) => setRemark(e.target.value)} /></div>
              </div>
            </div>
          </div>
        </div>

        <aside className="px-review">
          <div className="px-review-head"><h3>Before you send</h3></div>
          <div className="px-review-body">
            <dl>
              <div className="px-rrow"><dt>Method</dt><dd>RTGS</dd></div>
              <div className="px-rrow"><dt>Bank</dt><dd className={bank ? '' : 'empty'}>{bank ? bank.name : 'Select a bank'}</dd></div>
              <div className="px-rrow"><dt>Account</dt><dd className={account ? '' : 'empty'}>{account || 'Add a number'}</dd></div>
              <div className="px-rrow"><dt>Name</dt><dd className={beneficiaryName ? '' : 'empty'}>{beneficiaryName || '—'}</dd></div>
              <div className="px-rrow big"><dt>Amount</dt><dd className={amtNum === 0 ? 'empty' : ''}><span className="u">KES</span>{n2(amtNum)}</dd></div>
              <div className="px-rrow"><dt>Arrives</dt><dd>Same working day</dd></div>
              <div className="px-rrow after"><dt>Balance after</dt><dd className={short ? 'short' : ''}>{afterBal == null ? '—' : short ? ('Short by KES ' + n2(Math.abs(afterBal))) : ('KES ' + n2(afterBal))}</dd></div>
            </dl>
          </div>
          <div className="px-review-foot">
            {short && <div className="px-note bad"><span>Not enough in your balance to send this amount.</span></div>}
            {error && <div className="px-note bad"><span>{error}</span></div>}
            <button className="px-btn spark block" disabled={!validForm || busy || short} onClick={initiate}>{busy ? 'Starting…' : 'Continue'}</button>
            <span className="px-sms"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4.5" y="10" width="15" height="10.5" rx="2.2" /><path d="M8 10V7.5a4 4 0 0 1 8 0V10" /></svg> You'll confirm with a code sent by SMS.</span>
          </div>
        </aside>
      </div>
    </div>
  );

  return (
    <div className="pm-flow">
      <div className="pm-flow-head">
        <button className="pm-flow-back" onClick={step === 'otp' ? () => setStep('form') : onCancel}>← Back</button>
        <h2>RTGS Transfer</h2>
      </div>
      {step === 'waiting' && (
        <div style={{ textAlign: 'center', padding: '32px 0' }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>📲</div>
          <div style={{ color: '#f5a623', fontWeight: 700, fontSize: 16, marginBottom: 8 }}>Waiting for OTP…</div>
          <div style={{ color: '#9aa4b2', fontSize: 13 }}>Choice Bank sent an OTP to your phone.<br />It will be captured automatically.</div>
        </div>
      )}
      {step === 'otp' && (
        <>
          <p className="pm-otpinfo">{info}</p>
          <div className="pm-field"><label>OTP code</label>
            <input className="pm-inp" inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="Enter the code"
              value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} /></div>
          {error && <div className="pm-error">{error}</div>}
          <button className="pm-btn" disabled={!otp || busy} onClick={confirm}>{busy ? 'Confirming…' : `Send ${fmtKES(amount)} via RTGS`}</button>
          <OtpResend flow="rtgs" />
        </>
      )}
    </div>
  );
}

// ── MpesaToBank ───────────────────────────────────────────────────────────────

function MpesaToBank({ onDone, onCancel, balance = null }) {
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

  const amtNum = Number(amount) || 0;
  const n2 = (v) => Number(v || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const afterBal = balance != null ? balance + amtNum : null;   // a deposit — balance goes UP

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
    <div>
      <div className="px-vh"><h2>M-Pesa to bank</h2><p>Pull money from your M-Pesa and land it in your Choice Bank account. We'll send a prompt to your phone to approve.</p></div>
      <div className="px-cols">
        <div>
          <div className="px-card">
            <div className="px-card-head"><h3>Deposit details</h3><span className="r">Max KES 150,000 per transaction</span></div>
            <div className="px-card-body">
              <div className="px-field"><label>M-Pesa number to pull from</label>
                <input className="px-in" inputMode="tel" placeholder="07XX XXX XXX" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
              <div className="px-field"><label>Amount</label>
                <div className="px-amt"><span className="cur">KES</span><input className="px-in amount" inputMode="numeric" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))} /></div>
              </div>
            </div>
          </div>
        </div>

        <aside className="px-review">
          <div className="px-review-head"><h3>Before you deposit</h3></div>
          <div className="px-review-body">
            <dl>
              <div className="px-rrow"><dt>From</dt><dd className={phone ? '' : 'empty'}>{phone || 'Add a number'}</dd></div>
              <div className="px-rrow"><dt>Into</dt><dd>Choice Bank</dd></div>
              <div className="px-rrow big"><dt>Amount</dt><dd className={amtNum === 0 ? 'empty' : ''}><span className="u">KES</span>{n2(amtNum)}</dd></div>
              <div className="px-rrow"><dt>Arrives</dt><dd>Up to 2 minutes</dd></div>
              <div className="px-rrow after"><dt>Balance after</dt><dd style={{ color: '#3FD07A' }}>{afterBal == null ? '—' : 'KES ' + n2(afterBal)}</dd></div>
            </dl>
          </div>
          <div className="px-review-foot">
            {error && <div className="px-note bad"><span>{error}</span></div>}
            <button className="px-btn spark block" disabled={!validForm || busy} onClick={submit}>{busy ? 'Sending prompt…' : 'Deposit via M-Pesa'}</button>
            <span className="px-sms"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="7" y="2" width="10" height="20" rx="2.2" /><path d="M11 18.4h2" /></svg> Approve the M-Pesa prompt on your phone.</span>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ── SendMoney (M-Pesa + Airtel, with Hakikisha name lookup for M-Pesa) ─────────

function SendMoney({ network = 'mpesa', balance = null, onDone, onCancel }) {
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
  const [quote, setQuote] = useState(null); // fee preview + max "withdraw everything"
  const doneRef = useRef(false); // guards the background auto-capture poll from overriding a manual confirm

  const rawPhone = phone.replace(/\s/g, '');
  const validPhone = /^(0?7|0?1|7|1)\d{8}$/.test(rawPhone);
  const amtNum = Number(amount) || 0;
  // The recipient gets `amount`; Choice charges a fee ON TOP, so the balance must
  // cover amount + fee. Block submit when it doesn't (the backend re-checks too).
  const insufficient = !!(quote && amtNum >= 10 && quote.total > quote.balance);
  const validForm = validPhone && amtNum > 0 && amtNum <= limit && !insufficient;

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

  // Fee preview: fee for the typed amount, whether the balance covers amount+fee,
  // and the max amount that empties the account (for "Withdraw everything").
  // Pure server-side computation from the pricing sheet — the backend stays the
  // authority, so we never hardcode (and drift from) the fee tables here.
  useEffect(() => {
    if (balance == null) { setQuote(null); return; }
    let cancel = false;
    const t = setTimeout(async () => {
      try {
        const r = await cbSendMoneyQuote(network, amtNum, balance);
        if (!cancel) setQuote(r.data || null);
      } catch { if (!cancel) setQuote(null); }
    }, 300);
    return () => { cancel = true; clearTimeout(t); };
  }, [amtNum, balance, network]);

  const initiate = async () => {
    setError(''); setBusy(true); doneRef.current = false;
    try {
      await cbSendMoneyInitiate({
        payee_phone: phone.trim(),
        amount: Number(amount),
        payee_name: payee.name || '',
        network,
      });
      setStep('waiting');
      setBusy(false);   // free the screen so the user can enter the code manually or use email
      // Auto-confirm runs in the BACKGROUND: the backend waits for the SMS OTP from the
      // MacroDroid webhook. If it lands first, we finish; if it times out, we drop to
      // manual entry. Either path is guarded by doneRef so it can't override a manual
      // confirm the user completed in the meantime.
      (async () => {
        try {
          await cbSendMoneyConfirmSms();
          if (!doneRef.current) { doneRef.current = true; setStep('done'); }
        } catch (e2) {
          if (!doneRef.current) {
            setInfo('OTP not auto-captured — enter the code from your phone manually.');
            setStep('otp');
          }
        }
      })();
    } catch (e) {
      setError(e.response?.data?.detail || 'Could not start the transfer. Please try again.');
      setBusy(false);
    }
  };

  const confirm = async () => {
    setError(''); setBusy(true);
    try { await cbSendMoneyConfirm(otp.trim()); doneRef.current = true; setStep('done'); }
    catch (e) { setError(e.response?.data?.detail || 'OTP confirmation failed.'); }
    finally { setBusy(false); }
  };

  // SMS OTP didn't arrive — get the same transfer's code by email instead.
  const resendEmail = async () => {
    setError(''); setInfo(''); setBusy(true);
    try {
      const r = await cbSendMoneyResendEmail();
      setInfo(r.data?.message || 'We sent the OTP to your registered email. Enter it below to complete the transfer.');
      setStep('otp');
    } catch (e) {
      setError(e.response?.data?.detail || 'Could not send the email OTP.');
      setStep('otp');
    } finally { setBusy(false); }
  };

  const n2 = (v) => Number(v || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const afterBal = balance != null ? balance - (quote ? quote.total : amtNum) : null;

  if (step === 'done') return (
    <div className="pm-flow pm-success">
      <div style={{ fontSize: 56 }}>✅</div>
      <h2>Money sent</h2>
      <p>{fmtKES(amount)} is on its way to {payee.name || phone}.</p>
      <button className="pm-btn" onClick={onDone}>Done</button>
    </div>
  );

  // ── FORM: two-column (form + live review slip), matching the SparkP2P mockup ──
  if (step === 'form') return (
    <div>
      <div className="px-vh">
        <h2>{title}</h2>
        <p>Money leaves your Choice Bank balance and arrives on the recipient's {isMpesa ? 'M-Pesa' : 'Airtel'} in a few seconds.</p>
      </div>
      <div className="px-cols">
        <div>
          <div className="px-card">
            <div className="px-card-head"><h3>Recipient</h3><span className="r">Max {fmtKES(limit)} per transaction</span></div>
            <div className="px-card-body">
              <div className="px-field">
                <label>Phone number</label>
                <input className="px-in" inputMode="tel" placeholder="07XX XXX XXX" value={phone} onChange={(e) => setPhone(e.target.value)} />
                {isMpesa && payee.status === 'checking' && <span className="hint">Verifying name…</span>}
                {isMpesa && payee.status === 'ok' && payee.name && (
                  <div className="px-verified">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#3FD07A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5 9.5 17 19 7" /></svg>
                    Registered to <b>{payee.name}</b>
                  </div>
                )}
                {isMpesa && payee.status === 'fail' && <span className="hint" style={{ color: '#E4C58A' }}>Could not verify the name — check the number.</span>}
              </div>
              <div className="px-field">
                <label>Amount
                  {quote && quote.max_net >= 10 && (
                    <button type="button" onClick={() => setAmount(String(quote.max_net))} style={{ marginLeft: 'auto', background: 'rgba(248,168,28,0.12)', border: '1px solid rgba(248,168,28,0.35)', color: '#F8A81C', fontSize: 11.5, fontWeight: 700, cursor: 'pointer', padding: '4px 10px', borderRadius: 999 }}>Withdraw everything</button>
                  )}
                </label>
                <div className="px-amt"><span className="cur">KES</span>
                  <input className="px-in amount" inputMode="numeric" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
                </div>
              </div>
              <div className="px-field">
                <label>Note <span className="opt">Optional</span></label>
                <input className="px-in" placeholder="e.g. Trade payment" disabled title="Notes aren't sent on M-Pesa transfers" />
              </div>
            </div>
          </div>
        </div>

        <aside className="px-review">
          <div className="px-review-head"><h3>Before you send</h3></div>
          <div className="px-review-body">
            <dl>
              <div className="px-rrow"><dt>To</dt><dd className={(payee.name || phone) ? '' : 'empty'}>{payee.name || phone || 'Add a number'}</dd></div>
              <div className="px-rrow"><dt>Method</dt><dd>{isMpesa ? 'M-Pesa' : 'Airtel Money'}</dd></div>
              <div className="px-rrow big"><dt>Amount</dt><dd className={amtNum === 0 ? 'empty' : ''}><span className="u">KES</span>{n2(amtNum)}</dd></div>
              <div className="px-rrow"><dt>Fee</dt><dd>{quote && amtNum >= 10 ? ('+ KES ' + n2(quote.fee)) : 'Shown at confirm'}</dd></div>
              <div className="px-rrow after"><dt>Balance after</dt><dd className={insufficient ? 'short' : ''}>{afterBal == null ? '—' : insufficient ? ('Short by KES ' + n2(Math.abs(afterBal))) : ('KES ' + n2(afterBal))}</dd></div>
            </dl>
          </div>
          <div className="px-review-foot">
            {insufficient && (
              <div className="px-note bad">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}><path d="M12 3.5 22 20H2z" /><path d="M12 10v4.2M12 17.2v.4" /></svg>
                <span>Not enough balance — you need <b>KES {n2(quote.total)}</b> ({fmtKES(amtNum)} + {fmtKES(quote.fee)} fee).{quote.max_net >= 10 && <> Tap <b>Withdraw everything</b> to send {fmtKES(quote.max_net)}.</>}</span>
              </div>
            )}
            {error && <div className="px-note bad"><span>{error}</span></div>}
            <button className="px-btn spark block" disabled={!validForm || busy} onClick={initiate}>{busy ? 'Starting…' : 'Continue'}</button>
            <span className="px-sms">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4.5" y="10" width="15" height="10.5" rx="2.2" /><path d="M8 10V7.5a4 4 0 0 1 8 0V10" /></svg>
              You'll confirm with a code sent by SMS.
            </span>
          </div>
        </aside>
      </div>
    </div>
  );

  // ── WAITING / OTP steps (unchanged logic) ──
  return (
    <div className="pm-flow">
      <div className="pm-flow-head">
        <button className="pm-flow-back" onClick={step === 'otp' ? () => setStep('form') : onCancel}>← Back</button>
        <h2>{title}</h2>
      </div>
      {step === 'waiting' && (
        <div style={{ textAlign: 'center', padding: '32px 0' }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>📲</div>
          <div style={{ color: '#f5a623', fontWeight: 700, fontSize: 16, marginBottom: 8 }}>Waiting for OTP…</div>
          <div style={{ color: '#9aa4b2', fontSize: 13 }}>Choice Bank sent an OTP to your phone.<br />It will be captured automatically.</div>
          {error && <div className="pm-error" style={{ marginTop: 14 }}>{error}</div>}
          {/* If auto-capture is slow, let the user just type the code they received. */}
          <button onClick={() => { setError(''); setInfo('Enter the OTP Choice Bank sent to your phone.'); setStep('otp'); }}
            style={{ marginTop: 22, display: 'block', width: '100%', background: 'linear-gradient(135deg,#f59e0b,#d97706)', border: 'none', color: '#10131a', borderRadius: 10, padding: '12px 16px', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
            Enter the code manually
          </button>
          <button onClick={resendEmail} disabled={busy}
            style={{ marginTop: 12, background: 'none', border: 'none', color: '#f59e0b', fontSize: 13, cursor: busy ? 'default' : 'pointer', textDecoration: 'underline', padding: 0 }}>
            {busy ? 'Sending…' : '📧 SMS not arriving? Get the code by email'}
          </button>
        </div>
      )}
      {step === 'otp' && (
        <>
          <p className="pm-otpinfo">{info}</p>
          <div className="pm-field"><label>OTP code</label>
            <input className="pm-inp" inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="Enter the code"
              value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} /></div>
          {error && <div className="pm-error">{error}</div>}
          <button className="pm-btn" disabled={!otp || busy} onClick={confirm}>{busy ? 'Confirming…' : `Send ${fmtKES(amount)}`}</button>
          <OtpResend flow="send_money" />
          <button onClick={resendEmail} disabled={busy}
            style={{ display: 'block', background: 'none', border: 'none', color: '#f59e0b', fontSize: 13, cursor: 'pointer', textDecoration: 'underline', padding: 0, marginTop: 10 }}>
            📧 Didn't get the SMS? Get the code by email instead
          </button>
        </>
      )}
    </div>
  );
}

// ── Paybill ───────────────────────────────────────────────────────────────────

function Paybill({ onDone, onCancel, defaultTill = false, balance = null }) {
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

  const amtNum = Number(amount) || 0;
  const n2 = (v) => Number(v || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const afterBal = balance != null ? balance - amtNum : null;

  if (step === 'done') return (
    <div className="pm-flow pm-success">
      <div style={{ fontSize: 56 }}>⏳</div>
      <h2>Payment processing</h2>
      <p>{fmtKES(amount)} to {isPaybill ? `Paybill ${biz} (acc ${acct})` : `Till ${biz}`} is being processed. You'll get a Telegram confirmation the moment it completes — or a notice if it doesn't go through and the money is returned.</p>
      <button className="pm-btn" onClick={onDone}>Done</button>
    </div>
  );

  if (step === 'form') return (
    <div>
      <div className="px-vh"><h2>Pay Paybill or Till</h2><p>Pay a business from your Choice Bank balance through M-Pesa.</p></div>
      <div className="px-cols">
        <div>
          <div className="px-card">
            <div className="px-card-head"><h3>Payment details</h3></div>
            <div className="px-card-body">
              <div className="px-field">
                <label>Payment type</label>
                <div className="px-seg">
                  <button aria-pressed={isPaybill} onClick={() => setIsPaybill(true)}>Paybill</button>
                  <button aria-pressed={!isPaybill} onClick={() => setIsPaybill(false)}>Till / Buy Goods</button>
                </div>
              </div>
              {isPaybill && (
                <div className="px-note warn" style={{ marginBottom: 18 }}>
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}><path d="M12 3.5 22 20H2z" /><path d="M12 10v4.2M12 17.2v.4" /></svg>
                  <span><b>Paying a bank paybill?</b> Choice can't verify a bank account number before the money goes, so a wrong number can leave your account and never arrive. Use <b>PesaLink</b> for Equity (247247), KCB, Co-op and similar.</span>
                </div>
              )}
              <div className="px-row2">
                <div className="px-field">
                  <label>{isPaybill ? 'Paybill number' : 'Till / Buy Goods number'}</label>
                  <input className="px-in" inputMode="numeric" placeholder="e.g. 247247" value={biz} onChange={(e) => setBiz(e.target.value.replace(/\D/g, ''))} />
                  {payee.status === 'checking' && <span className="hint">Verifying name…</span>}
                  {payee.status === 'ok' && (
                    <div className="px-verified"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#3FD07A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5 9.5 17 19 7" /></svg> Paying to <b>{payee.name}</b></div>
                  )}
                  {payee.status === 'fail' && <span className="hint" style={{ color: isPaybill ? '#FF6E5C' : '#E4C58A' }}>{payee.name}{!isPaybill && ' — you can still proceed for Till.'}</span>}
                </div>
                {isPaybill && (
                  <div className="px-field"><label>Account number</label>
                    <input className="px-in" placeholder="Your account or phone" value={acct} onChange={(e) => setAcct(e.target.value)} /></div>
                )}
              </div>
              <div className="px-field"><label>Amount</label>
                <div className="px-amt"><span className="cur">KES</span><input className="px-in amount" inputMode="numeric" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} /></div>
              </div>
            </div>
          </div>
        </div>

        <aside className="px-review">
          <div className="px-review-head"><h3>Before you pay</h3></div>
          <div className="px-review-body">
            <dl>
              <div className="px-rrow"><dt>Type</dt><dd>{isPaybill ? 'Paybill' : 'Till / Buy Goods'}</dd></div>
              <div className="px-rrow"><dt>Business</dt><dd className={biz ? '' : 'empty'}>{biz || 'Add a number'}</dd></div>
              {isPaybill && <div className="px-rrow"><dt>Account</dt><dd className={acct ? '' : 'empty'}>{acct || 'Add account'}</dd></div>}
              {payee.status === 'ok' && <div className="px-rrow"><dt>Paying</dt><dd>{payee.name}</dd></div>}
              <div className="px-rrow big"><dt>Amount</dt><dd className={amtNum === 0 ? 'empty' : ''}><span className="u">KES</span>{n2(amtNum)}</dd></div>
              <div className="px-rrow after"><dt>Balance after</dt><dd>{afterBal == null ? '—' : 'KES ' + n2(afterBal)}</dd></div>
            </dl>
          </div>
          <div className="px-review-foot">
            {error && <div className="px-note bad"><span>{error}</span></div>}
            <button className="px-btn spark block" disabled={!validForm || busy} onClick={initiate}>{busy ? 'Starting…' : 'Continue'}</button>
            <span className="px-sms"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4.5" y="10" width="15" height="10.5" rx="2.2" /><path d="M8 10V7.5a4 4 0 0 1 8 0V10" /></svg> You'll confirm with a code sent by SMS.</span>
          </div>
        </aside>
      </div>
    </div>
  );

  return (
    <div className="pm-flow">
      <div className="pm-flow-head">
        <button className="pm-flow-back" onClick={step === 'otp' ? () => setStep('form') : onCancel}>← Back</button>
        <h2>Pay Paybill / Till</h2>
      </div>
      {step === 'otp' && (
        <>
          <p className="pm-otpinfo">{info}</p>
          <div className="pm-field"><label>OTP code</label>
            <input className="pm-inp" inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="Enter the code" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} /></div>
          {error && <div className="pm-error">{error}</div>}
          <button className="pm-btn" disabled={!otp || busy} onClick={confirm}>{busy ? 'Confirming…' : `Pay ${fmtKES(amount)}`}</button>
          <OtpResend flow="paybill" />
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
      <div style={{ fontSize: 56 }}>⏳</div>
      <h2>Payment processing</h2>
      <p>{fmtKES(amount)} to {cfg.name} ({cfg.acctLabel.toLowerCase()}: {acct}) is being processed. You'll get a Telegram confirmation once it completes — or a notice if it doesn't go through and the money is returned.</p>
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
          <OtpResend flow="paybill" />
        </>
      )}
    </div>
  );
}
