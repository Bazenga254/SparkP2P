import { useEffect, useState } from 'react';
import { Link2, Copy, Trash2, Lock, Eye, EyeOff, Plus, KeyRound, PauseCircle, PlayCircle, Check } from 'lucide-react';
import { linksList, linkCreate, linkUpdate, linkChangePassword, linkSetStatus, linkDelete } from '../services/api';

const C = { card: '#131722', line: '#232B3A', ink: '#0A0D13', text: '#E9EDF4', muted: '#8B94A7', amber: '#FFA51F', mint: '#3ECF8E', red: '#F2635C', blue: '#5B8DEF' };

export default function ShareLinks({ profile }) {
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [toast, setToast] = useState('');

  const load = () => {
    setLoading(true);
    linksList().then((r) => setLinks(r.data?.links || [])).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 2400); };
  const copy = (url) => { navigator.clipboard?.writeText(url); flash('Link copied'); };

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '4px 2px 60px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 18, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 20, fontWeight: 800, color: C.text, display: 'flex', alignItems: 'center', gap: 9 }}>
            <Link2 size={20} color={C.amber} /> Shared account links
          </h2>
          <p style={{ margin: 0, color: C.muted, fontSize: 13.5, lineHeight: 1.5 }}>
            Share a <b>read-only</b> view of your Choice Bank account. People with the link + its password
            can see the balance, deposit by M-Pesa, and (optionally) view transactions — but can never withdraw.
          </p>
        </div>
        <button onClick={() => setShowCreate(true)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: C.amber, color: '#160F00', border: 0, borderRadius: 10, padding: '10px 16px', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
          <Plus size={16} /> New link
        </button>
      </div>

      {loading ? (
        <div style={{ color: C.muted, padding: 30, textAlign: 'center' }}>Loading…</div>
      ) : links.length === 0 ? (
        <div style={{ border: `1px dashed ${C.line}`, borderRadius: 16, padding: '40px 20px', textAlign: 'center', color: C.muted }}>
          <Link2 size={30} color={C.muted} style={{ opacity: .6 }} />
          <div style={{ marginTop: 10, fontSize: 14 }}>No shared links yet. Create one to let others view your account and deposit.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {links.map((l) => <LinkRow key={l.id} link={l} onChanged={load} onCopy={copy} flash={flash} />)}
        </div>
      )}

      {showCreate && <CreateModal onClose={() => setShowCreate(false)} onDone={() => { setShowCreate(false); load(); flash('Link created'); }} />}
      {toast && <div style={{ position: 'fixed', left: '50%', bottom: 30, transform: 'translateX(-50%)', background: '#1a2029', color: '#fff', padding: '11px 20px', borderRadius: 10, zIndex: 90, boxShadow: '0 10px 30px rgba(0,0,0,.4)', fontSize: 14 }}>{toast}</div>}
    </div>
  );
}

function Badge({ color, children }) {
  return <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color, background: `${color}22`, padding: '3px 8px', borderRadius: 6 }}>{children}</span>;
}

function LinkRow({ link, onChanged, onCopy, flash }) {
  const [busy, setBusy] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [pw, setPw] = useState('');

  const toggle = async (field) => {
    setBusy(true);
    try { await linkUpdate(link.id, { [field]: !link[field] }); onChanged(); } catch { flash('Could not update'); } finally { setBusy(false); }
  };
  const setStatus = async (status) => {
    setBusy(true);
    try { await linkSetStatus(link.id, status); onChanged(); } catch (e) { flash(e.response?.data?.detail || 'Could not update'); } finally { setBusy(false); }
  };
  const del = async () => {
    if (!window.confirm('Delete this link? Anyone using it will lose access immediately.')) return;
    setBusy(true);
    try { await linkDelete(link.id); onChanged(); flash('Link deleted'); } catch { flash('Could not delete'); } finally { setBusy(false); }
  };
  const changePw = async () => {
    if (pw.length < 4) { flash('Password must be at least 4 characters'); return; }
    setBusy(true);
    try { await linkChangePassword(link.id, pw); setPw(''); setPwOpen(false); onChanged(); flash('Password changed'); } catch (e) { flash(e.response?.data?.detail || 'Could not change'); } finally { setBusy(false); }
  };

  const statusColor = link.status === 'active' ? C.mint : link.status === 'locked' ? C.red : C.muted;

  return (
    <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: '15px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: C.text }}>{link.label}</div>
        <Badge color={statusColor}>{link.status}</Badge>
        {link.locked && <span style={{ fontSize: 11.5, color: C.red, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Lock size={12} /> locked — ask an admin to unlock</span>}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: C.muted }}>{link.view_count} view{link.view_count === 1 ? '' : 's'}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, background: C.ink, border: `1px solid ${C.line}`, borderRadius: 9, padding: '9px 11px' }}>
        <span style={{ flex: 1, minWidth: 0, fontFamily: 'ui-monospace,monospace', fontSize: 12.5, color: C.blue, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{link.url}</span>
        <button onClick={() => onCopy(link.url)} title="Copy link" style={iconBtn}><Copy size={15} /></button>
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
        <Chip on={link.show_transactions} onClick={() => toggle('show_transactions')} disabled={busy}
          icon={link.show_transactions ? <Eye size={14} /> : <EyeOff size={14} />} label={link.show_transactions ? 'Transactions visible' : 'Transactions hidden'} />
        <Chip on={link.allow_deposit} onClick={() => toggle('allow_deposit')} disabled={busy}
          icon={<Plus size={14} />} label={link.allow_deposit ? 'Deposits on' : 'Deposits off'} />
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button onClick={() => setPwOpen((v) => !v)} disabled={busy} style={actBtn}><KeyRound size={14} /> Change password</button>
        {link.status === 'active' && <button onClick={() => setStatus('suspended')} disabled={busy} style={actBtn}><PauseCircle size={14} /> Suspend</button>}
        {link.status === 'suspended' && <button onClick={() => setStatus('active')} disabled={busy} style={actBtn}><PlayCircle size={14} /> Resume</button>}
        <button onClick={del} disabled={busy} style={{ ...actBtn, color: C.red, borderColor: '#3a2530' }}><Trash2 size={14} /> Delete</button>
      </div>

      {pwOpen && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input type="text" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="New password (min 4 chars)"
            style={{ flex: 1, background: C.ink, border: `1px solid ${C.line}`, borderRadius: 9, padding: '10px 12px', color: C.text, fontSize: 14 }} />
          <button onClick={changePw} disabled={busy} style={{ ...actBtn, background: C.amber, color: '#160F00', border: 0 }}><Check size={14} /> Save</button>
        </div>
      )}
    </div>
  );
}

function Chip({ on, onClick, disabled, icon, label }) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 999, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
        border: `1px solid ${on ? '#2a4a3a' : C.line}`, background: on ? 'rgba(62,207,142,.12)' : 'transparent', color: on ? C.mint : C.muted }}>
      {icon} {label}
    </button>
  );
}

function CreateModal({ onClose, onDone }) {
  const [label, setLabel] = useState('');
  const [password, setPassword] = useState('');
  const [showTx, setShowTx] = useState(true);
  const [allowDep, setAllowDep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    setErr('');
    if (password.length < 4) { setErr('Password must be at least 4 characters.'); return; }
    setBusy(true);
    try { await linkCreate({ label, password, show_transactions: showTx, allow_deposit: allowDep }); onDone(); }
    catch (e) { setErr(e.response?.data?.detail || 'Could not create the link.'); }
    finally { setBusy(false); }
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 95, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, padding: 22, width: 440, maxWidth: '100%' }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 17, fontWeight: 800, color: C.text }}>New shared link</h3>
        <p style={{ margin: '0 0 16px', color: C.muted, fontSize: 13 }}>Anyone with the link + password can view this account and deposit.</p>

        <label style={lbl}>Name (only you see this)</label>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Family, Suppliers" style={inp} />

        <label style={lbl}>Password for viewers</label>
        <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Set a password to share" style={inp} />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '6px 0 16px' }}>
          <Toggle on={showTx} set={setShowTx} label="Let viewers see transactions & payer names" />
          <Toggle on={allowDep} set={setAllowDep} label="Let viewers deposit by M-Pesa" />
        </div>

        {err && <div style={{ color: C.red, fontSize: 13, marginBottom: 10 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ ...actBtn, padding: '10px 16px' }}>Cancel</button>
          <button onClick={submit} disabled={busy} style={{ background: C.amber, color: '#160F00', border: 0, borderRadius: 10, padding: '10px 18px', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>{busy ? 'Creating…' : 'Create link'}</button>
        </div>
      </div>
    </div>
  );
}

function Toggle({ on, set, label }) {
  return (
    <button onClick={() => set(!on)} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'transparent', border: 0, cursor: 'pointer', textAlign: 'left', padding: 0 }}>
      <span style={{ width: 38, height: 22, borderRadius: 999, background: on ? C.amber : '#2a3340', position: 'relative', flex: '0 0 auto', transition: 'background .15s' }}>
        <span style={{ position: 'absolute', top: 2, left: on ? 18 : 2, width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'left .15s' }} />
      </span>
      <span style={{ fontSize: 13.5, color: C.text }}>{label}</span>
    </button>
  );
}

const iconBtn = { background: 'transparent', border: 0, color: C.muted, cursor: 'pointer', padding: 4, display: 'inline-flex' };
const actBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', border: `1px solid ${C.line}`, color: C.text, borderRadius: 9, padding: '8px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const lbl = { display: 'block', fontSize: 12.5, fontWeight: 600, color: C.muted, margin: '10px 0 6px' };
const inp = { width: '100%', background: C.ink, border: `1px solid ${C.line}`, borderRadius: 9, padding: '11px 12px', color: C.text, fontSize: 14, boxSizing: 'border-box' };
