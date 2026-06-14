import { useState, useEffect, useRef } from 'react';
import api from '../services/api';
import { SPK_CSS } from './trackerTheme';

const fmtU = n => { const v = Number(n) || 0; if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'; if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K'; return Math.round(v).toLocaleString(); };
const ROT_OPTS = [5, 10, 15, 30, 60];
const FEATS = [
  { p: 'M12 2 4 6v6c0 5 3.5 8 8 10 4.5-2 8-5 8-10V6z', t: 'Hold the top slots', d: 'Members stay clustered at the front of the book together.' },
  { p: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5', t: 'Rotate #1 fairly', d: 'The bot cycles the lead position every few minutes.' },
  { p: 'M4 19V9M10 19V5M16 19v-7M21 19H3', t: 'Protect your margin', d: 'Never repriced below the floor you set for the team.' },
];

export default function SquadPanel({ enabled }) {
  const [data, setData] = useState(null);
  const [sim, setSim] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [createName, setCreateName] = useState('');
  const [inviteId, setInviteId] = useState('');
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState(null);
  const [countdown, setCountdown] = useState(null);
  const cdRef = useRef(null);

  const loadMe = async () => {
    try {
      const r = await api.get('/squads/me'); setData(r.data);
      if (r.data.squad && !form) { const s = r.data.squad; setForm({ mode: s.mode, rotation_minutes: s.rotation_minutes, margin_min: s.margin_min || '', margin_max: s.margin_max || '', side_mode: s.side_mode, volume_gate_pct: s.volume_gate_pct || 1.1, max_gap: s.max_gap || 0.08 }); }
    } catch (e) { setErr(e.response?.data?.detail || 'Could not load squad.'); }
  };
  const loadSim = async () => { try { const r = await api.get('/squads/simulation'); setSim(r.data); if (r.data?.rotation?.next_in_sec != null) setCountdown(r.data.rotation.next_in_sec); } catch (_) { setSim(null); } };

  useEffect(() => { if (enabled) loadMe(); /* eslint-disable-next-line */ }, [enabled]);
  useEffect(() => { if (!data?.squad) { setSim(null); return; } loadSim(); const id = setInterval(loadSim, 30000); return () => clearInterval(id); /* eslint-disable-next-line */ }, [data?.squad?.id]);
  useEffect(() => { if (countdown == null) return; clearInterval(cdRef.current); cdRef.current = setInterval(() => setCountdown(c => (c == null ? c : Math.max(0, c - 1))), 1000); return () => clearInterval(cdRef.current); }, [countdown != null]);

  if (!enabled) return null;

  const act = async (fn) => { setBusy(true); setMsg(''); try { await fn(); await loadMe(); await loadSim(); } catch (e) { setMsg(e.response?.data?.detail || 'Action failed'); } setBusy(false); };
  const create = () => act(async () => { await api.post('/squads/create', { name: createName.trim() }); setCreateName(''); });
  const invite = () => act(async () => { const r = await api.post('/squads/invite', { identifier: inviteId.trim() }); setInviteId(''); setMsg(r.data.telegram_delivered ? `Invite sent to ${r.data.name} on Telegram ✓` : `${r.data.name} invited — they haven't linked Telegram; they can accept in their app.`); });
  const respond = (squad_id, accept) => act(async () => { await api.post('/squads/respond', { squad_id, accept }); });
  const leave = () => { if (window.confirm(data.role === 'captain' ? 'Disband this squad for everyone?' : 'Leave this squad?')) act(async () => { await api.post('/squads/leave'); setForm(null); }); };
  const saveSettings = () => act(async () => { await api.put('/squads/settings', { mode: form.mode, rotation_minutes: Number(form.rotation_minutes), margin_min: parseFloat(form.margin_min) || 0, margin_max: parseFloat(form.margin_max) || 0, side_mode: form.side_mode, volume_gate_pct: parseFloat(form.volume_gate_pct) || 1.1, max_gap: parseFloat(form.max_gap) || 0.08 }); setMsg('Saved ✓'); });

  const squad = data?.squad;
  const isCap = data?.role === 'captain';
  const mmss = s => s == null ? '—' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const yn = v => v ? <span className="ok">✓</span> : <span className="bad">✗</span>;

  return (
    <div className="spk">
      <style>{SPK_CSS}</style>
      <div className="panel">
        <div className="page-head">
          <div>
            <div className="ttl"><span className="hi"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0M16 3.5a3 3 0 0 1 0 6" /></svg></span>Squad — coordinated team pricing</div>
            <div className="sub">Trade as a team · hold the top slots · rotate #1 fairly · never below your margin floor</div>
          </div>
          {squad && <div className="right"><button className="btn-refresh" onClick={() => { loadMe(); loadSim(); }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" /></svg>Refresh</button></div>}
        </div>

        {err && <div className="empty-line" style={{ color: '#ff6b6b' }}>{err}</div>}

        {data?.invites?.length > 0 && data.invites.map(iv => (
          <div className="invite-row" key={iv.squad_id}>
            <span><b>{iv.captain_name}</b> invited you to join squad “<b>{iv.name}</b>”.</span>
            <span className="ib"><button className="btn-create" disabled={busy} onClick={() => respond(iv.squad_id, true)} style={{ padding: '8px 16px' }}>Accept</button><button className="btn-soft" disabled={busy} onClick={() => respond(iv.squad_id, false)}>Decline</button></span>
          </div>
        ))}

        {!squad ? (
          <div className="squad-card">
            <h3>Create a squad</h3>
            <p>Form a team of verified merchants, invite them by phone or email (they <b>tap Accept on Telegram</b> to join), and the bot will keep you all in the top slots — rotating #1 every few minutes and protecting your margin. <b>Each member must be a verified Binance merchant with their API connected and their desktop app (relay) running.</b></p>
            <div className="squad-form">
              <input placeholder="Squad name (e.g. RULU Team)" value={createName} onChange={e => setCreateName(e.target.value)} />
              <button className="btn-create" disabled={busy || !createName.trim()} onClick={create}>Create squad</button>
            </div>
            {msg && <div className="save-msg" style={{ marginLeft: 0, marginTop: 12, display: 'block' }}>{msg}</div>}
            <div className="squad-features">
              {FEATS.map((f, i) => <div className="feat" key={i}><span className="fi"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d={f.p} /></svg></span><div><div className="ft">{f.t}</div><div className="fd">{f.d}</div></div></div>)}
            </div>
          </div>
        ) : (
          <>
            <div className="squad-card">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>{squad.name} <span className={`mode-tag mode-${squad.mode}`}>{squad.mode === 'live' ? 'LIVE' : squad.mode === 'sim' ? 'SIMULATING' : 'OFF'}</span></h3>
              <div className="srow head"><span>Member</span><span>Binance name</span><span className="r hide-sm">Verified</span><span className="r hide-sm">API</span><span className="r">Relay</span><span className="r">Status</span></div>
              {data.members.map(m => (
                <div className="srow" key={m.trader_id}>
                  <span>{m.name}{m.is_captain && <span className="mode-tag mode-sim" style={{ marginLeft: 8 }}>CAPTAIN</span>}</span>
                  <span>{m.nick || <span className="muted">— not detected —</span>}</span>
                  <span className="r hide-sm">{yn(m.verified)}</span>
                  <span className="r hide-sm">{yn(m.has_api)}</span>
                  <span className="r">{m.relay_online ? <span className="ok">● online</span> : <span className="bad">○ offline</span>}</span>
                  <span className="r">{m.status === 'invited' ? <span className="muted">invited…</span> : <span className="ok">active</span>}</span>
                </div>
              ))}
              <div className="squad-form" style={{ marginTop: 16 }}>
                {isCap && <input placeholder="Invite by phone number or email — they accept on Telegram…" value={inviteId} onChange={e => setInviteId(e.target.value)} />}
                {isCap && <button className="btn-create" disabled={busy || !inviteId.trim()} onClick={invite}>Invite</button>}
                <button className="btn-soft" disabled={busy} onClick={leave} style={{ color: '#ef6a7e' }}>{isCap ? 'Disband' : 'Leave squad'}</button>
              </div>
              {msg && <div className="save-msg" style={{ marginLeft: 0, marginTop: 12, display: 'block' }}>{msg}</div>}
            </div>

            {isCap && form && (
              <div className="squad-card" style={{ marginTop: 16 }}>
                <h3>Targets &amp; protection</h3>
                <div className="grid-2">
                  <div><div className="flabel" style={{ marginTop: 0 }}>Mode</div><select className="sel" value={form.mode} onChange={e => setForm({ ...form, mode: e.target.value })}><option value="off">Off</option><option value="sim">Simulate (preview only)</option><option value="live">Live — change real prices</option></select></div>
                  <div><div className="flabel" style={{ marginTop: 0 }}>Coordinate sides</div><select className="sel" value={form.side_mode} onChange={e => setForm({ ...form, side_mode: e.target.value })}><option value="both">Both buy &amp; sell</option><option value="sell">Sell-USDT only</option><option value="buy">Buy-USDT only</option></select></div>
                  <div><div className="flabel">Rotate #1 every</div><select className="sel" value={form.rotation_minutes} onChange={e => setForm({ ...form, rotation_minutes: e.target.value })}>{ROT_OPTS.map(o => <option key={o} value={o}>{o} min</option>)}</select></div>
                  <div><div className="flabel">Contest if outsider bigger by ×</div><input className="minp" type="number" step="0.05" value={form.volume_gate_pct} onChange={e => setForm({ ...form, volume_gate_pct: e.target.value })} /></div>
                  <div><div className="flabel">Min margin (KES/USDT)</div><input className="minp" type="number" step="0.01" value={form.margin_min} onChange={e => setForm({ ...form, margin_min: e.target.value })} /></div>
                  <div><div className="flabel">Max margin (KES/USDT)</div><input className="minp" type="number" step="0.01" value={form.margin_max} onChange={e => setForm({ ...form, margin_max: e.target.value })} /></div>
                </div>
                {form.mode === 'live' && <div className="note" style={{ color: 'var(--amber-2)', marginTop: 14 }}>⚠ Live changes real Binance ad prices for every online member, within the margin band, never below min. Each push routes through their own relay/IP; needs ≥2 verified members with relay online. Confirm coordinated pricing is acceptable with Binance merchant support first.</div>}
                <button className="btn-primary" disabled={busy} onClick={saveSettings}>Save settings</button>{msg && <span className="save-msg">{msg}</span>}
              </div>
            )}

            {sim && (
              <div className="squad-card" style={{ marginTop: 16 }}>
                <h3 style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>Live plan <span className={`mode-tag mode-${sim.mode}`}>{sim.mode === 'live' ? 'LIVE — changing real prices' : sim.mode === 'sim' ? 'SIMULATING' : 'PREVIEW'}</span><span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)' }}>🔄 every {sim.rotation?.minutes}m · next in {mmss(countdown)}</span></h3>
                {sim.missing_nicks?.length > 0 && <div className="note" style={{ color: 'var(--amber-2)' }}>⚠ Binance name not detected for: {sim.missing_nicks.join(', ')}. They can't be positioned until they detect their name on the Price Tracker.</div>}
                {['sell', 'buy'].map(side => sim[side] && (
                  <div key={side} style={{ marginTop: 16 }}>
                    <div className="flabel" style={{ margin: '0 0 8px', color: side === 'sell' ? 'var(--green-2)' : 'var(--blue-2)' }}>{side === 'sell' ? 'Sell-USDT (your sell ads)' : 'Buy-USDT (your buy ads)'} · {sim[side].k} live</div>
                    <div className={`gate ${sim[side].contest ? 'on' : 'off'}`}>{sim[side].contest ? '⚔️ ' : '🛡️ '}{sim[side].gate_reason}{sim[side].top_intruder && <span className="muted"> (top outsider {sim[side].top_intruder.nick} @ {sim[side].top_intruder.price}, {fmtU(sim[side].top_intruder.available)} USDT)</span>}</div>
                    {sim[side].leader_nick && <div className="note">👑 #1 now: <b style={{ color: 'var(--text)' }}>{sim[side].leader_nick}</b> · margin band KES {sim[side].band.min_price}–{sim[side].band.max_price}</div>}
                    <div className="srow head" style={{ marginTop: 8 }}><span>Slot</span><span>Member</span><span className="r hide-sm">Now</span><span className="r">Target</span><span className="r">Margin</span></div>
                    {[...sim[side].members].sort((a, b) => (a.target_slot || 99) - (b.target_slot || 99)).map(m => (
                      <div className="srow" key={m.trader_id} style={!m.online ? { opacity: .5 } : undefined}>
                        <span>{m.online ? `#${m.target_slot}` : '—'}</span>
                        <span>{m.nick || m.name}</span>
                        <span className="r hide-sm">{m.online ? `#${m.current_rank} · ${m.current_price?.toFixed(2)}` : <span className="muted">no ad</span>}</span>
                        <span className="r" style={{ fontWeight: 800, color: 'var(--amber-2)' }}>{m.online ? m.target_price?.toFixed(2) : '—'}</span>
                        <span className="r" style={{ color: m.online ? (m.target_margin >= 0 ? 'var(--green-2)' : '#ef6a7e') : 'var(--text-3)' }}>{m.online ? m.target_margin?.toFixed(2) : '—'}</span>
                      </div>
                    ))}
                  </div>
                ))}
                <div className="footnote" style={{ textAlign: 'left' }}>{sim.mode === 'live' ? 'LIVE — real prices are adjusted within your margin band (never below min). Each push routes through that member\'s own relay/IP; offline members are skipped and the block resizes.' : 'Preview only — no prices are changed. Members with no live ad are skipped and the block resizes to whoever is online.'}</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
