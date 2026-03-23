import { useState, useEffect } from 'react';
import { getAdminDashboard, getAdminTraders, getDisputedOrders, getUnmatchedPayments, updateTraderStatus, updateTraderTier } from '../services/api';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { RefreshCw, LogOut, ArrowLeft } from 'lucide-react';

export default function Admin() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [dashboard, setDashboard] = useState(null);
  const [traders, setTraders] = useState([]);
  const [disputes, setDisputes] = useState([]);
  const [unmatched, setUnmatched] = useState([]);
  const [activeTab, setActiveTab] = useState('overview');
  const [refreshing, setRefreshing] = useState(false);

  const loadData = async () => {
    setRefreshing(true);
    try {
      const [dashRes, tradersRes, disputesRes, unmatchedRes] = await Promise.all([
        getAdminDashboard(),
        getAdminTraders(),
        getDisputedOrders(),
        getUnmatchedPayments(),
      ]);
      setDashboard(dashRes.data);
      setTraders(tradersRes.data);
      setDisputes(disputesRes.data);
      setUnmatched(unmatchedRes.data);
    } catch (err) {
      console.error('Admin load error:', err);
    }
    setRefreshing(false);
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleStatusChange = async (traderId, newStatus) => {
    await updateTraderStatus(traderId, newStatus);
    loadData();
  };

  const handleTierChange = async (traderId, newTier) => {
    await updateTraderTier(traderId, newTier);
    loadData();
  };

  return (
    <div className="dashboard admin">
      <header className="dash-header">
        <div className="dash-header-left">
          <button className="icon-btn" onClick={() => navigate('/dashboard')} title="Back to Dashboard">
            <ArrowLeft size={18} />
          </button>
          <h1>SparkP2P Admin</h1>
        </div>
        <div className="dash-header-right">
          <button className="icon-btn" onClick={loadData} disabled={refreshing}>
            <RefreshCw size={18} className={refreshing ? 'spinning' : ''} />
          </button>
          <button className="icon-btn" onClick={logout}><LogOut size={18} /></button>
        </div>
      </header>

      <nav className="dash-tabs">
        {['overview', 'traders', 'disputes', 'unmatched'].map((tab) => (
          <button
            key={tab}
            className={`tab-btn ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
            {tab === 'disputes' && disputes.length > 0 && (
              <span className="badge-count">{disputes.length}</span>
            )}
            {tab === 'unmatched' && unmatched.length > 0 && (
              <span className="badge-count">{unmatched.length}</span>
            )}
          </button>
        ))}
      </nav>

      <main className="dash-content">
        {activeTab === 'overview' && dashboard && (
          <div className="admin-grid">
            <div className="card">
              <h3>Traders</h3>
              <div className="big-stat">{dashboard.traders.total}</div>
              <span className="stat-label">{dashboard.traders.active} active</span>
            </div>
            <div className="card">
              <h3>Today's Orders</h3>
              <div className="big-stat">{dashboard.today.orders}</div>
              <span className="stat-label">{dashboard.today.completed} completed</span>
            </div>
            <div className="card">
              <h3>Today's Volume</h3>
              <div className="big-stat">KES {dashboard.today.volume.toLocaleString()}</div>
            </div>
            <div className="card">
              <h3>Today's Revenue</h3>
              <div className="big-stat">KES {dashboard.today.revenue.toLocaleString()}</div>
            </div>
            <div className="card">
              <h3>Platform Float</h3>
              <div className="big-stat">KES {dashboard.platform.total_float.toLocaleString()}</div>
            </div>
            <div className="card alert-card">
              <h3>Disputed Orders</h3>
              <div className="big-stat">{dashboard.alerts.disputed_orders}</div>
            </div>
          </div>
        )}

        {activeTab === 'traders' && (
          <div className="card">
            <h3>All Traders</h3>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Binance</th>
                  <th>Trades</th>
                  <th>Volume</th>
                  <th>Tier</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {traders.map((t) => (
                  <tr key={t.id}>
                    <td>{t.full_name}</td>
                    <td>{t.email}</td>
                    <td>{t.phone}</td>
                    <td>{t.binance_connected ? 'Yes' : 'No'}</td>
                    <td>{t.total_trades}</td>
                    <td>KES {t.total_volume.toLocaleString()}</td>
                    <td>
                      <select value={t.tier} onChange={(e) => handleTierChange(t.id, e.target.value)}>
                        <option value="standard">Standard</option>
                        <option value="silver">Silver</option>
                        <option value="gold">Gold</option>
                      </select>
                    </td>
                    <td style={{ color: t.status === 'active' ? '#10b981' : '#f59e0b' }}>{t.status}</td>
                    <td>
                      <select value={t.status} onChange={(e) => handleStatusChange(t.id, e.target.value)}>
                        <option value="pending">Pending</option>
                        <option value="active">Active</option>
                        <option value="paused">Paused</option>
                        <option value="suspended">Suspended</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'disputes' && (
          <div className="card">
            <h3>Disputed Orders</h3>
            {disputes.length === 0 ? <p className="empty-msg">No disputes</p> : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Order #</th>
                    <th>Trader</th>
                    <th>Side</th>
                    <th>Amount</th>
                    <th>Risk Score</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {disputes.map((d) => (
                    <tr key={d.id}>
                      <td className="mono">{d.binance_order_number}</td>
                      <td>{d.trader_id}</td>
                      <td>{d.side}</td>
                      <td>KES {d.fiat_amount.toLocaleString()}</td>
                      <td>{d.risk_score || '-'}</td>
                      <td>{new Date(d.created_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {activeTab === 'unmatched' && (
          <div className="card">
            <h3>Unmatched Payments</h3>
            <p className="help-text">Payments received that couldn't be matched to any order.</p>
            {unmatched.length === 0 ? <p className="empty-msg">No unmatched payments</p> : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Amount</th>
                    <th>Phone</th>
                    <th>Sender</th>
                    <th>Reference</th>
                    <th>M-Pesa ID</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {unmatched.map((p) => (
                    <tr key={p.id}>
                      <td>KES {p.amount.toLocaleString()}</td>
                      <td>{p.phone}</td>
                      <td>{p.sender_name}</td>
                      <td className="mono">{p.bill_ref_number}</td>
                      <td className="mono">{p.mpesa_transaction_id}</td>
                      <td>{new Date(p.created_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
