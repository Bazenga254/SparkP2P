import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import api, { getProfile, getWallet, getOrderStats, getOrders, exportOrders, requestWithdrawal, requestWithdrawalOtp, getWalletTransactions, getSessionHealth, getBinanceAccountData, getMarketPrices, getMyAdPrices, getTodayStats, postBotLog, getMyBotLogs, initiateDeposit, getDepositHistory, checkDepositStatus, internalTransfer, getSystemStatus, getMyAffiliate, getMyReferrals, getMyPayouts, applyForAffiliate, updateProfile, choiceGetBalance, choiceDeposit, choiceDepositStatus, getMyTransactions, getCbWithdrawalBank, saveCbWithdrawalBank, cbWithdrawToBank, cbWithdrawInitiate, cbWithdrawToMpesaInitiate, initiateSubscription, getSubscriptionStatus, getCredits, buyCredits, getRateLimit, getPaymentInfo, payChoiceInitiate, payChoiceConfirm, subscriptionDepositInitiate } from '../services/api';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { isNative } from '../mobile/relayAgent';
import { Wallet, TrendingUp, TrendingDown, ArrowDownCircle, ArrowUpCircle, ArrowDown, ArrowUp, RefreshCw, LogOut, Settings, Clock, Shield, Plus, X, Bell, Copy, CreditCard, Eye, EyeOff, MessageSquare, Activity, BarChart2, DollarSign, Repeat, SlidersHorizontal, Share2, Users, ChevronDown, ChevronUp, ChevronRight, LayoutDashboard, List, ArrowRightLeft, MoreHorizontal, Wifi } from 'lucide-react';
import SettingsPanel from '../components/SettingsPanel';
import { kycCreateSession } from '../services/api';
import SupportChat from '../components/SupportChat';
import PriceTracker from '../components/PriceTracker';
import MarketActivity from '../components/MarketActivity';
import SquadPanel from '../components/SquadPanel';
import MobileRelayBanner from '../components/MobileRelayBanner';

// Settlement withdrawal fee shown in the withdrawal confirm dialog (M-Pesa / PesaLink rail).
// tx_fee on transaction rows comes from the backend (outbound_fees.py) — no duplication needed.
const MPESA_MIN_WITHDRAWAL = 1501;
function mpesaOutboundFee(amount) {
  const a = amount || 0;
  if (a <= 100)   return 8;
  if (a <= 1000)  return 14;
  if (a <= 1500)  return 16;
  if (a <= 2500)  return 20;
  if (a <= 3500)  return 21;
  if (a <= 7500)  return 24;
  if (a <= 15000) return 28;
  if (a <= 25000) return 31;
  if (a <= 30000) return 32;
  if (a <= 40000) return 39;
  return 40;
}
function pesalinkOutboundFee(amount) {
  return (amount || 0) <= 1000 ? 15 : 30;
}
function getWithdrawalFee(method, amount) {
  if (amount <= 0) return 0;
  return method === 'mpesa' ? mpesaOutboundFee(amount) : pesalinkOutboundFee(amount);
}
const fmtCountdown = (secs) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
const fmtKES = (n) => 'KES ' + Math.abs(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
const fmtKESFee = (n) => 'KES ' + Math.abs(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDateEAT = (ts) => new Date(ts).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });
const fmtTimeEAT = (ts) => new Date(ts).toLocaleTimeString('en-KE', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit', second: '2-digit' });

const SUPPORTED_COINS = ['USDT', 'USDC', 'BTC', 'ETH', 'BNB', 'BUSD'];

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const fmtCompact = (n) => {
  const x = Math.abs(n || 0);
  if (x >= 1e6) return (n < 0 ? '-' : '') + (x / 1e6).toFixed(2) + 'M';
  if (x >= 1e3) return (n < 0 ? '-' : '') + (x / 1e3).toFixed(1) + 'K';
  return Math.round(n || 0).toString();
};
const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const PROFIT_METRICS = {
  net:    { label: 'Profit', color: '#10b981', neg: '#ef4444', fmt: (v) => fmtKES(v),                          axis: (v) => fmtCompact(v) },
  volume: { label: 'Volume', color: '#3b82f6', neg: '#3b82f6', fmt: (v) => 'KES ' + fmtCompact(v),             axis: (v) => fmtCompact(v) },
  spread: { label: 'Margin', color: '#f59e0b', neg: '#ef4444', fmt: (v) => 'KES ' + (v || 0).toFixed(2),       axis: (v) => (v || 0).toFixed(2) },
  price:  { label: 'Price',  color: '#a78bfa', neg: '#a78bfa', fmt: (v) => 'KES ' + (v || 0).toFixed(2),       axis: (v) => (v || 0).toFixed(2) },
};

function SubscriptionLock({ onUnlock, title = 'Your subscription has expired', sub = 'Renew your plan to unlock this.' }) {
  return (
    <div style={{ maxWidth: 460, margin: '60px auto', textAlign: 'center', background: 'linear-gradient(180deg,#161a26,#10131c)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 18, padding: '36px 28px', boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}>
      <div style={{ fontSize: 46, marginBottom: 8 }}>🔒</div>
      <h2 style={{ color: '#fff', fontSize: 20, margin: '0 0 8px' }}>{title}</h2>
      <p style={{ color: '#9aa4b2', fontSize: 13.5, margin: '0 0 22px', lineHeight: 1.5 }}>{sub}</p>
      <button onClick={onUnlock}
        style={{ background: '#f59e0b', color: '#1a1205', border: 'none', borderRadius: 12, padding: '13px 26px', fontWeight: 800, fontSize: 14.5, cursor: 'pointer' }}>
        Click here to subscribe →
      </button>
    </div>
  );
}

function ProfitPage() {
  const [view, setView] = useState('week');     // week | month | year (range preset)
  const [offset, setOffset] = useState(0);       // 0 = current, -1 = previous period…
  const [metric, setMetric] = useState('net');   // net | volume | spread | price
  const [asset, setAsset] = useState('ALL');     // ALL | USDT | USDC | BTC …
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  // Resolve bucket + range from the view preset + offset.
  // The backend buckets the trading day at 00:00 UTC (= 03:00 EAT, matching Binance's reset),
  // so build a pseudo-UTC "now" whose local-field getters (getDate/getDay/…) read in UTC.
  // This keeps all the date math below unchanged while producing UTC-correct date strings.
  const now = new Date(Date.now() + new Date().getTimezoneOffset() * 60000);
  let bucket, startD, endD, rangeLabel;
  if (view === 'today') {
    const d = new Date(now); d.setDate(d.getDate() + offset);
    bucket = 'hour'; startD = d; endD = d;
    rangeLabel = offset === 0 ? 'Today' : `${MONTH_NAMES[d.getMonth()].slice(0,3)} ${d.getDate()}`;
  } else if (view === 'week') {
    const d = new Date(now); const dow = (d.getDay() + 6) % 7; // Mon=0
    d.setDate(d.getDate() - dow + offset * 7);
    const e = new Date(d); e.setDate(e.getDate() + 6);
    bucket = 'day'; startD = d; endD = e;
    rangeLabel = `${MONTH_NAMES[d.getMonth()].slice(0,3)} ${d.getDate()} – ${MONTH_NAMES[e.getMonth()].slice(0,3)} ${e.getDate()}`;
  } else if (view === 'month') {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const e = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    bucket = 'day'; startD = d; endD = e;
    rangeLabel = `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
  } else {
    const y = now.getFullYear() + offset;
    bucket = 'month'; startD = new Date(y, 0, 1); endD = new Date(y, 11, 31);
    rangeLabel = `${y}`;
  }
  const start = isoLocal(startD), end = isoLocal(endD);
  const isCurrent = offset === 0;

  useEffect(() => {
    let cancel = false; setLoading(true);
    api.get('/traders/profit-series', { params: { bucket, start, end, asset } })
      .then(r => { if (!cancel) setData(r.data); })
      .catch(() => { if (!cancel) setData(null); })
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [bucket, start, end, asset]);

  const rows = data?.rows || [];
  const total = data?.total || {};
  const M = PROFIT_METRICS[metric];
  const vals = rows.map(r => r[metric] || 0);
  const maxPos = Math.max(0, ...vals, 0);
  const maxNeg = Math.max(0, ...vals.map(v => -v), 0);
  const span = (maxPos + maxNeg) || 1;
  const H = 210;
  const zeroTop = (maxPos / span) * H;
  const tabBtn = (active) => ({ padding: '5px 14px', borderRadius: 16, border: '1px solid',
    borderColor: active ? '#10b981' : 'var(--border)', background: active ? 'rgba(16,185,129,0.15)' : 'transparent',
    color: active ? '#10b981' : '#9ca3af', fontSize: 12, fontWeight: 600, cursor: 'pointer' });
  const navBtn = (dis) => ({ width: 32, height: 32, borderRadius: 8, border: '1px solid var(--border)', background: 'transparent',
    color: dis ? '#374151' : '#cbd5e1', fontSize: 18, cursor: dis ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' });

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      {/* Header: range preset + metric */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <BarChart2 size={20} style={{ color: '#10b981' }} />
          <h3>Profit Tracker</h3>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[['today','Today'],['week','This Week'],['month','This Month'],['year','This Year']].map(([v, l]) => (
              <button key={v} onClick={() => { setView(v); setOffset(0); }} style={tabBtn(view === v)}>{l}</button>
            ))}
          </div>
        </div>

        {/* Period nav + metric selector */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, padding: '6px 0 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={() => setOffset(o => o - 1)} style={navBtn(false)}>‹</button>
            <span style={{ fontWeight: 700, fontSize: 15, color: '#e5e7eb', minWidth: 150, textAlign: 'center' }}>{rangeLabel}{isCurrent ? ' · now' : ''}</span>
            <button onClick={() => !isCurrent && setOffset(o => o + 1)} disabled={isCurrent} style={navBtn(isCurrent)}>›</button>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            {(data?.assets?.length > 1) && (
              <div style={{ display: 'flex', gap: 4, marginRight: 8, paddingRight: 8, borderRight: '1px solid var(--border)' }}>
                {['ALL', ...data.assets].map(a => (
                  <button key={a} onClick={() => setAsset(a)}
                    style={{ ...tabBtn(asset === a), fontSize: 11, color: asset === a ? '#f59e0b' : '#9ca3af', borderColor: asset === a ? '#f59e0b' : 'var(--border)', background: asset === a ? '#f59e0b22' : 'transparent' }}>
                    {a === 'ALL' ? 'All coins' : a}
                  </button>
                ))}
              </div>
            )}
            {Object.entries(PROFIT_METRICS).map(([k, m]) => (
              <button key={k} onClick={() => setMetric(k)}
                style={{ ...tabBtn(metric === k), borderColor: metric === k ? m.color : 'var(--border)',
                  background: metric === k ? `${m.color}22` : 'transparent', color: metric === k ? m.color : '#9ca3af' }}>
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {/* Summary strip */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', paddingBottom: 6 }}>
          {[['Net Profit', fmtKES(total.net), (total.net || 0) >= 0 ? '#10b981' : '#ef4444'],
            ['Volume', 'KES ' + fmtCompact(total.volume), '#3b82f6'],
            ['Avg Margin', 'KES ' + (total.spread || 0).toFixed(2), '#f59e0b'],
            ['Trades', (total.trades || 0).toLocaleString(), '#e5e7eb']].map(([l, v, c]) => (
            <div key={l} style={{ flex: 1, minWidth: 130, background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px' }}>
              <div style={{ fontSize: 11, color: '#6b7280' }}>{l}</div>
              <div style={{ fontSize: 17, fontWeight: 800, color: c }}>{v}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <BarChart2 size={18} style={{ color: M.color }} /><h3>{M.label} — {rangeLabel}</h3>
          {(metric === 'price' || metric === 'volume') && (
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 14, fontSize: 11, color: '#9ca3af' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: '#3b82f6' }} />Buy</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: '#10b981' }} />Sell</span>
            </span>
          )}
        </div>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: '#6b7280' }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: '#6b7280' }}>No data for this period.</div>
        ) : (metric === 'price' || metric === 'volume') ? (() => {
          // Dual Buy + Sell bars. Volume: 0-based (buy vs sell KES). Price: zoomed to min/max
          // (prices barely vary, so a 0-based axis would look flat).
          const isVol = metric === 'volume';
          const bk = isVol ? 'buy_volume' : 'buy_rate';
          const sk = isVol ? 'sell_volume' : 'sell_rate';
          const vals = rows.flatMap(r => [r[bk], r[sk]].filter(x => x > 0));
          const hiV = vals.length ? Math.max(...vals) : 1;
          let pMin, pSpan, topLbl, midLbl, botLbl;
          const F = isVol ? (x) => 'KES ' + fmtCompact(x) : (x) => x.toFixed(2);
          if (isVol) {
            pMin = 0; pSpan = hiV || 1;
            topLbl = F(hiV); midLbl = F(hiV / 2); botLbl = '0';
          } else {
            const lo = vals.length ? Math.min(...vals) : 0;
            const pad = (hiV - lo) * 0.25 || 0.5;
            pMin = lo - pad; pSpan = (hiV + pad - pMin) || 1;
            topLbl = F(hiV + pad); midLbl = F((hiV + pad + pMin) / 2); botLbl = F(pMin);
          }
          const bh = (v) => (v > 0 ? Math.max(2, (v - pMin) / pSpan * H) : 0);
          return (
            <div style={{ display: 'flex', gap: 8, paddingTop: 8 }}>
              <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', height: H, width: 56, textAlign: 'right', paddingBottom: 22 }}>
                <span style={{ fontSize: 10, color: '#6b7280' }}>{topLbl}</span>
                <span style={{ fontSize: 10, color: '#6b7280' }}>{midLbl}</span>
                <span style={{ fontSize: 10, color: '#6b7280' }}>{botLbl}</span>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: rows.length > 16 ? 1 : 4, height: H }}>
                  {rows.map((r) => (
                    <div key={r.key} style={{ flex: 1, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 2, minWidth: 0 }}
                      title={isVol ? `${r.label} — Buy KES ${fmtCompact(r.buy_volume)} · Sell KES ${fmtCompact(r.sell_volume)}`
                                   : `${r.label} — Buy ${r.buy_rate || '—'} · Sell ${r.sell_rate || '—'} (spread ${(r.spread || 0).toFixed(2)})`}>
                      <div style={{ width: '42%', height: bh(r[bk]), background: '#3b82f6', borderRadius: '2px 2px 0 0', opacity: 0.9 }} />
                      <div style={{ width: '42%', height: bh(r[sk]), background: '#10b981', borderRadius: '2px 2px 0 0', opacity: 0.9 }} />
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: rows.length > 16 ? 1 : 4, marginTop: 4 }}>
                  {rows.map((r, i) => (
                    <div key={r.key} style={{ flex: 1, textAlign: 'center', fontSize: 9, color: '#6b7280', whiteSpace: 'nowrap', overflow: 'hidden' }}>
                      {rows.length > 16 ? (i % 3 === 0 ? r.label.split(' ').pop() : '') : r.label}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })() : (
          <div style={{ display: 'flex', gap: 8, paddingTop: 8 }}>
            {/* Y axis */}
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', height: H, width: 52, textAlign: 'right', paddingBottom: 22 }}>
              <span style={{ fontSize: 10, color: '#6b7280' }}>{M.axis(maxPos)}</span>
              <span style={{ fontSize: 10, color: '#6b7280' }}>0</span>
              {maxNeg > 0 && <span style={{ fontSize: 10, color: '#6b7280' }}>-{M.axis(maxNeg)}</span>}
            </div>
            {/* Bars */}
            <div style={{ flex: 1, position: 'relative' }}>
              <div style={{ position: 'absolute', top: zeroTop, left: 0, right: 0, borderTop: '1px solid #374151' }} />
              <div style={{ display: 'flex', alignItems: 'stretch', gap: rows.length > 16 ? 1 : 4, height: H }}>
                {rows.map((r) => {
                  const v = r[metric] || 0;
                  const barH = Math.max(v !== 0 ? 2 : 0, Math.abs(v) / span * H);
                  const top = v >= 0 ? zeroTop - barH : zeroTop;
                  return (
                    <div key={r.key} style={{ flex: 1, position: 'relative', minWidth: 0 }} title={`${r.label}: ${M.fmt(v)} · ${r.trades || 0} trades`}>
                      <div style={{ position: 'absolute', left: '12%', right: '12%', top, height: barH,
                        background: v >= 0 ? M.color : M.neg, borderRadius: '3px 3px 0 0', opacity: 0.92 }} />
                    </div>
                  );
                })}
              </div>
              {/* X labels */}
              <div style={{ display: 'flex', gap: rows.length > 16 ? 1 : 4, marginTop: 4 }}>
                {rows.map((r, i) => (
                  <div key={r.key} style={{ flex: 1, textAlign: 'center', fontSize: 9, color: '#6b7280', whiteSpace: 'nowrap', overflow: 'hidden' }}>
                    {rows.length > 16 ? (i % 3 === 0 ? r.label.split(' ').pop() : '') : r.label}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Detailed breakdown */}
      <div className="card">
        <div className="card-header"><List size={18} /><h3>Breakdown</h3></div>
        <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <div style={{ minWidth: 460 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr 1fr 1fr 0.7fr', gap: 6, fontSize: 11, color: '#6b7280', padding: '6px 0', borderBottom: '1px solid var(--border)', fontWeight: 600 }}>
              <span>Period</span><span style={{ textAlign: 'right' }}>Profit</span><span style={{ textAlign: 'right' }}>Volume</span><span style={{ textAlign: 'right' }}>Margin</span><span style={{ textAlign: 'right' }}>Trades</span>
            </div>
            {rows.filter(r => r.trades > 0).length === 0 ? (
              <div style={{ textAlign: 'center', padding: '24px 0', color: '#6b7280', fontSize: 13 }}>No trades in this period.</div>
            ) : rows.filter(r => r.trades > 0).map(r => (
              <div key={r.key} style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr 1fr 1fr 0.7fr', gap: 6, fontSize: 13, padding: '9px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <span style={{ color: '#cbd5e1' }}>{r.label}</span>
                <span style={{ textAlign: 'right', fontWeight: 700, color: (r.net || 0) >= 0 ? '#10b981' : '#ef4444' }}>{fmtKES(r.net)}</span>
                <span style={{ textAlign: 'right', color: '#9ca3af' }}>KES {fmtCompact(r.volume)}</span>
                <span style={{ textAlign: 'right', color: '#f59e0b' }}>{(r.spread || 0).toFixed(2)}</span>
                <span style={{ textAlign: 'right', color: '#6b7280' }}>{r.trades}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{ marginTop: 10, fontSize: 10, color: '#6b7280' }}>Realized profit (cost-basis) · includes all completed trades, online or off · use ‹ › to view any past period</div>
      </div>
    </div>
  );
}

function ProfitTracker() {
  const [gran, setGran] = useState('day');          // day | week | month
  const [anchor, setAnchor] = useState('');          // '' = today; otherwise YYYY-MM-DD
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    api.get('/traders/profit-history', { params: { granularity: gran, anchor } })
      .then(r => { if (!cancel) setData(r.data); })
      .catch(() => { if (!cancel) setData(null); })
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [gran, anchor]);

  // Switching granularity resets the view to the current (today's) period
  const switchGran = (g) => { setGran(g); setAnchor(''); };

  const navBtn = (disabled) => ({ width: 32, height: 32, borderRadius: 8, border: '1px solid var(--border)',
    background: 'transparent', color: disabled ? '#374151' : '#cbd5e1', fontSize: 18, lineHeight: 1,
    cursor: disabled ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' });

  const net = data?.net ?? 0;
  const periodWord = gran === 'day' ? "day's" : gran === 'week' ? "week's" : "month's";

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header">
        <BarChart2 size={20} style={{ color: '#10b981' }} />
        <h3>Profit Tracker</h3>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {[['day','Daily'],['week','Weekly'],['month','Monthly']].map(([g, label]) => (
            <button key={g} onClick={() => switchGran(g)}
              style={{ padding: '4px 12px', borderRadius: 16, border: '1px solid',
                borderColor: gran === g ? '#10b981' : 'var(--border)',
                background: gran === g ? 'rgba(16,185,129,0.15)' : 'transparent',
                color: gran === g ? '#10b981' : '#9ca3af', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Period navigation */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, padding: '10px 0 4px' }}>
        <button onClick={() => data?.prev && setAnchor(data.prev)} style={navBtn(false)}>‹</button>
        <span style={{ fontWeight: 700, fontSize: 15, color: '#e5e7eb', minWidth: 160, textAlign: 'center' }}>
          {data?.label || '—'}{data?.is_current ? '  ·  now' : ''}
        </span>
        <button onClick={() => data?.next && setAnchor(data.next)} disabled={!data?.next} style={navBtn(!data?.next)}>›</button>
      </div>

      {/* The one accumulated figure for this period */}
      <div style={{ textAlign: 'center', padding: '14px 0 6px' }}>
        {loading ? (
          <div style={{ color: '#6b7280', fontSize: 14, padding: '14px 0' }}>Loading…</div>
        ) : (
          <>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{`This ${periodWord} profit`}</div>
            <div style={{ fontSize: 38, fontWeight: 800, lineHeight: 1.1, color: net >= 0 ? '#10b981' : '#ef4444' }}>{fmtKES(net)}</div>
            <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 6 }}>
              {(data?.trades || 0).toLocaleString()} trade{(data?.trades === 1) ? '' : 's'} · {fmtKES(data?.volume)} volume
            </div>
          </>
        )}
      </div>

      {/* Gross / fees supporting line */}
      {!loading && (data?.trades > 0) && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 28, padding: '10px 0 2px', borderTop: '1px solid rgba(255,255,255,0.06)', marginTop: 8 }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: '#6b7280' }}>Gross</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#10b981' }}>{fmtKES(data?.gross)}</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: '#6b7280' }}>Binance fees</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#ef4444' }}>− {fmtKES(data?.fees)}</div>
          </div>
        </div>
      )}

      <div style={{ marginTop: 12, fontSize: 10, color: '#6b7280', textAlign: 'center' }}>
        Realized profit (cost-basis) · use ‹ › to view any past {gran === 'day' ? 'day' : gran === 'week' ? 'week' : 'month'}
      </div>
    </div>
  );
}

function SpreadCalculator({ orderStats, profile, cbWithdrawBank }) {
  const [coin, setCoin] = useState('USDT');
  const [buyPrice, setBuyPrice] = useState('130.00');
  const [sellPrice, setSellPrice] = useState('130.50');
  const [volume, setVolume] = useState('500000');
  const [withdrawMethod, setWithdrawMethod] = useState('mpesa');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [autoLoaded, setAutoLoaded] = useState(false);
  const [adSource, setAdSource] = useState(''); // 'orders' | 'ads' | 'market' | ''
  const [missingAd, setMissingAd] = useState(''); // 'buy' | 'sell' | ''
  const [todayStats, setTodayStats] = useState(null); // 24h live stats from backend
  const [statsLoading, setStatsLoading] = useState(true);

  // Priority 1: use actual avg rates from today's completed orders (most accurate)
  useEffect(() => {
    if (!orderStats) return;
    const avgBuy = orderStats.avg_buy_rate;
    const avgSell = orderStats.avg_sell_rate;
    if (avgBuy > 50 || avgSell > 50) {
      if (avgBuy > 50) setBuyPrice(String(avgBuy));
      if (avgSell > 50) setSellPrice(String(avgSell));
      setAutoLoaded(true);
      setAdSource('orders');
      setMissingAd(!avgBuy || avgBuy <= 50 ? 'buy' : !avgSell || avgSell <= 50 ? 'sell' : '');
    }
  }, [orderStats?.avg_buy_rate, orderStats?.avg_sell_rate]);

  useEffect(() => {
    const fetchPrices = async () => {
      // Skip ad/market fetch if we already have real order data for today
      if (orderStats?.avg_buy_rate > 50 && orderStats?.avg_sell_rate > 50) return;

      // Try trader's own ads (fallback when no orders yet today)
      try {
        const adRes = await getMyAdPrices();
        const ad = adRes.data;
        if (ad.connected && (ad.buy || ad.sell)) {
          if (ad.buy) setBuyPrice(String(ad.buy));
          if (ad.sell) setSellPrice(String(ad.sell));
          setAutoLoaded(true);
          setAdSource('ads');
          setMissingAd(!ad.buy ? 'buy' : !ad.sell ? 'sell' : '');
          return;
        }
      } catch (e) {}

      // Fallback to market prices
      try {
        const res = await getMarketPrices();
        const d = res.data;
        if (d.best_buy > 0 && d.best_sell > 0) {
          setBuyPrice(String(d.best_buy));
          setSellPrice(String(d.best_sell));
          setAutoLoaded(true);
          setAdSource('market');
        }
      } catch (e) {}
    };
    fetchPrices();
    const priceInterval = setInterval(fetchPrices, 60000);

    // Live update when the desktop bot pushes fresh scraped prices
    // Only apply if we don't have real order data (order data takes priority)
    const onAdPricesUpdated = (e) => {
      if (orderStats?.avg_buy_rate > 50 && orderStats?.avg_sell_rate > 50) return;
      const { buy: b, sell: s } = e.detail || {};
      if (b && b > 50) { setBuyPrice(String(b)); setAutoLoaded(true); setAdSource('ads'); }
      if (s && s > 50) { setSellPrice(String(s)); setAutoLoaded(true); setAdSource('ads'); }
    };
    window.addEventListener('ad-prices-updated', onAdPricesUpdated);

    return () => {
      clearInterval(priceInterval);
      window.removeEventListener('ad-prices-updated', onAdPricesUpdated);
    };
  }, []);

  // Fetch real 24h stats, reset at midnight EAT
  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await getTodayStats();
        setTodayStats(res.data);
      } catch (e) {
        setTodayStats(null);
      } finally {
        setStatsLoading(false);
      }
    };
    fetchStats();

    // Refresh every 2 minutes so the dashboard stays live
    const statsInterval = setInterval(fetchStats, 120000);

    // Also schedule a refresh right after the next midnight EAT (UTC+3)
    const nowEAT = new Date(Date.now() + 3 * 3600 * 1000);
    const msToMidnightEAT =
      (24 * 3600 - (nowEAT.getUTCHours() * 3600 + nowEAT.getUTCMinutes() * 60 + nowEAT.getUTCSeconds())) * 1000;
    const midnightTimer = setTimeout(fetchStats, msToMidnightEAT + 2000); // +2s buffer

    return () => {
      clearInterval(statsInterval);
      clearTimeout(midnightTimer);
    };
  }, []);

  const buy = parseFloat(buyPrice) || 0;
  const sell = parseFloat(sellPrice) || 0;
  const vol = parseFloat(volume) || 0;
  const spread = sell - buy;
  const spreadPct = buy > 0 ? (spread / buy) * 100 : 0;
  const usdtAmount = buy > 0 ? vol / buy : 0;
  const grossProfit = usdtAmount * spread;
  const profitable = spread > 0;

  // Cash-out analysis — use real 24h gross profit as base, fall back to simulated spread profit
  const realProfit = todayStats?.gross_profit ?? null;
  const baseProfit = realProfit !== null ? realProfit : grossProfit;     // gross (before any fees)
  const binanceFees = todayStats?.fees_kes ?? 0;                          // actual Binance commission (KES)
  const afterBinance = baseProfit - binanceFees;                         // net after Binance fees
  const wdAmt = parseFloat(withdrawAmount) || (afterBinance > 0 ? afterBinance : vol);
  // Withdrawals are paid via CREDITS (deducted from credit balance), not a cash fee —
  // so the trader receives their full balance. No withdrawal fee in the cash-out math.
  const wdFee = 0;
  const wdReceived = wdAmt;
  const netProfit = afterBinance;                                         // net after Binance fees only
  const netProfitable = netProfit > 0;
  const netPct = baseProfit > 0 ? (netProfit / baseProfit) * 100 : 0;
  // Where the withdrawal lands — the trader's configured account
  const wdBankName = cbWithdrawBank?.bank_name || (cbWithdrawBank?.bank_code ? 'Bank (PesaLink)' : null);
  const wdAccount = cbWithdrawBank?.account_number || null;
  const wdDestLabel = wdBankName ? `${wdBankName}${wdAccount ? ' · ' + wdAccount : ''}` : (profile?.settlement_phone ? `M-Pesa · ${profile.settlement_phone}` : 'Not set');
  // Break-even sell price (kept for the Min. Sell Price card; no fee now -> just buy price)
  const breakEvenSpreadKES = 0;
  const breakEvenSell = buy + breakEvenSpreadKES;
  const breakEvenPct = buy > 0 ? (breakEvenSpreadKES / buy) * 100 : 0;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header">
        <TrendingUp size={20} />
        <h3>Margin Calculator</h3>
        {autoLoaded && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: '#10b981', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981', animation: 'pulse-green 1.5s ease-in-out infinite' }} />
            {adSource === 'orders'
              ? `Live from today's ${orderStats?.total_trades ?? ''} order${orderStats?.total_trades !== 1 ? 's' : ''}`
              : adSource === 'ads' ? 'Auto-filled from your ads' : 'Live market prices'}
            {missingAd && (
              <span style={{ color: '#f59e0b', marginLeft: 4 }}>
                ⚠ No {missingAd} ad found — enter {missingAd} price manually
              </span>
            )}
          </span>
        )}
      </div>

      {/* Inputs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 12, padding: '12px 0 0', alignItems: 'end' }}>
        <div>
          <label style={{ fontSize: 12, color: '#9ca3af', display: 'block', marginBottom: 4 }}>Coin</label>
          <select value={coin} onChange={(e) => setCoin(e.target.value)}
            style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 14, fontWeight: 700 }}>
            {SUPPORTED_COINS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 12, color: '#9ca3af', display: 'block', marginBottom: 4 }}>Buy Price (KSh/{coin})</label>
          <input type="number" step="0.01" placeholder="130.23" value={buyPrice} onChange={(e) => setBuyPrice(e.target.value)}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 14 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, color: '#9ca3af', display: 'block', marginBottom: 4 }}>Sell Price (KSh/{coin})</label>
          <input type="number" step="0.01" placeholder="130.74" value={sellPrice} onChange={(e) => setSellPrice(e.target.value)}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 14 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, color: '#9ca3af', display: 'block', marginBottom: 4 }}>
            Simulation Size (KES)
            <span style={{ marginLeft: 5, fontSize: 10, color: '#6b7280', fontWeight: 400 }}>— per trade estimate</span>
          </label>
          <input type="number" step="1000" placeholder="500000" value={volume} onChange={(e) => setVolume(e.target.value)}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 14 }} />
        </div>
      </div>

      {/* Spread % badge */}
      {buy > 0 && sell > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, margin: '12px 0 4px' }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            background: profitable ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)',
            border: `1px solid ${profitable ? '#10b981' : '#ef4444'}`,
            borderRadius: 20, padding: '4px 14px',
          }}>
            <span style={{ fontSize: 12, color: '#9ca3af' }}>Buy</span>
            <span style={{ fontWeight: 700, color: '#fff', fontSize: 14 }}>KSh {buy.toFixed(2)}</span>
            <span style={{ fontSize: 12, color: '#6b7280' }}>→</span>
            <span style={{ fontSize: 12, color: '#9ca3af' }}>Sell</span>
            <span style={{ fontWeight: 700, color: '#fff', fontSize: 14 }}>KSh {sell.toFixed(2)}</span>
            <span style={{ fontSize: 12, color: '#6b7280' }}>|</span>
            <span style={{ fontWeight: 800, fontSize: 15, color: profitable ? '#10b981' : '#ef4444' }}>
              {spreadPct >= 0 ? '+' : ''}{spreadPct.toFixed(3)}% margin
            </span>
          </div>
          {!profitable && (
            <span style={{ fontSize: 12, color: '#ef4444' }}>⚠ Sell below buy — you'd lose money</span>
          )}
        </div>
      )}

      {/* Stats row — left card is simulation, right 3 are real 24h data */}
      {buy > 0 && sell > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 12, marginTop: 10 }}>

          {/* Spread per coin — calculated from inputs */}
          <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: '#9ca3af' }}>Margin per {coin}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: profitable ? '#10b981' : '#ef4444' }}>KSh {spread.toFixed(2)}</div>
            <div style={{ fontSize: 11, color: '#6b7280' }}>{spreadPct.toFixed(3)}%</div>
          </div>

          {/* Crypto Traded — real 24h */}
          <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', border: '1px solid var(--border)', position: 'relative' }}>
            <div style={{ fontSize: 11, color: '#9ca3af', display: 'flex', alignItems: 'center', gap: 4 }}>
              {todayStats?.dominant_currency || coin} Traded
              <span style={{ fontSize: 9, background: 'rgba(16,185,129,0.15)', color: '#10b981', borderRadius: 4, padding: '1px 5px' }}>24h</span>
            </div>
            {statsLoading ? (
              <div style={{ fontSize: 18, fontWeight: 700, color: '#6b7280' }}>—</div>
            ) : todayStats ? (
              <>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#f59e0b' }}>{todayStats.usdt_traded.toFixed(2)}</div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>KES {todayStats.kes_volume.toLocaleString(undefined, { maximumFractionDigits: 0 })} vol</div>
              </>
            ) : (
              <div style={{ fontSize: 14, color: '#6b7280' }}>N/A</div>
            )}
          </div>

          {/* Gross Profit — real 24h */}
          <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: '#9ca3af', display: 'flex', alignItems: 'center', gap: 4 }}>
              Gross Profit
              <span style={{ fontSize: 9, background: 'rgba(16,185,129,0.15)', color: '#10b981', borderRadius: 4, padding: '1px 5px' }}>24h</span>
            </div>
            {statsLoading ? (
              <div style={{ fontSize: 18, fontWeight: 700, color: '#6b7280' }}>—</div>
            ) : todayStats ? (
              <>
                <div style={{ fontSize: 18, fontWeight: 700, color: todayStats.gross_profit >= 0 ? '#10b981' : '#ef4444' }}>
                  {fmtKES(todayStats.gross_profit)}
                </div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>from margin</div>
              </>
            ) : (
              <div style={{ fontSize: 14, color: '#6b7280' }}>N/A</div>
            )}
          </div>

          {/* Trades Today — real 24h */}
          <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: '#9ca3af', display: 'flex', alignItems: 'center', gap: 4 }}>
              Trades Today
              <span style={{ fontSize: 9, background: 'rgba(16,185,129,0.15)', color: '#10b981', borderRadius: 4, padding: '1px 5px' }}>24h</span>
            </div>
            {statsLoading ? (
              <div style={{ fontSize: 18, fontWeight: 700, color: '#6b7280' }}>—</div>
            ) : todayStats ? (
              <>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#a78bfa' }}>{todayStats.trades_count}</div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>resets midnight EAT</div>
              </>
            ) : (
              <div style={{ fontSize: 14, color: '#6b7280' }}>N/A</div>
            )}
          </div>

        </div>
      )}

      {/* Cash-out analysis */}
      {buy > 0 && sell > 0 && profitable && (
        <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 2 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 1 }}>
              Cash-Out Analysis
            </div>
            <div style={{ fontSize: 11, color: realProfit !== null ? '#10b981' : '#6b7280' }}>
              {realProfit !== null ? '● Live — based on today\'s actual trades' : '○ Simulated — no trades yet today'}
            </div>
          </div>
          <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 12 }}>
            {realProfit !== null
              ? `Today's gross profit from ${todayStats.trades_count} trade${todayStats.trades_count !== 1 ? 's' : ''} (${fmtKES(todayStats.kes_volume)} volume) — minus Binance commission. Withdrawals are paid using your credits, so you receive the full amount.`
              : 'Set your buy/sell prices above to see a profit estimate.'}
          </div>

          {/* Withdrawal destination (read-only) + amount */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
            <div>
              <label style={{ fontSize: 12, color: '#9ca3af', display: 'block', marginBottom: 4 }}>Withdrawal Account</label>
              <div style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {wdDestLabel}
              </div>
            </div>
            <div>
              <label style={{ fontSize: 12, color: '#9ca3af', display: 'block', marginBottom: 4 }}>
                {realProfit !== null ? 'Profit to Withdraw (KES)' : 'Amount to Withdraw (KES)'}
              </label>
              <input type="number" step="100"
                placeholder={baseProfit > 0 ? baseProfit.toFixed(0) : vol.toLocaleString()}
                value={withdrawAmount} onChange={(e) => setWithdrawAmount(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 14 }} />
            </div>
          </div>

          {/* Result cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 12 }}>

            {/* Card 1 — Gross Profit */}
            <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, color: '#9ca3af' }}>{realProfit !== null ? 'Today\'s Gross Profit' : 'Est. Gross Profit'}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#10b981' }}>+ {fmtKESFee(baseProfit)}</div>
              <div style={{ fontSize: 11, color: '#6b7280' }}>{realProfit !== null ? 'from completed trades' : 'from margin × volume'}</div>
            </div>

            {/* Card 1b — Binance Fees (flat fee per USDT sold) */}
            {realProfit !== null && (
              <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>Binance Fees</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#ef4444' }}>− {fmtKESFee(binanceFees)}</div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>KES {profile?.binance_fee_per_usdt ?? 0.25}/USDT · buy + sell</div>
              </div>
            )}

            {/* Card 3 — Net Profit (after Binance fees; withdrawal is credit-based, no cash fee) */}
            <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', border: `1px solid ${netProfitable ? '#10b981' : '#ef4444'}` }}>
              <div style={{ fontSize: 11, color: '#9ca3af' }}>Net Profit</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: netProfitable ? '#10b981' : '#ef4444' }}>
                {netProfitable ? '+' : '−'} {fmtKESFee(Math.abs(netProfit))}
              </div>
              <div style={{ fontSize: 11, color: netProfitable ? '#10b981' : '#ef4444' }}>
                {netPct >= 0 ? '+' : ''}{netPct.toFixed(2)}% of gross profit
              </div>
            </div>

            {/* Card 4 — Withdrawal destination */}
            <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, color: '#9ca3af' }}>Withdraw To</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#f59e0b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{wdBankName || (profile?.settlement_phone ? 'M-Pesa' : 'Not set')}</div>
              <div style={{ fontSize: 11, color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{wdAccount || profile?.settlement_phone || 'Set in Settings → Bank Account'}</div>
            </div>

          </div>

          {/* Summary banner */}
          {baseProfit > 0 && (
            <div style={{
              marginTop: 12, padding: '10px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600,
              background: netProfitable ? 'rgba(16,185,129,0.10)' : 'rgba(239,68,68,0.10)',
              border: `1px solid ${netProfitable ? '#10b981' : '#ef4444'}`,
              color: netProfitable ? '#10b981' : '#ef4444',
            }}>
              {netProfitable
                ? `✓ You receive the full ${fmtKES(wdReceived)} to ${wdDestLabel} — withdrawal is paid using your credits, no cash fee`
                : `✗ Binance fees exceed gross by ${fmtKES(Math.abs(netProfit))} — increase your margin`}
            </div>
          )}
        </div>
      )}

    </div>
  );
}

export default function Dashboard() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [scanning, setScanning] = useState(searchParams.get('scanning') === '1');
  const [scanStep, setScanStep] = useState(0);
  const scanPollRef = useRef(null);
  const scanStepRef = useRef(null);
  const [appVersion, setAppVersion] = useState(null);
  const [profile, setProfile] = useState(null);
  const [rateLimit, setRateLimit] = useState(null);   // daily trade/telegram caps + reset (for the banner)
  const [rlNow, setRlNow] = useState(Date.now());     // ticks the limit-reached countdown

  // Prepaid I&M payout credits (only on the I&M / own-paybill rails).
  const [credits, setCredits] = useState(null);       // { credits_enabled, credits, credit_rate, ... }
  const [showBuyCredits, setShowBuyCredits] = useState(false);
  const [buyCreditsAmount, setBuyCreditsAmount] = useState(1000);
  const [buyCreditsPhone, setBuyCreditsPhone] = useState('');
  const [buyCreditsBusy, setBuyCreditsBusy] = useState(false);
  const [buyCreditsMsg, setBuyCreditsMsg] = useState('');
  // The progress bar shows credits left as a fraction of the MOST you've had
  // (the peak, remembered across reloads). It fills on load, then drains as
  // payouts consume credits. barReady flips on after mount so width animates 0→N.
  const [creditsPeak, setCreditsPeak] = useState(() => Number(localStorage.getItem('imCreditsPeak') || 0));
  const [barReady, setBarReady] = useState(false);
  const loadCredits = async () => {
    try {
      const r = await getCredits();
      setCredits(r.data);
      const bal = r.data?.credits ?? 0;
      setCreditsPeak(prev => {
        // Peak grows on a top-up; once fully drained to 0, reset so the NEXT
        // top-up starts a fresh full bar rather than a tiny sliver of an old peak.
        const p = bal <= 0 ? 0 : Math.max(prev, bal);
        localStorage.setItem('imCreditsPeak', String(p));
        return p;
      });
    } catch (_) {}
  };
  useEffect(() => {
    loadCredits();
    const t = setInterval(loadCredits, 20000);   // keep the balance live as payouts consume
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (credits?.credits_enabled && !barReady) {
      const t = setTimeout(() => setBarReady(true), 80);   // let width transition from 0
      return () => clearTimeout(t);
    }
  }, [credits, barReady]);

  // Fetch Choice Bank balance — poll every 10s when account is verified
  useEffect(() => {
    if (!profile?.choice_account_id) return;
    const fetchCbBalance = async () => {
      setCbBalanceLoading(true);
      try {
        const res = await choiceGetBalance(profile.id);
        setCbDashBalance(res.data);
      } catch {}
      finally { setCbBalanceLoading(false); }
    };
    fetchCbBalance();
    const iv = setInterval(fetchCbBalance, 10000);
    return () => clearInterval(iv);
  }, [profile?.choice_account_id, profile?.id]);

  const [wallet, setWallet] = useState(null);
  const [stats, setStats] = useState(null);
  const [orders, setOrders] = useState([]);
  const [ordersPage, setOrdersPage] = useState(1);
  const [ordersHasMore, setOrdersHasMore] = useState(true);
  const ORDERS_PER_PAGE = 20;
  const [ordersFilter, setOrdersFilter] = useState('all'); // 'all' | 'incoming' | 'outgoing'
  const [exportRange, setExportRange] = useState('7d');  // 24h | 7d | 30d | 1y | all
  const [exportType, setExportType] = useState('all');   // all | incoming | outgoing
  const [exporting, setExporting] = useState(false);
  const [showTierModal, setShowTierModal] = useState(false);
  const [tierModalSelection, setTierModalSelection] = useState('');
  const [tierModalSaving, setTierModalSaving] = useState(false);
  const [transactions, setTransactions] = useState([]);
  const [withdrawalTxns, setWithdrawalTxns] = useState([]);
  const [cbDashBalance, setCbDashBalance] = useState(null);
  const [cbBalanceLoading, setCbBalanceLoading] = useState(false);
  const [showCbDepositModal, setShowCbDepositModal] = useState(false);
  const [cbDepositAmount, setCbDepositAmount] = useState('');
  const [cbDepositLoading, setCbDepositLoading] = useState(false);
  const [cbDepositMsg, setCbDepositMsg] = useState('');
  const [cbDepositPhone, setCbDepositPhone] = useState('');
  // 'waiting' while we watch the STK land, then 'success' | 'failed'
  const [cbDepositState, setCbDepositState] = useState('');
  const cbDepositTimers = useRef([]);
  // Stop watching if the dashboard unmounts mid-poll.
  useEffect(() => () => {
    cbDepositTimers.current.forEach((id) => { clearInterval(id); clearTimeout(id); });
    cbDepositTimers.current = [];
  }, []);
  const [txFilter, setTxFilter] = useState('all');
  const [showCbWithdrawModal, setShowCbWithdrawModal] = useState(false);
  const [cbWithdrawAmount, setCbWithdrawAmount] = useState('');
  const [cbWithdrawOtp, setCbWithdrawOtp] = useState('');
  const [cbWithdrawOtpSent, setCbWithdrawOtpSent] = useState(false);
  const [cbWithdrawChannel, setCbWithdrawChannel] = useState('mpesa'); // 'mpesa' | 'bank'
  const [cbWithdrawOtpLoading, setCbWithdrawOtpLoading] = useState(false);
  const [cbWithdrawLoading, setCbWithdrawLoading] = useState(false);
  const [cbWithdrawMsg, setCbWithdrawMsg] = useState('');
  const [cbWithdrawBank, setCbWithdrawBank] = useState(null);
  const [allTxns, setAllTxns] = useState([]);
  const [allTxnsLoading, setAllTxnsLoading] = useState(false);
  const [expandedWithdrawals, setExpandedWithdrawals] = useState({});
  const [depositPage, setDepositPage] = useState(1);
  const [withdrawalPage, setWithdrawalPage] = useState(1);
  const [sweepSecondsLeft, setSweepSecondsLeft] = useState(0);
  const [activeTab, setActiveTab] = useState('overview');
  const [ptView, setPtView] = useState('tracker');  // Price Tracker page sub-view: 'tracker' | 'activity'
  const [mobMoreOpen, setMobMoreOpen] = useState(false);
  const [creditPlan, setCreditPlan] = useState(null);
  const [creditCategory, setCreditCategory] = useState('starter'); // 'starter' | 'enterprise'
  const [creditPhone, setCreditPhone] = useState('');
  const [b2cAmt, setB2cAmt] = useState('');       // Buy-credits amount (B2C own-paybill clients)
  const [b2cBusy, setB2cBusy] = useState(false);
  const [b2cMsg, setB2cMsg] = useState(null);
  const [payGoAmount, setPayGoAmount] = useState('500');
  const [creditBuying, setCreditBuying] = useState(false);
  const [creditPolling, setCreditPolling] = useState(false);
  const [creditCheckoutId, setCreditCheckoutId] = useState(null);
  const [creditMsg, setCreditMsg] = useState(null);
  // Manual Paybill + Pay-with-Choice-Bank
  const [payInfo, setPayInfo] = useState(null);
  const [choicePay, setChoicePay] = useState(null); // { plan, step:'otp'|'done', otp, busy, error, info }
  const [subDepAmount, setSubDepAmount] = useState('');
  const [subDepSending, setSubDepSending] = useState(false);
  const [subDepMsg, setSubDepMsg] = useState(null); // { type:'ok'|'err', text }
  const [botLogs, setBotLogs] = useState([]);
  const logsEndRef = useRef(null);
  const [txnTab, setTxnTab] = useState('deposits');
  const [refreshing, setRefreshing] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [showBalance, setShowBalance] = useState(false);
  const [showWithdrawModal, setShowWithdrawModal] = useState(false);
  const [withdrawPreview, setWithdrawPreview] = useState(null);
  const [withdrawCustomAmount, setWithdrawCustomAmount] = useState('');
  const [withdrawOtp, setWithdrawOtp] = useState('');
  const [withdrawOtpSent, setWithdrawOtpSent] = useState(false);
  const [withdrawOtpLoading, setWithdrawOtpLoading] = useState(false);
  const [withdrawMsg, setWithdrawMsg] = useState('');
  const [withdrawAmtErr, setWithdrawAmtErr] = useState('');
  const [withdrawStatus, setWithdrawStatus] = useState(null); // null | 'processing' | 'succeeded'
  const withdrawPollRef = useRef(null);
  const [systemStatus, setSystemStatus] = useState(null);
  const [sessionHealth, setSessionHealth] = useState(null);
  const [identityError, setIdentityError] = useState('');
  const [notifications, setNotifications] = useState([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [openSupportChat, setOpenSupportChat] = useState(false);
  const [showConfigModal, setShowConfigModal] = useState(false);
  useEffect(() => { if (activeTab !== 'logs') window.scrollTo(0, 0); }, [activeTab]);
  const [botTradeMode, setBotTradeMode] = useState('both');
  const [savingConfig, setSavingConfig] = useState(false);
  const [configSaved, setConfigSaved] = useState(false);
  const configSavedAt = useRef(0);
  const [ddEnabled, setDdEnabled] = useState(false);
  const [botFullAuto, setBotFullAuto] = useState(false);
  const [ddMin30d, setDdMin30d] = useState(20);
  const [ddMinAll, setDdMinAll] = useState(0);
  const [ddAutoCancelNew, setDdAutoCancelNew] = useState(false);
  const [tgApprovalEnabled, setTgApprovalEnabled] = useState(false);
  const [tgConnectedForConfig, setTgConnectedForConfig] = useState(false);
  const [tgNotifyScope, setTgNotifyScope] = useState('both');   // both | sell | buy
  const [tgCodeCfg, setTgCodeCfg] = useState(null);             // {code, expires_in} when linking
  const [tgCodeCfgLoading, setTgCodeCfgLoading] = useState(false);
  const genTgCodeCfg = async () => {
    setTgCodeCfgLoading(true);
    try {
      const r = await api.post('/telegram/generate-link-code');
      setTgCodeCfg(r.data);
      const iv = setInterval(async () => {
        try { const s = await api.get('/telegram/status'); if (s.data.connected) { setTgConnectedForConfig(true); setTgCodeCfg(null); clearInterval(iv); } } catch {}
      }, 3000);
      setTimeout(() => clearInterval(iv), 600000);
    } catch {} finally { setTgCodeCfgLoading(false); }
  };
  const disconnectTgCfg = async () => { try { await api.post('/telegram/disconnect'); setTgConnectedForConfig(false); setTgCodeCfg(null); } catch {} };
  const testTgCfg = async () => { try { await api.post('/telegram/test'); } catch {} };
  const [cfEnabled, setCfEnabled] = useState(false);
  const [cfAllTradesMin, setCfAllTradesMin] = useState('0');
  const [cfAllTradesMinAll, setCfAllTradesMinAll] = useState('0');
  const [cfMaxPayMins, setCfMaxPayMins] = useState('0');
  const [cfMaxReleaseMins, setCfMaxReleaseMins] = useState('0');
  const [binanceFeePerUsdt, setBinanceFeePerUsdt] = useState('0.25');
  const [cfSync, setCfSync] = useState(null); // live Binance sync status: { available, synced, expected, binance_values }
  const checkCfSync = async () => {
    try { const r = await api.get('/traders/cf-sync-status'); setCfSync(r.data); } catch { setCfSync(null); }
  };
  const [profitData, setProfitData] = useState(null); // live daily profit from Binance order history (EP-16)
  const fetchProfit = async () => {
    try { const r = await api.get('/traders/profit-breakdown'); if (r.data?.available) setProfitData(r.data); } catch {}
  };
  const [settingsInitialSection, setSettingsInitialSection] = useState('binance'); // timestamp of last successful config save — prevents stale loadData responses from overwriting the saved value
  const [showPaybill, setShowPaybill] = useState(false);
  const [copied, setCopied] = useState('');
  const [binanceData, setBinanceData] = useState(null);
  const [showDepositModal, setShowDepositModal] = useState(false);
  const [depositAmount, setDepositAmount] = useState('');
  const [depositPhone, setDepositPhone] = useState('');
  const [depositLoading, setDepositLoading] = useState(false);
  const [depositStatus, setDepositStatus] = useState(null); // null, 'pending', 'success', 'failed'
  const [depositMessage, setDepositMessage] = useState('');
  const [depositHistory, setDepositHistory] = useState([]);
  const depositPollRef = useRef(null);
  const [showSendModal, setShowSendModal] = useState(false);
  const [sendRecipient, setSendRecipient] = useState('');
  const [sendAmount, setSendAmount] = useState('');
  const [sendLoading, setSendLoading] = useState(false);
  const [sendMessage, setSendMessage] = useState('');
  const [sendStatus, setSendStatus] = useState(null); // null, 'success', 'error'
  const [updateVersion, setUpdateVersion] = useState(null); // set when desktop update is ready
  const [updateDownloading, setUpdateDownloading] = useState(null); // { version, percent } while downloading
  const [checkingUpdate, setCheckingUpdate] = useState(false); // manual check in progress
  const [upToDate, setUpToDate] = useState(null); // { version } when already on latest
  const upToDateTimerRef = useRef(null);
  const [affiliateData, setAffiliateData] = useState(null); // { affiliate: {...} | null }
  const [affiliateReferrals, setAffiliateReferrals] = useState(null);
  const [affiliateApplying, setAffiliateApplying] = useState(false);
  const [affiliateApplyMsg, setAffiliateApplyMsg] = useState('');
  const [affiliateCopied, setAffiliateCopied] = useState(false);
  const [expandedReferral, setExpandedReferral] = useState(null);

  // Listen for update events from Electron main process
  useEffect(() => {
    const readyHandler = (e) => {
      setUpdateDownloading(null);
      setCheckingUpdate(false);
      setUpToDate(null);
      setUpdateVersion(e.detail?.version || 'latest');
    };
    const downloadingHandler = (e) => {
      setCheckingUpdate(false);
      setUpToDate(null);
      setUpdateDownloading(prev => ({ ...prev, ...e.detail }));
    };
    const upToDateHandler = (e) => {
      setCheckingUpdate(false);
      setUpToDate(e.detail);
      clearTimeout(upToDateTimerRef.current);
      upToDateTimerRef.current = setTimeout(() => setUpToDate(null), 5000);
    };
    window.addEventListener('sparkp2p-update-ready', readyHandler);
    window.addEventListener('sparkp2p-update-downloading', downloadingHandler);
    window.addEventListener('sparkp2p-up-to-date', upToDateHandler);
    return () => {
      window.removeEventListener('sparkp2p-update-ready', readyHandler);
      window.removeEventListener('sparkp2p-update-downloading', downloadingHandler);
      window.removeEventListener('sparkp2p-up-to-date', upToDateHandler);
      clearTimeout(upToDateTimerRef.current);
    };
  }, []);

  // Sweep countdown timer — ticks every second, resets at each 15-min boundary
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const m = now.getMinutes();
      const nextM = (Math.floor(m / 15) + 1) * 15;
      const next = new Date(now);
      if (nextM >= 60) {
        next.setHours(next.getHours() + 1, 0, 0, 0);
      } else {
        next.setMinutes(nextM, 0, 0);
      }
      setSweepSecondsLeft(Math.max(0, Math.floor((next - now) / 1000)));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // Fetch daily rate-limit status (for the limit-reached banner) + tick the countdown each second.
  useEffect(() => {
    if (!localStorage.getItem('token')) return;
    const fetchRL = () => { getRateLimit().then(r => setRateLimit(r.data)).catch(() => {}); };
    fetchRL();
    const poll = setInterval(fetchRL, 60000);
    const id = setInterval(() => setRlNow(Date.now()), 1000);
    return () => { clearInterval(poll); clearInterval(id); };
  }, []);

  // Paybill + account number for manual / Choice Bank payment (loaded once).
  useEffect(() => {
    if (!localStorage.getItem('token')) return;
    getPaymentInfo().then(r => setPayInfo(r.data)).catch(() => {});
  }, []);

  const handleDepositStk = async () => {
    const amt = Number(subDepAmount);
    if (!amt || amt < 10) { setSubDepMsg({ type: 'err', text: 'Enter at least KES 10.' }); return; }
    if (!creditPhone.trim()) { setSubDepMsg({ type: 'err', text: 'Enter your M-Pesa number above first.' }); return; }
    setSubDepSending(true); setSubDepMsg(null);
    try {
      const r = await subscriptionDepositInitiate(amt, creditPhone.trim());
      setSubDepMsg({ type: 'ok', text: r.data?.message || 'STK Push sent — enter your PIN. It will be added to your balance.' });
      setSubDepAmount('');
      // Balance updates via the callback — refresh a few times.
      let n = 0;
      const iv = setInterval(async () => { n++; try { const p = await getPaymentInfo(); setPayInfo(p.data); } catch {} if (n >= 6) clearInterval(iv); }, 5000);
    } catch (e) {
      setSubDepMsg({ type: 'err', text: e.response?.data?.detail || 'Could not send the STK push.' });
    } finally { setSubDepSending(false); }
  };

  const startChoicePay = async (plan) => {
    setChoicePay({ plan, step: 'init', busy: true, error: '', otp: '' });
    try {
      const r = await payChoiceInitiate(plan);
      setChoicePay({ plan, step: 'otp', busy: false, error: '', otp: '', info: r.data?.message });
    } catch (e) {
      setChoicePay({ plan, step: 'init', busy: false, error: e.response?.data?.detail || 'Could not start the payment.', otp: '' });
    }
  };
  const confirmChoicePay = async () => {
    setChoicePay(c => ({ ...c, busy: true, error: '' }));
    try {
      await payChoiceConfirm(choicePay.otp);
      setChoicePay(c => ({ ...c, step: 'done', busy: false }));
    } catch (e) {
      setChoicePay(c => ({ ...c, busy: false, error: e.response?.data?.detail || 'OTP confirmation failed.' }));
    }
  };

  const loadData = async () => {
    if (!localStorage.getItem('token')) return;
    setRefreshing(true);
    try {
      const results = await Promise.allSettled([
        getProfile(),
        getWallet(),
        getOrderStats(),
        getWalletTransactions(50, 'positive'),
        getSessionHealth(),
        getBinanceAccountData(),
        getWalletTransactions(100, 'negative'),
      ]);
      // NOTE: Orders are NOT fetched here — the dedicated binance-orders effect (keyed on
      // activeTab/ordersFilter/ordersPage) owns the Orders list so the filter never gets
      // overwritten by a background loadData refresh.
      if (results[0].status === 'fulfilled') { const p = results[0].value.data; setProfile(p); if (!p.binance_merchant_tier) setShowTierModal(true); if (Date.now() - configSavedAt.current > 30000) { setBotTradeMode(p.bot_trade_mode || 'both'); setDdEnabled(p.dd_enabled || false); setBotFullAuto(p.bot_full_auto || false); setDdMin30d(p.dd_min_30d_trades ?? 20); setDdMinAll(p.dd_min_all_trades ?? 0); setDdAutoCancelNew(p.dd_auto_cancel_new || false); setTgApprovalEnabled(p.telegram_approval_enabled || false); setTgConnectedForConfig(p.telegram_connected || false); setTgNotifyScope(p.telegram_notify_scope || 'both'); setCfEnabled(p.cf_filters_enabled || false); setCfAllTradesMin(String(p.cf_all_trades_min ?? 0)); setCfAllTradesMinAll(String(p.cf_all_trades_min_all ?? 0)); setCfMaxPayMins(String(p.cf_max_pay_mins ?? 0)); setCfMaxReleaseMins(String(p.cf_max_release_mins ?? 0)); setBinanceFeePerUsdt(String(p.binance_fee_per_usdt ?? 0.25)); } }
      if (results[1].status === 'fulfilled') setWallet(results[1].value.data);
      if (results[2].status === 'fulfilled') setStats(results[2].value.data);
      if (results[3].status === 'fulfilled') setTransactions(results[3].value.data);
      if (results[4].status === 'fulfilled') setSessionHealth(results[4].value.data);
      if (results[5].status === 'fulfilled') setBinanceData(results[5].value.data);
      if (results[6].status === 'fulfilled') setWithdrawalTxns(results[6].value.data);

      // Fetch notifications
      try {
        const notifRes = await api.get('/traders/notifications');
        if (notifRes.data) {
          setNotifications(notifRes.data);
          setUnreadCount(notifRes.data.filter(n => !n.read).length);
        }
      } catch (e) {}
    } catch (err) {
      console.error('Failed to load data:', err);
    }
    setRefreshing(false);
  };

  const loadAffiliateData = async () => {
    try {
      const res = await getMyAffiliate();
      setAffiliateData(res.data);
      if (res.data?.affiliate?.status === 'approved') {
        const refRes = await getMyReferrals();
        setAffiliateReferrals(refRes.data);
      }
    } catch (e) {}
  };

  // Listen for identity mismatch event from desktop bot
  useEffect(() => {
    const handler = (e) => setIdentityError(e.detail?.message || 'Identity verification failed. Please log in with your registered Binance account.');
    window.addEventListener('identity-mismatch', handler);
    return () => window.removeEventListener('identity-mismatch', handler);
  }, []);

  // Refresh profile when desktop app signals Binance or I&M connected
  useEffect(() => {
    const handler = async () => {
      try {
        const res = await getProfile();
        setProfile(res.data);
      } catch (_) {}
    };
    window.addEventListener('binance-connected', handler);
    window.addEventListener('im-connected', handler);
    window.addEventListener('gmail-connected', handler);
    return () => {
      window.removeEventListener('binance-connected', handler);
      window.removeEventListener('im-connected', handler);
      window.removeEventListener('gmail-connected', handler);
    };
  }, []);

  // Refresh profile every 30s so bot status stays live after the initial scan
  useEffect(() => {
    const id = setInterval(async () => {
      try { const res = await getProfile(); setProfile(res.data); } catch (_) {}
    }, 30000);
    return () => clearInterval(id);
  }, []);

  // Web presence heartbeat — marks this trader online while the dashboard is open
  useEffect(() => {
    const ping = () => { api.post('/traders/web-heartbeat').catch(() => {}); };
    ping();
    const id = setInterval(ping, 60000);
    return () => clearInterval(id);
  }, []);

  // Load the configured Choice Bank withdrawal account (for the Spread Calculator cash-out)
  useEffect(() => {
    getCbWithdrawalBank().then(r => setCbWithdrawBank(r.data)).catch(() => {});
  }, []);

  // Live daily profit from real Binance order history — refresh every 60s on Overview
  useEffect(() => {
    fetchProfit();
    const id = setInterval(fetchProfit, 60000);
    return () => clearInterval(id);
  }, []);

  // Live counterparty-filter sync check when the Configure tab opens
  useEffect(() => {
    if (activeTab === 'configure' || showConfigModal) checkCfSync();
  }, [activeTab, showConfigModal]);

  // Orders tab — load REAL Binance order history (EP-16), with filter + pagination, refresh 20s
  useEffect(() => {
    if (activeTab !== 'orders') return;
    const side = ordersFilter === 'all' ? '' : ordersFilter;
    const load = async () => {
      try {
        const res = await api.get('/traders/binance-orders', { params: { limit: 20, offset: (ordersPage - 1) * 20, side } });
        setOrders(res.data);
        setOrdersHasMore(res.data.length === 20);
      } catch (_) {}
    };
    load();
    const id = setInterval(load, 20000);
    return () => clearInterval(id);
  }, [activeTab, ordersFilter, ordersPage]);

  const [setupMissing, setSetupMissing] = useState([]);
  const [setupDismissed, setSetupDismissed] = useState(false);

  // Listen for setup-incomplete / setup-complete events from desktop app
  useEffect(() => {
    // Gmail is optional (API-key merchants don't need it), so never gate setup on it.
    const onIncomplete = (e) => { setSetupMissing((e.detail?.missing || []).filter(x => x !== 'Gmail')); setSetupDismissed(false); };
    const onComplete = () => setSetupMissing([]);
    window.addEventListener('setup-incomplete', onIncomplete);
    window.addEventListener('setup-complete', onComplete);
    return () => {
      window.removeEventListener('setup-incomplete', onIncomplete);
      window.removeEventListener('setup-complete', onComplete);
    };
  }, []);

  // Also derive missing connections directly from profile (catches page refresh)
  const missingConnections = (() => {
    if (!profile) return [];
    const m = [];
    if (!profile.binance_connected) m.push('Binance');
    // Gmail is optional — API-key merchants don't need it, so it must not pause the bot.
    return m;
  })();
  const showSetupBanner = (setupMissing.length > 0 || missingConnections.length > 0) && !setupDismissed;
  const bannerMissing = setupMissing.length > 0 ? setupMissing : missingConnections;

  useEffect(() => {
    // Show the REAL installed desktop version via the preload bridge (works over https,
    // unlike the http://127.0.0.1 fetch which browsers block as mixed content).
    // Fall back to the build-time constant for plain web browsers.
    setAppVersion(__APP_VERSION__);
    try {
      if (window.sparkp2p?.getBotStatus) {
        window.sparkp2p.getBotStatus().then(s => { if (s?.version) setAppVersion(s.version); }).catch(() => {});
      }
    } catch (_) {}
    fetch('http://127.0.0.1:9223/status').then(r => r.json()).then(d => { if (d.version) setAppVersion(d.version); }).catch(() => {});
    // Wait a tick to ensure token is stored after login redirect
    const timer = setTimeout(() => {
      if (localStorage.getItem('token')) {
        loadData();
        loadAffiliateData();
      }
    }, 100);
    const interval = setInterval(() => {
      if (localStorage.getItem('token')) {
        loadData();
      }
    }, 15000);
    return () => { clearTimeout(timer); clearInterval(interval); };
  }, []);

  // Fast wallet poll every 5s for real-time KES balance updates
  useEffect(() => {
    const walletPoll = setInterval(async () => {
      if (!localStorage.getItem('token')) return;
      try {
        const res = await getWallet();
        if (res.data) {
          setWallet(prev => {
            if (prev && res.data.balance !== prev.balance) {
              // Balance changed — also refresh transactions
              getWalletTransactions(50, 'positive').then(r => { if (r.data) setTransactions(r.data); }).catch(() => {});
              getWalletTransactions(100, 'negative').then(r => { if (r.data) setWithdrawalTxns(r.data); }).catch(() => {});
            }
            return res.data;
          });
        }
      } catch (e) {}
    }, 5000);
    return () => clearInterval(walletPoll);
  }, []);

  // Poll Binance account data (wallet balances) every 30s so the display stays current
  useEffect(() => {
    const binancePoll = setInterval(async () => {
      if (!localStorage.getItem('token')) return;
      try {
        const res = await getBinanceAccountData();
        if (res.data) setBinanceData(res.data);
      } catch (e) {}
    }, 30000);
    return () => clearInterval(binancePoll);
  }, []);

  // NOTE: we intentionally do NOT auto-redirect to /onboarding. Traders always land on their
  // dashboard and finish the Binance connection from Settings (the dashboard shows "Connect
  // Binance" prompts when not connected). Forcing onboarding trapped users whose API verification
  // never completed because their relay was offline. Onboarding is still reachable at /onboarding.

  // Recompute withdrawal amount error whenever amount or preview changes
  useEffect(() => {
    if (!withdrawPreview) { setWithdrawAmtErr(''); return; }
    const balance = withdrawPreview.balance ?? 0;
    const minWd = withdrawPreview.min_withdrawal ?? 1000;
    const customAmt = parseFloat(withdrawCustomAmount) || 0;
    const clampedAmt = Math.min(customAmt, balance);
    const remainingAfter = balance - clampedAmt;
    const wouldStrand = clampedAmt > 0 && clampedAmt < balance && remainingAfter > 0 && remainingAfter < minWd;
    if (customAmt > balance) setWithdrawAmtErr(`Max KES ${balance.toLocaleString()}`);
    else if (customAmt > 0 && customAmt < minWd) setWithdrawAmtErr(`Min KES ${minWd.toLocaleString()}`);
    else if (wouldStrand) setWithdrawAmtErr(`Withdrawing KES ${clampedAmt.toLocaleString()} would leave KES ${remainingAfter.toLocaleString()} which can't be withdrawn later. Withdraw the full KES ${balance.toLocaleString()} instead.`);
    else setWithdrawAmtErr('');
  }, [withdrawCustomAmount, withdrawPreview]);

  // Scanning overlay: poll until bot confirms Binance connection
  const SCAN_STEPS = [
    'Connecting to your Binance account...',
    'Loading your wallet balances...',
    'Confirming your Binance identity...',
    'Almost ready...',
  ];
  useEffect(() => {
    if (!scanning) return;
    setSearchParams({}, { replace: true });

    // Cycle through status messages every 8 seconds
    scanStepRef.current = setInterval(() => {
      setScanStep(s => Math.min(s + 1, SCAN_STEPS.length - 1));
    }, 8000);

    // Poll profile until bot has synced and confirmed Binance username
    scanPollRef.current = setInterval(async () => {
      try {
        const res = await getProfile();
        const { last_extension_sync } = res.data;
        if (last_extension_sync) {
          clearInterval(scanPollRef.current);
          clearInterval(scanStepRef.current);
          setScanning(false);
        }
      } catch (_) {}
    }, 3000);

    // Safety timeout: remove overlay after 2 minutes regardless
    const timeout = setTimeout(() => {
      clearInterval(scanPollRef.current);
      clearInterval(scanStepRef.current);
      setScanning(false);
    }, 120000);

    return () => {
      clearInterval(scanPollRef.current);
      clearInterval(scanStepRef.current);
      clearTimeout(timeout);
    };
  }, [scanning]);

  // Activity logs — pull the server-side log (account events like sign-ins, password changes,
  // API-key problems + any desktop-pushed lines) so it's complete on web AND mobile. On the
  // desktop, also stream live local entries straight in and persist them to the server.
  useEffect(() => {
    const loadServer = () => getMyBotLogs()
      .then(r => setBotLogs((r.data || []).slice().reverse()))   // server is newest-first; view is chronological
      .catch(() => {});
    loadServer();
    const iv = setInterval(loadServer, 30000);
    let offLog = null;
    if (window.sparkp2p?.onLog) {
      offLog = window.sparkp2p.onLog(entry => {
        setBotLogs(prev => {
          const next = [...prev, entry];
          return next.length > 400 ? next.slice(-400) : next;
        });
        if (entry && entry.message) postBotLog({ level: entry.level || 'info', message: String(entry.message), time: entry.time || new Date().toISOString() }).catch(() => {});
      });
    }
    return () => { clearInterval(iv); offLog?.(); };
  }, []);

  useEffect(() => {
    if (activeTab === 'logs') logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    if (activeTab === 'transactions') {
      setAllTxnsLoading(true);
      getMyTransactions(100).then(r => { if (r.data) setAllTxns(r.data); }).catch(() => {}).finally(() => setAllTxnsLoading(false));
    }
  }, [botLogs, activeTab]);

  const handleWithdraw = async () => {
    if (!wallet || wallet.balance <= 0) return;

    // Block if there's already a pending withdrawal being processed
    if (wallet.pending_withdrawal) {
      alert(`You already have a withdrawal of ${fmtKES(wallet.pending_withdrawal_amount)} being processed. Please wait for it to complete before requesting another.`);
      return;
    }

    // Get fee preview first
    try {
      const preview = await api.get('/traders/wallet/withdraw/preview');
      const p = preview.data;

      if (!p.can_withdraw) {
        if (p.cooldown_active) {
          alert(`Your payment method was recently changed. Withdrawals available in ${p.cooldown_hours} hours.`);
        } else {
          alert(p.reason || 'Cannot withdraw at this time.');
        }
        return;
      }

      setWithdrawPreview(p);
      // Prefill the max RECEIVABLE amount (balance minus the Choice Bank fee, which is debited on top).
      {
        const _bal = p.balance ?? 0;
        const _maxRecv = Math.max(0, _bal - getWithdrawalFee(p.settlement_method || 'mpesa', _bal));
        setWithdrawCustomAmount(String(Math.round(_maxRecv * 100) / 100));
      }
      setWithdrawOtp('');
      setWithdrawOtpSent(false);
      setWithdrawMsg('');
      // Fetch system health status before showing modal
      try {
        const sysRes = await getSystemStatus();
        setSystemStatus(sysRes.data);
      } catch (_) {
        setSystemStatus(null);
      }
      setShowWithdrawModal(true);
    } catch (err) {
      alert(err.response?.data?.detail || 'Could not check withdrawal');
    }
  };

  const handleDeposit = async () => {
    const amt = parseFloat(depositAmount);
    if (!amt || amt < 100 || amt > 500000) {
      setDepositMessage('Amount must be between KES 100 and KES 500,000');
      return;
    }
    if (!depositPhone || depositPhone.length < 9) {
      setDepositMessage('Please enter a valid M-Pesa phone number');
      return;
    }

    setDepositLoading(true);
    setDepositMessage('');
    setDepositStatus(null);

    try {
      const res = await initiateDeposit(amt, depositPhone);
      const checkoutId = res.data.checkout_request_id;
      setDepositStatus('pending');
      setDepositMessage('STK Push sent. Enter your M-Pesa PIN on your phone...');

      // Poll for status
      let attempts = 0;
      depositPollRef.current = setInterval(async () => {
        attempts++;
        try {
          const statusRes = await checkDepositStatus(checkoutId);
          if (statusRes.data.status === 'completed') {
            clearInterval(depositPollRef.current);
            setDepositStatus('success');
            setDepositMessage(`Deposit successful! New balance: KES ${statusRes.data.balance_after?.toLocaleString()}`);
            setDepositLoading(false);
            loadData(); // Refresh wallet
          } else if (statusRes.data.status === 'failed') {
            clearInterval(depositPollRef.current);
            setDepositStatus('failed');
            setDepositMessage('Deposit failed. Please try again.');
            setDepositLoading(false);
          }
        } catch (e) {
          // Ignore poll errors
        }
        if (attempts >= 30) {
          // Stop polling after ~60 seconds
          clearInterval(depositPollRef.current);
          setDepositStatus('failed');
          setDepositMessage('Timed out waiting for payment confirmation. Check your M-Pesa and try again.');
          setDepositLoading(false);
        }
      }, 2000);
    } catch (err) {
      setDepositStatus('failed');
      setDepositMessage(err.response?.data?.detail || 'Failed to initiate deposit');
      setDepositLoading(false);
    }
  };

  const closeDepositModal = () => {
    if (depositPollRef.current) clearInterval(depositPollRef.current);
    setShowDepositModal(false);
    setDepositAmount('');
    setDepositStatus(null);
    setDepositMessage('');
    setDepositLoading(false);
  };

  const handleSend = async () => {
    const amt = parseFloat(sendAmount);
    if (!amt || amt < 10) {
      setSendMessage('Minimum transfer is KES 10');
      setSendStatus('error');
      return;
    }
    if (!sendRecipient || sendRecipient.trim().length < 5) {
      setSendMessage('Enter a valid phone number or email');
      setSendStatus('error');
      return;
    }
    setSendLoading(true);
    setSendMessage('');
    setSendStatus(null);
    try {
      const res = await internalTransfer(sendRecipient.trim(), amt);
      setSendStatus('success');
      setSendMessage(res.data.message || 'Transfer successful!');
      loadData();
    } catch (err) {
      setSendStatus('error');
      setSendMessage(err.response?.data?.detail || 'Transfer failed');
    }
    setSendLoading(false);
  };

  const closeSendModal = () => {
    setShowSendModal(false);
    setSendRecipient('');
    setSendAmount('');
    setSendMessage('');
    setSendStatus(null);
    setSendLoading(false);
  };

  // Pre-fill phone from profile
  useEffect(() => {
    if (profile?.phone) setDepositPhone(profile.phone);
  }, [profile]);



  const getStatusColor = (status) => {
    const colors = {
      pending: '#f59e0b',
      payment_received: '#3b82f6',
      releasing: '#a78bfa',
      released: '#10b981',
      completed: '#10b981',
      disputed: '#ef4444',
      expired: '#f97316',
      cancelled: '#6b7280',
    };
    return colors[status] || '#6b7280';
  };

  // Live clock — ticks every second so active order timers update in real time
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const formatDuration = (seconds) => {
    if (seconds < 0) seconds = 0;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  // Active statuses — timer keeps running until the order ends
  const ACTIVE_STATUSES = new Set(['pending', 'payment_received', 'releasing', 'payment_sent', 'disputed']);

  const getOrderDuration = (order) => {
    const start = new Date(order.created_at).getTime();
    // Released/completed — static duration to release time
    if (order.released_at) {
      return { secs: Math.floor((new Date(order.released_at) - start) / 1000), live: false, overdue: false };
    }
    // Cancelled — static duration to cancellation time (accurate if cancelled_at exists)
    if (order.status === 'cancelled') {
      const end = order.cancelled_at ? new Date(order.cancelled_at).getTime() : now;
      return { secs: Math.floor((end - start) / 1000), live: false, overdue: false };
    }
    // Active or expired-but-still-running — live elapsed time
    const secs = Math.floor((now - start) / 1000);
    const overdue = order.status === 'expired';
    const live = ACTIVE_STATUSES.has(order.status) || overdue;
    return { secs, live, overdue };
  };

  return (
    <div className="dashboard" style={showSetupBanner ? { paddingTop: 62 } : {}}>
      {/* Binance initial scan overlay */}
      {scanning && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: '#000',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          gap: 32,
        }}>
          <div style={{
            width: 56, height: 56,
            border: '3px solid rgba(255,255,255,0.08)',
            borderTop: '3px solid rgba(255,255,255,0.65)',
            borderRadius: '50%',
            animation: 'spin 0.9s linear infinite',
          }} />
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 15, color: 'rgba(255,255,255,0.75)', fontWeight: 500, letterSpacing: 0.2 }}>
              {SCAN_STEPS[scanStep]}
            </div>
          </div>
        </div>
      )}

      {/* Binance session expired — reconnect so the bot can keep sending chat to buyers/sellers */}
      {profile?.binance_session_expired && (
        <div className="setup-banner" style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.4)' }}>
          <span className="setup-banner-icon">🔐</span>
          <div className="setup-banner-body">
            <div className="setup-banner-title">Binance session expired — reconnect to keep trading</div>
            <div className="setup-banner-desc">
              Your Binance login has expired, so the bot can't send payment details or messages to your buyers and sellers. Reconnect now — it takes under a minute.
            </div>
          </div>
          <button className="setup-banner-btn" onClick={() => { setSettingsInitialSection('binance'); setActiveTab('settings'); }}>
            Reconnect Binance
          </button>
        </div>
      )}

      {/* Setup incomplete banner */}
      {showSetupBanner && (
        <div className="setup-banner">
          <span className="setup-banner-icon">⚠️</span>
          <div className="setup-banner-body">
            <div className="setup-banner-title">Bot Paused — Setup Incomplete</div>
            <div className="setup-banner-desc">
              Connect{' '}
              {bannerMissing.map((m, i) => (
                <span key={m}>
                  <strong style={{ color: '#fff' }}>{m}</strong>
                  {i < bannerMissing.length - 1 ? ', ' : ''}
                </span>
              ))}
              {' '}in Settings → Binance tab.
            </div>
          </div>
          <button className="setup-banner-btn" onClick={() => setActiveTab('settings')}>
            Go to Settings
          </button>
          <button className="setup-banner-dismiss" onClick={() => setSetupDismissed(true)}>
            ✕
          </button>
        </div>
      )}


      {/* Identity mismatch alert */}
      {identityError && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9998,
          background: '#7f1d1d', borderBottom: '2px solid #ef4444',
          padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <span style={{ fontSize: 20 }}>🚫</span>
          <div style={{ flex: 1 }}>
            <div style={{ color: '#fca5a5', fontWeight: 700, fontSize: 14 }}>Identity Verification Failed</div>
            <div style={{ color: '#fecaca', fontSize: 13, marginTop: 2 }}>{identityError}</div>
          </div>
          <button onClick={() => setIdentityError('')} style={{ background: 'transparent', border: '1px solid #ef4444', color: '#fca5a5', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontSize: 13 }}>Dismiss</button>
        </div>
      )}

      <header className="dash-header">
        <div className="dash-header-left">
          <img src="/spark-icon.svg" alt="SparkP2P" className="header-logo" />
          <h1>SparkP2P</h1>
          {appVersion && (
            <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 500, letterSpacing: '0.02em', marginLeft: -2, marginTop: 2 }}>
              v{appVersion}
            </span>
          )}
          <span className={`status-badge ${profile?.binance_connected ? 'connected' : 'disconnected'}`}>
            {profile?.binance_connected ? 'Binance Connected' : 'Binance Disconnected'}
          </span>
          <span
            style={{
              display: 'inline-block',
              width: 10,
              height: 10,
              borderRadius: '50%',
              marginLeft: 6,
              backgroundColor: profile?.binance_connected ? '#10b981' : '#ef4444',
              boxShadow: profile?.binance_connected ? '0 0 6px #10b981' : '0 0 4px #ef4444',
              animation: profile?.binance_connected ? 'pulse-green 1.5s ease-in-out infinite' : 'none',
            }}
            title={profile?.binance_connected ? 'Binance Connected' : 'Disconnected'}
          />
        </div>
        <div className="dash-header-right">
          <span className="user-name">{user?.full_name}</span>
          <span className="tier-badge">{profile?.tier || 'standard'}</span>
          {(profile?.role === 'employee' || profile?.is_admin) && (
            <button className="icon-btn" onClick={() => navigate(profile?.is_admin ? '/admin' : '/employee')} title={profile?.is_admin ? 'Admin' : 'Employee Portal'}>
              <Shield size={18} />
            </button>
          )}
          <div style={{ position: 'relative' }}>
            <button
              className="icon-btn"
              title="Messages"
              onClick={() => { setOpenSupportChat(true); }}
            >
              <MessageSquare size={18} />
              {notifications.filter(n => !n.read && n.type === 'support').length > 0 && (
                <span style={{ position: 'absolute', top: -2, right: -2, background: '#6366f1', color: '#fff', borderRadius: '50%', width: 16, height: 16, fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>
                  {notifications.filter(n => !n.read && n.type === 'support').length}
                </span>
              )}
            </button>
          </div>
          <div style={{ position: 'relative' }}>
            <button className="icon-btn" onClick={() => { setShowNotifications(!showNotifications); setUnreadCount(0); api.post('/traders/notifications/mark-read').catch(() => {}); }}>
              <Bell size={18} />
              {unreadCount > 0 && (
                <span style={{ position: 'absolute', top: -2, right: -2, background: '#ef4444', color: '#fff', borderRadius: '50%', width: 16, height: 16, fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </button>
            {showNotifications && (
              <div style={{ position: 'absolute', top: 36, right: 0, width: 320, maxHeight: 400, overflowY: 'auto', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 8px 30px rgba(0,0,0,0.4)', zIndex: 100 }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 14 }}>Notifications</div>
                {notifications.length === 0 ? (
                  <div style={{ padding: 20, textAlign: 'center', color: '#6b7280', fontSize: 13 }}>No notifications yet</div>
                ) : (
                  notifications.slice(0, 20).map((n, i) => (
                    <div key={i} style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', fontSize: 13, opacity: n.read ? 0.6 : 1 }}>
                      <div style={{ fontWeight: n.read ? 400 : 600, color: n.type === 'payment' ? '#10b981' : n.type === 'release' ? '#3b82f6' : '#e5e7eb' }}>
                        {n.title}
                      </div>
                      <div style={{ color: '#9ca3af', fontSize: 12, marginTop: 2 }}>{n.message}</div>
                      <div style={{ color: '#6b7280', fontSize: 11, marginTop: 4 }}>{n.time}</div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
          {/* Update button — only shown in desktop Electron app */}
          {window.sparkp2p?.isDesktop && (
            <div style={{ position: 'relative' }}>
              <button
                className="icon-btn"
                title={
                  updateVersion ? `v${updateVersion} ready — click to install` :
                  updateDownloading ? `Downloading update${updateDownloading.version ? ` v${updateDownloading.version}` : ''}... ${updateDownloading.percent ?? 0}%` :
                  checkingUpdate ? 'Checking for updates...' :
                  'Check for updates'
                }
                disabled={!!updateDownloading || checkingUpdate}
                onClick={() => {
                  if (updateVersion) { window.sparkp2p?.restartApp?.(); return; }
                  setCheckingUpdate(true);
                  setUpToDate(null);
                  window.sparkp2p?.checkForUpdates?.();
                  setTimeout(() => setCheckingUpdate(false), 15000);
                }}
                style={{
                  color: updateVersion ? '#10b981' : updateDownloading ? '#3b82f6' : checkingUpdate ? '#60a5fa' : undefined,
                  position: 'relative',
                }}
              >
                <ArrowUpCircle size={18} className={updateDownloading || checkingUpdate ? 'spinning' : ''} />
                {updateVersion && (
                  <span style={{
                    position: 'absolute', top: -4, right: -4,
                    width: 8, height: 8, borderRadius: '50%',
                    background: '#10b981', border: '2px solid var(--bg)',
                    boxShadow: '0 0 6px #10b981',
                    animation: 'pulse-green 1.5s ease-in-out infinite',
                  }} />
                )}
                {updateDownloading && !updateVersion && (
                  <span style={{
                    position: 'absolute', top: -6, right: -6,
                    background: '#3b82f6', color: '#fff', borderRadius: 8,
                    fontSize: 8, fontWeight: 700, padding: '1px 3px', lineHeight: 1,
                    minWidth: 18, textAlign: 'center',
                  }}>
                    {updateDownloading.percent ?? 0}%
                  </span>
                )}
              </button>
              {/* Up-to-date popup */}
              {upToDate && (
                <div style={{
                  position: 'absolute', top: 38, right: 0, zIndex: 200,
                  background: '#0c2a1a', border: '1px solid #10b981',
                  borderRadius: 10, padding: '10px 14px', whiteSpace: 'nowrap',
                  boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
                  animation: 'fadeIn 0.2s ease',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: '#10b981', fontSize: 16 }}>✓</span>
                    <div>
                      <div style={{ color: '#10b981', fontWeight: 700, fontSize: 13 }}>You are up to date!</div>
                      <div style={{ color: '#6ee7b7', fontSize: 12, marginTop: 2 }}>
                        SparkP2P v{upToDate.version} is the latest version.
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
          <button className="icon-btn" onClick={loadData} disabled={refreshing}>
            <RefreshCw size={18} className={refreshing ? 'spinning' : ''} />
          </button>
          {/* Logout moved to the mobile "More" menu and the desktop sidebar footer */}
          <button className="icon-btn dash-header-logout" onClick={logout} title="Logout"><LogOut size={18} /></button>
        </div>
      </header>

      <nav className="dash-tabs">
        {['overview', 'orders', 'transactions', 'logs', 'settings'].map((tab) => (
          <button
            key={tab}
            className={`tab-btn ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
        {affiliateData?.affiliate && (
          <button
            className={`tab-btn ${activeTab === 'affiliates' ? 'active' : ''}`}
            onClick={() => setActiveTab('affiliates')}
            style={{ display: 'flex', alignItems: 'center', gap: 5 }}
          >
            <Share2 size={13} /> Affiliates
          </button>
        )}
        {!profile?.binance_connected && (
          <button
            className="tab-btn"
            style={{ color: '#f59e0b', fontWeight: 600 }}
            onClick={() => setActiveTab('settings')}
          >
            Connect Binance
          </button>
        )}
        <button
          className="tab-btn"
          style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#f59e0b', fontWeight: 600 }}
          onClick={() => setShowConfigModal(true)}
          title="Configure Bot"
        >
          <SlidersHorizontal size={14} /> Configure
        </button>
        <button
          className={`tab-btn ${activeTab === 'credits' ? 'active' : ''}`}
          style={{ display: 'flex', alignItems: 'center', gap: 5, color: activeTab === 'credits' ? '#fff' : '#10b981', fontWeight: 700 }}
          onClick={() => setActiveTab('credits')}
        >
          <DollarSign size={14} /> Subscriptions
        </button>
        <div style={{ position: 'relative', marginLeft: 'auto' }}>
          <button
            className="tab-btn"
            style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#10b981', fontWeight: 600, fontSize: 13 }}
            onClick={() => setShowPaybill(!showPaybill)}
          >
            <CreditCard size={14} /> My Paybill
          </button>
          {showPaybill && (
            <div style={{ position: 'absolute', top: 40, right: 0, width: 340, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 8px 30px rgba(0,0,0,0.4)', zIndex: 100, padding: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>🏦 Choice Bank Payment Details</div>
              <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 12 }}>
                Copy these details to receive payments via M-Pesa Paybill into your Choice Bank account.
              </div>

              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>Account Name</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg)', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)' }}>
                  <span style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>{profile?.full_name || 'Loading...'}</span>
                  <button onClick={() => { navigator.clipboard.writeText(profile?.full_name || ''); setCopied('name'); setTimeout(() => setCopied(''), 2000); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: copied === 'name' ? '#10b981' : '#9ca3af', padding: 2 }}>
                    <Copy size={14} />
                  </button>
                </div>
              </div>

              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>Account Number</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg)', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)' }}>
                  <span style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>{profile?.choice_account_number || profile?.choice_account_id || 'Pending verification'}</span>
                  <button onClick={() => { navigator.clipboard.writeText(profile?.choice_account_number || profile?.choice_account_id || ''); setCopied('account'); setTimeout(() => setCopied(''), 2000); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: copied === 'account' ? '#10b981' : '#9ca3af', padding: 2 }}>
                    <Copy size={14} />
                  </button>
                </div>
              </div>

              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>Paybill Number</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg)', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)' }}>
                  <span style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>{profile?.choice_paybill || '444174'}</span>
                  <button onClick={() => { navigator.clipboard.writeText(profile?.choice_paybill || '444174'); setCopied('paybill'); setTimeout(() => setCopied(''), 2000); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: copied === 'paybill' ? '#10b981' : '#9ca3af', padding: 2 }}>
                    <Copy size={14} />
                  </button>
                </div>
              </div>

              {copied && (
                <div style={{ fontSize: 12, color: '#10b981', textAlign: 'center', marginBottom: 8 }}>Copied!</div>
              )}

              <div style={{ fontSize: 11, color: '#6b7280', lineHeight: 1.5, padding: '8px 0', borderTop: '1px solid var(--border)' }}>
                Share these details with buyers on Binance P2P. Payments go directly to your Choice Bank account.
              </div>
            </div>
          )}
        </div>
      </nav>

      <div className="dash-body">

        {/* ── Desktop / Tablet Sidebar ── */}
        <aside className="dash-sidebar">
          {/* Brand — shows Binance merchant tier once an API key is connected */}
          {(() => {
            // Badge reflects the REAL Binance P2P tier detected from the public board — shown only
            // for confirmed merchants (gold/silver/bronze). Non-merchants ('normal') / unknown: no badge.
            const tier = (profile?.binance_p2p_tier || '').toLowerCase();
            const TIERS = {
              gold:   { label: 'Gold Merchant',   color: '#f59e0b', glow: 'rgba(245,158,11,0.18)' },
              silver: { label: 'Silver Merchant', color: '#cbd5e1', glow: 'rgba(203,213,225,0.16)' },
              bronze: { label: 'Bronze Merchant', color: '#d97757', glow: 'rgba(217,119,87,0.16)' },
            };
            const t = TIERS[tier];
            if (t) {
              return (
                <div className="dsb-brand">
                  <div style={{ width: 28, height: 28, borderRadius: 6, background: t.glow, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <svg width="17" height="17" viewBox="0 0 24 24" fill={t.color} stroke={t.color} strokeWidth="1" strokeLinejoin="round">
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                    </svg>
                  </div>
                  <div style={{ lineHeight: 1.15 }}>
                    <div style={{ color: t.color, fontWeight: 700, fontSize: 13 }}>{t.label}</div>
                    <div style={{ color: '#6B7280', fontSize: 10 }}>Binance P2P</div>
                  </div>
                </div>
              );
            }
            return (
              <div className="dsb-brand">
                <img src="/spark-icon.svg" alt="SparkP2P" style={{ width: 28, height: 28, borderRadius: 6 }} />
                <div style={{ lineHeight: 1.1 }}>
                  <div style={{ color: '#F59E0B', fontWeight: 500, fontSize: 14 }}>SparkP2P</div>
                  {appVersion && <div style={{ color: '#6B7280', fontSize: 10 }}>v{appVersion}</div>}
                </div>
              </div>
            );
          })()}

          {/* Main nav */}
          <div className="dsb-section-label">Main</div>
          {[
            { key: 'overview',      icon: LayoutDashboard, label: 'Overview'      },
            { key: 'orders',        icon: List,            label: 'Orders'        },
            { key: 'transactions',  icon: ArrowRightLeft,  label: 'Transactions'  },
            { key: 'profit',        icon: BarChart2,       label: 'Profit'        },
            ...((profile?.price_tracker_enabled && !rateLimit?.locked) ? [{ key: 'pricetracker', icon: TrendingUp, label: 'Price Tracker' }] : []),
            { key: 'logs',          icon: Activity,        label: 'Logs'          },
          ].map(({ key, icon: Icon, label }) => (
            <button key={key}
              className={`dsb-nav-item${activeTab === key ? ' dsb-active' : ''}`}
              onClick={() => setActiveTab(key)}
            >
              <Icon size={16} />
              <span>{label}</span>
            </button>
          ))}

          {/* Account nav */}
          <div className="dsb-section-label">Account</div>
          <button
            className={`dsb-nav-item${activeTab === 'settings' ? ' dsb-active' : ''}`}
            onClick={() => setActiveTab('settings')}
          >
            <Settings size={16} /><span>Settings</span>
          </button>
          {affiliateData?.affiliate && (
            <button
              className={`dsb-nav-item${activeTab === 'affiliates' ? ' dsb-active' : ''}`}
              onClick={() => setActiveTab('affiliates')}
            >
              <Share2 size={16} /><span>Affiliates</span>
            </button>
          )}
          <button
            className={`dsb-nav-item${activeTab === 'paybill' ? ' dsb-active' : ''}`}
            onClick={() => setActiveTab('paybill')}
          >
            <CreditCard size={16} /><span>My Paybill</span>
          </button>

          {/* Setup nav */}
          <div className="dsb-section-label">Setup</div>
          {!profile?.binance_connected && (
            <button className="dsb-nav-item dsb-warn" onClick={() => setActiveTab('settings')}>
              <Wifi size={16} /><span>Connect Binance</span>
            </button>
          )}
          <button
            className={`dsb-nav-item dsb-accent${activeTab === 'configure' ? ' dsb-active' : ''}`}
            onClick={() => setActiveTab('configure')}
          >
            <SlidersHorizontal size={16} /><span>Configure</span>
          </button>
          <button
            className={`dsb-nav-item dsb-green${activeTab === 'credits' ? ' dsb-active' : ''}`}
            onClick={() => setActiveTab('credits')}
          >
            <DollarSign size={16} /><span>Subscriptions</span>
          </button>

          {/* Footer */}
          <div className="dsb-footer">
            <div className="dsb-user-row">
              <div className="dsb-avatar">{(user?.full_name || 'U').charAt(0).toUpperCase()}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: '#E5E7EB', fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.full_name}</div>
                <div style={{ color: '#F59E0B', fontSize: 10, fontWeight: 500, textTransform: 'uppercase' }}>{profile?.tier || 'standard'}</div>
              </div>
              <button className="icon-btn" onClick={logout} title="Logout" style={{ padding: 4 }}>
                <LogOut size={15} />
              </button>
            </div>
          </div>
        </aside>

        <main className="dash-content">
<MobileRelayBanner />
{activeTab === 'overview' && (
          <>
            {/* Daily trade-limit reached — blocking banner with live countdown to the 3 AM reset */}
            {rateLimit?.trades && !rateLimit.trades.allowed && (() => {
              const ms = Math.max(0, new Date(rateLimit.trades.reset_at).getTime() - rlNow);
              const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
              const pad = (n) => String(n).padStart(2, '0');
              return (
                <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: 12, padding: '14px 18px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 20 }}>⏳</span>
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <div style={{ color: '#ef4444', fontWeight: 800, fontSize: 14 }}>Daily trade limit reached ({rateLimit.trades.used}/{rateLimit.trades.limit})</div>
                    <div style={{ color: '#9ca3af', fontSize: 12, marginTop: 2 }}>
                      Trading is paused until the 3:00 AM reset. {rateLimit.plan_label ? `Upgrade your plan for a higher limit.` : 'Subscribe for a higher limit.'}
                    </div>
                  </div>
                  <div style={{ textAlign: 'center', minWidth: 92 }}>
                    <div style={{ color: '#ef4444', fontWeight: 800, fontSize: 20, fontVariantNumeric: 'tabular-nums', letterSpacing: '1px' }}>{pad(h)}:{pad(m)}:{pad(s)}</div>
                    <div style={{ color: '#6b7280', fontSize: 10 }}>until reset</div>
                  </div>
                  <button onClick={() => setActiveTab('credits')} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#ef4444', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Upgrade</button>
                </div>
              );
            })()}
            {/* Telegram alert cap reached — informational */}
            {rateLimit?.telegram && !rateLimit.telegram.allowed && (
              <div style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 10, padding: '10px 16px', marginBottom: 16, fontSize: 12, color: '#d97706' }}>
                🔕 Daily Telegram alert limit reached ({rateLimit.telegram.used}/{rateLimit.telegram.limit}). Alerts resume after the 3:00 AM reset.
              </div>
            )}
            {/* KYC rejection banner — shown when admin rejected our staging submission */}
            {profile && !profile.choice_account_id && (profile.choice_kyc_status || '').startsWith('rejected_admin:') && (
              <div onClick={async () => {
                try {
                  const res = await kycCreateSession();
                  const token = res.data.token;
                  if (isNative()) {
                    navigate(`/kyc/${token}`);
                  } else {
                    const url = `${window.location.origin}/verify-kyc?t=${token}`;
                    if (window.sparkp2p && window.sparkp2p.openExternal) {
                      window.sparkp2p.openExternal(url);
                    } else {
                      window.open(url, '_blank');
                    }
                  }
                } catch {
                  setSettingsInitialSection('bank');
                  setActiveTab('settings');
                }
              }}
                style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 18px', marginBottom: 16, borderRadius: 10,
                  background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.35)', cursor: 'pointer' }}>
                <span style={{ fontSize: 18, marginTop: 2 }}>❌</span>
                <div style={{ flex: 1 }}>
                  <div style={{ color: '#ef4444', fontWeight: 700, fontSize: 13, marginBottom: 4 }}>KYC Submission Needs Correction</div>
                  <div style={{ color: '#fca5a5', fontSize: 12, lineHeight: 1.5 }}>
                    {(profile.choice_kyc_status || '').replace('rejected_admin:', '') || 'Your KYC submission was rejected. Please fix and resubmit.'}
                  </div>
                  <div style={{ color: '#ef4444', fontSize: 12, fontWeight: 600, marginTop: 6 }}>Tap to Fix &amp; Resubmit →</div>
                </div>
              </div>
            )}
            {/* Choice Bank verification banner — only after profile loads (hide if already rejected — rejection banner shows instead) */}
            {profile && !profile.choice_account_id && !(profile.choice_kyc_status || '').startsWith('rejected_admin:') && (
              <div onClick={async () => {
                try {
                  const res = await kycCreateSession();
                  const token = res.data.token;
                  if (isNative()) {
                    // Mobile app: go straight into the in-app KYC form (no desktop→phone QR bridge).
                    navigate(`/kyc/${token}`);
                  } else {
                    const url = `${window.location.origin}/verify-kyc?t=${token}`;
                    if (window.sparkp2p && window.sparkp2p.openExternal) {
                      window.sparkp2p.openExternal(url);
                    } else {
                      window.open(url, '_blank');
                    }
                  }
                } catch {
                  setSettingsInitialSection('bank');
                  setActiveTab('settings');
                }
              }}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 18px', marginBottom: 16, borderRadius: 10,
                  background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.35)', cursor: 'pointer' }}>
                <span style={{ fontSize: 18 }}>🏦</span>
                <div style={{ flex: 1 }}>
                  <span style={{ color: '#f59e0b', fontWeight: 700, fontSize: 13 }}>Complete Bank Verification</span>
                  <span style={{ color: '#9ca3af', fontSize: 12, marginLeft: 8 }}>Link your Choice Bank account to receive M-Pesa payments automatically.</span>
                </div>
                <span style={{ color: '#f59e0b', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>Set up →</span>
              </div>
            )}

            {/* Row 1: Greeting + Wallet */}
            <div className="overview-grid-top">
              <div className="card greeting-card">
                <div className="greeting-text">
                  <span className="greeting-hello">Good {new Date().getHours() < 12 ? 'Morning' : new Date().getHours() < 18 ? 'Afternoon' : 'Evening'}, {user?.full_name}!</span>
                  {(() => {
                    // Use the most recent of: bot heartbeat, web heartbeat (dashboard open), or login.
                    const tsCandidates = [profile?.last_extension_sync || user?.last_extension_sync, profile?.last_web_active, profile?.last_login]
                      .filter(Boolean).map(x => new Date(x).getTime());
                    const ts = tsCandidates.length ? Math.max(...tsCandidates) : null;
                    const diff = ts ? (Date.now() - ts) / 1000 : null;
                    // Online if the desktop app is open (window.sparkp2p) or any heartbeat within 3 min.
                    const appOpen = typeof window !== 'undefined' && !!window.sparkp2p;
                    const online = appOpen || (diff !== null && diff < 180);
                    const label = online ? 'Online' : !ts ? 'Bot Never Connected' : diff < 3600 ? `Last seen ${Math.floor(diff/60)}m ago` : diff < 86400 ? `Last seen ${Math.floor(diff/3600)}h ago` : `Last seen ${Math.floor(diff/86400)}d ago`;
                    return (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: online ? '#10b981' : '#9ca3af', marginBottom: 2 }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: online ? '#10b981' : '#6b7280', flexShrink: 0 }} />
                        {label}
                      </span>
                    );
                  })()}
                  <span className="greeting-sub">Today's Earnings</span>
                  <span className="greeting-amount">KES {(profitData?.net_profit ?? stats?.today?.net_profit ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                </div>
                <div className="greeting-icon">
                  {(stats?.today?.net_profit || 0) >= 0 ? '📈' : '📉'}
                </div>
              </div>

              <div className="card wallet-mini-card"
                onClick={() => { if (profile?.choice_account_id) navigate('/payments'); }}
                style={profile?.choice_account_id ? { cursor: 'pointer' } : undefined}
                title={profile?.choice_account_id ? 'Open Payments' : undefined}>
                <div className="wallet-mini-header">
                  <span style={{ fontSize: 17 }}>🏦</span>
                  <span>Choice Bank</span>
                  {profile?.choice_account_id && (
                    <button
                      onClick={async (e) => { e.stopPropagation(); setCbBalanceLoading(true); try { const r = await choiceGetBalance(profile.id); setCbDashBalance(r.data); } catch {} finally { setCbBalanceLoading(false); } }}
                      style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center' }}
                      title="Refresh balance"
                    >
                      <RefreshCw size={13} style={{ animation: cbBalanceLoading ? 'spin 1s linear infinite' : 'none' }} />
                    </button>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowBalance(v => !v); }}
                    style={{ marginLeft: profile?.choice_account_id ? 0 : 'auto', background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center' }}
                    title={showBalance ? 'Hide balance' : 'Show balance'}
                  >
                    {showBalance ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                  {profile?.choice_account_id && <ChevronRight size={16} style={{ marginLeft: 'auto', color: '#f59e0b' }} />}
                </div>

                {profile?.choice_account_id ? (
                  <>
                    <div className="wallet-mini-amount">
                      {showBalance
                        ? `KES ${Number(cbDashBalance?.balance || 0).toLocaleString()}`
                        : 'KES ••••••'}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#9ca3af', marginBottom: 14, letterSpacing: 0.5 }}>
                      {profile.choice_account_number || profile.choice_account_id}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); setCbDepositMsg(''); setCbDepositAmount(''); setCbDepositPhone(profile?.phone || ''); setShowCbDepositModal(true); }}
                        style={{ flex: 1, padding: '10px 0', borderRadius: 9, border: 'none', background: 'linear-gradient(135deg, #10b981, #059669)', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}
                      >
                        ➕ Deposit
                      </button>
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          setCbWithdrawMsg(''); setCbWithdrawAmount(''); setCbWithdrawOtp('');
                          setCbWithdrawOtpSent(false);
                          try { const r = await getCbWithdrawalBank(); setCbWithdrawBank(r.data); } catch { setCbWithdrawBank(null); }
                          setShowCbWithdrawModal(true);
                        }}
                        style={{ flex: 1, padding: '10px 0', borderRadius: 9, border: '1px solid rgba(239,68,68,0.4)', background: 'rgba(239,68,68,0.08)', color: '#ef4444', fontWeight: 700, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}
                      >
                        ↗️ Withdraw
                      </button>
                    </div>
                    <div style={{ marginTop: 10, fontSize: 12, color: '#f59e0b', fontWeight: 600, textAlign: 'center' }}>
                      Click here for more →
                    </div>
                  </>
                ) : (
                  <div style={{ textAlign: 'center', padding: '20px 8px' }}>
                    <div style={{ fontSize: 28, marginBottom: 8 }}>🔒</div>
                    <div style={{ color: '#f59e0b', fontWeight: 700, fontSize: 13, marginBottom: 4 }}>Verification Required</div>
                    <div style={{ color: '#6b7280', fontSize: 11, lineHeight: 1.5 }}>Complete bank verification to see your live Choice Bank balance here.</div>
                  </div>
                )}
              </div>
            </div>

            {/* Prepaid I&M payout credits — only on the I&M / own-paybill rails.
                Choice Bank traders never see this (credits_enabled=false). */}
            {credits?.credits_enabled && (() => {
              const bal = credits.credits ?? 0;
              const rate = credits.credit_rate || 0;
              const paused = credits.paused_no_credits;
              const low = !paused && bal > 0 && bal <= 20;
              const accent = paused ? '#ef4444' : low ? '#f59e0b' : '#8b5cf6';
              const peak = Math.max(creditsPeak, bal, 1);
              const pct = barReady ? Math.min(100, Math.round((bal / peak) * 100)) : 0;
              return (
                <div className="card" style={{ marginBottom: 16, border: `1px solid ${accent}44`, background: paused ? 'rgba(239,68,68,0.06)' : '#0f0f16' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                      <div style={{ width: 46, height: 46, borderRadius: 12, background: `${accent}22`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0 }}>🎟️</div>
                      <div>
                        <div style={{ fontSize: 12, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '.5px', fontWeight: 600 }}>I&amp;M Automation credits</div>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 2 }}>
                          <span style={{ fontSize: 30, fontWeight: 800, color: accent }}>{bal.toLocaleString()}</span>
                          <span style={{ fontSize: 13, color: '#9ca3af' }}>credits · {bal.toLocaleString()} payout{bal === 1 ? '' : 's'} left</span>
                        </div>
                        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                          1 credit = 1 payout · KES {rate} each · pay to Paybill {credits.paybill}
                        </div>
                      </div>
                    </div>
                    <button onClick={() => { setBuyCreditsMsg(''); setBuyCreditsPhone(profile?.phone || ''); setShowBuyCredits(true); }}
                      style={{ padding: '11px 22px', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 700, background: accent, color: '#fff', flexShrink: 0 }}>
                      + Buy credits
                    </button>
                  </div>
                  {/* Animated usage bar: fills on load, drains as payouts consume credits. */}
                  <div style={{ marginTop: 16, height: 9, borderRadius: 6, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', width: pct + '%', borderRadius: 6,
                      background: paused ? '#ef4444' : low ? 'linear-gradient(90deg,#f59e0b,#fbbf24)' : 'linear-gradient(90deg,#8b5cf6,#a78bfa)',
                      transition: 'width 0.9s cubic-bezier(.34,.1,.2,1)',
                    }} />
                  </div>
                  {paused && (
                    <div style={{ marginTop: 14, padding: '10px 14px', borderRadius: 10, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444', fontSize: 13, fontWeight: 600 }}>
                      ⏸ Automation paused — you're out of credits. New Binance orders are ignored until you top up.
                    </div>
                  )}
                  {low && (
                    <div style={{ marginTop: 14, padding: '10px 14px', borderRadius: 10, background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', color: '#f59e0b', fontSize: 13, fontWeight: 600 }}>
                      ⚠ Running low — {bal} payout{bal === 1 ? '' : 's'} left. Top up to avoid a pause.
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Row 2: Quick Stats */}
            <div className="overview-stats-row">
              <div className="mini-stat-card">
                <Activity size={18} style={{ color: '#f59e0b', marginBottom: 4 }} />
                <span className="mini-stat-value">{profitData ? ((profitData.buy?.orders || 0) + (profitData.sell?.orders || 0)) : (stats?.today?.total_trades || 0)}</span>
                <span className="mini-stat-label">Total Trades</span>
              </div>
              <div className="mini-stat-card sell-card">
                <ArrowDown size={18} style={{ color: '#10b981', marginBottom: 4 }} />
                <span className="mini-stat-value">{profitData?.sell?.orders ?? stats?.today?.sell_trades ?? 0}</span>
                <span className="mini-stat-label">Sell Orders</span>
              </div>
              <div className="mini-stat-card buy-card">
                <ArrowUp size={18} style={{ color: '#3b82f6', marginBottom: 4 }} />
                <span className="mini-stat-value">{profitData?.buy?.orders ?? stats?.today?.buy_trades ?? 0}</span>
                <span className="mini-stat-label">Buy Orders</span>
              </div>
              <div className="mini-stat-card">
                <DollarSign size={18} style={{ color: '#f59e0b', marginBottom: 4 }} />
                <span className="mini-stat-value">KES {(profitData ? ((profitData.buy?.kes || 0) + (profitData.sell?.kes || 0)) : (stats?.today?.volume || 0)).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                <span style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>{((profitData?.buy?.usdt ?? stats?.today?.buy_crypto ?? 0) + (profitData?.sell?.usdt ?? stats?.today?.sell_crypto ?? 0)).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT</span>
                <span className="mini-stat-label">Total Volume</span>
              </div>
              <div className="mini-stat-card">
                <BarChart2 size={18} style={{ color: '#8b5cf6', marginBottom: 4 }} />
                <span className="mini-stat-value">{stats?.limits?.unlimited ? 'Unlimited' : `${stats?.limits?.remaining_today ?? 0}/${stats?.limits?.daily_limit ?? 0}`}</span>
                <span className="mini-stat-label">Daily Limit</span>
              </div>
            </div>




            {/* Row 3: Buy/Sell Breakdown + Profit */}
            <div className="overview-grid-mid">
              {/* Buying Summary */}
              <div className="card buysell-card buying">
                <div className="buysell-header">
                  <ArrowUpCircle size={24} />
                  <h3>Buying</h3>
                </div>
                <div className="buysell-amount">
                  <span className="buysell-crypto">{(profitData?.buy?.usdt ?? stats?.today?.buy_crypto ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT</span>
                  <span className="buysell-fiat">KES {(profitData?.buy?.kes ?? stats?.today?.buy_volume ?? 0).toLocaleString()}</span>
                </div>
                <div className="buysell-detail">
                  <div><span>Orders</span><span>{profitData?.buy?.orders ?? stats?.today?.buy_trades ?? 0}</span></div>
                  <div><span>Avg Rate</span><span>KES {(profitData?.buy?.avg_rate ?? stats?.today?.avg_buy_rate ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
                </div>
                <div style={{ borderTop: '1px solid var(--border)', marginTop: 10, paddingTop: 8, fontSize: 12, color: '#9ca3af' }}>
                  Minimum: <strong style={{ color: '#f59e0b' }}>KES 100,000</strong>
                </div>
              </div>

              {/* Selling Summary */}
              <div className="card buysell-card selling">
                <div className="buysell-header">
                  <ArrowDownCircle size={24} />
                  <h3>Selling</h3>
                </div>
                <div className="buysell-amount">
                  <span className="buysell-crypto">{(profitData?.sell?.usdt ?? stats?.today?.sell_crypto ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT</span>
                  <span className="buysell-fiat">KES {(profitData?.sell?.kes ?? stats?.today?.sell_volume ?? 0).toLocaleString()}</span>
                </div>
                <div className="buysell-detail">
                  <div><span>Orders</span><span>{profitData?.sell?.orders ?? stats?.today?.sell_trades ?? 0}</span></div>
                  <div><span>Avg Rate</span><span>KES {(profitData?.sell?.avg_rate ?? stats?.today?.avg_sell_rate ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
                </div>
                <div style={{ borderTop: '1px solid var(--border)', marginTop: 10, paddingTop: 8, fontSize: 12, color: '#9ca3af' }}>
                  Minimum: <strong style={{ color: '#10b981' }}>KES 1,000</strong>
                </div>
              </div>

              {/* Profit Summary */}
              <div className="card profit-card">
                <div className="card-header">
                  <TrendingUp size={24} style={{ color: '#10b981' }} />
                  <h3>Profit Breakdown</h3>
                </div>
                <div className="profit-amount">
                  <span className={`big-profit ${(profitData?.net_profit ?? stats?.today?.net_profit ?? 0) >= 0 ? 'positive' : 'negative'}`}>
                    KES {(profitData?.net_profit ?? stats?.today?.net_profit ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                  <span className="profit-label">Net Profit{profitData ? ' · today' : ''}</span>
                </div>
                <div className="profit-breakdown">
                  <div className="profit-row spread-row">
                    <span>Margin</span>
                    <span>KES {(profitData?.spread ?? stats?.today?.spread ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ({(profitData?.spread_pct ?? stats?.today?.spread_pct ?? 0)}%)</span>
                  </div>
                  <div className="profit-row">
                    <span>Gross Profit</span>
                    <span className="positive">KES {(profitData?.gross_profit ?? stats?.today?.gross_profit ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                  </div>
                  <div className="profit-row fee-row">
                    <span>Binance Fees (KES {binanceFeePerUsdt}/USDT · buy + sell)</span>
                    <span>-KES {(profitData?.fees_kes ?? stats?.today?.binance_fees ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                  </div>
                  {profitData && (
                    <div className="profit-row fee-row">
                      <span>Choice Bank Fees</span>
                      <span>-KES {(profitData.choice_bank_fees ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Margin calculator + profit — hidden entirely while the subscription is inactive */}
            {rateLimit?.locked ? (
              <SubscriptionLock onUnlock={() => setActiveTab('credits')} sub="Your subscription is inactive, so the margin calculator and profit are hidden. Renew to unlock them." />
            ) : (
              <>
                {/* Spread Calculator */}
                <SpreadCalculator orderStats={stats?.today} profile={profile} cbWithdrawBank={cbWithdrawBank} />

                {/* Profit Tracker — daily/weekly/monthly accumulation with history */}
                <ProfitTracker />
              </>
            )}

            {/* Affiliate Quick-Action Card */}
            {affiliateData !== null && (
              <div className="card" style={{ marginBottom: 16 }}>
                <div className="card-header" style={{ cursor: 'pointer' }} onClick={() => setActiveTab('affiliates')}>
                  <Share2 size={20} style={{ color: '#f59e0b' }} />
                  <h3>Affiliates</h3>
                  {affiliateData?.affiliate?.status === 'approved' && (
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 20, fontSize: 13, color: '#9ca3af' }}>
                      <span><strong style={{ color: '#f59e0b' }}>{affiliateReferrals?.summary?.total_referrals || 0}</strong> referrals</span>
                      <span>Pending: <strong style={{ color: '#10b981' }}>KES {(affiliateData.affiliate.pending_balance || 0).toLocaleString()}</strong></span>
                    </span>
                  )}
                  {affiliateData?.affiliate?.status === 'pending' && (
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: '#f59e0b', fontWeight: 600 }}>⏳ Application under review</span>
                  )}
                  {affiliateData?.affiliate?.status === 'rejected' && (
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: '#ef4444', fontWeight: 600 }}>Application rejected</span>
                  )}
                  <span style={{ marginLeft: affiliateData?.affiliate ? 12 : 'auto', color: '#3b82f6', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {affiliateData?.affiliate ? 'View →' : 'Apply as Affiliate →'}
                  </span>
                </div>
                {!affiliateData?.affiliate && (
                  <div style={{ padding: '8px 0 4px', color: '#9ca3af', fontSize: 13 }}>
                    Earn 10% commission on fees from every trader you refer. <button onClick={() => setActiveTab('affiliates')} style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', fontWeight: 600, padding: 0 }}>Apply now →</button>
                  </div>
                )}
              </div>
            )}

            {/* Row 4: Recent Orders */}
            <div className="card orders-card">
              <div className="card-header">
                <Clock size={20} />
                <h3>Recent Orders</h3>
              </div>
              <div className="orders-list">
                {orders.slice(0, 5).map((order) => (
                  <div key={order.id} className="order-item">
                    <div className="order-side">
                      {order.side === 'sell' ? (
                        <ArrowDownCircle size={18} color="#10b981" />
                      ) : (
                        <ArrowUpCircle size={18} color="#3b82f6" />
                      )}
                      <span>{order.side.toUpperCase()}</span>
                    </div>
                    <div className="order-details">
                      <span>{order.crypto_amount} {order.crypto_currency} @ {order.exchange_rate}</span>
                      <span className="fiat">KES {order.fiat_amount.toLocaleString()}</span>
                    </div>
                    <div className="order-status" style={{ color: getStatusColor(order.status) }}>
                      {order.status.replace('_', ' ')}
                    </div>
                  </div>
                ))}
                {orders.length === 0 && <p className="empty-msg">No orders yet</p>}
              </div>
            </div>

            {/* Binance Account Data */}
            {binanceData && (binanceData.balances?.length > 0 || binanceData.active_ads?.length > 0 || binanceData.completed_orders?.length > 0 || binanceData.updated_at) && (
              <>
                {/* Binance Username */}
                {binanceData.nickname && (
                  <div style={{ padding: '10px 0 4px', fontSize: 14, color: '#9ca3af' }}>
                    Binance Account: <span style={{ color: '#f59e0b', fontWeight: 600 }}>{binanceData.nickname}</span>
                  </div>
                )}

                {/* Active Ads */}
                {binanceData.active_ads?.length > 0 && (
                  <div className="card">
                    <div className="card-header">
                      <TrendingUp size={20} />
                      <h3>Your Active Ads on Binance</h3>
                    </div>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Type</th>
                          <th>Asset</th>
                          <th>Price</th>
                          <th>Available</th>
                          <th>Limits</th>
                        </tr>
                      </thead>
                      <tbody>
                        {binanceData.active_ads.map((ad, i) => (
                          <tr key={i}>
                            <td className={ad.tradeType === 'SELL' ? 'sell' : 'buy'}>{ad.tradeType}</td>
                            <td>{ad.asset}</td>
                            <td>KES {ad.price?.toLocaleString()}</td>
                            <td>{ad.amount?.toFixed(2)} {ad.asset}</td>
                            <td>KES {ad.minLimit?.toLocaleString()} - {ad.maxLimit?.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Binance Order History */}
                {binanceData.completed_orders?.length > 0 && (
                  <div className="card">
                    <div className="card-header">
                      <Clock size={20} />
                      <h3>Binance Order History</h3>
                      <span style={{ marginLeft: 'auto', fontSize: 12, color: '#6b7280' }}>
                        Last synced: {binanceData.updated_at ? fmtTimeEAT(binanceData.updated_at) : 'Never'}
                      </span>
                    </div>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Type</th>
                          <th>Amount</th>
                          <th>Crypto</th>
                          <th>Rate</th>
                          <th>Counterparty</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {binanceData.completed_orders.map((o, i) => (
                          <tr key={i}>
                            <td className={o.tradeType === 'SELL' ? 'sell' : 'buy'}>{o.tradeType}</td>
                            <td>KES {o.totalPrice?.toLocaleString()}</td>
                            <td>{o.amount?.toFixed(2)} {o.asset}</td>
                            <td>KES {o.price?.toFixed(2)}</td>
                            <td>{o.counterparty || '-'}</td>
                            <td style={{ color: o.status === 4 ? '#10b981' : '#f59e0b' }}>
                              {o.status === 4 ? 'Completed' : o.status === 5 ? 'Cancelled' : 'Other'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {activeTab === 'orders' && (() => {
          // Fetching is handled by the binance-orders effect (keyed on filter/page);
          // these handlers just update state and the effect reloads.
          const handleFilterChange = (f) => {
            setOrdersFilter(f);
            setOrdersPage(1);
          };

          const handlePageChange = (p) => {
            setOrdersPage(p);
          };

          const handleExportOrders = async () => {
            setExporting(true);
            try {
              const res = await exportOrders(exportRange, exportType);
              const blobUrl = URL.createObjectURL(res.data);
              const a = document.createElement('a');
              a.href = blobUrl;
              a.download = `sparkp2p-orders-${exportRange}-${exportType}.xlsx`;
              document.body.appendChild(a);
              a.click();
              a.remove();
              URL.revokeObjectURL(blobUrl);
            } catch (e) {
              alert('Could not export orders. Please try again.');
            } finally {
              setExporting(false);
            }
          };

          const RANGE_OPTS = [
            { key: '24h', label: '24 hours' },
            { key: '7d',  label: '7 days' },
            { key: '30d', label: '30 days' },
            { key: '1y',  label: '1 year' },
            { key: 'all', label: 'All time' },
          ];

          const incomingCount = orders.filter(o => o.side === 'sell').length;
          const outgoingCount = orders.filter(o => o.side === 'buy').length;

          return (
            <div className="card">
              {/* Sub-tab filter */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[
                    { key: 'all',      label: 'All Orders',  color: '#9ca3af' },
                    { key: 'incoming', label: '↓ Incoming',  color: '#10b981' },
                    { key: 'outgoing', label: '↑ Outgoing',  color: '#3b82f6' },
                  ].map(({ key, label, color }) => (
                    <button key={key} onClick={() => handleFilterChange(key)}
                      style={{ padding: '7px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 13, transition: 'all 0.15s',
                        background: ordersFilter === key ? color : '#1f2937',
                        color: ordersFilter === key ? (key === 'all' ? '#111' : '#fff') : '#6b7280' }}>
                      {label}
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 16 }}>
                  <span style={{ fontSize: 12, color: '#10b981' }}>↓ Incoming = buyers pay you (sell orders)</span>
                  <span style={{ fontSize: 12, color: '#3b82f6' }}>↑ Outgoing = you pay sellers (buy orders)</span>
                </div>
              </div>

              {/* Export to Excel */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                background: '#0e1117', border: '1px solid #1f2937', borderRadius: 10, padding: '12px 14px', marginBottom: 18 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#fff', display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ fontSize: 15 }}>📊</span> Export to Excel
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <label style={{ fontSize: 11, color: '#6b7280' }}>Period</label>
                  <select value={exportRange} onChange={e => setExportRange(e.target.value)}
                    style={{ background: '#1f2937', color: '#fff', border: '1px solid #374151', borderRadius: 7, padding: '7px 10px', fontSize: 13, cursor: 'pointer' }}>
                    {RANGE_OPTS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                  </select>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <label style={{ fontSize: 11, color: '#6b7280' }}>Type</label>
                  <select value={exportType} onChange={e => setExportType(e.target.value)}
                    style={{ background: '#1f2937', color: '#fff', border: '1px solid #374151', borderRadius: 7, padding: '7px 10px', fontSize: 13, cursor: 'pointer' }}>
                    <option value="all">Incoming + Outgoing</option>
                    <option value="incoming">Incoming only</option>
                    <option value="outgoing">Outgoing only</option>
                  </select>
                </div>
                <button onClick={handleExportOrders} disabled={exporting}
                  style={{ padding: '8px 18px', borderRadius: 8, border: 'none', cursor: exporting ? 'not-allowed' : 'pointer',
                    fontWeight: 700, fontSize: 13, background: exporting ? '#374151' : '#10b981', color: '#fff', display: 'flex', alignItems: 'center', gap: 7 }}>
                  {exporting ? 'Preparing…' : '⬇ Download .xlsx'}
                </button>
                <span style={{ fontSize: 11, color: '#6b7280' }}>
                  Day resets at 3:00 AM EAT — “24 hours” = today’s trading day.
                </span>
              </div>

              <table className="data-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Amount (KES)</th>
                    <th>Crypto</th>
                    <th>Rate</th>
                    <th>Status</th>
                    <th>Reference</th>
                    <th>Time</th>
                    <th>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.length === 0 ? (
                    <tr><td colSpan={8} style={{ textAlign: 'center', color: '#6b7280', padding: '32px 0' }}>No orders found</td></tr>
                  ) : orders.map((order) => {
                    const { secs, live, overdue } = getOrderDuration(order);
                    const isIncoming = order.side === 'sell';
                    return (
                      <tr key={order.id}>
                        <td>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700,
                            background: isIncoming ? 'rgba(16,185,129,0.12)' : 'rgba(59,130,246,0.12)',
                            color: isIncoming ? '#10b981' : '#3b82f6',
                            border: `1px solid ${isIncoming ? 'rgba(16,185,129,0.3)' : 'rgba(59,130,246,0.3)'}` }}>
                            {isIncoming ? '↓ Incoming' : '↑ Outgoing'}
                          </span>
                        </td>
                        <td style={{ fontWeight: 600 }}>KES {(order.fiat_amount || 0).toLocaleString()}</td>
                        <td>{order.crypto_amount} {order.crypto_currency}</td>
                        <td style={{ color: '#9ca3af' }}>{order.exchange_rate}</td>
                        <td style={{ color: getStatusColor(order.status) }}>
                          {(order.status || '').replace(/_/g, ' ')}
                        </td>
                        <td className="mono" style={{ fontSize: 12 }}>{order.account_reference || '—'}</td>
                        <td style={{ fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>{fmtDateEAT(order.created_at)}</td>
                        <td style={{ fontVariantNumeric: 'tabular-nums', color: overdue ? '#f97316' : live ? '#facc15' : '#9ca3af', fontWeight: live ? 600 : 400, whiteSpace: 'nowrap' }}>
                          {order._binance ? '—' : (<>
                            {overdue && <span title="Binance timer expired" style={{ marginRight: 4 }}>⚠️</span>}
                            {formatDuration(secs)}
                            {live && <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.6 }}>●</span>}
                          </>)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {/* Pagination */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 16 }}>
                <button onClick={() => handlePageChange(Math.max(1, ordersPage - 1))} disabled={ordersPage === 1}
                  style={{ padding: '6px 16px', borderRadius: 8, border: 'none', cursor: ordersPage === 1 ? 'not-allowed' : 'pointer',
                    background: ordersPage === 1 ? '#1f2937' : '#374151', color: ordersPage === 1 ? '#6b7280' : '#f9fafb', fontWeight: 600, fontSize: 13 }}>← Prev</button>
                <span style={{ fontSize: 13, color: '#6b7280' }}>Page {ordersPage}</span>
                <button onClick={() => handlePageChange(ordersPage + 1)} disabled={!ordersHasMore}
                  style={{ padding: '6px 16px', borderRadius: 8, border: 'none', cursor: !ordersHasMore ? 'not-allowed' : 'pointer',
                    background: !ordersHasMore ? '#1f2937' : '#374151', color: !ordersHasMore ? '#6b7280' : '#f9fafb', fontWeight: 600, fontSize: 13 }}>Next →</button>
              </div>
            </div>
          );
        })()}


        {activeTab === 'settings' && <SettingsPanel profile={profile} onUpdate={loadData} initialSection={settingsInitialSection} />}

        {/* ── Profit Tab ── */}
        {activeTab === 'profit' && (rateLimit?.locked
          ? <SubscriptionLock onUnlock={() => setActiveTab('credits')} sub="Your profit statistics are hidden while your subscription is inactive. Renew to see them again." />
          : <ProfitPage />)}

        {/* ── Price Tracker Tab (admin-gated) ── */}
        {activeTab === 'pricetracker' && rateLimit?.locked && (
          <SubscriptionLock onUnlock={() => setActiveTab('credits')} sub="The Price Tracker is unavailable while your subscription is inactive. Renew to unlock it." />
        )}
        {activeTab === 'pricetracker' && !rateLimit?.locked && (
          profile?.price_tracker_enabled ? (
            <div>
              <div style={{ display: 'flex', gap: 10, marginBottom: 18, overflowX: 'auto', paddingBottom: 2 }}>
                {[['tracker', '⚡ Price Tracker'], ['activity', '📊 Market Activity'], ['squad', '🤝 Squad']].map(([k, lbl]) => (
                  <button
                    key={k}
                    onClick={() => setPtView(k)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 9, whiteSpace: 'nowrap',
                      padding: '11px 18px', borderRadius: 12, fontSize: 14, fontWeight: 600, cursor: 'pointer',
                      fontFamily: '"Inter",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
                      border: '1px solid ' + (ptView === k ? 'rgba(245,166,35,0.4)' : 'rgba(255,255,255,0.11)'),
                      background: ptView === k ? 'rgba(245,166,35,0.12)' : '#171B22',
                      color: ptView === k ? '#FFBE52' : '#929AA6',
                      transition: 'all .15s',
                    }}
                  >{lbl}</button>
                ))}
              </div>
              {ptView === 'tracker'
                ? <PriceTracker enabled={true} binanceName={profile?.binance_nickname} profile={profile} />
                : ptView === 'activity'
                  ? <MarketActivity enabled={true} />
                  : <SquadPanel enabled={true} />}
            </div>
          ) : <div className="card"><p style={{ color: '#9ca3af', padding: '14px 0', margin: 0 }}>Price Tracker is not enabled for your account.</p></div>
        )}

        {/* ── Transactions Tab ── */}
        {activeTab === 'transactions' && (
          <div>
            {/* Summary */}
            {(() => {
              const inTotal  = allTxns.filter(t => t.direction === 'in').reduce((s, t) => s + t.amount, 0);
              const outTotal = allTxns.filter(t => t.direction === 'out').reduce((s, t) => s + t.amount, 0);
              const fmt = v => 'KES ' + v.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              return (
                <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
                  <div style={{ flex: 1, background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: 12, padding: '14px 18px' }}>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Total Inbound</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: '#10b981' }}>{fmt(inTotal)}</div>
                  </div>
                  <div style={{ flex: 1, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 12, padding: '14px 18px' }}>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Total Outbound</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: '#ef4444' }}>{fmt(outTotal)}</div>
                  </div>
                  <div style={{ flex: 1, background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 12, padding: '14px 18px' }}>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Net</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: (inTotal - outTotal) >= 0 ? '#10b981' : '#ef4444' }}>{fmt(inTotal - outTotal)}</div>
                  </div>
                </div>
              );
            })()}

            {/* Filters + Refresh */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
              {[['all', 'All'], ['in', 'Inbound'], ['out', 'Outbound']].map(([v, l]) => (
                <button key={v} onClick={() => setTxFilter(v)} style={{ padding: '6px 16px', borderRadius: 20, border: '1px solid', borderColor: txFilter === v ? '#10b981' : 'var(--border)', background: txFilter === v ? 'rgba(16,185,129,0.15)' : 'transparent', color: txFilter === v ? '#10b981' : '#6b7280', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                  {l}
                </button>
              ))}
              <button
                onClick={() => { setAllTxnsLoading(true); getMyTransactions(100).then(r => { if (r.data) setAllTxns(r.data); }).catch(() => {}).finally(() => setAllTxnsLoading(false)); }}
                style={{ marginLeft: 'auto', padding: '6px 14px', borderRadius: 20, border: '1px solid var(--border)', background: 'transparent', color: '#6b7280', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}
              >
                <RefreshCw size={12} className={allTxnsLoading ? 'spinning' : ''} /> Refresh
              </button>
            </div>

            {/* List */}
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              {allTxnsLoading && allTxns.length === 0 && (
                <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading transactions…</div>
              )}
              {!allTxnsLoading && allTxns.length === 0 && (
                <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>No transactions yet</div>
              )}
              {allTxns
                .filter(t => txFilter === 'all' || t.direction === txFilter)
                .map((t, i, arr) => {
                  const isIn = t.direction === 'in';
                  const dateStr = new Date(t.created_at).toLocaleString('en-KE', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true });
                  const fmtAmt = v => 'KES ' + v.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                  return (
                    <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 18px', borderBottom: i < arr.length - 1 ? '1px solid #111827' : 'none' }}>
                      <div style={{ width: 38, height: 38, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: isIn ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)', fontSize: 17, flexShrink: 0 }}>
                        {t.icon || (isIn ? '↙️' : '↗️')}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', marginBottom: 2 }}>
                          {t.label}
                          {t.counterparty_name && <span style={{ color: '#9aa4b2', fontWeight: 500 }}> · {t.counterparty_name}</span>}
                        </div>
                        <div style={{ fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {t.description !== t.label ? t.description : ''}{t.phone ? ' · ' + t.phone : ''} · {dateStr}
                        </div>
                        {t.reference && <div style={{ fontSize: 10, color: '#4b5563', marginTop: 1 }}>Ref: {t.reference}</div>}
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: isIn ? '#10b981' : '#ef4444' }}>
                          {isIn ? '+' : '-'}{fmtAmt(t.amount)}
                        </div>
                        {!isIn && t.tx_fee > 0 && (
                          <div style={{ fontSize: 10, color: '#6b7280', marginTop: 1 }}>Fee: KES {t.tx_fee}</div>
                        )}
                        {t.status === 'completed' && !isIn && (
                          <div style={{ fontSize: 10, color: '#10b981', marginTop: 1 }}>✓ completed</div>
                        )}
                        {t.status && t.status !== 'completed' && (
                          <div style={{ fontSize: 10, color: t.status === 'failed' ? '#ef4444' : '#f59e0b', marginTop: 1 }}>{t.status}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        )}

        {/* ── Logs Tab ── */}
        {activeTab === 'logs' && (
          <div className="card" style={{ fontFamily: 'monospace', fontSize: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ margin: 0 }}>Activity Logs</h3>
              <span style={{ color: '#6b7280', fontSize: 11 }}>{botLogs.length} entries</span>
            </div>
            {!window.sparkp2p ? (
              <p style={{ color: '#6b7280', textAlign: 'center', padding: 40 }}>Logs are only available in the desktop app.</p>
            ) : botLogs.length === 0 ? (
              <p style={{ color: '#6b7280', textAlign: 'center', padding: 40 }}>No activity yet. Logs will appear here as the bot runs.</p>
            ) : (
              <div style={{ maxHeight: 'calc(80vh - 140px)', minHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                {botLogs.map((log, i) => {
                  const colors = { success: '#10b981', error: '#ef4444', warning: '#f59e0b', info: '#6b7280' };
                  const badges = { success: '✓', error: '✕', warning: '⚠', info: '·' };
                  const color = colors[log.level] || '#6b7280';
                  const badge = badges[log.level] || '·';
                  const time = fmtTimeEAT(log.time);
                  return (
                    <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '4px 6px', borderRadius: 4, background: i % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent' }}>
                      <span style={{ color, minWidth: 14, marginTop: 1 }}>{badge}</span>
                      <span style={{ color: '#374151', minWidth: 70, fontSize: 10, marginTop: 2 }}>{time}</span>
                      <span style={{ color: log.level === 'error' ? '#fca5a5' : log.level === 'success' ? '#6ee7b7' : log.level === 'warning' ? '#fcd34d' : '#9ca3af', flex: 1, wordBreak: 'break-word' }}>{log.message}</span>
                    </div>
                  );
                })}
                <div ref={logsEndRef} />
              </div>
            )}
          </div>
        )}

        {/* ── Affiliates Tab ── */}
        {activeTab === 'configure' && (
          <div>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 28 }}>
              <div>
                <h2 style={{ color: '#fff', fontSize: 20, fontWeight: 700, margin: '0 0 4px' }}>Configure bot</h2>
                <p style={{ color: '#6b7280', fontSize: 13, margin: 0 }}>Control what the bot automates and how it screens counterparties</p>
              </div>
              <button
                onClick={async () => {
                  setSavingConfig(true);
                  try {
                    const res = await api.put('/traders/trading-config', { bot_trade_mode: botTradeMode, dd_enabled: ddEnabled, bot_full_auto: botFullAuto, dd_min_30d_trades: ddMin30d, dd_min_all_trades: ddMinAll, cf_filters_enabled: cfEnabled, cf_all_trades_min: parseInt(cfAllTradesMin) || 0, cf_all_trades_min_all: parseInt(cfAllTradesMinAll) || 0, cf_max_pay_mins: parseInt(cfMaxPayMins) || 0, cf_max_release_mins: parseInt(cfMaxReleaseMins) || 0, telegram_notify_scope: tgNotifyScope, binance_fee_per_usdt: parseFloat(binanceFeePerUsdt) || 0.25 });
                    configSavedAt.current = Date.now();
                    setConfigSaved(true);
                    setTimeout(() => { setConfigSaved(false); }, 1500);
                    checkCfSync(); // refresh live Binance sync badge
                    if (res?.data?.warning) alert(res.data.warning);
                  } catch (e) {}
                  setSavingConfig(false);
                }}
                disabled={savingConfig || configSaved}
                style={{ padding: '9px 22px', borderRadius: 8, border: 'none', background: configSaved ? '#059669' : '#10b981', color: '#fff', fontWeight: 700, fontSize: 13, cursor: savingConfig || configSaved ? 'default' : 'pointer', flexShrink: 0, whiteSpace: 'nowrap', opacity: savingConfig ? 0.7 : 1, transition: 'background 0.2s' }}
              >
                {savingConfig ? 'Saving…' : configSaved ? '✓ Saved' : 'Save changes'}
              </button>
            </div>

            {/* ORDER TYPES */}
            <div style={{ color: '#6b7280', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: 6 }}>Order Types</div>
            <p style={{ color: '#9ca3af', fontSize: 13, marginBottom: 14 }}>Choose which order types the bot should automate. Orders outside the selected mode stay visible on Binance — you complete them manually.</p>
            <div className="cfg-order-grid">
              {[
                { value: 'both',      label: 'Buy & sell',       badge: 'DEFAULT', desc: 'Bot fully automates both sides — pays sellers for incoming buy orders and releases USDT to buyers for sell orders.',         footNote: 'Recommended for most traders', footColor: '#10b981', warn: null },
                { value: 'buy_only',  label: 'Buy orders only',  badge: null,      desc: 'Bot pays sellers and acquires USDT automatically when buyers place orders.',                                                   footNote: null, footColor: null, warn: "Sell orders won't be automated. Release USDT manually on Binance." },
                { value: 'sell_only', label: 'Sell orders only', badge: null,      desc: 'Bot receives M-Pesa payments and releases USDT to buyers automatically.',                                                      footNote: null, footColor: null, warn: "Buy orders won't be automated. Pay sellers manually on Binance." },
              ].map(opt => {
                const active = botTradeMode === opt.value;
                return (
                  <div key={opt.value} onClick={() => setBotTradeMode(opt.value)}
                    style={{ padding: 16, borderRadius: 10, border: `1px solid ${active ? '#f59e0b' : '#1f2937'}`, background: active ? 'rgba(245,158,11,0.06)' : '#0d1117', cursor: 'pointer', transition: 'all 0.15s', display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ width: 18, height: 18, borderRadius: '50%', border: `2px solid ${active ? '#f59e0b' : '#374151'}`, background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {active && <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#f59e0b' }} />}
                      </div>
                      {opt.badge && <span style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', background: '#1f2937', padding: '2px 8px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{opt.badge}</span>}
                    </div>
                    <div>
                      <div style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 700, marginBottom: 6 }}>{opt.label}</div>
                      <div style={{ color: '#9ca3af', fontSize: 12, lineHeight: 1.5 }}>{opt.desc}</div>
                    </div>
                    {opt.warn && <div style={{ fontSize: 11, color: '#f59e0b', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 6, padding: '6px 8px', lineHeight: 1.4 }}>{opt.warn}</div>}
                    {opt.footNote && <div style={{ fontSize: 11, color: opt.footColor, fontWeight: 500 }}>{opt.footNote}</div>}
                  </div>
                );
              })}
            </div>

            {/* COUNTERPARTY SCREENING */}
            <div style={{ color: '#6b7280', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.8px', margin: '28px 0 14px' }}>Counterparty Screening</div>

            {/* Telegram screening row */}
            <div style={{ background: '#0d1117', border: '0.5px solid #1f2937', borderRadius: 10, padding: '14px 16px', marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 600 }}>Screen via Telegram before sharing payment details</div>
                  <div style={{ color: '#6b7280', fontSize: 12, marginTop: 3 }}>
                    {tgConnectedForConfig ? 'Buyer details sent to your Telegram for approval before payment is shared.' : 'Screen buyers automatically before sharing payment details'}
                  </div>
                </div>
                <div onClick={() => setDdEnabled(v => !v)}
                  style={{ width: 44, height: 24, borderRadius: 12, background: ddEnabled ? '#f59e0b' : '#374151', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0, marginLeft: 20 }}>
                  <div style={{ position: 'absolute', top: 4, left: ddEnabled ? 22 : 4, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
                </div>
              </div>
              {ddEnabled && tgConnectedForConfig && (
                <div style={{ marginTop: 12, background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: 8, padding: '10px 14px' }}>
                  <div style={{ color: '#10b981', fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Telegram screening active</div>
                  <div style={{ color: '#9ca3af', fontSize: 12, lineHeight: 1.5 }}>Every new sell order pauses — buyer stats are sent to your Telegram before payment details are shared. Reply <span style={{ color: '#10b981' }}>/approve</span> or <span style={{ color: '#ef4444' }}>/reject</span>.</div>
                </div>
              )}
              {ddEnabled && !tgConnectedForConfig && (
                <div style={{ marginTop: 12, background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 8, padding: '12px 14px' }}>
                  <div style={{ color: '#f59e0b', fontSize: 13, fontWeight: 700, marginBottom: 4 }}>⚠ Telegram not connected</div>
                  <p style={{ margin: 0, color: '#9ca3af', fontSize: 12, lineHeight: 1.5 }}>Connect it in <strong style={{ color: '#e5e7eb' }}>Telegram Notifications</strong> just below.</p>
                </div>
              )}
            </div>

            {/* Full automation (strict) — auto-decide every order, no manual approval */}
            <div style={{ background: '#0d1117', border: '0.5px solid #1f2937', borderRadius: 10, padding: '14px 16px', marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 600 }}>Fully automate trades (strict)</div>
                  <div style={{ color: '#6b7280', fontSize: 12, marginTop: 3 }}>The bot decides every order itself — no Telegram approval. Meets your screening → processed automatically; fails any check → auto-rejected with a polite cancel message.</div>
                </div>
                <div onClick={() => setBotFullAuto(v => !v)}
                  style={{ width: 44, height: 24, borderRadius: 12, background: botFullAuto ? '#f59e0b' : '#374151', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0, marginLeft: 20 }}>
                  <div style={{ position: 'absolute', top: 4, left: botFullAuto ? 22 : 4, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
                </div>
              </div>
              {botFullAuto && (
                <div style={{ marginTop: 12, background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: 8, padding: '10px 14px' }}>
                  <div style={{ color: '#10b981', fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Full automation active</div>
                  <div style={{ color: '#9ca3af', fontSize: 12, lineHeight: 1.5 }}>Every order is processed or rejected automatically against your screening criteria — you won't be asked to approve. Orders that fail get the polite cancel-request message; orders that pass are processed straight away.</div>
                </div>
              )}
            </div>

            {/* Telegram Notifications — connect + choose which alerts to receive */}
            <div style={{ background: '#0d1117', border: '0.5px solid #1f2937', borderRadius: 10, padding: '14px 16px', marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 600 }}>Telegram Notifications</div>
                  <div style={{ color: '#6b7280', fontSize: 12, marginTop: 3 }}>
                    {tgConnectedForConfig ? 'Connected to @Sparkp2p_bot — choose which order alerts you receive.' : 'Connect Telegram to receive buy / sell order alerts.'}
                  </div>
                </div>
                {tgConnectedForConfig && <span style={{ color: '#10b981', fontSize: 12, fontWeight: 700, flexShrink: 0, marginLeft: 12 }}>✓ Connected</span>}
              </div>

              {!tgConnectedForConfig && (
                tgCodeCfg ? (
                  <div style={{ marginTop: 12, background: 'rgba(79,70,229,0.08)', border: '1px solid rgba(79,70,229,0.3)', borderRadius: 8, padding: '14px 16px' }}>
                    <div style={{ color: '#a5b4fc', fontWeight: 600, marginBottom: 8, fontSize: 13 }}>Connect: open <strong style={{ color: '#fff' }}>@Sparkp2p_bot</strong> on Telegram, tap Start, then send:</div>
                    <div style={{ margin: '8px 0', padding: '10px 14px', background: '#0f1117', borderRadius: 8, fontFamily: 'monospace', fontSize: 17, fontWeight: 700, color: '#a5b4fc', textAlign: 'center', letterSpacing: 3 }}>/link {tgCodeCfg.code}</div>
                    <div style={{ color: '#6b7280', fontSize: 11, textAlign: 'center' }}>Updates automatically once connected · code expires in {Math.floor((tgCodeCfg.expires_in || 600) / 60)} min</div>
                  </div>
                ) : (
                  <button onClick={genTgCodeCfg} disabled={tgCodeCfgLoading}
                    style={{ marginTop: 12, padding: '9px 18px', borderRadius: 8, border: 'none', background: '#4f46e5', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                    {tgCodeCfgLoading ? 'Generating…' : 'Connect Telegram'}
                  </button>
                )
              )}

              {tgConnectedForConfig && (
                <>
                  <div style={{ marginTop: 14 }}>
                    <div style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Receive notifications for</div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {[['both', 'Buy & Sell'], ['sell', 'Sell orders only'], ['buy', 'Buy orders only']].map(([v, l]) => (
                        <button key={v} onClick={() => setTgNotifyScope(v)}
                          style={{ padding: '6px 14px', borderRadius: 16, border: '1px solid',
                            borderColor: tgNotifyScope === v ? '#f59e0b' : '#374151',
                            background: tgNotifyScope === v ? 'rgba(245,158,11,0.15)' : 'transparent',
                            color: tgNotifyScope === v ? '#f59e0b' : '#9ca3af', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                          {l}
                        </button>
                      ))}
                    </div>
                    <div style={{ color: '#6b7280', fontSize: 11, marginTop: 6 }}>
                      {tgNotifyScope === 'both' ? 'You get an alert for every buy and sell order.'
                        : tgNotifyScope === 'sell' ? 'Only sell-order alerts (buyer screening). Buy-order alerts are muted.'
                        : 'Only buy-order alerts (pay the seller). Sell-order alerts are muted.'} Press “Save changes” to apply.
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                    <button onClick={testTgCfg} style={{ padding: '7px 14px', borderRadius: 7, border: '1px solid #10b981', background: 'transparent', color: '#10b981', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Send Test</button>
                    <button onClick={disconnectTgCfg} style={{ padding: '7px 14px', borderRadius: 7, border: '1px solid #ef4444', background: 'transparent', color: '#ef4444', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Disconnect</button>
                  </div>
                </>
              )}
            </div>


            {/* High-risk regions row */}
            <div style={{ background: '#0d1117', border: '0.5px solid #1f2937', borderRadius: 10, padding: '14px 16px', marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 600 }}>Pause on high-risk regions</span>
                  <span style={{ fontSize: 10, color: '#6b7280', background: '#1f2937', padding: '1px 7px', borderRadius: 4, fontWeight: 600 }}>COMING SOON</span>
                </div>
                <div style={{ color: '#6b7280', fontSize: 12, marginTop: 3 }}>Require manual approval for flagged areas</div>
              </div>
              <div style={{ width: 44, height: 24, borderRadius: 12, background: '#374151', cursor: 'not-allowed', position: 'relative', flexShrink: 0, marginLeft: 20, opacity: 0.4 }}>
                <div style={{ position: 'absolute', top: 4, left: 4, width: 16, height: 16, borderRadius: '50%', background: '#fff' }} />
              </div>
            </div>

            {/* Binance Ad Counterparty Filters */}
            <div style={{ background: '#0d1117', border: `0.5px solid ${cfEnabled ? 'rgba(245,158,11,0.4)' : '#1f2937'}`, borderRadius: 10, padding: '14px 16px', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: cfEnabled ? 14 : 0 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 600 }}>Binance Ad Counterparty Filters</div>
                  <div style={{ color: '#6b7280', fontSize: 12, marginTop: 3 }}>
                    {profile?.cf_last_pushed_at
                      ? `Last pushed to Binance: ${new Date(profile.cf_last_pushed_at).toLocaleString('en-KE', { dateStyle: 'short', timeStyle: 'short' })}`
                      : 'Filters pushed to all your sell ads on save'}
                  </div>
                  {cfSync && (cfSync.available ? !cfSync.synced || cfEnabled : cfSync.reason !== 'no_api_key') && (
                    <div style={{ fontSize: 11, fontWeight: 600, marginTop: 4, color: !cfSync.available ? '#9ca3af' : cfSync.synced ? '#10b981' : '#ef4444' }}>
                      {!cfSync.available
                        ? (cfSync.reason === 'no_api_key' ? '' : "⚠ Can't verify with Binance — keep your bot/relay online")
                        : cfSync.synced
                          ? '✓ In sync with Binance'
                          : `⚠ Out of sync — Binance shows ${(cfSync.binance_values || []).join(', ') || '?'} (expected ${cfSync.expected}). Click Save to fix.`}
                    </div>
                  )}
                </div>
                <div onClick={() => setCfEnabled(v => !v)}
                  style={{ width: 44, height: 24, borderRadius: 12, background: cfEnabled ? '#f59e0b' : '#374151', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0, marginLeft: 20 }}>
                  <div style={{ position: 'absolute', top: 4, left: cfEnabled ? 22 : 4, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
                </div>
              </div>
              {cfEnabled && (<>
                <div style={{ display: 'flex', gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: '#9ca3af', fontSize: 11, fontWeight: 600, marginBottom: 5 }}>Min Total Trades (30D)</div>
                    <input type="number" min="0" value={cfAllTradesMin} onChange={e => setCfAllTradesMin(e.target.value)}
                      style={{ width: '100%', background: '#111827', border: '1px solid #374151', borderRadius: 7, padding: '8px 10px', color: '#e5e7eb', fontSize: 14, boxSizing: 'border-box' }} />
                    <div style={{ color: '#6b7280', fontSize: 10, marginTop: 3 }}>0 = off · bot enforced</div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: '#9ca3af', fontSize: 11, fontWeight: 600, marginBottom: 5 }}>Min Total Trades (All Time)</div>
                    <input type="number" min="0" value={cfAllTradesMinAll} onChange={e => setCfAllTradesMinAll(e.target.value)}
                      style={{ width: '100%', background: '#111827', border: '1px solid #374151', borderRadius: 7, padding: '8px 10px', color: '#e5e7eb', fontSize: 14, boxSizing: 'border-box' }} />
                    <div style={{ color: '#6b7280', fontSize: 10, marginTop: 3 }}>0 = off · Binance enforced 24/7</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: '#9ca3af', fontSize: 11, fontWeight: 600, marginBottom: 5 }}>Max Avg Pay Time (min)</div>
                    <input type="number" min="0" value={cfMaxPayMins} onChange={e => setCfMaxPayMins(e.target.value)}
                      style={{ width: '100%', background: '#111827', border: '1px solid #374151', borderRadius: 7, padding: '8px 10px', color: '#e5e7eb', fontSize: 14, boxSizing: 'border-box' }} />
                    <div style={{ color: '#6b7280', fontSize: 10, marginTop: 3 }}>0 = off · flags slow payers (sell orders)</div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: '#9ca3af', fontSize: 11, fontWeight: 600, marginBottom: 5 }}>Max Avg Release Time (min)</div>
                    <input type="number" min="0" value={cfMaxReleaseMins} onChange={e => setCfMaxReleaseMins(e.target.value)}
                      style={{ width: '100%', background: '#111827', border: '1px solid #374151', borderRadius: 7, padding: '8px 10px', color: '#e5e7eb', fontSize: 14, boxSizing: 'border-box' }} />
                    <div style={{ color: '#6b7280', fontSize: 10, marginTop: 3 }}>0 = off · flags slow releasers</div>
                  </div>
                </div>
              </>)}
            </div>

            {/* Profit Calculation — Binance fee per USDT (net margin = avg sell − avg buy − fee) */}
            <div style={{ background: '#0d1117', border: '0.5px solid #1f2937', borderRadius: 10, padding: '14px 16px', marginBottom: 8 }}>
              <div style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 600 }}>Profit Calculation</div>
              <div style={{ color: '#6b7280', fontSize: 12, marginTop: 3, marginBottom: 12 }}>Binance fee deducted from your gross margin. Net margin = avg sell − avg buy − this fee.</div>
              <div style={{ maxWidth: 260 }}>
                <div style={{ color: '#9ca3af', fontSize: 11, fontWeight: 600, marginBottom: 5 }}>Binance Fee (KES per USDT)</div>
                <input type="number" min="0" step="0.01" value={binanceFeePerUsdt} onChange={e => setBinanceFeePerUsdt(e.target.value)}
                  style={{ width: '100%', background: '#111827', border: '1px solid #374151', borderRadius: 7, padding: '8px 10px', color: '#e5e7eb', fontSize: 14, boxSizing: 'border-box' }} />
                <div style={{ color: '#6b7280', fontSize: 10, marginTop: 3 }}>Cumulative buy + sell (~0.1% per side). Default 0.25.</div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'paybill' && (() => {
          const recentTxns = [...(transactions || []).map(t => ({ ...t, sign: 1 })), ...(withdrawalTxns || []).map(t => ({ ...t, sign: -1 }))]
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
            .slice(0, 5);
          const isLocked = profile?.settlement_cooldown_until && new Date(profile.settlement_cooldown_until) > new Date();
          return (
            <div>
              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
                <div>
                  <h2 style={{ color: '#fff', fontSize: 20, fontWeight: 700, margin: '0 0 4px' }}>My paybill</h2>
                  <p style={{ color: '#6b7280', fontSize: 13, margin: 0 }}>Bank details the bot uses to receive payouts</p>
                </div>
                <button onClick={() => { setSettingsInitialSection('bank'); setActiveTab('settings'); }}
                  style={{ padding: '8px 18px', borderRadius: 8, border: '1px solid #374151', background: 'transparent', color: '#e5e7eb', fontWeight: 600, fontSize: 13, cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap' }}>
                  Edit details
                </button>
              </div>

              <div className="paybill-two-col">
                {/* Left: bank details + transactions */}
                <div>
                  <div className="card" style={{ marginBottom: 14 }}>
                    {/* Bank header */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div style={{ width: 40, height: 40, borderRadius: 8, background: 'linear-gradient(135deg,#0d9488,#065f46)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
                        </div>
                        <div>
                          <div style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 700 }}>Choice Bank · Kenya</div>
                          <div style={{ color: '#6b7280', fontSize: 12, marginTop: 2 }}>{profile?.choice_account_number ? 'Connected · paybill active' : 'Verification pending'}</div>
                        </div>
                      </div>
                      {profile?.choice_account_number
                        ? <span style={{ fontSize: 11, fontWeight: 700, color: '#10b981', background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.3)', padding: '3px 10px', borderRadius: 20 }}>Verified</span>
                        : <span style={{ fontSize: 11, fontWeight: 700, color: '#f59e0b', background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.3)', padding: '3px 10px', borderRadius: 20 }}>Pending</span>}
                    </div>

                    {/* Fields */}
                    {[
                      { label: 'PAYBILL NUMBER',  value: profile?.choice_paybill || '444174',                                                key: 'pb' },
                      { label: 'ACCOUNT NUMBER',  value: profile?.choice_account_number || 'Pending verification',                          key: 'ac' },
                      { label: 'ACCOUNT NAME',    value: profile?.full_name || '—',                                                          key: 'nm' },
                    ].map(({ label, value, key: ck }) => (
                      <div key={ck} style={{ marginBottom: 14 }}>
                        <div style={{ color: '#6b7280', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 6 }}>{label}</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#0a0d14', borderRadius: 8, padding: '10px 14px', border: '0.5px solid #374151' }}>
                          <span style={{ flex: 1, color: '#e5e7eb', fontSize: 14, fontWeight: 600 }}>{value}</span>
                          <button
                            onClick={() => { navigator.clipboard.writeText(String(value)); setCopied(ck); setTimeout(() => setCopied(''), 1800); }}
                            style={{ background: copied === ck ? 'rgba(16,185,129,0.12)' : 'transparent', border: `1px solid ${copied === ck ? 'rgba(16,185,129,0.3)' : '#374151'}`, cursor: 'pointer', color: copied === ck ? '#10b981' : '#6b7280', padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, flexShrink: 0, transition: 'all 0.15s' }}>
                            {copied === ck ? 'Copied!' : 'Copy'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Recent transactions */}
                  <div className="card">
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Activity size={16} style={{ color: '#6b7280' }} />
                        <span style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 700 }}>Recent paybill transactions</span>
                      </div>
                      <button onClick={() => setActiveTab('transactions')}
                        style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: 12, cursor: 'pointer', padding: 0 }}>
                        View all →
                      </button>
                    </div>
                    {recentTxns.length === 0 ? (
                      <p style={{ color: '#6b7280', fontSize: 13, padding: '12px 0', textAlign: 'center' }}>No transactions yet</p>
                    ) : (
                      recentTxns.map((t, i) => {
                        const amt = Math.abs(t.amount || 0);
                        const isPos = (t.amount || 0) > 0;
                        const desc = t.description || (isPos ? 'Incoming' : 'Payout to bank');
                        const shortDesc = desc.length > 28 ? desc.slice(0, 28) + '…' : desc;
                        const date = t.created_at ? new Date(t.created_at) : null;
                        const dateStr = date ? `${date.toLocaleDateString('en-KE')}, ${date.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })}` : '';
                        return (
                          <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: i < recentTxns.length - 1 ? '0.5px solid #1f2937' : 'none' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <div style={{ width: 8, height: 8, borderRadius: '50%', background: isPos ? '#10b981' : '#6b7280', flexShrink: 0 }} />
                              <div>
                                <div style={{ color: '#e5e7eb', fontSize: 13, fontWeight: 500 }}>{shortDesc}</div>
                                <div style={{ color: '#6b7280', fontSize: 11, marginTop: 2 }}>{dateStr}</div>
                              </div>
                            </div>
                            <span style={{ color: isPos ? '#10b981' : '#9ca3af', fontSize: 13, fontWeight: 700, flexShrink: 0 }}>
                              {isPos ? '+' : '−'} KES {amt.toLocaleString()}
                            </span>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                {/* Right: balance + auto-payout + locked notice */}
                <div>
                  <div style={{ marginBottom: 6 }}>
                    <div style={{ color: '#6b7280', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.7px', marginBottom: 6 }}>Current Balance</div>
                    <div style={{ fontSize: 34, fontWeight: 700, color: '#10b981', lineHeight: 1 }}>
                      KES {cbDashBalance !== null && cbDashBalance !== undefined ? (typeof cbDashBalance === 'object' ? (cbDashBalance.balance || 0) : cbDashBalance).toLocaleString() : '—'}
                    </div>
                    <div style={{ color: '#6b7280', fontSize: 12, marginTop: 6, marginBottom: 16 }}>Available for withdrawal</div>
                    <button
                      onClick={async () => {
                        setCbWithdrawMsg(''); setCbWithdrawAmount(''); setCbWithdrawOtp('');
                        setCbWithdrawOtpSent(false);
                        try { const r = await getCbWithdrawalBank(); setCbWithdrawBank(r.data); } catch { setCbWithdrawBank(null); }
                        setShowCbWithdrawModal(true);
                      }}
                      style={{ width: '100%', padding: '12px 0', borderRadius: 8, border: 'none', background: 'linear-gradient(135deg,#10b981,#059669)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer', marginBottom: 16 }}>
                      Withdraw
                    </button>
                  </div>

                  <div className="card" style={{ marginBottom: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                      <span style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 700 }}>Auto-payout</span>
                      <div style={{ width: 44, height: 24, borderRadius: 12, background: profile?.batch_settlement_enabled ? '#f59e0b' : '#374151', position: 'relative', opacity: 0.6, cursor: 'default' }}>
                        <div style={{ position: 'absolute', top: 4, left: profile?.batch_settlement_enabled ? 22 : 4, width: 16, height: 16, borderRadius: '50%', background: '#fff' }} />
                      </div>
                    </div>
                    {[
                      { label: 'Trigger', value: `Balance ≥ KES ${(profile?.batch_threshold || 10000).toLocaleString()}` },
                      { label: 'Next payout', value: profile?.batch_settlement_enabled ? 'When triggered' : 'Disabled' },
                    ].map(({ label, value }) => (
                      <div key={label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0', borderTop: '0.5px solid #1f2937' }}>
                        <span style={{ color: '#6b7280', fontSize: 12 }}>{label}</span>
                        <span style={{ color: '#e5e7eb', fontSize: 12, fontWeight: 500 }}>{value}</span>
                      </div>
                    ))}
                  </div>

                  <div className="card">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: isLocked ? '#ef4444' : '#10b981', flexShrink: 0 }} />
                      <span style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 700 }}>{isLocked ? 'Account is locked' : 'Account security'}</span>
                    </div>
                    <p style={{ color: '#6b7280', fontSize: 12, lineHeight: 1.5, margin: 0 }}>
                      {isLocked
                        ? `Bank detail changes are locked until ${new Date(profile.settlement_cooldown_until).toLocaleDateString('en-KE')}. A 48-hour cooling-off period applies after changes.`
                        : 'Changes to bank details require 2FA + a 24-hour cooling-off period for your protection.'}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

        {activeTab === 'affiliates' && (
          <div>
            {/* No affiliate record yet — Apply form */}
            {!affiliateData?.affiliate && (
              <div className="card" style={{ maxWidth: 520, margin: '0 auto' }}>
                <div className="card-header">
                  <Share2 size={20} style={{ color: '#f59e0b' }} />
                  <h3>Become an Affiliate</h3>
                </div>
                <p style={{ color: '#9ca3af', fontSize: 14, margin: '8px 0 20px' }}>
                  Earn <strong style={{ color: '#f59e0b' }}>10% commission</strong> on all fees we collect from every trader you refer — every single order they make. Payouts every Friday for balances ≥ KES 5,000.
                </p>
                {affiliateApplyMsg ? (
                  <div style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid #10b981', borderRadius: 8, padding: '12px 16px', color: '#10b981', fontSize: 14 }}>
                    {affiliateApplyMsg}
                  </div>
                ) : (
                  <button
                    onClick={async () => {
                      setAffiliateApplying(true);
                      try {
                        await applyForAffiliate();
                        setAffiliateApplyMsg('Application submitted! We will review and respond shortly.');
                        await loadAffiliateData();
                      } catch (e) {
                        setAffiliateApplyMsg(e?.response?.data?.detail || 'Failed to submit application.');
                      }
                      setAffiliateApplying(false);
                    }}
                    disabled={affiliateApplying}
                    style={{ width: '100%', padding: '12px 0', borderRadius: 8, border: 'none', background: 'linear-gradient(135deg, #f59e0b, #d97706)', color: '#000', fontWeight: 700, fontSize: 15, cursor: affiliateApplying ? 'not-allowed' : 'pointer', opacity: affiliateApplying ? 0.7 : 1 }}
                  >
                    {affiliateApplying ? 'Submitting...' : 'Apply as Affiliate'}
                  </button>
                )}
              </div>
            )}

            {/* Pending / Rejected state */}
            {affiliateData?.affiliate && affiliateData.affiliate.status !== 'approved' && (
              <div className="card" style={{ maxWidth: 520, margin: '0 auto', textAlign: 'center' }}>
                <Share2 size={40} style={{ color: affiliateData.affiliate.status === 'rejected' ? '#ef4444' : '#f59e0b', margin: '0 auto 12px' }} />
                {affiliateData.affiliate.status === 'pending' && (
                  <>
                    <h3 style={{ color: '#f59e0b', marginBottom: 8 }}>Application Under Review</h3>
                    <p style={{ color: '#9ca3af', fontSize: 14 }}>We've received your application and will review it shortly. You'll be notified once approved.</p>
                  </>
                )}
                {affiliateData.affiliate.status === 'rejected' && (
                  <>
                    <h3 style={{ color: '#ef4444', marginBottom: 8 }}>Application Rejected</h3>
                    <p style={{ color: '#9ca3af', fontSize: 14 }}>Unfortunately your application was not approved at this time. Contact support for details.</p>
                  </>
                )}
              </div>
            )}

            {/* Approved affiliate dashboard */}
            {affiliateData?.affiliate?.status === 'approved' && (() => {
              const link = affiliateData.affiliate.referral_link || `https://sparkp2p.com/login?ref=${affiliateData.affiliate.referral_code}`;
              const shareMsg = `Join SparkP2P — automate your Binance P2P trading. Sign up with my link: ${link}`;
              return (
                <>
                  {/* Stats grid — no icons */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
                    {[
                      { label: 'REFERRALS',      value: affiliateReferrals?.summary?.total_referrals || 0 },
                      { label: 'PENDING PAYOUT', value: `KES ${(affiliateData.affiliate.pending_balance || 0).toLocaleString()}` },
                      { label: 'TOTAL EARNED',   value: `KES ${(affiliateData.affiliate.total_earned || 0).toLocaleString()}` },
                      { label: 'THIS WEEK',      value: `KES ${(affiliateReferrals?.summary?.this_week_earnings || 0).toLocaleString()}` },
                    ].map(({ label, value }) => (
                      <div key={label} className="card" style={{ padding: '14px 18px' }}>
                        <div style={{ color: '#fff', fontWeight: 700, fontSize: 20, marginBottom: 4 }}>{value}</div>
                        <div style={{ color: '#6b7280', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
                      </div>
                    ))}
                  </div>

                  {/* 2-col layout */}
                  <div className="aff-two-col" style={{ display: "grid", gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr)", gap: 16, alignItems: "start" }}>

                    {/* Left: referral link + referrals list */}
                    <div>
                      <div className="card" style={{ marginBottom: 14 }}>
                        <div style={{ fontWeight: 700, color: '#fff', fontSize: 15, marginBottom: 12 }}>Your referral link</div>
                        {/* Inline URL + Copy button */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                          <div style={{ flex: 1, background: 'rgba(255,255,255,0.04)', border: '0.5px solid #374151', borderRadius: 8, padding: '9px 12px', fontFamily: 'monospace', fontSize: 12, color: '#d1d5db', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {link}
                          </div>
                          <button
                            onClick={() => { navigator.clipboard.writeText(link).then(() => { setAffiliateCopied(true); setTimeout(() => setAffiliateCopied(false), 2000); }); }}
                            style={{ flexShrink: 0, padding: '9px 18px', borderRadius: 8, border: 'none', background: affiliateCopied ? '#10b981' : '#3b82f6', color: '#fff', fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>
                            {affiliateCopied ? 'Copied!' : 'Copy'}
                          </button>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <span style={{ color: '#6b7280', fontSize: 12 }}>Your code: <strong style={{ color: '#f59e0b' }}>{affiliateData.affiliate.referral_code}</strong></span>
                          <span style={{ color: '#6b7280', fontSize: 12 }}>10% of all fees, lifetime</span>
                        </div>
                      </div>

                      <div className="card">
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                          <div style={{ fontWeight: 700, color: '#fff', fontSize: 15 }}>Your referrals</div>
                          <span style={{ fontSize: 12, color: '#6b7280' }}>{(affiliateReferrals?.referrals || []).length} trader{(affiliateReferrals?.referrals || []).length !== 1 ? 's' : ''}</span>
                        </div>
                        {(affiliateReferrals?.referrals || []).length === 0 ? (
                          <div style={{ textAlign: 'center', padding: '28px 0' }}>
                            <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'rgba(255,255,255,0.05)', margin: '0 auto 12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              <Users size={22} color="#6b7280" />
                            </div>
                            <div style={{ color: '#6b7280', fontSize: 14, fontWeight: 600, marginBottom: 4 }}>No referrals yet</div>
                            <div style={{ color: '#4b5563', fontSize: 12 }}>Share your link to start earning</div>
                          </div>
                        ) : (
                          <div style={{ marginTop: 8 }}>
                            {(affiliateReferrals?.referrals || []).map((ref, i) => (
                              <div key={i} style={{ borderBottom: i < affiliateReferrals.referrals.length - 1 ? '1px solid var(--border)' : 'none' }}>
                                <div
                                  style={{ display: 'flex', alignItems: 'center', padding: '12px 4px', cursor: ref.weekly_breakdown?.length > 0 ? 'pointer' : 'default' }}
                                  onClick={() => ref.weekly_breakdown?.length > 0 && setExpandedReferral(expandedReferral === i ? null : i)}
                                >
                                  <div style={{ flex: 1 }}>
                                    <div style={{ fontWeight: 600, color: '#e5e7eb', fontSize: 14 }}>{ref.trader_name}</div>
                                    <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                                      Joined {ref.joined_at ? new Date(ref.joined_at).toLocaleDateString('en-KE') : '—'}
                                    </div>
                                  </div>
                                  <div style={{ textAlign: 'right', marginRight: ref.weekly_breakdown?.length > 0 ? 8 : 0 }}>
                                    <div style={{ fontWeight: 700, color: '#10b981', fontSize: 14 }}>KES {(ref.total_earned || 0).toLocaleString()}</div>
                                    <div style={{ fontSize: 11, color: '#6b7280' }}>earned</div>
                                  </div>
                                  {ref.weekly_breakdown?.length > 0 && (
                                    expandedReferral === i ? <ChevronUp size={16} color="#6b7280" /> : <ChevronDown size={16} color="#6b7280" />
                                  )}
                                </div>
                                {expandedReferral === i && ref.weekly_breakdown?.length > 0 && (
                                  <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: '8px 12px', marginBottom: 8 }}>
                                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                      <thead>
                                        <tr style={{ color: '#6b7280' }}>
                                          <th style={{ textAlign: 'left', padding: '4px 0', fontWeight: 500 }}>Week</th>
                                          <th style={{ textAlign: 'right', padding: '4px 0', fontWeight: 500 }}>Orders</th>
                                          <th style={{ textAlign: 'right', padding: '4px 0', fontWeight: 500 }}>Commission</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {ref.weekly_breakdown.map((w, wi) => (
                                          <tr key={wi} style={{ color: '#d1d5db' }}>
                                            <td style={{ padding: '4px 0' }}>Week of {new Date(w.week_start).toLocaleDateString('en-KE')}</td>
                                            <td style={{ padding: '4px 0', textAlign: 'right' }}>{w.order_count}</td>
                                            <td style={{ padding: '4px 0', textAlign: 'right', color: '#10b981', fontWeight: 600 }}>KES {(w.commission || 0).toLocaleString()}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Right: Share quickly + How it works */}
                    <div>
                      <div className="card" style={{ marginBottom: 14 }}>
                        <div style={{ fontWeight: 700, color: '#fff', fontSize: 15, marginBottom: 14 }}>Share quickly</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <a href={`https://wa.me/?text=${encodeURIComponent(shareMsg)}`} target="_blank" rel="noopener noreferrer"
                            style={{ display: 'block', padding: '10px 16px', borderRadius: 8, background: '#25d366', color: '#fff', fontWeight: 700, fontSize: 14, textDecoration: 'none', textAlign: 'center' }}>
                            WhatsApp
                          </a>
                          <a href={`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Join SparkP2P — automate your Binance P2P trading!')}`} target="_blank" rel="noopener noreferrer"
                            style={{ display: 'block', padding: '10px 16px', borderRadius: 8, border: '1px solid rgba(0,136,204,0.4)', background: 'rgba(0,136,204,0.06)', color: '#0088cc', fontWeight: 700, fontSize: 14, textDecoration: 'none', textAlign: 'center' }}>
                            Telegram
                          </a>
                          <a href={`sms:?body=${encodeURIComponent(shareMsg)}`}
                            style={{ display: 'block', padding: '10px 16px', borderRadius: 8, border: '1px solid #374151', background: 'transparent', color: '#d1d5db', fontWeight: 700, fontSize: 14, textDecoration: 'none', textAlign: 'center' }}>
                            SMS
                          </a>
                        </div>
                      </div>

                      <div className="card">
                        <div style={{ fontWeight: 700, color: '#fff', fontSize: 15, marginBottom: 16 }}>How it works</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                          {[
                            { n: '1', color: '#f59e0b', bg: 'rgba(245,158,11,0.15)', title: 'Share your link',       desc: 'WhatsApp, Telegram, social — anywhere fellow traders are.' },
                            { n: '2', color: '#10b981', bg: 'rgba(16,185,129,0.15)', title: 'They sign up & trade',  desc: 'Your code is locked to their account forever.' },
                            { n: '3', color: '#10b981', bg: 'rgba(16,185,129,0.15)', title: 'You earn 10%',          desc: 'Paid to your M-Pesa every Monday. No cap.' },
                          ].map(({ n, color, bg, title, desc }) => (
                            <div key={n} style={{ display: 'flex', gap: 12 }}>
                              <div style={{ width: 24, height: 24, borderRadius: '50%', background: bg, color, fontSize: 12, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{n}</div>
                              <div>
                                <div style={{ color: '#e5e7eb', fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{title}</div>
                                <div style={{ color: '#6b7280', fontSize: 12, lineHeight: 1.4 }}>{desc}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                  </div>
                </>
              );
            })()}
          </div>
        )}
        {/* ==================== BUY CREDITS TAB ==================== */}
        {activeTab === 'credits' && (() => {
          // Presentation only. The plan NAME and PRICE come from the backend (payInfo.plans,
          // sourced from plans.py PLAN_CONFIG — the same values that set the actual STK amount),
          // so a server-side price change can never leave these cards showing a stale price.
          const PLAN_UI = {
            starter: { cls: '',        ribbon: null,             btn: 'btn-ghost', check: 'check-a',
              blurb: 'For casual traders getting started.', summary: '30 trades & 100 Telegram alerts per day',
              features: ['<b>30 trades</b> per day (buy + sell)', '<b>100</b> Telegram alerts per day', 'Resets daily at 3:00 AM'] },
            pro: { cls: 'popular', ribbon: '★ MOST POPULAR', btn: 'btn-amber', check: 'check-a',
              blurb: 'Best balance of volume and value.', summary: '80 trades & 200 Telegram alerts per day',
              features: ['<b>80 trades</b> per day (buy + sell)', '<b>200</b> Telegram alerts per day', 'Resets daily at 3:00 AM'] },
            pro_max: { cls: 'best',    ribbon: '★ BEST VALUE',   btn: 'btn-green', check: 'check-g',
              blurb: 'For high-volume power traders.', summary: 'Unlimited trades & Telegram alerts',
              features: ['<b>Unlimited</b> trades per day', '<b>Unlimited</b> Telegram alerts', '<b>Priority</b> support'] },
          };
          // Mirrors plans.py; only used for the first paint before payInfo arrives.
          const PLAN_FALLBACK = [
            { key: 'starter', label: 'Bronze', price: 10000 },
            { key: 'pro',     label: 'Silver', price: 11000 },
            { key: 'pro_max', label: 'Gold',   price: 13000 },
          ];
          const SUB_PLANS = (payInfo?.plans?.length ? payInfo.plans : PLAN_FALLBACK)
            .filter(p => PLAN_UI[p.key])
            .map(p => ({ key: p.key, name: p.label, amount: p.price, ...PLAN_UI[p.key] }));
          const currentPlanKey = profile?.subscription_plan || null;
          const currentPlan = SUB_PLANS.find(p => p.key === currentPlanKey) || null;

          // B2C-via-own-paybill clients: locked to the hidden B2C plan + a payout-credit balance.
          const b2cEnabled = !!profile?.b2c_own_paybill_enabled;
          const b2cCredits = Number(profile?.b2c_credits || 0);
          const handleBuyCredits = async () => {
            const amt = parseInt(b2cAmt, 10) || 0;
            if (!creditPhone.trim()) { setB2cMsg({ type: 'error', text: 'Enter your M-Pesa number first.' }); return; }
            if (amt < 5000) { setB2cMsg({ type: 'error', text: 'Minimum credit purchase is KES 5,000.' }); return; }
            setB2cBusy(true); setB2cMsg(null);
            try {
              const r = await api.post('/subscriptions/buy-credits', { phone: creditPhone.trim(), amount: amt });
              setB2cMsg({ type: 'info', text: r.data?.message || 'STK push sent — enter your M-Pesa PIN.' });
              setB2cAmt('');
            } catch (e) {
              setB2cMsg({ type: 'error', text: e.response?.data?.detail || 'Failed to send STK push.' });
            }
            setB2cBusy(false);
          };

          const handleSubscribe = async (planKey) => {
            if (!creditPhone.trim()) { setCreditMsg({ type: 'error', text: 'Enter your M-Pesa number first.' }); return; }
            setCreditPlan(planKey); setCreditBuying(true); setCreditMsg(null);
            try {
              await initiateSubscription(planKey, creditPhone.trim());
              setCreditMsg({ type: 'info', text: 'STK push sent — enter your M-Pesa PIN to confirm.' });
              setCreditPolling(true);
              const interval = setInterval(async () => {
                try {
                  const ps = await getSubscriptionStatus();
                  if (ps.data?.has_subscription && (ps.data?.status === 'active')) {
                    clearInterval(interval); setCreditPolling(false); setCreditPlan(null);
                    setCreditMsg({ type: 'success', text: '✔ Subscription active! Your daily limits are now applied.' });
                    if (typeof loadData === 'function') loadData();
                  }
                } catch {}
              }, 5000);
              setTimeout(() => { clearInterval(interval); setCreditPolling(false); }, 120000);
            } catch (err) {
              setCreditMsg({ type: 'error', text: err?.response?.data?.detail || 'Failed to send STK push. Try again.' });
            }
            setCreditBuying(false);
          };

          const Check = ({ cls }) => (<svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>);

          return (
            <div className="sp-sub">
              <style>{`
                @import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,700;12..96,800&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&family=JetBrains+Mono:wght@500;700&display=swap');
                .sp-sub{--panel:#13171f;--panel-2:#161b24;--line:rgba(255,255,255,0.07);--line-2:rgba(255,255,255,0.12);--txt:#eef1f6;--txt-dim:#9aa3b2;--txt-faint:#646e7e;--amber:#f5a623;--amber-bright:#ffb937;--amber-deep:#c9821a;--green:#34d27b;--green-soft:#1f8f56;--radius:18px;
                  max-width:1080px;margin:0 auto;padding:14px 6px 60px;font-family:'DM Sans',sans-serif;color:var(--txt)}
                .sp-sub .page-head{text-align:center;margin-bottom:34px}
                .sp-sub .eyebrow{font-size:11px;letter-spacing:.22em;color:var(--amber);font-weight:600;text-transform:uppercase}
                .sp-sub .page-head h2{font-family:'Bricolage Grotesque',sans-serif;font-size:32px;font-weight:800;letter-spacing:-.5px;margin-top:6px}
                .sp-sub .page-head p{color:var(--txt-dim);font-size:14.5px;margin-top:8px}
                .sp-sub .top-grid{display:grid;grid-template-columns:1.25fr 1fr;gap:20px;margin-bottom:44px}
                .sp-sub .card{background:linear-gradient(180deg,var(--panel),var(--panel-2));border:1px solid var(--line);border-radius:var(--radius);padding:26px;position:relative;overflow:hidden}
                .sp-sub .plan-now{border:1px solid rgba(245,166,35,0.28);background:radial-gradient(420px 220px at 100% 0%, rgba(245,166,35,0.16), transparent 70%),linear-gradient(180deg,var(--panel),var(--panel-2))}
                .sp-sub .tag{font-size:11px;letter-spacing:.16em;color:var(--txt-faint);font-weight:600}
                .sp-sub .plan-now h3{font-family:'Bricolage Grotesque',sans-serif;font-size:28px;font-weight:800;color:var(--amber-bright);margin:8px 0 4px;letter-spacing:-.4px}
                .sp-sub .plan-now .sub{color:var(--txt-dim);font-size:13px}
                .sp-sub .plan-now .reset{display:inline-flex;gap:7px;align-items:center;margin-top:18px;font-size:12.5px;color:var(--txt-dim);background:rgba(255,255,255,0.03);border:1px solid var(--line);padding:7px 12px;border-radius:10px}
                .sp-sub .plan-now .reset b{color:var(--txt)}
                .sp-sub .mpesa label{display:block;font-size:13px;color:var(--txt-dim);margin:14px 0 9px}
                .sp-sub .field{display:flex;align-items:center;gap:10px;background:#0a0c10;border:1px solid var(--line-2);border-radius:12px;padding:0 14px;transition:.18s}
                .sp-sub .field:focus-within{border-color:var(--amber);box-shadow:0 0 0 3px rgba(245,166,35,0.15)}
                .sp-sub .field .cc{font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--txt-dim);font-weight:700}
                .sp-sub .field input{flex:1;background:transparent;border:0;outline:0;color:var(--txt);font-family:'JetBrains Mono',monospace;font-size:15px;padding:14px 0;letter-spacing:.04em}
                .sp-sub .field input::placeholder{color:var(--txt-faint)}
                .sp-sub .mpesa .hint{font-size:12px;color:var(--txt-faint);margin-top:11px;line-height:1.5}
                .sp-sub .plans-head{text-align:center;margin-bottom:24px}
                .sp-sub .plans-head h3{font-family:'Bricolage Grotesque',sans-serif;font-size:23px;font-weight:700;margin-top:6px;letter-spacing:-.3px}
                .sp-sub .plans-head .eyebrow{color:var(--txt-faint)}
                .sp-sub .plans{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;align-items:stretch}
                .sp-sub .plan{position:relative;display:flex;flex-direction:column;background:linear-gradient(180deg,var(--panel),var(--panel-2));border:1px solid var(--line);border-radius:var(--radius);padding:26px 22px 24px;transition:transform .25s cubic-bezier(.2,.8,.2,1),border-color .25s,box-shadow .25s}
                .sp-sub .plan:hover{transform:translateY(-6px);border-color:var(--line-2);box-shadow:0 24px 50px -28px rgba(0,0,0,0.8)}
                .sp-sub .plan .ribbon{position:absolute;top:-12px;left:50%;transform:translateX(-50%);font-size:10.5px;font-weight:700;letter-spacing:.1em;white-space:nowrap;padding:5px 13px;border-radius:99px}
                .sp-sub .plan.popular{border-color:rgba(245,166,35,0.45);background:radial-gradient(360px 200px at 50% -10%, rgba(245,166,35,0.14), transparent 70%),linear-gradient(180deg,var(--panel),var(--panel-2));box-shadow:0 22px 60px -30px rgba(245,166,35,0.5)}
                .sp-sub .plan.popular .ribbon{background:linear-gradient(135deg,var(--amber-bright),var(--amber-deep));color:#1a1206}
                .sp-sub .plan.best{border-color:rgba(52,210,123,0.4)}
                .sp-sub .plan.best .ribbon{background:linear-gradient(135deg,#3fe089,var(--green-soft));color:#04150c}
                .sp-sub .plan .name{font-family:'Bricolage Grotesque',sans-serif;font-size:19px;font-weight:700;letter-spacing:-.2px}
                .sp-sub .plan .price{display:flex;align-items:baseline;gap:6px;margin:10px 0 4px}
                .sp-sub .plan .price .cur{font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--txt-dim);font-weight:700}
                .sp-sub .plan .price .amt{font-family:'JetBrains Mono',monospace;font-size:32px;font-weight:700;letter-spacing:-1px;color:var(--txt)}
                .sp-sub .plan.popular .price .amt{color:var(--amber-bright)}
                .sp-sub .plan.best .price .amt{color:var(--green)}
                .sp-sub .plan .price .per{font-size:13px;color:var(--txt-faint)}
                .sp-sub .plan .blurb{font-size:12.5px;color:var(--txt-faint);min-height:18px}
                .sp-sub .plan ul{list-style:none;margin:20px 0 22px;padding:0;display:flex;flex-direction:column;gap:13px;flex:1}
                .sp-sub .plan li{display:flex;gap:10px;font-size:13.5px;color:var(--txt-dim);line-height:1.4}
                .sp-sub .plan li svg{width:17px;height:17px;flex:0 0 17px;margin-top:1px}
                .sp-sub .plan li b{color:var(--txt);font-weight:600}
                .sp-sub .check-a{color:var(--amber)} .sp-sub .check-g{color:var(--green)}
                .sp-sub .btn{width:100%;border:0;cursor:pointer;border-radius:12px;padding:13px;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:600;transition:.18s;display:flex;align-items:center;justify-content:center;gap:8px}
                .sp-sub .btn:disabled{cursor:not-allowed;opacity:.55}
                .sp-sub .btn-ghost{background:rgba(255,255,255,0.04);color:var(--txt-dim);border:1px solid var(--line-2)}
                .sp-sub .btn-ghost:hover{background:rgba(255,255,255,0.08);color:var(--txt)}
                .sp-sub .btn-amber{background:linear-gradient(135deg,var(--amber-bright),var(--amber-deep));color:#1a1206}
                .sp-sub .btn-amber:hover{filter:brightness(1.08)}
                .sp-sub .btn-current{background:rgba(52,210,123,0.14);color:var(--green);border:1px solid rgba(52,210,123,0.35);cursor:default}
                .sp-sub .btn-green{background:linear-gradient(135deg,#3fe089,var(--green-soft));color:#04150c}
                .sp-sub .btn-green:hover{filter:brightness(1.06)}
                .sp-sub .sp-msg{margin-top:18px;text-align:center;font-size:13px;padding:11px 16px;border-radius:11px;max-width:520px;margin-left:auto;margin-right:auto}
                .sp-sub .reveal{opacity:0;transform:translateY(14px);animation:spRise .6s cubic-bezier(.2,.8,.2,1) forwards}
                @keyframes spRise{to{opacity:1;transform:none}}
                .sp-sub .d1{animation-delay:.05s}.sp-sub .d2{animation-delay:.13s}.sp-sub .d3{animation-delay:.21s}.sp-sub .d4{animation-delay:.29s}.sp-sub .d5{animation-delay:.37s}.sp-sub .d6{animation-delay:.45s}
                @media(max-width:900px){.sp-sub .top-grid{grid-template-columns:1fr}.sp-sub .plans{grid-template-columns:1fr}}
              `}</style>

              <div className="page-head reveal d1">
                <div className="eyebrow">Billing &amp; Plans</div>
                <h2>Manage your subscription</h2>
                <p>Pay securely via M-PESA. Daily limits reset at 3:00 AM (EAT).</p>
              </div>

              <div className="top-grid">
                <div className="card plan-now reveal d2">
                  <div className="tag">YOUR CURRENT PLAN</div>
                  <h3>{currentPlan ? currentPlan.name : 'No active subscription'}</h3>
                  <div className="sub">{currentPlan ? currentPlan.summary : 'Subscribe to a plan to use the bot.'}</div>
                  <div className="reset">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--amber)" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
                    Daily limits reset at <b>3:00 AM (EAT)</b>
                  </div>
                  {payInfo?.expires_at && (() => {
                    const exp = new Date(payInfo.expires_at);
                    const days = Math.ceil((exp - Date.now()) / 86400000);
                    const dateStr = exp.toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' });
                    return (
                      <div className="reset" style={{ marginTop: 8 }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={days <= 3 ? '#ef4444' : 'var(--amber)'} strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
                        Expires <b>{dateStr}</b>
                        <span style={{ marginLeft: 6, color: days <= 3 ? '#ef4444' : '#10b981', fontWeight: 700 }}>
                          · {days >= 0 ? `${days} day${days === 1 ? '' : 's'} left` : 'expired'}
                        </span>
                      </div>
                    );
                  })()}
                </div>
                <div className="card mpesa reveal d3">
                  <div className="tag">M-PESA NUMBER FOR PAYMENT</div>
                  <label>We'll send an STK push to this number</label>
                  <div className="field">
                    <span className="cc">+254</span>
                    <input type="tel" inputMode="numeric" placeholder="712 345 678" value={creditPhone} onChange={e => setCreditPhone(e.target.value)} disabled={creditBuying || creditPolling} />
                  </div>
                  <div className="hint">Make sure the number is registered to your Safaricom line and has sufficient balance before subscribing.</div>
                  {/* Deposit a custom amount toward your balance via STK push ("pay slowly") */}
                  <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #20262f' }}>
                    <label style={{ display: 'block', color: '#9aa4b2', fontSize: 11.5, marginBottom: 6 }}>Or deposit any amount toward your balance</label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input type="tel" inputMode="numeric" placeholder="Amount (KES)" value={subDepAmount}
                        onChange={e => setSubDepAmount(e.target.value.replace(/[^\d]/g, ''))}
                        style={{ flex: 1, padding: '11px 12px', borderRadius: 10, background: '#0a0d14', border: '1px solid #2a3142', color: '#fff', fontSize: 14, minWidth: 0 }} />
                      <button onClick={handleDepositStk} disabled={subDepSending}
                        style={{ padding: '11px 16px', borderRadius: 10, border: 'none', background: subDepSending ? '#3a3f4d' : '#f59e0b', color: subDepSending ? '#9aa4b2' : '#1a1205', fontWeight: 800, fontSize: 13, cursor: subDepSending ? 'default' : 'pointer', whiteSpace: 'nowrap' }}>
                        {subDepSending ? 'Sending…' : 'STK Push'}
                      </button>
                    </div>
                    {subDepMsg && <div style={{ marginTop: 8, fontSize: 12, color: subDepMsg.type === 'ok' ? '#10b981' : '#ef4444' }}>{subDepMsg.text}</div>}
                  </div>
                </div>
              </div>

              {/* Subscription balance (prepaid — pay slowly). Always shown so it's easy to find. */}
              {payInfo && (() => {
                const hasBal = payInfo.balance > 0;
                return (
                  <div className="card reveal d3" style={{ marginTop: 16, padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: `1px solid ${hasBal ? 'rgba(16,185,129,0.3)' : '#20262f'}`, background: hasBal ? 'rgba(16,185,129,0.06)' : 'transparent' }}>
                    <div>
                      <div style={{ color: '#9aa4b2', fontSize: 12, fontWeight: 600 }}>SUBSCRIPTION BALANCE</div>
                      <div style={{ color: hasBal ? '#10b981' : '#e5e7eb', fontSize: 22, fontWeight: 800 }}>KES {(payInfo.balance || 0).toLocaleString()}</div>
                    </div>
                    <div style={{ color: '#7d8794', fontSize: 11.5, textAlign: 'right', maxWidth: 230 }}>
                      {hasBal
                        ? "Money you've paid so far. Top up to a plan price and it activates automatically — the amounts below already subtract this."
                        : 'Pay any amount to Paybill 4041355 (account below) and it builds up here until it covers a plan — then activates automatically.'}
                    </div>
                  </div>
                );
              })()}

              {/* Manual Paybill + Pay with Choice Bank */}
              {payInfo && (
                <div className="card reveal d3" style={{ marginTop: 16, padding: 18 }}>
                  <div className="tag" style={{ marginBottom: 12 }}>OTHER WAYS TO PAY</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 14 }}>
                    {/* Manual M-Pesa Paybill */}
                    <div style={{ background: '#0e1320', border: '1px solid #20262f', borderRadius: 12, padding: 16 }}>
                      <div style={{ fontWeight: 800, color: '#fff', fontSize: 14, marginBottom: 4 }}>📲 Pay manually via M-PESA</div>
                      <div style={{ color: '#9aa4b2', fontSize: 12, marginBottom: 12 }}>Lipa na M-PESA → Pay Bill. Your subscription activates automatically once paid.</div>
                      {[['Paybill number', payInfo.paybill], ['Account number', payInfo.account_number]].map(([k, v]) => (
                        <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderTop: '1px solid #1a2030' }}>
                          <span style={{ color: '#7d8794', fontSize: 12 }}>{k}</span>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <b style={{ color: '#f59e0b', fontSize: 15, letterSpacing: 0.5 }}>{v}</b>
                            <button onClick={() => { navigator.clipboard?.writeText(String(v)); }} title="Copy"
                              style={{ background: 'none', border: '1px solid #2a3142', borderRadius: 6, color: '#9aa4b2', fontSize: 10, padding: '3px 7px', cursor: 'pointer' }}>Copy</button>
                          </span>
                        </div>
                      ))}
                      <div style={{ color: '#6b7280', fontSize: 11, marginTop: 10 }}>
                        Enter the amount for your plan (KES {(payInfo.plans || []).map(p => p.price.toLocaleString()).join(' / ')}).
                      </div>
                    </div>

                    {/* Pay with Choice Bank */}
                    <div style={{ background: '#0e1320', border: '1px solid #20262f', borderRadius: 12, padding: 16 }}>
                      <div style={{ fontWeight: 800, color: '#fff', fontSize: 14, marginBottom: 4 }}>🏦 Pay with Choice Bank</div>
                      {!payInfo.has_choice_account ? (
                        <div style={{ color: '#9aa4b2', fontSize: 12 }}>Verify your Choice Bank account first to pay directly from your wallet.</div>
                      ) : choicePay?.step === 'done' ? (
                        <div style={{ color: '#10b981', fontSize: 13 }}>✅ Payment sent from your Choice Bank wallet. Your subscription will activate shortly.</div>
                      ) : choicePay?.step === 'otp' ? (
                        <>
                          <div style={{ color: '#9aa4b2', fontSize: 12, marginBottom: 8 }}>{choicePay.info || 'Enter the OTP sent to your phone.'}</div>
                          <input inputMode="numeric" autoComplete="one-time-code" placeholder="OTP code" value={choicePay.otp}
                            onChange={e => setChoicePay(c => ({ ...c, otp: e.target.value.replace(/\D/g, '') }))}
                            style={{ width: '100%', padding: '10px 12px', borderRadius: 9, background: '#0a0d14', border: '1px solid #2a3142', color: '#fff', fontSize: 14 }} />
                          {choicePay.error && <div style={{ color: '#ef4444', fontSize: 12, marginTop: 6 }}>{choicePay.error}</div>}
                          <button disabled={!choicePay.otp || choicePay.busy} onClick={confirmChoicePay}
                            style={{ width: '100%', marginTop: 10, padding: 11, borderRadius: 9, border: 'none', background: (!choicePay.otp || choicePay.busy) ? '#3a3f4d' : '#10b981', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                            {choicePay.busy ? 'Confirming…' : 'Confirm payment'}
                          </button>
                        </>
                      ) : (
                        <>
                          <div style={{ color: '#9aa4b2', fontSize: 12, marginBottom: 10 }}>Deduct the plan fee straight from your Choice Bank wallet.</div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                            {payInfo.plans.map(p => {
                              const due = p.due != null ? p.due : p.price;
                              const discounted = due < p.price;
                              return (
                                <button key={p.key} disabled={choicePay?.busy} onClick={() => startChoicePay(p.key)}
                                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', borderRadius: 9, border: '1px solid #2a3142', background: '#0a0d14', color: '#e5e7eb', cursor: 'pointer', fontSize: 13 }}>
                                  <span>{p.label}</span>
                                  <span style={{ textAlign: 'right' }}>
                                    <b style={{ color: '#10b981' }}>KES {due.toLocaleString()}</b>
                                    {discounted && <span style={{ color: '#6b7280', fontSize: 10.5, marginLeft: 6, textDecoration: 'line-through' }}>{p.price.toLocaleString()}</span>}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                          {choicePay?.error && <div style={{ color: '#ef4444', fontSize: 12, marginTop: 8 }}>{choicePay.error}</div>}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* The old B2C-only credits block was removed — the unified "I&M
                  Automation credits" card on the Overview tab now handles credits
                  for ALL prepaid rails (rate-based, min KES 1,000, no free credits),
                  so keeping this one meant two credit UIs with conflicting math. */}

              {!b2cEnabled && (<>
              <div className="plans-head reveal d3">
                <div className="eyebrow">Subscription Plans</div>
                <h3>Choose the plan that fits your trading volume</h3>
              </div>

              <div className="plans">
                {SUB_PLANS.map((p, idx) => {
                  const isCurrent = currentPlanKey === p.key;
                  const busy = (creditBuying || creditPolling) && creditPlan === p.key;
                  return (
                    <div key={p.key} className={`plan ${p.cls} reveal d${idx + 4}`}>
                      {p.ribbon && <div className="ribbon">{p.ribbon}</div>}
                      <div className="name">{p.name}</div>
                      <div className="price"><span className="cur">KES</span><span className="amt">{p.amount.toLocaleString()}</span><span className="per">/mo</span></div>
                      <div className="blurb">{p.blurb}</div>
                      <ul>
                        {p.features.map((f, i) => (
                          <li key={i}><Check cls={p.check} /><span dangerouslySetInnerHTML={{ __html: f }} /></li>
                        ))}
                      </ul>
                      {isCurrent ? (
                        <button className="btn btn-current">✓ Current plan</button>
                      ) : (
                        <button className={`btn ${p.btn}`} disabled={busy || !creditPhone.trim()} onClick={() => handleSubscribe(p.key)}>
                          {busy ? (creditPolling ? 'Waiting…' : 'Sending…') : `Choose ${p.name} →`}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              </>)}

              {creditMsg && (
                <div className="sp-msg" style={{
                  background: creditMsg.type === 'success' ? 'rgba(52,210,123,0.12)' : creditMsg.type === 'error' ? 'rgba(255,90,90,0.12)' : 'rgba(245,166,35,0.1)',
                  color: creditMsg.type === 'success' ? '#34d27b' : creditMsg.type === 'error' ? '#ff5a5a' : '#f5a623',
                  border: `1px solid ${creditMsg.type === 'success' ? 'rgba(52,210,123,0.3)' : creditMsg.type === 'error' ? 'rgba(255,90,90,0.3)' : 'rgba(245,166,35,0.3)'}`,
                }}>{creditMsg.text}</div>
              )}

            </div>
          );
        })()}


      <SupportChat forceOpen={openSupportChat} onOpen={() => setOpenSupportChat(false)} />

      </main>
      </div> {/* dash-body */}

      {/* Withdraw OTP Modal */}
      {showWithdrawModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#1f2937', borderRadius: 16, padding: 32, width: '100%', maxWidth: 420, boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 style={{ color: '#fff', fontSize: 18, margin: 0 }}>Confirm Withdrawal</h3>
              <button onClick={() => { setShowWithdrawModal(false); setWithdrawStatus(null); clearInterval(withdrawPollRef.current); }} style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 20 }}>×</button>
            </div>

            {/* System degraded banner */}
            {systemStatus && (() => {
              const degradedSystems = Object.values(systemStatus).filter(s => s.degraded);
              if (degradedSystems.length === 0) return null;
              const names = degradedSystems.map(s => s.name).join(' and ');
              return (
                <div style={{
                  display: 'flex', gap: 10, alignItems: 'flex-start',
                  background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.35)',
                  borderRadius: 8, padding: '12px 14px', marginBottom: 16,
                }}>
                  <span style={{ fontSize: 16, flexShrink: 0 }}>⚠️</span>
                  <div>
                    <p style={{ margin: '0 0 4px', fontSize: 13, color: '#ef4444', fontWeight: 700 }}>
                      {names} {degradedSystems.length > 1 ? 'are' : 'is'} currently unavailable
                    </p>
                    <p style={{ margin: 0, fontSize: 12, color: '#f87171', lineHeight: 1.5 }}>
                      Withdrawals are temporarily on hold. Your balance is safe and will be processed as soon as the system recovers. Our team has been notified.
                    </p>
                  </div>
                </div>
              );
            })()}

            {/* Amount input */}
            {withdrawPreview && (() => {
              const method = withdrawPreview.settlement_method || 'mpesa';
              const balance = withdrawPreview.balance ?? 0;
              const minWd = method === 'mpesa'
                ? Math.max(MPESA_MIN_WITHDRAWAL, withdrawPreview.min_withdrawal ?? 0)
                : (withdrawPreview.min_withdrawal ?? 1000);
              const forceFullBalance = withdrawPreview.force_full_withdrawal;
              const customAmt = parseFloat(withdrawCustomAmount) || 0;
              // Choice Bank debits (amount + fee) from the balance and sends the FULL amount to the
              // payee. So the most a trader can RECEIVE is their balance minus the fee on that amount.
              const maxReceive = Math.max(0, balance - getWithdrawalFee(method, balance));
              const clampedAmt = Math.min(customAmt, maxReceive);
              const liveFee = getWithdrawalFee(method, clampedAmt);
              const liveReceive = clampedAmt;                 // recipient gets the full amount
              const totalDebit = clampedAmt + liveFee;        // deducted from the Choice balance
              const remainingAfter = balance - totalDebit;
              const wouldStrand = clampedAmt > 0 && totalDebit < balance && remainingAfter > 0 && remainingAfter < minWd;
              const amtErr = customAmt > maxReceive
                ? `Max KES ${maxReceive.toLocaleString()}`
                : customAmt > 0 && customAmt < minWd
                  ? `Min KES ${minWd.toLocaleString()}`
                  : wouldStrand
                    ? `Withdrawing KES ${clampedAmt.toLocaleString()} would leave KES ${remainingAfter.toLocaleString()} which can't be withdrawn later. Withdraw the full KES ${maxReceive.toLocaleString()} instead.`
                    : '';
              return (
                <>
                  {forceFullBalance && (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 8, padding: '10px 12px', marginBottom: 14 }}>
                      <span style={{ fontSize: 14, flexShrink: 0 }}>ℹ️</span>
                      <p style={{ margin: 0, fontSize: 12, color: '#d97706', lineHeight: 1.5 }}>
                        Your balance is below KES {(minWd * 2).toLocaleString()}. You must withdraw the <strong>full amount</strong> to avoid leaving a balance that cannot be withdrawn later.
                      </p>
                    </div>
                  )}
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: 'block', color: '#9ca3af', fontSize: 12, marginBottom: 6 }}>
                      Withdrawal Amount <span style={{ color: '#6b7280' }}>(Balance: KES {balance.toLocaleString()})</span>
                    </label>
                    <div style={{ position: 'relative' }}>
                      <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#6b7280', fontSize: 13 }}>KES</span>
                      <input
                        type="number"
                        min={0}
                        max={maxReceive}
                        step={1}
                        value={withdrawCustomAmount}
                        onChange={e => { if (!forceFullBalance) setWithdrawCustomAmount(e.target.value); }}
                        readOnly={forceFullBalance}
                        style={{ width: '100%', padding: '11px 14px 11px 44px', borderRadius: 8, border: `1px solid ${amtErr ? '#ef4444' : '#374151'}`, background: forceFullBalance ? '#0f1117' : '#111827', color: '#fff', fontSize: 15, boxSizing: 'border-box', cursor: forceFullBalance ? 'not-allowed' : 'text' }}
                      />
                      {!forceFullBalance && (
                      <button
                        onClick={() => setWithdrawCustomAmount(String(Math.round(maxReceive * 100) / 100))}
                        style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#10b981', fontSize: 11, cursor: 'pointer', fontWeight: 700 }}
                      >MAX</button>
                      )}
                    </div>
                    {amtErr && <p style={{ color: '#ef4444', fontSize: 11, margin: '4px 0 0' }}>{amtErr}</p>}
                  </div>
                  <div style={{ background: '#111827', borderRadius: 10, padding: '14px 16px', marginBottom: 20, fontSize: 13 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, color: '#9ca3af' }}>
                      <span>You Receive</span><span style={{ color: '#10b981', fontWeight: 700 }}>KES {liveReceive.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, color: '#9ca3af' }}>
                      <span>Transaction Fee <span style={{ color: '#6b7280', fontSize: 11 }}>(Choice Bank)</span></span><span style={{ color: '#f59e0b', fontWeight: 600 }}>+ KES {liveFee.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div style={{ borderTop: '1px solid #374151', paddingTop: 8, display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#fff', fontWeight: 700 }}>Deducted from balance</span><span style={{ color: '#fff', fontWeight: 700, fontSize: 15 }}>KES {totalDebit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                  </div>
                </>
              );
            })()}

            <div style={{
              display: 'flex', gap: 8, alignItems: 'flex-start',
              background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)',
              borderRadius: 8, padding: '10px 12px', marginBottom: 16,
            }}>
              <span style={{ fontSize: 15, flexShrink: 0 }}>💡</span>
              <p style={{ margin: 0, fontSize: 12, color: '#d97706', lineHeight: 1.5 }}>
                We recommend <strong>bulk withdrawals</strong> to reduce transaction charges and ensure you remain profitable.
              </p>
            </div>

            {withdrawStatus === 'processing' ? (
              <div style={{ textAlign: 'center', padding: '20px 0' }}>
                <div style={{ fontSize: 40, marginBottom: 16 }}>⏳</div>
                <p style={{ color: '#10b981', fontWeight: 700, fontSize: 16, marginBottom: 8 }}>Processing your withdrawal...</p>
                <p style={{ color: '#9ca3af', fontSize: 13, marginBottom: 24 }}>The bot is completing the bank transfer. This usually takes 1–3 minutes.</p>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981', animation: 'pulse 1.2s infinite' }} />
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981', animation: 'pulse 1.2s infinite 0.4s' }} />
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981', animation: 'pulse 1.2s infinite 0.8s' }} />
                </div>
              </div>
            ) : withdrawStatus === 'succeeded' ? (
              <div style={{ textAlign: 'center', padding: '20px 0' }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
                <p style={{ color: '#10b981', fontWeight: 700, fontSize: 18, marginBottom: 8 }}>Withdrawal Successful!</p>
                <p style={{ color: '#9ca3af', fontSize: 13, marginBottom: 24 }}>The funds have been transferred to your account.</p>
                <button onClick={() => { setShowWithdrawModal(false); setWithdrawStatus(null); }} style={{ padding: '11px 32px', borderRadius: 8, border: 'none', background: 'linear-gradient(135deg,#10b981,#059669)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>Done</button>
              </div>
            ) : !withdrawOtpSent ? (
              <>
                <p style={{ color: '#9ca3af', fontSize: 13, marginBottom: 16 }}>We'll send a one-time code to your registered phone number to authorize this withdrawal.</p>
                <button
                  onClick={async () => {
                    setWithdrawOtpLoading(true);
                    setWithdrawMsg('');
                    try {
                      const res = await requestWithdrawalOtp();
                      setWithdrawOtpSent(true);
                      setWithdrawMsg(res.data.message || 'OTP sent');
                    } catch (e) {
                      setWithdrawMsg(e.response?.data?.detail || 'Failed to send OTP');
                    }
                    setWithdrawOtpLoading(false);
                  }}
                  disabled={withdrawOtpLoading}
                  style={{ width: '100%', padding: '11px 0', borderRadius: 8, border: 'none', background: 'linear-gradient(135deg,#10b981,#059669)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}
                >
                  {withdrawOtpLoading ? 'Sending...' : 'Send OTP to my phone'}
                </button>
              </>
            ) : (
              <>
                <p style={{ color: '#10b981', fontSize: 13, marginBottom: 12 }}>{withdrawMsg}</p>
                <input
                  type="text"
                  maxLength={6}
                  placeholder="Enter 6-digit OTP"
                  value={withdrawOtp}
                  onChange={e => setWithdrawOtp(e.target.value.replace(/\D/g, ''))}
                  style={{ width: '100%', padding: '11px 14px', borderRadius: 8, border: '1px solid #374151', background: '#111827', color: '#fff', fontSize: 20, fontWeight: 700, letterSpacing: 3, textAlign: 'center', marginBottom: 12, boxSizing: 'border-box' }}
                />
                {withdrawMsg && !withdrawMsg.includes('sent') && (
                  <p style={{ color: '#ef4444', fontSize: 12, marginBottom: 8 }}>{withdrawMsg}</p>
                )}
                <button
                  onClick={async () => {
                    if (withdrawOtp.length !== 6) { setWithdrawMsg('Enter the 6-digit code'); return; }
                    const customAmt = parseFloat(withdrawCustomAmount);
                    const walletBal = withdrawPreview?.balance ?? 0;
                    const finalAmt = customAmt > 0 && customAmt < walletBal ? customAmt : undefined;
                    setWithdrawing(true);
                    setWithdrawMsg('');
                    try {
                      const res = await requestWithdrawal(withdrawOtp, finalAmt);
                      const s = res.data?.status;
                      if (s === 'queued') {
                        // Batch withdrawal queued — wallet balance already deducted
                        setShowWithdrawModal(false);
                        alert(res.data.message || 'Withdrawal queued! You will receive an SMS and email once the hourly batch transfer completes.');
                        await loadData();
                      } else if (s === 'processing') {
                        setWithdrawStatus('processing');
                        // Poll wallet every 5s until pending_withdrawal clears
                        withdrawPollRef.current = setInterval(async () => {
                          try {
                            const w = await getWallet();
                            if (!w.data.pending_withdrawal) {
                              clearInterval(withdrawPollRef.current);
                              setWithdrawStatus('succeeded');
                              await loadData();
                            }
                          } catch (_) {}
                        }, 5000);
                      } else {
                        setShowWithdrawModal(false);
                        alert(res.data.message || 'Withdrawal sent!');
                        await loadData();
                      }
                    } catch (e) {
                      setWithdrawMsg(e.response?.data?.detail || 'Withdrawal failed. Please try again.');
                    }
                    setWithdrawing(false);
                  }}
                  disabled={withdrawing || withdrawOtp.length !== 6 || !!withdrawAmtErr}
                  style={{ width: '100%', padding: '11px 0', borderRadius: 8, border: 'none', background: (withdrawOtp.length === 6 && !withdrawAmtErr) ? 'linear-gradient(135deg,#10b981,#059669)' : '#374151', color: '#fff', fontWeight: 700, fontSize: 14, cursor: (withdrawOtp.length === 6 && !withdrawAmtErr) ? 'pointer' : 'not-allowed', marginBottom: 8 }}
                >
                  {withdrawing ? 'Processing...' : 'Confirm Withdrawal'}
                </button>
                <button onClick={() => { setWithdrawOtpSent(false); setWithdrawOtp(''); setWithdrawMsg(''); }} style={{ width: '100%', padding: '8px 0', borderRadius: 8, border: '1px solid #374151', background: 'none', color: '#9ca3af', fontSize: 13, cursor: 'pointer' }}>
                  Resend OTP
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Buy Credits Modal — STK to Paybill 4041355, rate-based estimate */}
      {showBuyCredits && (() => {
        const rate = credits?.credit_rate || 0;
        const amt = Math.max(0, parseInt(buyCreditsAmount, 10) || 0);
        const est = rate > 0 ? Math.round(amt / rate) : 0;
        const min = credits?.min_deposit || 1000;
        return (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}
            onClick={() => !buyCreditsBusy && setShowBuyCredits(false)}>
            <div style={{ background: 'var(--card-bg, #1a1d27)', borderRadius: 16, padding: 28, width: '100%', maxWidth: 420, border: '1px solid var(--border, #2a2d3a)' }}
              onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#fff', marginBottom: 4 }}>Buy I&amp;M credits</div>
              <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 20 }}>
                1 credit = 1 payout · KES {rate} each. Paid to Paybill <b style={{ color: '#e5e7eb' }}>{credits?.paybill}</b> via STK.
              </div>

              <label style={{ fontSize: 12, color: '#9ca3af', fontWeight: 600 }}>Amount (KES)</label>
              <input type="number" min={min} step={100} value={buyCreditsAmount}
                onChange={e => setBuyCreditsAmount(e.target.value)}
                style={{ width: '100%', padding: '11px 12px', marginTop: 6, marginBottom: 6, borderRadius: 10, border: '1px solid #2a2d3a', background: '#0f0f16', color: '#fff', fontSize: 15 }} />
              <div style={{ fontSize: 12, color: est > 0 ? '#8b5cf6' : '#6b7280', marginBottom: 16, fontWeight: 600 }}>
                {amt < min ? `Minimum is KES ${min.toLocaleString()}` : `≈ ${est.toLocaleString()} credits (${est.toLocaleString()} payouts)`}
              </div>

              <label style={{ fontSize: 12, color: '#9ca3af', fontWeight: 600 }}>M-Pesa phone</label>
              <input type="tel" placeholder="2547XXXXXXXX" value={buyCreditsPhone}
                onChange={e => setBuyCreditsPhone(e.target.value)}
                style={{ width: '100%', padding: '11px 12px', marginTop: 6, marginBottom: 16, borderRadius: 10, border: '1px solid #2a2d3a', background: '#0f0f16', color: '#fff', fontSize: 15 }} />

              {buyCreditsMsg && <div style={{ fontSize: 13, color: buyCreditsMsg.startsWith('✔') ? '#10b981' : '#ef4444', marginBottom: 14 }}>{buyCreditsMsg}</div>}

              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => !buyCreditsBusy && setShowBuyCredits(false)}
                  style={{ flex: 1, padding: '11px', borderRadius: 10, border: '1px solid #2a2d3a', background: 'transparent', color: '#9ca3af', fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
                <button disabled={buyCreditsBusy || amt < min || !buyCreditsPhone.trim()}
                  onClick={async () => {
                    setBuyCreditsBusy(true); setBuyCreditsMsg('');
                    try {
                      const r = await buyCredits(amt, buyCreditsPhone.trim());
                      setBuyCreditsMsg('✔ ' + (r.data?.message || `STK sent. You'll get ${est} credits once paid.`));
                      setTimeout(() => { loadCredits(); }, 4000);
                    } catch (e) {
                      setBuyCreditsMsg(e?.response?.data?.detail || 'Could not send STK. Please try again.');
                    } finally { setBuyCreditsBusy(false); }
                  }}
                  style={{ flex: 2, padding: '11px', borderRadius: 10, border: 'none', background: (amt < min || !buyCreditsPhone.trim()) ? '#4b5563' : '#8b5cf6', color: '#fff', fontWeight: 700, cursor: buyCreditsBusy ? 'wait' : 'pointer' }}>
                  {buyCreditsBusy ? 'Sending…' : `Send STK · KES ${amt.toLocaleString()}`}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Deposit Modal */}
      {showDepositModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center',
          justifyContent: 'center', zIndex: 1000, padding: 16,
        }}>
          <div style={{
            background: 'var(--card-bg, #1a1d27)', borderRadius: 16, padding: 32,
            width: '100%', maxWidth: 420, position: 'relative',
            border: '1px solid var(--border, #2a2d3a)',
          }}>
            <button
              onClick={closeDepositModal}
              style={{
                position: 'absolute', top: 12, right: 12, background: 'none',
                border: 'none', color: '#9ca3af', cursor: 'pointer',
              }}
            >
              <X size={20} />
            </button>

            <h2 style={{ color: '#fff', fontSize: 20, marginBottom: 4 }}>Deposit Funds</h2>
            <p style={{ color: '#9ca3af', fontSize: 13, marginBottom: 20 }}>
              Add funds to your SparkP2P wallet for auto-pay buy orders.
            </p>

            {/* Manual Paybill Deposit Info */}
            <div style={{
              background: 'var(--bg, #0f1117)', borderRadius: 10, padding: 16,
              marginBottom: 20, border: '1px solid var(--border, #2a2d3a)',
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#10b981', marginBottom: 10 }}>
                Option 1: Pay via M-Pesa Paybill (Manual)
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px', fontSize: 13 }}>
                <span style={{ color: '#9ca3af' }}>Paybill Number</span>
                <span style={{ color: '#fff', fontWeight: 600 }}>{profile?.choice_paybill || '444174'}</span>
                <span style={{ color: '#9ca3af' }}>Account Number</span>
                <span style={{ color: '#f59e0b', fontWeight: 600 }}>{profile?.choice_account_number || profile?.choice_account_id || 'Pending'}</span>
              </div>
              <p style={{ fontSize: 11, color: '#6b7280', marginTop: 8, marginBottom: 0 }}>
                Send any amount from M-Pesa, bank app, or agent. Your wallet will be credited automatically.
              </p>
            </div>

            <div style={{ fontSize: 13, fontWeight: 600, color: '#10b981', marginBottom: 10 }}>
              Option 2: Instant Deposit via STK Push
            </div>

            {depositStatus !== 'success' && (
              <>
                <label style={{ color: '#9ca3af', fontSize: 13, display: 'block', marginBottom: 6 }}>
                  Amount (KES)
                </label>
                <input
                  type="number"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  placeholder="e.g. 10000"
                  min="100"
                  max="500000"
                  disabled={depositLoading}
                  style={{
                    width: '100%', padding: '12px 14px', borderRadius: 10,
                    border: '1px solid var(--border, #2a2d3a)',
                    background: 'var(--bg, #0f1117)', color: '#fff', fontSize: 16,
                    marginBottom: 16, boxSizing: 'border-box',
                  }}
                />

                <label style={{ color: '#9ca3af', fontSize: 13, display: 'block', marginBottom: 6 }}>
                  M-Pesa Phone Number
                </label>
                <input
                  type="tel"
                  value={depositPhone}
                  onChange={(e) => setDepositPhone(e.target.value)}
                  placeholder="0712345678"
                  disabled={depositLoading}
                  style={{
                    width: '100%', padding: '12px 14px', borderRadius: 10,
                    border: '1px solid var(--border, #2a2d3a)',
                    background: 'var(--bg, #0f1117)', color: '#fff', fontSize: 16,
                    marginBottom: 20, boxSizing: 'border-box',
                  }}
                />

                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  {[1000, 5000, 10000, 50000].map((amt) => (
                    <button
                      key={amt}
                      onClick={() => setDepositAmount(String(amt))}
                      disabled={depositLoading}
                      style={{
                        flex: 1, padding: '8px 0', borderRadius: 8,
                        border: depositAmount === String(amt) ? '2px solid #10b981' : '1px solid var(--border, #2a2d3a)',
                        background: depositAmount === String(amt) ? 'rgba(16,185,129,0.1)' : 'var(--bg, #0f1117)',
                        color: '#fff', fontSize: 12, cursor: 'pointer',
                      }}
                    >
                      {(amt / 1000)}K
                    </button>
                  ))}
                </div>

                <button
                  onClick={handleDeposit}
                  disabled={depositLoading}
                  style={{
                    width: '100%', padding: '14px 0', borderRadius: 10, border: 'none',
                    background: depositLoading
                      ? '#374151'
                      : 'linear-gradient(135deg, #10b981, #059669)',
                    color: '#fff', fontWeight: 600, fontSize: 15, cursor: depositLoading ? 'default' : 'pointer',
                  }}
                >
                  {depositLoading ? 'Waiting for M-Pesa...' : 'Deposit via M-Pesa'}
                </button>
              </>
            )}

            {depositMessage && (
              <div style={{
                marginTop: 16, padding: 14, borderRadius: 10,
                background: depositStatus === 'success'
                  ? 'rgba(16,185,129,0.1)' : depositStatus === 'failed'
                    ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.1)',
                border: `1px solid ${depositStatus === 'success' ? '#10b981' : depositStatus === 'failed' ? '#ef4444' : '#f59e0b'}`,
                color: depositStatus === 'success' ? '#10b981' : depositStatus === 'failed' ? '#ef4444' : '#f59e0b',
                fontSize: 13, textAlign: 'center',
              }}>
                {depositMessage}
              </div>
            )}

            {depositStatus === 'success' && (
              <button
                onClick={closeDepositModal}
                style={{
                  width: '100%', padding: '14px 0', borderRadius: 10, border: 'none',
                  background: 'linear-gradient(135deg, #10b981, #059669)',
                  color: '#fff', fontWeight: 600, fontSize: 15, cursor: 'pointer', marginTop: 16,
                }}
              >
                Done
              </button>
            )}
          </div>
        </div>
      )}

      {/* Send Money Modal */}
      {showSendModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center',
          justifyContent: 'center', zIndex: 1000, padding: 16,
        }}>
          <div style={{
            background: 'var(--card-bg, #1a1d27)', borderRadius: 16, padding: 32,
            width: '100%', maxWidth: 420, position: 'relative',
            border: '1px solid var(--border, #2a2d3a)',
          }}>
            <button
              onClick={closeSendModal}
              style={{
                position: 'absolute', top: 12, right: 12, background: 'none',
                border: 'none', color: '#9ca3af', cursor: 'pointer',
              }}
            >
              <X size={20} />
            </button>

            <h2 style={{ color: '#fff', fontSize: 20, marginBottom: 4 }}>Send to SparkP2P User</h2>
            <p style={{ color: '#9ca3af', fontSize: 13, marginBottom: 8 }}>
              Transfer funds instantly to another SparkP2P trader.
            </p>
            <div style={{
              display: 'inline-block', padding: '4px 12px', borderRadius: 20,
              background: 'rgba(16,185,129,0.1)', border: '1px solid #10b981',
              color: '#10b981', fontSize: 12, fontWeight: 600, marginBottom: 20,
            }}>
              FREE - no transaction fees
            </div>

            {sendStatus !== 'success' && (
              <>
                <label style={{ color: '#9ca3af', fontSize: 13, display: 'block', marginBottom: 6 }}>
                  Recipient Phone or Email
                </label>
                <input
                  type="text"
                  value={sendRecipient}
                  onChange={(e) => setSendRecipient(e.target.value)}
                  placeholder="0712345678 or user@email.com"
                  disabled={sendLoading}
                  style={{
                    width: '100%', padding: '12px 14px', borderRadius: 10,
                    border: '1px solid var(--border, #2a2d3a)',
                    background: 'var(--bg, #0f1117)', color: '#fff', fontSize: 16,
                    marginBottom: 16, boxSizing: 'border-box',
                  }}
                />

                <label style={{ color: '#9ca3af', fontSize: 13, display: 'block', marginBottom: 6 }}>
                  Amount (KES)
                </label>
                <input
                  type="number"
                  value={sendAmount}
                  onChange={(e) => setSendAmount(e.target.value)}
                  placeholder="e.g. 5000"
                  min="10"
                  max="500000"
                  disabled={sendLoading}
                  style={{
                    width: '100%', padding: '12px 14px', borderRadius: 10,
                    border: '1px solid var(--border, #2a2d3a)',
                    background: 'var(--bg, #0f1117)', color: '#fff', fontSize: 16,
                    marginBottom: 16, boxSizing: 'border-box',
                  }}
                />

                <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                  {[500, 1000, 5000, 10000].map((amt) => (
                    <button
                      key={amt}
                      onClick={() => setSendAmount(String(amt))}
                      disabled={sendLoading}
                      style={{
                        flex: 1, padding: '8px 0', borderRadius: 8,
                        border: sendAmount === String(amt) ? '2px solid #3b82f6' : '1px solid var(--border, #2a2d3a)',
                        background: sendAmount === String(amt) ? 'rgba(59,130,246,0.1)' : 'var(--bg, #0f1117)',
                        color: '#fff', fontSize: 12, cursor: 'pointer',
                      }}
                    >
                      {amt >= 1000 ? `${amt / 1000}K` : amt}
                    </button>
                  ))}
                </div>

                {wallet && (
                  <div style={{
                    fontSize: 12, color: '#9ca3af', marginBottom: 16, textAlign: 'center',
                  }}>
                    Available balance: <span style={{ color: '#f59e0b', fontWeight: 600 }}>KES {wallet.balance?.toLocaleString()}</span>
                  </div>
                )}

                <button
                  onClick={handleSend}
                  disabled={sendLoading}
                  style={{
                    width: '100%', padding: '14px 0', borderRadius: 10, border: 'none',
                    background: sendLoading
                      ? '#374151'
                      : 'linear-gradient(135deg, #3b82f6, #2563eb)',
                    color: '#fff', fontWeight: 600, fontSize: 15, cursor: sendLoading ? 'default' : 'pointer',
                  }}
                >
                  {sendLoading ? 'Sending...' : 'Send Money'}
                </button>
              </>
            )}

            {sendMessage && (
              <div style={{
                marginTop: 16, padding: 14, borderRadius: 10,
                background: sendStatus === 'success'
                  ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
                border: `1px solid ${sendStatus === 'success' ? '#10b981' : '#ef4444'}`,
                color: sendStatus === 'success' ? '#10b981' : '#ef4444',
                fontSize: 13, textAlign: 'center',
              }}>
                {sendMessage}
              </div>
            )}

            {sendStatus === 'success' && (
              <button
                onClick={closeSendModal}
                style={{
                  width: '100%', padding: '14px 0', borderRadius: 10, border: 'none',
                  background: 'linear-gradient(135deg, #10b981, #059669)',
                  color: '#fff', fontWeight: 600, fontSize: 15, cursor: 'pointer', marginTop: 16,
                }}
              >
                Done
              </button>
            )}
          </div>
        </div>
      )}


      {/* ── Configure Bot Modal ── */}
      {showConfigModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget) setShowConfigModal(false); }}>
          <div style={{ background: '#13151f', border: '1px solid #1f2937', borderRadius: 14, padding: 28, width: 460, maxWidth: '90vw', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <SlidersHorizontal size={20} color="#f59e0b" />
                <h3 style={{ color: '#fff', fontSize: 16, fontWeight: 700, margin: 0 }}>Configure Bot</h3>
              </div>
              <button onClick={() => setShowConfigModal(false)} style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', padding: 4 }}><X size={18} /></button>
            </div>

            <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 20 }}>
              Choose which order types the bot should automate. Orders outside the selected mode stay visible on Binance — you complete them manually.
            </p>

            {[
              {
                value: 'both',
                label: 'Buy & Sell (default)',
                desc: 'Bot fully automates both sides — pays sellers for incoming buy orders and releases USDT to buyers for sell orders.',
                note: null,
              },
              {
                value: 'buy_only',
                label: 'Buy orders only',
                desc: 'Bot pays sellers and acquires USDT automatically when buyers place orders.',
                note: 'Sell orders will not be automated. If a buyer places a sell order your ad is still live, you must release USDT to them manually on Binance.',
              },
              {
                value: 'sell_only',
                label: 'Sell orders only',
                desc: 'Bot receives M-Pesa payments and releases USDT to buyers automatically.',
                note: 'Buy orders will not be automated. If a seller lists an offer matching your buy ad, you must pay them and complete the order manually on Binance.',
              },
            ].map(opt => (
              <label key={opt.value} onClick={() => setBotTradeMode(opt.value)}
                style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 14px', borderRadius: 10, border: `1px solid ${botTradeMode === opt.value ? '#f59e0b' : '#1f2937'}`, background: botTradeMode === opt.value ? 'rgba(245,158,11,0.06)' : 'transparent', marginBottom: 10, cursor: 'pointer', transition: 'all 0.15s' }}>
                <div style={{ width: 18, height: 18, borderRadius: '50%', border: `2px solid ${botTradeMode === opt.value ? '#f59e0b' : '#374151'}`, background: botTradeMode === opt.value ? '#f59e0b' : 'transparent', flexShrink: 0, marginTop: 2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {botTradeMode === opt.value && <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#000' }} />}
                </div>
                <div>
                  <div style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 600, marginBottom: 3 }}>{opt.label}</div>
                  <div style={{ color: '#9ca3af', fontSize: 12, lineHeight: 1.4 }}>{opt.desc}</div>
                  {opt.note && (
                    <div style={{ marginTop: 6, fontSize: 11, color: '#f59e0b', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.18)', borderRadius: 6, padding: '5px 8px', lineHeight: 1.4 }}>
                      ⚠ {opt.note}
                    </div>
                  )}
                </div>
              </label>
            ))}

            {/* ── Counterparty Screening ── */}
            <div style={{ borderTop: '1px solid #1f2937', marginTop: 8, paddingTop: 20, marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <div>
                  <div style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 700 }}>Counterparty Screening</div>
                  <div style={{ color: '#6b7280', fontSize: 12, marginTop: 2 }}>
                    {tgConnectedForConfig ? 'Buyer details sent to your Telegram for approval before payment is shared' : 'Screen buyers automatically before sharing payment details'}
                  </div>
                </div>
                <div onClick={() => setDdEnabled(v => !v)}
                  style={{ width: 40, height: 22, borderRadius: 11, background: ddEnabled ? '#f59e0b' : '#374151', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
                  <div style={{ position: 'absolute', top: 3, left: ddEnabled ? 20 : 3, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
                </div>
              </div>

              {ddEnabled && (
                <div style={{ marginTop: 12 }}>
                  {tgConnectedForConfig ? (
                    <div style={{ background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: 10, padding: '14px 16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.8a19.79 19.79 0 01-3.07-8.63A2 2 0 012 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 14.92z"/></svg>
                        <span style={{ color: '#10b981', fontSize: 13, fontWeight: 700 }}>Telegram screening active</span>
                      </div>
                      {[
                        'Every new sell order pauses — buyer stats are sent to your Telegram before payment details are shared',
                        'You receive: buyer trade count, 30-day activity, avg pay time, completion rate, and whether they have traded with you before',
                        'Tap YES on Telegram to approve — the bot immediately sends payment details to the buyer',
                        'Tap NO to reject — the bot sends a polite excuse message and waits for the buyer to cancel',
                        'Returning buyers who have previously traded with you bypass the gate automatically',
                        'If you do not respond within 10 minutes, the order is skipped and re-evaluated next cycle',
                      ].map((item, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
                          <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#10b981', flexShrink: 0, marginTop: 6 }} />
                          <span style={{ color: '#d1d5db', fontSize: 12, lineHeight: 1.5 }}>{item}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 10, padding: '16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                        <span style={{ color: '#f59e0b', fontSize: 13, fontWeight: 700 }}>Telegram not connected</span>
                      </div>
                      <p style={{ margin: '0 0 14px', color: '#9ca3af', fontSize: 12, lineHeight: 1.6 }}>
                        You need to connect your Telegram first to use this feature. Once connected, every new sell order will send buyer details to your Telegram for you to approve or reject before payment info is shared.
                      </p>
                      <button
                        onClick={() => { setShowConfigModal(false); setSettingsInitialSection('notifications'); setActiveTab('settings'); }}
                        style={{ width: '100%', padding: '9px 0', borderRadius: 8, border: '1px solid rgba(245,158,11,0.5)', background: 'rgba(245,158,11,0.12)', color: '#f59e0b', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}
                      >
                        Connect Telegram → Settings / Notifications
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Telegram Notifications (mobile) — connect + alert scope */}
            <div style={{ borderTop: '1px solid #1f2937', marginTop: 8, paddingTop: 16, marginBottom: 8 }}>
              <div style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 700 }}>Telegram Notifications</div>
              <div style={{ color: '#6b7280', fontSize: 12, marginTop: 2, marginBottom: 12 }}>
                {tgConnectedForConfig ? 'Connected — choose which order alerts you receive.' : 'Connect Telegram to receive buy / sell order alerts.'}
              </div>
              {!tgConnectedForConfig ? (
                tgCodeCfg ? (
                  <div style={{ background: 'rgba(79,70,229,0.08)', border: '1px solid rgba(79,70,229,0.3)', borderRadius: 10, padding: '14px 16px' }}>
                    <div style={{ color: '#a5b4fc', fontWeight: 600, marginBottom: 8, fontSize: 12 }}>Open @Sparkp2p_bot, tap Start, then send:</div>
                    <div style={{ margin: '8px 0', padding: '10px', background: '#0f1117', borderRadius: 8, fontFamily: 'monospace', fontSize: 16, fontWeight: 700, color: '#a5b4fc', textAlign: 'center', letterSpacing: 2 }}>/link {tgCodeCfg.code}</div>
                    <div style={{ color: '#6b7280', fontSize: 11, textAlign: 'center' }}>Updates automatically once connected.</div>
                  </div>
                ) : (
                  <button onClick={genTgCodeCfg} disabled={tgCodeCfgLoading}
                    style={{ width: '100%', padding: '10px 0', borderRadius: 8, border: 'none', background: '#4f46e5', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                    {tgCodeCfgLoading ? 'Generating…' : 'Connect Telegram'}
                  </button>
                )
              ) : (
                <>
                  <div style={{ color: '#9ca3af', fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Receive notifications for</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                    {[['both', 'Buy & Sell'], ['sell', 'Sell only'], ['buy', 'Buy only']].map(([v, l]) => (
                      <button key={v} onClick={() => setTgNotifyScope(v)}
                        style={{ padding: '7px 14px', borderRadius: 16, border: '1px solid',
                          borderColor: tgNotifyScope === v ? '#f59e0b' : '#374151',
                          background: tgNotifyScope === v ? 'rgba(245,158,11,0.15)' : 'transparent',
                          color: tgNotifyScope === v ? '#f59e0b' : '#9ca3af', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                        {l}
                      </button>
                    ))}
                  </div>
                  <div style={{ color: '#6b7280', fontSize: 11, marginBottom: 10 }}>Press “Save changes” to apply.</div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button onClick={testTgCfg} style={{ flex: 1, padding: '8px 0', borderRadius: 7, border: '1px solid #10b981', background: 'transparent', color: '#10b981', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Send Test</button>
                    <button onClick={disconnectTgCfg} style={{ flex: 1, padding: '8px 0', borderRadius: 7, border: '1px solid #ef4444', background: 'transparent', color: '#ef4444', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Disconnect</button>
                  </div>
                </>
              )}
            </div>

            {/* Binance Ad Counterparty Filters (modal) */}
            <div style={{ background: '#111827', border: `1px solid ${cfEnabled ? 'rgba(245,158,11,0.4)' : '#374151'}`, borderRadius: 10, padding: '14px 16px', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: cfEnabled ? 14 : 0 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 600 }}>Binance Ad Counterparty Filters</div>
                  <div style={{ color: '#6b7280', fontSize: 12, marginTop: 2 }}>
                    {profile?.cf_last_pushed_at
                      ? `Last pushed to Binance: ${new Date(profile.cf_last_pushed_at).toLocaleString('en-KE', { dateStyle: 'short', timeStyle: 'short' })}`
                      : 'Filters pushed to all your sell ads on save'}
                  </div>
                </div>
                <div onClick={() => setCfEnabled(v => !v)}
                  style={{ width: 40, height: 22, borderRadius: 11, background: cfEnabled ? '#f59e0b' : '#374151', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
                  <div style={{ position: 'absolute', top: 3, left: cfEnabled ? 20 : 3, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
                </div>
              </div>
              {cfEnabled && (<>
                <div style={{ display: 'flex', gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: '#9ca3af', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>Min Total Trades (30D)</div>
                    <input type="number" min="0" value={cfAllTradesMin} onChange={e => setCfAllTradesMin(e.target.value)}
                      style={{ width: '100%', background: '#0d1117', border: '1px solid #374151', borderRadius: 7, padding: '8px 10px', color: '#e5e7eb', fontSize: 14, boxSizing: 'border-box' }} />
                    <div style={{ color: '#6b7280', fontSize: 10, marginTop: 3 }}>0 = off · bot enforced</div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: '#9ca3af', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>Min Total Trades (All Time)</div>
                    <input type="number" min="0" value={cfAllTradesMinAll} onChange={e => setCfAllTradesMinAll(e.target.value)}
                      style={{ width: '100%', background: '#0d1117', border: '1px solid #374151', borderRadius: 7, padding: '8px 10px', color: '#e5e7eb', fontSize: 14, boxSizing: 'border-box' }} />
                    <div style={{ color: '#6b7280', fontSize: 10, marginTop: 3 }}>0 = off · Binance enforced 24/7</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: '#9ca3af', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>Max Avg Pay Time (min)</div>
                    <input type="number" min="0" value={cfMaxPayMins} onChange={e => setCfMaxPayMins(e.target.value)}
                      style={{ width: '100%', background: '#0d1117', border: '1px solid #374151', borderRadius: 7, padding: '8px 10px', color: '#e5e7eb', fontSize: 14, boxSizing: 'border-box' }} />
                    <div style={{ color: '#6b7280', fontSize: 10, marginTop: 3 }}>0 = off · flags slow payers</div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: '#9ca3af', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>Max Avg Release Time (min)</div>
                    <input type="number" min="0" value={cfMaxReleaseMins} onChange={e => setCfMaxReleaseMins(e.target.value)}
                      style={{ width: '100%', background: '#0d1117', border: '1px solid #374151', borderRadius: 7, padding: '8px 10px', color: '#e5e7eb', fontSize: 14, boxSizing: 'border-box' }} />
                    <div style={{ color: '#6b7280', fontSize: 10, marginTop: 3 }}>0 = off · flags slow releasers</div>
                  </div>
                </div>
              </>)}
            </div>

            {/* Profit Calculation — Binance fee per USDT (net margin = avg sell − avg buy − fee) */}
            <div style={{ background: '#111827', border: '1px solid #374151', borderRadius: 10, padding: '14px 16px', marginBottom: 8 }}>
              <div style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 600 }}>Profit Calculation</div>
              <div style={{ color: '#6b7280', fontSize: 12, marginTop: 2, marginBottom: 12 }}>Binance fee deducted from your gross margin. Net margin = avg sell − avg buy − this fee.</div>
              <div style={{ maxWidth: 260 }}>
                <div style={{ color: '#9ca3af', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>Binance Fee (KES per USDT)</div>
                <input type="number" min="0" step="0.01" value={binanceFeePerUsdt} onChange={e => setBinanceFeePerUsdt(e.target.value)}
                  style={{ width: '100%', background: '#0d1117', border: '1px solid #374151', borderRadius: 7, padding: '8px 10px', color: '#e5e7eb', fontSize: 14, boxSizing: 'border-box' }} />
                <div style={{ color: '#6b7280', fontSize: 10, marginTop: 3 }}>Cumulative buy + sell (~0.1% per side). Default 0.25.</div>
              </div>
            </div>

            {configSaved && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px 0', borderRadius: 8, background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.3)', marginBottom: 8 }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                <span style={{ color: '#10b981', fontWeight: 600, fontSize: 14 }}>Bot configured successfully</span>
              </div>
            )}
            <button
              onClick={async () => {
                setSavingConfig(true);
                try {
                  const res = await api.put('/traders/trading-config', { bot_trade_mode: botTradeMode, dd_enabled: ddEnabled, bot_full_auto: botFullAuto, dd_min_30d_trades: ddMin30d, dd_min_all_trades: ddMinAll, cf_filters_enabled: cfEnabled, cf_all_trades_min: parseInt(cfAllTradesMin) || 0, cf_all_trades_min_all: parseInt(cfAllTradesMinAll) || 0, cf_max_pay_mins: parseInt(cfMaxPayMins) || 0, cf_max_release_mins: parseInt(cfMaxReleaseMins) || 0, telegram_notify_scope: tgNotifyScope, binance_fee_per_usdt: parseFloat(binanceFeePerUsdt) || 0.25 });
                  configSavedAt.current = Date.now();
                  setConfigSaved(true);
                  setTimeout(() => { setConfigSaved(false); if (showConfigModal) setShowConfigModal(false); }, 1500);
                  checkCfSync(); // refresh live Binance sync badge
                  if (res?.data?.warning) alert(res.data.warning);
                } catch (e) {}
                setSavingConfig(false);
              }}
              disabled={savingConfig || configSaved}
              style={{ width: '100%', marginTop: 8, padding: '11px 0', borderRadius: 8, border: 'none', background: 'linear-gradient(135deg,#f59e0b,#d97706)', color: '#000', fontWeight: 700, fontSize: 14, cursor: savingConfig || configSaved ? 'default' : 'pointer', opacity: savingConfig || configSaved ? 0.6 : 1 }}
            >
              {savingConfig ? 'Saving...' : 'Save Configuration'}
            </button>
          </div>
        </div>
      )}

      {/* Merchant Tier Modal — shown once for traders who haven't set their Binance tier */}
      {showTierModal && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div style={{ background: '#1a1d27', borderRadius: 16, padding: 32, maxWidth: 480, width: '100%', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 24px 64px rgba(0,0,0,0.6)' }}>
            <div style={{ textAlign: 'center', marginBottom: 8 }}>
              <div style={{ fontSize: 36, marginBottom: 8 }}>🏅</div>
              <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>What is your Binance Merchant Tier?</h2>
              <p style={{ margin: '8px 0 0', fontSize: 13, color: '#9ca3af' }}>
                Your tier determines the fee Binance deducts per trade. We use this to calculate your accurate net profit.
              </p>
            </div>

            <div style={{ display: 'flex', gap: 12, margin: '24px 0', flexWrap: 'wrap' }}>
              {[
                { value: 'gold',   label: 'Gold',   fee: '0.25', color: '#f59e0b', badge: '🥇', desc: 'Highest tier' },
                { value: 'silver', label: 'Silver', fee: '0.35', color: '#9ca3af', badge: '🥈', desc: 'Mid tier' },
                { value: 'bronze', label: 'Bronze', fee: '0.40', color: '#b45309', badge: '🥉', desc: 'Standard tier' },
              ].map(({ value, label, fee, color, badge, desc }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setTierModalSelection(value)}
                  style={{
                    flex: 1, minWidth: 110, padding: '18px 10px', borderRadius: 12, cursor: 'pointer',
                    border: `2px solid ${tierModalSelection === value ? color : '#374151'}`,
                    background: tierModalSelection === value ? `${color}22` : '#111827',
                    color: '#f9fafb', textAlign: 'center', transition: 'all 0.15s',
                    boxShadow: tierModalSelection === value ? `0 0 0 3px ${color}44` : 'none',
                  }}
                >
                  <div style={{ fontSize: 28, marginBottom: 6 }}>{badge}</div>
                  <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 2 }}>{label}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 6 }}>{desc}</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color, background: `${color}18`, borderRadius: 6, padding: '4px 0' }}>
                    KES {fee} / trade
                  </div>
                </button>
              ))}
            </div>

            {tierModalSelection && (
              <div style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: 10, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#6ee7b7' }}>
                At <strong>{tierModalSelection}</strong> tier — every completed P2P trade costs you <strong>KES {tierModalSelection === 'gold' ? '0.25' : tierModalSelection === 'silver' ? '0.35' : '0.40'}</strong> in Binance fees. This will be deducted from your net profit calculation.
              </div>
            )}

            <button
              disabled={!tierModalSelection || tierModalSaving}
              onClick={async () => {
                if (!tierModalSelection) return;
                setTierModalSaving(true);
                try {
                  await updateProfile({ binance_merchant_tier: tierModalSelection });
                  setProfile(p => ({ ...p, binance_merchant_tier: tierModalSelection }));
                  setShowTierModal(false);
                } catch {}
                setTierModalSaving(false);
              }}
              style={{
                width: '100%', padding: '13px 0', borderRadius: 10, border: 'none',
                background: tierModalSelection ? 'linear-gradient(135deg,#10b981,#059669)' : '#374151',
                color: '#fff', fontWeight: 700, fontSize: 15, cursor: tierModalSelection ? 'pointer' : 'not-allowed',
                opacity: tierModalSaving ? 0.7 : 1, transition: 'all 0.15s',
              }}
            >
              {tierModalSaving ? 'Saving…' : tierModalSelection ? `Confirm — I'm a ${tierModalSelection.charAt(0).toUpperCase() + tierModalSelection.slice(1)} Merchant` : 'Select your tier above'}
            </button>
            <p style={{ textAlign: 'center', fontSize: 12, color: '#6b7280', marginTop: 12 }}>
              You can change this anytime in Settings → Trading
            </p>
          </div>
        </div>
      )}

      {/* Choice Bank → Bank Withdrawal Modal */}
      {showCbWithdrawModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}>
          <div style={{ background: '#1f2937', borderRadius: 16, padding: 28, width: '100%', maxWidth: 420, boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 style={{ color: '#fff', fontSize: 18, margin: 0 }}>↗️ Withdraw from Choice Bank</h3>
              <button onClick={() => setShowCbWithdrawModal(false)} style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 22 }}>×</button>
            </div>

            {/* Channel selector — choose where to withdraw first */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              {['mpesa', 'bank'].map(ch => (
                <button key={ch} onClick={() => { setCbWithdrawChannel(ch); setCbWithdrawOtpSent(false); setCbWithdrawOtp(''); setCbWithdrawMsg(''); }}
                  style={{ flex: 1, padding: '8px 0', borderRadius: 8, border: `1px solid ${cbWithdrawChannel === ch ? '#10b981' : '#374151'}`, background: cbWithdrawChannel === ch ? 'rgba(16,185,129,0.15)' : 'none', color: cbWithdrawChannel === ch ? '#10b981' : '#9ca3af', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                  {ch === 'mpesa' ? '📱 M-Pesa' : '🏦 Bank (Pesalink)'}
                </button>
              ))}
            </div>

            {/* Bank channel needs a configured bank; M-Pesa needs the onboarding number */}
            {cbWithdrawChannel === 'bank' && !cbWithdrawBank?.bank_code ? (
              <div style={{ textAlign: 'center', padding: '24px 0' }}>
                <div style={{ fontSize: 36, marginBottom: 12 }}>🏦</div>
                <p style={{ color: '#f59e0b', fontWeight: 700, marginBottom: 8 }}>No withdrawal bank set up</p>
                <p style={{ color: '#9ca3af', fontSize: 13, marginBottom: 20 }}>Go to Settings → Bank Account to add your bank account, or switch to M-Pesa above.</p>
                <button onClick={() => { setShowCbWithdrawModal(false); setSettingsInitialSection("bank"); setActiveTab("settings"); }} style={{ padding: "10px 24px", borderRadius: 8, border: "none", background: "#f59e0b", color: "#000", fontWeight: 700, cursor: "pointer" }}>
                  Go to Settings
                </button>
              </div>
            ) : cbWithdrawChannel === 'mpesa' && !profile?.settlement_mpesa_phone ? (
              <div style={{ textAlign: 'center', padding: '24px 0' }}>
                <div style={{ fontSize: 36, marginBottom: 12 }}>📱</div>
                <p style={{ color: '#f59e0b', fontWeight: 700, marginBottom: 8 }}>No M-Pesa number set up</p>
                <p style={{ color: '#9ca3af', fontSize: 13, marginBottom: 20 }}>Add your M-Pesa settlement number in Settings → Settlement to withdraw to M-Pesa.</p>
              </div>
            ) : (
              <>
                {/* Destination (depends on selected channel) */}
                <div style={{ background: '#111827', borderRadius: 10, padding: '14px 16px', marginBottom: 16 }}>
                  <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>Withdrawal Destination</div>
                  {cbWithdrawChannel === 'mpesa' ? (
                    <>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 2 }}>M-Pesa</div>
                      <div style={{ fontSize: 13, color: '#9ca3af' }}>{profile?.settlement_mpesa_phone}</div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 2 }}>{cbWithdrawBank.bank_name}</div>
                      <div style={{ fontSize: 13, color: '#9ca3af' }}>{cbWithdrawBank.account} · {cbWithdrawBank.account_name}</div>
                    </>
                  )}
                </div>

                {/* Amount */}
                <div style={{ marginBottom: 16 }}>
                  <label style={{ display: 'block', color: '#9ca3af', fontSize: 12, marginBottom: 6 }}>
                    Amount (KES) · Balance: <span style={{ color: '#10b981', fontWeight: 700 }}>KES {Number(cbDashBalance?.balance || 0).toLocaleString()}</span>
                  </label>
                  <div style={{ position: 'relative' }}>
                    <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#6b7280', fontSize: 13 }}>KES</span>
                    <input type="number" min={100} step={1}
                      value={cbWithdrawAmount}
                      onChange={e => setCbWithdrawAmount(e.target.value)}
                      style={{ width: '100%', padding: '11px 14px 11px 44px', borderRadius: 8, border: '1px solid #374151', background: '#111827', color: '#fff', fontSize: 15, boxSizing: 'border-box' }}
                    />
                    <button onClick={() => setCbWithdrawAmount(String(Math.round((cbDashBalance?.balance || 0) * 100) / 100))}
                      style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#10b981', fontSize: 11, cursor: 'pointer', fontWeight: 700 }}>
                      MAX
                    </button>
                  </div>
                  {cbWithdrawChannel === 'mpesa' && (
                    <div style={{ fontSize: 11, color: '#6b7280', marginTop: 6 }}>M-Pesa limit: KES 250,000 per withdrawal — withdraw to your bank for larger amounts.</div>
                  )}
                </div>

                {/* Fee breakdown */}
                {parseFloat(cbWithdrawAmount) > 0 && (() => {
                  const amt = parseFloat(cbWithdrawAmount) || 0;
                  const fee = getWithdrawalFee(cbWithdrawChannel === 'mpesa' ? 'mpesa' : 'bank', amt);
                  return (
                    <div style={{ background: '#111827', borderRadius: 10, padding: '14px 16px', marginBottom: 16, fontSize: 13 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, color: '#9ca3af' }}>
                        <span>You Receive</span><span style={{ color: '#10b981', fontWeight: 700 }}>KES {amt.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, color: '#9ca3af' }}>
                        <span>Transaction Fee <span style={{ color: '#6b7280', fontSize: 11 }}>(Choice Bank)</span></span><span style={{ color: '#f59e0b', fontWeight: 600 }}>+ KES {fee.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                      </div>
                      <div style={{ borderTop: '1px solid #374151', paddingTop: 8, display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#fff', fontWeight: 700 }}>Deducted from balance</span>
                        <span style={{ color: '#fff', fontWeight: 700, fontSize: 15 }}>KES {(amt + fee).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                      </div>
                    </div>
                  );
                })()}

                {cbWithdrawMsg && (
                  <p style={{ color: cbWithdrawMsg.includes('sent') || cbWithdrawMsg.includes('success') ? '#10b981' : '#ef4444', fontSize: 12, marginBottom: 10 }}>{cbWithdrawMsg}</p>
                )}

                {!cbWithdrawOtpSent ? (
                  <>
                    <p style={{ color: '#9ca3af', fontSize: 12, marginBottom: 14 }}>
                      {cbWithdrawChannel === 'mpesa'
                        ? `Funds will be sent to your M-Pesa settlement number${profile?.settlement_mpesa_phone ? ' (' + profile.settlement_mpesa_phone + ')' : ''}.`
                        : 'Funds will be sent to your configured bank account via Pesalink.'}
                    </p>
                    <button
                      disabled={cbWithdrawOtpLoading || !parseFloat(cbWithdrawAmount)}
                      onClick={async () => {
                        const minAmt = cbWithdrawChannel === 'mpesa' ? 1501 : 100; if (!parseFloat(cbWithdrawAmount) || parseFloat(cbWithdrawAmount) < minAmt) { setCbWithdrawMsg(`Minimum ${cbWithdrawChannel === 'mpesa' ? 'M-Pesa ' : ''}withdrawal is KES ${minAmt.toLocaleString()}`); return; }
                        if (cbWithdrawChannel === 'mpesa' && parseFloat(cbWithdrawAmount) > 250000) { setCbWithdrawMsg('M-Pesa withdrawals are limited to KES 250,000 per transaction. Withdraw to your bank for larger amounts.'); return; }
                        setCbWithdrawOtpLoading(true); setCbWithdrawMsg('');
                        try {
                          const initFn = cbWithdrawChannel === 'mpesa' ? cbWithdrawToMpesaInitiate : cbWithdrawInitiate;
                          const r = await initFn(parseFloat(cbWithdrawAmount));
                          setCbWithdrawOtpSent(true);
                          setCbWithdrawMsg(r.data?.message || 'OTP sent to your phone. Enter it to confirm.');
                        } catch(e) { setCbWithdrawMsg(e.response?.data?.detail || 'Failed to send OTP'); }
                        setCbWithdrawOtpLoading(false);
                      }}
                      style={{ width: '100%', padding: '11px 0', borderRadius: 8, border: 'none', background: parseFloat(cbWithdrawAmount) > 0 ? 'linear-gradient(135deg,#ef4444,#dc2626)' : '#374151', color: '#fff', fontWeight: 700, fontSize: 14, cursor: parseFloat(cbWithdrawAmount) > 0 ? 'pointer' : 'not-allowed' }}
                    >
                      {cbWithdrawOtpLoading ? 'Sending OTP...' : 'Send OTP to authorize'}
                    </button>
                  </>
                ) : (
                  <>
                    <input type="text" maxLength={8} placeholder="Enter OTP from Choice Bank"
                      value={cbWithdrawOtp}
                      onChange={e => setCbWithdrawOtp(e.target.value.replace(/\D/g, ''))}
                      style={{ width: '100%', padding: '11px 14px', borderRadius: 8, border: '1px solid #374151', background: '#111827', color: '#fff', fontSize: 20, fontWeight: 700, letterSpacing: 3, textAlign: 'center', marginBottom: 12, boxSizing: 'border-box' }}
                    />
                    <button
                      disabled={cbWithdrawLoading || cbWithdrawOtp.length < 4}
                      onClick={async () => {
                        if (cbWithdrawOtp.length < 4) return;
                        setCbWithdrawLoading(true); setCbWithdrawMsg('');
                        try {
                          const r = await cbWithdrawToBank(cbWithdrawOtp, parseFloat(cbWithdrawAmount));
                          setCbWithdrawMsg(r.data?.message || 'Withdrawal initiated!');
                          setTimeout(() => setShowCbWithdrawModal(false), 2500);
                        } catch(e) { setCbWithdrawMsg(e.response?.data?.detail || 'Withdrawal failed. Please try again.'); }
                        setCbWithdrawLoading(false);
                      }}
                      style={{ width: '100%', padding: '11px 0', borderRadius: 8, border: 'none', background: cbWithdrawOtp.length >= 4 ? 'linear-gradient(135deg,#ef4444,#dc2626)' : '#374151', color: '#fff', fontWeight: 700, fontSize: 14, cursor: cbWithdrawOtp.length >= 4 ? 'pointer' : 'not-allowed', marginBottom: 8 }}
                    >
                      {cbWithdrawLoading ? 'Processing...' : 'Confirm Withdrawal'}
                    </button>
                    <button onClick={() => { setCbWithdrawOtpSent(false); setCbWithdrawOtp(''); setCbWithdrawMsg(''); }}
                      style={{ width: '100%', padding: '8px 0', borderRadius: 8, border: '1px solid #374151', background: 'none', color: '#9ca3af', fontSize: 13, cursor: 'pointer' }}>
                      Resend OTP
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Choice Bank STK Push Deposit Modal */}
      {showCbDepositModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--surface)', borderRadius: 16, padding: 28, width: 360, border: '1px solid var(--border)', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 style={{ margin: 0, color: '#fff', fontSize: 18 }}>🏦 Deposit to Choice Bank</h3>
              <button
                onClick={() => {
                  cbDepositTimers.current.forEach((id) => { clearInterval(id); clearTimeout(id); });
                  cbDepositTimers.current = [];
                  setShowCbDepositModal(false); setCbDepositState(''); setCbDepositMsg('');
                }}
                style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 20 }}
              >✕</button>
            </div>
            <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 16, lineHeight: 1.5 }}>
              An M-Pesa STK push will be sent to the number below. Enter your M-Pesa PIN to complete the deposit into your Choice Bank account.
            </div>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>M-Pesa Number</div>
              <input
                type="tel"
                placeholder="e.g. 0712345678"
                value={cbDepositPhone}
                onChange={e => setCbDepositPhone(e.target.value)}
                style={{ width: '100%', padding: '12px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: '#fff', fontSize: 15, fontWeight: 600, boxSizing: 'border-box' }}
              />
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>You can use any M-Pesa number to fund your account</div>
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>Amount (KES)</div>
              <input
                type="number"
                min="1"
                placeholder="e.g. 5000"
                value={cbDepositAmount}
                onChange={e => setCbDepositAmount(e.target.value)}
                style={{ width: '100%', padding: '12px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: '#fff', fontSize: 16, fontWeight: 600, boxSizing: 'border-box' }}
              />
            </div>
            {cbDepositMsg && (() => {
              const tone = cbDepositState === 'waiting' ? '#f59e0b'
                : (cbDepositState === 'success' || cbDepositMsg.includes('✅')) ? '#10b981' : '#ef4444';
              return (
                <div style={{ marginBottom: 12, padding: '10px 14px', borderRadius: 8, background: `${tone}1a`, border: `1px solid ${tone}44`, color: tone, fontSize: 13, display: 'flex', alignItems: 'center', gap: 9 }}>
                  {cbDepositState === 'waiting' && (
                    <span style={{ width: 13, height: 13, flexShrink: 0, borderRadius: '50%', border: '2px solid #f59e0b55', borderTopColor: '#f59e0b', display: 'inline-block', animation: 'cbSpin 0.7s linear infinite' }} />
                  )}
                  <span>{cbDepositMsg}</span>
                  <style>{'@keyframes cbSpin{to{transform:rotate(360deg)}}'}</style>
                </div>
              );
            })()}
            <button
              disabled={cbDepositLoading || cbDepositState === 'waiting' || !cbDepositAmount || Number(cbDepositAmount) < 1 || !cbDepositPhone.trim()}
              onClick={async () => {
                const amt = Math.floor(Number(cbDepositAmount));
                setCbDepositLoading(true); setCbDepositMsg(''); setCbDepositState('');
                try {
                  const r = await choiceDeposit({ amount: amt, mobile: cbDepositPhone.trim() });
                  const txId = r?.data?.txId || '';
                  setCbDepositAmount('');
                  if (!txId) {
                    // No Choice txId came back — can't watch it; fall back to the old message.
                    setCbDepositMsg('✅ STK push sent! Check your phone and enter your M-Pesa PIN.');
                    setCbDepositLoading(false);
                    return;
                  }
                  // Watch the actual transaction until Choice confirms the money landed.
                  setCbDepositState('waiting');
                  setCbDepositMsg('Sent to your phone. Enter your M-Pesa PIN — watching for the money…');
                  const stop = () => {
                    cbDepositTimers.current.forEach((id) => { clearInterval(id); clearTimeout(id); });
                    cbDepositTimers.current = [];
                  };
                  const iv = setInterval(async () => {
                    try {
                      const s = await choiceDepositStatus(txId);
                      const st = s.data?.status;
                      if (st === 'success') {
                        stop();
                        setCbDepositState('success');
                        setCbDepositMsg(`✅ Deposit confirmed — KES ${amt.toLocaleString()} is in your Choice Bank account.`);
                        if (typeof loadData === 'function') loadData();
                        cbDepositTimers.current.push(setTimeout(() => {
                          setShowCbDepositModal(false); setCbDepositState(''); setCbDepositMsg('');
                        }, 1800));
                      } else if (st === 'failed') {
                        stop();
                        setCbDepositState('failed');
                        setCbDepositMsg('❌ Deposit failed or was cancelled — no money was taken. Please try again.');
                      }
                    } catch { /* transient — keep polling */ }
                  }, 3000);
                  cbDepositTimers.current.push(iv);
                  // Give up watching after 3 min; the backend poller still finishes the job.
                  cbDepositTimers.current.push(setTimeout(() => {
                    stop();
                    setCbDepositState((prev) => (prev === 'waiting' ? '' : prev));
                    setCbDepositMsg((prev) => (prev.startsWith('Sent to your phone')
                      ? 'Still processing — it will appear in Transactions once confirmed.' : prev));
                  }, 180000));
                } catch (e) {
                  setCbDepositState('failed');
                  setCbDepositMsg(e?.response?.data?.detail || 'Failed to send STK push. Please try again.');
                }
                setCbDepositLoading(false);
              }}
              style={{ width: '100%', padding: '13px 0', borderRadius: 9, border: 'none', background: cbDepositLoading || cbDepositState === 'waiting' || !cbDepositAmount || !cbDepositPhone.trim() ? '#374151' : 'linear-gradient(135deg, #10b981, #059669)', color: '#fff', fontWeight: 700, fontSize: 15, cursor: cbDepositLoading || cbDepositState === 'waiting' || !cbDepositAmount || !cbDepositPhone.trim() ? 'not-allowed' : 'pointer' }}
            >
              {cbDepositLoading ? 'Sending STK Push…' : cbDepositState === 'waiting' ? 'Waiting for your PIN…' : 'Send M-Pesa Prompt'}
            </button>
          </div>
        </div>
      )}

      {/* ── Mobile bottom navigation bar ── */}
      <nav className="mob-bottom-nav">
        {[
          { key: 'overview',      icon: LayoutDashboard, label: 'Overview'  },
          { key: 'orders',        icon: List,            label: 'Orders'    },
          { key: 'transactions',  icon: ArrowRightLeft,  label: 'Trades'    },
          { key: 'settings',      icon: Settings,        label: 'Settings'  },
          { key: 'more',          icon: MoreHorizontal,  label: 'More'      },
        ].map(({ key, icon: Icon, label }) => {
          const primaryKeys = ['overview','orders','transactions','settings'];
          const isActive = activeTab === key || (key === 'more' && !primaryKeys.includes(activeTab));
          return (
            <button
              key={key}
              className={`mob-nav-btn${isActive ? ' mob-active' : ''}`}
              onClick={() => key === 'more' ? setMobMoreOpen(true) : setActiveTab(key)}
            >
              <Icon size={22} />
              <span className="mob-nav-label">{label}</span>
            </button>
          );
        })}
      </nav>

      {/* ── Mobile more menu overlay ── */}
      {mobMoreOpen && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,0.72)' }}
          onClick={() => setMobMoreOpen(false)}
        >
          <div
            style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: '#111827',
              borderRadius: '16px 16px 0 0', paddingBottom: 32,
              border: '0.5px solid #374151', boxShadow: '0 -8px 40px rgba(0,0,0,0.6)' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ width: 36, height: 4, background: '#374151', borderRadius: 2, margin: '12px auto 8px' }} />
            {[
              ...((profile?.price_tracker_enabled && !rateLimit?.locked) ? [{ key: 'pricetracker', label: 'Price Tracker', icon: TrendingUp }] : []),
              { key: 'profit',       label: 'Profit',      icon: BarChart2   },
              { key: 'logs',         label: 'Bot Logs',    icon: Activity    },
              { key: 'configure',    label: 'Configure',   icon: SlidersHorizontal },
              { key: 'paybill',      label: 'My Paybill',  icon: CreditCard  },
              ...(affiliateData?.affiliate ? [{ key: 'affiliates', label: 'Affiliates', icon: Share2 }] : []),
              { key: 'credits',      label: 'Subscriptions', icon: DollarSign  },
            ].map(({ key, label, icon: Icon }) => (
              <button key={key}
                onClick={() => { setActiveTab(key); setMobMoreOpen(false); }}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 14,
                  padding: '13px 24px', background: 'none', border: 'none', cursor: 'pointer',
                  color: activeTab === key ? '#F59E0B' : '#E5E7EB',
                  fontSize: 14, fontWeight: activeTab === key ? 600 : 400 }}
              >
                <Icon size={20} color={activeTab === key ? '#F59E0B' : '#9CA3AF'} />
                {label}
              </button>
            ))}
            <div style={{ height: 1, background: '#1f2937', margin: '6px 24px' }} />
            <button
              onClick={() => { setMobMoreOpen(false); logout(); }}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 14,
                padding: '13px 24px', background: 'none', border: 'none', cursor: 'pointer',
                color: '#ef4444', fontSize: 14, fontWeight: 600 }}
            >
              <LogOut size={20} color="#ef4444" />
              Log out
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
