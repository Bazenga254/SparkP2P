import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
  getDisputedOrders,
  getDisputeDetails,
  resolveDispute,
  assignDispute,
  sendChatMessage,
  getChatHistory,
  getAdminTransactions,
  getMyPermissions,
  getSurveyResponses,
  sendSurveyInvite,
} from '../services/api';
import {
  LayoutDashboard,
  AlertTriangle,
  ShoppingCart,
  MessageCircle,
  LogOut,
  RefreshCw,
  ChevronRight,
  Send,
  Shield,
  ArrowLeft,
  CheckCircle,
  XCircle,
  Ban,
  ClipboardList,
} from 'lucide-react';

const ALL_SIDEBAR_ITEMS = [
  { key: 'dashboard', icon: LayoutDashboard, label: 'Dashboard', permission: null },
  { key: 'disputes', icon: AlertTriangle, label: 'Active Disputes', permission: 'disputes' },
  { key: 'orders', icon: ShoppingCart, label: 'All Orders', permission: 'orders' },
  { key: 'chat', icon: MessageCircle, label: 'Chat', permission: 'chat' },
  { key: 'survey', icon: ClipboardList, label: 'Survey Responses', permission: 'survey' },
];

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

export default function Employee() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [permissions, setPermissions] = useState(null);

  useEffect(() => {
    getMyPermissions().then(res => setPermissions(res.data)).catch(() => {});
  }, []);

  const sidebarItems = ALL_SIDEBAR_ITEMS.filter(item =>
    item.permission === null || (permissions && permissions[item.permission])
  );

  // Data
  const [disputes, setDisputes] = useState([]);
  const [transactions, setTransactions] = useState({ total: 0, transactions: [] });
  const [selectedDispute, setSelectedDispute] = useState(null);
  const [disputeDetail, setDisputeDetail] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [resolutionNote, setResolutionNote] = useState('');
  const [resolving, setResolving] = useState(false);
  const chatEndRef = useRef(null);

  const loadData = async () => {
    setRefreshing(true);
    try {
      const [disputesRes, txRes] = await Promise.all([
        getDisputedOrders(),
        getAdminTransactions('today', 50),
      ]);
      setDisputes(disputesRes.data);
      setTransactions(txRes.data);
    } catch (err) {
      console.error('Employee data load error:', err);
    }
    setRefreshing(false);
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, []);

  const openDispute = async (orderId) => {
    setSelectedDispute(orderId);
    setActiveTab('dispute-detail');
    try {
      const res = await getDisputeDetails(orderId);
      setDisputeDetail(res.data);
      setChatMessages(res.data.chat || []);
    } catch (err) {
      console.error('Load dispute detail error:', err);
    }
  };

  const handleAssign = async () => {
    if (!selectedDispute) return;
    try {
      await assignDispute(selectedDispute);
      const res = await getDisputeDetails(selectedDispute);
      setDisputeDetail(res.data);
    } catch (err) {
      console.error('Assign error:', err);
    }
  };

  const handleResolve = async (action) => {
    if (!selectedDispute) return;
    if (!resolutionNote.trim()) {
      alert('Please add a resolution note');
      return;
    }
    setResolving(true);
    try {
      await resolveDispute(selectedDispute, {
        resolution: resolutionNote,
        action,
      });
      setResolutionNote('');
      setSelectedDispute(null);
      setDisputeDetail(null);
      setActiveTab('disputes');
      loadData();
    } catch (err) {
      console.error('Resolve error:', err);
      alert(err.response?.data?.detail || 'Failed to resolve');
    }
    setResolving(false);
  };

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!newMessage.trim() || !selectedDispute) return;
    try {
      const res = await sendChatMessage({
        order_id: selectedDispute,
        message: newMessage.trim(),
      });
      setChatMessages((prev) => [...prev, {
        ...res.data,
        sender_name: user?.full_name || 'You',
      }]);
      setNewMessage('');
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    } catch (err) {
      console.error('Send message error:', err);
    }
  };

  // Refresh chat periodically when viewing dispute detail
  useEffect(() => {
    if (activeTab !== 'dispute-detail' || !selectedDispute) return;
    const interval = setInterval(async () => {
      try {
        const res = await getChatHistory(selectedDispute);
        setChatMessages(res.data);
      } catch (err) { /* ignore */ }
    }, 5000);
    return () => clearInterval(interval);
  }, [activeTab, selectedDispute]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  const resolvedToday = disputes.filter((d) => {
    const meta = d.fraud_check_result || {};
    return meta.resolved_at && new Date(meta.resolved_at).toDateString() === new Date().toDateString();
  }).length;

  const fmtKES = (v) => `KES ${(v || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

  const [surveyResponses, setSurveyResponses] = useState([]);
  const [surveySelected, setSurveySelected] = useState(null);
  const [surveyInviting, setSurveyInviting] = useState(null);
  const [surveyFilter, setSurveyFilter] = useState('all');

  useEffect(() => {
    if (activeTab === 'survey') {
      getSurveyResponses().then(res => setSurveyResponses(res.data)).catch(() => {});
    }
  }, [activeTab]);

  const handleSendInvite = async (id) => {
    setSurveyInviting(id);
    try {
      await sendSurveyInvite(id);
      setSurveyResponses(prev => prev.map(r => r.id === id ? { ...r, invite_sent: true } : r));
    } catch (e) {
      alert(e.response?.data?.detail || 'Failed to send invite');
    }
    setSurveyInviting(null);
  };

  const pageTitles = {
    dashboard: 'Dashboard',
    disputes: 'Active Disputes',
    orders: 'All Orders',
    chat: 'Chat',
    survey: 'Survey Responses',
    'dispute-detail': 'Dispute Details',
  };

  return (
    <div className="emp-layout">
      {sidebarOpen && <div className="emp-overlay" onClick={() => setSidebarOpen(false)} />}

      {/* Sidebar */}
      <aside className={`emp-sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="emp-sidebar-header">
          <div className="emp-logo">
            <div className="emp-logo-icon">S</div>
            <span className="emp-logo-text">SparkP2P</span>
          </div>
          <span className="emp-role-badge">Employee</span>
        </div>

        <nav className="emp-nav">
          {sidebarItems.map((item) => {
            const Icon = item.icon;
            const badge = item.key === 'disputes' ? disputes.length : 0;
            return (
              <button
                key={item.key}
                className={`emp-nav-item ${activeTab === item.key ? 'active' : ''}`}
                onClick={() => { setActiveTab(item.key); setSidebarOpen(false); }}
              >
                <Icon size={18} />
                <span>{item.label}</span>
                {badge > 0 && <span className="emp-nav-badge">{badge}</span>}
              </button>
            );
          })}
        </nav>

        <div className="emp-sidebar-footer">
          <div className="emp-user-info">
            <div className="emp-user-avatar">{user?.full_name?.charAt(0) || 'E'}</div>
            <div className="emp-user-meta">
              <span className="emp-user-name">{user?.full_name || 'Employee'}</span>
              <span className="emp-user-role">Support Staff</span>
            </div>
          </div>
          <button className="emp-logout-btn" onClick={logout}>
            <LogOut size={18} />
            <span>Logout</span>
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="emp-main">
        <header className="emp-topbar">
          <div className="emp-topbar-left">
            <button className="emp-hamburger" onClick={() => setSidebarOpen(!sidebarOpen)}>
              <span /><span /><span />
            </button>
            {activeTab === 'dispute-detail' && (
              <button className="emp-back-btn" onClick={() => { setActiveTab('disputes'); setSelectedDispute(null); setDisputeDetail(null); }}>
                <ArrowLeft size={18} />
              </button>
            )}
            <h1 className="emp-page-title">{pageTitles[activeTab] || 'Dashboard'}</h1>
          </div>
          <div className="emp-topbar-right">
            <button className="emp-refresh-btn" onClick={loadData} disabled={refreshing}>
              <RefreshCw size={16} className={refreshing ? 'spinning' : ''} />
            </button>
          </div>
        </header>

        <div className="emp-content">
          {/* ==================== DASHBOARD ==================== */}
          {activeTab === 'dashboard' && (
            <>
              <div className="emp-greeting">
                <h2>{getGreeting()}, {user?.full_name?.split(' ')[0] || 'Employee'}!</h2>
                <p>Here's your support overview for today.</p>
              </div>

              <div className="emp-stat-grid">
                <div className="emp-stat-card">
                  <div className="emp-stat-icon" style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>
                    <AlertTriangle size={22} />
                  </div>
                  <div className="emp-stat-info">
                    <span className="emp-stat-label">Open Disputes</span>
                    <span className="emp-stat-value">{disputes.length}</span>
                  </div>
                </div>
                <div className="emp-stat-card">
                  <div className="emp-stat-icon" style={{ background: 'rgba(16,185,129,0.15)', color: '#10b981' }}>
                    <CheckCircle size={22} />
                  </div>
                  <div className="emp-stat-info">
                    <span className="emp-stat-label">Resolved Today</span>
                    <span className="emp-stat-value">{resolvedToday}</span>
                  </div>
                </div>
                <div className="emp-stat-card">
                  <div className="emp-stat-icon" style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b' }}>
                    <ShoppingCart size={22} />
                  </div>
                  <div className="emp-stat-info">
                    <span className="emp-stat-label">Today's Orders</span>
                    <span className="emp-stat-value">{transactions.total}</span>
                  </div>
                </div>
              </div>

              {/* Recent Disputes */}
              <div className="emp-card" style={{ marginTop: 20 }}>
                <div className="emp-card-header">
                  <h3>Recent Disputes</h3>
                  <button className="emp-link-btn" onClick={() => setActiveTab('disputes')}>
                    View All <ChevronRight size={14} />
                  </button>
                </div>
                {disputes.length === 0 ? (
                  <p className="emp-empty">No open disputes</p>
                ) : (
                  <div className="emp-dispute-list">
                    {disputes.slice(0, 5).map((d) => (
                      <div key={d.id} className="emp-dispute-row" onClick={() => openDispute(d.id)}>
                        <div className="emp-dispute-info">
                          <span className="emp-dispute-id">#{d.binance_order_number}</span>
                          <span className="emp-dispute-amount">{fmtKES(d.fiat_amount)}</span>
                        </div>
                        <div className="emp-dispute-meta">
                          <span className={`emp-badge ${d.side === 'BUY' ? 'green' : 'red'}`}>{d.side}</span>
                          <span className="emp-dispute-time">
                            {d.created_at ? new Date(d.created_at).toLocaleString() : '-'}
                          </span>
                        </div>
                        <ChevronRight size={16} className="emp-dispute-arrow" />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {/* ==================== DISPUTES LIST ==================== */}
          {activeTab === 'disputes' && (
            <div className="emp-card">
              <div className="emp-card-header">
                <h3>Disputed Orders</h3>
                <span className="emp-card-count">{disputes.length} disputes</span>
              </div>
              {disputes.length === 0 ? (
                <p className="emp-empty">No open disputes</p>
              ) : (
                <div className="emp-table-wrap">
                  <table className="emp-table">
                    <thead>
                      <tr>
                        <th>Order #</th>
                        <th>Side</th>
                        <th>Amount</th>
                        <th>Risk</th>
                        <th>Created</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {disputes.map((d) => (
                        <tr key={d.id}>
                          <td className="mono">{d.binance_order_number}</td>
                          <td><span className={`emp-badge ${d.side === 'BUY' ? 'green' : 'red'}`}>{d.side}</span></td>
                          <td>{fmtKES(d.fiat_amount)}</td>
                          <td>{d.risk_score || '-'}</td>
                          <td>{d.created_at ? new Date(d.created_at).toLocaleString() : '-'}</td>
                          <td>
                            <button className="emp-action-btn" onClick={() => openDispute(d.id)}>
                              View Details
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ==================== DISPUTE DETAIL ==================== */}
          {activeTab === 'dispute-detail' && disputeDetail && (
            <div className="emp-detail-layout">
              {/* Left: Order + Trader + Payment info */}
              <div className="emp-detail-left">
                {/* Order Info */}
                <div className="emp-card">
                  <div className="emp-card-header">
                    <h3>Order Information</h3>
                    <span className={`emp-badge ${disputeDetail.order.status === 'disputed' ? 'red' : 'green'}`}>
                      {disputeDetail.order.status}
                    </span>
                  </div>
                  <div className="emp-detail-grid">
                    <div className="emp-detail-item">
                      <span className="emp-detail-label">Binance Order</span>
                      <span className="emp-detail-value mono">{disputeDetail.order.binance_order_number}</span>
                    </div>
                    <div className="emp-detail-item">
                      <span className="emp-detail-label">Side</span>
                      <span className={`emp-badge ${disputeDetail.order.side === 'buy' ? 'green' : 'red'}`}>
                        {disputeDetail.order.side?.toUpperCase()}
                      </span>
                    </div>
                    <div className="emp-detail-item">
                      <span className="emp-detail-label">Fiat Amount</span>
                      <span className="emp-detail-value">{fmtKES(disputeDetail.order.fiat_amount)}</span>
                    </div>
                    <div className="emp-detail-item">
                      <span className="emp-detail-label">Crypto</span>
                      <span className="emp-detail-value">
                        {disputeDetail.order.crypto_amount} {disputeDetail.order.crypto_currency}
                      </span>
                    </div>
                    <div className="emp-detail-item">
                      <span className="emp-detail-label">Rate</span>
                      <span className="emp-detail-value">{fmtKES(disputeDetail.order.exchange_rate)}</span>
                    </div>
                    <div className="emp-detail-item">
                      <span className="emp-detail-label">Risk Score</span>
                      <span className="emp-detail-value" style={{
                        color: (disputeDetail.order.risk_score || 0) > 70 ? '#ef4444' :
                               (disputeDetail.order.risk_score || 0) > 40 ? '#f59e0b' : '#10b981'
                      }}>
                        {disputeDetail.order.risk_score ?? '-'}
                      </span>
                    </div>
                    <div className="emp-detail-item">
                      <span className="emp-detail-label">Counterparty</span>
                      <span className="emp-detail-value">{disputeDetail.order.counterparty_name || '-'}</span>
                    </div>
                    <div className="emp-detail-item">
                      <span className="emp-detail-label">Created</span>
                      <span className="emp-detail-value">
                        {disputeDetail.order.created_at ? new Date(disputeDetail.order.created_at).toLocaleString() : '-'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Trader Info */}
                {disputeDetail.trader && (
                  <div className="emp-card" style={{ marginTop: 16 }}>
                    <div className="emp-card-header">
                      <h3>Trader Information</h3>
                    </div>
                    <div className="emp-detail-grid">
                      <div className="emp-detail-item">
                        <span className="emp-detail-label">Name</span>
                        <span className="emp-detail-value">{disputeDetail.trader.full_name}</span>
                      </div>
                      <div className="emp-detail-item">
                        <span className="emp-detail-label">Email</span>
                        <span className="emp-detail-value">{disputeDetail.trader.email}</span>
                      </div>
                      <div className="emp-detail-item">
                        <span className="emp-detail-label">Phone</span>
                        <span className="emp-detail-value">{disputeDetail.trader.phone}</span>
                      </div>
                      <div className="emp-detail-item">
                        <span className="emp-detail-label">Trust Score</span>
                        <span className="emp-detail-value">{disputeDetail.trader.trust_score}</span>
                      </div>
                      <div className="emp-detail-item">
                        <span className="emp-detail-label">Total Trades</span>
                        <span className="emp-detail-value">{disputeDetail.trader.total_trades}</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Payments */}
                <div className="emp-card" style={{ marginTop: 16 }}>
                  <div className="emp-card-header">
                    <h3>Payments</h3>
                    <span className="emp-card-count">{disputeDetail.payments?.length || 0}</span>
                  </div>
                  {disputeDetail.payments?.length > 0 ? (
                    <div className="emp-table-wrap">
                      <table className="emp-table">
                        <thead>
                          <tr>
                            <th>Direction</th>
                            <th>Amount</th>
                            <th>M-Pesa ID</th>
                            <th>Status</th>
                            <th>Time</th>
                          </tr>
                        </thead>
                        <tbody>
                          {disputeDetail.payments.map((p) => (
                            <tr key={p.id}>
                              <td>
                                <span className={`emp-badge ${p.direction === 'inbound' ? 'green' : 'yellow'}`}>
                                  {p.direction === 'inbound' ? 'IN' : 'OUT'}
                                </span>
                              </td>
                              <td>{fmtKES(p.amount)}</td>
                              <td className="mono">{p.mpesa_transaction_id || '-'}</td>
                              <td>
                                <span className={`emp-badge ${p.status === 'completed' ? 'green' : p.status === 'failed' ? 'red' : 'dim'}`}>
                                  {p.status}
                                </span>
                              </td>
                              <td>{p.created_at ? new Date(p.created_at).toLocaleString() : '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="emp-empty">No payments found</p>
                  )}
                </div>

                {/* Actions */}
                {disputeDetail.order.status === 'disputed' && (
                  <div className="emp-card" style={{ marginTop: 16 }}>
                    <div className="emp-card-header">
                      <h3>Resolution Actions</h3>
                    </div>
                    <div className="emp-actions-section">
                      {!disputeDetail.order.assigned_to && (
                        <button className="emp-assign-btn" onClick={handleAssign}>
                          <Shield size={16} /> Assign to Me
                        </button>
                      )}
                      {disputeDetail.order.assigned_to && (
                        <p className="emp-assigned-note">
                          Assigned to: <strong>{disputeDetail.order.assigned_to}</strong>
                        </p>
                      )}

                      <textarea
                        className="emp-resolution-input"
                        placeholder="Add resolution note..."
                        value={resolutionNote}
                        onChange={(e) => setResolutionNote(e.target.value)}
                        rows={3}
                      />

                      <div className="emp-action-buttons">
                        <button
                          className="emp-resolve-btn release"
                          onClick={() => handleResolve('release')}
                          disabled={resolving}
                        >
                          <CheckCircle size={16} /> Release Crypto
                        </button>
                        <button
                          className="emp-resolve-btn refund"
                          onClick={() => handleResolve('refund')}
                          disabled={resolving}
                        >
                          <XCircle size={16} /> Refund
                        </button>
                        <button
                          className="emp-resolve-btn cancel"
                          onClick={() => handleResolve('cancel')}
                          disabled={resolving}
                        >
                          <Ban size={16} /> Cancel Order
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {disputeDetail.order.resolution && (
                  <div className="emp-card" style={{ marginTop: 16 }}>
                    <div className="emp-card-header">
                      <h3>Resolution</h3>
                      <span className="emp-badge green">{disputeDetail.order.resolution_action}</span>
                    </div>
                    <p className="emp-resolution-text">{disputeDetail.order.resolution}</p>
                  </div>
                )}
              </div>

              {/* Right: Chat */}
              <div className="emp-detail-right">
                <div className="emp-chat-card">
                  <div className="emp-chat-header">
                    <MessageCircle size={18} />
                    <h3>Dispute Chat</h3>
                  </div>

                  <div className="emp-chat-messages">
                    {chatMessages.length === 0 && (
                      <p className="emp-chat-empty">No messages yet. Start the conversation.</p>
                    )}
                    {chatMessages.map((msg) => (
                      <div
                        key={msg.id}
                        className={`emp-chat-bubble ${msg.sender_role === 'employee' || msg.sender_role === 'admin' ? 'outgoing' : 'incoming'}`}
                      >
                        <div className="emp-chat-bubble-header">
                          <span className="emp-chat-sender">{msg.sender_name}</span>
                          <span className={`emp-chat-role-badge ${msg.sender_role}`}>{msg.sender_role}</span>
                        </div>
                        <p className="emp-chat-text">{msg.message}</p>
                        <span className="emp-chat-time">
                          {msg.created_at ? new Date(msg.created_at).toLocaleTimeString() : ''}
                        </span>
                      </div>
                    ))}
                    <div ref={chatEndRef} />
                  </div>

                  <form className="emp-chat-input" onSubmit={handleSendMessage}>
                    <input
                      type="text"
                      placeholder="Type a message..."
                      value={newMessage}
                      onChange={(e) => setNewMessage(e.target.value)}
                    />
                    <button type="submit" disabled={!newMessage.trim()}>
                      <Send size={18} />
                    </button>
                  </form>
                </div>
              </div>
            </div>
          )}

          {/* ==================== ALL ORDERS (Read-only) ==================== */}
          {activeTab === 'orders' && (
            <div className="emp-card">
              <div className="emp-card-header">
                <h3>Recent Orders</h3>
                <span className="emp-card-count">{transactions.total} total</span>
              </div>
              <div className="emp-table-wrap">
                <table className="emp-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Direction</th>
                      <th>Amount</th>
                      <th>Trader</th>
                      <th>Status</th>
                      <th>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.transactions.map((tx) => (
                      <tr key={tx.id}>
                        <td className="mono">{tx.id}</td>
                        <td>
                          <span className={`emp-badge ${tx.direction === 'inbound' ? 'green' : 'yellow'}`}>
                            {tx.direction === 'inbound' ? 'IN' : 'OUT'}
                          </span>
                        </td>
                        <td>{fmtKES(tx.amount)}</td>
                        <td>{tx.trader_name}</td>
                        <td>
                          <span className={`emp-badge ${tx.status === 'completed' ? 'green' : tx.status === 'failed' ? 'red' : 'dim'}`}>
                            {tx.status}
                          </span>
                        </td>
                        <td>{tx.created_at ? new Date(tx.created_at).toLocaleString() : '-'}</td>
                      </tr>
                    ))}
                    {transactions.transactions.length === 0 && (
                      <tr><td colSpan={6} className="emp-empty">No transactions found</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ==================== CHAT (standalone) ==================== */}
          {activeTab === 'chat' && (
            <div className="emp-card">
              <div className="emp-card-header">
                <h3>Chat</h3>
              </div>
              <p className="emp-empty" style={{ padding: 40 }}>
                Select a dispute to start chatting. Go to Active Disputes and click on one.
              </p>
            </div>
          )}

          {/* ==================== SURVEY RESPONSES ==================== */}
          {activeTab === 'survey' && (
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              <div className="emp-card" style={{ flex: 1 }}>
                <div className="emp-card-header">
                  <h3>Survey Responses</h3>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {['all', 'qualified', 'disqualified'].map(f => (
                      <button key={f} onClick={() => setSurveyFilter(f)}
                        style={{ padding: '4px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                          background: surveyFilter === f ? '#f59e0b' : '#1f2937', color: surveyFilter === f ? '#000' : '#9ca3af' }}>
                        {f.charAt(0).toUpperCase() + f.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
                  {[
                    { label: 'Total', val: surveyResponses.length, color: '#60a5fa' },
                    { label: 'Qualified', val: surveyResponses.filter(r => r.is_qualified).length, color: '#10b981' },
                    { label: 'Disqualified', val: surveyResponses.filter(r => r.disqualified).length, color: '#ef4444' },
                    { label: 'Invited', val: surveyResponses.filter(r => r.invite_sent).length, color: '#f59e0b' },
                  ].map(s => (
                    <div key={s.label} style={{ flex: 1, background: '#111827', borderRadius: 8, padding: '10px 14px', textAlign: 'center' }}>
                      <div style={{ fontSize: 20, fontWeight: 700, color: s.color }}>{s.val}</div>
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{s.label}</div>
                    </div>
                  ))}
                </div>
                <div className="emp-table-wrap">
                  <table className="emp-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Phone</th>
                        <th>Status</th>
                        <th>Invite</th>
                        <th>Date</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {surveyResponses
                        .filter(r => surveyFilter === 'all' || (surveyFilter === 'qualified' ? r.is_qualified : r.disqualified))
                        .map(r => (
                          <tr key={r.id} style={{ cursor: 'pointer', background: surveySelected?.id === r.id ? 'rgba(245,158,11,0.06)' : '' }}
                            onClick={() => setSurveySelected(surveySelected?.id === r.id ? null : r)}>
                            <td>{r.full_name}</td>
                            <td className="mono">{r.phone}</td>
                            <td>
                              <span className={`emp-badge ${r.is_qualified ? 'green' : r.disqualified ? 'red' : 'dim'}`}>
                                {r.is_qualified ? 'Qualified' : r.disqualified ? 'Disqualified' : 'Pending'}
                              </span>
                            </td>
                            <td>
                              {r.invite_sent
                                ? <span className="emp-badge green">Sent</span>
                                : r.is_qualified
                                  ? <button className="emp-action-btn" disabled={surveyInviting === r.id}
                                      onClick={e => { e.stopPropagation(); handleSendInvite(r.id); }}>
                                      {surveyInviting === r.id ? 'Sending...' : 'Send Invite'}
                                    </button>
                                  : <span style={{ color: '#4b5563', fontSize: 12 }}>—</span>}
                            </td>
                            <td style={{ fontSize: 12, color: '#6b7280' }}>
                              {r.submitted_at ? new Date(r.submitted_at).toLocaleDateString() : '-'}
                            </td>
                            <td><ChevronRight size={14} style={{ color: '#6b7280' }} /></td>
                          </tr>
                        ))}
                      {surveyResponses.length === 0 && (
                        <tr><td colSpan={6} className="emp-empty">No survey responses yet</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {surveySelected && (
                <div className="emp-card" style={{ width: 320, flexShrink: 0 }}>
                  <div className="emp-card-header">
                    <h3>{surveySelected.full_name}</h3>
                    <button onClick={() => setSurveySelected(null)} style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 18 }}>×</button>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {[
                      { q: 'Verified Merchant?', a: surveySelected.q1_is_merchant },
                      { q: 'Trading Frequency', a: surveySelected.q2_trade_frequency },
                      { q: 'Monthly Volume', a: surveySelected.q3_daily_volume },
                      { q: 'Account Frozen?', a: surveySelected.q4_account_frozen },
                      { q: 'Has Automation?', a: surveySelected.q5_has_automation },
                      { q: 'Automation Name', a: surveySelected.q5_automation_name },
                      { q: 'Biggest Challenge', a: surveySelected.q6_biggest_challenge },
                      { q: 'Daily Transactions', a: surveySelected.q7_daily_transactions },
                    ].map(({ q, a }) => a && (
                      <div key={q} style={{ borderBottom: '1px solid #1f2937', paddingBottom: 10 }}>
                        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>{q}</div>
                        <div style={{ fontSize: 13, color: '#e5e7eb' }}>{a}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
