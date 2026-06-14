import { useState, useEffect } from 'react';
import api from '../services/api';
import { SPK_CSS, spark, CVAR } from './trackerTheme';
import CostBasisCard from './CostBasisCard';

// Live Binance P2P competitor order book (admin-gated). Redesigned cockpit UI.
const TIER_COLOR = { gold: '#FFBE52', silver: '#D6DBE2', bronze: '#F08A3C', normal: '#929AA6' };
const TIERS = [{ key: 'all', label: 'All' }, { key: 'gold', label: 'Gold' }, { key: 'silver', label: 'Silver' }, { key: 'bronze', label: 'Bronze' }];

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const medOf = arr => { const s = [...arr].filter(x => x > 0).sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };
const OUT_PCT = 0.03;
const cleanSide = rows => {
  const arr = (rows || []).filter(r => r && r.price > 0);
  const m = medOf(arr.slice(0, 15).map(r => r.price));
  if (!m) return arr;
  const f = arr.filter(r => Math.abs(r.price - m) / m <= OUT_PCT);
  return f.length ? f : arr;
};
const fmt2 = n => Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const INS_ICON = {
  g: '<path d="M3 17l6-6 4 4 7-7M14 8h7v7"/>',
  a: '<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>',
  o: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 9h18M3 14h18M9 4v16"/>',
};
const STAR = '<svg viewBox="0 0 24 24"><path d="M12 2.6l2.9 5.9 6.5.5-4.9 4.3 1.5 6.4L12 16.8 6 19.7l1.5-6.4L2.6 9l6.5-.5z"/></svg>';

function buildInsights({ buy, sell, ask, bid, askMed, bidMed, spread, hist, meq }) {
  const out = [];
  if (spread > 0.1) out.push({ t: 'g', text: `Healthy maker spread of KES ${spread.toFixed(2)} — a typical round trip nets about ${spread.toFixed(2)} per USDT.` });
  else out.push({ t: 'a', text: `Maker spread is only KES ${spread.toFixed(2)} — margins are thin right now; chasing rank would eat profit.` });
  if (hist && hist.length >= 3) {
    const first = r2((hist[0].ask_med || 0) - (hist[0].bid_med || 0));
    if (Math.abs(spread - first) >= 0.03) {
      const tight = spread < first;
      out.push({ t: tight ? 'a' : 'g', text: `Spread ${tight ? 'tightening' : 'widening'}: KES ${first.toFixed(2)} → ${spread.toFixed(2)} over the window.` });
    }
  }
  if (buy[0] && askMed && buy[0].price < askMed - 0.08) out.push({ t: 'a', text: `Aggressive seller: ${buy[0].nick} at KES ${buy[0].price.toFixed(2)}, ${(askMed - buy[0].price).toFixed(2)} below the pack — undercutting on Buy-USDT.` });
  if (sell[0] && bidMed && sell[0].price > bidMed + 0.08) out.push({ t: 'a', text: `Aggressive buyer: ${sell[0].nick} at KES ${sell[0].price.toFixed(2)}, ${(sell[0].price - bidMed).toFixed(2)} above the pack — bidding up Sell-USDT.` });
  if (meq) {
    const mb = buy.find(r => (r.nick || '').toLowerCase() === meq);
    const ms = sell.find(r => (r.nick || '').toLowerCase() === meq);
    if (mb && mb.rank > 1) out.push({ t: 'o', text: `Your Buy-USDT ad is #${mb.rank} — KES ${(mb.price - ask).toFixed(2)} off #1. Price ${(ask - 0.01).toFixed(2)} to take the top.` });
    if (ms && ms.rank > 1) out.push({ t: 'o', text: `Your Sell-USDT ad is #${ms.rank} — KES ${(bid - ms.price).toFixed(2)} off #1. Price ${(bid + 0.01).toFixed(2)} to take the top.` });
  }
  const avails = buy.slice(0, 10).map(r => Number(r.available) || 0);
  if (buy[0] && avails.length > 3) {
    const m = medOf(avails);
    if (m && (Number(buy[0].available) || 0) < m * 0.4) out.push({ t: 'o', text: `Thin wall at the top of Buy-USDT — only ${Math.round(buy[0].available).toLocaleString()} USDT at #1. Easy to seize #1 with size.` });
  }
  return out.slice(0, 5);
}

export default function PriceTracker({ enabled, binanceName, profile }) {
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);
  const [query, setQuery] = useState('');
  const [tier, setTier] = useState('all');
  const [verifiedOnly, setVerifiedOnly] = useState(true);
  const [hist, setHist] = useState([]);
  const [copied, setCopied] = useState('');
  const [alertsCollapsed, setAlertsCollapsed] = useState(false);

  const copyNick = async (nick, key) => { try { await navigator.clipboard.writeText(nick); } catch (_) {} setCopied(key); setTimeout(() => setCopied(c => (c === key ? '' : c)), 1200); };

  const [watch, setWatch] = useState(() => profile?.pm_watchlist || []);
  const [watchBusy, setWatchBusy] = useState('');
  const isWatched = nick => watch.some(w => w.toLowerCase() === (nick || '').trim().toLowerCase());
  const toggleWatch = async (nick) => {
    const name = (nick || '').trim(); if (!name) return;
    const action = isWatched(name) ? 'remove' : 'add';
    setWatchBusy(name.toLowerCase());
    try { const r = await api.post('/traders/price-monitor/watchlist', { nick: name, action }); setWatch(r.data.watchlist || []); } catch (_) {}
    setWatchBusy('');
  };
  const posOf = (rows, nick) => { const nl = (nick || '').trim().toLowerCase(); const m = (rows || []).filter(r => (r.nick || '').trim().toLowerCase() === nl).sort((a, b) => a.rank - b.rank)[0]; return m ? { rank: m.rank, price: m.price } : null; };

  const [me, setMe] = useState(() => (binanceName || localStorage.getItem('sparkp2p_pt_me') || ''));
  const [detecting, setDetecting] = useState(false);
  const [detectMsg, setDetectMsg] = useState('');
  const saveMe = v => { setMe(v); localStorage.setItem('sparkp2p_pt_me', v); };
  useEffect(() => { if (binanceName && !me) saveMe(binanceName); /* eslint-disable-next-line */ }, [binanceName]);
  const detect = async () => {
    setDetecting(true); setDetectMsg('');
    try { const r = await api.post('/traders/detect-binance-name'); if (r.data?.nickname) saveMe(r.data.nickname); }
    catch (e) { setDetectMsg(e.response?.data?.detail || 'Could not detect your name.'); }
    setDetecting(false);
  };

  const [pm, setPm] = useState({
    enabled: !!profile?.pm_enabled, target: profile?.pm_target_rank || 1, scope: profile?.pm_scope || 'all',
    drop: profile?.pm_alert_drop ?? true, top1: !!profile?.pm_alert_top1, overtaken: !!profile?.pm_alert_overtaken,
    summary: !!profile?.pm_alert_summary, reached: !!profile?.pm_alert_reached, anomaly: !!profile?.pm_alert_anomaly,
    watchlist: profile?.pm_alert_watchlist ?? true, autoprice: profile?.pm_autoprice || 'off',
    marginMin: profile?.pm_margin_min || '', marginMax: profile?.pm_margin_max || '',
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
        alert_reached: pm.reached, alert_anomaly: pm.anomaly, alert_watchlist: pm.watchlist,
        autoprice: pm.autoprice, margin_min: parseFloat(pm.marginMin) || 0, margin_max: parseFloat(pm.marginMax) || 0,
      });
      setPmMsg('Saved ✓');
    } catch (e) { setPmMsg(e.response?.data?.detail || 'Save failed'); }
    setPmSaving(false);
  };
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState('');
  const sendTest = async () => { setTesting(true); setTestMsg(''); try { await api.post('/traders/price-monitor/test'); setTestMsg('Sent ✓'); } catch (e) { setTestMsg(e.response?.data?.detail || 'Failed'); } setTesting(false); };

  const load = async () => {
    setLoading(true); setErr('');
    try { const r = await api.get('/traders/price-tracker?asset=USDT&fiat=KES'); setBoard(r.data); setUpdatedAt(Date.now()); }
    catch (e) { setErr(e.response?.data?.detail || 'Could not load live prices.'); }
    setLoading(false);
  };
  useEffect(() => { if (!enabled) return; load(); const id = setInterval(load, 30000); return () => clearInterval(id); /* eslint-disable-next-line */ }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    const f = async () => { try { const r = await api.get('/traders/price-tracker/history?hours=6'); setHist(r.data?.points || []); } catch (_) {} };
    f(); const id = setInterval(f, 60000); return () => clearInterval(id);
  }, [enabled]);

  if (!enabled) return null;

  const q = query.trim().toLowerCase();
  const meq = me.trim().toLowerCase();
  const isMe = nick => !!meq && (nick || '').trim().toLowerCase() === meq;
  const pick = rows => {
    let scoped = rows || [];
    if (verifiedOnly) scoped = scoped.filter(r => r.tier !== 'normal');
    if (tier !== 'all') scoped = scoped.filter(r => r.tier === tier);
    // Rank WITHIN the current filter scope (board is already in competitive order), so verified-only
    // shows verified-only ranks rather than positions that count hidden non-merchants.
    const ranked = scoped.map((r, i) => ({ ...r, _rank: i + 1 }));
    return q ? ranked.filter(r => (r.nick || '').toLowerCase().includes(q)) : ranked.slice(0, 12);
  };
  const myPos = rows => { if (!meq) return null; const m = (rows || []).filter(r => isMe(r.nick)).sort((a, b) => a.rank - b.rank)[0]; return m ? { rank: m.rank, price: m.price, tier: m.tier } : null; };

  const TICK = 0.01;
  // Joint round-trip optimiser: find the most competitive (highest-rank) sell+buy pair on BOTH
  // boards whose round-trip margin (sell − buy) stays at/above the floor. Sell ads live on the
  // Buy-USDT board (cheaper = better); buy ads on the Sell-USDT board (higher = better).
  const optimizeRT = (minRT, maxRT, targetRank) => {
    const tierOf = rows => { const m = (rows || []).find(r => isMe(r.nick)); return m ? m.tier : null; };
    let sellComps = (board.buy || []).filter(r => !isMe(r.nick) && r.price > 0);
    let buyComps = (board.sell || []).filter(r => !isMe(r.nick) && r.price > 0);
    if (pm.scope === 'tier') { const t = tierOf(board.buy) || tierOf(board.sell); if (t) { sellComps = sellComps.filter(r => r.tier === t); buyComps = buyComps.filter(r => r.tier === t); } }
    if (!sellComps.length || !buyComps.length) return null;
    const sP = r => sellComps[Math.min(r, sellComps.length) - 1].price - TICK;  // price to sit at sell-rank r
    const bP = r => buyComps[Math.min(r, buyComps.length) - 1].price + TICK;    // price to sit at buy-rank r
    const sRankOf = p => sellComps.filter(c => c.price < p).length + 1;
    const bRankOf = p => buyComps.filter(c => c.price > p).length + 1;
    const tr = Math.max(1, targetRank);
    // Can we hold the target rank on both sides while keeping the round-trip floor?
    const sellT = sP(tr), buyT = bP(tr), rtT = r2(sellT - buyT);
    if (rtT >= minRT) return { sell: r2(sellT), buy: r2(buyT), sellRank: tr, buyRank: bRankOf(buyT), rt: rtT, holds: true };
    // Too tight — search the trade-off curve for the best balanced ranks at exactly the floor.
    let best = null;
    const N = Math.min(sellComps.length, 60);
    for (let rs = 1; rs <= N; rs++) {
      const sell = sP(rs);
      let buy = sell - minRT; const buy1 = bP(1); if (buy > buy1) buy = buy1;   // most competitive buy at the floor, capped at #1
      const sr = sRankOf(sell), br = bRankOf(buy);
      const score = Math.max(sr, br) * 1000 + (sr + br);   // minimise the worse rank, then the sum
      if (!best || score < best.score) best = { sell: r2(sell), buy: r2(buy), sellRank: sr, buyRank: br, rt: r2(sell - buy), score };
    }
    return best ? { sell: best.sell, buy: best.buy, sellRank: best.sellRank, buyRank: best.buyRank, rt: best.rt, holds: best.sellRank <= tr && best.buyRank <= tr } : null;
  };

  const upd = new Date(updatedAt || Date.now()).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div className="spk">
      <style>{SPK_CSS}</style>

      <div className="panel">
        <div className="page-head">
          <div>
            <div className="ttl"><span className="hi"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2 4 14h6l-1 8 9-12h-6z" /></svg></span>Price Tracker</div>
            <div className="sub">Live Binance P2P · USDT/KES{updatedAt ? ` · updated ${upd}` : ''}</div>
          </div>
          <div className="right"><button className="btn-refresh" onClick={load} disabled={loading}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }}><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" /></svg>Refresh</button></div>
        </div>

        {err ? <div className="empty-line" style={{ color: '#ff6b6b' }}>{err}</div> : !board ? <div className="empty-line">Loading live prices…</div> : (() => {
          const vf = rows => verifiedOnly ? (rows || []).filter(r => r.tier !== 'normal') : (rows || []);
          const buy = cleanSide(vf(board.buy)), sell = cleanSide(vf(board.sell));
          const ask = buy[0]?.price || 0, bid = sell[0]?.price || 0;
          const askMed = medOf(buy.slice(0, 10).map(r => r.price)), bidMed = medOf(sell.slice(0, 10).map(r => r.price));
          const spread = r2(askMed - bidMed);
          const buyLiq = buy.reduce((s, r) => s + (Number(r.available) || 0), 0);
          const sellLiq = sell.reduce((s, r) => s + (Number(r.available) || 0), 0);
          const merchants = new Set([...buy, ...sell].map(r => (r.nick || '').toLowerCase()).filter(Boolean)).size;
          const spSeries = hist.map(p => r2((p.ask_med || 0) - (p.bid_med || 0)));
          const kpis = [
            { l: 'Buy USDT From', v: ask.toFixed(2), s: 'cheapest ask', c: 'blue', d: hist.map(p => p.ask) },
            { l: 'Sell USDT To', v: bid.toFixed(2), s: 'highest bid', c: 'green', d: hist.map(p => p.bid) },
            { l: 'Maker Spread', v: (spread > 0 ? '+' : '') + spread.toFixed(2), s: 'round-trip / USDT', c: 'amber', d: spSeries },
            { l: 'Buy Liquidity', v: fmt2(buyLiq), s: 'USDT on offer', c: 'blue', d: hist.map(p => p.buy_liq) },
            { l: 'Sell Liquidity', v: fmt2(sellLiq), s: 'USDT bid', c: 'green', d: hist.map(p => p.sell_liq) },
            { l: 'Merchants', v: String(merchants), s: 'live on the book', c: '', d: null },
          ];
          const insights = buildInsights({ buy, sell, ask, bid, askMed, bidMed, spread, hist, meq });
          const Ladder = (rows, side) => {
            const top = rows.slice(0, 8); const maxA = Math.max(1, ...top.map(r => Number(r.available) || 0));
            const prices = rows.map(r => r.price).filter(Boolean);
            const mn = prices.length ? Math.min(...prices) : 0, mx = prices.length ? Math.max(...prices) : 0, w = (mx - mn) || 1, bins = 12;
            const counts = Array(bins).fill(0); prices.forEach(p => counts[Math.min(bins - 1, Math.floor((p - mn) / w * bins))]++);
            const cmax = Math.max(1, ...counts);
            return (
              <div className={`book ${side}`}>
                <h4>{side === 'buy' ? 'Buy USDT — cheapest asks' : 'Sell USDT — highest bids'}</h4>
                {top.map((r, i) => (
                  <div key={r.advNo} className={`lvl t-${r.tier}`}>
                    <span className="rk">#{i + 1}</span><span className="nm" title={r.nick}>{r.nick}</span>
                    <span className="px">{r.price.toFixed(2)}</span>
                    <span className="track"><i style={{ width: `${Math.max(5, (Number(r.available) || 0) / maxA * 100)}%` }} /></span>
                  </div>
                ))}
                {top.length === 0 && <div className="book-empty">No live ads.</div>}
                {prices.length >= 4 && <>
                  <div className="hist">{counts.map((c, i) => <b key={i} style={{ height: `${c / cmax * 100}%` }} title={`KES ${(mn + w * i / bins).toFixed(2)} · ${c}`} />)}</div>
                  <div className="hist-ax"><span>{mn.toFixed(2)}</span><span>price spread — where merchants cluster</span><span>{mx.toFixed(2)}</span></div>
                </>}
              </div>
            );
          };
          return (
            <>
              <div className="toggle-row">
                <div className={`switch${verifiedOnly ? '' : ' off'}`} onClick={() => { const v = !verifiedOnly; setVerifiedOnly(v); if (v && tier === 'normal') setTier('all'); }} />
                <div>
                  <div className="tt">Verified Merchant Ads only</div>
                  <div className="td">{verifiedOnly ? 'Every metric, graph and list below counts verified merchants only (Gold · Silver · Bronze).' : 'Counting all advertisers — verified merchants and non-merchants.'}</div>
                </div>
              </div>

              <div className="stats s6">
                {kpis.map((x, i) => (
                  <div className="stat" key={i}>
                    <div className="sl">{x.l}</div>
                    <div className={`sv ${x.c}`}>{x.v}</div>
                    <div className="ss">{x.s}</div>
                    {x.d && x.d.filter(v => v != null).length > 1 && <div className="chart" dangerouslySetInnerHTML={{ __html: spark(x.d, CVAR[x.c] || '#929AA6') }} />}
                  </div>
                ))}
              </div>

              {insights.length > 0 && (
                <div className="insights">
                  {insights.map((x, i) => {
                    const parts = x.text.split(' — ');
                    return (
                      <div className={`insight ${x.t}`} key={i}>
                        <span className="ii" dangerouslySetInnerHTML={{ __html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${INS_ICON[x.t]}</svg>` }} />
                        <span><b>{parts[0]}</b>{parts.length > 1 ? ' — ' + parts.slice(1).join(' — ') : ''}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="depth">{Ladder(buy, 'buy')}{Ladder(sell, 'sell')}</div>
              <div className="footnote">Sparklines show the last 6 hours · Maker spread = median ask − median bid (a typical round-trip margin per USDT). Spoof / outlier ads are filtered.</div>
            </>
          );
        })()}
      </div>

      {board && (() => {
        const pb = myPos(board.buy), ps = myPos(board.sell);
        return (
          <>
            {/* Track + watchlist */}
            <div className="panel panel-gap">
              <div className="track-row">
                <div className="pill-group">
                  {TIERS.map(t => (
                    <button key={t.key} className={`fpill${tier === t.key ? ' on' : ''}`} onClick={() => setTier(t.key)}>
                      {t.key !== 'all' && <span className={`d d-${t.key}`} />}{t.label}
                    </button>
                  ))}
                </div>
                <div className="searchbox">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4-4" /></svg>
                  <input placeholder="Track a merchant — search by name…" value={query} onChange={e => setQuery(e.target.value)} />
                </div>
              </div>
              {q && !isWatched(query.trim()) && (
                <div style={{ marginTop: 12 }}><button className="fpill on" onClick={() => toggleWatch(query.trim())} disabled={watchBusy === query.trim().toLowerCase()}>＋ Track “{query.trim()}”</button></div>
              )}

              <div className="divider" />

              <div className="bname">
                <span className="lab">Your Binance name</span>
                <span className="ipw"><input placeholder="auto-detected from your Binance API" value={me} onChange={e => saveMe(e.target.value)} />{me && <span className="clr" onClick={() => saveMe('')}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M6 6l12 12M18 6 6 18" /></svg></span>}</span>
                <button className="btn-link" onClick={detect} disabled={detecting}>{detecting ? 'Detecting…' : 'Detect from Binance'}</button>
              </div>
              {binanceName && me === binanceName && <div className="ok-line"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6 9 17l-5-5" /></svg>Auto-detected from your Binance API</div>}
              {detectMsg && <div className="note">{detectMsg}</div>}
              {meq && (pb || ps
                ? <div className="pos-line">{pb && <>Buy-USDT <b>#{pb.rank}</b> · KES {pb.price.toFixed(2)}</>}{pb && ps && '   ·   '}{ps && <>Sell-USDT <b>#{ps.rank}</b> · KES {ps.price.toFixed(2)}</>}</div>
                : <div className="note">No live ad found for “{me}” in the current results — you may not be advertising, or you're ranked beyond what we pull.</div>)}

              <div className="divider" />

              <div className="wl-head">
                <span className="wt"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" /><circle cx="12" cy="12" r="3" /></svg>Watchlist <span className="wl-count">{watch.length}</span></span>
                <span className="wh">Star any merchant below to track them — you'll get a Telegram alert when their rank moves.</span>
              </div>
              {watch.length === 0
                ? <div className="empty-line">No merchants tracked yet. Tap the ☆ next to any merchant (or search a name and “Track”) to start watching them.</div>
                : <div className="wl-chips">{watch.map(nick => { const a = posOf(board.buy, nick), b = posOf(board.sell, nick); return (
                    <span className="wl-chip" key={nick}>{nick}<span className="pos">{a ? ` B#${a.rank}` : ''}{b ? ` S#${b.rank}` : ''}</span><button onClick={() => toggleWatch(nick)} disabled={watchBusy === nick.toLowerCase()}>×</button></span>
                  ); })}</div>}
            </div>

            {/* Alerts & Targets */}
            <div className="panel panel-gap">
              <div className="panel-head">
                <div className="ph-t"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 6 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H2a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 3.3 6l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H8a1.7 1.7 0 0 0 1-1.5V2a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V8a1.7 1.7 0 0 0 1.5 1H22a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>Alerts &amp; Targets</div>
                <span className="alerts-pill" onClick={() => setAlertsCollapsed(c => !c)} style={pm.enabled ? undefined : { background: 'rgba(255,255,255,.05)', color: 'var(--text-3)' }}>
                  {pm.enabled ? 'Alerts ON' : 'Alerts off'} <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d={alertsCollapsed ? 'M6 9l6 6 6-6' : 'M6 15l6-6 6 6'} /></svg>
                </span>
              </div>
              <div className={`alerts-body${alertsCollapsed ? ' collapsed' : ''}`}>
                <label className="chk"><input type="checkbox" checked={pm.enabled} onChange={e => setPm({ ...pm, enabled: e.target.checked })} />Enable rank alerts via Telegram</label>
                <div className="tg-row">
                  {tgConnected ? <span className="tg-ok"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6 9 17l-5-5" /></svg>Telegram connected</span> : <span className="tg-bad">⚠ Telegram not connected — link it in Settings</span>}
                  {tgConnected && <button className="btn-soft" onClick={sendTest} disabled={testing}>{testing ? 'Sending…' : 'Send test alert'}</button>}
                  {testMsg && <span style={{ fontSize: 12.5, color: testMsg.includes('✓') ? 'var(--green-2)' : '#ef6a7e' }}>{testMsg}</span>}
                </div>
                <div className="grid-2">
                  <div><div className="flabel">Target rank</div>
                    <select className="sel" value={pm.target} onChange={e => setPm({ ...pm, target: e.target.value })}><option value={1}>Top 1</option><option value={2}>Top 2</option><option value={3}>Top 3</option><option value={5}>Top 5</option><option value={10}>Top 10</option></select></div>
                  <div><div className="flabel">Compare against</div>
                    <select className="sel" value={pm.scope} onChange={e => setPm({ ...pm, scope: e.target.value })}><option value="all">Whole table</option><option value="tier">My tier only</option></select></div>
                </div>
                <div className="flabel">Notify me when…</div>
                <div className="notify-grid">
                  {[['drop', 'I drop out of my target rank'], ['reached', 'I reach / regain my target rank (e.g. become #1)'], ['overtaken', 'Someone overtakes me'], ['top1', 'The #1 merchant changes'], ['anomaly', 'The market turns aggressive (price spike / spread squeeze)'], ['watchlist', 'A merchant on my watchlist moves rank'], ['summary', 'Send a periodic rank summary (every 6h)']].map(([k, lbl]) => (
                    <label className="chk" key={k}><input type="checkbox" checked={pm[k]} onChange={e => setPm({ ...pm, [k]: e.target.checked })} />{lbl}</label>
                  ))}
                </div>
                <div className="flabel">Auto-pricing</div>
                {profile?.pm_autoprice_error && <div className="note" style={{ color: '#ef6a7e' }}>⚠ {profile.pm_autoprice_error}</div>}
                <select className="sel" style={{ maxWidth: 520 }} value={pm.autoprice} onChange={e => setPm({ ...pm, autoprice: e.target.value })}><option value="off">Off — monitor / alerts only</option><option value="sim">Simulate — preview the price it would set (no change)</option><option value="live">Live — auto-reprice to hold my rank</option></select>
                {pm.autoprice !== 'off' && (
                  <>
                    <div className="margin-grid" style={{ marginTop: 18 }}>
                      <div><div className="flabel" style={{ marginTop: 0 }}>Min round-trip margin (sell − buy)</div><input className="minp" type="number" step="0.01" value={pm.marginMin} onChange={e => setPm({ ...pm, marginMin: e.target.value })} /></div>
                      <div><div className="flabel" style={{ marginTop: 0 }}>Max round-trip margin</div><input className="minp" type="number" step="0.01" value={pm.marginMax} onChange={e => setPm({ ...pm, marginMax: e.target.value })} /></div>
                    </div>
                    <div className="note" style={{ marginTop: 12 }}>Round-trip margin = your sell price − your buy price (profit per USDT across both ads). The bot jointly optimises both ads — pushing each as competitive as the floor allows to rank as high as possible on both boards, never dropping below your min. Live price-changing needs your desktop relay online.</div>
                    {pm.autoprice === 'live' && <div className="note" style={{ color: board?.relay_connected ? 'var(--green-2)' : '#ef6a7e', fontWeight: 700 }}>{board?.relay_connected ? '🟢 Relay online — auto-pricing is ACTIVE.' : '🔴 Relay offline — auto-pricing is PAUSED. Open your desktop app.'}</div>}
                  </>
                )}
                <div><button className="btn-primary" onClick={savePm} disabled={pmSaving}>{pmSaving ? 'Saving…' : 'Save settings'}</button>{pmMsg && <span className="save-msg">{pmMsg}</span>}</div>
              </div>
            </div>

            {/* Cost-basis sell-down readout */}
            <CostBasisCard />

            {/* Auto-pricing simulation */}
            {pm.autoprice === 'sim' && meq && (() => {
              const minRT = parseFloat(pm.marginMin) || 0, maxRT = parseFloat(pm.marginMax) || minRT;
              const tr = Number(pm.target) || 1;
              const opt = optimizeRT(minRT, maxRT, tr);
              if (!opt) return null;
              const cards = [
                { l: 'Sell ad → would set', v: opt.sell.toFixed(2), c: 'green', sub: `ranks #${opt.sellRank} on Buy-USDT`, warn: opt.sellRank > tr },
                { l: 'Buy ad → would set', v: opt.buy.toFixed(2), c: 'blue', sub: `ranks #${opt.buyRank} on Sell-USDT`, warn: opt.buyRank > tr },
                { l: 'Round-trip margin', v: opt.rt.toFixed(2), c: opt.rt > 0 ? 'green' : 'amber', sub: 'sell − buy per USDT' },
                { l: `Holds Top ${tr}?`, v: opt.holds ? 'Yes' : 'No', c: opt.holds ? 'green' : 'amber', sub: opt.holds ? 'best margin at this rank' : 'best balance at your floor' },
              ];
              return (
                <div className="panel panel-gap">
                  <div className="panel-head"><div className="ph-t"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2 4 14h6l-1 8 9-12h-6z" /></svg>Auto-pricing — simulation preview</div><span className="alerts-pill" style={{ background: 'var(--amber-soft)', color: 'var(--amber-2)', borderColor: 'rgba(245,166,35,.25)', cursor: 'default' }}>Simulation only</span></div>
                  <div className="sim-grid">{cards.map((c, i) => <div className="sim" key={i}><div className="sl">{c.l}</div><div className={`sv ${c.c}`}>{c.v}</div><div className="sim-sub" style={c.warn ? { color: 'var(--amber-2)' } : undefined}>{c.sub}</div></div>)}</div>
                  {opt.holds
                    ? <div className="note" style={{ marginTop: 14, color: 'var(--green-2)' }}>✓ The algorithm holds <b style={{ color: 'var(--text)' }}>Top {tr} on both sides</b> at KES {opt.rt.toFixed(2)} round-trip. Switch Auto-pricing to <b style={{ color: 'var(--text)' }}>Live</b> to maintain it automatically.</div>
                    : <div className="note" style={{ marginTop: 14, color: 'var(--amber-2)' }}>⚖ Best the algorithm can do at a KES {minRT.toFixed(2)} round-trip floor: <b style={{ color: 'var(--text)' }}>Sell #{opt.sellRank} / Buy #{opt.buyRank}</b> (it pushes both ads as competitive as the floor allows). The market is too tight to hold Top {tr} on both at this margin — lower your <b style={{ color: 'var(--text)' }}>min round-trip margin</b> to climb higher, or keep it to protect profit.</div>}
                </div>
              );
            })()}

            {/* Full merchant ranking */}
            <div className="panel panel-gap">
              <div className="panel-head"><div className="ph-t"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0M16 3.5a3 3 0 0 1 0 6" /></svg>Merchant ranking — live order book</div><span className="alerts-pill" style={{ background: 'var(--card-2)', color: 'var(--text-2)', borderColor: 'var(--line-2)', cursor: 'default' }}>☆ tap a star to track</span></div>
              <div className="depth">
                {[['buy', 'Buy USDT', '“merchant is selling”', 'cheapest first — best to buy from'], ['sell', 'Sell USDT', '“merchant is buying”', 'highest first — best to sell to']].map(([side, ttl, sub, hint]) => {
                  const rows = pick(side === 'buy' ? board.buy : board.sell);
                  return (
                    <div className={`book ${side}`} key={side}>
                      <div className="book-head"><div><h4>{ttl}</h4><span className="book-sub">{sub}</span></div><span className="book-hint">{hint}</span></div>
                      {rows.map(r => (
                        <div className={`mrow t-${r.tier}`} key={r.advNo}>
                          <span className="m-rk">{r._rank}</span>
                          <div className="m-main">
                            <div className="m-top">
                              <span className="m-dot" />
                              <span className="m-nm" title="Click to copy" onClick={() => copyNick(r.nick, r.advNo)}>{r.nick}</span>
                              {copied === r.advNo && <span className="copied">✓</span>}
                              {isMe(r.nick) && <span className="me-tag">YOU</span>}
                              {!isMe(r.nick) && <button className={`star${isWatched(r.nick) ? ' on' : ''}`} onClick={() => toggleWatch(r.nick)} disabled={watchBusy === r.nick.trim().toLowerCase()} dangerouslySetInnerHTML={{ __html: STAR }} />}
                            </div>
                            <div className="m-sub"><span className={`tier ${r.tier}`}>{r.tier.toUpperCase()}</span><span className="m-pct">{r.finishRate}%</span><span className="m-trades">{Number(r.orders30d || 0).toLocaleString()} trades</span></div>
                          </div>
                          <div className="m-right"><div className="m-px">{Number(r.price).toFixed(2)}</div><div className="m-amt">{fmt2(r.available)}</div></div>
                        </div>
                      ))}
                      {rows.length === 0 && <div className="book-empty">{q ? `No “${query}” here.` : 'No merchants.'}</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        );
      })()}
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
