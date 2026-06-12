import { useState, useEffect } from 'react';
import { Zap, RefreshCw } from 'lucide-react';
import api from '../services/api';

// Live Binance P2P competitor order book (admin-gated). Renders nothing unless enabled.
// Card-based layout (Sell USDT left, Buy USDT right).
export default function PriceTracker({ enabled }) {
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);

  const load = async () => {
    setLoading(true); setErr('');
    try {
      const r = await api.get('/traders/price-tracker?asset=USDT&fiat=KES');
      setBoard(r.data);
      setUpdatedAt(Date.now());
    } catch (e) {
      setErr(e.response?.data?.detail || 'Could not load live prices.');
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!enabled) return;
    load();
    const id = setInterval(load, 30000); // refresh every 30s
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  if (!enabled) return null;

  const fmt = n => Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 2 });

  const Column = ({ side, title, hint, rows }) => (
    <div className={`pt-col pt-${side}`}>
      <div className="pt-col-head">
        <div className="pt-dot" />
        <h2>{title}</h2>
        <span className="pt-sort">{hint}</span>
      </div>
      <div className="pt-list">
        {(rows || []).map((r, i) => (
          <div key={r.advNo} className={`pt-row${i === 0 ? ' pt-best' : ''}`}>
            <div className="pt-rank">{i + 1}</div>
            <div className="pt-info">
              <div className="pt-name">{r.nick}</div>
              <div className="pt-submeta">
                <span className={r.finishRate >= 95 ? 'pt-good' : 'pt-done'}>{r.finishRate}%</span>
                <span>{Number(r.orders30d || 0).toLocaleString()} trades</span>
              </div>
            </div>
            <div className="pt-right">
              <div className="pt-price">{Number(r.price || 0).toFixed(2)}</div>
              <div className="pt-avail">{fmt(r.available)}</div>
            </div>
          </div>
        ))}
        {(!rows || rows.length === 0) && (
          <div className="pt-empty">No ads.</div>
        )}
      </div>
    </div>
  );

  return (
    <div className="pt-root">
      <style>{PT_CSS}</style>
      <div className="pt-head">
        <div>
          <h1><Zap size={18} style={{ color: '#f5a623' }} /> Price Tracker</h1>
          <div className="pt-meta">
            Live Binance P2P · USDT/KES{updatedAt ? ` · updated ${new Date(updatedAt).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : ''}
          </div>
        </div>
        <button className="pt-refresh" onClick={load} disabled={loading}>
          <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} /> Refresh
        </button>
      </div>

      {err ? (
        <div className="pt-state pt-err">{err}</div>
      ) : !board ? (
        <div className="pt-state">Loading live prices…</div>
      ) : (
        <>
          <div className="pt-columns">
            <Column side="sell" title="Sell USDT" hint="highest first — best to sell to" rows={board.sell} />
            <Column side="buy" title="Buy USDT" hint="cheapest first — best to buy from" rows={board.buy} />
          </div>
          <div className="pt-footnote">Rank #1 is the most competitive merchant on each side. Prices update automatically every 30s.</div>
        </>
      )}
    </div>
  );
}

const PT_CSS = `
.pt-root {
  --pt-sell:#34c759; --pt-buy:#4a9eff; --pt-top:#f5a623;
  --pt-text:#fff; --pt-dim:#c4c9d0; --pt-faint:#7d848c;
  --pt-card:rgba(255,255,255,0.03); --pt-border:rgba(255,255,255,0.08); --pt-hover:rgba(255,255,255,0.06);
  background:#161b22; border:1px solid var(--pt-border); border-radius:12px; padding:1.5rem; color:var(--pt-text);
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,sans-serif;
}
.pt-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:1.5rem; }
.pt-head h1 { font-size:18px; font-weight:600; display:flex; align-items:center; gap:8px; color:var(--pt-text); }
.pt-meta { font-size:12px; color:var(--pt-faint); margin-top:3px; }
.pt-refresh { background:transparent; border:1px solid var(--pt-border); color:var(--pt-dim); padding:.45rem .9rem; border-radius:6px; font-size:13px; cursor:pointer; display:flex; align-items:center; gap:6px; transition:background .15s; }
.pt-refresh:hover { background:var(--pt-hover); }
.pt-refresh:disabled { opacity:.6; cursor:default; }
.pt-columns { display:grid; grid-template-columns:1fr 1fr; gap:1.5rem; }
.pt-col-head { display:flex; align-items:center; gap:8px; margin-bottom:1rem; padding-bottom:.75rem; border-bottom:1px solid var(--pt-border); }
.pt-dot { width:10px; height:10px; border-radius:50%; flex-shrink:0; }
.pt-col-head h2 { font-size:14px; font-weight:600; flex:1; }
.pt-sort { font-size:11px; color:var(--pt-faint); }
.pt-sell .pt-dot { background:var(--pt-sell); } .pt-sell h2 { color:var(--pt-sell); }
.pt-buy .pt-dot { background:var(--pt-buy); } .pt-buy h2 { color:var(--pt-buy); }
.pt-list { display:flex; flex-direction:column; gap:.6rem; }
.pt-row { background:var(--pt-card); border:1px solid var(--pt-border); border-radius:8px; padding:.7rem .85rem; display:flex; align-items:center; gap:.75rem; transition:background .15s,border-color .15s; }
.pt-row:hover { background:var(--pt-hover); border-color:rgba(255,255,255,0.15); }
.pt-rank { width:22px; height:22px; border-radius:50%; background:rgba(255,255,255,0.06); color:var(--pt-faint); font-size:11px; font-weight:600; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
.pt-row.pt-best .pt-rank { background:rgba(245,166,35,0.15); color:var(--pt-top); }
.pt-info { flex:1; min-width:0; }
.pt-name { font-size:13px; font-weight:600; margin-bottom:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--pt-text); }
.pt-submeta { font-size:11px; color:var(--pt-faint); display:flex; gap:8px; flex-wrap:wrap; }
.pt-submeta .pt-done { color:var(--pt-dim); }
.pt-submeta .pt-good { color:var(--pt-sell); }
.pt-right { text-align:right; flex-shrink:0; }
.pt-price { font-size:15px; font-weight:700; }
.pt-sell .pt-price { color:var(--pt-sell); } .pt-buy .pt-price { color:var(--pt-buy); }
.pt-avail { font-size:10px; color:var(--pt-faint); margin-top:2px; }
.pt-footnote { font-size:11px; color:var(--pt-faint); margin-top:1.25rem; text-align:center; }
.pt-state { padding:24px 0; text-align:center; color:var(--pt-faint); font-size:13px; }
.pt-err { color:#ff6b6b; }
.pt-empty { padding:14px; text-align:center; color:var(--pt-faint); font-size:12px; }
@media (max-width:760px){ .pt-columns{ grid-template-columns:1fr; } }
@keyframes spin { to { transform: rotate(360deg); } }
`;
