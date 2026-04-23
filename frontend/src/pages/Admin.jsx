import { useState, useEffect, useRef } from 'react';
import api from '../services/api';
import { getAdminDashboard, getAdminTraders, getDisputedOrders, getUnmatchedPayments, updateTraderStatus, updateTraderTier, getAdminTransactions, getAdminOrders, getAdminAnalytics, getAdminOnlineTraders, getMessageTemplates, updateMessageTemplate, seedMessageTemplates, getAdminSupportTickets, closeSupportTicket, replyToSupportTicket, uploadSupportAttachment, getAdminWithdrawals, markWithdrawalComplete, markWithdrawalPending, deleteWithdrawal, getRevenueBreakdown, getAdminSweeps, retrySweep, getAdminPaybillTransactions, getTraderPnl, verifyTotp } from '../services/api';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { RefreshCw, LogOut, LayoutDashboard, Users, AlertTriangle, Banknote, TrendingUp, Settings, UserCheck, ShoppingCart, CheckCircle, Activity, AlertCircle, ArrowRightLeft, DollarSign, Wifi, Repeat, MessageSquare, Save, RotateCcw, ChevronDown, ChevronUp, Copy, Shield, Wallet, Paperclip, X, Building2, Smartphone, Eye, EyeOff, Lock } from 'lucide-react';
import { getProfile } from '../services/api';

const sidebarSections = [
  {
    label: 'OVERVIEW',
    items: [
      { key: 'dashboard', icon: LayoutDashboard, label: 'Dashboard' },
      { key: 'transactions', icon: ArrowRightLeft, label: 'Transactions' },
      { key: 'withdrawals', icon: Wallet, label: 'Withdrawals' },
      { key: 'paybill', icon: Banknote, label: 'Paybill Transactions' },
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
  // Dashboard privacy — hide sensitive values until TOTP verified
  const [dashHidden, setDashHidden] = useState(true);
  const [showDashTotpModal, setShowDashTotpModal] = useState(false);
  const [dashTotpCode, setDashTotpCode] = useState('');
  const [dashTotpError, setDashTotpError] = useState('');
  const [dashTotpLoading, setDashTotpLoading] = useState(false);
  const dashLockTimer = useRef(null);
  const DASH_LOCK_MS = 5 * 60 * 1000; // 5 minutes

  const resetDashLockTimer = () => {
    if (dashLockTimer.current) clearTimeout(dashLockTimer.current);
    dashLockTimer.current = setTimeout(() => setDashHidden(true), DASH_LOCK_MS);
  };

  // Start lock timer when dashboard is unlocked; clear it when re-hidden
  useEffect(() => {
    if (!dashHidden) {
      resetDashLockTimer();
    } else {
      if (dashLockTimer.current) clearTimeout(dashLockTimer.current);
    }
    return () => { if (dashLockTimer.current) clearTimeout(dashLockTimer.current); };
  }, [dashHidden]);
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
  const [traderPnl, setTraderPnl] = useState(null);
  const [pnlPeriod, setPnlPeriod] = useState('today');
  const [pnlLoading, setPnlLoading] = useState(false);
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
  const [auditPage, setAuditPage] = useState(1);
  const AUDIT_PER_PAGE = 30;
  const [ipWhitelist, setIpWhitelist] = useState([]);
  const [ipWhitelistEnabled, setIpWhitelistEnabled] = useState(false);
  const [ipInput, setIpInput] = useState('');
  const [ipSaving, setIpSaving] = useState(false);
  const [ipMsg, setIpMsg] = useState('');
  const [myIp, setMyIp] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [smsBalance, setSmsBalance] = useState(null);
  const [smsBalanceLoading, setSmsBalanceLoading] = useState(false);
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
  const [ticketAttachments, setTicketAttachments] = useState({}); // { [ticketId]: { url, name, type } }
  const [ticketUploading, setTicketUploading] = useState({});
  const adminFileRefs = useRef({});
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

  // Revenue breakdown
  const [revBreakdown, setRevBreakdown] = useState(null);
  const [revPeriod, setRevPeriod] = useState('all');
  const [revMethod, setRevMethod] = useState('all');
  const [revPage, setRevPage] = useState(1);
  const [revLoading, setRevLoading] = useState(false);

  // Auto-Sweeps (M-Pesa paybill → I&M Bank)
  const [sweeps, setSweeps] = useState([]);
  const [sweepsLoading, setSweepsLoading] = useState(false);
  const [sweepRetrying, setSweepRetrying] = useState(null); // sweep id being retried
  const [sweepSubTab, setSweepSubTab] = useState('all'); // all | pending | completed | failed

  // Paybill Transactions
  const [paybillTxs, setPaybillTxs] = useState({ transactions: [], total: 0, pages: 1, summary: {} });
  const [paybillPeriod, setPaybillPeriod] = useState('today');
  const [paybillPage, setPaybillPage] = useState(1);
  const [paybillLoading, setPaybillLoading] = useState(false);

  // Connection status (desktop app sessions)
  const [connProfile, setConnProfile] = useState(null);
  const [imConnecting, setImConnecting] = useState(false);
  const [mpesaConnecting, setMpesaConnecting] = useState(false);
  const imConnPollRef = useRef(null);
  const mpesaConnPollRef = useRef(null);

  // Pause Bot 3FA modal
  const [botPaused, setBotPaused] = useState(false);
  const [showPauseModal, setShowPauseModal] = useState(false);
  const [pauseStep, setPauseStep] = useState('warning'); // warning | verify
  const [pauseOtpSent, setPauseOtpSent] = useState(false);
  const [pauseOtp, setPauseOtp] = useState('');
  const [pauseSecAnswer, setPauseSecAnswer] = useState('');
  const [pauseTotp, setPauseTotp] = useState('');
  const [pauseSecQ, setPauseSecQ] = useState('');
  const [pauseLoading, setPauseLoading] = useState(false);
  const [pauseMsg, setPauseMsg] = useState('');

  const loadSweeps = async (statusFilter = sweepSubTab) => {
    setSweepsLoading(true);
    try {
      const params = statusFilter !== 'all' ? { status: statusFilter } : {};
      const res = await getAdminSweeps(params);
      setSweeps(res.data);
    } catch (e) {
      console.error('Sweeps load error:', e);
    } finally {
      setSweepsLoading(false);
    }
  };

  const loadPaybillTxs = async (period = paybillPeriod, page = paybillPage) => {
    setPaybillLoading(true);
    try {
      const res = await getAdminPaybillTransactions({ period, page, limit: 50 });
      setPaybillTxs(res.data);
    } catch (e) {
      console.error('Paybill txs error:', e);
    } finally {
      setPaybillLoading(false);
    }
  };

  const handleRetrySweep = async (sweepId) => {
    setSweepRetrying(sweepId);
    try {
      await retrySweep(sweepId);
      loadSweeps();
    } catch (e) {
      alert(e?.response?.data?.detail || 'Retry failed');
    } finally {
      setSweepRetrying(null);
    }
  };

  // Load connection status on mount + listen for desktop app events
  useEffect(() => {
    getProfile().then(r => setConnProfile(r.data)).catch(() => {});
    const onIm = async () => { const r = await getProfile(); setConnProfile(r.data); setImConnecting(false); };
    const onMpesa = async () => { const r = await getProfile(); setConnProfile(r.data); setMpesaConnecting(false); };
    window.addEventListener('im-connected', onIm);
    window.addEventListener('mpesa-portal-connected', onMpesa);
    return () => { window.removeEventListener('im-connected', onIm); window.removeEventListener('mpesa-portal-connected', onMpesa); };
  }, []);

  // Poll until I&M connected
  useEffect(() => {
    if (!imConnecting) return;
    imConnPollRef.current = setInterval(async () => {
      try { const r = await getProfile(); setConnProfile(r.data); if (r.data.im_connected) { setImConnecting(false); clearInterval(imConnPollRef.current); } } catch (_) {}
    }, 3000);
    return () => clearInterval(imConnPollRef.current);
  }, [imConnecting]);

  // Poll until M-PESA portal connected
  useEffect(() => {
    if (!mpesaConnecting) return;
    mpesaConnPollRef.current = setInterval(async () => {
      try { const r = await getProfile(); setConnProfile(r.data); if (r.data.mpesa_portal_connected) { setMpesaConnecting(false); clearInterval(mpesaConnPollRef.current); } } catch (_) {}
    }, 3000);
    return () => clearInterval(mpesaConnPollRef.current);
  }, [mpesaConnecting]);

  const handleAdminConnectIm = () => {
    if (window.sparkp2p?.isDesktop) window.sparkp2p.connectIm();
    setImConnecting(true);
  };

  const handleAdminConnectMpesa = () => {
    if (window.sparkp2p?.isDesktop) window.sparkp2p.connectMpesa();
    setMpesaConnecting(true);
  };

  // Check bot status on mount
  useEffect(() => {
    fetch('http://127.0.0.1:9223/status').then(r => r.json()).then(d => setBotPaused(d.paused)).catch(() => {});
  }, []);

  const handleRequestPauseOtp = async () => {
    // DEV: skip OTP — pause/resume immediately
    setPauseLoading(true);
    try {
      const action = botPaused ? 'resume' : 'pause';
      await fetch(`http://127.0.0.1:9223/${action}`).catch(() => {});
      setBotPaused(!botPaused);
      setShowPauseModal(false);
      setPauseStep('warning');
    } catch (err) {
      setPauseMsg('Failed.');
    }
    setPauseLoading(false);
  };

  const handleConfirmPause = async () => {
    // DEV: skip OTP — pause/resume immediately
    setPauseLoading(true);
    try {
      const action = botPaused ? 'resume' : 'pause';
      await fetch(`http://127.0.0.1:9223/${action}`).catch(() => {});
      setBotPaused(!botPaused);
      setShowPauseModal(false);
      setPauseStep('warning'); setPauseOtp(''); setPauseSecAnswer(''); setPauseTotp(''); setPauseMsg(''); setPauseOtpSent(false);
    } catch (err) {
      setPauseMsg('Failed.');
    }
    setPauseLoading(false);
  };

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

  const handleDeleteWithdrawal = async (txId) => {
    if (!window.confirm('Permanently delete this withdrawal record? This cannot be undone.')) return;
    setWdActionLoading(txId);
    try {
      await deleteWithdrawal(txId);
      loadWithdrawals();
    } catch (err) {
      console.error('Delete withdrawal error:', err);
    }
    setWdActionLoading(null);
  };

  const loadRevenueBreakdown = async (period = revPeriod, method = revMethod, page = revPage) => {
    setRevLoading(true);
    try {
      const res = await getRevenueBreakdown({ period, method, page, limit: 50 });
      setRevBreakdown(res.data);
    } catch (err) {
      console.error('Revenue breakdown error:', err);
    }
    setRevLoading(false);
  };

  const handleAdminFileSelect = async (ticketId, e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setTicketUploading((p) => ({ ...p, [ticketId]: true }));
    try {
      const res = await uploadSupportAttachment(file);
      setTicketAttachments((p) => ({ ...p, [ticketId]: { url: res.data.url, name: res.data.name, type: res.data.type } }));
    } catch {
      alert('Upload failed. Max 10 MB. Allowed: images, PDF, DOC, TXT.');
    } finally {
      setTicketUploading((p) => ({ ...p, [ticketId]: false }));
      e.target.value = '';
    }
  };

  const handleReplyTicket = async (ticketId) => {
    const msg = (ticketReplies[ticketId] || '').trim();
    const att = ticketAttachments[ticketId];
    if (!msg && !att) return;
    setTicketReplying((p) => ({ ...p, [ticketId]: true }));
    try {
      const res = await replyToSupportTicket(ticketId, msg, att?.url, att?.name);
      setTicketReplies((p) => ({ ...p, [ticketId]: '' }));
      setTicketAttachments((p) => { const n = { ...p }; delete n[ticketId]; return n; });
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
    if (activeTab === 'withdrawals') { loadWithdrawals(); loadSweeps('all'); }
    if (activeTab === 'paybill') { loadPaybillTxs('today', 1); }
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

  const loadTraderPnl = async (traderId, period) => {
    setPnlLoading(true);
    try {
      const r = await getTraderPnl(traderId, period);
      setTraderPnl(r.data);
    } catch (e) { console.error('PnL load error:', e); }
    setPnlLoading(false);
  };

  const openTraderPage = async (trader) => {
    setViewingTrader({ ...trader });
    setViewingTraderWallet(null);
    setViewingTraderTx([]);
    setViewingTraderOrders([]);
    setTraderPnl(null);
    setPnlPeriod('today');
    setViewingTraderLoading(true);
    setTxPage(1);
    setOrdersPage(1);
    setResetPwMsg('');
    setShowSecurityAnswer(false);
    setResolveRef(''); setResolveAmount(''); setResolveMsg({ text: '', type: '' });
    try {
      const [detailRes, walletRes, txRes, ordersRes, pnlRes] = await Promise.all([
        api.get(`/admin/traders/${trader.id}/detail`),
        api.get(`/admin/traders/${trader.id}/wallet`),
        api.get(`/admin/traders/${trader.id}/transactions?limit=60`),
        api.get(`/admin/traders/${trader.id}/orders?limit=60`),
        getTraderPnl(trader.id, 'today'),
      ]);
      setViewingTrader(prev => ({ ...prev, ...(detailRes.data || {}) }));
      setViewingTraderWallet(walletRes.data);
      setViewingTraderTx(txRes.data || []);
      setViewingTraderOrders(ordersRes.data || []);
      setTraderPnl(pnlRes.data);
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
  const fmtKESFee = (v) => `KES ${(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // Compute max volume for chart scaling
  const maxVolume = analytics?.monthly_volumes?.length
    ? Math.max(...analytics.monthly_volumes.map((m) => m.total_volume), 1)
    : 1;

  return (
    <div className="adm-layout">

      {/* ── Pause Bot 3FA Modal ── */}
      {showPauseModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#1a1d2e', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 16, padding: 28, width: '100%', maxWidth: 440, boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}>

            {pauseStep === 'warning' && (
              <>
                <div style={{ fontSize: 32, textAlign: 'center', marginBottom: 12 }}>{botPaused ? '▶️' : '⏸️'}</div>
                <h3 style={{ textAlign: 'center', marginBottom: 8, color: botPaused ? '#10b981' : '#ef4444' }}>
                  {botPaused ? 'Resume Bot Trading?' : 'Pause Bot Trading?'}
                </h3>
                <p style={{ fontSize: 13, color: '#9ca3af', textAlign: 'center', marginBottom: 24 }}>
                  {botPaused
                    ? 'The bot will resume monitoring orders and executing trades automatically.'
                    : 'All browser sessions will be locked. You will need to verify your identity with 3 factors to proceed.'}
                </p>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button onClick={() => setShowPauseModal(false)} style={{ flex: 1, padding: '11px 0', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: '#9ca3af', cursor: 'pointer', fontWeight: 600 }}>Cancel</button>
                  <button onClick={handleRequestPauseOtp} disabled={pauseLoading} style={{ flex: 1, padding: '11px 0', borderRadius: 8, border: 'none', background: botPaused ? '#10b981' : '#ef4444', color: '#fff', cursor: 'pointer', fontWeight: 700 }}>
                    {pauseLoading ? 'Sending OTP...' : 'Continue'}
                  </button>
                </div>
                {pauseMsg && <p style={{ color: '#f59e0b', fontSize: 12, textAlign: 'center', marginTop: 10 }}>{pauseMsg}</p>}
              </>
            )}

            {pauseStep === 'verify' && (
              <>
                <h3 style={{ marginBottom: 6, color: '#f59e0b' }}>3-Factor Verification</h3>
                <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 20 }}>All three factors are required to {botPaused ? 'resume' : 'pause'} the bot.</p>

                {/* Factor 1: SMS OTP */}
                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 12, color: '#9ca3af', display: 'block', marginBottom: 5 }}>
                    1. SMS OTP {pauseMsg && <span style={{ color: '#10b981' }}>— {pauseMsg}</span>}
                  </label>
                  <input
                    type="text" inputMode="numeric" maxLength={6} placeholder="6-digit code from SMS"
                    value={pauseOtp} onChange={e => setPauseOtp(e.target.value)}
                    style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: '#0d0f1e', color: '#fff', fontSize: 14, boxSizing: 'border-box' }}
                  />
                </div>

                {/* Factor 2: Security Answer */}
                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 12, color: '#9ca3af', display: 'block', marginBottom: 5 }}>
                    2. Security Answer {pauseSecQ && <span style={{ color: '#6b7280' }}>— {pauseSecQ}</span>}
                  </label>
                  <input
                    type="text" placeholder="Your security answer"
                    value={pauseSecAnswer} onChange={e => setPauseSecAnswer(e.target.value)}
                    style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: '#0d0f1e', color: '#fff', fontSize: 14, boxSizing: 'border-box' }}
                  />
                </div>

                {/* Factor 3: Google Authenticator — only if TOTP is configured */}
                <div style={{ marginBottom: 20 }}>
                  <label style={{ fontSize: 12, color: '#9ca3af', display: 'block', marginBottom: 5 }}>
                    3. Google Authenticator Code
                    {!connProfile?.has_totp && (
                      <span style={{ marginLeft: 8, fontSize: 11, color: '#f59e0b' }}>— Not configured (optional)</span>
                    )}
                  </label>
                  <input
                    type="text" inputMode="numeric" maxLength={6} placeholder={connProfile?.has_totp ? "6-digit code from Google Authenticator" : "Not set up — skip or set up in Settings → Binance"}
                    value={pauseTotp} onChange={e => setPauseTotp(e.target.value)}
                    disabled={!connProfile?.has_totp}
                    style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: connProfile?.has_totp ? '#0d0f1e' : '#1a1c2e', color: connProfile?.has_totp ? '#fff' : '#4b5563', fontSize: 14, boxSizing: 'border-box', cursor: connProfile?.has_totp ? 'text' : 'not-allowed' }}
                  />
                </div>

                {pauseMsg && <p style={{ color: '#ef4444', fontSize: 12, marginBottom: 12 }}>{pauseMsg}</p>}

                <div style={{ display: 'flex', gap: 10 }}>
                  <button onClick={() => { setShowPauseModal(false); setPauseStep('warning'); setPauseMsg(''); }} style={{ flex: 1, padding: '11px 0', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: '#9ca3af', cursor: 'pointer', fontWeight: 600 }}>Cancel</button>
                  <button onClick={handleConfirmPause} disabled={pauseLoading} style={{ flex: 1, padding: '11px 0', borderRadius: 8, border: 'none', background: botPaused ? '#10b981' : '#ef4444', color: '#fff', cursor: 'pointer', fontWeight: 700 }}>
                    {pauseLoading ? 'Verifying...' : `Confirm ${botPaused ? 'Resume' : 'Pause'}`}
                  </button>
                </div>
              </>
            )}

          </div>
        </div>
      )}

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
                    onClick={() => { setActiveTab(item.key); setSidebarOpen(false); if (item.key === 'revenue') loadRevenueBreakdown('all', 'all', 1); }}
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

        {/* Bot Connections */}
        <div style={{ padding: '12px 12px 4px', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
          <div className="adm-nav-label" style={{ marginBottom: 8 }}>CONNECTIONS</div>

          {/* I&M Bank */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <Building2 size={13} color={connProfile?.im_connected ? '#10b981' : '#6b7280'} />
              <span style={{ fontSize: 11, color: connProfile?.im_connected ? '#10b981' : '#6b7280', fontWeight: 600 }}>
                I&amp;M Bank {connProfile?.im_connected ? '● Connected' : '○ Disconnected'}
              </span>
            </div>
            <button
              onClick={handleAdminConnectIm}
              disabled={imConnecting}
              style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: `1px solid ${connProfile?.im_connected ? 'rgba(245,158,11,0.4)' : 'rgba(99,102,241,0.5)'}`, background: 'transparent', color: connProfile?.im_connected ? '#f59e0b' : '#818cf8', cursor: 'pointer', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}
            >
              {imConnecting ? (
                <><div style={{ width: 10, height: 10, border: '2px solid rgba(99,102,241,0.3)', borderTop: '2px solid #6366f1', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} /> Connecting...</>
              ) : connProfile?.im_connected ? 'Re-connect I&M' : 'Connect I&M Bank'}
            </button>
          </div>

          {/* M-PESA Portal */}
          <div style={{ marginBottom: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <Smartphone size={13} color={connProfile?.mpesa_portal_connected ? '#10b981' : '#6b7280'} />
              <span style={{ fontSize: 11, color: connProfile?.mpesa_portal_connected ? '#10b981' : '#6b7280', fontWeight: 600 }}>
                M-PESA Portal {connProfile?.mpesa_portal_connected ? '● Connected' : '○ Disconnected'}
              </span>
            </div>
            <button
              onClick={handleAdminConnectMpesa}
              disabled={mpesaConnecting}
              style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: `1px solid ${connProfile?.mpesa_portal_connected ? 'rgba(245,158,11,0.4)' : 'rgba(16,185,129,0.5)'}`, background: 'transparent', color: connProfile?.mpesa_portal_connected ? '#f59e0b' : '#10b981', cursor: 'pointer', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}
            >
              {mpesaConnecting ? (
                <><div style={{ width: 10, height: 10, border: '2px solid rgba(16,185,129,0.3)', borderTop: '2px solid #10b981', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} /> Connecting...</>
              ) : connProfile?.mpesa_portal_connected ? 'Re-connect Portal' : 'Connect M-PESA'}
            </button>
          </div>
        </div>

        {/* Pause / Resume Bot */}
        <div style={{ padding: '8px 12px 12px' }}>
          <button
            onClick={() => { setShowPauseModal(true); setPauseStep('warning'); setPauseMsg(''); }}
            style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: `1px solid ${botPaused ? 'rgba(16,185,129,0.5)' : 'rgba(239,68,68,0.5)'}`, background: botPaused ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)', color: botPaused ? '#10b981' : '#ef4444', cursor: 'pointer', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
          >
            {botPaused ? '▶ Resume Bot' : '⏸ Pause Bot'}
          </button>
        </div>

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
              {/* TOTP unlock modal */}
              {showDashTotpModal && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.92)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)' }}>
                  <div style={{ background: '#111827', borderRadius: 16, padding: 32, width: 360, border: '1px solid #1f2937', boxShadow: '0 20px 60px rgba(0,0,0,0.8)' }}>
                    <div style={{ textAlign: 'center', marginBottom: 24 }}>
                      <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'rgba(59,130,246,0.15)', border: '2px solid #3b82f6', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                        <Lock size={24} color="#3b82f6" />
                      </div>
                      <h3 style={{ fontWeight: 700, fontSize: 17, marginBottom: 6 }}>Verify Identity</h3>
                      <p style={{ color: '#9ca3af', fontSize: 13 }}>Enter your Google Authenticator code to view sensitive dashboard data.</p>
                    </div>
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      placeholder="6-digit code"
                      value={dashTotpCode}
                      onChange={e => { setDashTotpCode(e.target.value.replace(/\D/g, '')); setDashTotpError(''); }}
                      onKeyDown={async e => { if (e.key === 'Enter') { /* handled by button */ } }}
                      style={{ width: '100%', padding: '12px 16px', borderRadius: 10, border: `1px solid ${dashTotpError ? '#ef4444' : '#374151'}`, background: '#111827', color: '#fff', fontSize: 20, letterSpacing: 8, textAlign: 'center', boxSizing: 'border-box', marginBottom: 8 }}
                      autoFocus
                    />
                    {dashTotpError && <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 10, textAlign: 'center' }}>{dashTotpError}</div>}
                    <button
                      disabled={dashTotpCode.length !== 6 || dashTotpLoading}
                      onClick={async () => {
                        setDashTotpLoading(true);
                        try {
                          await verifyTotp(dashTotpCode);
                          setDashHidden(false);
                          setShowDashTotpModal(false);
                          setDashTotpCode('');
                          setDashTotpError('');
                        } catch (e) {
                          setDashTotpError(e.response?.data?.detail || 'Invalid code. Try again.');
                        }
                        setDashTotpLoading(false);
                      }}
                      style={{ width: '100%', padding: '12px', borderRadius: 10, border: 'none', background: dashTotpCode.length === 6 ? '#3b82f6' : '#1f2937', color: dashTotpCode.length === 6 ? '#fff' : '#6b7280', fontWeight: 700, fontSize: 14, cursor: dashTotpCode.length === 6 ? 'pointer' : 'default', marginBottom: 10 }}
                    >
                      {dashTotpLoading ? 'Verifying…' : 'Unlock Dashboard'}
                    </button>
                    <button onClick={() => { setShowDashTotpModal(false); setDashTotpCode(''); setDashTotpError(''); }}
                      style={{ width: '100%', padding: '10px', borderRadius: 10, border: '1px solid #374151', background: 'transparent', color: '#9ca3af', cursor: 'pointer', fontSize: 13 }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}

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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--green)' }}>
                        {dashHidden ? '••••••' : fmtKESFee(analytics?.revenue?.today || dashboard.today.revenue)}
                      </div>
                      <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>fees collected</p>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                      <button
                        onClick={() => { if (dashHidden) { setShowDashTotpModal(true); } else { setDashHidden(true); } }}
                        title={dashHidden ? 'Show dashboard data' : 'Hide dashboard data'}
                        style={{ background: dashHidden ? 'rgba(255,255,255,0.07)' : 'rgba(16,185,129,0.12)', border: `1px solid ${dashHidden ? 'rgba(255,255,255,0.12)' : '#10b981'}`, borderRadius: 8, padding: '8px 10px', cursor: 'pointer', color: dashHidden ? '#9ca3af' : '#10b981', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, whiteSpace: 'nowrap' }}
                      >
                        {dashHidden ? <Eye size={15} /> : <EyeOff size={15} />}
                        {dashHidden ? 'Show' : 'Hide'}
                      </button>
                      {!dashHidden && (
                        <span style={{ fontSize: 10, color: '#6b7280' }}>Locks in 5 min</span>
                      )}
                    </div>
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
                    <span className="adm-stat-value">{dashHidden ? '••••••' : fmtKESFee(dashboard.today.revenue)}</span>
                  </div>
                  <div className="adm-stat-icon" style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b' }}>
                    <TrendingUp size={22} />
                  </div>
                </div>
                <div className="adm-stat-card" style={{ '--card-accent': '#06b6d4', cursor: 'pointer' }} onClick={async () => {
                  if (!dashHidden) { try { await api.post('/payment/balance/refresh'); } catch(e) {} }
                }}>
                  <div className="adm-stat-info">
                    <span className="adm-stat-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      Paybill Balance
                      {paybillBalance?.updated_at && <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981', display: 'inline-block', animation: 'pulse-green 1.5s ease-in-out infinite', boxShadow: '0 0 6px #10b981' }} />}
                    </span>
                    <span className="adm-stat-value">
                      {dashHidden ? '••••••' : (paybillBalance?.available != null ? fmtKES(paybillBalance.available) : '—')}
                    </span>
                    {!dashHidden && paybillBalance?.updated_at && <span style={{ fontSize: 10, color: '#6b7280' }}>Updated: {new Date(paybillBalance.updated_at).toLocaleTimeString()} · {paybillBalance.source === 'realtime' ? 'live' : 'Safaricom'}</span>}
                    {!dashHidden && !paybillBalance?.updated_at && <span style={{ fontSize: 10, color: '#6b7280' }}>Click to refresh</span>}
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
                    <span className="adm-stat-value">{dashHidden ? '••••••' : fmtKES(dashboard.platform.total_float)}</span>
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
                    <span className="adm-stat-value">{dashHidden ? '••••••' : fmtKES(dashboard.today.volume)}</span>
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
                        <span className="adm-profit-val">{fmtKESFee(analytics?.revenue?.today)}</span>
                      </div>
                      <div className="adm-profit-row">
                        <span>This Week</span>
                        <span className="adm-profit-val">{fmtKESFee(analytics?.revenue?.week)}</span>
                      </div>
                      <div className="adm-profit-row">
                        <span>This Month</span>
                        <span className="adm-profit-val">{fmtKESFee(analytics?.revenue?.month)}</span>
                      </div>
                      <div className="adm-profit-row">
                        <span>This Year</span>
                        <span className="adm-profit-val">{fmtKESFee(analytics?.revenue?.year)}</span>
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
                            ['Total Volume', w?.total_volume, '#3b82f6'],
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

                    {/* P&L Card */}
                    <div className="adm-card" style={{ marginBottom: 16 }}>
                      <div className="adm-card-header" style={{ flexWrap: 'wrap', gap: 8 }}>
                        <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <TrendingUp size={16} style={{ color: '#10b981' }} />
                          Profit & Loss
                        </h3>
                        <div style={{ display: 'flex', gap: 6 }}>
                          {['today', 'week', 'month'].map(p => (
                            <button
                              key={p}
                              onClick={async () => { setPnlPeriod(p); await loadTraderPnl(t.id, p); }}
                              style={{
                                padding: '4px 12px', borderRadius: 20, fontSize: 12, cursor: 'pointer', border: 'none',
                                background: pnlPeriod === p ? '#10b981' : 'rgba(255,255,255,0.07)',
                                color: pnlPeriod === p ? '#000' : '#9ca3af', fontWeight: pnlPeriod === p ? 700 : 400,
                              }}
                            >
                              {p === 'today' ? 'Today' : p === 'week' ? '7 Days' : '30 Days'}
                            </button>
                          ))}
                        </div>
                      </div>
                      {pnlLoading ? (
                        <div style={{ padding: '24px', textAlign: 'center', color: '#6b7280', fontSize: 13 }}>Loading…</div>
                      ) : traderPnl ? (() => {
                        const s = traderPnl.summary;
                        return (
                          <div style={{ padding: '16px 20px 20px' }}>
                            {/* Summary cards */}
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 20 }}>
                              {[
                                { label: 'Gross Revenue', value: s.revenue, color: '#10b981', prefix: '+' },
                                { label: 'Fees Paid', value: s.fees, color: '#ef4444', prefix: '-' },
                                { label: 'Net P&L', value: s.net, color: s.net > 0 ? '#10b981' : s.net < 0 ? '#ef4444' : '#6b7280', prefix: s.net > 0 ? '+' : '' },
                                { label: 'Sell Orders', value: s.trades, color: '#f59e0b', isCount: true },
                              ].map(({ label, value, color, isCount, prefix }) => (
                                <div key={label} style={{ background: 'var(--bg)', borderRadius: 8, padding: '12px 14px', border: `1px solid ${color}33` }}>
                                  <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>{label}</div>
                                  <div style={{ fontSize: 17, fontWeight: 700, color }}>
                                    {isCount ? value : `${prefix || ''}KES ${Math.abs(value).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`}
                                  </div>
                                </div>
                              ))}
                            </div>
                            {/* Daily breakdown table (hidden for today single-day) */}
                            {traderPnl.daily.length > 1 && (
                              <div className="adm-table-wrap">
                                <table className="adm-table">
                                  <thead>
                                    <tr>
                                      <th>Date</th>
                                      <th>Sell Orders</th>
                                      <th style={{ textAlign: 'right' }}>Revenue</th>
                                      <th style={{ textAlign: 'right' }}>Fees</th>
                                      <th style={{ textAlign: 'right' }}>Net P&L</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {[...traderPnl.daily].reverse().map(row => (
                                      <tr key={row.date}>
                                        <td style={{ color: '#9ca3af' }}>{new Date(row.date + 'T00:00:00').toLocaleDateString('en-KE', { weekday: 'short', month: 'short', day: 'numeric' })}</td>
                                        <td><span style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b', padding: '2px 8px', borderRadius: 10, fontSize: 12, fontWeight: 600 }}>{row.trades}</span></td>
                                        <td style={{ textAlign: 'right', color: '#10b981', fontWeight: 600 }}>{row.revenue > 0 ? `+KES ${row.revenue.toLocaleString()}` : '—'}</td>
                                        <td style={{ textAlign: 'right', color: '#ef4444' }}>{row.fees > 0 ? `-KES ${row.fees.toLocaleString()}` : '—'}</td>
                                        <td style={{ textAlign: 'right', fontWeight: 700, color: row.net >= 0 ? '#3b82f6' : '#ef4444' }}>
                                          {row.net !== 0 ? `${row.net >= 0 ? '+' : ''}KES ${row.net.toLocaleString()}` : '—'}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                            {traderPnl.daily.length === 1 && s.trades === 0 && (
                              <div style={{ textAlign: 'center', color: '#4b5563', fontSize: 13, padding: '8px 0 4px' }}>No completed sell orders today.</div>
                            )}
                          </div>
                        );
                      })() : null}
                    </div>

                    {/* Withdrawal Method */}
                    <div className="adm-card" style={{ marginBottom: 16 }}>
                      <div className="adm-card-header">
                        <h3>Withdrawal Method</h3>
                        {t.settlement_changed_at && (
                          <span className="adm-card-count">Changed {new Date(t.settlement_changed_at).toLocaleDateString()}</span>
                        )}
                      </div>
                      <div style={{ padding: '16px 20px 20px' }}>
                        {(() => {
                          const method = (t.settlement_method || '').toString().toLowerCase();
                          const methodLabel = method === 'mpesa' ? 'M-Pesa' : method === 'paybill' ? 'Paybill' : method === 'bank' ? 'I&M Bank' : method || '—';
                          const methodColor = method === 'mpesa' ? '#10b981' : method === 'paybill' ? '#3b82f6' : method === 'bank' ? '#8b5cf6' : '#6b7280';

                          const pendingMethod = (t.pending_settlement_method || '').toString().toLowerCase();
                          const pendingLabel = pendingMethod === 'mpesa' ? 'M-Pesa' : pendingMethod === 'paybill' ? 'Paybill' : pendingMethod === 'bank' ? 'I&M Bank' : pendingMethod || '';

                          return (
                            <>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                                <span style={{ background: methodColor + '22', color: methodColor, padding: '4px 12px', borderRadius: 20, fontSize: 13, fontWeight: 700 }}>{methodLabel}</span>
                                {pendingMethod && (
                                  <span style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b', padding: '4px 12px', borderRadius: 20, fontSize: 12 }}>
                                    Pending change → {pendingLabel}
                                  </span>
                                )}
                              </div>
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 24px', fontSize: 13 }}>
                                {method === 'mpesa' && t.settlement_phone && (
                                  <div>
                                    <div style={{ color: '#6b7280', fontSize: 11, marginBottom: 2 }}>M-Pesa Phone</div>
                                    <div style={{ fontWeight: 600 }}>{t.settlement_phone}</div>
                                  </div>
                                )}
                                {method === 'paybill' && t.settlement_paybill && (
                                  <div>
                                    <div style={{ color: '#6b7280', fontSize: 11, marginBottom: 2 }}>Paybill Number</div>
                                    <div style={{ fontWeight: 600 }}>{t.settlement_paybill}</div>
                                  </div>
                                )}
                                {method === 'paybill' && t.settlement_account && (
                                  <div>
                                    <div style={{ color: '#6b7280', fontSize: 11, marginBottom: 2 }}>Account Reference</div>
                                    <div style={{ fontWeight: 600 }}>{t.settlement_account}</div>
                                  </div>
                                )}
                                {method === 'bank' && t.settlement_account && (
                                  <div>
                                    <div style={{ color: '#6b7280', fontSize: 11, marginBottom: 2 }}>Account Number</div>
                                    <div style={{ fontWeight: 600 }}>{t.settlement_account}</div>
                                  </div>
                                )}
                                {method === 'bank' && t.settlement_bank_name && (
                                  <div>
                                    <div style={{ color: '#6b7280', fontSize: 11, marginBottom: 2 }}>Bank Name</div>
                                    <div style={{ fontWeight: 600 }}>{t.settlement_bank_name}</div>
                                  </div>
                                )}
                              </div>

                              {pendingMethod && (
                                <div style={{ marginTop: 16, padding: '12px 14px', borderRadius: 8, border: '1px solid rgba(245,158,11,0.3)', background: 'rgba(245,158,11,0.05)' }}>
                                  <div style={{ fontSize: 12, color: '#f59e0b', fontWeight: 700, marginBottom: 8 }}>Pending Change (48hr cooldown)</div>
                                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px', fontSize: 12 }}>
                                    {pendingMethod === 'mpesa' && t.pending_settlement_phone && (
                                      <div>
                                        <div style={{ color: '#6b7280', fontSize: 11 }}>New Phone</div>
                                        <div style={{ fontWeight: 600, color: '#fff' }}>{t.pending_settlement_phone}</div>
                                      </div>
                                    )}
                                    {pendingMethod === 'paybill' && t.pending_settlement_paybill && (
                                      <div>
                                        <div style={{ color: '#6b7280', fontSize: 11 }}>New Paybill</div>
                                        <div style={{ fontWeight: 600, color: '#fff' }}>{t.pending_settlement_paybill}</div>
                                      </div>
                                    )}
                                    {pendingMethod === 'paybill' && t.pending_settlement_account && (
                                      <div>
                                        <div style={{ color: '#6b7280', fontSize: 11 }}>New Account Ref</div>
                                        <div style={{ fontWeight: 600, color: '#fff' }}>{t.pending_settlement_account}</div>
                                      </div>
                                    )}
                                    {pendingMethod === 'bank' && t.pending_settlement_account && (
                                      <div>
                                        <div style={{ color: '#6b7280', fontSize: 11 }}>New Account</div>
                                        <div style={{ fontWeight: 600, color: '#fff' }}>{t.pending_settlement_account}</div>
                                      </div>
                                    )}
                                    {pendingMethod === 'bank' && t.pending_settlement_bank_name && (
                                      <div>
                                        <div style={{ color: '#6b7280', fontSize: 11 }}>New Bank</div>
                                        <div style={{ fontWeight: 600, color: '#fff' }}>{t.pending_settlement_bank_name}</div>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              )}
                            </>
                          );
                        })()}
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
                          {ticketCategory === 'open' && (
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
                                      {m.attachment_url && (
                                        <div style={{ marginTop: 6 }}>
                                          {m.attachment_type?.startsWith('image/') ? (
                                            <img src={m.attachment_url} alt={m.attachment_name} style={{ maxWidth: 180, maxHeight: 140, borderRadius: 6, display: 'block' }} />
                                          ) : (
                                            <a href={m.attachment_url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: '#a5b4fc', display: 'flex', alignItems: 'center', gap: 4 }}>
                                              <Paperclip size={11} /> {m.attachment_name || 'Attachment'}
                                            </a>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                            {/* Attachment preview */}
                            {ticketAttachments[ticket.id] && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, padding: '5px 8px', background: 'rgba(99,102,241,0.08)', borderRadius: 6, fontSize: 11, color: '#a5b4fc' }}>
                                <Paperclip size={12} />
                                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ticketAttachments[ticket.id].name}</span>
                                <button onClick={() => setTicketAttachments((p) => { const n = { ...p }; delete n[ticket.id]; return n; })} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#a5b4fc', padding: 0, display: 'flex' }}><X size={12} /></button>
                              </div>
                            )}
                            {/* Reply box */}
                            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                              <input
                                type="file"
                                accept="image/*,.pdf,.doc,.docx,.txt"
                                style={{ display: 'none' }}
                                ref={(el) => { adminFileRefs.current[ticket.id] = el; }}
                                onChange={(e) => handleAdminFileSelect(ticket.id, e)}
                              />
                              <button
                                onClick={() => adminFileRefs.current[ticket.id]?.click()}
                                disabled={ticketUploading[ticket.id]}
                                title="Attach file"
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: ticketAttachments[ticket.id] ? '#a5b4fc' : 'var(--text-secondary)', padding: '6px 4px', display: 'flex', alignItems: 'center' }}
                              >
                                <Paperclip size={16} />
                              </button>
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
                                disabled={ticketReplying[ticket.id] || ticketUploading[ticket.id] || (!(ticketReplies[ticket.id] || '').trim() && !ticketAttachments[ticket.id])}
                                className="adm-btn-sm"
                                style={{ padding: '8px 14px', background: 'rgba(99,102,241,0.2)', color: '#a5b4fc', border: '1px solid rgba(99,102,241,0.4)', whiteSpace: 'nowrap' }}
                              >
                                {ticketUploading[ticket.id] ? 'Uploading…' : ticketReplying[ticket.id] ? 'Sending…' : 'Send Reply'}
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
              {/* ── Period + Method filters ── */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: 4, background: 'var(--surface)', borderRadius: 8, padding: 4, border: '1px solid var(--border)' }}>
                  {[['all','All Time'], ['month','This Month'], ['week','This Week'], ['today','Today']].map(([val, label]) => (
                    <button key={val} onClick={() => { setRevPeriod(val); setRevPage(1); loadRevenueBreakdown(val, revMethod, 1); }}
                      style={{ padding: '5px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                        background: revPeriod === val ? '#f59e0b' : 'transparent', color: revPeriod === val ? '#000' : '#9ca3af' }}>
                      {label}
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 4, background: 'var(--surface)', borderRadius: 8, padding: 4, border: '1px solid var(--border)' }}>
                  {[['all','All Methods'], ['mpesa','M-Pesa'], ['bank','I&M Bank']].map(([val, label]) => (
                    <button key={val} onClick={() => { setRevMethod(val); setRevPage(1); loadRevenueBreakdown(revPeriod, val, 1); }}
                      style={{ padding: '5px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                        background: revMethod === val ? '#10b981' : 'transparent', color: revMethod === val ? '#000' : '#9ca3af' }}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* ── Summary cards: Total + M-Pesa + I&M ── */}
              <div className="adm-stat-grid" style={{ marginBottom: 16 }}>
                <div className="adm-stat-card" style={{ '--card-accent': '#10b981' }}>
                  <div className="adm-stat-info">
                    <span className="adm-stat-label">Total Revenue</span>
                    <span className="adm-stat-value">{fmtKESFee(revBreakdown?.summary?.total ?? analytics?.platform_profit)}</span>
                  </div>
                  <div className="adm-stat-icon" style={{ background: 'rgba(16,185,129,0.15)', color: '#10b981' }}><DollarSign size={22} /></div>
                </div>
                <div className="adm-stat-card" style={{ '--card-accent': '#e11d48' }}>
                  <div className="adm-stat-info">
                    <span className="adm-stat-label">M-Pesa Revenue</span>
                    <span className="adm-stat-value">{fmtKESFee(revBreakdown?.summary?.mpesa ?? 0)}</span>
                  </div>
                  <div className="adm-stat-icon" style={{ background: 'rgba(225,29,72,0.15)', color: '#e11d48' }}><DollarSign size={22} /></div>
                </div>
                <div className="adm-stat-card" style={{ '--card-accent': '#3b82f6' }}>
                  <div className="adm-stat-info">
                    <span className="adm-stat-label">I&M Bank Revenue</span>
                    <span className="adm-stat-value">{fmtKESFee(revBreakdown?.summary?.bank ?? 0)}</span>
                  </div>
                  <div className="adm-stat-icon" style={{ background: 'rgba(59,130,246,0.15)', color: '#3b82f6' }}><DollarSign size={22} /></div>
                </div>
              </div>

              {/* ── Per-transaction breakdown table ── */}
              <div className="adm-card" style={{ marginBottom: 16 }}>
                <div className="adm-card-header"><h3>Fee Transactions</h3></div>
                {revLoading ? (
                  <p className="adm-empty">Loading...</p>
                ) : revBreakdown?.transactions?.length > 0 ? (
                  <>
                    <div className="adm-table-wrap">
                      <table className="adm-table">
                        <thead>
                          <tr>
                            <th>Date</th>
                            <th>Trader</th>
                            <th>Method</th>
                            <th>Destination</th>
                            <th style={{ textAlign: 'right' }}>Withdrawal</th>
                            <th style={{ textAlign: 'right' }}>Fee Earned</th>
                          </tr>
                        </thead>
                        <tbody>
                          {revBreakdown.transactions.map((tx) => (
                            <tr key={tx.id}>
                              <td style={{ fontSize: 12, color: '#9ca3af', whiteSpace: 'nowrap' }}>{new Date(tx.date).toLocaleString()}</td>
                              <td>
                                <div style={{ fontWeight: 500, fontSize: 13 }}>{tx.trader_name}</div>
                                <div style={{ fontSize: 11, color: '#6b7280' }}>{tx.trader_phone}</div>
                              </td>
                              <td>
                                <span style={{ padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600,
                                  background: tx.method === 'M-Pesa' ? 'rgba(225,29,72,0.15)' : 'rgba(59,130,246,0.15)',
                                  color: tx.method === 'M-Pesa' ? '#e11d48' : '#3b82f6' }}>
                                  {tx.method}
                                </span>
                              </td>
                              <td style={{ fontSize: 12, color: '#6b7280' }}>{tx.destination || '—'}</td>
                              <td style={{ textAlign: 'right', fontSize: 13 }}>{fmtKES(tx.withdrawal_amount)}</td>
                              <td style={{ textAlign: 'right', fontWeight: 700, color: '#10b981' }}>+{fmtKESFee(tx.fee)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {revBreakdown.pages > 1 && (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderTop: '1px solid var(--border)' }}>
                        <button onClick={() => { setRevPage(p => p - 1); loadRevenueBreakdown(revPeriod, revMethod, revPage - 1); }} disabled={revPage <= 1}
                          style={{ padding: '6px 16px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: revPage <= 1 ? '#4b5563' : '#fff', cursor: revPage <= 1 ? 'default' : 'pointer', fontSize: 13 }}>← Prev</button>
                        <span style={{ fontSize: 13, color: '#6b7280' }}>Page {revPage} of {revBreakdown.pages} · {revBreakdown.total} transactions</span>
                        <button onClick={() => { setRevPage(p => p + 1); loadRevenueBreakdown(revPeriod, revMethod, revPage + 1); }} disabled={revPage >= revBreakdown.pages}
                          style={{ padding: '6px 16px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: revPage >= revBreakdown.pages ? '#4b5563' : '#fff', cursor: revPage >= revBreakdown.pages ? 'default' : 'pointer', fontSize: 13 }}>Next →</button>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="adm-empty">No fee transactions for this period</p>
                )}
              </div>

              {/* ── Monthly volume breakdown ── */}
              <div className="adm-card">
                <div className="adm-card-header"><h3>Monthly Volume</h3></div>
                {analytics?.monthly_volumes?.length > 0 ? (
                  <div className="adm-table-wrap">
                    <table className="adm-table">
                      <thead>
                        <tr><th>Month</th><th>Buy Volume</th><th>Sell Volume</th><th>Total Volume</th><th>Trades</th><th>Profit</th></tr>
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
                          <span className={`adm-badge ${wd.status === 'completed' ? 'green' : wd.status === 'failed' || wd.status === 'cancelled' ? 'red' : 'yellow'}`}>
                            {wd.status === 'completed' ? 'Completed' : wd.status === 'failed' ? 'Failed' : wd.status === 'cancelled' ? 'Cancelled' : 'Pending'}
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
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button disabled={wdActionLoading === wd.id} onClick={() => handleMarkComplete(wd.id)}
                                style={{ padding: '5px 14px', borderRadius: 6, border: 'none', background: '#10b981', color: '#000', fontWeight: 600, fontSize: 12, cursor: 'pointer', opacity: wdActionLoading === wd.id ? 0.6 : 1 }}>
                                {wdActionLoading === wd.id ? '...' : '✓ Mark Complete'}
                              </button>
                              <button disabled={wdActionLoading === wd.id} onClick={() => handleDeleteWithdrawal(wd.id)}
                                style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid #ef4444', background: 'transparent', color: '#ef4444', fontSize: 12, cursor: 'pointer', opacity: wdActionLoading === wd.id ? 0.6 : 1 }}>
                                {wdActionLoading === wd.id ? '...' : '✕ Remove'}
                              </button>
                            </div>
                          ) : wd.status === 'cancelled' ? (
                            <button disabled={wdActionLoading === wd.id} onClick={() => handleDeleteWithdrawal(wd.id)}
                              style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid #ef4444', background: 'transparent', color: '#ef4444', fontSize: 12, cursor: 'pointer', opacity: wdActionLoading === wd.id ? 0.6 : 1 }}>
                              {wdActionLoading === wd.id ? '...' : '✕ Remove'}
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
            // Fetch IP whitelist + current IP
            if (ipWhitelist.length === 0 && !ipWhitelistEnabled) {
              api.get('/admin/ip-whitelist').then(res => {
                setIpWhitelist(res.data.ips || []);
                setIpWhitelistEnabled(res.data.enabled);
              }).catch(() => {});
            }
            if (!myIp) {
              api.get('/admin/my-ip').then(res => setMyIp(res.data.ip || '')).catch(() => {});
            }
            const securityFeatures = [
              { label: 'Audit Trail', status: 'active', desc: 'All admin/employee access to trader PII is logged with IP and timestamp.' },
              { label: 'Data Masking', status: 'active', desc: 'Phone numbers are masked (07XX XXX 678) for non-admin roles.' },
              { label: 'Role Restrictions', status: 'active', desc: 'Employees cannot view settlement accounts, security answers, or full phone numbers.' },
              { label: 'IP Restriction', status: ipWhitelistEnabled ? 'active' : 'config', desc: ipWhitelistEnabled ? `Admin access restricted to: ${ipWhitelist.join(', ')}` : 'No IP restriction active — all IPs can access admin.' },
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

                {/* IP Whitelist Manager */}
                <div className="adm-card" style={{ marginBottom: 20 }}>
                  <div className="adm-card-header">
                    <h3>IP Whitelist — Admin Access Control</h3>
                    <span className="adm-card-count">{ipWhitelistEnabled ? `${ipWhitelist.length} IP(s) allowed` : 'Disabled — allow all'}</span>
                  </div>
                  <div style={{ padding: '16px 20px 20px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, padding: '10px 14px', background: 'var(--bg)', borderRadius: 8, border: '1px solid var(--border)' }}>
                      <div>
                        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>Your current IP address</div>
                        <div style={{ fontFamily: 'monospace', fontWeight: 700, color: '#f59e0b', fontSize: 14 }}>{myIp || '…'}</div>
                      </div>
                      <button
                        onClick={() => { if (myIp && !ipWhitelist.includes(myIp)) setIpWhitelist(prev => [...prev, myIp]); }}
                        disabled={!myIp || ipWhitelist.includes(myIp)}
                        style={{ padding: '7px 14px', borderRadius: 7, border: 'none', background: (!myIp || ipWhitelist.includes(myIp)) ? '#374151' : '#f59e0b', color: (!myIp || ipWhitelist.includes(myIp)) ? '#6b7280' : '#000', fontWeight: 700, fontSize: 12, cursor: (!myIp || ipWhitelist.includes(myIp)) ? 'default' : 'pointer' }}>
                        {ipWhitelist.includes(myIp) ? '✓ Already added' : '+ Add My IP'}
                      </button>
                    </div>
                    <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 14 }}>
                      Your current IP is always auto-included when saving — you cannot lock yourself out. Leave list empty to allow all IPs.
                    </p>

                    {/* Current IPs */}
                    {ipWhitelist.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
                        {ipWhitelist.map(ip => (
                          <div key={ip} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(16,185,129,0.1)', border: '1px solid #10b981', borderRadius: 6, padding: '4px 10px', fontSize: 13 }}>
                            <span style={{ fontFamily: 'monospace', color: '#10b981' }}>{ip}</span>
                            <button onClick={() => setIpWhitelist(prev => prev.filter(x => x !== ip))}
                              style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1 }}>×</button>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Add IP input */}
                    <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
                      <input
                        value={ipInput}
                        onChange={e => setIpInput(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && ipInput.trim()) {
                            setIpWhitelist(prev => prev.includes(ipInput.trim()) ? prev : [...prev, ipInput.trim()]);
                            setIpInput('');
                          }
                        }}
                        placeholder="e.g. 102.219.208.126"
                        style={{ flex: 1, padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 13, fontFamily: 'monospace' }}
                      />
                      <button
                        onClick={() => { if (ipInput.trim()) { setIpWhitelist(prev => prev.includes(ipInput.trim()) ? prev : [...prev, ipInput.trim()]); setIpInput(''); } }}
                        style={{ padding: '9px 18px', borderRadius: 8, border: 'none', background: '#374151', color: '#fff', fontSize: 13, cursor: 'pointer' }}>
                        + Add
                      </button>
                    </div>

                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <button
                        disabled={ipSaving}
                        onClick={async () => {
                          setIpSaving(true); setIpMsg('');
                          try {
                            await api.post('/admin/ip-whitelist', { ips: ipWhitelist });
                            setIpWhitelistEnabled(ipWhitelist.length > 0);
                            setIpMsg(ipWhitelist.length > 0 ? `Saved — ${ipWhitelist.length} IP(s) whitelisted` : 'Saved — IP restriction disabled');
                          } catch (e) {
                            setIpMsg(e.response?.data?.detail || 'Failed to save');
                          }
                          setIpSaving(false);
                        }}
                        style={{ padding: '9px 22px', borderRadius: 8, border: 'none', background: ipSaving ? '#374151' : '#10b981', color: '#000', fontWeight: 700, fontSize: 13, cursor: ipSaving ? 'default' : 'pointer' }}>
                        {ipSaving ? 'Saving...' : 'Save Whitelist'}
                      </button>
                      {ipWhitelist.length > 0 && (
                        <button onClick={() => setIpWhitelist([])}
                          style={{ padding: '9px 16px', borderRadius: 8, border: '1px solid #ef4444', background: 'transparent', color: '#ef4444', fontSize: 13, cursor: 'pointer' }}>
                          Clear All
                        </button>
                      )}
                      {ipMsg && <span style={{ fontSize: 12, color: ipMsg.includes('Failed') ? '#ef4444' : '#10b981' }}>{ipMsg}</span>}
                    </div>
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
                  ) : (() => {
                    const totalPages = Math.ceil(auditLogs.length / AUDIT_PER_PAGE);
                    const pageLogs = auditLogs.slice((auditPage - 1) * AUDIT_PER_PAGE, auditPage * AUDIT_PER_PAGE);
                    return (
                      <>
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
                              {pageLogs.map(log => (
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
                        {totalPages > 1 && (
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
                            <span style={{ fontSize: 12, color: '#6b7280' }}>
                              Showing {(auditPage - 1) * AUDIT_PER_PAGE + 1}–{Math.min(auditPage * AUDIT_PER_PAGE, auditLogs.length)} of {auditLogs.length} entries
                            </span>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button onClick={() => setAuditPage(p => Math.max(1, p - 1))} disabled={auditPage === 1}
                                style={{ padding: '5px 14px', borderRadius: 6, border: '1px solid var(--border)', background: auditPage === 1 ? 'transparent' : 'var(--bg)', color: auditPage === 1 ? '#4b5563' : '#fff', cursor: auditPage === 1 ? 'default' : 'pointer', fontSize: 12 }}>
                                ← Prev
                              </button>
                              <span style={{ padding: '5px 12px', fontSize: 12, color: '#9ca3af' }}>Page {auditPage} of {totalPages}</span>
                              <button onClick={() => setAuditPage(p => Math.min(totalPages, p + 1))} disabled={auditPage === totalPages}
                                style={{ padding: '5px 14px', borderRadius: 6, border: '1px solid var(--border)', background: auditPage === totalPages ? 'transparent' : 'var(--bg)', color: auditPage === totalPages ? '#4b5563' : '#fff', cursor: auditPage === totalPages ? 'default' : 'pointer', fontSize: 12 }}>
                                Next →
                              </button>
                            </div>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
              </div>
            );
          })()}

          {/* ==================== AUTO-SWEEPS ==================== */}
          {activeTab === 'withdrawals' && (
            <div className="adm-card" style={{ marginTop: 20 }}>
              <div className="adm-card-header" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 16 }}>⚡</span> Auto-Sweeps
                  <span style={{ fontSize: 11, background: 'rgba(16,185,129,0.15)', color: '#10b981', borderRadius: 6, padding: '2px 8px', fontWeight: 400 }}>
                    Paybill 4041355 → I&M Bank
                  </span>
                </h3>
                {/* Status filter */}
                <div style={{ display: 'flex', gap: 4, background: 'var(--bg)', borderRadius: 8, padding: 4, border: '1px solid var(--border)', marginLeft: 'auto' }}>
                  {[['all','All'], ['pending','Pending'], ['completed','Completed'], ['failed','Failed']].map(([val, label]) => (
                    <button key={val} onClick={() => { setSweepSubTab(val); loadSweeps(val); }}
                      style={{ padding: '5px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                        background: sweepSubTab === val ? (val === 'failed' ? '#ef4444' : val === 'completed' ? '#10b981' : '#f59e0b') : 'transparent',
                        color: sweepSubTab === val ? '#000' : 'var(--text-muted)' }}>
                      {label}
                    </button>
                  ))}
                </div>
                <button onClick={() => loadSweeps(sweepSubTab)} style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>
                  ↺ Refresh
                </button>
              </div>

              {sweepsLoading ? (
                <div style={{ padding: 24, textAlign: 'center', color: '#6b7280' }}>Loading sweeps...</div>
              ) : sweeps.length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center', color: '#6b7280', fontSize: 13 }}>
                  No sweeps yet. Sweeps are triggered automatically when traders withdraw.
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border)', color: '#6b7280', fontSize: 11 }}>
                        <th style={{ padding: '8px 12px', textAlign: 'left' }}>ID</th>
                        <th style={{ padding: '8px 12px', textAlign: 'left' }}>Amount</th>
                        <th style={{ padding: '8px 12px', textAlign: 'left' }}>Status</th>
                        <th style={{ padding: '8px 12px', textAlign: 'left' }}>Destination</th>
                        <th style={{ padding: '8px 12px', textAlign: 'left' }}>M-Pesa Ref</th>
                        <th style={{ padding: '8px 12px', textAlign: 'left' }}>Initiated</th>
                        <th style={{ padding: '8px 12px', textAlign: 'left' }}>Completed</th>
                        <th style={{ padding: '8px 12px', textAlign: 'left' }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {sweeps.map(sw => (
                        <tr key={sw.id} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td style={{ padding: '10px 12px', color: '#6b7280' }}>#{sw.id}</td>
                          <td style={{ padding: '10px 12px', fontWeight: 700, color: '#fff' }}>
                            KES {sw.amount?.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                          </td>
                          <td style={{ padding: '10px 12px' }}>
                            <span style={{
                              fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
                              background: sw.status === 'completed' ? 'rgba(16,185,129,0.15)' : sw.status === 'failed' ? 'rgba(239,68,68,0.15)' : 'rgba(245,158,11,0.15)',
                              color: sw.status === 'completed' ? '#10b981' : sw.status === 'failed' ? '#ef4444' : '#f59e0b',
                            }}>
                              {sw.status}
                            </span>
                            {sw.status === 'failed' && sw.failure_reason && (
                              <div style={{ fontSize: 10, color: '#ef4444', marginTop: 3 }}>{sw.failure_reason.substring(0, 60)}</div>
                            )}
                          </td>
                          <td style={{ padding: '10px 12px', color: '#9ca3af', fontSize: 12 }}>
                            Paybill {sw.sweep_paybill}<br />
                            <span style={{ color: '#6b7280' }}>Acc: {sw.sweep_account}</span>
                          </td>
                          <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontSize: 11, color: '#6b7280' }}>
                            {sw.mpesa_conversation_id ? sw.mpesa_conversation_id.substring(0, 20) + '...' : '—'}
                          </td>
                          <td style={{ padding: '10px 12px', color: '#6b7280', fontSize: 11 }}>
                            {sw.created_at ? new Date(sw.created_at).toLocaleString('en-KE', { dateStyle: 'short', timeStyle: 'short' }) : '—'}
                          </td>
                          <td style={{ padding: '10px 12px', color: '#6b7280', fontSize: 11 }}>
                            {sw.completed_at ? new Date(sw.completed_at).toLocaleString('en-KE', { dateStyle: 'short', timeStyle: 'short' }) : '—'}
                          </td>
                          <td style={{ padding: '10px 12px' }}>
                            {sw.status === 'failed' && (
                              <button
                                onClick={() => handleRetrySweep(sw.id)}
                                disabled={sweepRetrying === sw.id}
                                style={{ padding: '4px 12px', borderRadius: 6, border: 'none', background: '#f59e0b', color: '#000', fontWeight: 700, fontSize: 11, cursor: 'pointer', opacity: sweepRetrying === sw.id ? 0.6 : 1 }}>
                                {sweepRetrying === sw.id ? '...' : 'Retry'}
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ==================== PAYBILL TRANSACTIONS ==================== */}
          {activeTab === 'paybill' && (
            <div>
              {/* Summary Cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16, marginBottom: 20 }}>
                {[
                  { label: 'Total In (C2B)', value: `KES ${(paybillTxs.summary?.total_in || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`, count: paybillTxs.summary?.count_in || 0, color: '#10b981' },
                  { label: 'Total Out (B2C/B2B)', value: `KES ${(paybillTxs.summary?.total_out || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`, count: paybillTxs.summary?.count_out || 0, color: '#ef4444' },
                  { label: 'Total Transactions', value: paybillTxs.summary?.total || 0, count: null, color: '#f59e0b' },
                ].map(card => (
                  <div key={card.label} className="adm-card" style={{ padding: '16px 20px' }}>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>{card.label}</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: card.color }}>{card.value}</div>
                    {card.count !== null && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>{card.count} transactions</div>}
                  </div>
                ))}
              </div>

              {/* Table */}
              <div className="adm-card">
                <div className="adm-card-header" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Banknote size={18} /> Paybill 4041355 — All Transactions
                  </h3>
                  {/* Period filter */}
                  <div style={{ display: 'flex', gap: 4, background: 'var(--bg)', borderRadius: 8, padding: 4, border: '1px solid var(--border)' }}>
                    {[['today','Today'], ['week','This Week'], ['month','This Month'], ['year','This Year'], ['all','All Time']].map(([val, label]) => (
                      <button key={val} onClick={() => { setPaybillPeriod(val); setPaybillPage(1); loadPaybillTxs(val, 1); }}
                        style={{ padding: '5px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                          background: paybillPeriod === val ? '#f59e0b' : 'transparent',
                          color: paybillPeriod === val ? '#000' : 'var(--text-muted)' }}>
                        {label}
                      </button>
                    ))}
                  </div>
                  <button onClick={() => loadPaybillTxs(paybillPeriod, paybillPage)}
                    style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontSize: 12, marginLeft: 'auto' }}>
                    ↺ Refresh
                  </button>
                </div>

                {paybillLoading ? (
                  <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>Loading...</div>
                ) : paybillTxs.transactions.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>No transactions found for this period.</div>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--border)', color: '#6b7280', fontSize: 11 }}>
                          <th style={{ padding: '8px 12px', textAlign: 'left' }}>Date & Time</th>
                          <th style={{ padding: '8px 12px', textAlign: 'left' }}>Direction</th>
                          <th style={{ padding: '8px 12px', textAlign: 'left' }}>Amount (KES)</th>
                          <th style={{ padding: '8px 12px', textAlign: 'left' }}>Phone / Destination</th>
                          <th style={{ padding: '8px 12px', textAlign: 'left' }}>Name</th>
                          <th style={{ padding: '8px 12px', textAlign: 'left' }}>Trader</th>
                          <th style={{ padding: '8px 12px', textAlign: 'left' }}>M-PESA Receipt</th>
                          <th style={{ padding: '8px 12px', textAlign: 'left' }}>Status</th>
                          <th style={{ padding: '8px 12px', textAlign: 'left' }}>Remarks</th>
                        </tr>
                      </thead>
                      <tbody>
                        {paybillTxs.transactions.map(tx => {
                          const isIn = tx.direction === 'inbound';
                          return (
                            <tr key={tx.id} style={{ borderBottom: '1px solid var(--border)' }}>
                              <td style={{ padding: '10px 12px', color: '#9ca3af', fontSize: 11, whiteSpace: 'nowrap' }}>
                                {tx.created_at ? new Date(tx.created_at).toLocaleString('en-KE', { dateStyle: 'short', timeStyle: 'short' }) : '—'}
                              </td>
                              <td style={{ padding: '10px 12px' }}>
                                <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
                                  background: isIn ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                                  color: isIn ? '#10b981' : '#ef4444' }}>
                                  {isIn ? '↓ IN' : '↑ OUT'}
                                </span>
                              </td>
                              <td style={{ padding: '10px 12px', fontWeight: 700, color: isIn ? '#10b981' : '#ef4444' }}>
                                {isIn ? '+' : '-'}KES {(tx.amount || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                              </td>
                              <td style={{ padding: '10px 12px', color: '#9ca3af', fontSize: 12 }}>
                                {isIn ? tx.phone : (tx.destination || tx.phone || '—')}
                                {tx.bill_ref && <div style={{ fontSize: 10, color: '#6b7280' }}>Ref: {tx.bill_ref}</div>}
                              </td>
                              <td style={{ padding: '10px 12px', fontSize: 12, color: '#fff' }}>
                                {tx.sender_name || '—'}
                              </td>
                              <td style={{ padding: '10px 12px', fontSize: 11, color: '#9ca3af' }}>
                                {tx.trader_name || '—'}
                              </td>
                              <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontSize: 11, color: '#6b7280' }}>
                                {tx.mpesa_receipt || '—'}
                              </td>
                              <td style={{ padding: '10px 12px' }}>
                                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 12,
                                  background: tx.status === 'completed' ? 'rgba(16,185,129,0.15)' : tx.status === 'failed' ? 'rgba(239,68,68,0.15)' : 'rgba(245,158,11,0.15)',
                                  color: tx.status === 'completed' ? '#10b981' : tx.status === 'failed' ? '#ef4444' : '#f59e0b' }}>
                                  {tx.status || '—'}
                                </span>
                              </td>
                              <td style={{ padding: '10px 12px', fontSize: 11, color: '#6b7280', maxWidth: 180 }}>
                                {tx.remarks || '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Pagination */}
                {paybillTxs.pages > 1 && (
                  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, padding: '16px 0', borderTop: '1px solid var(--border)' }}>
                    <button onClick={() => { const p = Math.max(1, paybillPage - 1); setPaybillPage(p); loadPaybillTxs(paybillPeriod, p); }}
                      disabled={paybillPage === 1}
                      style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: paybillPage === 1 ? '#4b5563' : 'var(--text)', cursor: paybillPage === 1 ? 'not-allowed' : 'pointer' }}>
                      ← Prev
                    </button>
                    <span style={{ color: '#6b7280', fontSize: 13 }}>Page {paybillPage} of {paybillTxs.pages}</span>
                    <button onClick={() => { const p = Math.min(paybillTxs.pages, paybillPage + 1); setPaybillPage(p); loadPaybillTxs(paybillPeriod, p); }}
                      disabled={paybillPage === paybillTxs.pages}
                      style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: paybillPage === paybillTxs.pages ? '#4b5563' : 'var(--text)', cursor: paybillPage === paybillTxs.pages ? 'not-allowed' : 'pointer' }}>
                      Next →
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ==================== SETTINGS ==================== */}
          {activeTab === 'settings' && (
            <div>
              {smsBalance === null && !smsBalanceLoading && (() => { setSmsBalanceLoading(true); api.get('/admin/sms-balance').then(res => setSmsBalance(res.data)).catch(() => {}).finally(() => setSmsBalanceLoading(false)); return null; })()}
              {/* SMS Credits */}
              <div className="adm-card" style={{ marginBottom: 20 }}>
                <div className="adm-card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <MessageSquare size={18} /> SMS Credits — Advanta
                  </h3>
                  <button
                    className="adm-btn-secondary"
                    style={{ fontSize: 12, padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 4 }}
                    disabled={smsBalanceLoading}
                    onClick={() => {
                      setSmsBalanceLoading(true);
                      api.get('/admin/sms-balance').then(res => setSmsBalance(res.data)).catch(() => {}).finally(() => setSmsBalanceLoading(false));
                    }}
                  >
                    <RefreshCw size={13} style={{ animation: smsBalanceLoading ? 'spin 1s linear infinite' : 'none' }} />
                    {smsBalanceLoading ? 'Checking…' : 'Refresh'}
                  </button>
                </div>
                <div style={{ padding: '0 16px 16px' }}>
                  {/* Balance display */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
                    <div style={{
                      fontSize: 36, fontWeight: 700, fontFamily: 'monospace',
                      color: smsBalance === null ? '#6b7280'
                        : smsBalance.credits < 50 ? '#ef4444'
                        : smsBalance.credits < 100 ? '#f59e0b'
                        : '#4ade80',
                    }}>
                      {smsBalance === null ? '—' : smsBalance.credits.toLocaleString()}
                    </div>
                    <div>
                      <div style={{ fontSize: 13, color: '#9ca3af' }}>SMS credits remaining</div>
                      {smsBalance !== null && (
                        <div style={{
                          fontSize: 12, marginTop: 2, fontWeight: 600,
                          color: smsBalance.low ? '#f59e0b' : '#4ade80',
                        }}>
                          {smsBalance.low ? '⚠ Low balance — top up soon' : 'Balance OK'}
                        </div>
                      )}
                    </div>
                    {smsBalance === null && (
                      <button
                        className="adm-btn-secondary"
                        style={{ fontSize: 12, padding: '6px 14px' }}
                        onClick={() => {
                          setSmsBalanceLoading(true);
                          api.get('/admin/sms-balance').then(res => setSmsBalance(res.data)).catch(() => {}).finally(() => setSmsBalanceLoading(false));
                        }}
                      >
                        Check Balance
                      </button>
                    )}
                  </div>

                  {/* Top-up info */}
                  <div style={{
                    background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: '12px 14px',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}>
                    <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>Top Up via M-Pesa</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      <div>
                        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 2 }}>Paybill Number</div>
                        <div style={{ fontSize: 18, fontWeight: 700, color: '#e5e7eb', fontFamily: 'monospace', letterSpacing: 1 }}>969610</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 2 }}>Account Number</div>
                        <div style={{ fontSize: 18, fontWeight: 700, color: '#e5e7eb', fontFamily: 'monospace', letterSpacing: 1 }}>SparkAI</div>
                      </div>
                    </div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 8 }}>
                      Use Paybill <strong style={{ color: '#9ca3af' }}>969610</strong>, Account <strong style={{ color: '#9ca3af' }}>SparkAI</strong> to top up Advanta SMS credits. Credits are added within minutes.
                    </div>
                  </div>
                </div>
              </div>

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
