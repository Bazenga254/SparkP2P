import { useState, useEffect } from 'react';
import { getAdminDashboard, getAdminTraders, getDisputedOrders, getUnmatchedPayments, updateTraderStatus, updateTraderTier } from '../services/api';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { RefreshCw, LogOut, LayoutDashboard, Users, AlertTriangle, Banknote, TrendingUp, Settings, UserCheck, ShoppingCart, CheckCircle, Activity, AlertCircle } from 'lucide-react';

const sidebarSections = [
  {
    label: 'OVERVIEW',
    items: [
      { key: 'dashboard', icon: LayoutDashboard, label: 'Dashboard' },
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

export default function Admin() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [dashboard, setDashboard] = useState(null);
  const [traders, setTraders] = useState([]);
  const [disputes, setDisputes] = useState([]);
  const [unmatched, setUnmatched] = useState([]);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [refreshing, setRefreshing] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

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

  const pageTitles = {
    dashboard: 'Dashboard',
    traders: 'All Traders',
    disputes: 'Disputes',
    unmatched: 'Unmatched Payments',
    revenue: 'Revenue',
    settings: 'Settings',
  };

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
            <button className="adm-refresh-btn" onClick={loadData} disabled={refreshing}>
              <RefreshCw size={16} className={refreshing ? 'spinning' : ''} />
            </button>
          </div>
        </header>

        <div className="adm-content">
          {/* Dashboard stats - always visible on dashboard tab */}
          {activeTab === 'dashboard' && dashboard && (
            <>
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
                    <span className="adm-stat-value">KES {dashboard.today.revenue.toLocaleString()}</span>
                  </div>
                  <div className="adm-stat-icon" style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b' }}>
                    <TrendingUp size={22} />
                  </div>
                </div>
                <div className="adm-stat-card" style={{ '--card-accent': '#06b6d4' }}>
                  <div className="adm-stat-info">
                    <span className="adm-stat-label">Platform Float</span>
                    <span className="adm-stat-value">KES {dashboard.platform.total_float.toLocaleString()}</span>
                  </div>
                  <div className="adm-stat-icon" style={{ background: 'rgba(6,182,212,0.15)', color: '#06b6d4' }}>
                    <Banknote size={22} />
                  </div>
                </div>
              </div>

              <div className="adm-stat-grid" style={{ marginTop: '16px' }}>
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
                    <span className="adm-stat-value">KES {dashboard.today.volume.toLocaleString()}</span>
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
            </>
          )}

          {/* Traders Table */}
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

          {/* Disputes Table */}
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

          {/* Unmatched Payments Table */}
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

          {/* Revenue placeholder */}
          {activeTab === 'revenue' && (
            <div className="adm-card">
              <div className="adm-card-header">
                <h3>Revenue Overview</h3>
              </div>
              <p className="adm-empty">Revenue analytics coming soon.</p>
            </div>
          )}

          {/* Settings placeholder */}
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
