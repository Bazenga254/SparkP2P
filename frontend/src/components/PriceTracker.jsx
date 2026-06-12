import { useState, useEffect } from 'react';
import { Zap, RefreshCw, Search, X } from 'lucide-react';
import api from '../services/api';

// Live Binance P2P competitor order book (admin-gated). Renders nothing unless enabled.
// Tier (Gold/Silver/Bronze) = Binance P2P Merchant level, read from the feed's vipLevel
// (verified against the web-UI medal badges: vip3=Gold, vip2=Silver, vip1/0=Bronze).
const TIER_COLOR = { gold: '#f5c33b', silver: '#ffffff', bronze: '#cd7f32', normal: '#9ca3af' };
const TIERS = [
  { key: 'all', label: 'All' },
  { key: 'gold', label: 'Gold' },
  { key: 'silver', label: 'Silver' },
  { key: 'bronze', label: 'Bronze' },
  { key: 'normal', label: 'Normal' },
];

export default function PriceTracker({ enabled, binanceName }) {
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);
  const [query, setQuery] = useState('');
  const [tier, setTier] = useState('all');
  const [me, setMe] = useState(() => (binanceName || localStorage.getItem('sparkp2p_pt_me') || ''));
  const [detecting, setDetecting] = useState(false);
  const [detectMsg, setDetectMsg] = useState('');
  const saveMe = v => { setMe(v); localStorage.setItem('sparkp2p_pt_me', v); };

  // Auto-fill from the API-detected Binance nickname when it arrives.
  useEffect(() => { if (binanceName && !me) saveMe(binanceName); /* eslint-disable-next-line */ }, [binanceName]);

  const detect = async () => {
    setDetecting(true); setDetectMsg('');
    try {
      const r = await api.post('/traders/detect-binance-name');
      if (r.data?.nickname) saveMe(r.data.nickname);
    } catch (e) {
      setDetectMsg(e.response?.data?.detail || 'Could not detect your name.');
    }
    setDetecting(false);
  };

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
  const q = query.trim().toLowerCase();
  const pick = rows => {
    let list = rows || [];
    if (tier !== 'all') list = list.filter(r => r.tier === tier);
    if (q) list = list.filter(r => (r.nick || '').toLowerCase().includes(q));
    else list = list.slice(0, 20);
    return list;
  };

  // "Your position" — match my Binance name against the live board (no relay needed).
  const meq = me.trim().toLowerCase();
  const isMe = nick => !!meq && (nick || '').trim().toLowerCase() === meq;
  const myPos = rows => {
    if (!meq) return null;
    const mine = (rows || []).filter(r => isMe(r.nick)).sort((a, b) => a.rank - b.rank)[0];
    if (!mine) return null;
    const tierRank = (rows || []).filter(r => r.tier === mine.tier && r.rank < mine.rank).length + 1;
    return { ...mine, tierRank };
  };

  const Column = ({ side, title, clarify, hint, rows }) => (
    <div className={`pt-col pt-${side}`}>
      <div className="pt-col-head">
        <div className="pt-dot" />
        <div className="pt-col-titles">
          <h2>{title}</h2>
          <div className="pt-clarify">{clarify}</div>
        </div>
        <span className="pt-sort">{hint}</span>
      </div>
      <div className="pt-list">
        {rows.map((r) => (
          <div key={r.advNo} className={`pt-row${r.rank === 1 && !q && tier === 'all' ? ' pt-best' : ''}${isMe(r.nick) ? ' pt-me' : ''}`}>
            <div className="pt-rank">{r.rank}</div>
            <div className="pt-info">
              <div className="pt-name">
                <span className="pt-medal" style={{ background: TIER_COLOR[r.tier] }} />
                <span style={{ color: TIER_COLOR[r.tier] || '#fff' }}>{r.nick}</span>
                {isMe(r.nick) && <span className="pt-youtag">YOU</span>}
              </div>
              <div className="pt-submeta">
                <span className="pt-tier" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
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
        {rows.length === 0 && (
          <div className="pt-empty">{q ? `No "${query}" ad here.` : `No ${tier === 'all' ? '' : tier + ' '}merchants.`}</div>
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
          <div className="pt-controls">
            <div className="pt-filters">
              {TIERS.map(t => (
                <button
                  key={t.key}
                  className={`pt-filter${tier === t.key ? ' pt-active' : ''}`}
                  style={tier === t.key && t.key !== 'all' ? { color: TIER_COLOR[t.key], borderColor: TIER_COLOR[t.key] } : undefined}
                  onClick={() => setTier(t.key)}
                >
                  {t.key !== 'all' && <span className="pt-swatch" style={{ background: TIER_COLOR[t.key] }} />}
                  {t.label}
                </button>
              ))}
            </div>
            <div className="pt-searchbar">
              <Search size={15} className="pt-search-ic" />
              <input
                className="pt-search"
                placeholder="Track a merchant — search by name…"
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
              {query && <button className="pt-search-clear" onClick={() => setQuery('')} title="Clear"><X size={14} /></button>}
            </div>
          </div>

          {/* Your position — client-side match against the live board (no relay needed) */}
          <div className="pt-pos">
            <div className="pt-pos-bar">
              <span className="pt-pos-label">Your Binance name</span>
              <div className="pt-pos-inputwrap">
                <input
                  className="pt-pos-field"
                  placeholder="auto-detected from your Binance API"
                  value={me}
                  onChange={e => saveMe(e.target.value)}
                />
                {me && <button className="pt-pos-clear" onClick={() => saveMe('')} title="Clear"><X size={13} /></button>}
              </div>
              <button className="pt-pos-detect" onClick={detect} disabled={detecting}>
                {detecting ? 'Detecting…' : 'Detect from Binance'}
              </button>
            </div>
            {binanceName && me === binanceName && <div className="pt-pos-auto">✓ Auto-detected from your Binance API</div>}
            {detectMsg && <div className="pt-pos-none">{detectMsg}</div>}
            {meq && (() => {
              const pb = myPos(board.buy), ps = myPos(board.sell);
              if (!pb && !ps) return <div className="pt-pos-none">No live ad found for “{me}” in the current results — you may not be advertising, or you're ranked beyond what we pull.</div>;
              const Cell = (label, p, accent) => (
                <div className="pt-pos-cell">
                  <div className="pt-pos-side" style={{ color: accent }}>{label}</div>
                  {p ? (
                    <div className="pt-pos-val">
                      <strong>#{p.rank}</strong> overall · <strong style={{ color: TIER_COLOR[p.tier] }}>#{p.tierRank} {p.tier}</strong> · KES {Number(p.price).toFixed(2)}
                    </div>
                  ) : <div className="pt-pos-val pt-pos-dim">no live ad on this side</div>}
                </div>
              );
              return (
                <div className="pt-pos-grid">
                  {Cell('Buy USDT — your sell ad', pb, '#4a9eff')}
                  {Cell('Sell USDT — your buy ad', ps, '#34c759')}
                </div>
              );
            })()}
          </div>

          <div className="pt-columns">
            <Column side="buy" title="Buy USDT" clarify={'“merchant is selling”'} hint="cheapest first — best to buy from" rows={pick(board.buy)} />
            <Column side="sell" title="Sell USDT" clarify={'“merchant is buying”'} hint="highest first — best to sell to" rows={pick(board.sell)} />
          </div>
          <div className="pt-footnote">
            Tier = <strong>Binance P2P Merchant level</strong> (🥇 Gold · 🥈 Silver · 🥉 Bronze · <span style={{ color: '#9ca3af' }}>Normal</span> = non-merchant). Rank #1 is the most competitive on each side. Prices update every 30s.
          </div>
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
.pt-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem; }
.pt-head h1 { font-size:18px; font-weight:600; display:flex; align-items:center; gap:8px; color:var(--pt-text); }
.pt-meta { font-size:12px; color:var(--pt-faint); margin-top:3px; }
.pt-refresh { background:transparent; border:1px solid var(--pt-border); color:var(--pt-dim); padding:.45rem .9rem; border-radius:6px; font-size:13px; cursor:pointer; display:flex; align-items:center; gap:6px; transition:background .15s; }
.pt-refresh:hover { background:var(--pt-hover); }
.pt-refresh:disabled { opacity:.6; cursor:default; }
.pt-controls { display:flex; gap:12px; align-items:center; margin-bottom:1.25rem; flex-wrap:wrap; }
.pt-filters { display:flex; gap:8px; flex-wrap:wrap; }
.pt-filter { display:flex; align-items:center; gap:6px; background:var(--pt-card); border:1px solid var(--pt-border); color:var(--pt-dim); padding:.4rem .85rem; border-radius:7px; font-size:13px; font-weight:600; cursor:pointer; transition:background .15s,border-color .15s; }
.pt-filter:hover { background:var(--pt-hover); }
.pt-filter.pt-active { background:var(--pt-hover); border-color:rgba(255,255,255,0.25); color:#fff; }
.pt-swatch { width:9px; height:9px; border-radius:50%; flex-shrink:0; }
.pt-searchbar { position:relative; display:flex; align-items:center; flex:1; min-width:220px; }
.pt-search-ic { position:absolute; left:12px; color:var(--pt-faint); pointer-events:none; }
.pt-search { width:100%; box-sizing:border-box; padding:.55rem .9rem .55rem 36px; border-radius:8px; border:1px solid var(--pt-border); background:var(--pt-card); color:var(--pt-text); font-size:13.5px; outline:none; }
.pt-search:focus { border-color:rgba(255,255,255,0.25); }
.pt-search::placeholder { color:var(--pt-faint); }
.pt-search-clear { position:absolute; right:8px; background:none; border:none; color:var(--pt-faint); cursor:pointer; display:flex; padding:4px; }
.pt-search-clear:hover { color:var(--pt-text); }
.pt-pos { background:rgba(74,158,255,0.06); border:1px solid rgba(74,158,255,0.22); border-radius:10px; padding:.85rem 1rem; margin-bottom:1.25rem; }
.pt-pos-bar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.pt-pos-label { font-size:12px; font-weight:700; color:var(--pt-dim); white-space:nowrap; }
.pt-pos-inputwrap { position:relative; flex:1; min-width:200px; display:flex; align-items:center; }
.pt-pos-field { width:100%; box-sizing:border-box; padding:.5rem .9rem; border-radius:8px; border:1px solid var(--pt-border); background:var(--pt-card); color:var(--pt-text); font-size:13.5px; outline:none; }
.pt-pos-field:focus { border-color:rgba(255,255,255,0.25); }
.pt-pos-field::placeholder { color:var(--pt-faint); }
.pt-pos-clear { position:absolute; right:8px; background:none; border:none; color:var(--pt-faint); cursor:pointer; display:flex; padding:3px; }
.pt-pos-clear:hover { color:var(--pt-text); }
.pt-pos-grid { display:grid; grid-template-columns:1fr 1fr; gap:1rem; margin-top:.85rem; }
.pt-pos-cell { background:var(--pt-card); border:1px solid var(--pt-border); border-radius:8px; padding:.6rem .8rem; }
.pt-pos-side { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.4px; margin-bottom:4px; }
.pt-pos-val { font-size:14px; color:var(--pt-text); font-weight:500; }
.pt-pos-dim { color:var(--pt-faint); font-weight:500; }
.pt-pos-none { font-size:12.5px; color:var(--pt-faint); margin-top:.6rem; }
.pt-pos-detect { background:transparent; border:1px solid rgba(74,158,255,0.4); color:var(--pt-buy); padding:.5rem .85rem; border-radius:8px; font-size:12.5px; font-weight:600; cursor:pointer; white-space:nowrap; }
.pt-pos-detect:hover { background:rgba(74,158,255,0.1); }
.pt-pos-detect:disabled { opacity:.6; cursor:default; }
.pt-pos-auto { font-size:11.5px; color:var(--pt-sell); margin-top:.55rem; font-weight:600; }
.pt-youtag { font-size:9px; font-weight:800; letter-spacing:.5px; color:#0f1318; background:#4a9eff; border-radius:4px; padding:1px 5px; margin-left:2px; }
@media (max-width:760px){ .pt-pos-grid { grid-template-columns:1fr; } }
.pt-columns { display:grid; grid-template-columns:1fr 1fr; gap:1.5rem; }
.pt-col-head { display:flex; align-items:center; gap:8px; margin-bottom:1rem; padding-bottom:.75rem; border-bottom:1px solid var(--pt-border); }
.pt-dot { width:10px; height:10px; border-radius:50%; flex-shrink:0; }
.pt-col-titles { flex:1; min-width:0; }
.pt-col-head h2 { font-size:15px; font-weight:700; }
.pt-clarify { font-size:13.5px; font-weight:700; color:var(--pt-dim); margin-top:3px; letter-spacing:.2px; }
.pt-sort { font-size:11px; color:var(--pt-faint); text-align:right; }
.pt-sell .pt-dot { background:var(--pt-sell); } .pt-sell h2 { color:var(--pt-sell); }
.pt-buy .pt-dot { background:var(--pt-buy); } .pt-buy h2 { color:var(--pt-buy); }
.pt-list { display:flex; flex-direction:column; gap:.6rem; }
.pt-row { background:var(--pt-card); border:1px solid var(--pt-border); border-radius:8px; padding:.7rem .85rem; display:flex; align-items:center; gap:.75rem; transition:background .15s,border-color .15s; }
.pt-row:hover { background:var(--pt-hover); border-color:rgba(255,255,255,0.15); }
.pt-rank { width:22px; height:22px; border-radius:50%; background:rgba(255,255,255,0.06); color:var(--pt-faint); font-size:11px; font-weight:600; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
.pt-row.pt-best .pt-rank { background:rgba(245,166,35,0.15); color:var(--pt-top); }
.pt-row.pt-me { border-color:rgba(74,158,255,0.55); background:rgba(74,158,255,0.08); }
.pt-info { flex:1; min-width:0; }
.pt-name { font-size:14.5px; font-weight:600; margin-bottom:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:flex; align-items:center; gap:6px; }
.pt-medal { width:9px; height:9px; border-radius:50%; flex-shrink:0; }
.pt-submeta { font-size:13px; color:var(--pt-dim); display:flex; gap:10px; flex-wrap:wrap; font-weight:500; align-items:center; }
.pt-tier { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.5px; }
.pt-submeta .pt-done { color:var(--pt-dim); }
.pt-submeta .pt-good { color:var(--pt-sell); }
.pt-right { text-align:right; flex-shrink:0; }
.pt-price { font-size:18px; font-weight:700; }
.pt-sell .pt-price { color:var(--pt-sell); } .pt-buy .pt-price { color:var(--pt-buy); }
.pt-avail { font-size:13px; color:var(--pt-dim); margin-top:3px; font-weight:500; }
.pt-footnote { font-size:11px; color:var(--pt-faint); margin-top:1.25rem; text-align:center; line-height:1.6; }
.pt-state { padding:24px 0; text-align:center; color:var(--pt-faint); font-size:13px; }
.pt-err { color:#ff6b6b; }
.pt-empty { padding:14px; text-align:center; color:var(--pt-faint); font-size:12px; }
@media (max-width:760px){ .pt-columns{ grid-template-columns:1fr; } }
@keyframes spin { to { transform: rotate(360deg); } }
`;
