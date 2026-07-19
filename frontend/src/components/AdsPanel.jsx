import { useState, useEffect } from 'react';
import { Megaphone, RefreshCw, ArrowDownCircle, ArrowUpCircle } from 'lucide-react';
import api from '../services/api';

// Per-ad automation. Each Binance ad is EITHER a buy ad or a sell ad — never
// both — so the only meaningful choices are: follow the global setting (Default),
// automate this ad, or leave it off. We never offer the opposite side (no "Sell"
// on a buy ad), and "Automate" maps to the ad's own side under the hood.
const OPTS = [
  { key: 'default',  label: 'Default (all)' },
  { key: 'automate', label: 'Automate' },
  { key: 'off',      label: 'Off' },
];

// The stored backend mode for "Automate" depends on the ad's side.
const automateMode = (tradeType) => (tradeType === 'BUY' ? 'buy_only' : 'sell_only');

// Map a stored mode back to one of the 3 choices, tolerant of legacy 'both'.
function choiceOf(ad) {
  const m = ad.mode;
  if (!m) return 'default';
  if (m === 'off') return 'off';
  const on = ad.trade_type === 'BUY' ? ['both', 'buy_only'] : ['both', 'sell_only'];
  return on.includes(m) ? 'automate' : 'off';
}

export default function AdsPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState('');   // advNo currently saving
  const [err, setErr] = useState('');

  const load = async () => {
    setLoading(true); setErr('');
    try {
      const r = await api.get('/traders/ads');
      setData(r.data);
    } catch (e) {
      setErr(e?.response?.data?.detail || 'Could not load your ads.');
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const setChoice = async (ad, choice) => {
    // Translate the 3-way choice into the backend mode for this ad's side.
    const mode = choice === 'default' ? 'default'
      : choice === 'off' ? 'off'
      : automateMode(ad.trade_type);
    setSaving(ad.adv_no);
    setData(d => ({ ...d, ads: d.ads.map(a => a.adv_no === ad.adv_no ? { ...a, mode: mode === 'default' ? null : mode } : a) }));
    try {
      await api.put(`/traders/ads/${encodeURIComponent(ad.adv_no)}`, { mode });
    } catch (e) {
      setErr(e?.response?.data?.detail || 'Could not save. Please retry.');
      load();   // resync on failure
    } finally { setSaving(''); }
  };

  const globalLabel = { both: 'Buy & Sell', buy_only: 'Buy only', sell_only: 'Sell only' }[data?.global_mode] || 'Buy & Sell';

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Megaphone size={20} style={{ color: '#f59e0b' }} />
          <h2 style={{ margin: 0, fontSize: 20, color: '#fff' }}>Ads</h2>
        </div>
        <button onClick={load} disabled={loading}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 8, border: '1px solid #2a2d3a', background: 'transparent', color: '#9ca3af', fontSize: 13, cursor: 'pointer' }}>
          <RefreshCw size={13} /> Refresh
        </button>
      </div>
      <p style={{ color: '#9ca3af', fontSize: 13.5, lineHeight: 1.6, margin: '0 0 20px' }}>
        Choose which of your Binance ads the bot automates. Leave an ad on <b>Default</b> and it's
        automated using your global mode (<b>{globalLabel}</b>). Pick a specific mode to control that
        ad on its own — handy when you run several ads and only want some automated.
      </p>

      {loading ? (
        <div style={{ color: '#6b7280', padding: 30, textAlign: 'center' }}>Loading your ads…</div>
      ) : !data?.connected ? (
        <div style={{ padding: 24, borderRadius: 12, background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.25)', color: '#f59e0b', fontSize: 14 }}>
          Connect your Binance API key in <b>Settings → Binance</b> to load your ads.
        </div>
      ) : err ? (
        <div style={{ padding: 20, borderRadius: 12, background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444', fontSize: 14 }}>
          {err} {data?.error ? <span style={{ color: '#9ca3af' }}>({data.error})</span> : null}
          <div style={{ marginTop: 8, color: '#9ca3af', fontSize: 13 }}>Make sure your desktop app / relay is running, then Refresh.</div>
        </div>
      ) : (data?.ads?.length || 0) === 0 ? (
        <div style={{ padding: 24, borderRadius: 12, background: 'rgba(255,255,255,0.02)', border: '1px solid #2a2d3a', color: '#9ca3af', fontSize: 14 }}>
          No ads found on your Binance account. Post an ad on Binance, then Refresh — it'll appear here.
          {data?.error ? <div style={{ marginTop: 8, color: '#6b7280', fontSize: 12 }}>({data.error})</div> : null}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {data.ads.map(ad => {
            const isBuy = ad.trade_type === 'BUY';
            const online = String(ad.status) === '1';
            const cur = choiceOf(ad);   // 'default' | 'automate' | 'off'
            const off = cur === 'off';
            return (
              <div key={ad.adv_no}
                style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', padding: '16px 18px', borderRadius: 12,
                  background: off ? 'rgba(239,68,68,0.04)' : 'rgba(255,255,255,0.02)',
                  border: `1px solid ${off ? 'rgba(239,68,68,0.25)' : '#2a2d3a'}` }}>
                <div style={{ width: 40, height: 40, borderRadius: 10, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: isBuy ? 'rgba(59,130,246,0.12)' : 'rgba(16,185,129,0.12)' }}>
                  {isBuy ? <ArrowUpCircle size={20} style={{ color: '#3b82f6' }} /> : <ArrowDownCircle size={20} style={{ color: '#10b981' }} />}
                </div>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ color: '#fff', fontWeight: 700, fontSize: 15 }}>{isBuy ? 'Buy' : 'Sell'} {ad.asset}</span>
                    <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 5, background: online ? 'rgba(16,185,129,0.15)' : 'rgba(107,114,128,0.15)', color: online ? '#10b981' : '#9ca3af', fontWeight: 600 }}>
                      {online ? 'Online' : 'Offline'}
                    </span>
                  </div>
                  <div style={{ color: '#9ca3af', fontSize: 12.5, marginTop: 3 }}>
                    {ad.price} {ad.fiat} / {ad.asset}
                    {ad.surplus != null && <> · {Number(ad.surplus).toLocaleString()} {ad.asset} left</>}
                    <span style={{ color: '#4b5563' }}> · #{String(ad.adv_no).slice(-8)}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  <label style={{ color: '#6b7280', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.4px' }}>Automate</label>
                  <select value={cur} disabled={saving === ad.adv_no}
                    onChange={e => setChoice(ad, e.target.value)}
                    style={{ padding: '8px 12px', borderRadius: 8, border: `1px solid ${off ? 'rgba(239,68,68,0.4)' : '#2a2d3a'}`, background: '#0f0f16', color: off ? '#ef4444' : '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', minWidth: 130 }}>
                    {OPTS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                  </select>
                </div>
              </div>
            );
          })}
          <p style={{ color: '#6b7280', fontSize: 12, marginTop: 4, lineHeight: 1.6 }}>
            <b>Default</b> follows your global mode. <b>Automate</b> runs the bot on that ad; <b>Off</b> leaves it
            alone entirely. Each ad only offers its own side. Changes take effect on the next order — sells always
            settle on Choice Bank regardless.
          </p>
        </div>
      )}
    </div>
  );
}
