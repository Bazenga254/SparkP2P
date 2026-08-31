import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { publicUnlock, publicView, publicTransactions, publicDeposit, publicDepositStatus } from '../services/api';

const C = { bg: '#0A0D13', card: '#131722', line: '#232B3A', ink: '#0A0D13', text: '#E9EDF4', muted: '#8B94A7', amber: '#FFA51F', mint: '#3ECF8E', red: '#F2635C', blue: '#5B8DEF' };
const money = (n) => n == null ? '••••' : Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function PublicAccount() {
  const { slug } = useParams();
  const [token, setToken] = useState(() => { try { return sessionStorage.getItem(`sv_${slug}`) || ''; } catch { return ''; } });
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [data, setData] = useState(null);
  const [txns, setTxns] = useState([]);

  const loadView = useCallback((tk) => {
    publicView(slug, tk).then((r) => setData(r.data)).catch((e) => {
      if (e.response?.status === 401) { setToken(''); try { sessionStorage.removeItem(`sv_${slug}`); } catch {} }
      else setErr(e.response?.data?.detail || 'This link is unavailable.');
    });
    publicTransactions(slug, tk).then((r) => setTxns(r.data?.transactions || [])).catch(() => {});
  }, [slug]);

  useEffect(() => { if (token) loadView(token); }, [token, loadView]);

  const unlock = async () => {
    setErr(''); setBusy(true);
    try {
      const r = await publicUnlock(slug, password);
      const tk = r.data?.token;
      setToken(tk); try { sessionStorage.setItem(`sv_${slug}`, tk); } catch {}
      setPassword('');
    } catch (e) {
      if (e.response?.status === 423) { setLocked(true); setErr(e.response?.data?.detail || 'This link is locked.'); }
      else setErr(e.response?.data?.detail || 'Wrong password.');
    } finally { setBusy(false); }
  };

  // ── Gate ──
  if (!token || !data) {
    return (
      <Shell>
        <div style={{ maxWidth: 380, margin: '0 auto', textAlign: 'center' }}>
          <div style={{ width: 54, height: 54, borderRadius: 16, background: 'rgba(255,165,31,.12)', display: 'grid', placeItems: 'center', margin: '0 auto 16px' }}>
            <LockIcon />
          </div>
          <h1 style={{ fontSize: 21, fontWeight: 800, margin: '0 0 6px', color: C.text }}>Account view</h1>
          <p style={{ color: C.muted, fontSize: 14, margin: '0 0 22px' }}>Enter the password you were given to see this account.</p>
          {locked ? (
            <div style={{ background: 'rgba(242,99,92,.1)', border: '1px solid #3a2530', borderRadius: 12, padding: 16, color: C.red, fontSize: 13.5 }}>
              🔒 This link is locked after too many wrong passwords. Please contact the account owner to have it unlocked.
            </div>
          ) : (
            <>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !busy && unlock()}
                placeholder="Password" autoFocus
                style={{ width: '100%', background: C.ink, border: `1px solid ${C.line}`, borderRadius: 11, padding: '13px 14px', color: C.text, fontSize: 15, boxSizing: 'border-box', textAlign: 'center' }} />
              {err && <div style={{ color: C.red, fontSize: 13, marginTop: 10 }}>{err}</div>}
              <button onClick={unlock} disabled={busy || !password}
                style={{ width: '100%', marginTop: 14, background: C.amber, color: '#160F00', border: 0, borderRadius: 11, padding: 13, fontWeight: 700, fontSize: 15, cursor: 'pointer', opacity: busy || !password ? .6 : 1 }}>
                {busy ? 'Checking…' : 'View account'}
              </button>
            </>
          )}
          <p style={{ color: '#5B6577', fontSize: 11.5, marginTop: 26 }}>Powered by SparkP2P · read-only view</p>
        </div>
      </Shell>
    );
  }

  // ── Unlocked view ──
  return (
    <Shell>
      <div style={{ maxWidth: 620, margin: '0 auto' }}>
        <div style={{ marginBottom: 6, fontSize: 12.5, color: C.muted }}>{data.account_name}</div>
        <h1 style={{ fontSize: 18, fontWeight: 800, margin: '0 0 16px', color: C.text }}>{data.label}</h1>

        {/* balance */}
        <div style={{ background: `linear-gradient(150deg,#2A2110,${C.card} 70%)`, border: `1px solid ${C.line}`, borderRadius: 16, padding: '18px 20px', marginBottom: 14 }}>
          <div style={{ fontSize: 11, letterSpacing: '.13em', textTransform: 'uppercase', color: C.amber, fontFamily: 'ui-monospace,monospace' }}>Current balance</div>
          <div style={{ fontFamily: 'ui-monospace,monospace', fontSize: 32, fontWeight: 600, color: '#fff', marginTop: 4 }}>
            <span style={{ fontSize: 15, color: C.muted, marginRight: 6 }}>{data.currency || 'KES'}</span>{money(data.balance)}
          </div>
        </div>

        {/* account details */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
          <Detail label="Paybill" value={data.paybill || '—'} />
          <Detail label="Account number" value={data.account_number || '—'} />
        </div>

        {/* deposit */}
        {data.allow_deposit && <DepositCard slug={slug} token={token} onDone={() => loadView(token)} />}

        {/* transactions */}
        {data.show_transactions ? (
          <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, padding: '16px 6px 8px', marginTop: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.text, padding: '0 12px 10px' }}>Transactions</div>
            {txns.length === 0 ? (
              <div style={{ color: C.muted, fontSize: 13.5, padding: '10px 12px 16px' }}>No transactions yet.</div>
            ) : txns.map((t, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 12px', borderTop: i ? `1px solid #1B2230` : 0 }}>
                <span style={{ width: 34, height: 34, borderRadius: 10, flex: '0 0 auto', display: 'grid', placeItems: 'center', fontSize: 16, background: t.direction === 'in' ? 'rgba(62,207,142,.12)' : 'rgba(242,99,92,.12)' }}>
                  {t.direction === 'in' ? '↓' : '↑'}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</div>
                  <div style={{ fontSize: 12, color: C.muted }}>{t.type}{t.date ? ` · ${new Date(t.date).toLocaleString('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}</div>
                </div>
                <div style={{ fontFamily: 'ui-monospace,monospace', fontSize: 14, fontWeight: 600, color: t.direction === 'in' ? C.mint : C.text, flex: '0 0 auto' }}>
                  {t.direction === 'in' ? '+' : '−'}{money(t.amount)}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ marginTop: 14, color: '#5B6577', fontSize: 12.5, textAlign: 'center' }}>Transaction history is hidden for this link.</div>
        )}

        <p style={{ color: '#5B6577', fontSize: 11.5, marginTop: 26, textAlign: 'center' }}>Read-only · you can view & deposit but not withdraw · Powered by SparkP2P</p>
      </div>
    </Shell>
  );
}

function DepositCard({ slug, token, onDone }) {
  const [phone, setPhone] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // {type, text}

  const send = async () => {
    setMsg(null);
    const amt = parseInt(amount, 10);
    if (!amt || amt < 1) { setMsg({ type: 'err', text: 'Enter an amount of at least KES 1.' }); return; }
    setBusy(true);
    try {
      const r = await publicDeposit(slug, token, phone, amt);
      const txId = r.data?.txId;
      setMsg({ type: 'ok', text: 'Check your phone and enter your M-Pesa PIN to complete the deposit.' });
      if (txId) pollStatus(txId);
    } catch (e) { setMsg({ type: 'err', text: e.response?.data?.detail || 'Could not start the deposit.' }); }
    finally { setBusy(false); }
  };

  const pollStatus = (txId) => {
    let tries = 0;
    const iv = setInterval(async () => {
      tries++;
      try {
        const r = await publicDepositStatus(slug, token, txId);
        if (r.data?.status === 'success') { clearInterval(iv); setMsg({ type: 'ok', text: `✅ Deposit of KES ${money(r.data.amount)} received.` }); setPhone(''); setAmount(''); onDone && onDone(); }
        else if (r.data?.status === 'failed') { clearInterval(iv); setMsg({ type: 'err', text: 'The deposit was cancelled or failed.' }); }
      } catch {}
      if (tries > 20) clearInterval(iv);
    }, 3000);
  };

  return (
    <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, padding: '16px 18px' }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>Deposit by M-Pesa</div>
      <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 12 }}>Money lands in this account in a few seconds. Your name will show on the account.</div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Your M-Pesa number (07…)" inputMode="numeric"
          style={{ flex: '1 1 180px', background: C.ink, border: `1px solid ${C.line}`, borderRadius: 10, padding: '11px 12px', color: C.text, fontSize: 14, boxSizing: 'border-box' }} />
        <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))} placeholder="Amount (KES)" inputMode="numeric"
          style={{ flex: '1 1 120px', background: C.ink, border: `1px solid ${C.line}`, borderRadius: 10, padding: '11px 12px', color: C.text, fontSize: 14, boxSizing: 'border-box' }} />
      </div>
      <button onClick={send} disabled={busy || !phone || !amount}
        style={{ width: '100%', marginTop: 12, background: C.mint, color: '#04140C', border: 0, borderRadius: 11, padding: 12, fontWeight: 700, fontSize: 14.5, cursor: 'pointer', opacity: busy || !phone || !amount ? .6 : 1 }}>
        {busy ? 'Sending…' : 'Send STK push'}
      </button>
      {msg && <div style={{ marginTop: 10, fontSize: 13, color: msg.type === 'ok' ? C.mint : C.red }}>{msg.text}</div>}
    </div>
  );
}

function Detail({ label, value }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: '12px 14px' }}>
      <div style={{ fontSize: 11, color: C.muted, textTransform: 'uppercase', letterSpacing: '.06em' }}>{label}</div>
      <div style={{ fontFamily: 'ui-monospace,monospace', fontSize: 15, color: C.text, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, fontFamily: "'IBM Plex Sans',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", padding: '40px 16px 60px' }}>
      {children}
    </div>
  );
}

function LockIcon() {
  return <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke={C.amber} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>;
}
