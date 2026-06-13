import { useState, useEffect, useRef } from 'react';
import { Users, RefreshCw } from 'lucide-react';
import api from '../services/api';

// Squad Mode — Phase A (simulation only). See docs/squad-mode.md.
const fmtU = n => {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return Math.round(v).toLocaleString();
};
const ROT_OPTS = [5, 10, 15, 30, 60];

export default function SquadPanel({ enabled }) {
  const [data, setData] = useState(null);
  const [sim, setSim] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [createName, setCreateName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState(null);
  const [countdown, setCountdown] = useState(null);
  const cdRef = useRef(null);

  const loadMe = async () => {
    try {
      const r = await api.get('/squads/me');
      setData(r.data);
      if (r.data.squad && !form) {
        const s = r.data.squad;
        setForm({ mode: s.mode, rotation_minutes: s.rotation_minutes, margin_min: s.margin_min || '', margin_max: s.margin_max || '', side_mode: s.side_mode, volume_gate_pct: s.volume_gate_pct || 1.1, max_gap: s.max_gap || 0.08 });
      }
    } catch (e) { setErr(e.response?.data?.detail || 'Could not load squad.'); }
  };
  const loadSim = async () => {
    try { const r = await api.get('/squads/simulation'); setSim(r.data); if (r.data?.rotation?.next_in_sec != null) setCountdown(r.data.rotation.next_in_sec); }
    catch (_) { setSim(null); }
  };

  useEffect(() => {
    if (!enabled) return;
    loadMe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  useEffect(() => {
    if (!data?.squad) { setSim(null); return; }
    loadSim();
    const id = setInterval(loadSim, 30000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.squad?.id]);

  useEffect(() => {
    if (countdown == null) return;
    clearInterval(cdRef.current);
    cdRef.current = setInterval(() => setCountdown(c => (c == null ? c : Math.max(0, c - 1))), 1000);
    return () => clearInterval(cdRef.current);
  }, [countdown != null]);

  if (!enabled) return null;

  const act = async (fn) => { setBusy(true); setMsg(''); try { await fn(); await loadMe(); await loadSim(); } catch (e) { setMsg(e.response?.data?.detail || 'Action failed'); } setBusy(false); };
  const create = () => act(async () => { await api.post('/squads/create', { name: createName.trim() }); setCreateName(''); });
  const invite = () => act(async () => { const r = await api.post('/squads/invite', { identifier: inviteEmail.trim() }); setInviteEmail(''); setMsg(r.data.telegram_delivered ? `Invite sent to ${r.data.name} on Telegram ✓` : `${r.data.name} invited — but they haven't linked Telegram; they can accept in their app.`); });
  const respond = (squad_id, accept) => act(async () => { await api.post('/squads/respond', { squad_id, accept }); });
  const leave = () => { if (window.confirm(data.role === 'captain' ? 'Disband this squad for everyone?' : 'Leave this squad?')) act(async () => { await api.post('/squads/leave'); setForm(null); }); };
  const saveSettings = () => act(async () => {
    await api.put('/squads/settings', { mode: form.mode, rotation_minutes: Number(form.rotation_minutes), margin_min: parseFloat(form.margin_min) || 0, margin_max: parseFloat(form.margin_max) || 0, side_mode: form.side_mode, volume_gate_pct: parseFloat(form.volume_gate_pct) || 1.1, max_gap: parseFloat(form.max_gap) || 0.08 });
    setMsg('Saved ✓');
  });

  const squad = data?.squad;
  const isCap = data?.role === 'captain';
  const mmss = s => s == null ? '—' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  return (
    <div className="sq-root">
      <style>{SQ_CSS}</style>
      <div className="sq-head">
        <div>
          <h1><Users size={18} style={{ color: '#f5a623' }} /> Squad — coordinated team pricing</h1>
          <div className="sq-meta">Trade as a team · hold the top slots · rotate #1 fairly · never below your margin floor</div>
        </div>
        {squad && <button className="sq-refresh" onClick={() => { loadMe(); loadSim(); }}><RefreshCw size={14} /> Refresh</button>}
      </div>

      {err && <div className="sq-state sq-err">{err}</div>}

      {/* Pending invites */}
      {data?.invites?.length > 0 && (
        <div className="sq-invites">
          {data.invites.map(iv => (
            <div key={iv.squad_id} className="sq-invite">
              <span><strong>{iv.captain_name}</strong> invited you to join squad “<strong>{iv.name}</strong>”.</span>
              <span className="sq-invite-btns">
                <button className="sq-btn sq-yes" disabled={busy} onClick={() => respond(iv.squad_id, true)}>Accept</button>
                <button className="sq-btn sq-no" disabled={busy} onClick={() => respond(iv.squad_id, false)}>Decline</button>
              </span>
            </div>
          ))}
        </div>
      )}

      {!squad ? (
        <div className="sq-card">
          <div className="sq-card-h">Create a squad</div>
          <p className="sq-note">Form a team of verified merchants, invite them by phone or email (they <strong>tap Accept on Telegram</strong> to join), and the bot will keep you all in the top slots — rotating #1 every few minutes and protecting your margin. <strong>Each member must be a verified Binance merchant with their API connected and their desktop app (relay) running.</strong></p>
          <div className="sq-row">
            <input className="sq-input" placeholder="Squad name (e.g. RULU Team)" value={createName} onChange={e => setCreateName(e.target.value)} />
            <button className="sq-btn sq-primary" disabled={busy || !createName.trim()} onClick={create}>Create squad</button>
          </div>
          {msg && <div className="sq-msg">{msg}</div>}
        </div>
      ) : (
        <>
          {/* Roster */}
          <div className="sq-card">
            <div className="sq-card-h">{squad.name} · <span className={`sq-mode sq-mode-${squad.mode}`}>{squad.mode === 'sim' ? 'SIMULATING' : squad.mode === 'live' ? 'LIVE' : 'OFF'}</span></div>
            <table className="sq-table">
              <thead><tr><th>Member</th><th>Binance name</th><th>Verified</th><th>API</th><th>Relay</th><th>Status</th></tr></thead>
              <tbody>
                {data.members.map(m => (
                  <tr key={m.trader_id}>
                    <td>{m.name}{m.is_captain && <span className="sq-cap">CAPTAIN</span>}</td>
                    <td>{m.nick || <span className="sq-dim">— not detected —</span>}</td>
                    <td>{m.verified ? <span className="sq-ok">✓</span> : <span className="sq-bad">✗</span>}</td>
                    <td>{m.has_api ? <span className="sq-ok">✓</span> : <span className="sq-bad">✗</span>}</td>
                    <td>{m.relay_online ? <span className="sq-ok">● online</span> : <span className="sq-bad">○ offline</span>}</td>
                    <td>{m.status === 'invited' ? <span className="sq-dim">invited…</span> : <span className="sq-ok">active</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {isCap && (
              <div className="sq-row" style={{ marginTop: 12 }}>
                <input className="sq-input" placeholder="Invite by phone number or email — they accept on Telegram…" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} />
                <button className="sq-btn sq-primary" disabled={busy || !inviteEmail.trim()} onClick={invite}>Invite</button>
                <button className="sq-btn sq-no" disabled={busy} onClick={leave}>Disband</button>
              </div>
            )}
            {!isCap && <div className="sq-row" style={{ marginTop: 12 }}><button className="sq-btn sq-no" disabled={busy} onClick={leave}>Leave squad</button></div>}
            {msg && <div className="sq-msg">{msg}</div>}
          </div>

          {/* Captain settings */}
          {isCap && form && (
            <div className="sq-card">
              <div className="sq-card-h">Targets &amp; protection</div>
              <div className="sq-grid">
                <label>Mode
                  <select value={form.mode} onChange={e => setForm({ ...form, mode: e.target.value })}>
                    <option value="off">Off</option>
                    <option value="sim">Simulate (preview only)</option>
                    <option value="live">Live — change real prices</option>
                  </select>
                </label>
                <label>Coordinate sides
                  <select value={form.side_mode} onChange={e => setForm({ ...form, side_mode: e.target.value })}>
                    <option value="both">Both buy &amp; sell</option>
                    <option value="sell">Sell-USDT only</option>
                    <option value="buy">Buy-USDT only</option>
                  </select>
                </label>
                <label>Rotate #1 every
                  <select value={form.rotation_minutes} onChange={e => setForm({ ...form, rotation_minutes: e.target.value })}>
                    {ROT_OPTS.map(o => <option key={o} value={o}>{o} min</option>)}
                  </select>
                </label>
                <label>Min margin (KES/USDT)
                  <input type="number" step="0.01" min="0" placeholder="e.g. 0.30" value={form.margin_min} onChange={e => setForm({ ...form, margin_min: e.target.value })} />
                </label>
                <label>Max margin (KES/USDT)
                  <input type="number" step="0.01" min="0" placeholder="e.g. 0.60" value={form.margin_max} onChange={e => setForm({ ...form, margin_max: e.target.value })} />
                </label>
                <label>Contest if outsider bigger by ×
                  <input type="number" step="0.05" min="1" placeholder="1.10" value={form.volume_gate_pct} onChange={e => setForm({ ...form, volume_gate_pct: e.target.value })} />
                </label>
                <label>Max gap between slots (KES)
                  <input type="number" step="0.01" min="0.01" placeholder="0.08" value={form.max_gap} onChange={e => setForm({ ...form, max_gap: e.target.value })} />
                </label>
              </div>
              {form.mode === 'live' && (
                <div className="sq-warn" style={{ marginTop: 12 }}>
                  ⚠ <strong>Live changes real Binance ad prices</strong> for every online member, within the margin band, never below your min margin. Each member's push routes through their own relay/IP. Needs ≥2 verified members with their relay online; offline members are skipped and the block resizes. Confirm coordinated pricing is acceptable with Binance merchant support before relying on it.
                </div>
              )}
              <button className="sq-btn sq-primary" style={{ marginTop: 12 }} disabled={busy} onClick={saveSettings}>Save settings</button>
            </div>
          )}

          {/* Simulation plan */}
          {sim && (
            <div className="sq-card">
              <div className="sq-card-h">Live plan {sim.mode === 'live' ? '(LIVE — changing real prices)' : sim.mode === 'sim' ? '(simulating)' : '(preview — set mode to Simulate or Live)'}</div>
              {sim.missing_nicks?.length > 0 && (
                <div className="sq-warn">⚠ Binance name not detected for: {sim.missing_nicks.join(', ')}. They can't be positioned until they detect their name on the Price Tracker.</div>
              )}
              <div className="sq-rot">
                🔄 Rotation every {sim.rotation?.minutes}m · next in <strong>{mmss(countdown)}</strong>
              </div>
              {['sell', 'buy'].map(side => sim[side] && (
                <div key={side} className="sq-side">
                  <div className="sq-side-h" style={{ color: side === 'sell' ? '#34c759' : '#4a9eff' }}>
                    {side === 'sell' ? 'Sell-USDT (your sell ads)' : 'Buy-USDT (your buy ads)'} · {sim[side].k} live
                  </div>
                  <div className={`sq-gate ${sim[side].contest ? 'sq-gate-on' : 'sq-gate-off'}`}>
                    {sim[side].contest ? '⚔️ ' : '🛡️ '}{sim[side].gate_reason}
                    {sim[side].top_intruder && <span className="sq-dim"> (top outsider {sim[side].top_intruder.nick} @ {sim[side].top_intruder.price}, {fmtU(sim[side].top_intruder.available)} USDT)</span>}
                  </div>
                  {sim[side].leader_nick && <div className="sq-leader">👑 #1 now: <strong>{sim[side].leader_nick}</strong> · margin band KES {sim[side].band.min_price}–{sim[side].band.max_price}</div>}
                  <table className="sq-table sq-plan">
                    <thead><tr><th>Slot</th><th>Member</th><th className="sq-r">Now</th><th className="sq-r">Target price</th><th className="sq-r">Margin</th></tr></thead>
                    <tbody>
                      {[...sim[side].members].sort((a, b) => (a.target_slot || 99) - (b.target_slot || 99)).map(m => (
                        <tr key={m.trader_id} className={!m.online ? 'sq-offline' : ''}>
                          <td>{m.online ? `#${m.target_slot}` : '—'}</td>
                          <td>{m.nick || m.name}</td>
                          <td className="sq-r">{m.online ? <>#{m.current_rank} · {m.current_price?.toFixed(2)}</> : <span className="sq-dim">no live ad</span>}</td>
                          <td className="sq-r sq-strong">{m.online ? m.target_price?.toFixed(2) : '—'}</td>
                          <td className="sq-r" style={{ color: m.online ? (m.target_margin >= 0 ? '#34c759' : '#ef6a7e') : '#7d848c' }}>{m.online ? m.target_margin?.toFixed(2) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
              <div className="sq-foot">{sim.mode === 'live'
                ? 'LIVE — real prices are being adjusted within your margin band (never below min). Each push routes through that member\'s own relay/IP; offline members are skipped and the block resizes.'
                : 'Preview only — no prices are changed. Members with no live ad are skipped and the block resizes to whoever is online.'}</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const SQ_CSS = `
.sq-root { --sq-border:rgba(255,255,255,0.08); --sq-card:rgba(255,255,255,0.03); --sq-dim:#7d848c; --sq-faint:#9aa0a8;
  background:#161b22; border:1px solid var(--sq-border); border-radius:12px; padding:1.5rem; color:#fff;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
.sq-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem; gap:12px; flex-wrap:wrap; }
.sq-head h1 { font-size:18px; font-weight:600; display:flex; align-items:center; gap:8px; }
.sq-meta { font-size:12px; color:var(--sq-dim); margin-top:3px; }
.sq-refresh { background:transparent; border:1px solid var(--sq-border); color:var(--sq-faint); padding:.45rem .9rem; border-radius:6px; font-size:13px; cursor:pointer; display:flex; align-items:center; gap:6px; }
.sq-card { background:var(--sq-card); border:1px solid var(--sq-border); border-radius:10px; padding:1.1rem 1.2rem; margin-bottom:1.1rem; }
.sq-card-h { font-size:14px; font-weight:700; margin-bottom:.85rem; }
.sq-note { font-size:12.5px; color:var(--sq-faint); line-height:1.55; margin:0 0 .9rem; }
.sq-row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
.sq-input { flex:1; min-width:200px; padding:.55rem .85rem; border-radius:8px; border:1px solid var(--sq-border); background:#0f1318; color:#fff; font-size:13.5px; outline:none; }
.sq-input:focus { border-color:rgba(255,255,255,0.25); }
.sq-btn { padding:.55rem 1.05rem; border-radius:8px; font-size:13px; font-weight:700; cursor:pointer; border:1px solid var(--sq-border); background:transparent; color:var(--sq-faint); }
.sq-btn:disabled { opacity:.5; cursor:default; }
.sq-primary { background:#f5a623; border-color:#f5a623; color:#0f1318; }
.sq-yes { background:#34c759; border-color:#34c759; color:#0f1318; }
.sq-no { color:#ef6a7e; border-color:rgba(239,106,126,0.4); }
.sq-msg { font-size:12.5px; color:#34c759; margin-top:.7rem; font-weight:600; }
.sq-invites { margin-bottom:1.1rem; display:flex; flex-direction:column; gap:8px; }
.sq-invite { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; background:rgba(245,166,35,0.08); border:1px solid rgba(245,166,35,0.3); border-radius:9px; padding:.7rem .95rem; font-size:13px; }
.sq-invite-btns { display:flex; gap:8px; }
.sq-table { width:100%; border-collapse:collapse; font-size:13px; }
.sq-table th { text-align:left; font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.4px; color:var(--sq-dim); padding:6px 8px; border-bottom:1px solid var(--sq-border); }
.sq-table td { padding:8px; border-bottom:1px solid rgba(255,255,255,0.04); }
.sq-table tr:last-child td { border-bottom:none; }
.sq-r { text-align:right; }
.sq-cap { font-size:9px; font-weight:800; background:#f5a623; color:#0f1318; border-radius:4px; padding:1px 5px; margin-left:6px; }
.sq-ok { color:#34c759; font-weight:700; }
.sq-bad { color:#ef6a7e; font-weight:700; }
.sq-dim { color:var(--sq-dim); }
.sq-strong { font-weight:800; color:#f5c33b; }
.sq-mode { font-size:11px; font-weight:800; padding:2px 8px; border-radius:6px; }
.sq-mode-off { background:rgba(255,255,255,0.1); color:var(--sq-faint); }
.sq-mode-sim { background:rgba(245,166,35,0.2); color:#f5a623; }
.sq-mode-live { background:rgba(52,199,89,0.2); color:#34c759; }
.sq-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
.sq-grid label { display:flex; flex-direction:column; gap:5px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.3px; color:var(--sq-dim); }
.sq-grid select, .sq-grid input { padding:.45rem .6rem; border-radius:7px; border:1px solid var(--sq-border); background:#0f1318; color:#fff; font-size:13px; font-weight:500; text-transform:none; }
.sq-warn { font-size:12px; color:#f5a623; background:rgba(245,166,35,0.07); border:1px solid rgba(245,166,35,0.25); border-radius:8px; padding:.55rem .8rem; margin-bottom:.85rem; }
.sq-rot { font-size:13px; font-weight:600; margin-bottom:1rem; color:#fff; }
.sq-side { margin-bottom:1.1rem; }
.sq-side-h { font-size:12.5px; font-weight:700; text-transform:uppercase; letter-spacing:.4px; margin-bottom:.55rem; }
.sq-gate { font-size:12.5px; padding:.5rem .8rem; border-radius:8px; margin-bottom:.5rem; line-height:1.45; }
.sq-gate-on { background:rgba(239,106,126,0.08); border:1px solid rgba(239,106,126,0.3); color:#f6c9d1; }
.sq-gate-off { background:rgba(52,199,89,0.07); border:1px solid rgba(52,199,89,0.25); color:#d6f5df; }
.sq-leader { font-size:12.5px; color:var(--sq-faint); margin-bottom:.5rem; }
.sq-plan td { padding:7px 8px; }
.sq-offline td { opacity:.5; }
.sq-foot { font-size:10.5px; color:var(--sq-dim); margin-top:.6rem; line-height:1.5; }
.sq-state { padding:18px 0; text-align:center; font-size:13px; color:var(--sq-dim); }
.sq-err { color:#ff6b6b; }
@media (max-width:760px){ .sq-grid { grid-template-columns:1fr; } }
`;
