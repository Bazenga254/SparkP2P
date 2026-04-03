import { useState, useEffect } from 'react';
import api from '../services/api';
import { getAdminDashboard, getAdminTraders, getDisputedOrders, getUnmatchedPayments, updateTraderStatus, updateTraderTier, getAdminTransactions, getAdminOrders, getAdminAnalytics, getAdminOnlineTraders, getMessageTemplates, updateMessageTemplate, seedMessageTemplates, getAdminSupportTickets, closeSupportTicket, replyToSupportTicket, getAdminWithdrawals, markWithdrawalComplete, markWithdrawalPending } from '../services/api';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { RefreshCw, LogOut, LayoutDashboard, Users, AlertTriangle, Banknote, TrendingUp, Settings, UserCheck, ShoppingCart, CheckCircle, Activity, AlertCircle, ArrowRightLeft, DollarSign, Wifi, Repeat, MessageSquare, Save, RotateCcw, ChevronDown, ChevronUp, Copy, Shield, Wallet } from 'lucide-react';

const sidebarSections = [
  {
    label: 'OVERVIEW',
    items: [
      { key: 'dashboard', icon: LayoutDashboard, label: 'Dashboard' },
      { key: 'transactions', icon: ArrowRightLeft, label: 'Transactions' },
      { key: 'withdrawals', icon: Wallet, label: 'Withdrawals' },
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
      { key: 'security', icon: Shield, label: 'Security' },
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
  const [resetPwLoading, setResetPwLoading] = useState(false);
  const [resetPwMsg, setResetPwMsg] = useState('');
  const [resolveRef, setResolveRef] = useState('');
  const [resolveAmount, setResolveAmount] = useState('');
  const [resolveLoading, setResolveLoading] = useState(false);
  const [resolveMsg, setResolveMsg] = useState({ text: '', type: '' });
  // Full-page trader detail view
  const [viewingTrader, setViewingTrader] = useState(null);
  const [viewingTraderWallet, setViewingTraderWallet] = useState(null);
  const [viewingTraderTx, setViewingTraderTx] = useState([]);
  const [viewingTraderOrders, setViewingTraderOrders] = useState([]);
  const [viewingTraderLoading, setViewingTraderLoading] = useState(false);
  const [showSecurityAnswer, setShowSecurityAnswer] = useState(false);
  const [txPage, setTxPage] = useState(1);
  const [ordersPage, setOrdersPage] = useState(1);
  const PAGE_SIZE = 15;
  const [disputes, setDisputes] = useState([]);
  const [unmatched, setUnmatched] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [onlineTraders, setOnlineTraders] = useState([]);
  const [transactions, setTransactions] = useState({ total: 0, transactions: [] });
  const [orders, setOrders] = useState({ total: 0, orders: [] });
  const [txPeriod, setTxPeriod] = useState('today');   // fiat period
  const [cryptoPeriod, setCryptoPeriod] = useState('all'); // crypto period — default all
  const [txType, setTxType] = useState('fiat'); // 'fiat' | 'crypto'
  const [ordersSearch, setOrdersSearch] = useState('');
  const [cryptoPage, setCryptoPage] = useState(1);
  const [fiatPage, setFiatPage] = useState(1);
  const [txLastUpdated, setTxLastUpdated] = useState(null);
  const [fiatLastUpdated, setFiatLastUpdated] = useState(null);
  const PAGE_TX_SIZE = 25;
  const [activeTab, setActiveTab] = useState('dashboard');
  const [refreshing, setRefreshing] = useState(false);
  const [auditLogs, setAuditLogs] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [editBody, setEditBody] = useState('');
  const [editSubject, setEditSubject] = useState('');
  const [templateSaving, setTemplateSaving] = useState(false);
  const [templateMsg, setTemplateMsg] = useState('');
  const [expandedTemplates, setExpandedTemplates] = useState({});
  const [supportTickets, setSupportTickets] = useState([]);
  const [supportLoading, setSupportLoading] = useState(false);
  const [expandedTicket, setExpandedTicket] = useState(null);
  const [ticketReplies, setTicketReplies] = useState({});
  const [ticketReplying, setTicketReplying] = useState({});
  const [unreadTicketCount, setUnreadTicketCount] = useState(0);
  const [ticketCategory, setTicketCategory] = useState('open'); // 'open' | 'closed'
  const [ticketPage, setTicketPage] = useState(1);
  const [ticketTotal, setTicketTotal] = useState(0);
  const [ticketPages, setTicketPages] = useState(1);
  const TICKET_PAGE_SIZE = 20;

  // Withdrawals
  const [withdrawals, setWithdrawals] = useState({ withdrawals: [], total: 0, pages: 1, summary: {} });
  const [wdMethod, setWdMethod] = useState('all');   // all | mpesa | bank_paybill
  const [wdStatus, setWdStatus] = useState('all');   // all | pending | completed
  const [wdPeriod, setWdPeriod] = useState('all');
  const [wdPage, setWdPage] = useState(1);
  const [wdLoading, setWdLoading] = useState(false);
  const [wdActionLoading, setWdActionLoading] = useState(null); // tx id being actioned

  const loadTemplates = async () => {
    try {
      const res = await getMessageTemplates();
      setTemplates(res.data);
    } catch (err) {
      console.error('Templates load error:', err);
    }
  };

  const loadSupportTickets = async (category = ticketCategory, page = ticketPage) => {
    setSupportLoading(true);
    try {
      const res = await getAdminSupportTickets({ category, page, page_size: 20 });
      setSupportTickets(res.data.tickets || []);
      setTicketTotal(res.data.total || 0);
      setTicketPages(res.data.pages || 1);
    } catch (err) {
      console.error('Support tickets load error:', err);
    }
    setSupportLoading(false);
  };

  const loadWithdrawals = async (method = wdMethod, status = wdStatus, period = wdPeriod, page = wdPage) => {
    setWdLoading(true);
    try {
      const res = await getAdminWithdrawals({ method, status, period, page, limit: 30 });
      setWithdrawals(res.data);
    } catch (err) {
      console.error('Withdrawals load error:', err);
    }
    setWdLoading(false);
  };

  const handleMarkComplete = async (txId) => {
    setWdActionLoading(txId);
    try {
      await markWithdrawalComplete(txId);
      loadWithdrawals();
    } catch (err) {
      console.error('Mark complete error:', err);
    }
    setWdActionLoading(null);
  };

  const handleMarkPending = async (txId) => {
    setWdActionLoading(txId);
    try {
      await markWithdrawalPending(txId);
      loadWithdrawals();
    } catch (err) {
      console.error('Mark pending error:', err);
    }
    setWdActionLoading(null);
  };

  const handleReplyTicket = async (ticketId) => {
    const msg = (ticketReplies[ticketId] || '').trim();
    if (!msg) return;
    setTicketReplying((p) => ({ ...p, [ticketId]: true }));
    try {
      const res = await replyToSupportTicket(ticketId, msg);
      setTicketReplies((p) => ({ ...p, [ticketId]: '' }));
      setSupportTickets((prev) => prev.map((t) =>
        t.id === ticketId ? { ...t, messages: res.data.messages } : t
      ));
    } catch (err) {
      console.error('Reply error:', err);
    }
    setTicketReplying((p) => ({ ...p, [ticketId]: false }));
  };

  const handleCloseTicket = async (ticketId) => {
    try {
      await closeSupportTicket(ticketId);
      loadSupportTickets();
    } catch (err) {
      console.error('Close ticket error:', err);
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

      // Fetch cached paybill balance
      try {
        const balRes = await api.get('/payment/balance');
        if (balRes.data?.updated_at) setPaybillBalance(balRes.data);
      } catch(e) {}
    } catch (err) {
      console.error('Admin load error:', err);
    }
    setRefreshing(false);
  };

  const [txnSearch, setTxnSearch] = useState('');

  const loadTransactions = async (period, search, resetPage = false) => {
    try {
      const res = await getAdminTransactions(period, 200, search);
      setTransactions(res.data);
      setFiatLastUpdated(new Date());
      if (resetPage) setFiatPage(1);
    } catch (err) {
      console.error('Transactions load error:', err);
    }
  };

  const loadOrders = async (period, search, resetPage = false) => {
    try {
      const res = await getAdminOrders(period, 200, search);
      setOrders(res.data);
      setTxLastUpdated(new Date());
      if (resetPage) setCryptoPage(1);
    } catch (err) {
      console.error('Orders load error:', err);
    }
  };

  useEffect(() => {
    if (activeTab === 'disputes') { setUnreadTicketCount(0); loadSupportTickets(ticketCategory, ticketPage); }
    if (activeTab === 'withdrawals') loadWithdrawals();
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === 'disputes') { setTicketPage(1); loadSupportTickets(ticketCategory, 1); }
  }, [ticketCategory]);

  // Poll open ticket count every 15s for badge; also refresh content when on disputes tab
  useEffect(() => {
    const pollTickets = async () => {
      try {
        const res = await getAdminSupportTickets({ category: 'open', page: 1, page_size: 20 });
        const data = res.data;
        if (activeTab === 'disputes' && ticketCategory === 'open') {
          setSupportTickets(data.tickets || []);
          setTicketTotal(data.total || 0);
          setTicketPages(data.pages || 1);
          setUnreadTicketCount(0);
        } else {
          setUnreadTicketCount(data.total || 0);
        }
      } catch (_) {}
    };
    pollTickets();
    const iv = setInterval(pollTickets, 15000);
    return () => clearInterval(iv);
  }, [activeTab, ticketCategory]);

  useEffect(() => {
    loadData();
    loadTransactions(txPeriod);
    loadOrders(cryptoPeriod);
    loadTemplates();
    const interval = setInterval(loadData, 30000);

    // Paybill balance: SSE for instant updates + trigger initial refresh
    api.post('/payment/balance/refresh').catch(() => {});
    const balanceES = new EventSource('/api/payment/balance/stream');
    balanceES.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data?.updated_at) setPaybillBalance(data);
      } catch {}
    };

    return () => { clearInterval(interval); balanceES.close(); };
  }, []);

  useEffect(() => { loadTransactions(txPeriod, '', true); }, [txPeriod]);
  useEffect(() => { loadOrders(cryptoPeriod, '', true); }, [cryptoPeriod]);

  // Real-time polling when on transactions tab
  useEffect(() => {
    if (activeTab !== 'transactions') return;
    const poll = setInterval(() => {
      if (txType === 'crypto') loadOrders(cryptoPeriod, ordersSearch);
      else loadTransactions(txPeriod, txnSearch);
    }, 10000);
    return () => clearInterval(poll);
  }, [activeTab, txType, cryptoPeriod, txPeriod]);

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

  const openTraderPage = async (trader) => {
    setViewingTrader({ ...trader });
    setViewingTraderWallet(null);
    setViewingTraderTx([]);
    setViewingTraderOrders([]);
    setViewingTraderLoading(true);
    setTxPage(1);
    setOrdersPage(1);
    setResetPwMsg('');
    setShowSecurityAnswer(false);
    setResolveRef(''); setResolveAmount(''); setResolveMsg({ text: '', type: '' });
    try {
      const [detailRes, walletRes, txRes, ordersRes] = await Promise.all([
        api.get(`/admin/traders/${trader.id}/detail`),
        api.get(`/admin/traders/${trader.id}/wallet`),
        api.get(`/admin/traders/${trader.id}/transactions?limit=60`),
        api.get(`/admin/traders/${trader.id}/orders?limit=60`),
      ]);
      setViewingTrader(prev => ({ ...prev, ...(detailRes.data || {}) }));
      setViewingTraderWallet(walletRes.data);
      setViewingTraderTx(txRes.data || []);
      setViewingTraderOrders(ordersRes.data || []);
    } catch (e) { console.error('Trader detail load error:', e); }
    setViewingTraderLoading(false);
  };

  const pageTitles = {
    dashboard: 'Dashboard',
    traders: 'All Traders',
    disputes: 'Disputes',
    unmatched: 'Unmatched Payments',
    transactions: 'Transactions',
    revenue: 'Revenue',
    security: 'Security',
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
                const badgeCount = item.key === 'disputes' ? unreadTicketCount : item.key === 'unmatched' ? unmatched.length : 0;
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
            <h1 className="adm-page-title">
              {activeTab === 'traders' && viewingTrader ? viewingTrader.full_name : (pageTitles[activeTab] || 'Dashboard')}
            </h1>
          </div>
          <div className="adm-topbar-right">
            {unreadTicketCount > 0 && (
              <button
                onClick={() => setActiveTab('disputes')}
                style={{
                  position: 'relative', background: 'rgba(245,158,11,0.12)',
                  border: '1px solid rgba(245,158,11,0.35)', borderRadius: 8,
                  padding: '5px 12px', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 7,
                  color: '#f59e0b', fontSize: 13, fontWeight: 600,
                  animation: 'pulse 2s ease-in-out infinite',
                }}
                title="View support tickets"
              >
                <MessageSquare size={15} />
                {unreadTicketCount} unread {unreadTicketCount === 1 ? 'ticket' : 'tickets'}
              </button>
            )}
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
                  try { await api.post('/payment/balance/refresh'); } catch(e) {}
                }}>
                  <div className="adm-stat-info">
                    <span className="adm-stat-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      Paybill Balance
                      {paybillBalance?.updated_at && <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981', display: 'inline-block', animation: 'pulse-green 1.5s ease-in-out infinite', boxShadow: '0 0 6px #10b981' }} />}
                    </span>
                    <span className="adm-stat-value">
                      {paybillBalance?.available != null ? fmtKES(paybillBalance.available) : '—'}
                    </span>
                    {paybillBalance?.updated_at && <span style={{ fontSize: 10, color: '#6b7280' }}>Updated: {new Date(paybillBalance.updated_at).toLocaleTimeString()} · {paybillBalance.source === 'realtime' ? 'live' : 'Safaricom'}</span>}
                    {!paybillBalance?.updated_at && <span style={{ fontSize: 10, color: '#6b7280' }}>Click to refresh</span>}
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <h3>All Transactions</h3>
                  {/* Type toggle */}
                  <div style={{ display: 'flex', gap: 4, background: 'var(--bg)', borderRadius: 8, padding: 4, border: '1px solid var(--border)' }}>
                    {[['fiat', 'Fiat (M-Pesa)'], ['crypto', 'Crypto (Binance)']].map(([key, label]) => (
                      <button key={key}
                        onClick={() => setTxType(key)}
                        style={{ padding: '5px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                          background: txType === key ? '#f59e0b' : 'transparent',
                          color: txType === key ? '#000' : '#9ca3af',
                        }}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Period filter — drives fiat or crypto depending on active type */}
                <div className="adm-period-filter">
                  {['today', 'week', 'month', 'year', 'all'].map((p) => {
                    const activePeriod = txType === 'fiat' ? txPeriod : cryptoPeriod;
                    const setter = txType === 'fiat' ? setTxPeriod : setCryptoPeriod;
                    return (
                      <button key={p} className={`adm-period-btn ${activePeriod === p ? 'active' : ''}`}
                        onClick={() => setter(p)}>
                        {p.charAt(0).toUpperCase() + p.slice(1)}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* ---- FIAT (M-Pesa Payments) ---- */}
              {txType === 'fiat' && (() => {
                const fiatTotal = transactions.transactions.length;
                const fiatTotalPages = Math.max(1, Math.ceil(fiatTotal / PAGE_TX_SIZE));
                const fiatSlice = transactions.transactions.slice((fiatPage - 1) * PAGE_TX_SIZE, fiatPage * PAGE_TX_SIZE);
                return (
                  <>
                    <div style={{ padding: '12px 0', display: 'flex', gap: 8 }}>
                      <input type="text" placeholder="Search by M-Pesa code, phone, name..."
                        value={txnSearch} onChange={(e) => setTxnSearch(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && loadTransactions(txPeriod, txnSearch, true)}
                        style={{ flex: 1, padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: '#fff', fontSize: 13 }}
                      />
                      <button onClick={() => loadTransactions(txPeriod, txnSearch, true)}
                        style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: '#f59e0b', color: '#000', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                        Search
                      </button>
                      {txnSearch && (
                        <button onClick={() => { setTxnSearch(''); loadTransactions(txPeriod, '', true); }}
                          style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: '#9ca3af', fontSize: 13, cursor: 'pointer' }}>
                          Clear
                        </button>
                      )}
                    </div>
                    <div style={{ padding: '0 0 10px', display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ fontSize: 12, color: '#6b7280' }}>{transactions.total} payment records</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#10b981' }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#10b981', display: 'inline-block', animation: 'pulse-green 1.5s ease-in-out infinite' }} />
                        Live · updates every 10s
                      </span>
                      {fiatLastUpdated && <span style={{ fontSize: 11, color: '#4b5563' }}>Last: {fiatLastUpdated.toLocaleTimeString()}</span>}
                    </div>
                    <div className="adm-table-wrap">
                      <table className="adm-table">
                        <thead>
                          <tr>
                            <th>ID</th><th>Direction</th><th>Type</th><th>Amount</th>
                            <th>Trader</th><th>Recipient/Sender</th><th>Phone</th>
                            <th>M-Pesa Code</th><th>Reference</th><th>Status</th><th>Time</th>
                          </tr>
                        </thead>
                        <tbody>
                          {fiatSlice.length === 0 ? (
                            <tr><td colSpan={11} className="adm-empty">No fiat transactions found</td></tr>
                          ) : fiatSlice.map((tx) => (
                            <tr key={tx.id}>
                              <td className="mono">{tx.id}</td>
                              <td><span className={`adm-badge ${tx.direction === 'inbound' ? 'green' : 'yellow'}`}>{tx.direction === 'inbound' ? 'IN' : 'OUT'}</span></td>
                              <td>{tx.transaction_type}</td>
                              <td style={{ fontWeight: 600, color: tx.direction === 'inbound' ? '#10b981' : '#f59e0b' }}>
                                {tx.direction === 'inbound' ? '+' : '-'}{fmtKES(tx.amount)}
                              </td>
                              <td>{tx.trader_name}</td>
                              <td>{tx.sender_name !== '-' ? tx.sender_name : tx.destination !== '-' ? tx.destination : '-'}</td>
                              <td className="mono">{(() => {
                                const p = tx.phone !== '-' ? tx.phone : tx.trader_phone;
                                if (p && p.length > 20) return tx.sender_name !== '-' ? tx.sender_name : 'Hidden';
                                return p || '-';
                              })()}</td>
                              <td className="mono" style={{ color: '#f59e0b' }}>{tx.mpesa_transaction_id}</td>
                              <td className="mono">{tx.bill_ref_number}</td>
                              <td><span className={`adm-badge ${tx.status === 'completed' ? 'green' : tx.status === 'failed' ? 'red' : 'dim'}`}>{tx.status}</span></td>
                              <td>{tx.created_at ? new Date(tx.created_at).toLocaleString() : '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {fiatTotalPages > 1 && (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderTop: '1px solid var(--border)' }}>
                        <button onClick={() => setFiatPage(p => Math.max(1, p - 1))} disabled={fiatPage === 1}
                          style={{ padding: '6px 16px', borderRadius: 6, border: '1px solid var(--border)', background: fiatPage === 1 ? 'transparent' : 'var(--bg)', color: fiatPage === 1 ? '#4b5563' : '#fff', cursor: fiatPage === 1 ? 'default' : 'pointer', fontSize: 13 }}>
                          ← Prev
                        </button>
                        <span style={{ fontSize: 13, color: '#6b7280' }}>Page {fiatPage} of {fiatTotalPages} · {fiatTotal} transactions loaded</span>
                        <button onClick={() => setFiatPage(p => Math.min(fiatTotalPages, p + 1))} disabled={fiatPage === fiatTotalPages}
                          style={{ padding: '6px 16px', borderRadius: 6, border: '1px solid var(--border)', background: fiatPage === fiatTotalPages ? 'transparent' : 'var(--bg)', color: fiatPage === fiatTotalPages ? '#4b5563' : '#fff', cursor: fiatPage === fiatTotalPages ? 'default' : 'pointer', fontSize: 13 }}>
                          Next →
                        </button>
                      </div>
                    )}
                  </>
                );
              })()}

              {/* ---- CRYPTO (Binance Orders) ---- */}
              {txType === 'crypto' && (() => {
                const totalPages = Math.max(1, Math.ceil(orders.orders.length / PAGE_TX_SIZE));
                const pageSlice = orders.orders.slice((cryptoPage - 1) * PAGE_TX_SIZE, cryptoPage * PAGE_TX_SIZE);
                return (
                  <>
                    <div style={{ padding: '12px 0', display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input type="text" placeholder="Search by order #, trader, counterparty..."
                        value={ordersSearch} onChange={(e) => setOrdersSearch(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && loadOrders(cryptoPeriod, ordersSearch, true)}
                        style={{ flex: 1, padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: '#fff', fontSize: 13 }}
                      />
                      <button onClick={() => loadOrders(cryptoPeriod, ordersSearch, true)}
                        style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: '#f59e0b', color: '#000', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                        Search
                      </button>
                      {ordersSearch && (
                        <button onClick={() => { setOrdersSearch(''); loadOrders(cryptoPeriod, '', true); }}
                          style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: '#9ca3af', fontSize: 13, cursor: 'pointer' }}>
                          Clear
                        </button>
                      )}
                    </div>
                    <div style={{ padding: '0 0 10px', display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ fontSize: 12, color: '#6b7280' }}>{orders.total} orders total</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#10b981' }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#10b981', display: 'inline-block', animation: 'pulse-green 1.5s ease-in-out infinite' }} />
                        Live · updates every 10s
                      </span>
                      {txLastUpdated && <span style={{ fontSize: 11, color: '#4b5563' }}>Last: {txLastUpdated.toLocaleTimeString()}</span>}
                    </div>
                    <div className="adm-table-wrap">
                      <table className="adm-table">
                        <thead>
                          <tr>
                            <th>Order #</th><th>Side</th><th>Trader</th><th>Crypto</th>
                            <th>Fiat Amount</th><th>Rate</th><th>Counterparty</th>
                            <th>Fee</th><th>Status</th><th>Time</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pageSlice.length === 0 ? (
                            <tr><td colSpan={10} className="adm-empty">No crypto orders found</td></tr>
                          ) : pageSlice.map((o) => (
                            <tr key={o.id}>
                              <td className="mono" style={{ fontSize: 11, color: '#f59e0b' }}>{o.binance_order_number || o.id}</td>
                              <td><span className={`adm-badge ${o.side === 'BUY' ? 'green' : 'red'}`}>{o.side}</span></td>
                              <td>{o.trader_name}</td>
                              <td style={{ fontWeight: 600 }}>{o.crypto_amount} {o.asset}</td>
                              <td style={{ fontWeight: 600, color: '#10b981' }}>{fmtKES(o.fiat_amount)}</td>
                              <td style={{ color: '#9ca3af', fontSize: 12 }}>{o.price ? `${o.price.toLocaleString()}/USDT` : '—'}</td>
                              <td>{o.counterparty}</td>
                              <td style={{ color: '#ef4444', fontSize: 12 }}>{o.platform_fee ? fmtKES(o.platform_fee) : '—'}</td>
                              <td><span className={`adm-badge ${o.status === 'completed' ? 'green' : o.status === 'disputed' ? 'red' : o.status === 'cancelled' ? 'dim' : 'yellow'}`}>{o.status}</span></td>
                              <td>{o.created_at ? new Date(o.created_at).toLocaleString() : '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {totalPages > 1 && (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderTop: '1px solid var(--border)' }}>
                        <button onClick={() => setCryptoPage(p => Math.max(1, p - 1))} disabled={cryptoPage === 1}
                          style={{ padding: '6px 16px', borderRadius: 6, border: '1px solid var(--border)', background: cryptoPage === 1 ? 'transparent' : 'var(--bg)', color: cryptoPage === 1 ? '#4b5563' : '#fff', cursor: cryptoPage === 1 ? 'default' : 'pointer', fontSize: 13 }}>
                          ← Prev
                        </button>
                        <span style={{ fontSize: 13, color: '#6b7280' }}>Page {cryptoPage} of {totalPages} · {orders.orders.length} orders loaded</span>
                        <button onClick={() => setCryptoPage(p => Math.min(totalPages, p + 1))} disabled={cryptoPage === totalPages}
                          style={{ padding: '6px 16px', borderRadius: 6, border: '1px solid var(--border)', background: cryptoPage === totalPages ? 'transparent' : 'var(--bg)', color: cryptoPage === totalPages ? '#4b5563' : '#fff', cursor: cryptoPage === totalPages ? 'default' : 'pointer', fontSize: 13 }}>
                          Next →
                        </button>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          )}

          {/* ==================== TRADERS ==================== */}
          {activeTab === 'traders' && !viewingTrader && (
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
                        <td><button style={{ background: 'none', border: 'none', color: '#f59e0b', cursor: 'pointer', fontWeight: 600, textDecoration: 'underline', padding: 0 }} onClick={() => openTraderPage(t)}>{t.full_name}</button></td>
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
            </div>
          )}

          {/* ==================== TRADER DETAIL PAGE ==================== */}
          {activeTab === 'traders' && viewingTrader && (() => {
            const t = viewingTrader;
            const w = viewingTraderWallet;
            const initials = (t.full_name || '?').split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase();
            const statusColor = t.status === 'active' ? '#10b981' : t.status === 'suspended' ? '#ef4444' : '#f59e0b';
            const tierColor = t.tier === 'pro' ? '#8b5cf6' : t.tier === 'starter' ? '#3b82f6' : '#6b7280';

            return (
              <div>
                {/* Back bar */}
                <div style={{ marginBottom: 16 }}>
                  <button
                    onClick={() => setViewingTrader(null)}
                    style={{ background: 'none', border: '1px solid var(--border)', color: '#9ca3af', padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}
                  >
                    ← All Traders
                  </button>
                </div>

                {viewingTraderLoading && (
                  <div style={{ textAlign: 'center', color: '#6b7280', padding: 40 }}>Loading trader details...</div>
                )}

                {!viewingTraderLoading && (
                  <>
                    {/* Hero card */}
                    <div className="adm-card" style={{ marginBottom: 16 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap', padding: '20px 24px' }}>
                        {/* Avatar */}
                        <div style={{ width: 72, height: 72, borderRadius: '50%', background: 'linear-gradient(135deg, #f59e0b, #ef4444)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
                          {initials}
                        </div>
                        {/* Name + badges */}
                        <div style={{ flex: 1, minWidth: 200 }}>
                          <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>{t.full_name}</div>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600, background: `${statusColor}22`, color: statusColor, border: `1px solid ${statusColor}44` }}>{t.status}</span>
                            <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600, background: `${tierColor}22`, color: tierColor, border: `1px solid ${tierColor}44` }}>{t.tier === 'standard' ? 'Free' : t.tier}</span>
                            <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600, background: 'rgba(156,163,175,0.15)', color: '#9ca3af', border: '1px solid rgba(156,163,175,0.3)' }}>{t.role || 'trader'}</span>
                            {t.binance_connected && <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600, background: 'rgba(245,158,11,0.15)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.3)' }}>Binance ✓</span>}
                          </div>
                        </div>
                        {/* Quick actions */}
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <label style={{ fontSize: 11, color: '#6b7280' }}>Status</label>
                            <select className="adm-select" value={t.status} onChange={async (e) => { await handleStatusChange(t.id, e.target.value); setViewingTrader(prev => ({ ...prev, status: e.target.value })); }}>
                              <option value="pending">Pending</option>
                              <option value="active">Active</option>
                              <option value="paused">Paused</option>
                              <option value="suspended">Suspended</option>
                            </select>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <label style={{ fontSize: 11, color: '#6b7280' }}>Tier</label>
                            <select className="adm-select" value={t.tier} onChange={async (e) => { await handleTierChange(t.id, e.target.value); setViewingTrader(prev => ({ ...prev, tier: e.target.value })); }}>
                              <option value="standard">Free</option>
                              <option value="starter">Starter</option>
                              <option value="pro">Pro</option>
                            </select>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <label style={{ fontSize: 11, color: '#6b7280' }}>Role</label>
                            <select className="adm-select" value={t.role || 'trader'} onChange={async (e) => { await handleRoleChange(t.id, e.target.value); setViewingTrader(prev => ({ ...prev, role: e.target.value })); }}>
                              <option value="trader">Trader</option>
                              <option value="employee">Employee</option>
                              <option value="admin">Admin</option>
                            </select>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Info + Wallet row */}
                    <div className="adm-two-col" style={{ marginBottom: 16, alignItems: 'flex-start' }}>
                      {/* Trader info grid */}
                      <div className="adm-card" style={{ flex: '1 1 0' }}>
                        <div className="adm-card-header"><h3>Account Info</h3></div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px 24px', fontSize: 13, padding: '16px 20px 20px' }}>
                          {[
                            ['Email', t.email],
                            ['Phone', t.phone],
                            ['Trades', t.total_trades ?? '—'],
                            ['Volume', fmtKES(t.total_volume)],
                            ['Joined', t.created_at ? new Date(t.created_at).toLocaleDateString() : '—'],
                            ['Last Login', t.last_login ? new Date(t.last_login).toLocaleString() : '—'],
                            ['Security Q', t.security_question || '—'],
                            ['Settlement', t.settlement_method || '—'],
                            ['Destination', t.settlement_destination || '—'],
                          ].map(([label, value]) => (
                            <div key={label}>
                              <div style={{ color: '#6b7280', fontSize: 11, marginBottom: 2 }}>{label}</div>
                              <div style={{ fontWeight: 600, wordBreak: 'break-all' }}>{value}</div>
                            </div>
                          ))}
                          <div>
                            <div style={{ color: '#6b7280', fontSize: 11, marginBottom: 2 }}>Answer</div>
                            <div style={{ fontWeight: 600, wordBreak: 'break-all', display: 'flex', alignItems: 'center', gap: 8 }}>
                              {showSecurityAnswer ? (t.security_answer || '—') : '••••••••'}
                              <button
                                onClick={() => setShowSecurityAnswer(v => !v)}
                                style={{ background: 'none', border: 'none', color: '#f59e0b', cursor: 'pointer', fontSize: 11, padding: '1px 6px', borderRadius: 4, border: '1px solid #f59e0b' }}
                              >
                                {showSecurityAnswer ? 'Hide' : 'Show'}
                              </button>
                            </div>
                          </div>
                          {t.google_id && (
                            <div style={{ gridColumn: '1 / -1' }}>
                              <div style={{ color: '#6b7280', fontSize: 11, marginBottom: 2 }}>Google ID</div>
                              <div style={{ fontWeight: 600, fontSize: 12, wordBreak: 'break-all' }}>{t.google_id}</div>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Wallet stats */}
                      <div className="adm-card" style={{ flex: '1 1 0' }}>
                        <div className="adm-card-header"><h3>Wallet</h3></div>
                        <div style={{ padding: '16px 20px 0' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                          {[
                            ['Balance', w?.balance, '#10b981'],
                            ['Reserved', w?.reserved, '#f59e0b'],
                            ['Total Earned', w?.total_earned, '#3b82f6'],
                            ['Withdrawn', w?.total_withdrawn, '#8b5cf6'],
                          ].map(([label, val, color]) => (
                            <div key={label} style={{ background: 'var(--bg)', borderRadius: 8, padding: '12px 16px', border: '1px solid var(--border)' }}>
                              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>{label}</div>
                              <div style={{ fontSize: 18, fontWeight: 700, color: color || '#fff' }}>{w ? fmtKES(val ?? 0) : '—'}</div>
                            </div>
                          ))}
                        </div>
                        </div>

                        {/* Reset Password */}
                        <div style={{ margin: '16px 20px 20px' }}>
                          <button
                            style={{ width: '100%', padding: '10px', borderRadius: 8, border: '1px solid #ef4444', background: 'rgba(239,68,68,0.1)', color: '#ef4444', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}
                            disabled={resetPwLoading}
                            onClick={async () => {
                              setResetPwLoading(true);
                              try {
                                await api.post(`/admin/traders/${t.id}/reset-password`);
                                setResetPwMsg('Password reset! New password sent via SMS.');
                              } catch (e) { setResetPwMsg('Failed to reset password.'); }
                              setResetPwLoading(false);
                            }}
                          >
                            {resetPwLoading ? 'Resetting...' : 'Reset Password'}
                          </button>
                          {resetPwMsg && <div style={{ marginTop: 6, fontSize: 12, color: resetPwMsg.includes('Failed') ? '#ef4444' : '#10b981', textAlign: 'center' }}>{resetPwMsg}</div>}
                        </div>
                      </div>
                    </div>

                    {/* Resolve Payment */}
                    <div className="adm-card" style={{ marginBottom: 16, border: '1px solid rgba(245,158,11,0.3)' }}>
                      <div className="adm-card-header">
                        <h3 style={{ color: '#f59e0b' }}>Resolve Unmatched Payment</h3>
                      </div>
                      <div style={{ padding: '4px 20px 20px' }}>
                      <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 14 }}>
                        Enter the M-Pesa reference and amount to verify with Safaricom and credit this trader's wallet.
                      </p>
                      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
                        <input
                          value={resolveRef}
                          onChange={e => setResolveRef(e.target.value.toUpperCase())}
                          placeholder="M-Pesa Ref e.g. QK12AB3CD4"
                          style={{ flex: '2 1 180px', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 13 }}
                        />
                        <input
                          value={resolveAmount}
                          onChange={e => setResolveAmount(e.target.value)}
                          placeholder="Amount (KES)"
                          type="number"
                          style={{ flex: '1 1 120px', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 13 }}
                        />
                        <button
                          disabled={resolveLoading || !resolveRef || !resolveAmount}
                          style={{ flex: '1 1 140px', padding: '10px 16px', borderRadius: 8, border: 'none', background: resolveLoading ? '#374151' : '#f59e0b', color: '#000', fontWeight: 700, fontSize: 13, cursor: resolveLoading ? 'default' : 'pointer', whiteSpace: 'nowrap' }}
                          onClick={async () => {
                            setResolveLoading(true);
                            setResolveMsg({ text: '', type: '' });
                            try {
                              await api.post(`/admin/traders/${t.id}/resolve-payment`, {
                                mpesa_ref: resolveRef,
                                amount: parseFloat(resolveAmount),
                              });
                              setResolveMsg({ text: 'Verifying with Safaricom...', type: 'info' });
                              let attempts = 0;
                              const poll = setInterval(async () => {
                                attempts++;
                                try {
                                  const r = await api.get(`/admin/traders/${t.id}/resolve-payment/status?mpesa_ref=${resolveRef}`);
                                  const { status, message } = r.data;
                                  if (status === 'credited') {
                                    setResolveMsg({ text: message, type: 'success' });
                                    setResolveRef(''); setResolveAmount('');
                                    clearInterval(poll);
                                    // Refresh wallet
                                    api.get(`/admin/traders/${t.id}/wallet`).then(r => setViewingTraderWallet(r.data)).catch(() => {});
                                  } else if (status === 'failed') {
                                    setResolveMsg({ text: message, type: 'error' });
                                    clearInterval(poll);
                                  } else if (attempts >= 10) {
                                    setResolveMsg({ text: 'Safaricom took too long to respond. Try again.', type: 'error' });
                                    clearInterval(poll);
                                  }
                                } catch (e) { clearInterval(poll); }
                              }, 3000);
                            } catch (e) {
                              setResolveMsg({ text: e.response?.data?.detail || 'Failed to start verification.', type: 'error' });
                            }
                            setResolveLoading(false);
                          }}
                        >
                          {resolveLoading ? 'Submitting...' : 'Verify & Credit Wallet'}
                        </button>
                      </div>
                      {resolveMsg.text && (
                        <div style={{ fontSize: 13, padding: '8px 12px', borderRadius: 8, marginTop: 4,
                          color: resolveMsg.type === 'success' ? '#10b981' : resolveMsg.type === 'error' ? '#ef4444' : '#f59e0b',
                          background: resolveMsg.type === 'success' ? 'rgba(16,185,129,0.1)' : resolveMsg.type === 'error' ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.1)',
                        }}>
                          {resolveMsg.text}
                        </div>
                      )}
                      </div>{/* end padding wrapper */}
                    </div>{/* end resolve card */}

                    {/* Recent Transactions */}
                    {(() => {
                      const txTotalPages = Math.ceil(viewingTraderTx.length / PAGE_SIZE);
                      const txSlice = viewingTraderTx.slice((txPage - 1) * PAGE_SIZE, txPage * PAGE_SIZE);
                      return (
                        <div className="adm-card" style={{ marginBottom: 16 }}>
                          <div className="adm-card-header">
                            <h3>Recent Transactions</h3>
                            <span className="adm-card-count">{viewingTraderTx.length} total</span>
                          </div>
                          <div className="adm-table-wrap">
                            <table className="adm-table">
                              <thead>
                                <tr>
                                  <th>Type</th>
                                  <th>Direction</th>
                                  <th>Amount</th>
                                  <th>Balance After</th>
                                  <th>M-Pesa Code</th>
                                  <th>Description</th>
                                  <th>Status</th>
                                  <th>Time</th>
                                </tr>
                              </thead>
                              <tbody>
                                {txSlice.length === 0 ? (
                                  <tr><td colSpan={8} style={{ textAlign: 'center', color: '#6b7280', padding: 24 }}>No transactions</td></tr>
                                ) : txSlice.map((tx) => (
                                  <tr key={tx.id}>
                                    <td style={{ textTransform: 'capitalize' }}>{(tx.transaction_type || '').replace(/_/g, ' ')}</td>
                                    <td><span className={`adm-badge ${tx.direction === 'inbound' ? 'green' : 'yellow'}`}>{tx.direction === 'inbound' ? 'IN' : 'OUT'}</span></td>
                                    <td style={{ fontWeight: 600, color: tx.direction === 'inbound' ? '#10b981' : '#f59e0b' }}>{tx.direction === 'inbound' ? '+' : '-'}{fmtKES(tx.amount)}</td>
                                    <td style={{ color: '#9ca3af' }}>{fmtKES(tx.balance_after)}</td>
                                    <td className="mono" style={{ color: '#f59e0b', fontSize: 11 }}>{tx.mpesa_transaction_id || '—'}</td>
                                    <td style={{ fontSize: 12, color: '#9ca3af', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tx.description || '—'}</td>
                                    <td><span className={`adm-badge ${tx.status === 'completed' ? 'green' : tx.status === 'failed' ? 'red' : 'dim'}`}>{tx.status}</span></td>
                                    <td>{tx.created_at ? new Date(tx.created_at).toLocaleString() : '—'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          {txTotalPages > 1 && (
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderTop: '1px solid var(--border)' }}>
                              <button onClick={() => setTxPage(p => Math.max(1, p - 1))} disabled={txPage === 1}
                                style={{ padding: '6px 16px', borderRadius: 6, border: '1px solid var(--border)', background: txPage === 1 ? 'transparent' : 'var(--bg)', color: txPage === 1 ? '#4b5563' : '#fff', cursor: txPage === 1 ? 'default' : 'pointer', fontSize: 13 }}>
                                ← Prev
                              </button>
                              <span style={{ fontSize: 13, color: '#6b7280' }}>Page {txPage} of {txTotalPages} · {viewingTraderTx.length} transactions</span>
                              <button onClick={() => setTxPage(p => Math.min(txTotalPages, p + 1))} disabled={txPage === txTotalPages}
                                style={{ padding: '6px 16px', borderRadius: 6, border: '1px solid var(--border)', background: txPage === txTotalPages ? 'transparent' : 'var(--bg)', color: txPage === txTotalPages ? '#4b5563' : '#fff', cursor: txPage === txTotalPages ? 'default' : 'pointer', fontSize: 13 }}>
                                Next →
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* Recent Orders */}
                    {(() => {
                      const ordTotalPages = Math.ceil(viewingTraderOrders.length / PAGE_SIZE);
                      const ordSlice = viewingTraderOrders.slice((ordersPage - 1) * PAGE_SIZE, ordersPage * PAGE_SIZE);
                      return (
                        <div className="adm-card">
                          <div className="adm-card-header">
                            <h3>Recent Orders</h3>
                            <span className="adm-card-count">{viewingTraderOrders.length} total</span>
                          </div>
                          <div className="adm-table-wrap">
                            <table className="adm-table">
                              <thead>
                                <tr>
                                  <th>Order #</th>
                                  <th>Side</th>
                                  <th>Crypto</th>
                                  <th>Fiat Amount</th>
                                  <th>Rate</th>
                                  <th>Counterparty</th>
                                  <th>Status</th>
                                  <th>Created</th>
                                </tr>
                              </thead>
                              <tbody>
                                {ordSlice.length === 0 ? (
                                  <tr><td colSpan={8} style={{ textAlign: 'center', color: '#6b7280', padding: 24 }}>No orders</td></tr>
                                ) : ordSlice.map((o) => (
                                  <tr key={o.id}>
                                    <td className="mono" style={{ fontSize: 11 }}>{o.binance_order_number || o.id}</td>
                                    <td><span className={`adm-badge ${o.side === 'BUY' ? 'green' : 'red'}`}>{o.side}</span></td>
                                    <td style={{ fontWeight: 600 }}>{o.crypto_amount} {o.asset || 'USDT'}</td>
                                    <td style={{ fontWeight: 600, color: '#10b981' }}>{fmtKES(o.fiat_amount)}</td>
                                    <td style={{ color: '#9ca3af', fontSize: 12 }}>{o.price ? `${(o.price).toLocaleString()}/USDT` : '—'}</td>
                                    <td style={{ fontSize: 12 }}>{o.counterparty || '—'}</td>
                                    <td><span className={`adm-badge ${o.status === 'completed' ? 'green' : o.status === 'disputed' ? 'red' : o.status === 'cancelled' ? 'dim' : 'yellow'}`}>{o.status}</span></td>
                                    <td>{o.created_at ? new Date(o.created_at).toLocaleString() : '—'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          {ordTotalPages > 1 && (
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderTop: '1px solid var(--border)' }}>
                              <button onClick={() => setOrdersPage(p => Math.max(1, p - 1))} disabled={ordersPage === 1}
                                style={{ padding: '6px 16px', borderRadius: 6, border: '1px solid var(--border)', background: ordersPage === 1 ? 'transparent' : 'var(--bg)', color: ordersPage === 1 ? '#4b5563' : '#fff', cursor: ordersPage === 1 ? 'default' : 'pointer', fontSize: 13 }}>
                                ← Prev
                              </button>
                              <span style={{ fontSize: 13, color: '#6b7280' }}>Page {ordersPage} of {ordTotalPages} · {viewingTraderOrders.length} orders</span>
                              <button onClick={() => setOrdersPage(p => Math.min(ordTotalPages, p + 1))} disabled={ordersPage === ordTotalPages}
                                style={{ padding: '6px 16px', borderRadius: 6, border: '1px solid var(--border)', background: ordersPage === ordTotalPages ? 'transparent' : 'var(--bg)', color: ordersPage === ordTotalPages ? '#4b5563' : '#fff', cursor: ordersPage === ordTotalPages ? 'default' : 'pointer', fontSize: 13 }}>
                                Next →
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </>
                )}
              </div>
            );
          })()}

          {/* ==================== DISPUTES ==================== */}
          {activeTab === 'disputes' && (
            <>
              {/* Order Disputes */}
              <div className="adm-card" style={{ marginBottom: 16 }}>
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

              {/* Support Tickets */}
              <div className="adm-card">
                <div className="adm-card-header">
                  <h3>Support Tickets</h3>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span className="adm-card-count">{ticketTotal} {ticketCategory}</span>
                    <button className="adm-btn-sm" onClick={() => loadSupportTickets(ticketCategory, ticketPage)} disabled={supportLoading} style={{ fontSize: 12, padding: '4px 10px' }}>
                      {supportLoading ? 'Loading…' : 'Refresh'}
                    </button>
                  </div>
                </div>

                {/* Category tabs */}
                <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)', marginBottom: 12 }}>
                  {['open', 'closed'].map((cat) => (
                    <button key={cat} onClick={() => setTicketCategory(cat)}
                      style={{
                        padding: '8px 20px', background: 'none', border: 'none',
                        borderBottom: ticketCategory === cat ? '2px solid #6366f1' : '2px solid transparent',
                        color: ticketCategory === cat ? '#a5b4fc' : 'var(--text-secondary)',
                        fontWeight: ticketCategory === cat ? 600 : 400,
                        fontSize: 13, cursor: 'pointer', textTransform: 'capitalize',
                      }}
                    >
                      {cat === 'open' ? `Open Tickets${unreadTicketCount > 0 && ticketCategory !== 'open' ? ` (${unreadTicketCount})` : ''}` : 'Closed Tickets'}
                    </button>
                  ))}
                </div>

                {supportTickets.length === 0 && !supportLoading ? (
                  <p className="adm-empty">No {ticketCategory} tickets.</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0' }}>
                    {supportTickets.map((ticket) => (
                      <div
                        key={ticket.id}
                        style={{
                          border: '1px solid var(--border)',
                          borderRadius: 10,
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            padding: '10px 14px',
                            cursor: 'pointer',
                            background: expandedTicket === ticket.id ? 'var(--bg)' : 'transparent',
                          }}
                          onClick={() => setExpandedTicket(expandedTicket === ticket.id ? null : ticket.id)}
                        >
                          <span
                            style={{
                              width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                              background: ticket.status === 'escalated' ? '#f59e0b' : ticket.status === 'open' ? '#10b981' : '#6b7280',
                            }}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>
                              #{ticket.id} — {ticket.subject || 'No subject'}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                              Trader #{ticket.trader_id} · {new Date(ticket.updated_at).toLocaleString()}
                              {ticket.escalation_reason && (
                                <span style={{ color: '#f59e0b', marginLeft: 6 }}>
                                  ⚡ {ticket.escalation_reason}
                                </span>
                              )}
                            </div>
                          </div>
                          <span className={`adm-badge ${ticket.status === 'escalated' ? 'yellow' : ticket.status === 'open' ? 'green' : 'dim'}`}>
                            {ticket.status}
                          </span>
                          {ticket.status === 'escalated' && (
                            <button
                              className="adm-btn-sm"
                              onClick={(e) => { e.stopPropagation(); handleCloseTicket(ticket.id); }}
                              style={{ fontSize: 11, padding: '3px 8px', background: 'rgba(16,185,129,0.15)', color: '#10b981', border: '1px solid rgba(16,185,129,0.3)' }}
                            >
                              Close
                            </button>
                          )}
                        </div>
                        {expandedTicket === ticket.id && (
                          <div style={{ borderTop: '1px solid var(--border)', padding: '12px 14px', background: 'var(--bg)' }}>
                            {(ticket.messages || []).length === 0 ? (
                              <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>No messages.</p>
                            ) : (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
                                {ticket.messages.map((m, i) => (
                                  <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                                    <div style={{
                                      maxWidth: '75%',
                                      padding: '7px 11px',
                                      borderRadius: m.role === 'user' ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
                                      background: m.role === 'user' ? 'rgba(99,102,241,0.15)' : m.role === 'admin' ? 'rgba(16,185,129,0.12)' : 'var(--card)',
                                      border: '1px solid var(--border)',
                                      fontSize: 12,
                                      lineHeight: 1.5,
                                      color: 'var(--text)',
                                      whiteSpace: 'pre-wrap',
                                      wordBreak: 'break-word',
                                    }}>
                                      <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 3 }}>
                                        {m.role === 'user' ? 'Trader' : m.role === 'admin' ? 'Admin' : 'AI Support'} · {m.ts ? new Date(m.ts).toLocaleTimeString() : ''}
                                      </div>
                                      {m.content}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                            {/* Reply box */}
                            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                              <textarea
                                value={ticketReplies[ticket.id] || ''}
                                onChange={(e) => setTicketReplies((p) => ({ ...p, [ticket.id]: e.target.value }))}
                                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleReplyTicket(ticket.id); } }}
                                placeholder="Type a reply to the trader…"
                                rows={2}
                                style={{
                                  flex: 1, resize: 'none', padding: '7px 10px', borderRadius: 8,
                                  border: '1px solid var(--border)', background: 'var(--card)',
                                  color: 'var(--text)', fontSize: 12, fontFamily: 'inherit', outline: 'none',
                                }}
                              />
                              <button
                                onClick={() => handleReplyTicket(ticket.id)}
                                disabled={ticketReplying[ticket.id] || !(ticketReplies[ticket.id] || '').trim()}
                                className="adm-btn-sm"
                                style={{ padding: '8px 14px', background: 'rgba(99,102,241,0.2)', color: '#a5b4fc', border: '1px solid rgba(99,102,241,0.4)', whiteSpace: 'nowrap' }}
                              >
                                {ticketReplying[ticket.id] ? 'Sending…' : 'Send Reply'}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Pagination */}
                {ticketPages > 1 && (
                  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, paddingTop: 14, borderTop: '1px solid var(--border)', marginTop: 8 }}>
                    <button className="adm-btn-sm" disabled={ticketPage <= 1} onClick={() => { const p = ticketPage - 1; setTicketPage(p); loadSupportTickets(ticketCategory, p); }}>← Prev</button>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Page {ticketPage} of {ticketPages} · {ticketTotal} tickets</span>
                    <button className="adm-btn-sm" disabled={ticketPage >= ticketPages} onClick={() => { const p = ticketPage + 1; setTicketPage(p); loadSupportTickets(ticketCategory, p); }}>Next →</button>
                  </div>
                )}
              </div>
            </>
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
                          <td>{p.phone && p.phone.length > 20 ? (p.sender_name || 'Hidden') : (p.phone || '-')}</td>
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

          {/* ==================== WITHDRAWALS ==================== */}
          {activeTab === 'withdrawals' && (
            <div className="adm-card">
              {/* ── Header: title + method toggle + period filter ── */}
              <div className="adm-card-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <h3>Withdrawals</h3>
                  {/* Method toggle */}
                  <div style={{ display: 'flex', gap: 4, background: 'var(--bg)', borderRadius: 8, padding: 4, border: '1px solid var(--border)' }}>
                    {[['all','All'], ['mpesa','M-Pesa'], ['bank_paybill','I&M Bank']].map(([val, label]) => (
                      <button key={val} onClick={() => { setWdMethod(val); setWdPage(1); loadWithdrawals(val, wdStatus, wdPeriod, 1); }}
                        style={{ padding: '5px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                          background: wdMethod === val ? '#f59e0b' : 'transparent',
                          color: wdMethod === val ? '#000' : '#9ca3af',
                        }}>
                        {label}
                      </button>
                    ))}
                  </div>
                  {/* Status toggle */}
                  <div style={{ display: 'flex', gap: 4, background: 'var(--bg)', borderRadius: 8, padding: 4, border: '1px solid var(--border)' }}>
                    {[['all','All Status'], ['pending','Pending'], ['completed','Completed']].map(([val, label]) => (
                      <button key={val} onClick={() => { setWdStatus(val); setWdPage(1); loadWithdrawals(wdMethod, val, wdPeriod, 1); }}
                        style={{ padding: '5px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                          background: wdStatus === val ? (val === 'pending' ? '#f59e0b' : val === 'completed' ? '#10b981' : '#f59e0b') : 'transparent',
                          color: wdStatus === val ? '#000' : '#9ca3af',
                        }}>
                        {val === 'pending' && (withdrawals.summary?.pending_count > 0) ? `Pending (${withdrawals.summary.pending_count})` : label}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Period filter */}
                <div className="adm-period-filter">
                  {[['today','Today'], ['week','Week'], ['month','Month'], ['all','All']].map(([val, label]) => (
                    <button key={val} className={`adm-period-btn ${wdPeriod === val ? 'active' : ''}`}
                      onClick={() => { setWdPeriod(val); setWdPage(1); loadWithdrawals(wdMethod, wdStatus, val, 1); }}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* ── Stats bar ── */}
              <div style={{ padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 24, borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: '#6b7280' }}>{withdrawals.summary?.total_count ?? 0} total withdrawals</span>
                <span style={{ fontSize: 12, color: '#10b981' }}>KES {(withdrawals.summary?.total_amount ?? 0).toLocaleString()} disbursed</span>
                {(withdrawals.summary?.pending_count ?? 0) > 0 && (
                  <span style={{ fontSize: 12, color: '#f59e0b', fontWeight: 600 }}>
                    ⚠ {withdrawals.summary.pending_count} I&amp;M pending · KES {withdrawals.summary.pending_amount.toLocaleString()} needs transfer
                  </span>
                )}
              </div>

              {/* ── Table ── */}
              <div className="adm-table-wrap">
                <table className="adm-table">
                  <thead>
                    <tr>
                      <th>Trader</th>
                      <th>Method</th>
                      <th>Destination</th>
                      <th>Amount (Net)</th>
                      <th>Status</th>
                      <th>Requested</th>
                      <th>Processed By</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wdLoading ? (
                      <tr><td colSpan={8} className="adm-empty">Loading...</td></tr>
                    ) : withdrawals.withdrawals.length === 0 ? (
                      <tr><td colSpan={8} className="adm-empty">No withdrawals found</td></tr>
                    ) : withdrawals.withdrawals.map((wd) => (
                      <tr key={wd.id}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{wd.trader_name}</div>
                          <div style={{ fontSize: 11, color: '#6b7280' }}>{wd.trader_phone}</div>
                        </td>
                        <td>
                          <span className={`adm-badge ${wd.settlement_method === 'mpesa' ? 'green' : 'blue'}`}>
                            {wd.settlement_method === 'mpesa' ? 'M-Pesa' : 'I&M Bank'}
                          </span>
                        </td>
                        <td>
                          <div className="mono" style={{ fontSize: 13 }}>{wd.destination}</div>
                          {wd.bank_name && <div style={{ fontSize: 11, color: '#6b7280' }}>{wd.bank_name}</div>}
                        </td>
                        <td style={{ fontWeight: 700, color: '#10b981' }}>
                          {fmtKES(wd.amount)}
                        </td>
                        <td>
                          <span className={`adm-badge ${wd.status === 'completed' ? 'green' : wd.status === 'failed' ? 'red' : 'yellow'}`}>
                            {wd.status === 'completed' ? 'Completed' : wd.status === 'failed' ? 'Failed' : 'Pending'}
                          </span>
                        </td>
                        <td style={{ fontSize: 12, color: '#9ca3af' }}>
                          {wd.created_at ? new Date(wd.created_at).toLocaleString() : '—'}
                        </td>
                        <td style={{ fontSize: 12 }}>
                          {wd.processed_by ? (
                            <>
                              <div style={{ fontWeight: 500 }}>{wd.processed_by}</div>
                              <div style={{ color: '#6b7280', fontSize: 11 }}>
                                {wd.processed_at ? new Date(wd.processed_at).toLocaleString() : ''}
                              </div>
                            </>
                          ) : <span style={{ color: '#4b5563' }}>—</span>}
                        </td>
                        <td>
                          {wd.status === 'pending' ? (
                            <button disabled={wdActionLoading === wd.id} onClick={() => handleMarkComplete(wd.id)}
                              style={{ padding: '5px 14px', borderRadius: 6, border: 'none', background: '#10b981', color: '#000', fontWeight: 600, fontSize: 12, cursor: 'pointer', opacity: wdActionLoading === wd.id ? 0.6 : 1 }}>
                              {wdActionLoading === wd.id ? '...' : '✓ Mark Complete'}
                            </button>
                          ) : wd.status === 'completed' && wd.settlement_method !== 'mpesa' ? (
                            <button disabled={wdActionLoading === wd.id} onClick={() => handleMarkPending(wd.id)}
                              style={{ padding: '5px 14px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: '#9ca3af', fontSize: 12, cursor: 'pointer' }}>
                              {wdActionLoading === wd.id ? '...' : '↩ Revert'}
                            </button>
                          ) : (
                            <span style={{ fontSize: 12, color: '#4b5563' }}>Auto</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* ── Pagination ── */}
              {withdrawals.pages > 1 && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderTop: '1px solid var(--border)' }}>
                  <button onClick={() => { setWdPage(p => p - 1); loadWithdrawals(wdMethod, wdStatus, wdPeriod, wdPage - 1); }} disabled={wdPage <= 1}
                    style={{ padding: '6px 16px', borderRadius: 6, border: '1px solid var(--border)', background: wdPage <= 1 ? 'transparent' : 'var(--bg)', color: wdPage <= 1 ? '#4b5563' : '#fff', cursor: wdPage <= 1 ? 'default' : 'pointer', fontSize: 13 }}>
                    ← Prev
                  </button>
                  <span style={{ fontSize: 13, color: '#6b7280' }}>Page {wdPage} of {withdrawals.pages} · {withdrawals.total} withdrawals</span>
                  <button onClick={() => { setWdPage(p => p + 1); loadWithdrawals(wdMethod, wdStatus, wdPeriod, wdPage + 1); }} disabled={wdPage >= withdrawals.pages}
                    style={{ padding: '6px 16px', borderRadius: 6, border: '1px solid var(--border)', background: wdPage >= withdrawals.pages ? 'transparent' : 'var(--bg)', color: wdPage >= withdrawals.pages ? '#4b5563' : '#fff', cursor: wdPage >= withdrawals.pages ? 'default' : 'pointer', fontSize: 13 }}>
                    Next →
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ==================== SECURITY ==================== */}
          {activeTab === 'security' && (() => {
            // Fetch audit logs when tab opens
            if (!auditLoading && auditLogs.length === 0) {
              setAuditLoading(true);
              api.get('/admin/audit-logs?limit=200').then(res => {
                setAuditLogs(res.data || []);
              }).catch(() => {}).finally(() => setAuditLoading(false));
            }
            const securityFeatures = [
              { label: 'Audit Trail', status: 'active', desc: 'All admin/employee access to trader PII is logged with IP and timestamp.' },
              { label: 'Data Masking', status: 'active', desc: 'Phone numbers are masked (07XX XXX 678) for non-admin roles.' },
              { label: 'Role Restrictions', status: 'active', desc: 'Employees cannot view settlement accounts, security answers, or full phone numbers.' },
              { label: 'IP Restriction', status: 'config', desc: 'Set ALLOWED_ADMIN_IPS in .env to restrict admin access to specific IPs. Currently: allow all.' },
              { label: 'Session Timeout', status: 'active', desc: 'Users auto-logged out after 30 min of inactivity. Bot API calls also keep session alive.' },
              { label: 'Withdrawal OTP', status: 'active', desc: 'All withdrawals require a one-time SMS code before processing.' },
              { label: 'Login Lockout', status: 'active', desc: '3 failed login attempts locks account for 24 hours.' },
              { label: 'Password Cooldown', status: 'active', desc: 'Password changes require OTP and have a 48-hour cooldown.' },
              { label: 'Encrypted Credentials', status: 'active', desc: 'Binance cookies, 2FA secrets, and fund passwords are encrypted at rest.' },
              { label: 'HTTPS / TLS', status: 'active', desc: 'All traffic encrypted in transit via Let\'s Encrypt TLS certificate.' },
            ];
            return (
              <div>
                {/* Security Features Status */}
                <div className="adm-card" style={{ marginBottom: 20 }}>
                  <div className="adm-card-header"><h3>Security Controls Status</h3></div>
                  <div style={{ padding: '12px 20px 16px' }}>
                    {securityFeatures.map(f => (
                      <div key={f.label} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 0', borderBottom: '1px solid #1f2937' }}>
                        <span style={{
                          marginTop: 2, flexShrink: 0, width: 10, height: 10, borderRadius: '50%',
                          background: f.status === 'active' ? '#10b981' : '#f59e0b',
                          boxShadow: f.status === 'active' ? '0 0 6px #10b981' : '0 0 6px #f59e0b',
                          display: 'inline-block',
                        }} />
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13, color: '#fff' }}>{f.label}</div>
                          <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>{f.desc}</div>
                        </div>
                        <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600, color: f.status === 'active' ? '#10b981' : '#f59e0b', flexShrink: 0 }}>
                          {f.status === 'active' ? 'ACTIVE' : 'ACTION NEEDED'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Audit Logs */}
                <div className="adm-card">
                  <div className="adm-card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <h3>Audit Log — Admin Access to Sensitive Data</h3>
                    <button onClick={() => { setAuditLogs([]); setAuditLoading(false); }} style={{ background: 'none', border: '1px solid #374151', color: '#9ca3af', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>
                      Refresh
                    </button>
                  </div>
                  {auditLoading ? (
                    <div style={{ padding: 24, color: '#9ca3af', textAlign: 'center' }}>Loading...</div>
                  ) : auditLogs.length === 0 ? (
                    <div style={{ padding: 24, color: '#6b7280', textAlign: 'center', fontSize: 13 }}>No audit logs yet. Logs are recorded when admins/employees view trader data.</div>
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      <table className="adm-table">
                        <thead>
                          <tr>
                            <th>Time</th>
                            <th>Actor (ID)</th>
                            <th>Role</th>
                            <th>Action</th>
                            <th>Target Trader</th>
                            <th>Detail</th>
                            <th>IP Address</th>
                          </tr>
                        </thead>
                        <tbody>
                          {auditLogs.map(log => (
                            <tr key={log.id}>
                              <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{log.created_at ? new Date(log.created_at).toLocaleString() : '—'}</td>
                              <td>#{log.actor_id}</td>
                              <td><span style={{ background: log.actor_role === 'admin' ? '#7c3aed22' : '#0e3a5a', color: log.actor_role === 'admin' ? '#a78bfa' : '#38bdf8', borderRadius: 4, padding: '2px 7px', fontSize: 11, fontWeight: 600 }}>{log.actor_role}</span></td>
                              <td style={{ fontSize: 12, color: '#f59e0b' }}>{log.action}</td>
                              <td>{log.target_trader_id ? `#${log.target_trader_id}` : '—'}</td>
                              <td style={{ fontSize: 11, color: '#9ca3af', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{log.detail || '—'}</td>
                              <td style={{ fontSize: 12, fontFamily: 'monospace' }}>{log.ip_address || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

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
