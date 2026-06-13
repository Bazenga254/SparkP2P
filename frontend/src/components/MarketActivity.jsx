import { useState, useEffect } from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import api from '../services/api';

// 24h market-activity dashboard (admin-gated, same gate as the Price Tracker).
// Volume is ESTIMATED from order-book depletion — Binance doesn't expose competitors'
// wallet balances or executed trades, so we infer fills from drops in advertised quantity.

const fmtU = n => {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return Math.round(v).toLocaleString();
};
const fmtN = n => Number(n || 0).toLocaleString('en-KE');

export default function MarketActivity({ enabled }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);

  const load = async () => {
    setLoading(true); setErr('');
    try {
      const r = await api.get('/traders/market-activity');
      setData(r.data);
      setUpdatedAt(Date.now());
    } catch (e) {
      setErr(e.response?.data?.detail || 'Could not load market activity.');
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!enabled) return;
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  if (!enabled) return null;

  const partial = data && data.tracked_hours != null && data.tracked_hours < 24;

  return (
    <div className="ma-root">
      <style>{MA_CSS}</style>
      <div className="ma-head">
        <div>
          <h1><Activity size={18} style={{ color: '#f5a623' }} /> Market Activity</h1>
          <div className="ma-meta">
            Last 24h · USDT/KES · estimated from order-book flow{updatedAt ? ` · updated ${new Date(updatedAt).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : ''}
          </div>
        </div>
        <button className="ma-refresh" onClick={load} disabled={loading}>
          <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} /> Refresh
        </button>
      </div>

      {err ? (
        <div className="ma-state ma-err">{err}</div>
      ) : !data ? (
        <div className="ma-state">Loading market activity…</div>
      ) : (
        <>
          <div className="ma-note">
            ⓘ Volume is an <strong>estimate</strong>: Binance doesn't publish merchants' balances or trades, so we infer fills
            from drops in advertised quantity across all ads. Spoof ads and relist/edit spikes are filtered out.
            {partial && <> Tracking has run for <strong>{data.tracked_hours}h</strong> so far — figures will reach a full 24h window shortly.</>}
          </div>

          <div className="ma-kpis">
            <div className="ma-kpi ma-kpi-lg">
              <div className="ma-kpi-label">Est. USDT traded (24h)</div>
              <div className="ma-kpi-val" style={{ color: '#f5a623' }}>{fmtU(data.total_vol)}</div>
              <div className="ma-kpi-split">
                <span style={{ color: 'var(--ma-buy)' }}>▼ {fmtU(data.buy_vol)} bought</span>
                <span style={{ color: 'var(--ma-sell)' }}>▲ {fmtU(data.sell_vol)} sold</span>
              </div>
            </div>
            <div className="ma-kpi">
              <div className="ma-kpi-label">Avg maker spread</div>
              <div className="ma-kpi-val">{data.avg_spread != null ? `KES ${data.avg_spread.toFixed(2)}` : '—'}</div>
              <div className="ma-kpi-sub">{data.spread_pct != null ? `${data.spread_pct.toFixed(2)}% of price` : 'building…'}</div>
            </div>
            <div className="ma-kpi">
              <div className="ma-kpi-label">Spread range (24h)</div>
              <div className="ma-kpi-val">{data.min_spread != null ? `${data.min_spread.toFixed(2)}–${data.max_spread.toFixed(2)}` : '—'}</div>
              <div className="ma-kpi-sub">KES / USDT</div>
            </div>
            <div className="ma-kpi">
              <div className="ma-kpi-label">Liquidity now</div>
              <div className="ma-kpi-val" style={{ fontSize: 17 }}>
                <span style={{ color: 'var(--ma-buy)' }}>{fmtU(data.buy_liq_now)}</span>
                <span style={{ color: 'var(--ma-faint)' }}> / </span>
                <span style={{ color: 'var(--ma-sell)' }}>{fmtU(data.sell_liq_now)}</span>
              </div>
              <div className="ma-kpi-sub">buy offered / sell bid</div>
            </div>
            <div className="ma-kpi">
              <div className="ma-kpi-label">Active merchants</div>
              <div className="ma-kpi-val">{fmtN(data.active_merchants)}</div>
              <div className="ma-kpi-sub">{data.new_merchants != null ? `+${data.new_merchants} new in 24h` : 'new-count after 24h'}</div>
            </div>
          </div>

          <div className="ma-table-wrap">
            <div className="ma-table-h">Merchant flow — top movers (24h, estimated)</div>
            {(!data.merchants || data.merchants.length === 0) ? (
              <div className="ma-empty">No fills observed yet — give it a few minutes of tracking.</div>
            ) : (
              <table className="ma-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Merchant</th>
                    <th className="ma-r">Est. traded</th>
                    <th className="ma-r ma-hide-sm">Bought</th>
                    <th className="ma-r ma-hide-sm">Sold</th>
                    <th className="ma-r">Avail now</th>
                    <th className="ma-r">Δ 24h</th>
                  </tr>
                </thead>
                <tbody>
                  {data.merchants.map((m, i) => (
                    <tr key={m.nick + i}>
                      <td className="ma-rank">{i + 1}</td>
                      <td className="ma-nick">{m.nick}</td>
                      <td className="ma-r ma-strong">{fmtU(m.sold)}</td>
                      <td className="ma-r ma-hide-sm" style={{ color: 'var(--ma-buy)' }}>{m.buy ? fmtU(m.buy) : '—'}</td>
                      <td className="ma-r ma-hide-sm" style={{ color: 'var(--ma-sell)' }}>{m.sell ? fmtU(m.sell) : '—'}</td>
                      <td className="ma-r">{fmtU(m.avail)}</td>
                      <td className="ma-r" style={{ color: m.delta_pct == null ? 'var(--ma-faint)' : m.delta_pct < 0 ? '#ef6a7e' : 'var(--ma-buy)' }}>
                        {m.delta_pct == null ? '—' : `${m.delta_pct > 0 ? '+' : ''}${m.delta_pct}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="ma-foot">
              “Est. traded” = USDT inferred filled from drops in this merchant's advertised quantity. “Δ 24h” = change in their advertised inventory (a top-up shows positive).
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const MA_CSS = `
.ma-root {
  --ma-buy:#4a9eff; --ma-sell:#34c759; --ma-text:#fff; --ma-dim:#c4c9d0; --ma-faint:#7d848c;
  --ma-card:rgba(255,255,255,0.03); --ma-border:rgba(255,255,255,0.08); --ma-hover:rgba(255,255,255,0.05);
  background:#161b22; border:1px solid var(--ma-border); border-radius:12px; padding:1.5rem; color:var(--ma-text);
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
}
.ma-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem; }
.ma-head h1 { font-size:18px; font-weight:600; display:flex; align-items:center; gap:8px; }
.ma-meta { font-size:12px; color:var(--ma-faint); margin-top:3px; }
.ma-refresh { background:transparent; border:1px solid var(--ma-border); color:var(--ma-dim); padding:.45rem .9rem; border-radius:6px; font-size:13px; cursor:pointer; display:flex; align-items:center; gap:6px; }
.ma-refresh:hover { background:var(--ma-hover); }
.ma-refresh:disabled { opacity:.6; cursor:default; }
.ma-note { font-size:12px; color:var(--ma-dim); background:rgba(245,166,35,0.06); border:1px solid rgba(245,166,35,0.2); border-radius:9px; padding:.7rem .9rem; margin-bottom:1.25rem; line-height:1.5; }
.ma-kpis { display:grid; grid-template-columns:1.4fr 1fr 1fr 1fr 1fr; gap:12px; margin-bottom:1.5rem; }
.ma-kpi { background:linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.015)); border:1px solid var(--ma-border); border-radius:10px; padding:.85rem .95rem; min-width:0; }
.ma-kpi-lg { background:linear-gradient(180deg,rgba(245,166,35,0.1),rgba(245,166,35,0.02)); border-color:rgba(245,166,35,0.25); }
.ma-kpi-label { font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.4px; color:var(--ma-faint); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ma-kpi-val { font-size:24px; font-weight:800; margin-top:5px; line-height:1.1; letter-spacing:-.5px; }
.ma-kpi-sub { font-size:10.5px; color:var(--ma-faint); margin-top:3px; }
.ma-kpi-split { display:flex; gap:12px; font-size:11.5px; font-weight:700; margin-top:6px; flex-wrap:wrap; }
.ma-table-wrap { background:var(--ma-card); border:1px solid var(--ma-border); border-radius:10px; padding:1rem 1.1rem 1.2rem; }
.ma-table-h { font-size:13.5px; font-weight:700; margin-bottom:.85rem; }
.ma-table { width:100%; border-collapse:collapse; font-size:13px; }
.ma-table th { text-align:left; font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.4px; color:var(--ma-faint); padding:6px 8px; border-bottom:1px solid var(--ma-border); }
.ma-table td { padding:9px 8px; border-bottom:1px solid rgba(255,255,255,0.04); }
.ma-table tr:last-child td { border-bottom:none; }
.ma-table tbody tr:hover { background:var(--ma-hover); }
.ma-r { text-align:right; }
.ma-rank { color:var(--ma-faint); font-weight:700; width:30px; }
.ma-nick { font-weight:600; }
.ma-strong { font-weight:800; color:#f5c33b; }
.ma-foot { font-size:10.5px; color:var(--ma-faint); margin-top:.9rem; line-height:1.5; }
.ma-empty { font-size:12.5px; color:var(--ma-faint); padding:18px 0; text-align:center; }
.ma-state { padding:24px 0; text-align:center; color:var(--ma-faint); font-size:13px; }
.ma-err { color:#ff6b6b; }
@media (max-width:1000px){ .ma-kpis { grid-template-columns:1fr 1fr; } }
@media (max-width:600px){ .ma-hide-sm { display:none; } .ma-kpis { grid-template-columns:1fr; } }
@keyframes spin { to { transform: rotate(360deg); } }
`;
