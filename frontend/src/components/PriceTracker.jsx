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

export default function PriceTracker({ enabled, binanceName, profile }) {
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);
  const [query, setQuery] = useState('');
  const [tier, setTier] = useState('all');
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [copied, setCopied] = useState('');
  const copyNick = async (nick, key) => {
    try { await navigator.clipboard.writeText(nick); } catch (_) {}
    setCopied(key);
    setTimeout(() => setCopied(c => (c === key ? '' : c)), 1200);
  };
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

  // ── Alerts & Targets (Monitor settings) ──
  const [pmOpen, setPmOpen] = useState(false);
  const [pm, setPm] = useState({
    enabled: !!profile?.pm_enabled,
    target: profile?.pm_target_rank || 1,
    scope: profile?.pm_scope || 'all',
    drop: profile?.pm_alert_drop ?? true,
    top1: !!profile?.pm_alert_top1,
    overtaken: !!profile?.pm_alert_overtaken,
    summary: !!profile?.pm_alert_summary,
    reached: !!profile?.pm_alert_reached,
    anomaly: !!profile?.pm_alert_anomaly,
    autoprice: profile?.pm_autoprice || 'off',
    marginMin: profile?.pm_margin_min || '',
    marginMax: profile?.pm_margin_max || '',
  });
  const [pmSaving, setPmSaving] = useState(false);
  const [pmMsg, setPmMsg] = useState('');
  const tgConnected = !!profile?.telegram_connected;
  const savePm = async () => {
    setPmSaving(true); setPmMsg('');
    try {
      await api.put('/traders/price-monitor/settings', {
        enabled: pm.enabled, target_rank: Number(pm.target), scope: pm.scope,
        alert_drop: pm.drop, alert_top1: pm.top1, alert_overtaken: pm.overtaken, alert_summary: pm.summary,
        alert_reached: pm.reached, alert_anomaly: pm.anomaly,
        autoprice: pm.autoprice, margin_min: parseFloat(pm.marginMin) || 0, margin_max: parseFloat(pm.marginMax) || 0,
      });
      setPmMsg('Saved ✓');
    } catch (e) { setPmMsg(e.response?.data?.detail || 'Save failed'); }
    setPmSaving(false);
  };
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState('');
  const sendTest = async () => {
    setTesting(true); setTestMsg('');
    try { await api.post('/traders/price-monitor/test'); setTestMsg('Sent ✓ — check your Telegram'); }
    catch (e) { setTestMsg(e.response?.data?.detail || 'Failed to send'); }
    setTesting(false);
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
    if (verifiedOnly) list = list.filter(r => r.tier !== 'normal');
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

  // ── Auto-price simulation (client-side, relay-free) ──
  const round2 = n => Math.round(n * 100) / 100;
  const median = arr => {
    const s = [...arr].filter(x => x > 0).sort((a, b) => a - b);
    const n = s.length;
    return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0;
  };
  const TICK = 0.01;
  // isSell=true => your SELL ad on the Buy-USDT board (cheapest first); ref = cost to acquire.
  // isSell=false => your BUY ad on the Sell-USDT board (highest first); ref = sale revenue.
  const simSide = (rows, isSell, ref, mmin, mmax) => {
    if (!(mmax > 0) || !ref) return null;
    const myRow = (rows || []).filter(r => isMe(r.nick)).sort((a, b) => a.rank - b.rank)[0];
    let comps = (rows || []).filter(r => !isMe(r.nick));
    if (pm.scope === 'tier' && myRow) comps = comps.filter(r => r.tier === myRow.tier);
    if (!comps.length) return null;
    const tgt = comps[Math.min(Number(pm.target) || 1, comps.length) - 1];
    const peg = isSell ? tgt.price - TICK : tgt.price + TICK;
    const lo = isSell ? ref + mmin : ref - mmax;   // sell: cost+min ; buy: revenue-max
    const hi = isSell ? ref + mmax : ref - mmin;   // sell: cost+max ; buy: revenue-min
    const target = round2(Math.min(Math.max(peg, lo), hi));
    const margin = round2(isSell ? target - ref : ref - target);
    return { current: myRow ? myRow.price : null, target, margin };
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
                <span className="pt-nick" style={{ color: TIER_COLOR[r.tier] || '#fff' }} title="Click to copy name" onClick={() => copyNick(r.nick, r.advNo)}>{r.nick}</span>
                {copied === r.advNo && <span className="pt-copied">✓ copied</span>}
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
              {TIERS.filter(t => !(verifiedOnly && t.key === 'normal')).map(t => (
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
              <button
                className={`pt-filter${verifiedOnly ? ' pt-active' : ''}`}
                title="Show only verified merchants (Gold/Silver/Bronze), hiding non-merchants"
                onClick={() => { const v = !verifiedOnly; setVerifiedOnly(v); if (v && tier === 'normal') setTier('all'); }}
              >
                {verifiedOnly ? '✓ ' : ''}Verified only
              </button>
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

          {/* Alerts & Targets (Monitor settings) */}
          <div className="pt-mon">
            <button className="pt-mon-head" onClick={() => setPmOpen(o => !o)}>
              <span>⚙ Alerts &amp; Targets</span>
              <span className="pt-mon-state">{pm.enabled ? 'Alerts ON' : 'Alerts off'} &nbsp;{pmOpen ? '▴' : '▾'}</span>
            </button>
            {pmOpen && (
              <div className="pt-mon-body">
                <label className="pt-mon-row">
                  <input type="checkbox" checked={pm.enabled} onChange={e => setPm({ ...pm, enabled: e.target.checked })} />
                  Enable rank alerts via Telegram
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', margin: '4px 0 6px' }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: tgConnected ? 'var(--pt-sell)' : '#f5a623' }}>
                    {tgConnected ? '✓ Telegram connected' : '⚠ Telegram not connected — link it in Settings → Notifications'}
                  </span>
                  {tgConnected && (
                    <button className="pt-mon-save" style={{ background: 'transparent', border: '1px solid var(--pt-border)', color: 'var(--pt-dim)', padding: '.35rem .8rem' }} onClick={sendTest} disabled={testing}>
                      {testing ? 'Sending…' : 'Send test alert'}
                    </button>
                  )}
                  {testMsg && <span style={{ fontSize: 12, color: testMsg.includes('✓') ? 'var(--pt-sell)' : '#ef6a7e' }}>{testMsg}</span>}
                </div>
                <div className="pt-mon-grid">
                  <div>
                    <div className="pt-mon-lbl">Target rank</div>
                    <select className="pt-mon-sel" value={pm.target} onChange={e => setPm({ ...pm, target: e.target.value })}>
                      <option value={1}>Always #1</option>
                      <option value={2}>Top 2</option>
                      <option value={3}>Top 3</option>
                      <option value={5}>Top 5</option>
                      <option value={10}>Top 10</option>
                    </select>
                  </div>
                  <div>
                    <div className="pt-mon-lbl">Compare against</div>
                    <select className="pt-mon-sel" value={pm.scope} onChange={e => setPm({ ...pm, scope: e.target.value })}>
                      <option value="all">Whole table</option>
                      <option value="tier">My tier only</option>
                    </select>
                  </div>
                </div>
                <div className="pt-mon-lbl" style={{ marginTop: 12 }}>Notify me when…</div>
                {[['drop', 'I drop out of my target rank'], ['reached', 'I reach / regain my target rank (e.g. become #1)'], ['overtaken', 'Someone overtakes me'], ['top1', 'The #1 merchant changes'], ['anomaly', 'The market turns aggressive (price spike / spread squeeze)'], ['summary', 'Send a periodic rank summary (every 6h)']].map(([k, lbl]) => (
                  <label key={k} className="pt-mon-row">
                    <input type="checkbox" checked={pm[k]} onChange={e => setPm({ ...pm, [k]: e.target.checked })} />
                    {lbl}
                  </label>
                ))}
                <div className="pt-mon-lbl" style={{ marginTop: 14 }}>Auto-pricing</div>
                {profile?.pm_autoprice_error && (
                  <div className="pt-mon-warn" style={{ color: '#ef6a7e', marginBottom: 8 }}>⚠ {profile.pm_autoprice_error}</div>
                )}
                <select className="pt-mon-sel" style={{ maxWidth: 360 }} value={pm.autoprice} onChange={e => setPm({ ...pm, autoprice: e.target.value })}>
                  <option value="off">Off — monitor / alerts only</option>
                  <option value="sim">Simulate — preview the price it would set (no change)</option>
                  <option value="live">Live — automatically change my ad price</option>
                </select>
                {pm.autoprice === 'live' && (
                  <>
                    <div className="pt-mon-warn" style={{ color: '#ef6a7e' }}>
                      ⚠ Live mode changes your real Binance ad price automatically — only while your desktop app (relay) is online. It always stays within your margin band and never below your minimum margin. Updates at most once every 5 minutes, max 1 KES per move.
                    </div>
                    <div style={{ marginTop: 8, fontSize: 13, fontWeight: 700, color: board?.relay_connected ? '#34c759' : '#ef6a7e' }}>
                      {board?.relay_connected
                        ? '🟢 Relay online — auto-pricing is ACTIVE.'
                        : '🔴 Relay offline — auto-pricing is PAUSED. Open your SparkP2P desktop app and keep it running for prices to change.'}
                    </div>
                  </>
                )}
                {pm.autoprice !== 'off' && (
                  <>
                    <div className="pt-mon-grid" style={{ marginTop: 10 }}>
                      <div>
                        <div className="pt-mon-lbl">Min margin (KES/USDT)</div>
                        <input className="pt-mon-sel" type="number" step="0.01" min="0" placeholder="e.g. 0.38" value={pm.marginMin} onChange={e => setPm({ ...pm, marginMin: e.target.value })} />
                      </div>
                      <div>
                        <div className="pt-mon-lbl">Max margin (KES/USDT)</div>
                        <input className="pt-mon-sel" type="number" step="0.01" min="0" placeholder="e.g. 0.46" value={pm.marginMax} onChange={e => setPm({ ...pm, marginMax: e.target.value })} />
                      </div>
                    </div>
                    <div className="pt-mon-warn" style={{ color: 'var(--pt-faint)' }}>
                      Margin = sell − buy (round-trip profit per USDT). The bot keeps you within this band while chasing your target rank — never below the min. Live price-changing comes after you're happy with the simulation (and needs your desktop relay online).
                    </div>
                  </>
                )}
                <div className="pt-mon-actions">
                  <button className="pt-mon-save" onClick={savePm} disabled={pmSaving}>{pmSaving ? 'Saving…' : 'Save settings'}</button>
                  {pmMsg && <span className="pt-mon-msg">{pmMsg}</span>}
                </div>
              </div>
            )}
          </div>

          {/* Auto-price simulation (preview only) */}
          {pm.autoprice === 'sim' && meq && (() => {
            const mmin = parseFloat(pm.marginMin) || 0, mmax = parseFloat(pm.marginMax) || 0;
            const cost = median((board.buy || []).slice(0, 5).map(r => r.price));      // cost to acquire USDT
            const revenue = median((board.sell || []).slice(0, 5).map(r => r.price));  // revenue when selling
            const simSell = simSide(board.buy, true, cost, mmin, mmax);
            const simBuy = simSide(board.sell, false, revenue, mmin, mmax);
            if (!simSell && !simBuy) return null;
            const Cell = (lbl, s, acc) => (
              <div className="pt-pos-cell">
                <div className="pt-pos-side" style={{ color: acc }}>{lbl} → would set</div>
                {s ? (
                  <>
                    <div className="pt-pos-val">KES {s.target.toFixed(2)} {s.current != null && <span className="pt-pos-dim">(now {s.current.toFixed(2)})</span>}</div>
                    <div className="pt-pos-dim" style={{ fontSize: 11, marginTop: 2 }}>margin KES {s.margin.toFixed(2)} · holds top {pm.target}</div>
                  </>
                ) : <div className="pt-pos-val pt-pos-dim">no live ad / set margin band</div>}
              </div>
            );
            return (
              <div className="pt-sim">
                <div className="pt-sim-h">🧪 Auto-price simulation <span>preview only — your price is NOT changed</span></div>
                <div className="pt-pos-grid">
                  {Cell('Sell ad', simSell, '#34c759')}
                  {Cell('Buy ad', simBuy, '#4a9eff')}
                </div>
              </div>
            );
          })()}

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
.pt-mon { border:1px solid var(--pt-border); border-radius:10px; margin-bottom:1.25rem; overflow:hidden; }
.pt-mon-head { width:100%; display:flex; align-items:center; justify-content:space-between; background:var(--pt-card); border:none; color:var(--pt-text); padding:.7rem 1rem; font-size:13.5px; font-weight:600; cursor:pointer; }
.pt-mon-head:hover { background:var(--pt-hover); }
.pt-mon-state { font-size:12px; color:var(--pt-faint); }
.pt-mon-body { padding:1rem; border-top:1px solid var(--pt-border); }
.pt-mon-row { display:flex; align-items:center; gap:8px; font-size:13px; color:var(--pt-dim); padding:5px 0; cursor:pointer; }
.pt-mon-row input { accent-color:var(--pt-buy); width:15px; height:15px; }
.pt-mon-warn { font-size:12px; color:#f5a623; margin:4px 0 8px; }
.pt-mon-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:8px; }
.pt-mon-lbl { font-size:11px; color:var(--pt-faint); font-weight:700; text-transform:uppercase; letter-spacing:.4px; margin-bottom:5px; }
.pt-mon-sel { width:100%; box-sizing:border-box; padding:.45rem .6rem; border-radius:7px; border:1px solid var(--pt-border); background:#0f1318; color:var(--pt-text); font-size:13px; }
.pt-mon-actions { display:flex; align-items:center; gap:12px; margin-top:14px; }
.pt-mon-save { background:var(--pt-buy); border:none; color:#0f1318; font-weight:700; padding:.5rem 1.1rem; border-radius:8px; font-size:13px; cursor:pointer; }
.pt-mon-save:disabled { opacity:.6; cursor:default; }
.pt-mon-msg { font-size:12.5px; color:var(--pt-sell); font-weight:600; }
@media (max-width:760px){ .pt-mon-grid { grid-template-columns:1fr; } }
.pt-sim { background:rgba(52,199,89,0.06); border:1px solid rgba(52,199,89,0.22); border-radius:10px; padding:.85rem 1rem; margin-bottom:1.25rem; }
.pt-sim-h { font-size:13.5px; font-weight:700; color:var(--pt-text); margin-bottom:.75rem; }
.pt-sim-h span { font-size:11px; font-weight:500; color:var(--pt-faint); margin-left:8px; }
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
.pt-nick { cursor:pointer; user-select:text; }
.pt-nick:hover { text-decoration:underline; }
.pt-copied { font-size:10px; font-weight:700; color:var(--pt-sell); white-space:nowrap; }
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
