import { useState, useEffect } from 'react';
import api from '../services/api';
import { SPK_CSS } from './trackerTheme';

const fmtU = n => { const v = Number(n) || 0; if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'; if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K'; return Math.round(v).toLocaleString(); };

export default function MarketActivity({ enabled }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);
  const [filter, setFilter] = useState('all');   // 'all' | 'gold' | 'silver' | 'bronze'

  const load = async () => {
    setLoading(true); setErr('');
    try { const r = await api.get('/traders/market-activity'); setData(r.data); setUpdatedAt(Date.now()); }
    catch (e) { setErr(e.response?.data?.detail || 'Could not load market activity.'); }
    setLoading(false);
  };
  useEffect(() => { if (!enabled) return; load(); const id = setInterval(load, 60000); return () => clearInterval(id); /* eslint-disable-next-line */ }, [enabled]);
  if (!enabled) return null;

  const upd = new Date(updatedAt || Date.now()).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const partial = data && data.incomplete_day;

  const TIER_COLOR = { gold: '#FFBE52', silver: '#D6DBE2', bronze: '#F08A3C' };
  const allowedTiers = (data?.allowed_tiers || ['gold', 'silver', 'bronze']).filter(t => t !== 'normal');
  const byTier = data?.by_tier || {};
  // Traded / liquidity / active-merchant cards follow the tier filter; spread cards stay market-wide.
  const bt = filter !== 'all' ? (byTier[filter] || { traded: 0, bought: 0, sold: 0, avail: 0, online: 0 }) : null;
  const tradedV = bt ? bt.traded : (data?.total_vol || 0);
  const boughtV = bt ? bt.bought : (data?.bought_vol || 0);
  const soldV = bt ? bt.sold : (data?.sold_vol || 0);
  const liqV = bt ? bt.avail : (data?.buy_liq_now || 0);
  const activeV = bt ? bt.online : (data?.active_merchants ?? 0);
  const shownMerchants = data ? (filter === 'all' ? (data.merchants || []) : (data.merchants || []).filter(m => m.tier === filter)) : [];

  const stats = data ? [
    { l: 'Est. USDT Traded (today)', v: fmtU(tradedV), c: 'amber', hl: true, extra: <><span className="chg-dn">▼ {fmtU(boughtV)} bought</span> &nbsp; <span className="chg-up">▲ {fmtU(soldV)} sold</span></> },
    { l: 'Avg Maker Spread', v: data.avg_spread != null ? `KES ${data.avg_spread.toFixed(2)}` : '—', s: data.spread_pct != null ? `${data.spread_pct.toFixed(2)}% of price` : 'building…' },
    { l: 'Spread Range', v: data.min_spread != null ? `${data.min_spread.toFixed(2)}–${data.max_spread.toFixed(2)}` : '—', s: 'KES / USDT' },
    { l: 'Liquidity Now', v: <span className="green">{fmtU(liqV)}</span>, s: 'USDT for sale' },
    { l: 'Active Merchants', v: String(activeV ?? '—'), s: filter === 'all' ? (data.new_merchants != null ? `+${data.new_merchants} new today` : 'new-count from 3am') : `${filter} tier only` },
  ] : [];

  return (
    <div className="spk">
      <style>{SPK_CSS}</style>
      <div className="panel">
        <div className="page-head">
          <div>
            <div className="ttl"><span className="hi"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 19V9M10 19V5M16 19v-7M21 19H3" /></svg></span>Market Activity</div>
            <div className="sub">Today · since 3:00 AM EAT · USDT/KES · estimated from order-book flow{updatedAt ? ` · updated ${upd}` : ''}</div>
          </div>
          <div className="right"><button className="btn-refresh" onClick={load} disabled={loading}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }}><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" /></svg>Refresh</button></div>
        </div>

        {err ? <div className="empty-line" style={{ color: '#ff6b6b' }}>{err}</div> : !data ? <div className="empty-line">Loading market activity…</div> : (
          <>
            <div className="insight" style={{ marginBottom: 22, background: 'var(--card)' }}>
              <span className="ii" style={{ background: 'var(--blue-soft)', color: 'var(--blue-2)' }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v4h1" /></svg></span>
              <span><b>Volume is an estimate:</b> Binance doesn't publish merchants' balances or trades, so we infer fills from drops in advertised quantity across all ads. Spoof ads and relist/edit spikes are filtered out. Totals reset daily at <b>3:00 AM EAT</b>.{partial && <> Tracking started after today's reset, so today's totals cover the last <b>{data.tracked_hours}h</b> only.</>}</span>
            </div>

            {allowedTiers.length > 1 && (
              <div style={{ display: 'flex', gap: 8, margin: '0 0 18px', flexWrap: 'wrap' }}>
                {['all', ...allowedTiers].map(t => {
                  const on = filter === t; const col = t === 'all' ? '#FFBE52' : TIER_COLOR[t];
                  return (
                    <button key={t} onClick={() => setFilter(t)}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 15px', borderRadius: 999, cursor: 'pointer',
                        border: `1px solid ${on ? col : 'var(--line)'}`, background: on ? `${col}22` : 'var(--card)',
                        color: on ? col : 'var(--text-2)', fontSize: 12.5, fontWeight: 700, letterSpacing: 0.3 }}>
                      {t !== 'all' && <span style={{ width: 8, height: 8, borderRadius: '50%', background: TIER_COLOR[t] }} />}
                      {t === 'all' ? 'All merchants' : t[0].toUpperCase() + t.slice(1)}
                    </button>
                  );
                })}
              </div>
            )}

            <div className="stats s5">
              {stats.map((x, i) => (
                <div className={`stat${x.hl ? ' hl' : ''}`} key={i}>
                  <div className="sl">{x.l}</div>
                  <div className={`sv ${x.c || ''}`}>{x.v}</div>
                  <div className="ss">{x.extra || x.s || ''}</div>
                </div>
              ))}
            </div>

            <div className="section-h">Merchant flow — top movers (today, estimated)</div>
            <div className="tbl-wrap"><table>
              <thead><tr><th className="l">Merchant</th><th>Est. Traded</th><th>Bought</th><th>Sold</th><th>Avail Now</th><th>Avg Spread</th></tr></thead>
              <tbody>
                {(shownMerchants.length === 0)
                  ? <tr><td className="l" colSpan="6" style={{ textAlign: 'center', color: 'var(--text-3)' }}>No fills observed yet — give it a few minutes of tracking.</td></tr>
                  : shownMerchants.map((m, i) => (
                    <tr key={m.nick + i}>
                      <td className="l row-head"><span className="rank">{i + 1}</span> <span className="m-name" style={{ marginLeft: 8 }}>{m.nick}</span>{m.tier && m.tier !== 'normal' && <span style={{ marginLeft: 8, fontSize: 9.5, fontWeight: 800, letterSpacing: 0.4, padding: '2px 6px', borderRadius: 5, color: TIER_COLOR[m.tier], border: `1px solid ${TIER_COLOR[m.tier]}55`, textTransform: 'uppercase' }}>{m.tier}</span>}</td>
                      <td data-label="Est. Traded" className="v-traded">{fmtU(m.traded)}</td>
                      <td data-label="Bought" className="v-bought">{m.bought ? fmtU(m.bought) : <span className="muted">—</span>}</td>
                      <td data-label="Sold" className="v-sold">{m.sold ? fmtU(m.sold) : <span className="muted">—</span>}</td>
                      <td data-label="Avail Now">{m.avail ? fmtU(m.avail) : <span className="muted">0</span>}</td>
                      <td data-label="Avg Spread" title="Volume-weighted avg sell price − avg buy price today (needs fills on both sides)" style={{ color: m.spread == null ? 'var(--text-3)' : m.spread < 0 ? '#ef6a7e' : 'var(--green-2)', fontWeight: 600 }}>{m.spread == null ? '—' : `KES ${m.spread.toFixed(2)}`}</td>
                    </tr>
                  ))}
              </tbody>
            </table></div>
            <div className="footnote">“Est. traded” = USDT inferred filled from drops in this merchant's advertised quantity. “Avail Now” = USDT they currently have listed for sale (updates in real time as they sell or restock). “Avg Spread” = their volume-weighted average sell price minus average buy price today (KES/USDT) — an estimate of their daily margin; shown only when they've filled on both sides.</div>
          </>
        )}
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
