import { useState, useEffect } from 'react';
import api from '../services/api';
import { getAdminDashboard, getAdminTraders, getDisputedOrders, getUnmatchedPayments, updateTraderStatus, updateTraderTier, getAdminTransactions, getAdminAnalytics, getAdminOnlineTraders } from '../services/api';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { RefreshCw, LogOut, LayoutDashboard, Users, AlertTriangle, Banknote, TrendingUp, Settings, UserCheck, ShoppingCart, CheckCircle, Activity, AlertCircle, ArrowRightLeft, DollarSign, Wifi } from 'lucide-react';

const sidebarSections = [
  {
    label: 'OVERVIEW',
    items: [
      { key: 'dashboard', icon: LayoutDashboard, label: 'Dashboard' },
      { key: 'transactions', icon: ArrowRightLeft, label: 'Transactions' },
    ],
  },
  {
    label: 'TRADERS',
    items: [
      { key: 'traders', icon: Users, label: 'All Traders' },
      { key: 'disputes', icon: AlertTriangle, label: 'Disputes' },
      { key: 'unmatched', icon: Banknote, label: 'Unmatched Payments' },
    ],
  },
  {
    label: 'PLATFORM',
    items: [
      { key: 'revenue', icon: TrendingUp, label: 'Revenue' },
      { key: 'settings', icon: Settings, label: 'Settings' },
    ],
  },
];

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

export default function Admin() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [dashboard, setDashboard] = useState(null);
  const [traders, setTraders] = useState([]);
  const [disputes, setDisputes] = useState([]);
  const [unmatched, setUnmatched] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [onlineTraders, setOnlineTraders] = useState([]);
  const [transactions, setTransactions] = useState({ total: 0, transactions: [] });
  const [txPeriod, setTxPeriod] = useState('today');
  const [activeTab, setActiveTab] = useState('dashboard');
  const [refreshing, setRefreshing] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const loadData = async () => {
    setRefreshing(true);
    try {
      const [dashRes, tradersRes, disputesRes, unmatchedRes, analyticsRes, onlineRes] = await Promise.all([
        getAdminDashboard(),
        getAdminTraders(),
        getDisputedOrders(),
        getUnmatchedPayments(),
        getAdminAnalytics(),
        getAdminOnlineTraders(),
      ]);
      setDashboard(dashRes.data);
      setTraders(tradersRes.data);
      setDisputes(disputesRes.data);
      setUnmatched(unmatchedRes.data);
      setAnalytics(analyticsRes.data);
      setOnlineTraders(onlineRes.data);
    } catch (err) {
      console.error('Admin load error:', err);
    }
    setRefreshing(false);
  };

  const loadTransactions = async (period) => {
    try {
      const res = await getAdminTransactions(period, 50);
      setTransactions(res.data);
    } catch (err) {
      console.error('Transactions load error:', err);
    }
  };

  useEffect(() => {
    loadData();
    loadTransactions(txPeriod);
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    loadTransactions(txPeriod);
  }, [txPeriod]);

  const handleStatusChange = async (traderId, newStatus) => {
    await updateTraderStatus(traderId, newStatus);
    loadData();
  };

  const handleTierChange = async (traderId, newTier) => {
    await updateTraderTier(traderId, newTier);
    loadData();
  };

  const handleRoleChange = async (traderId, newRole) => {
    try {
      await api.put(`/admin/traders/${traderId}/role?role=${newRole}`);
      loadData();
    } catch (err) {
      console.error('Failed to update role:', err);
    }
  };

  const pageTitles = {
    dashboard: 'Dashboard',
    traders: 'All Traders',
    disputes: 'Disputes',
    unmatched: 'Unmatched Payments',
    transactions: 'Transactions',
    revenue: 'Revenue',
    settings: 'Settings',
  };

  const fmtKES = (v) => `KES ${(v || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

  // Compute max volume for chart scaling
  const maxVolume = analytics?.monthly_volumes?.length
    ? Math.max(...analytics.monthly_volumes.map((m) => m.total_volume), 1)
    : 1;

  return (
    <div className="adm-layout">
      {/* Mobile overlay */}
      {sidebarOpen && <div className="adm-overlay" onClick={() => setSidebarOpen(false)} />}

      {/* Sidebar */}
      <aside className={`adm-sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="adm-sidebar-header">
          <div className="adm-logo" onClick={() => navigate('/dashboard')}>
            <div className="adm-logo-icon">S</div>
            <span className="adm-logo-text">SparkP2P</span>
          </div>
        </div>

        <nav className="adm-nav">
          {sidebarSections.map((section) => (
            <div key={section.label} className="adm-nav-section">
              <div className="adm-nav-label">{section.label}</div>
              {section.items.map((item) => {
                const Icon = item.icon;
                const badgeCount = item.key === 'disputes' ? disputes.length : item.key === 'unmatched' ? unmatched.length : 0;
                return (
                  <button
                    key={item.key}
                    className={`adm-nav-item ${activeTab === item.key ? 'active' : ''}`}
                    onClick={() => { setActiveTab(item.key); setSidebarOpen(false); }}
                  >
                    <Icon size={18} />
                    <span>{item.label}</span>
                    {badgeCount > 0 && <span className="adm-nav-badge">{badgeCount}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="adm-sidebar-footer">
          <button className="adm-logout-btn" onClick={logout}>
            <LogOut size={18} />
            <span>Logout</span>
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="adm-main">
        <header className="adm-topbar">
          <div className="adm-topbar-left">
            <button className="adm-hamburger" onClick={() => setSidebarOpen(!sidebarOpen)}>
              <span /><span /><span />
            </button>
            <h1 className="adm-page-title">{pageTitles[activeTab] || 'Dashboard'}</h1>
          </div>
          <div className="adm-topbar-right">
            <button className="adm-refresh-btn" onClick={() => { loadData(); loadTransactions(txPeriod); }} disabled={refreshing}>
              <RefreshCw size={16} className={refreshing ? 'spinning' : ''} />
            </button>
          </div>
        </header>

        <div className="adm-content">
          {/* ==================== DASHBOARD ==================== */}
          {activeTab === 'dashboard' && dashboard && (
            <>
              {/* Row 1: Greeting + Online Traders */}
              <div className="adm-two-col" style={{ marginBottom: 16 }}>
                <div className="adm-greeting-card">
                  <div>
                    <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>
                      {getGreeting()}, Admin!
                    </h2>
                    <p style={{ color: 'var(--text-dim)', fontSize: 13.5 }}>
                      Today's platform earnings
                    </p>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--green)' }}>
                      {fmtKES(analytics?.revenue?.today || dashboard.today.revenue)}
                    </div>
                    <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>fees collected</p>
                  </div>
                </div>
                <div className="adm-greeting-card" style={{ flex: '0 0 auto', minWidth: 200 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span className="adm-online-badge" />
                    <div>
                      <div style={{ fontSize: 28, fontWeight: 700 }}>
                        {analytics?.online_traders ?? 0}
                      </div>
                      <p style={{ color: 'var(--text-dim)', fontSize: 12.5 }}>Online Traders</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Row 2: 4 stat cards */}
              <div className="adm-stat-grid">
                <div className="adm-stat-card" style={{ '--card-accent': '#10b981' }}>
                  <div className="adm-stat-info">
                    <span className="adm-stat-label">Total Traders</span>
                    <span className="adm-stat-value">{dashboard.traders.total}</span>
                  </div>
                  <div className="adm-stat-icon" style={{ background: 'rgba(16,185,129,0.15)', color: '#10b981' }}>
                    <Users size={22} />
                  </div>
                </div>
                <div className="adm-stat-card" style={{ '--card-accent': '#3b82f6' }}>
                  <div className="adm-stat-info">
                    <span className="adm-stat-label">Active Traders</span>
                    <span className="adm-stat-value">{dashboard.traders.active}</span>
                  </div>
                  <div className="adm-stat-icon" style={{ background: 'rgba(59,130,246,0.15)', color: '#3b82f6' }}>
                    <UserCheck size={22} />
                  </div>
                </div>
                <div className="adm-stat-card" style={{ '--card-accent': '#f59e0b' }}>
                  <div className="adm-stat-info">
                    <span className="adm-stat-label">Today's Revenue</span>
                    <span className="adm-stat-value">{fmtKES(dashboard.today.revenue)}</span>
                  </div>
                  <div className="adm-stat-icon" style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b' }}>
                    <TrendingUp size={22} />
                  </div>
                </div>
                <div className="adm-stat-card" style={{ '--card-accent': '#06b6d4' }}>
                  <div className="adm-stat-info">
                    <span className="adm-stat-label">Platform Float</span>
                    <span className="adm-stat-value">{fmtKES(dashboard.platform.total_float)}</span>
                  </div>
                  <div className="adm-stat-icon" style={{ background: 'rgba(6,182,212,0.15)', color: '#06b6d4' }}>
                    <Banknote size={22} />
                  </div>
                </div>
              </div>

              {/* Row 3: 4 more stat cards */}
              <div className="adm-stat-grid" style={{ marginTop: 16 }}>
                <div className="adm-stat-card" style={{ '--card-accent': '#8b5cf6' }}>
                  <div className="adm-stat-info">
                    <span className="adm-stat-label">Today's Orders</span>
                    <span className="adm-stat-value">{dashboard.today.orders}</span>
                  </div>
                  <div className="adm-stat-icon" style={{ background: 'rgba(139,92,246,0.15)', color: '#8b5cf6' }}>
                    <ShoppingCart size={22} />
                  </div>
                </div>
                <div className="adm-stat-card" style={{ '--card-accent': '#10b981' }}>
                  <div className="adm-stat-info">
                    <span className="adm-stat-label">Completed Today</span>
                    <span className="adm-stat-value">{dashboard.today.completed}</span>
                  </div>
                  <div className="adm-stat-icon" style={{ background: 'rgba(16,185,129,0.15)', color: '#10b981' }}>
                    <CheckCircle size={22} />
                  </div>
                </div>
                <div className="adm-stat-card" style={{ '--card-accent': '#3b82f6' }}>
                  <div className="adm-stat-info">
                    <span className="adm-stat-label">Today's Volume</span>
                    <span className="adm-stat-value">{fmtKES(dashboard.today.volume)}</span>
                  </div>
                  <div className="adm-stat-icon" style={{ background: 'rgba(59,130,246,0.15)', color: '#3b82f6' }}>
                    <Activity size={22} />
                  </div>
                </div>
                <div className="adm-stat-card" style={{ '--card-accent': dashboard.alerts.disputed_orders > 0 ? '#ef4444' : '#6b7280' }}>
                  <div className="adm-stat-info">
                    <span className="adm-stat-label">Disputed Orders</span>
                    <span className="adm-stat-value" style={{ color: dashboard.alerts.disputed_orders > 0 ? '#ef4444' : undefined }}>
                      {dashboard.alerts.disputed_orders}
                    </span>
                  </div>
                  <div className="adm-stat-icon" style={{
                    background: dashboard.alerts.disputed_orders > 0 ? 'rgba(239,68,68,0.15)' : 'rgba(107,114,128,0.15)',
                    color: dashboard.alerts.disputed_orders > 0 ? '#ef4444' : '#6b7280'
                  }}>
                    <AlertCircle size={22} />
                  </div>
                </div>
              </div>

              {/* Row 4: Chart + Profit Breakdown */}
              <div className="adm-two-col" style={{ marginTop: 16 }}>
                {/* Monthly Volumes Chart */}
                <div className="adm-card" style={{ flex: '3 1 0' }}>
                  <div className="adm-card-header">
                    <h3>Monthly Volumes</h3>
                    <span className="adm-card-count">Last 6 months</span>
                  </div>
                  <div className="adm-chart-container">
                    {analytics?.monthly_volumes?.length > 0 ? (
                      analytics.monthly_volumes.map((m, i) => (
                        <div key={i} className="adm-chart-col">
                          <div className="adm-chart-bars">
                            <div
                              className="adm-chart-bar buy"
                              style={{ height: `${(m.buy_volume / maxVolume) * 140}px` }}
                              title={`Buy: ${fmtKES(m.buy_volume)}`}
                            />
                            <div
                              className="adm-chart-bar sell"
                              style={{ height: `${(m.sell_volume / maxVolume) * 140}px` }}
                              title={`Sell: ${fmtKES(m.sell_volume)}`}
                            />
                          </div>
                          <span className="adm-chart-label">{m.month.split(' ')[0]}</span>
                        </div>
                      ))
                    ) : (
                      <p className="adm-empty" style={{ padding: '40px 0' }}>No volume data yet</p>
                    )}
                  </div>
                  {analytics?.monthly_volumes?.length > 0 && (
                    <div style={{ display: 'flex', gap: 16, padding: '0 20px 14px', fontSize: 12, color: 'var(--text-dim)' }}>
                      <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: 'var(--blue)', marginRight: 5 }} />Buy</span>
                      <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: 'var(--green)', marginRight: 5 }} />Sell</span>
                    </div>
                  )}
                </div>

                {/* Profit Breakdown */}
                <div className="adm-profit-card" style={{ flex: '2 1 0' }}>
                  <div className="adm-card-header">
                    <h3>Platform Profit</h3>
                    <DollarSign size={16} style={{ color: 'var(--accent)' }} />
                  </div>
                  <div style={{ padding: 20 }}>
                    <div className="adm-profit-total">
                      {fmtKES(analytics?.platform_profit)}
                    </div>
                    <p style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 20 }}>all-time fees collected</p>

                    <div className="adm-profit-rows">
                      <div className="adm-profit-row">
                        <span>Today</span>
                        <span className="adm-profit-val">{fmtKES(analytics?.revenue?.today)}</span>
                      </div>
                      <div className="adm-profit-row">
                        <span>This Week</span>
                        <span className="adm-profit-val">{fmtKES(analytics?.revenue?.week)}</span>
                      </div>
                      <div className="adm-profit-row">
                        <span>This Month</span>
                        <span className="adm-profit-val">{fmtKES(analytics?.revenue?.month)}</span>
                      </div>
                      <div className="adm-profit-row">
                        <span>This Year</span>
                        <span className="adm-profit-val">{fmtKES(analytics?.revenue?.year)}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Row 5: Recent Transactions + Top Traders */}
              <div className="adm-two-col" style={{ marginTop: 16 }}>
                {/* Recent Transactions */}
                <div className="adm-card" style={{ flex: '3 1 0' }}>
                  <div className="adm-card-header">
                    <h3>Recent Transactions</h3>
                    <span className="adm-card-count">{transactions.total} total</span>
                  </div>
                  <div className="adm-table-wrap">
                    <table className="adm-table">
                      <thead>
                        <tr>
                          <th>Type</th>
                          <th>Amount</th>
                          <th>Trader</th>
                          <th>Status</th>
                          <th>Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {transactions.transactions.slice(0, 10).map((tx) => (
                          <tr key={tx.id}>
                            <td>
                              <span className={`adm-badge ${tx.direction === 'inbound' ? 'green' : 'yellow'}`}>
                                {tx.direction === 'inbound' ? 'IN' : 'OUT'}
                              </span>
                            </td>
                            <td>{fmtKES(tx.amount)}</td>
                            <td>{tx.trader_name}</td>
                            <td>
                              <span className={`adm-badge ${tx.status === 'completed' ? 'green' : tx.status === 'failed' ? 'red' : 'dim'}`}>
                                {tx.status}
                              </span>
                            </td>
                            <td>{tx.created_at ? new Date(tx.created_at).toLocaleString() : '-'}</td>
                          </tr>
                        ))}
                        {transactions.transactions.length === 0 && (
                          <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: 30 }}>No transactions today</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Top Traders */}
                <div className="adm-top-traders" style={{ flex: '2 1 0' }}>
                  <div className="adm-card-header">
                    <h3>Top Traders</h3>
                    <span className="adm-card-count">by volume</span>
                  </div>
                  <div style={{ padding: '12px 0' }}>
                    {analytics?.top_traders?.length > 0 ? analytics.top_traders.map((t, i) => (
                      <div key={i} className="adm-top-trader-row">
                        <div className="adm-top-trader-rank">#{i + 1}</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</div>
                          <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t.trades} trades</div>
                        </div>
                        <div style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--green)', whiteSpace: 'nowrap' }}>
                          {fmtKES(t.volume)}
                        </div>
                      </div>
                    )) : (
                      <p className="adm-empty">No traders yet</p>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}

          {/* ==================== TRANSACTIONS ==================== */}
          {activeTab === 'transactions' && (
            <div className="adm-card">
              <div className="adm-card-header">
                <h3>All Transactions</h3>
                <div className="adm-period-filter">
                  {['today', 'week', 'month', 'year', 'all'].map((p) => (
                    <button
                      key={p}
                      className={`adm-period-btn ${txPeriod === p ? 'active' : ''}`}
                      onClick={() => setTxPeriod(p)}
                    >
                      {p.charAt(0).toUpperCase() + p.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="adm-table-wrap">
                <table className="adm-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Direction</th>
                      <th>Type</th>
                      <th>Amount</th>
                      <th>Trader</th>
                      <th>Phone</th>
                      <th>Status</th>
                      <th>M-Pesa ID</th>
                      <th>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.transactions.map((tx) => (
                      <tr key={tx.id}>
                        <td className="mono">{tx.id}</td>
                        <td>
                          <span className={`adm-badge ${tx.direction === 'inbound' ? 'green' : 'yellow'}`}>
                            {tx.direction === 'inbound' ? 'Inbound' : 'Outbound'}
                          </span>
                        </td>
                        <td>{tx.transaction_type}</td>
                        <td>{fmtKES(tx.amount)}</td>
                        <td>{tx.trader_name}</td>
                        <td>{tx.phone || '-'}</td>
                        <td>
                          <span className={`adm-badge ${tx.status === 'completed' ? 'green' : tx.status === 'failed' ? 'red' : 'dim'}`}>
                            {tx.status}
                          </span>
                        </td>
                        <td className="mono">{tx.mpesa_transaction_id || '-'}</td>
                        <td>{tx.created_at ? new Date(tx.created_at).toLocaleString() : '-'}</td>
                      </tr>
                    ))}
                    {transactions.transactions.length === 0 && (
                      <tr><td colSpan={9} className="adm-empty">No transactions for this period</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ==================== TRADERS ==================== */}
          {activeTab === 'traders' && (
            <div className="adm-card">
              <div className="adm-card-header">
                <h3>All Traders</h3>
                <span className="adm-card-count">{traders.length} total</span>
              </div>
              <div className="adm-table-wrap">
                <table className="adm-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Phone</th>
                      <th>Binance</th>
                      <th>Trades</th>
                      <th>Volume</th>
                      <th>Tier</th>
                      <th>Role</th>
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
                        <td>
                          <span className={`adm-badge ${t.binance_connected ? 'green' : 'dim'}`}>
                            {t.binance_connected ? 'Yes' : 'No'}
                          </span>
                        </td>
                        <td>{t.total_trades}</td>
                        <td>KES {t.total_volume.toLocaleString()}</td>
                        <td>
                          <select className="adm-select" value={t.tier} onChange={(e) => handleTierChange(t.id, e.target.value)}>
                            <option value="standard">Standard</option>
                            <option value="silver">Silver</option>
                            <option value="gold">Gold</option>
                          </select>
                        </td>
                        <td>
                          <select className="adm-select" value={t.role || 'trader'} onChange={(e) => handleRoleChange(t.id, e.target.value)}>
                            <option value="trader">Trader</option>
                            <option value="employee">Employee</option>
                            <option value="admin">Admin</option>
                          </select>
                        </td>
                        <td>
                          <span className={`adm-badge ${t.status === 'active' ? 'green' : t.status === 'suspended' ? 'red' : 'yellow'}`}>
                            {t.status}
                          </span>
                        </td>
                        <td>
                          <select className="adm-select" value={t.status} onChange={(e) => handleStatusChange(t.id, e.target.value)}>
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
            </div>
          )}

          {/* ==================== DISPUTES ==================== */}
          {activeTab === 'disputes' && (
            <div className="adm-card">
              <div className="adm-card-header">
                <h3>Disputed Orders</h3>
                <span className="adm-card-count">{disputes.length} disputes</span>
              </div>
              {disputes.length === 0 ? (
                <p className="adm-empty">No disputes found</p>
              ) : (
                <div className="adm-table-wrap">
                  <table className="adm-table">
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
                          <td><span className={`adm-badge ${d.side === 'BUY' ? 'green' : 'red'}`}>{d.side}</span></td>
                          <td>KES {d.fiat_amount.toLocaleString()}</td>
                          <td>{d.risk_score || '-'}</td>
                          <td>{new Date(d.created_at).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ==================== UNMATCHED ==================== */}
          {activeTab === 'unmatched' && (
            <div className="adm-card">
              <div className="adm-card-header">
                <h3>Unmatched Payments</h3>
                <span className="adm-card-count">{unmatched.length} payments</span>
              </div>
              <p className="adm-help-text">Payments received that couldn't be matched to any order.</p>
              {unmatched.length === 0 ? (
                <p className="adm-empty">No unmatched payments</p>
              ) : (
                <div className="adm-table-wrap">
                  <table className="adm-table">
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
                </div>
              )}
            </div>
          )}

          {/* ==================== REVENUE ==================== */}
          {activeTab === 'revenue' && (
            <>
              {/* Revenue summary cards */}
              <div className="adm-stat-grid" style={{ marginBottom: 16 }}>
                <div className="adm-stat-card" style={{ '--card-accent': '#10b981' }}>
                  <div className="adm-stat-info">
                    <span className="adm-stat-label">Today's Revenue</span>
                    <span className="adm-stat-value">{fmtKES(analytics?.revenue?.today)}</span>
                  </div>
                  <div className="adm-stat-icon" style={{ background: 'rgba(16,185,129,0.15)', color: '#10b981' }}>
                    <DollarSign size={22} />
                  </div>
                </div>
                <div className="adm-stat-card" style={{ '--card-accent': '#3b82f6' }}>
                  <div className="adm-stat-info">
                    <span className="adm-stat-label">Weekly Revenue</span>
                    <span className="adm-stat-value">{fmtKES(analytics?.revenue?.week)}</span>
                  </div>
                  <div className="adm-stat-icon" style={{ background: 'rgba(59,130,246,0.15)', color: '#3b82f6' }}>
                    <TrendingUp size={22} />
                  </div>
                </div>
                <div className="adm-stat-card" style={{ '--card-accent': '#f59e0b' }}>
                  <div className="adm-stat-info">
                    <span className="adm-stat-label">Monthly Revenue</span>
                    <span className="adm-stat-value">{fmtKES(analytics?.revenue?.month)}</span>
                  </div>
                  <div className="adm-stat-icon" style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b' }}>
                    <TrendingUp size={22} />
                  </div>
                </div>
                <div className="adm-stat-card" style={{ '--card-accent': '#8b5cf6' }}>
                  <div className="adm-stat-info">
                    <span className="adm-stat-label">All-Time Profit</span>
                    <span className="adm-stat-value">{fmtKES(analytics?.platform_profit)}</span>
                  </div>
                  <div className="adm-stat-icon" style={{ background: 'rgba(139,92,246,0.15)', color: '#8b5cf6' }}>
                    <DollarSign size={22} />
                  </div>
                </div>
              </div>

              {/* Monthly breakdown table */}
              <div className="adm-card">
                <div className="adm-card-header">
                  <h3>Monthly Breakdown</h3>
                </div>
                {analytics?.monthly_volumes?.length > 0 ? (
                  <div className="adm-table-wrap">
                    <table className="adm-table">
                      <thead>
                        <tr>
                          <th>Month</th>
                          <th>Buy Volume</th>
                          <th>Sell Volume</th>
                          <th>Total Volume</th>
                          <th>Trades</th>
                          <th>Profit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...analytics.monthly_volumes].reverse().map((m, i) => (
                          <tr key={i}>
                            <td style={{ fontWeight: 600 }}>{m.month}</td>
                            <td style={{ color: 'var(--blue)' }}>{fmtKES(m.buy_volume)}</td>
                            <td style={{ color: 'var(--green)' }}>{fmtKES(m.sell_volume)}</td>
                            <td>{fmtKES(m.total_volume)}</td>
                            <td>{m.trades}</td>
                            <td style={{ color: 'var(--accent)', fontWeight: 600 }}>{fmtKES(m.profit)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="adm-empty">No revenue data yet</p>
                )}
              </div>
            </>
          )}

          {/* ==================== SETTINGS ==================== */}
          {activeTab === 'settings' && (
            <div className="adm-card">
              <div className="adm-card-header">
                <h3>Platform Settings</h3>
              </div>
              <p className="adm-empty">Settings panel coming soon.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
