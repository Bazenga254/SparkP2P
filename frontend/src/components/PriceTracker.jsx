import { useState, useEffect } from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import api from '../services/api';

// Live Binance P2P competitor order book (admin-gated). Renders nothing unless enabled.
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

  const Side = ({ title, hint, rows, accent }) => (
    <div style={{ flex: 1, minWidth: 300 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontWeight: 700, color: accent, fontSize: 14 }}>{title}</span>
        <span style={{ fontSize: 11, color: '#6b7280' }}>{hint}</span>
      </div>
      <div style={{ overflowX: 'auto', border: '1px solid #1f2937', borderRadius: 10 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ color: '#6b7280', textAlign: 'left' }}>
              <th style={{ padding: '8px 10px', fontWeight: 600 }}>#</th>
              <th style={{ padding: '8px 10px', fontWeight: 600 }}>Merchant</th>
              <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Price</th>
              <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Done</th>
              <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>30d</th>
              <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Available</th>
            </tr>
          </thead>
          <tbody>
            {(rows || []).map((r) => (
              <tr key={r.advNo} style={{ borderTop: '1px solid #1f2937', background: r.rank === 1 ? 'rgba(245,158,11,0.06)' : 'transparent' }}>
                <td style={{ padding: '8px 10px', color: r.rank === 1 ? '#f59e0b' : '#9ca3af', fontWeight: 700 }}>{r.rank}</td>
                <td style={{ padding: '8px 10px', color: '#e5e7eb' }}>
                  {r.nick}
                  {r.floating && <span title="Floating (auto) price ad" style={{ marginLeft: 6, fontSize: 9, color: '#818cf8', border: '1px solid rgba(129,140,248,0.4)', borderRadius: 4, padding: '0 4px' }}>AUTO</span>}
                </td>
                <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: accent }}>{fmt(r.price)}</td>
                <td style={{ padding: '8px 10px', textAlign: 'right', color: '#9ca3af' }}>{r.finishRate}%</td>
                <td style={{ padding: '8px 10px', textAlign: 'right', color: '#9ca3af' }}>{r.orders30d.toLocaleString()}</td>
                <td style={{ padding: '8px 10px', textAlign: 'right', color: '#9ca3af' }}>{fmt(r.available)}</td>
              </tr>
            ))}
            {(!rows || rows.length === 0) && (
              <tr><td colSpan={6} style={{ padding: 14, textAlign: 'center', color: '#6b7280' }}>No ads.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header">
        <Activity size={20} style={{ color: '#f59e0b' }} />
        <h3>Price Tracker</h3>
        <span style={{ marginLeft: 10, fontSize: 12, color: '#6b7280' }}>Live Binance P2P · USDT/KES{updatedAt ? ` · updated ${new Date(updatedAt).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : ''}</span>
        <button onClick={load} disabled={loading} title="Refresh" style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
          <RefreshCw size={15} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
        </button>
      </div>

      {err ? (
        <div style={{ padding: '14px 0', color: '#ef4444', fontSize: 13 }}>{err}</div>
      ) : !board ? (
        <div style={{ padding: '14px 0', color: '#6b7280', fontSize: 13 }}>Loading live prices…</div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 4 }}>
            <Side title="Sell USDT" hint="highest first — best to sell to" rows={board.sell} accent="#10b981" />
            <Side title="Buy USDT" hint="cheapest first — best to buy from" rows={board.buy} accent="#3b82f6" />
          </div>
          <p style={{ fontSize: 11, color: '#6b7280', marginTop: 10, marginBottom: 0 }}>
            Rank #1 is the most competitive merchant on each side. Prices update automatically every 30s.
          </p>
        </>
      )}
    </div>
  );
}
