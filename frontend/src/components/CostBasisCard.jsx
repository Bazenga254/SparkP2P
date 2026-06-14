import { useState, useEffect } from 'react';
import api from '../services/api';

// Cost-basis sell-down readout (Phase 1 — display + input only). See docs/cost-basis-mode.md.
const fmtU = n => Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 0 });

export default function CostBasisCard() {
  const [cb, setCb] = useState(null);
  const [stock, setStock] = useState('');
  const [cost, setCost] = useState('');
  const [buffer, setBuffer] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = async () => {
    try {
      const r = await api.get('/traders/cost-basis'); setCb(r.data);
      setStock(r.data.starting_stock ? String(r.data.starting_stock) : '');
      setCost(r.data.starting_cost ? String(r.data.starting_cost) : '');
      setBuffer(r.data.cleared_buffer != null ? String(r.data.cleared_buffer) : '');
    } catch (_) { setCb(null); }
  };
  useEffect(() => { load(); const id = setInterval(load, 60000); return () => clearInterval(id); }, []);

  const save = async (patch, ok) => {
    setBusy(true); setMsg('');
    try { const r = await api.put('/traders/cost-basis', patch); setCb(r.data); if (ok) setMsg(ok); }
    catch (e) { setMsg(e.response?.data?.detail || 'Save failed'); }
    setBusy(false);
  };

  if (!cb) return null;
  const phaseTag = cb.phase === 'selldown'
    ? <span className="mode-tag mode-sim">SELLING DOWN</span>
    : cb.phase === 'roundtrip'
      ? <span className="mode-tag mode-live">ROUND-TRIP</span>
      : <span className="mode-tag mode-off">OFF</span>;

  return (
    <div className="panel panel-gap">
      <div className="panel-head">
        <div className="ph-t"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7h18v13H3zM3 7l3-4h12l3 4M9 11a3 3 0 0 0 6 0" /></svg>Stock &amp; cost basis</div>
        {phaseTag}
      </div>

      <label className="chk"><input type="checkbox" checked={cb.enabled} onChange={e => save({ enabled: e.target.checked })} disabled={busy} />Protect my margin — never price my sell ad below what I paid for the coins</label>

      {cb.enabled && (
        <>
          <div className="sim-grid" style={{ marginTop: 16 }}>
            <div className="sim"><div className="sl">Held USDT</div><div className="sv amber">{fmtU(cb.inventory)}</div><div className="sim-sub">{cb.inventory > cb.cleared_buffer ? 'still selling down' : 'stock cleared'}</div></div>
            <div className="sim"><div className="sl">Avg cost</div><div className="sv">{cb.avg_cost ? `KES ${cb.avg_cost.toFixed(2)}` : '—'}</div><div className="sim-sub">weighted average</div></div>
            <div className="sim"><div className="sl">Sell floor</div><div className="sv green">{cb.sell_floor ? cb.sell_floor.toFixed(2) : '—'}</div><div className="sim-sub">avg cost + min margin</div></div>
            <div className="sim"><div className="sl">Phase</div><div className={`sv ${cb.phase === 'selldown' ? 'amber' : 'green'}`}>{cb.phase === 'selldown' ? 'Sell-down' : 'Round-trip'}</div><div className="sim-sub">{cb.phase === 'selldown' ? 'clearing existing stock' : 'buy low / sell high'}</div></div>
          </div>

          <div className="flabel">Your current stock (one-time — it auto-tracks after)</div>
          <div className="margin-grid">
            <div><div className="flabel" style={{ marginTop: 0 }}>USDT you're holding now</div><input className="minp" type="number" step="1" placeholder="e.g. 2000" value={stock} onChange={e => setStock(e.target.value)} /></div>
            <div><div className="flabel" style={{ marginTop: 0 }}>Avg price you paid (KES/USDT)</div><input className="minp" type="number" step="0.01" placeholder="e.g. 129.40" value={cost} onChange={e => setCost(e.target.value)} /></div>
          </div>
          <div className="margin-grid" style={{ marginTop: 12 }}>
            <div><div className="flabel" style={{ marginTop: 0 }}>“Cleared” when below (USDT)</div><input className="minp" type="number" step="1" placeholder="50" value={buffer} onChange={e => setBuffer(e.target.value)} /></div>
            <div style={{ display: 'flex', alignItems: 'flex-end' }}><button className="btn-primary" style={{ marginTop: 0 }} disabled={busy} onClick={() => save({ starting_stock: parseFloat(stock) || 0, starting_cost: parseFloat(cost) || 0, cleared_buffer: parseFloat(buffer) || 50 }, 'Saved ✓')}>Set my stock</button>{msg && <span className="save-msg">{msg}</span>}</div>
          </div>
          <div className="note" style={{ marginTop: 12 }}>While you hold stock, the bot will sell it down first at <b style={{ color: 'var(--text)' }}>≥ your cost + min margin</b> (so you never resume at a loss), then switch to the advanced buy-low/sell-high pricing once cleared. The held figure updates automatically as you trade. <i>(Tracking &amp; readout are live now; automatic price-flooring goes live in the next step.)</i></div>
        </>
      )}
    </div>
  );
}
