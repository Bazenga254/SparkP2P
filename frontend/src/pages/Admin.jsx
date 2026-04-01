import { useState, useEffect } from 'react';
import api from '../services/api';
import { getAdminDashboard, getAdminTraders, getDisputedOrders, getUnmatchedPayments, updateTraderStatus, updateTraderTier, getAdminTransactions, getAdminAnalytics, getAdminOnlineTraders, getMessageTemplates, updateMessageTemplate, seedMessageTemplates } from '../services/api';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { RefreshCw, LogOut, LayoutDashboard, Users, AlertTriangle, Banknote, TrendingUp, Settings, UserCheck, ShoppingCart, CheckCircle, Activity, AlertCircle, ArrowRightLeft, DollarSign, Wifi, Repeat, MessageSquare, Save, RotateCcw, ChevronDown, ChevronUp, Copy } from 'lucide-react';

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
  const [selectedTrader, setSelectedTrader] = useState(null);
  const [paybillBalance, setPaybillBalance] = useState(null);
  const [traderDetail, setTraderDetail] = useState(null);
  const [resetPwLoading, setResetPwLoading] = useState(false);
  const [resetPwMsg, setResetPwMsg] = useState('');
  const [disputes, setDisputes] = useState([]);
  const [unmatched, setUnmatched] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [onlineTraders, setOnlineTraders] = useState([]);
  const [transactions, setTransactions] = useState({ total: 0, transactions: [] });
  const [txPeriod, setTxPeriod] = useState('today');
  const [activeTab, setActiveTab] = useState('dashboard');
  const [refreshing, setRefreshing] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [editBody, setEditBody] = useState('');
  const [editSubject, setEditSubject] = useState('');
  const [templateSaving, setTemplateSaving] = useState(false);
  const [templateMsg, setTemplateMsg] = useState('');
  const [expandedTemplates, setExpandedTemplates] = useState({});

  const loadTemplates = async () => {
    try {
      const res = await getMessageTemplates();
      setTemplates(res.data);
    } catch (err) {
      console.error('Templates load error:', err);
    }
  };

  const handleEditTemplate = (tpl) => {
    setEditingTemplate(tpl.key);
    setEditBody(tpl.body);
    setEditSubject(tpl.subject || '');
    setTemplateMsg('');
  };

  const handleCancelEdit = () => {
    setEditingTemplate(null);
    setEditBody('');
    setEditSubject('');
    setTemplateMsg('');
  };

  const handleSaveTemplate = async (key) => {
    setTemplateSaving(true);
    try {
      await updateMessageTemplate(key, { body: editBody, subject: editSubject || null });
      setTemplateMsg('Template saved!');
      setEditingTemplate(null);
      loadTemplates();
    } catch (err) {
      setTemplateMsg(err.response?.data?.detail || 'Failed to save');
    }
    setTemplateSaving(false);
    setTimeout(() => setTemplateMsg(''), 3000);
  };

  const handleSeedTemplates = async (force = false) => {
    if (force && !confirm('Reset ALL templates to defaults? This will overwrite your edits.')) return;
    try {
      await seedMessageTemplates();
      setTemplateMsg('Templates seeded!');
      loadTemplates();
    } catch (err) {
      setTemplateMsg('Seed failed');
    }
    setTimeout(() => setTemplateMsg(''), 3000);
  };

  const insertVariable = (varName) => {
    setEditBody((prev) => prev + `{${varName}}`);
  };

  const toggleTemplateExpand = (key) => {
    setExpandedTemplates((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const getPreviewText = (body, variables) => {
    const sampleData = {
      amount: '5,000', balance: '12,500', crypto_amount: '45.50',
      currency: 'USDT', fiat_amount: '6,000', code: '482931',
      plan: 'Starter', expires: 'April 25, 2026', trader_name: 'John Doe',
    };
    let preview = body;
    try {
      const vars = JSON.parse(variables || '[]');
      vars.forEach((v) => {
        preview = preview.replace(new RegExp(`\\{${v}\\}`, 'g'), sampleData[v] || `[${v}]`);
      });
    } catch {}
    return preview;
  };

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

      // Fetch paybill balance + trigger refresh
      try {
        api.post('/payment/balance/refresh').catch(() => {});
        const balRes = await api.get('/payment/balance');
        if (balRes.data) setPaybillBalance(balRes.data);
      } catch(e) {}
    } catch (err) {
      console.error('Admin load error:', err);
    }
    setRefreshing(false);
  };

  const [txnSearch, setTxnSearch] = useState('');

  const loadTransactions = async (period, search) => {
    try {
      const res = await getAdminTransactions(period, 50, search);
      setTransactions(res.data);
    } catch (err) {
      console.error('Transactions load error:', err);
    }
  };

  useEffect(() => {
    loadData();
    loadTransactions(txPeriod);
    loadTemplates();
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
                <div className="adm-stat-card" style={{ '--card-accent': '#06b6d4', cursor: 'pointer' }} onClick={async () => {
                  try { await api.post('/payment/balance/refresh'); setTimeout(async () => { try { const r = await api.get('/payment/balance'); if (r.data?.balance) setPaybillBalance(r.data); } catch(e){} }, 10000); } catch(e){}
                }}>
                  <div className="adm-stat-info">
                    <span className="adm-stat-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>Paybill Balance {paybillBalance?.updated_at && <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981', display: 'inline-block', animation: 'pulse-green 1.5s ease-in-out infinite', boxShadow: '0 0 6px #10b981' }} />}</span>
                    <span className="adm-stat-value">
                      {paybillBalance?.balance
                        ? fmtKES(Object.values(paybillBalance.balance).reduce((sum, a) => sum + (a.available || 0), 0))
                        : fmtKES(dashboard.platform.total_float)}
                    </span>
                    {paybillBalance?.updated_at && <span style={{ fontSize: 10, color: '#6b7280' }}>Updated: {new Date(paybillBalance.updated_at).toLocaleTimeString()}</span>}
                    {!paybillBalance?.balance && <span style={{ fontSize: 10, color: '#6b7280' }}>Click to refresh</span>}
                  </div>
                  <div className="adm-stat-icon" style={{ background: 'rgba(6,182,212,0.15)', color: '#06b6d4' }}>
                    <Banknote size={22} />
                  </div>
                </div>
              </div>

              {/* Row 3: 4 more stat cards */}
              <div className="adm-stat-grid" style={{ marginTop: 16 }}>
                <div className="adm-stat-card" style={{ '--card-accent': '#06b6d4' }}>
                  <div className="adm-stat-info">
                    <span className="adm-stat-label">Platform Float</span>
                    <span className="adm-stat-value">{fmtKES(dashboard.platform.total_float)}</span>
                    <span style={{ fontSize: 10, color: '#6b7280' }}>Total trader wallet balances</span>
                  </div>
                  <div className="adm-stat-icon" style={{ background: 'rgba(6,182,212,0.15)', color: '#06b6d4' }}>
                    <Banknote size={22} />
                  </div>
                </div>
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

              {/* Row 2b: Internal Transfers */}
              {dashboard.internal_transfers && (dashboard.internal_transfers.today_count > 0 || (analytics?.internal_transfers?.month_count || 0) > 0) && (
                <div className="adm-stat-grid" style={{ marginTop: 16 }}>
                  <div className="adm-stat-card" style={{ '--card-accent': '#8b5cf6' }}>
                    <div className="adm-stat-info">
                      <span className="adm-stat-label">Internal Transfers Today</span>
                      <span className="adm-stat-value">{dashboard.internal_transfers.today_count}</span>
                    </div>
                    <div className="adm-stat-icon" style={{ background: 'rgba(139,92,246,0.15)', color: '#8b5cf6' }}>
                      <Repeat size={22} />
                    </div>
                  </div>
                  <div className="adm-stat-card" style={{ '--card-accent': '#10b981' }}>
                    <div className="adm-stat-info">
                      <span className="adm-stat-label">Internal Volume Today</span>
                      <span className="adm-stat-value">{fmtKES(dashboard.internal_transfers.today_volume)}</span>
                    </div>
                    <div className="adm-stat-icon" style={{ background: 'rgba(16,185,129,0.15)', color: '#10b981' }}>
                      <DollarSign size={22} />
                    </div>
                  </div>
                  <div className="adm-stat-card" style={{ '--card-accent': '#3b82f6' }}>
                    <div className="adm-stat-info">
                      <span className="adm-stat-label">Fees Saved (est.)</span>
                      <span className="adm-stat-value" style={{ color: '#10b981' }}>
                        {fmtKES((dashboard.internal_transfers.today_count || 0) * 77)}
                      </span>
                    </div>
                    <div className="adm-stat-icon" style={{ background: 'rgba(59,130,246,0.15)', color: '#3b82f6' }}>
                      <TrendingUp size={22} />
                    </div>
                  </div>
                </div>
              )}

              {/* Row 4: Chart + Profit Breakdown */}
              <div className="adm-two-col" style={{ marginTop: 16 }}>
                {/* Monthly Volumes Chart */}
                <div className="adm-card" style={{ flex: '3 1 0' }}>
                  <div className="adm-card-header">
                    <h3>Monthly Volumes</h3>
                    <span className="adm-card-count">Last 6 months</span>
                  </div>
                  <div style={{ padding: '10px 20px 0' }}>
                    {analytics?.monthly_volumes?.length > 0 ? (
                      <div style={{ display: 'flex', gap: 0 }}>
                        {/* Y-axis labels */}
                        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', paddingBottom: 24, marginRight: 8, width: 60, textAlign: 'right' }}>
                          {[maxVolume, maxVolume * 0.75, maxVolume * 0.5, maxVolume * 0.25, 0].map((v, i) => (
                            <span key={i} style={{ fontSize: 10, color: '#6b7280', lineHeight: 1 }}>
                              {v >= 1000000 ? `${(v/1000000).toFixed(1)}M` : v >= 1000 ? `${(v/1000).toFixed(0)}K` : v.toFixed(0)}
                            </span>
                          ))}
                        </div>
                        {/* Chart area */}
                        <div style={{ flex: 1, position: 'relative' }}>
                          {/* Grid lines */}
                          <div style={{ position: 'absolute', inset: 0, bottom: 24, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', pointerEvents: 'none' }}>
                            {[0,1,2,3,4].map(i => <div key={i} style={{ borderBottom: '1px solid var(--border)', width: '100%' }} />)}
                          </div>
                          {/* Bars */}
                          <div style={{ display: 'flex', justifyContent: 'space-around', alignItems: 'flex-end', height: 160, position: 'relative', paddingBottom: 24 }}>
                            {analytics.monthly_volumes.map((m, i) => (
                              <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1 }}>
                                <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 136 }}>
                                  <div style={{
                                    width: 18, background: 'var(--blue)', borderRadius: '3px 3px 0 0',
                                    height: `${Math.max((m.buy_volume / maxVolume) * 136, 2)}px`,
                                  }} title={`Buy: ${fmtKES(m.buy_volume)}`} />
                                  <div style={{
                                    width: 18, background: 'var(--green)', borderRadius: '3px 3px 0 0',
                                    height: `${Math.max((m.sell_volume / maxVolume) * 136, 2)}px`,
                                  }} title={`Sell: ${fmtKES(m.sell_volume)}`} />
                                </div>
                                <span style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>{m.month.split(' ')[0]}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
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
              {/* Search bar */}
              <div style={{ padding: '12px 0', display: 'flex', gap: 8 }}>
                <input
                  type="text"
                  placeholder="Search by M-Pesa code, phone, name..."
                  value={txnSearch}
                  onChange={(e) => setTxnSearch(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && loadTransactions(txPeriod, txnSearch)}
                  style={{
                    flex: 1, padding: '10px 14px', borderRadius: 8,
                    border: '1px solid var(--border)', background: 'var(--bg)',
                    color: '#fff', fontSize: 13,
                  }}
                />
                <button
                  onClick={() => loadTransactions(txPeriod, txnSearch)}
                  style={{
                    padding: '10px 20px', borderRadius: 8, border: 'none',
                    background: '#f59e0b', color: '#000', fontWeight: 600, fontSize: 13, cursor: 'pointer',
                  }}
                >
                  Search
                </button>
                {txnSearch && (
                  <button
                    onClick={() => { setTxnSearch(''); loadTransactions(txPeriod, ''); }}
                    style={{
                      padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border)',
                      background: 'transparent', color: '#9ca3af', fontSize: 13, cursor: 'pointer',
                    }}
                  >
                    Clear
                  </button>
                )}
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
                      <th>Recipient/Sender</th>
                      <th>Phone</th>
                      <th>M-Pesa Code</th>
                      <th>Reference</th>
                      <th>Status</th>
                      <th>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.transactions.map((tx) => (
                      <tr key={tx.id}>
                        <td className="mono">{tx.id}</td>
                        <td>
                          <span className={`adm-badge ${tx.direction === 'inbound' ? 'green' : 'yellow'}`}>
                            {tx.direction === 'inbound' ? 'IN' : 'OUT'}
                          </span>
                        </td>
                        <td>{tx.transaction_type}</td>
                        <td style={{ fontWeight: 600, color: tx.direction === 'inbound' ? '#10b981' : '#f59e0b' }}>
                          {tx.direction === 'inbound' ? '+' : '-'}{fmtKES(tx.amount)}
                        </td>
                        <td>{tx.trader_name}</td>
                        <td>{tx.sender_name !== '-' ? tx.sender_name : tx.destination !== '-' ? tx.destination : '-'}</td>
                        <td className="mono">{tx.phone !== '-' ? tx.phone : tx.trader_phone}</td>
                        <td className="mono" style={{ color: '#f59e0b' }}>{tx.mpesa_transaction_id}</td>
                        <td className="mono">{tx.bill_ref_number}</td>
                        <td>
                          <span className={`adm-badge ${tx.status === 'completed' ? 'green' : tx.status === 'failed' ? 'red' : 'dim'}`}>
                            {tx.status}
                          </span>
                        </td>
                        <td>{tx.created_at ? new Date(tx.created_at).toLocaleString() : '-'}</td>
                      </tr>
                    ))}
                    {transactions.transactions.length === 0 && (
                      <tr><td colSpan={11} className="adm-empty">No transactions found</td></tr>
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
                        <td><button style={{ background: 'none', border: 'none', color: '#f59e0b', cursor: 'pointer', fontWeight: 600, textDecoration: 'underline', padding: 0 }} onClick={async () => {
                          setSelectedTrader(t);
                          try {
                            const res = await api.get(`/admin/traders/${t.id}/detail`);
                            setTraderDetail(res.data);
                          } catch (e) { setTraderDetail({}); }
                          setResetPwMsg('');
                        }}>{t.full_name}</button></td>
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
                            <option value="standard">Free</option>
                            <option value="starter">Starter</option>
                            <option value="pro">Pro</option>
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

              {/* Trader Detail Modal */}
              {selectedTrader && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setSelectedTrader(null)}>
                  <div style={{ background: 'var(--surface)', borderRadius: 12, width: 500, maxHeight: '80vh', overflow: 'auto', padding: 24, border: '1px solid var(--border)' }} onClick={e => e.stopPropagation()}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                      <h3 style={{ margin: 0 }}>{selectedTrader.full_name}</h3>
                      <button onClick={() => setSelectedTrader(null)} style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: 20, cursor: 'pointer' }}>✕</button>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 13, marginBottom: 16 }}>
                      <div><span style={{ color: '#6b7280' }}>Email:</span> <strong>{selectedTrader.email}</strong></div>
                      <div><span style={{ color: '#6b7280' }}>Phone:</span> <strong>{selectedTrader.phone}</strong></div>
                      <div><span style={{ color: '#6b7280' }}>Role:</span> <strong>{selectedTrader.role}</strong></div>
                      <div><span style={{ color: '#6b7280' }}>Status:</span> <strong>{selectedTrader.status}</strong></div>
                      <div><span style={{ color: '#6b7280' }}>Tier:</span> <strong>{selectedTrader.tier}</strong></div>
                      <div><span style={{ color: '#6b7280' }}>Binance:</span> <strong>{selectedTrader.binance_connected ? 'Connected' : 'No'}</strong></div>
                      <div><span style={{ color: '#6b7280' }}>Trades:</span> <strong>{selectedTrader.total_trades}</strong></div>
                      <div><span style={{ color: '#6b7280' }}>Volume:</span> <strong>KES {selectedTrader.total_volume?.toLocaleString()}</strong></div>
                    </div>

                    {/* Security Question */}
                    <div style={{ background: 'var(--bg)', borderRadius: 8, padding: 12, marginBottom: 12, border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Security Question</div>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{traderDetail?.security_question || 'Not set'}</div>
                      {traderDetail?.security_answer && (
                        <div style={{ fontSize: 13, color: '#9ca3af', marginTop: 4 }}>Answer: <strong>{traderDetail.security_answer}</strong></div>
                      )}
                    </div>

                    {/* Settlement Info */}
                    <div style={{ background: 'var(--bg)', borderRadius: 8, padding: 12, marginBottom: 12, border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Settlement</div>
                      <div style={{ fontSize: 13 }}>
                        Method: <strong>{traderDetail?.settlement_method || 'Not set'}</strong>
                        {traderDetail?.settlement_destination && <> — {traderDetail.settlement_destination}</>}
                      </div>
                    </div>

                    {/* Google ID */}
                    {traderDetail?.google_id && (
                      <div style={{ background: 'var(--bg)', borderRadius: 8, padding: 12, marginBottom: 12, border: '1px solid var(--border)' }}>
                        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Google Account</div>
                        <div style={{ fontSize: 13 }}>ID: {traderDetail.google_id}</div>
                      </div>
                    )}

                    {/* Reset Password */}
                    <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
                      <button
                        style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid #ef4444', background: 'rgba(239,68,68,0.1)', color: '#ef4444', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}
                        disabled={resetPwLoading}
                        onClick={async () => {
                          setResetPwLoading(true);
                          try {
                            await api.post(`/admin/traders/${selectedTrader.id}/reset-password`);
                            setResetPwMsg('Password reset! New password sent via SMS.');
                          } catch (e) {
                            setResetPwMsg('Failed to reset password.');
                          }
                          setResetPwLoading(false);
                        }}
                      >
                        {resetPwLoading ? 'Resetting...' : 'Reset Password'}
                      </button>
                      <button
                        style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: '#9ca3af', cursor: 'pointer', fontSize: 13 }}
                        onClick={() => setSelectedTrader(null)}
                      >
                        Close
                      </button>
                    </div>
                    {resetPwMsg && <div style={{ marginTop: 8, fontSize: 12, color: resetPwMsg.includes('Failed') ? '#ef4444' : '#10b981', textAlign: 'center' }}>{resetPwMsg}</div>}
                  </div>
                </div>
              )}
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
            <div>
              {/* Create Employee */}
              <div className="adm-card" style={{ marginBottom: 20 }}>
                <div className="adm-card-header">
                  <h3>Create Employee Account</h3>
                </div>
                <form onSubmit={async (e) => {
                  e.preventDefault();
                  const fd = new FormData(e.target);
                  try {
                    const res = await api.post(
                      `/admin/employees/create?full_name=${encodeURIComponent(fd.get('name'))}&email=${encodeURIComponent(fd.get('email'))}&password=${encodeURIComponent(fd.get('password'))}&phone=${encodeURIComponent(fd.get('phone') || '0000000000')}`
                    );
                    alert(`Employee created! Email: ${res.data.email}`);
                    e.target.reset();
                    loadData();
                  } catch (err) {
                    alert(err.response?.data?.detail || 'Failed to create employee');
                  }
                }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                    <div>
                      <label style={{ display: 'block', fontSize: 13, color: '#9ca3af', marginBottom: 4 }}>Full Name</label>
                      <input name="name" type="text" required placeholder="John Doe" className="adm-input" />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: 13, color: '#9ca3af', marginBottom: 4 }}>Email</label>
                      <input name="email" type="email" required placeholder="employee@sparkp2p.com" className="adm-input" />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: 13, color: '#9ca3af', marginBottom: 4 }}>Phone (optional)</label>
                      <input name="phone" type="tel" placeholder="0712345678" className="adm-input" />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: 13, color: '#9ca3af', marginBottom: 4 }}>Password</label>
                      <input name="password" type="text" required placeholder="Temporary password" className="adm-input" />
                    </div>
                  </div>
                  <button type="submit" className="adm-btn-primary">Create Employee</button>
                </form>
              </div>

              {/* Message Templates */}
              <div className="adm-card">
                <div
                  className="adm-card-header"
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
                  onClick={() => setShowTemplates(!showTemplates)}
                >
                  <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <MessageSquare size={18} /> Message Templates
                    <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 400 }}>
                      ({templates.length})
                    </span>
                    <span style={{ fontSize: 14, color: '#6b7280', transition: 'transform 0.2s', transform: showTemplates ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                      ▼
                    </span>
                  </h3>
                  {showTemplates && (
                    <button
                      className="adm-btn-secondary"
                      onClick={(e) => { e.stopPropagation(); handleSeedTemplates(false); }}
                      style={{ fontSize: 12, padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 4 }}
                    >
                      <RotateCcw size={14} /> Seed Defaults
                    </button>
                  )}
                </div>

                {showTemplates && (<>

                {templateMsg && (
                  <div style={{
                    padding: '8px 14px', margin: '0 16px 12px', borderRadius: 6,
                    background: templateMsg.includes('fail') || templateMsg.includes('Failed') ? '#3b1218' : '#12261e',
                    color: templateMsg.includes('fail') || templateMsg.includes('Failed') ? '#f87171' : '#4ade80',
                    fontSize: 13,
                  }}>
                    {templateMsg}
                  </div>
                )}

                {/* Group by channel */}
                {['sms', 'email'].map((channel) => {
                  const channelTemplates = templates.filter((t) => t.channel === channel);
                  if (channelTemplates.length === 0) return null;
                  return (
                    <div key={channel} style={{ marginBottom: 16, padding: '0 16px 16px' }}>
                      <h4 style={{
                        textTransform: 'uppercase', fontSize: 11, letterSpacing: 1.5,
                        color: '#9ca3af', marginBottom: 10, paddingBottom: 6,
                        borderBottom: '1px solid rgba(255,255,255,0.06)',
                      }}>
                        {channel} Templates ({channelTemplates.length})
                      </h4>

                      {channelTemplates.map((tpl) => {
                        const isEditing = editingTemplate === tpl.key;
                        const isExpanded = expandedTemplates[tpl.key];
                        const vars = (() => { try { return JSON.parse(tpl.variables || '[]'); } catch { return []; } })();

                        return (
                          <div key={tpl.key} style={{
                            background: 'rgba(255,255,255,0.03)', borderRadius: 8,
                            marginBottom: 8, border: '1px solid rgba(255,255,255,0.06)',
                            overflow: 'hidden',
                          }}>
                            {/* Template header */}
                            <div
                              style={{
                                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                padding: '10px 14px', cursor: 'pointer',
                              }}
                              onClick={() => toggleTemplateExpand(tpl.key)}
                            >
                              <div>
                                <span style={{ fontWeight: 600, fontSize: 14 }}>{tpl.name}</span>
                                <span style={{ fontSize: 11, color: '#6b7280', marginLeft: 8 }}>{tpl.key}</span>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                {!isEditing && (
                                  <button
                                    className="adm-btn-secondary"
                                    style={{ fontSize: 11, padding: '3px 8px' }}
                                    onClick={(e) => { e.stopPropagation(); handleEditTemplate(tpl); }}
                                  >
                                    Edit
                                  </button>
                                )}
                                {isExpanded ? <ChevronUp size={16} color="#6b7280" /> : <ChevronDown size={16} color="#6b7280" />}
                              </div>
                            </div>

                            {/* Collapsed: show truncated body */}
                            {!isExpanded && !isEditing && (
                              <div style={{ padding: '0 14px 10px', fontSize: 12, color: '#9ca3af', lineHeight: 1.4 }}>
                                {tpl.body.length > 100 ? tpl.body.slice(0, 100) + '...' : tpl.body}
                              </div>
                            )}

                            {/* Expanded: show full body + preview */}
                            {isExpanded && !isEditing && (
                              <div style={{ padding: '0 14px 14px' }}>
                                <div style={{
                                  background: 'rgba(0,0,0,0.3)', borderRadius: 6, padding: '10px 12px',
                                  fontSize: 13, color: '#e5e7eb', lineHeight: 1.5, fontFamily: 'monospace',
                                  marginBottom: 8,
                                }}>
                                  {tpl.body}
                                </div>
                                {vars.length > 0 && (
                                  <div style={{ marginBottom: 8 }}>
                                    <span style={{ fontSize: 11, color: '#6b7280' }}>Variables: </span>
                                    {vars.map((v) => (
                                      <span key={v} style={{
                                        display: 'inline-block', fontSize: 11, padding: '2px 6px',
                                        borderRadius: 4, background: 'rgba(99,102,241,0.15)', color: '#818cf8',
                                        marginRight: 4, marginBottom: 2,
                                      }}>
                                        {'{' + v + '}'}
                                      </span>
                                    ))}
                                  </div>
                                )}
                                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Preview:</div>
                                <div style={{
                                  background: 'rgba(34,197,94,0.08)', borderRadius: 6, padding: '8px 12px',
                                  fontSize: 12, color: '#86efac', lineHeight: 1.4, borderLeft: '3px solid #22c55e',
                                }}>
                                  {getPreviewText(tpl.body, tpl.variables)}
                                </div>
                              </div>
                            )}

                            {/* Editing mode */}
                            {isEditing && (
                              <div style={{ padding: '0 14px 14px' }}>
                                {tpl.channel === 'email' && (
                                  <div style={{ marginBottom: 8 }}>
                                    <label style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 4 }}>Subject</label>
                                    <input
                                      className="adm-input"
                                      value={editSubject}
                                      onChange={(e) => setEditSubject(e.target.value)}
                                      placeholder="Email subject line"
                                    />
                                  </div>
                                )}
                                <div style={{ marginBottom: 8 }}>
                                  <label style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 4 }}>Body</label>
                                  <textarea
                                    className="adm-input"
                                    value={editBody}
                                    onChange={(e) => setEditBody(e.target.value)}
                                    rows={4}
                                    style={{ width: '100%', resize: 'vertical', fontFamily: 'monospace', fontSize: 13, lineHeight: 1.5 }}
                                  />
                                </div>
                                {vars.length > 0 && (
                                  <div style={{ marginBottom: 10 }}>
                                    <span style={{ fontSize: 11, color: '#6b7280' }}>Insert variable: </span>
                                    {vars.map((v) => (
                                      <button
                                        key={v}
                                        type="button"
                                        onClick={() => insertVariable(v)}
                                        style={{
                                          display: 'inline-block', fontSize: 11, padding: '2px 8px',
                                          borderRadius: 4, background: 'rgba(99,102,241,0.2)', color: '#a5b4fc',
                                          border: '1px solid rgba(99,102,241,0.3)', cursor: 'pointer',
                                          marginRight: 4, marginBottom: 2,
                                        }}
                                      >
                                        {'{' + v + '}'}
                                      </button>
                                    ))}
                                  </div>
                                )}
                                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Preview:</div>
                                <div style={{
                                  background: 'rgba(34,197,94,0.08)', borderRadius: 6, padding: '8px 12px',
                                  fontSize: 12, color: '#86efac', lineHeight: 1.4, marginBottom: 12,
                                  borderLeft: '3px solid #22c55e',
                                }}>
                                  {getPreviewText(editBody, tpl.variables)}
                                </div>
                                <div style={{ display: 'flex', gap: 8 }}>
                                  <button
                                    className="adm-btn-primary"
                                    onClick={() => handleSaveTemplate(tpl.key)}
                                    disabled={templateSaving}
                                    style={{ fontSize: 12, padding: '6px 14px', display: 'flex', alignItems: 'center', gap: 4 }}
                                  >
                                    <Save size={14} /> {templateSaving ? 'Saving...' : 'Save'}
                                  </button>
                                  <button
                                    className="adm-btn-secondary"
                                    onClick={handleCancelEdit}
                                    style={{ fontSize: 12, padding: '6px 14px' }}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}

                {templates.length === 0 && (
                  <p className="adm-empty" style={{ padding: '0 16px 16px' }}>
                    No templates found. Click "Seed Defaults" to create them.
                  </p>
                )}
                </>)}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
