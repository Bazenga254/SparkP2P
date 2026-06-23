import { useState, useEffect, useRef } from 'react';
import api from '../services/api';
import { getAdminDashboard, getAdminTraders, getDisputedOrders, getUnmatchedPayments, updateTraderStatus, updateTraderTier, getAdminTransactions, getAdminOrders, getAdminAnalytics, getAdminOnlineTraders, getMessageTemplates, updateMessageTemplate, seedMessageTemplates, getAdminSupportTickets, closeSupportTicket, replyToSupportTicket, uploadSupportAttachment, getAdminWithdrawals, markWithdrawalComplete, markWithdrawalPending, deleteWithdrawal, getRevenueBreakdown, getSubscriptionRevenue, getAdminSweeps, retrySweep, getAdminPaybillTransactions, getTraderPnl, verifyTotp, resolveUnmatchedPayment } from '../services/api';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { RefreshCw, LogOut, LayoutDashboard, Users, AlertTriangle, Banknote, TrendingUp, Settings, UserCheck, ShoppingCart, CheckCircle, Activity, AlertCircle, ArrowRightLeft, DollarSign, Wifi, Repeat, MessageSquare, Save, RotateCcw, ChevronDown, ChevronUp, Copy, Shield, Wallet, Paperclip, X, Building2, Smartphone, Eye, EyeOff, Lock, Share2, Check, XCircle, Receipt, PlusCircle, Trash2, MoreHorizontal } from 'lucide-react';
import { getProfile, getSurveyResponses, sendSurveyInvite, getEmployees, updateEmployeePermissions, deleteEmployee, deleteTrader, getAdminTraderBotLogs, adminGetKycTraders, adminGetKycLiveStatus, adminGetTraderChoiceBalance, adminGetChoicePlatformFloat, adminGetExpenses, adminPostExpense, adminDeleteExpense } from '../services/api';

const sidebarSections = [
  {
    label: 'OVERVIEW',
    items: [
      { key: 'dashboard', icon: LayoutDashboard, label: 'Dashboard' },
      { key: 'transactions', icon: ArrowRightLeft, label: 'Transactions' },
      { key: 'withdrawals', icon: Wallet, label: 'Withdrawals' },
      { key: 'paybill', icon: DollarSign, label: 'Subscriptions' },
    ],
  },
  {
    label: 'TRADERS',
    items: [
      { key: 'traders', icon: Users, label: 'All Traders' },
      { key: 'disputes', icon: AlertTriangle, label: 'Disputes' },
      { key: 'unmatched', icon: Banknote, label: 'Unmatched Payments' },
      { key: 'affiliates', icon: Share2, label: 'Affiliates' },
      { key: 'kyc', icon: UserCheck, label: 'KYC Verification' },
    ],
  },
  {
    label: 'PLATFORM',
    items: [
      { key: 'expenses', icon: Receipt, label: 'Expenses' },
      { key: 'security', icon: Shield, label: 'Security' },
      { key: 'settings', icon: Settings, label: 'Settings' },
    ],
  },
  {
    label: 'OUTREACH',
    items: [
      { key: 'survey', icon: MessageSquare, label: 'Survey Responses' },
    ],
  },
];

const fmtDateEAT = (ts) => new Date(ts).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });

// Friendly labels for audit-log actions (raw snake_case → readable). Unknown actions fall back
// to title-cased words. Actions in AUDIT_DANGER render in red (failures / denials / locks).
const AUDIT_ACTION_LABELS = {
  admin_login: 'Admin login', employee_login: 'Staff login',
  admin_login_failed: 'Admin login — FAILED', employee_login_failed: 'Staff login — FAILED',
  admin_login_locked: 'Admin account LOCKED', employee_login_locked: 'Staff account LOCKED',
  change_role: 'Changed role', change_status: 'Changed status',
  change_subscription: 'Changed subscription', toggle_price_tracker: 'Toggled price tracker',
  reset_trader_password: 'Reset trader password', resolve_payment: 'Resolved payment',
  denied_action: 'DENIED action', list_traders: 'Viewed traders list',
  view_trader_detail: 'Viewed trader detail',
};
const fmtAuditAction = (a) => AUDIT_ACTION_LABELS[a] || (a || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const isAuditDanger = (a) => /denied|failed|locked|suspend/i.test(a || '');
const fmtTimeEAT = (ts) => new Date(ts).toLocaleTimeString('en-KE', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDateOnlyEAT = (ts) => new Date(ts).toLocaleDateString('en-KE', { timeZone: 'Africa/Nairobi' });

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

// Polls Choice Bank balance every 10s for a given trader (auto-start on mount)
function CbBalancePoller({ traderId, onData }) {
  useEffect(() => {
    if (!traderId) return;
    let active = true;
    const fetchBalance = () => {
      adminGetTraderChoiceBalance(traderId)
        .then(r => { if (active) onData(r.data); })
        .catch(() => {});
    };
    fetchBalance();
    const iv = setInterval(fetchBalance, 10000);
    return () => { active = false; clearInterval(iv); };
  }, [traderId]);
  return null;
}


// Admin SMS composer — send a custom message to one customer or broadcast to everyone.
function AdminSmsModal({ target, onClose }) {
  const [msg, setMsg] = useState('');
  const [broadcast, setBroadcast] = useState(!!target.broadcast);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const send = async () => {
    setBusy(true); setError('');
    try {
      const body = broadcast ? { message: msg, broadcast: true } : { message: msg, trader_id: target.traderId };
      const r = await api.post('/admin/sms/send', body);
      setResult(r.data);
    } catch (e) { setError(e?.response?.data?.detail || 'Failed to send SMS.'); }
    finally { setBusy(false); }
  };
  const ov = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
  const card = { background: '#1a1d2e', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 16, padding: 24, width: '100%', maxWidth: 460, boxShadow: '0 20px 60px rgba(0,0,0,0.5)' };
  return (
    <div style={ov} onClick={onClose}>
      <div style={card} onClick={e => e.stopPropagation()}>
        <h3 style={{ margin: 0, color: '#fff', fontSize: 18 }}>Send SMS</h3>
        <p style={{ color: '#9aa4b2', fontSize: 12.5, margin: '6px 0 14px' }}>
          {broadcast ? 'This message goes to ALL customers with a phone number.' : `To ${target.name || 'this customer'}.`}
        </p>
        {result ? (
          <>
            <div style={{ color: '#10b981', fontSize: 14, marginBottom: 14 }}>✅ Sent {result.sent} / {result.total}{result.failed ? ` · ${result.failed} failed` : ''}</div>
            <button onClick={onClose} style={{ width: '100%', padding: 11, borderRadius: 10, border: 'none', background: '#f59e0b', color: '#1a1205', fontWeight: 800, cursor: 'pointer' }}>Done</button>
          </>
        ) : (
          <>
            {target.traderId && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#9aa4b2', fontSize: 12.5, marginBottom: 10, cursor: 'pointer' }}>
                <input type="checkbox" checked={broadcast} onChange={e => setBroadcast(e.target.checked)} />
                Send to ALL customers instead (broadcast)
              </label>
            )}
            <textarea value={msg} onChange={e => setMsg(e.target.value)} rows={5} maxLength={800} placeholder="Type your message…"
              style={{ width: '100%', padding: 12, borderRadius: 10, background: '#0a0d14', border: '1px solid #2a3142', color: '#fff', fontSize: 13.5, resize: 'vertical', boxSizing: 'border-box' }} />
            <div style={{ textAlign: 'right', color: '#6b7280', fontSize: 11, marginTop: 4 }}>{msg.length}/800</div>
            {error && <div style={{ color: '#ef4444', fontSize: 12.5, marginTop: 6 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button onClick={onClose} style={{ flex: 1, padding: 11, borderRadius: 10, border: '1px solid #2a3142', background: 'transparent', color: '#9aa4b2', fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
              <button disabled={!msg.trim() || busy} onClick={send}
                style={{ flex: 2, padding: 11, borderRadius: 10, border: 'none', background: (!msg.trim() || busy) ? '#3a3f4d' : (broadcast ? '#ef4444' : '#f59e0b'), color: (!msg.trim() || busy) ? '#9aa4b2' : (broadcast ? '#fff' : '#1a1205'), fontWeight: 800, cursor: (!msg.trim() || busy) ? 'default' : 'pointer' }}>
                {busy ? 'Sending…' : (broadcast ? 'Send to everyone' : 'Send SMS')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Admin duration picker for granting / extending a paid subscription. Admin picks a quick
// duration (1/3/6/12 months) or a custom date+time; expiry is sent to the backend as ISO UTC.
function TierGrantModal({ grant, onCancel, onApply }) {
  const tierLabel = grant.tier === 'pro_max' ? 'Starter Pro Max' : grant.tier === 'pro' ? 'Starter Pro' : 'Starter';
  const [mode, setMode] = useState('quick');
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);

  const fromMonths = (n) => { const d = new Date(); d.setMonth(d.getMonth() + n); return d; };
  const fmt = (d) => d.toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' });
  const apply = async (expiryDate) => {
    if (!expiryDate || isNaN(expiryDate.getTime())) return;
    setBusy(true);
    try { await onApply(grant.traderId, grant.tier, expiryDate.toISOString()); }
    catch (e) { alert(e?.response?.data?.detail || 'Could not grant subscription.'); setBusy(false); }
  };
  const QUICK = [['1 month', 1], ['3 months', 3], ['6 months', 6], ['1 year', 12]];
  const ov = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
  const card = { background: '#1a1d2e', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 16, padding: 26, width: '100%', maxWidth: 440, boxShadow: '0 20px 60px rgba(0,0,0,0.5)' };
  const tabBtn = (on) => ({ flex: 1, padding: '8px 0', borderRadius: 9, border: on ? '1px solid #f59e0b' : '1px solid #2a3142', background: on ? 'rgba(245,158,11,0.12)' : '#0e1320', color: on ? '#f59e0b' : '#9aa4b2', fontWeight: 700, fontSize: 12.5, cursor: 'pointer' });

  return (
    <div style={ov} onClick={onCancel}>
      <div style={card} onClick={e => e.stopPropagation()}>
        <h3 style={{ margin: 0, color: '#fff', fontSize: 18 }}>Grant {tierLabel}</h3>
        <p style={{ color: '#9aa4b2', fontSize: 12.5, margin: '6px 0 16px' }}>Choose how long this subscription stays active. It expires at the exact date &amp; time you pick.</p>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <button style={tabBtn(mode === 'quick')} onClick={() => setMode('quick')}>Quick</button>
          <button style={tabBtn(mode === 'custom')} onClick={() => setMode('custom')}>Custom date</button>
        </div>
        {mode === 'quick' ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {QUICK.map(([l, n]) => {
              const d = fromMonths(n);
              return (
                <button key={l} disabled={busy} onClick={() => apply(d)}
                  style={{ padding: '12px 10px', borderRadius: 11, border: '1px solid #2a3142', background: '#0e1320', color: '#e5e7eb', cursor: 'pointer', textAlign: 'left' }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{l}</div>
                  <div style={{ fontSize: 10.5, color: '#7d8794', marginTop: 3 }}>until {fmt(d)}</div>
                </button>
              );
            })}
          </div>
        ) : (
          <>
            <label style={{ display: 'block', color: '#9aa4b2', fontSize: 11.5, marginBottom: 6 }}>Expiry date &amp; time</label>
            <input type="datetime-local" value={custom} onChange={e => setCustom(e.target.value)}
              style={{ width: '100%', padding: '11px 12px', borderRadius: 10, background: '#0a0d14', border: '1px solid #2a3142', color: '#fff', fontSize: 14, colorScheme: 'dark' }} />
            <button disabled={!custom || busy} onClick={() => apply(new Date(custom))}
              style={{ width: '100%', marginTop: 14, padding: '12px', borderRadius: 11, border: 'none', background: (!custom || busy) ? '#3a3f4d' : '#f59e0b', color: (!custom || busy) ? '#9aa4b2' : '#1a1205', fontWeight: 800, fontSize: 14, cursor: (!custom || busy) ? 'default' : 'pointer' }}>
              {busy ? 'Granting…' : `Grant until ${custom ? fmt(new Date(custom)) : '…'}`}
            </button>
          </>
        )}
        <button onClick={onCancel} style={{ width: '100%', marginTop: 10, padding: '10px', borderRadius: 10, border: '1px solid #2a3142', background: 'transparent', color: '#9aa4b2', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
      </div>
    </div>
  );
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
  const [imAccountInput, setImAccountInput] = useState('');
  const [imAccountSaving, setImAccountSaving] = useState(false);
  const [imAccountMsg, setImAccountMsg] = useState('');
  const [resolveRef, setResolveRef] = useState('');
  const [resolveAmount, setResolveAmount] = useState('');
  const [resolveLoading, setResolveLoading] = useState(false);
  const [resolveMsg, setResolveMsg] = useState({ text: '', type: '' });
  // Full-page trader detail view
  const [viewingTrader, setViewingTrader] = useState(null);
  const [viewingTraderWallet, setViewingTraderWallet] = useState(null);
  // KYC admin state
  const [kycTraders, setKycTraders] = useState([]);
  const [kycLiveResult, setKycLiveResult] = useState(null);
  const [kycLiveLoading, setKycLiveLoading] = useState(false);
  const [choiceFloat, setChoiceFloat] = useState(null);
  const [choiceFloatLoading, setChoiceFloatLoading] = useState(false);
  const [expenses, setExpenses] = useState([]);
  const [expensesTotal, setExpensesTotal] = useState(0);
  const [expenseForm, setExpenseForm] = useState({ description: '', amount: '', category: 'general', expense_date: new Date().toISOString().slice(0, 10) });
  const [expenseSubmitting, setExpenseSubmitting] = useState(false);
  const [kycSelectedTrader, setKycSelectedTrader] = useState(null);
  const [cbBalance, setCbBalance] = useState(null);
  const [cbBalanceLoading, setCbBalanceLoading] = useState(false);

  const [viewingTraderTx, setViewingTraderTx] = useState([]);
  const [viewingTraderOrders, setViewingTraderOrders] = useState([]);
  const [viewingTraderLoading, setViewingTraderLoading] = useState(false);
  const [showSecurityAnswer, setShowSecurityAnswer] = useState(false);
  const [traderPnl, setTraderPnl] = useState(null);
  const [pnlPeriod, setPnlPeriod] = useState('today');
  const [pnlLoading, setPnlLoading] = useState(false);
  // Outbound-fee revenue simulation (buy orders)
  const [traderRevSim, setTraderRevSim] = useState(null);
  const [revSimPeriod, setRevSimPeriod] = useState('today');
  const [revSimMethod, setRevSimMethod] = useState('auto'); // auto | mpesa | pesalink
  const [revSimLoading, setRevSimLoading] = useState(false);
  // Total Trades / Volume period filter (24h | 7d | 30d | all) — default to today (since 03:00 EAT reset)
  const [activityPeriod, setActivityPeriod] = useState('24h');
  const [activity, setActivity] = useState(null); // { trades, volume } for the selected window
  const [activityLoading, setActivityLoading] = useState(false);
  const [revMode, setRevMode] = useState(localStorage.getItem('sparkp2p_revenue_mode') || 'sim'); // 'sim' | 'prod'
  const [txPage, setTxPage] = useState(1);
  const [ordersPage, setOrdersPage] = useState(1);
  const [ledgerTab, setLedgerTab] = useState('activity');
  const PAGE_SIZE = 15;
  const [addTokensAmount, setAddTokensAmount] = useState('');
  const [addTokensNote, setAddTokensNote] = useState('');
  const [addTokensLoading, setAddTokensLoading] = useState(false);
  const [addTokensMsg, setAddTokensMsg] = useState('');
  const [traderBotLogs, setTraderBotLogs] = useState([]);
  const [botLogsLoading, setBotLogsLoading] = useState(false);
  const [disputes, setDisputes] = useState([]);
  const [resolveModal, setResolveModal] = useState(null); // { dispute }
  const [resolveAction, setResolveAction] = useState('cancel');
  const [resolveNote, setResolveNote] = useState('');
  const [resolving, setResolving] = useState(false);
  const [unmatched, setUnmatched] = useState({ deposits: [], withdrawals: [] });
  const [unmatchedTab, setUnmatchedTab] = useState('deposits');
  const [analytics, setAnalytics] = useState(null);
  const [chartTip, setChartTip] = useState(null); // hover tooltip for monthly volume bars
  const [onlineTraders, setOnlineTraders] = useState([]);
  const [transactions, setTransactions] = useState({ total: 0, transactions: [] });
  const [orders, setOrders] = useState({ total: 0, orders: [] });
  const [txPeriod, setTxPeriod] = useState('today');   // fiat period
  const [cryptoPeriod, setCryptoPeriod] = useState('all'); // crypto period — default all
  const [txType, setTxType] = useState('fiat'); // 'fiat' | 'crypto'
  const [ordersSearch, setOrdersSearch] = useState('');
  const [cryptoPage, setCryptoPage] = useState(1);
  const [fiatPage, setFiatPage] = useState(1);
  const [fiatDirFilter, setFiatDirFilter] = useState('all');
  const [txLastUpdated, setTxLastUpdated] = useState(null);
  const [fiatLastUpdated, setFiatLastUpdated] = useState(null);
  const PAGE_TX_SIZE = 25;
  const [activeTab, setActiveTab] = useState('dashboard');
  const [mobMoreOpen, setMobMoreOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [auditLogs, setAuditLogs] = useState([]);
  const [auditImportantOnly, setAuditImportantOnly] = useState(true);
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
  const [auditAlerts, setAuditAlerts] = useState(0);
  const [ticketCategory, setTicketCategory] = useState('open'); // 'open' | 'closed'
  const [ticketPage, setTicketPage] = useState(1);
  const [ticketTotal, setTicketTotal] = useState(0);
  const [ticketPages, setTicketPages] = useState(1);
  const TICKET_PAGE_SIZE = 20;

  // Withdrawals
  const [withdrawals, setWithdrawals] = useState({ withdrawals: [], total: 0, pages: 1, summary: {} });
  const [wdMethod, setWdMethod] = useState('all');   // all | mpesa
  const [wdStatus, setWdStatus] = useState('all');   // all | pending | completed
  const [wdPeriod, setWdPeriod] = useState('all');
  const [wdPage, setWdPage] = useState(1);
  const [wdLoading, setWdLoading] = useState(false);
  const [wdActionLoading, setWdActionLoading] = useState(null); // tx id being actioned

  // Revenue breakdown
  const [revBreakdown, setRevBreakdown] = useState(null);
  const [revPeriod, setRevPeriod] = useState('all');
  const [revPlan, setRevPlan] = useState('all');
  const [revPage, setRevPage] = useState(1);
  const [revLoading, setRevLoading] = useState(false);
  const [expSubView, setExpSubView] = useState('revenue');

  // Auto-Sweeps (M-Pesa paybill → I&M Bank)
  const [sweeps, setSweeps] = useState([]);
  const [sweepsLoading, setSweepsLoading] = useState(false);
  const [sweepRetrying, setSweepRetrying] = useState(null); // sweep id being retried
  const [sweepSubTab, setSweepSubTab] = useState('all'); // all | pending | completed | failed

  const [traderRoleFilter, setTraderRoleFilter] = useState('traders'); // 'traders' | 'employees'
  const [traderSearch, setTraderSearch] = useState('');
  const [traderTierFilter, setTraderTierFilter] = useState('all');
  const [traderBotFilter, setTraderBotFilter] = useState('all');
  const [traderSort, setTraderSort] = useState('volume');
  const [traderDrop, setTraderDrop] = useState(null); // { type, id }
  const [tierGrant, setTierGrant] = useState(null); // { traderId, tier } — open the duration picker
  const [smsTarget, setSmsTarget] = useState(null); // { traderId?, name?, broadcast? } — open SMS composer

  // Employees
  const [employees, setEmployees] = useState([]);
  const [employeesLoading, setEmployeesLoading] = useState(false);
  const [permSaving, setPermSaving] = useState(null); // employee id being saved
  const [empDeleting, setEmpDeleting] = useState(null);
  const [empMsg, setEmpMsg] = useState('');

  // Survey Responses
  const [surveyResponses, setSurveyResponses] = useState([]);
  const [surveyLoading, setSurveyLoading] = useState(false);
  const [surveyFilter, setSurveyFilter] = useState('all'); // all | qualified | disqualified | invited
  const [surveyInviting, setSurveyInviting] = useState(null);
  const [surveyMsg, setSurveyMsg] = useState('');

  // Affiliates
  const [affiliateList, setAffiliateList] = useState([]);
  const [affiliateStats, setAffiliateStats] = useState(null);
  const [affiliateFilter, setAffiliateFilter] = useState('all'); // all | pending | approved | rejected
  const [affiliateLoading, setAffiliateLoading] = useState(false);
  const [affiliateActionMsg, setAffiliateActionMsg] = useState('');

  // Paybill Transactions
  const [paybillTxs, setPaybillTxs] = useState({ transactions: [], total: 0, pages: 1, summary: {} });
  const [paybillPeriod, setPaybillPeriod] = useState('today');
  const [paybillPage, setPaybillPage] = useState(1);
  const [paybillLoading, setPaybillLoading] = useState(false);
  // Subscriptions tab state
  const [subView, setSubView] = useState('plans');
  const [subPeriod, setSubPeriod] = useState('all');
  const [subPage, setSubPage] = useState(1);
  const [subData, setSubData] = useState({ transactions: [], total: 0, pages: 1, summary: {} });
  const [subLoading, setSubLoading] = useState(false);

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

  const loadEmployees = async () => {
    setEmployeesLoading(true);
    try {
      const res = await getEmployees();
      setEmployees(res.data);
    } catch (e) {
      console.error('Employees load error:', e);
    } finally {
      setEmployeesLoading(false);
    }
  };

  const handlePermissionToggle = async (empId, key, value) => {
    const emp = employees.find(e => e.id === empId);
    if (!emp) return;
    const updated = { ...emp.permissions, [key]: value };
    setPermSaving(empId);
    setEmpMsg('');
    try {
      await updateEmployeePermissions(empId, updated);
      setEmployees(prev => prev.map(e => e.id === empId ? { ...e, permissions: updated } : e));
      setEmpMsg('Permissions saved');
      setTimeout(() => setEmpMsg(''), 2500);
    } catch (e) {
      setEmpMsg('Failed to save');
    } finally {
      setPermSaving(null);
    }
  };

  const handleDeleteEmployee = async (empId, name) => {
    if (!confirm(`Delete employee ${name}? This cannot be undone.`)) return;
    setEmpDeleting(empId);
    try {
      await deleteEmployee(empId);
      setEmployees(prev => prev.filter(e => e.id !== empId));
    } catch (e) {
      alert(e?.response?.data?.detail || 'Failed to delete');
    } finally {
      setEmpDeleting(null);
    }
  };

  const handleDeleteTrader = async (traderId, name) => {
    if (!window.confirm(`Permanently delete "${name}"?\n\nThis cannot be undone. Traders with orders cannot be deleted — suspend them instead.`)) return;
    try {
      await deleteTrader(traderId);
      setTraders(prev => prev.filter(t => t.id !== traderId));
    } catch (err) {
      alert(err.response?.data?.detail || 'Delete failed.');
    }
  };

  const loadAffiliates = async () => {
    setAffiliateLoading(true);
    try {
      const [listRes, statsRes] = await Promise.all([
        api.get('/affiliates/admin/list'),
        api.get('/affiliates/admin/stats'),
      ]);
      setAffiliateList(listRes.data.affiliates || []);
      setAffiliateStats(statsRes.data);
    } catch (e) {
      console.error('Failed to load affiliates', e);
    } finally {
      setAffiliateLoading(false);
    }
  };

  const handleAffiliateApprove = async (id) => {
    try {
      const res = await api.post(`/affiliates/admin/${id}/approve`);
      setAffiliateActionMsg(res.data.message);
      loadAffiliates();
    } catch (e) {
      setAffiliateActionMsg(e.response?.data?.detail || 'Error');
    }
    setTimeout(() => setAffiliateActionMsg(''), 4000);
  };

  const handleAffiliateReject = async (id) => {
    const reason = prompt('Rejection reason (optional):') ?? '';
    try {
      await api.post(`/affiliates/admin/${id}/reject`, { reason });
      setAffiliateActionMsg('Rejected');
      loadAffiliates();
    } catch (e) {
      setAffiliateActionMsg(e.response?.data?.detail || 'Error');
    }
    setTimeout(() => setAffiliateActionMsg(''), 4000);
  };

  const loadSurveyResponses = async () => {
    setSurveyLoading(true);
    try {
      const res = await getSurveyResponses();
      setSurveyResponses(res.data);
    } catch (e) {
      console.error('Survey load error:', e);
    } finally {
      setSurveyLoading(false);
    }
  };

  const handleSendSurveyInvite = async (id) => {
    setSurveyInviting(id);
    setSurveyMsg('');
    try {
      const res = await sendSurveyInvite(id);
      const { phone_digits, wa_message } = res.data;
      setSurveyMsg('Opening WhatsApp — paste and send the message!');
      loadSurveyResponses();
      if (phone_digits && wa_message) {
        const url = `https://web.whatsapp.com/send?phone=${phone_digits}&text=${encodeURIComponent(wa_message)}`;
        setTimeout(() => {
          // In Electron, open in system browser (Chrome) — not the Electron window
          if (window.sparkp2p?.openExternal) window.sparkp2p.openExternal(url);
          else window.open(url, '_blank');
        }, 300);
      }
    } catch (e) {
      setSurveyMsg(e?.response?.data?.detail || 'Failed to send invite');
    } finally {
      setSurveyInviting(null);
    }
  };

  const loadSubData = async (view = subView, period = subPeriod, page = subPage) => {
    setSubLoading(true);
    try {
      const res = await getSubscriptionRevenue({ period, page, limit: 50 });
      setSubData(res.data);
    } catch (e) {
      console.error('Subscriptions load error:', e);
    } finally {
      setSubLoading(false);
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

  const loadWithdrawals = async (status = wdStatus, period = wdPeriod, page = wdPage) => {
    setWdLoading(true);
    try {
      const res = await getAdminWithdrawals({ status, period, page, limit: 30 });
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

  const loadRevenueBreakdown = async (period = revPeriod, plan = revPlan, page = revPage) => {
    setRevLoading(true);
    try {
      const res = await getSubscriptionRevenue({ period, plan, page, limit: 50 });
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
      setUnmatched(unmatchedRes.data || { deposits: [], withdrawals: [] });
      setAnalytics(analyticsRes.data);
      setOnlineTraders(onlineRes.data);

      // Fetch cached paybill balance
      try {
        const balRes = await api.get('/payment/balance');
        if (balRes.data?.updated_at) setPaybillBalance(balRes.data);
      } catch(e) {}
      // Fetch Choice Bank platform float
      try {
        setChoiceFloatLoading(true);
        const floatRes = await adminGetChoicePlatformFloat();
        setChoiceFloat(floatRes.data);
      } catch(e) {} finally { setChoiceFloatLoading(false); }
    } catch (err) {
      console.error('Admin load error:', err);
    }
    setRefreshing(false);
  };

  // Lightweight live refresh of just the trader list — keeps the Online / Relay badges current
  // (relay presence goes stale on the server ~70s after a relay stops). No full-page spinner;
  // search / filter / sort live in separate state, so replacing the data here doesn't disturb them.
  const refreshTradersLive = async () => {
    try {
      const [tradersRes, onlineRes] = await Promise.all([getAdminTraders(), getAdminOnlineTraders()]);
      setTraders(tradersRes.data);
      setOnlineTraders(onlineRes.data);
    } catch (_) { /* keep last known on a blip */ }
  };

  // Poll every 30s while viewing the Traders list so badges update without a manual reload.
  useEffect(() => {
    if (activeTab !== 'traders') return;
    const id = setInterval(refreshTradersLive, 30000);
    return () => clearInterval(id);
  }, [activeTab]);

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
    if (activeTab === 'withdrawals') { loadWithdrawals(); }
    if (activeTab === 'paybill') { loadSubData('plans', 'all', 1); }
    if (activeTab === 'survey') { loadSurveyResponses(); }
    if (activeTab === 'kyc') { adminGetKycTraders().then(r => setKycTraders(r.data.traders || [])).catch(() => {}); }
    if (activeTab === 'expenses') { adminGetExpenses().then(r => { setExpenses(r.data.expenses || []); setExpensesTotal(r.data.total || 0); }).catch(() => {}); loadRevenueBreakdown('all', 'all', 1); setExpSubView('revenue'); }
    if (activeTab === 'settings') { loadEmployees(); }
    if (activeTab === 'affiliates') { loadAffiliates(); }
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

  // Super-admin: poll for unseen sensitive staff actions (the audit-alert bell badge).
  useEffect(() => {
    const pollAudit = () => api.get('/admin/audit-notifications')
      .then(r => setAuditAlerts(r.data?.count || 0)).catch(() => {});
    pollAudit();
    const iv = setInterval(pollAudit, 30000);
    return () => clearInterval(iv);
  }, []);

  // Opening the Security (audit) tab marks the alerts as seen.
  useEffect(() => {
    if (activeTab === 'security') {
      api.post('/admin/audit-notifications/seen').catch(() => {});
      setAuditAlerts(0);
    }
  }, [activeTab]);

  useEffect(() => {
    loadData();
    loadTransactions(txPeriod);
    loadOrders(cryptoPeriod);
    loadTemplates();
    const interval = setInterval(loadData, 30000);

    // Web presence heartbeat — admin (also a trader) counts as online while panel is open
    api.post('/traders/web-heartbeat').catch(() => {});
    const heartbeat = setInterval(() => api.post('/traders/web-heartbeat').catch(() => {}), 60000);

    // Paybill balance: SSE for instant updates + trigger initial refresh
    api.post('/payment/balance/refresh').catch(() => {});
    const balanceES = new EventSource('/api/payment/balance/stream');
    balanceES.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data?.updated_at) setPaybillBalance(data);
      } catch {}
    };

    return () => { clearInterval(interval); clearInterval(heartbeat); balanceES.close(); };
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

  // Keep the dashboard's "Recent orders" widget live — it otherwise only loads
  // once on mount and freezes, so new orders never appear until a manual reload.
  useEffect(() => {
    if (activeTab !== 'dashboard') return;
    const poll = setInterval(() => loadOrders(cryptoPeriod, ordersSearch), 15000);
    return () => clearInterval(poll);
  }, [activeTab, cryptoPeriod, ordersSearch]);

  const handleStatusChange = async (traderId, newStatus) => {
    await updateTraderStatus(traderId, newStatus);
    loadData();
  };

  // Paid tiers open a duration picker (admin chooses how long the plan lasts); 'standard'
  // (downgrade to free) applies immediately.
  const handleTierChange = async (traderId, newTier) => {
    if (newTier && newTier !== 'standard') {
      setTierGrant({ traderId, tier: newTier });
      return;
    }
    await updateTraderTier(traderId, newTier);
    loadData();
  };

  // Apply a paid grant with the chosen expiry (ISO). Called from the duration modal.
  const applyTierGrant = async (traderId, tier, expiresAtISO) => {
    await updateTraderTier(traderId, tier, expiresAtISO);
    setTierGrant(null);
    loadData();
    refreshTraderDetail(traderId);
  };

  const handleRoleChange = async (traderId, newRole) => {
    try {
      await api.put(`/admin/traders/${traderId}/role?role=${newRole}`);
      loadData();
    } catch (err) {
      console.error('Failed to update role:', err);
    }
  };

  // Re-pull the full trader detail so derived fields (plan, plan_label, daily
  // limits, expiry) reflect a tier/status change immediately — not just on reload.
  const refreshTraderDetail = async (traderId) => {
    try {
      const r = await api.get(`/admin/traders/${traderId}/detail`);
      setViewingTrader(prev => (prev && prev.id === traderId) ? { ...prev, ...(r.data || {}) } : prev);
    } catch (_) {}
  };

  const loadTraderPnl = async (traderId, period) => {
    setPnlLoading(true);
    try {
      const r = await getTraderPnl(traderId, period);
      setTraderPnl(r.data);
    } catch (e) { console.error('PnL load error:', e); }
    setPnlLoading(false);
  };

  const loadTraderRevenueSim = async (traderId, period, methodArg) => {
    setRevSimLoading(true);
    try {
      const r = await api.get(`/admin/traders/${traderId}/revenue-sim?period=${period}&method=${methodArg || revSimMethod}`);
      setTraderRevSim(r.data);
    } catch (e) { console.error('Revenue sim load error:', e); }
    setRevSimLoading(false);
  };

  const loadTraderActivity = async (traderId, period) => {
    if (period === 'all') { setActivity(null); return; }   // Lifetime uses the trader's own totals
    setActivityLoading(true);
    try {
      const r = await api.get(`/admin/traders/${traderId}/activity?period=${period}`);
      setActivity(r.data);
    } catch (e) { console.error('Activity load error:', e); }
    setActivityLoading(false);
  };

  const openTraderPage = async (trader) => {
    setViewingTrader({ ...trader });
    setViewingTraderWallet(null);
    setViewingTraderTx([]);
    setViewingTraderOrders([]);
    setTraderPnl(null);
    setTraderRevSim(null);
    setRevSimPeriod('today');
    setRevSimMethod('auto');
    setActivityPeriod('24h');
    setActivity(null);
    loadTraderActivity(trader.id, '24h');   // show today's trades/volume by default
    setAddTokensMsg(''); setAddTokensAmount(''); setAddTokensNote('');
    setPnlPeriod('today');
    setViewingTraderLoading(true);
    setTxPage(1);
    setOrdersPage(1);
    setResetPwMsg('');
    setShowSecurityAnswer(false);
    setResolveRef(''); setResolveAmount(''); setResolveMsg({ text: '', type: '' });
    setImAccountInput(trader.settlement_account || ''); setImAccountMsg('');
    try {
      const [detailRes, walletRes, txRes, ordersRes, pnlRes, revSimRes, logsRes] = await Promise.allSettled([
        api.get(`/admin/traders/${trader.id}/detail`),
        api.get(`/admin/traders/${trader.id}/wallet`),
        api.get(`/admin/traders/${trader.id}/transactions?limit=60`),
        api.get(`/admin/traders/${trader.id}/orders?limit=60`),
        getTraderPnl(trader.id, 'today'),
        api.get(`/admin/traders/${trader.id}/revenue-sim?period=today`),
        getAdminTraderBotLogs(trader.id),
      ]);
      if (detailRes.status === 'fulfilled') setViewingTrader(prev => ({ ...prev, ...(detailRes.value.data || {}) }));
      if (walletRes.status === 'fulfilled') setViewingTraderWallet(walletRes.value.data);
      if (txRes.status === 'fulfilled') setViewingTraderTx(txRes.value.data || []);
      if (ordersRes.status === 'fulfilled') setViewingTraderOrders(ordersRes.value.data || []);
      if (pnlRes.status === 'fulfilled') setTraderPnl(pnlRes.value.data);
      if (revSimRes.status === 'fulfilled') setTraderRevSim(revSimRes.value.data);  // revenue-sim?period=today&method=auto
      if (logsRes.status === 'fulfilled') setTraderBotLogs(logsRes.value.data || []);
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
    survey: 'Survey Responses',
  };

  const fmtKES = (v) => `KES ${(v || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const fmtKESFee = (v) => `KES ${(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtLastSeen = (botTs, webTs) => {
    const now = Date.now();
    const botDiff = botTs ? (now - new Date(botTs).getTime()) / 1000 : null;
    const webDiff = webTs ? (now - new Date(webTs).getTime()) / 1000 : null;
    const botOnline = botDiff !== null && botDiff < 180; // 3-min window — bot polls periodically
    const webOnline = webDiff !== null && webDiff < 300; // 5-min window (stats poll every 2 min)
    if (botOnline) return { label: 'Bot Online', online: true };
    if (webOnline) return { label: 'Online', online: true };
    // Use whichever activity was more recent for the "last seen" label
    const diff = [botDiff, webDiff].filter(d => d !== null).reduce((a, b) => Math.min(a, b), Infinity);
    if (diff === Infinity) return { label: 'Never', online: false };
    if (diff < 3600) return { label: `${Math.floor(diff / 60)}m ago`, online: false };
    if (diff < 86400) return { label: `${Math.floor(diff / 3600)}h ago`, online: false };
    return { label: `${Math.floor(diff / 86400)}d ago`, online: false };
  };

  // Compute max volume for chart scaling
  const maxVolume = analytics?.monthly_volumes?.length
    ? Math.max(...analytics.monthly_volumes.map((m) => m.total_volume), 1)
    : 1;

  return (
    <div className="adm-layout">

      {/* ── Grant / Extend Subscription (duration picker) ── */}
      {tierGrant && (
        <TierGrantModal
          grant={tierGrant}
          onCancel={() => setTierGrant(null)}
          onApply={applyTierGrant}
        />
      )}

      {/* ── Send custom SMS (individual / broadcast) ── */}
      {smsTarget && <AdminSmsModal target={smsTarget} onClose={() => setSmsTarget(null)} />}

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
                const badgeCount = item.key === 'disputes' ? unreadTicketCount : item.key === 'unmatched' ? ((unmatched.deposits?.length || 0) + (unmatched.withdrawals?.length || 0)) : 0;
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
          <div className="adm-sidebar-user">
            <div className="adm-sidebar-avatar">AD</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: '#E5E7EB', fontSize: 12, fontWeight: 500 }}>Admin</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 1 }}>
                <span style={{ width: 6, height: 6, background: '#10B981', borderRadius: '50%', display: 'inline-block' }} />
                <span style={{ color: '#10B981', fontSize: 10 }}>Online</span>
              </div>
            </div>
            <button className="adm-logout-btn-icon" onClick={logout} title="Logout">
              <LogOut size={15} />
            </button>
          </div>
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

              {/* ── Header row ── */}
              <div className="adm-dash-header-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                <div>
                  <h2 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 4px', color: '#fff' }}>
                    {getGreeting()}, Admin
                  </h2>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#6b7280', fontSize: 13 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981', display: 'inline-block', flexShrink: 0 }} />
                    All systems normal · Today's platform earnings
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button className="adm-dash-online-btn" onClick={() => setActiveTab('traders')}
                    style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 14px', borderRadius: 8, border: '1px solid rgba(16,185,129,0.3)', background: 'rgba(16,185,129,0.08)', color: '#10b981', fontWeight: 600, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981', flexShrink: 0 }} />
                    {analytics?.online_traders ?? 0} online traders
                  </button>
                  {/* Audit-alert bell — unseen sensitive staff actions */}
                  <button onClick={() => { setActiveTab('security'); api.post('/admin/audit-notifications/seen').catch(() => {}); setAuditAlerts(0); }}
                    title="Staff activity alerts"
                    style={{ position: 'relative', background: 'none', border: 'none', cursor: 'pointer', padding: 6, color: auditAlerts > 0 ? '#f59e0b' : '#9ca3af' }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>
                    {auditAlerts > 0 && (
                      <span style={{ position: 'absolute', top: 2, right: 2, minWidth: 16, height: 16, padding: '0 3px', borderRadius: 8, background: '#f59e0b', color: '#1a1206', fontSize: 9, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{auditAlerts > 9 ? '9+' : auditAlerts}</span>
                    )}
                  </button>
                  <button onClick={() => setActiveTab('disputes')}
                    style={{ position: 'relative', background: 'none', border: 'none', cursor: 'pointer', padding: 6, color: '#9ca3af' }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
                    {unreadTicketCount > 0 && (
                      <span style={{ position: 'absolute', top: 2, right: 2, width: 16, height: 16, borderRadius: '50%', background: '#ef4444', color: '#fff', fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{unreadTicketCount > 9 ? '9+' : unreadTicketCount}</span>
                    )}
                  </button>
                  <button onClick={loadData}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 6, color: '#9ca3af' }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                  </button>
                </div>
              </div>

              {/* ── Top 2-col: Earnings + Needs Attention ── */}
              <div className="adm-dash-top-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.4fr) minmax(0,1fr)', gap: 14, marginBottom: 16 }}>

                {/* Earnings card */}
                <div className="adm-card" style={{ padding: '16px 20px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                    <div style={{ color: '#f59e0b', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.8px' }}>Today's Platform Earnings</div>
                    <button
                      onClick={() => { if (dashHidden) { setShowDashTotpModal(true); } else { setDashHidden(true); } }}
                      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 6, border: `1px solid ${dashHidden ? '#374151' : '#f59e0b'}`, background: dashHidden ? 'transparent' : 'rgba(245,158,11,0.08)', color: dashHidden ? '#9ca3af' : '#f59e0b', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                      {dashHidden ? <Eye size={13} /> : <EyeOff size={13} />}
                      {dashHidden ? 'Show' : 'Hide'}
                    </button>
                  </div>
                  <div style={{ fontSize: 32, fontWeight: 800, color: '#f59e0b', marginBottom: 16, letterSpacing: '-1px' }}>
                    {dashHidden ? 'KES ••••••' : fmtKESFee(analytics?.revenue?.today || dashboard.today.revenue)}
                  </div>
                  <div className="adm-earn-stats" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, paddingTop: 12, borderTop: '0.5px solid #1f2937' }}>
                    {[
                      { label: 'Paybill balance', value: dashHidden ? '••••••' : (paybillBalance?.available != null ? fmtKES(paybillBalance.available) : '—') },
                      { label: 'Platform float',  value: dashHidden ? '•••••••' : (choiceFloat ? fmtKES(choiceFloat.total) : '—') },
                      { label: "Today's volume",  value: dashHidden ? '••••••' : fmtKES(dashboard.today.volume) },
                    ].map(({ label, value }) => (
                      <div key={label}>
                        <div style={{ color: '#9ca3af', fontSize: 11, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
                        <div style={{ color: '#f9fafb', fontSize: 17, fontWeight: 800, letterSpacing: '-0.3px' }}>{value}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Needs Attention card */}
                <div className="adm-card" style={{ padding: '16px 20px', background: 'rgba(239,68,68,0.04)', border: '0.5px solid rgba(239,68,68,0.2)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: '#ef4444', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px' }}>
                      <AlertTriangle size={14} />
                      Needs Attention
                    </div>
                    <button onClick={() => setActiveTab('disputes')}
                      style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: 12, cursor: 'pointer', padding: 0 }}>
                      View all →
                    </button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, textAlign: 'center' }}>
                    {[
                      { label: 'Disputes',  value: unreadTicketCount,                                                        color: '#ef4444', onClick: () => setActiveTab('disputes')  },
                      { label: 'Unmatched', value: (unmatched.deposits?.length || 0) + (unmatched.withdrawals?.length || 0), color: '#f59e0b', onClick: () => setActiveTab('unmatched') },
                      { label: 'KYC pending', value: dashboard.traders?.total_unverified ?? 0,                               color: '#3b82f6', onClick: () => setActiveTab('kyc')       },
                    ].map(({ label, value, color, onClick }) => (
                      <div key={label} onClick={onClick} style={{ cursor: 'pointer', padding: '8px 4px', borderRadius: 8, background: 'rgba(255,255,255,0.02)' }}>
                        <div style={{ fontSize: 28, fontWeight: 800, color, lineHeight: 1, marginBottom: 6 }}>{value}</div>
                        <div style={{ color: '#6b7280', fontSize: 11 }}>{label}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* ── 4 key stat cards ── */}
              <div className="adm-dash-stat-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
                {[
                  { label: 'Total Traders', value: dashboard.traders.total,   badge: `+${dashboard.traders.new_today ?? 0}%`, badgeColor: '#10b981', icon: <Users size={18} />, iconBg: 'rgba(16,185,129,0.12)', iconColor: '#10b981' },
                  { label: 'Active Now',    value: dashboard.traders.active,   badge: 'Active',                                 badgeColor: '#10b981', icon: <UserCheck size={18} />, iconBg: 'rgba(16,185,129,0.12)', iconColor: '#10b981' },
                  { label: 'Orders',        value: dashboard.today.orders,     badge: 'today',                                  badgeColor: '#6b7280', icon: <ShoppingCart size={18} />, iconBg: 'rgba(139,92,246,0.12)', iconColor: '#8b5cf6' },
                  { label: 'Completed',     value: dashboard.today.completed,  badge: 'today',                                  badgeColor: '#6b7280', icon: <CheckCircle size={18} />, iconBg: 'rgba(16,185,129,0.12)', iconColor: '#10b981' },
                ].map(({ label, value, badge, badgeColor, icon, iconBg, iconColor }) => (
                  <div key={label} className="adm-card" style={{ padding: '16px 18px' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10 }}>
                      <div style={{ width: 34, height: 34, borderRadius: 8, background: iconBg, color: iconColor, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {icon}
                      </div>
                      <span style={{ fontSize: 11, fontWeight: 600, color: badgeColor, background: `${badgeColor}1a`, padding: '2px 8px', borderRadius: 20 }}>{badge}</span>
                    </div>
                    <div style={{ fontSize: 26, fontWeight: 800, color: '#fff', lineHeight: 1, marginBottom: 4 }}>{value}</div>
                    <div style={{ color: '#6b7280', fontSize: 12 }}>{label}</div>
                  </div>
                ))}
              </div>

              {/* ── Chart + Top Traders ── */}
              <div className="adm-dash-chart-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr)', gap: 14, marginBottom: 16 }}>
                {/* Monthly Volumes */}
                <div className="adm-card">
                  <div className="adm-card-header">
                    <h3>Monthly volumes</h3>
                    <span className="adm-card-count">Last 6 months</span>
                  </div>
                  <div style={{ padding: '10px 20px 0' }}>
                    {analytics?.monthly_volumes?.length > 0 ? (
                      <div style={{ display: 'flex', gap: 0 }}>
                        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', paddingBottom: 28, marginRight: 10, width: 60, textAlign: 'right' }}>
                          {[maxVolume, maxVolume * 0.5, 0].map((v, i) => (
                            <span key={i} style={{ fontSize: 13, fontWeight: 600, color: '#9ca3af', lineHeight: 1 }}>
                              {v >= 1000000 ? `${(v/1000000).toFixed(1)}M` : v >= 1000 ? `${(v/1000).toFixed(0)}K` : v.toFixed(0)}
                            </span>
                          ))}
                        </div>
                        <div style={{ flex: 1, position: 'relative' }}>
                          <div style={{ position: 'absolute', inset: 0, bottom: 28, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', pointerEvents: 'none' }}>
                            {[0,1,2].map(i => <div key={i} style={{ borderBottom: '1px solid #1f2937', width: '100%' }} />)}
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-around', alignItems: 'flex-end', height: 300, position: 'relative', paddingBottom: 28 }}>
                            {analytics.monthly_volumes.map((m, i) => (
                              <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1 }}>
                                <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 272 }}>
                                  {[{ key: 'buy', color: '#3b82f6', val: m.buy_volume }, { key: 'sell', color: '#10b981', val: m.sell_volume }].map(b => (
                                    <div key={b.key}
                                      onMouseEnter={(e) => setChartTip({ x: e.clientX, y: e.clientY, m, focus: b.key })}
                                      onMouseMove={(e) => setChartTip(prev => prev ? { ...prev, x: e.clientX, y: e.clientY } : prev)}
                                      onMouseLeave={() => setChartTip(null)}
                                      style={{ width: 22, background: b.color, borderRadius: '3px 3px 0 0', cursor: 'pointer',
                                        height: `${Math.max((b.val / maxVolume) * 272, 2)}px`,
                                        boxShadow: (chartTip && chartTip.m === m && chartTip.focus === b.key) ? '0 0 0 2px rgba(255,255,255,0.55)' : 'none',
                                        transition: 'box-shadow .1s' }} />
                                  ))}
                                </div>
                                <span style={{ fontSize: 13, fontWeight: 600, color: '#cbd5e1', marginTop: 8 }}>{m.month.split(' ')[0]}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    ) : <p className="adm-empty" style={{ padding: '40px 0' }}>No volume data yet</p>}
                    {chartTip && (
                      <div style={{ position: 'fixed', left: Math.min(chartTip.x + 14, (typeof window !== 'undefined' ? window.innerWidth : 9999) - 210), top: chartTip.y - 12, zIndex: 1000, pointerEvents: 'none', background: '#0f1117', border: '1px solid #2a2f3a', borderRadius: 8, padding: '10px 12px', minWidth: 180, boxShadow: '0 10px 30px rgba(0,0,0,0.55)', fontSize: 12 }}>
                        <div style={{ fontWeight: 700, color: '#e5e7eb', marginBottom: 7 }}>{chartTip.m.month}</div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, color: chartTip.focus === 'buy' ? '#60a5fa' : '#9ca3af', fontWeight: chartTip.focus === 'buy' ? 700 : 500 }}>
                          <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: '#3b82f6', marginRight: 6 }} />Buy</span><span>{fmtKES(chartTip.m.buy_volume)}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, marginTop: 4, color: chartTip.focus === 'sell' ? '#34d399' : '#9ca3af', fontWeight: chartTip.focus === 'sell' ? 700 : 500 }}>
                          <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: '#10b981', marginRight: 6 }} />Sell</span><span>{fmtKES(chartTip.m.sell_volume)}</span>
                        </div>
                        <div style={{ borderTop: '1px solid #2a2f3a', marginTop: 7, paddingTop: 6, display: 'flex', justifyContent: 'space-between', color: '#cbd5e1' }}>
                          <span>Total</span><span style={{ fontWeight: 700 }}>{fmtKES(chartTip.m.total_volume)}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', color: '#6b7280', marginTop: 2 }}>
                          <span>Trades</span><span>{chartTip.m.trades}</span>
                        </div>
                      </div>
                    )}
                  </div>
                  {analytics?.monthly_volumes?.length > 0 && (
                    <div style={{ display: 'flex', gap: 24, padding: '4px 20px 16px', fontSize: 14, fontWeight: 700, color: '#e5e7eb' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center' }}><span style={{ display: 'inline-block', width: 14, height: 14, borderRadius: 3, background: '#3b82f6', marginRight: 7 }} />Buy</span>
                      <span style={{ display: 'inline-flex', alignItems: 'center' }}><span style={{ display: 'inline-block', width: 14, height: 14, borderRadius: 3, background: '#10b981', marginRight: 7 }} />Sell</span>
                    </div>
                  )}
                </div>

                {/* Top Traders */}
                <div className="adm-card">
                  <div className="adm-card-header">
                    <h3>Top traders</h3>
                    <span className="adm-card-count">By volume</span>
                  </div>
                  <div style={{ padding: '8px 0' }}>
                    {analytics?.top_traders?.length > 0 ? analytics.top_traders.slice(0, 6).map((t, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 20px', borderBottom: i < Math.min(analytics.top_traders.length, 6) - 1 ? '0.5px solid #1f2937' : 'none' }}>
                        <div style={{ width: 24, fontWeight: 700, fontSize: 13, color: i === 0 ? '#f59e0b' : '#6b7280', flexShrink: 0 }}>#{i + 1}</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 13, color: '#e5e7eb', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</div>
                          <div style={{ color: '#6b7280', fontSize: 11 }}>{t.trades} trades</div>
                        </div>
                        <div style={{ fontWeight: 700, fontSize: 13, color: '#10b981', whiteSpace: 'nowrap' }}>{fmtKES(t.volume)}</div>
                      </div>
                    )) : <p className="adm-empty" style={{ padding: '24px 20px' }}>No data yet</p>}
                  </div>
                </div>
              </div>

              {/* ── Recent Orders (full width) ── */}
              <div className="adm-card">
                <div className="adm-card-header">
                  <h3>Recent orders</h3>
                  <span className="adm-card-count" style={{ cursor: 'pointer' }} onClick={() => setActiveTab('transactions')}>{orders.total} total →</span>
                </div>
                <div>
                  {orders.orders.slice(0, 8).map((o, i) => (
                    <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 0', borderBottom: i < Math.min(orders.orders.length, 8) - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
                      <span className={`adm-badge ${o.side === 'sell' ? 'green' : 'yellow'}`} style={{ flexShrink: 0, minWidth: 40, textAlign: 'center' }}>{o.side?.toUpperCase()}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ color: '#e5e7eb', fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.trader_name}</div>
                        <div style={{ color: '#6b7280', fontSize: 11, marginTop: 2 }}>{o.created_at ? fmtDateEAT(o.created_at) : '—'} · {fmtKES(o.fiat_amount)}</div>
                      </div>
                      <span className={`adm-badge ${o.status === 'completed' || o.status === 'released' ? 'green' : o.status === 'cancelled' ? 'red' : 'dim'}`} style={{ flexShrink: 0, textTransform: 'capitalize' }}>{o.status}</span>
                    </div>
                  ))}
                  {orders.orders.length === 0 && (
                    <div style={{ textAlign: 'center', color: '#6b7280', padding: 30 }}>No orders today</div>
                  )}
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
                    {[['fiat', 'Fiat (Choice Bank)'], ['crypto', 'Crypto (Binance)']].map(([key, label]) => (
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
                const fiatFiltered = fiatDirFilter === 'all'
                  ? transactions.transactions
                  : transactions.transactions.filter(t => (fiatDirFilter === 'in' ? t.direction === 'inbound' : t.direction === 'outbound'));
                const fiatTotal = fiatFiltered.length;
                const fiatTotalPages = Math.max(1, Math.ceil(fiatTotal / PAGE_TX_SIZE));
                const fiatSlice = fiatFiltered.slice((fiatPage - 1) * PAGE_TX_SIZE, fiatPage * PAGE_TX_SIZE);
                const inTotal  = transactions.transactions.filter(t => t.direction === 'inbound').reduce((s, t) => s + (t.amount || 0), 0);
                const outTotal = transactions.transactions.filter(t => t.direction === 'outbound').reduce((s, t) => s + (t.amount || 0), 0);
                const fmtAmt   = v => 'KES ' + v.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                return (
                  <>
                    {/* Summary totals */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, margin: '12px 0', padding: '0 20px' }}>
                      <div style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: 10, padding: '12px 14px' }}>
                        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>Total Inbound</div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: '#10b981' }}>{fmtAmt(inTotal)}</div>
                      </div>
                      <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 10, padding: '12px 14px' }}>
                        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>Total Outbound</div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: '#ef4444' }}>{fmtAmt(outTotal)}</div>
                      </div>
                      <div style={{ gridColumn: '1 / -1', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 10, padding: '11px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={{ fontSize: 11, color: '#6b7280' }}>Net balance</div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: (inTotal - outTotal) >= 0 ? '#10b981' : '#ef4444' }}>{fmtAmt(inTotal - outTotal)}</div>
                      </div>
                    </div>
                    {/* Direction filter pills */}
                    <div style={{ display: 'flex', gap: 6, marginBottom: 10, padding: '0 20px' }}>
                      {[['all', 'All'], ['in', 'Inbound'], ['out', 'Outbound']].map(([v, l]) => (
                        <button key={v} onClick={() => { setFiatDirFilter(v); setFiatPage(1); }}
                          style={{ padding: '5px 16px', borderRadius: 20, border: '1px solid', borderColor: fiatDirFilter === v ? '#10b981' : 'var(--border)', background: fiatDirFilter === v ? 'rgba(16,185,129,0.15)' : 'transparent', color: fiatDirFilter === v ? '#10b981' : '#6b7280', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                          {l}
                        </button>
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 8, padding: '0 20px' }}>
                      <input type="text" placeholder="Search TX ID, phone, trader…"
                        value={txnSearch} onChange={(e) => setTxnSearch(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && loadTransactions(txPeriod, txnSearch, true)}
                        style={{ flex: 1, minWidth: 0, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: '#fff', fontSize: 13 }}
                      />
                      <button onClick={() => loadTransactions(txPeriod, txnSearch, true)}
                        style={{ flexShrink: 0, padding: '10px 14px', borderRadius: 8, border: 'none', background: '#f59e0b', color: '#000', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                        Search
                      </button>
                      {txnSearch && (
                        <button onClick={() => { setTxnSearch(''); loadTransactions(txPeriod, '', true); }}
                          style={{ flexShrink: 0, padding: '10px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: '#9ca3af', fontSize: 16, cursor: 'pointer', lineHeight: 1 }}>
                          ×
                        </button>
                      )}
                    </div>
                    <div style={{ padding: '0 20px 10px', display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ fontSize: 12, color: '#6b7280' }}>{transactions.total} payment records</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#10b981' }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#10b981', display: 'inline-block', animation: 'pulse-green 1.5s ease-in-out infinite' }} />
                        Live · updates every 10s
                      </span>
                      {fiatLastUpdated && <span style={{ fontSize: 11, color: '#4b5563' }}>Last: {fmtTimeEAT(fiatLastUpdated)}</span>}
                    </div>
                    <div>
                      {fiatSlice.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '30px 0', color: '#6b7280', fontSize: 13 }}>No fiat transactions found</div>
                      ) : fiatSlice.map((tx, i) => {
                        const isIn = tx.direction === 'inbound';
                        const cpName = tx.sender_name !== '-' ? tx.sender_name : tx.destination !== '-' ? tx.destination : null;
                        const txPhone = tx.phone !== '-' ? tx.phone : null;
                        const txId = tx.mpesa_transaction_id !== '-' ? tx.mpesa_transaction_id : null;
                        return (
                          <div key={tx.id} style={{ padding: '11px 20px', borderBottom: i < fiatSlice.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <span className={`adm-badge ${isIn ? 'green' : 'yellow'}`} style={{ flexShrink: 0, minWidth: 36, textAlign: 'center' }}>{isIn ? 'IN' : 'OUT'}</span>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ color: '#e5e7eb', fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tx.trader_name || '—'}</div>
                                <div style={{ color: '#6b7280', fontSize: 11, marginTop: 1 }}>{tx.created_at ? fmtDateEAT(tx.created_at) : '—'}</div>
                              </div>
                              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                                <div style={{ color: isIn ? '#10b981' : '#f59e0b', fontWeight: 700, fontSize: 14 }}>{isIn ? '+' : '-'}{fmtKES(tx.amount)}</div>
                                <span className={`adm-badge ${tx.status === 'completed' ? 'green' : tx.status === 'failed' ? 'red' : 'dim'}`} style={{ marginTop: 3, display: 'inline-block', textTransform: 'capitalize' }}>{tx.status}</span>
                              </div>
                            </div>
                            {(cpName || txPhone || txId) && (
                              <div style={{ display: 'flex', gap: 8, marginTop: 5, paddingLeft: 46, flexWrap: 'wrap' }}>
                                {cpName && <span style={{ color: '#9ca3af', fontSize: 10 }}>{cpName}</span>}
                                {txPhone && <span style={{ color: '#4b5563', fontSize: 10 }}>· {txPhone}</span>}
                                {txId && <span style={{ color: '#f59e0b', fontSize: 10, fontFamily: 'monospace' }}>{txId}</span>}
                              </div>
                            )}
                          </div>
                        );
                      })}
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
                    <div style={{ padding: '12px 20px', display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input type="text" placeholder="Search order #, trader, counterparty…"
                        value={ordersSearch} onChange={(e) => setOrdersSearch(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && loadOrders(cryptoPeriod, ordersSearch, true)}
                        style={{ flex: 1, minWidth: 0, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: '#fff', fontSize: 13 }}
                      />
                      <button onClick={() => loadOrders(cryptoPeriod, ordersSearch, true)}
                        style={{ flexShrink: 0, padding: '10px 14px', borderRadius: 8, border: 'none', background: '#f59e0b', color: '#000', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                        Search
                      </button>
                      {ordersSearch && (
                        <button onClick={() => { setOrdersSearch(''); loadOrders(cryptoPeriod, '', true); }}
                          style={{ flexShrink: 0, padding: '10px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: '#9ca3af', fontSize: 16, cursor: 'pointer', lineHeight: 1 }}>
                          ×
                        </button>
                      )}
                    </div>
                    <div style={{ padding: '0 20px 10px', display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ fontSize: 12, color: '#6b7280' }}>{orders.total} orders total</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#10b981' }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#10b981', display: 'inline-block', animation: 'pulse-green 1.5s ease-in-out infinite' }} />
                        Live · updates every 10s
                      </span>
                      {txLastUpdated && <span style={{ fontSize: 11, color: '#4b5563' }}>Last: {fmtTimeEAT(txLastUpdated)}</span>}
                    </div>
                    <div>
                      {pageSlice.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '30px 0', color: '#6b7280', fontSize: 13 }}>No crypto orders found</div>
                      ) : pageSlice.map((o, i) => (
                        <div key={o.id} style={{ padding: '11px 20px', borderBottom: i < pageSlice.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span className={`adm-badge ${o.side === 'BUY' ? 'green' : 'red'}`} style={{ flexShrink: 0, minWidth: 36, textAlign: 'center' }}>{o.side}</span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ color: '#e5e7eb', fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.trader_name || '—'}</div>
                              <div style={{ color: '#6b7280', fontSize: 11, marginTop: 1 }}>{o.created_at ? fmtDateEAT(o.created_at) : '—'}</div>
                            </div>
                            <div style={{ textAlign: 'right', flexShrink: 0 }}>
                              <div style={{ color: '#10b981', fontWeight: 700, fontSize: 14 }}>{fmtKES(o.fiat_amount)}</div>
                              <span className={`adm-badge ${o.status === 'completed' ? 'green' : o.status === 'disputed' ? 'red' : o.status === 'cancelled' ? 'dim' : 'yellow'}`} style={{ marginTop: 3, display: 'inline-block', textTransform: 'capitalize' }}>{o.status}</span>
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 8, marginTop: 5, paddingLeft: 46, flexWrap: 'wrap', alignItems: 'center' }}>
                            <span style={{ color: '#9ca3af', fontSize: 10, fontWeight: 600 }}>{o.crypto_amount} {o.asset}{/* aligned under name */}</span>
                            {o.counterparty && <span style={{ color: '#4b5563', fontSize: 10 }}>· {o.counterparty}</span>}
                            {o.platform_fee > 0 && <span style={{ color: '#ef4444', fontSize: 10 }}>· Fee: {fmtKES(o.platform_fee)}</span>}
                          </div>
                        </div>
                      ))}
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
          {activeTab === 'traders' && !viewingTrader && (() => {
            // Base list by role tab
            const baseList = traderRoleFilter === 'traders'
              ? traders.filter(t => !t.role || t.role === 'trader' || t.role === 'admin')
              : traders.filter(t => t.role === 'employee');
            // Apply search
            const searched = traderSearch.trim()
              ? baseList.filter(t => [t.full_name, t.email, t.phone].some(f => f?.toLowerCase().includes(traderSearch.toLowerCase())))
              : baseList;
            // Apply tier filter
            const tierFiltered = traderTierFilter === 'all' ? searched
              : searched.filter(t => (traderTierFilter === 'free' ? (!t.tier || t.tier === 'standard') : t.tier === traderTierFilter));
            // Apply bot filter
            const botFiltered = traderBotFilter === 'all' ? tierFiltered
              : tierFiltered.filter(t => {
                  const ls = fmtLastSeen(t.last_seen_at, t.last_web_active);
                  return traderBotFilter === 'online' ? ls.online : !ls.online;
                });
            // Sort
            const sorted = [...botFiltered].sort((a, b) => {
              if (traderSort === 'volume') return (b.total_volume || 0) - (a.total_volume || 0);
              if (traderSort === 'trades') return (b.total_trades || 0) - (a.total_trades || 0);
              return (a.full_name || '').localeCompare(b.full_name || '');
            });
            // Avatar bg colour from initials
            const avatarColor = (name) => {
              const colors = ['#1E3A8A','#065F46','#5B21B6','#92400E','#7F1D1D','#0F4C5C','#1F4E79','#3B0764'];
              let h = 0; for (const c of (name||'')) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
              return colors[Math.abs(h) % colors.length];
            };
            const avatarFg = () => '#c7d2fe';
            const tierLabel = (tier) => tier === 'pro_max' ? 'Starter Pro Max' : tier === 'pro' ? 'Starter Pro' : tier === 'starter' ? 'Starter' : 'Free';
            const tierColor = (tier) => tier === 'advanced' ? { bg: 'rgba(239,68,68,0.15)', color: '#ef4444' }
              : tier === 'pro_max' ? { bg: 'rgba(139,92,246,0.15)', color: '#8b5cf6' }
              : tier === 'pro' ? { bg: 'rgba(245,158,11,0.15)', color: '#f59e0b' }
              : tier === 'starter' ? { bg: 'rgba(16,185,129,0.12)', color: '#10b981' }
              : { bg: 'rgba(156,163,175,0.12)', color: '#9ca3af' };
            const roleColor = (role) => role === 'admin' ? { bg: 'rgba(245,158,11,0.15)', color: '#f59e0b' }
              : { bg: 'rgba(156,163,175,0.12)', color: '#9ca3af' };
            const onlineCount = traders.filter(t => fmtLastSeen(t.last_seen_at, t.last_web_active).online).length;
            const adminCount  = traders.filter(t => t.role === 'admin').length;
            const relayCount  = traders.filter(t => t.relay_connected).length;
            // CSV export
            const exportCSV = () => {
              const header = 'Name,Email,Phone,Tier,Role,Trades,Volume,Status';
              const rows = sorted.map(t => [t.full_name, t.email, t.phone, tierLabel(t.tier), t.role||'trader', t.total_trades||0, t.total_volume||0, t.status].map(v=>`"${v}"`).join(','));
              const blob = new Blob([[header,...rows].join('\n')], { type: 'text/csv' });
              const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'traders.csv'; a.click();
            };
            return (
              <div onClick={() => setTraderDrop(null)}>
                {/* Page header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
                  <div>
                    <div style={{ color: '#e5e7eb', fontSize: 18, fontWeight: 600 }}>All traders</div>
                    <div style={{ color: '#6b7280', fontSize: 12, marginTop: 3 }}>
                      {traders.length} total · {adminCount} admin · {onlineCount} online now · <span style={{ color: relayCount > 0 ? '#10b981' : '#9ca3af' }}>{relayCount} on v1.9.2 relay</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => setSmsTarget({ broadcast: true })} title="Send SMS to all customers"
                      style={{ height: 34, padding: '0 12px', background: '#111827', border: '0.5px solid #374151', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: '#60a5fa', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
                      💬 SMS all
                    </button>
                    <button onClick={exportCSV} title="Export CSV"
                      style={{ width: 34, height: 34, background: '#111827', border: '0.5px solid #374151', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#9ca3af', flexShrink: 0 }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    </button>
                    <button title="Add trader"
                      style={{ width: 34, height: 34, background: '#f59e0b', border: 'none', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0f1419" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    </button>
                  </div>
                </div>

                {/* Tabs row */}
                <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                  {[['traders', 'Traders'], ['employees', 'Employees']].map(([key, label]) => {
                    const cnt = key === 'traders' ? traders.filter(t => !t.role || t.role === 'trader' || t.role === 'admin').length
                      : traders.filter(t => t.role === 'employee').length;
                    const active = traderRoleFilter === key;
                    return (
                      <button key={key} onClick={() => setTraderRoleFilter(key)}
                        style={{ padding: '6px 14px', borderRadius: 16, border: ('0.5px solid ' + (active ? 'rgba(245,158,11,0.4)' : '#374151')), cursor: 'pointer', fontSize: 12, fontWeight: active ? 600 : 400,
                          background: active ? 'rgba(245,158,11,0.15)' : '#111827',
                          color: active ? '#f59e0b' : '#9ca3af' }}>
                        {label} <span style={{ opacity: 0.65, marginLeft: 4, fontSize: 11 }}>{cnt}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Search row */}
                <div style={{ background: '#111827', border: '0.5px solid #374151', borderRadius: 8, padding: '9px 12px', display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }} onClick={e => e.stopPropagation()}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                  <input value={traderSearch} onChange={e => setTraderSearch(e.target.value)} onClick={e => e.stopPropagation()}
                    placeholder="Search name, email, phone…"
                    style={{ background: 'transparent', border: 'none', outline: 'none', color: '#e5e7eb', fontSize: 13, flex: 1, minWidth: 0 }} />
                  {traderSearch && <button onClick={() => setTraderSearch('')} style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 16, padding: 0, lineHeight: 1 }}>×</button>}
                </div>

                {/* Filter + Sort row */}
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  {/* Filter button with inline panel */}
                  <div style={{ flex: 1, position: 'relative' }} onClick={e => e.stopPropagation()}>
                    <button onClick={() => setTraderDrop(d => d?.type === 'filterPanel' ? null : { type: 'filterPanel' })}
                      style={{ width: '100%', background: '#111827', border: ('0.5px solid ' + ((traderTierFilter !== 'all' || traderBotFilter !== 'all') ? '#f59e0b' : '#374151')), padding: '8px 12px', borderRadius: 6, fontSize: 12, color: (traderTierFilter !== 'all' || traderBotFilter !== 'all') ? '#f59e0b' : '#e5e7eb', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
                      Filter
                      {(traderTierFilter !== 'all' || traderBotFilter !== 'all') && <span style={{ marginLeft: 'auto', background: '#f59e0b', color: '#000', width: 16, height: 16, borderRadius: '50%', fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>!</span>}
                    </button>
                    {traderDrop?.type === 'filterPanel' && (
                      <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, background: '#1f2937', border: '1px solid #374151', borderRadius: 10, zIndex: 50, padding: 12, minWidth: 230 }} onClick={e => e.stopPropagation()}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                          <span style={{ color: '#e5e7eb', fontSize: 13, fontWeight: 500 }}>Filter traders</span>
                          <button onClick={() => { setTraderTierFilter('all'); setTraderBotFilter('all'); }} style={{ background: 'none', border: 'none', color: '#f59e0b', fontSize: 11, fontWeight: 500, cursor: 'pointer' }}>Clear all</button>
                        </div>
                        <div style={{ color: '#9ca3af', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 7 }}>Tier</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 12 }}>
                          {[['all','All'],['free','Free'],['starter','Starter'],['pro','Starter Pro'],['pro_max','Starter Pro Max']].map(([v,l]) => (
                            <button key={v} onClick={() => setTraderTierFilter(v)}
                              style={{ padding: '5px 10px', borderRadius: 12, border: ('0.5px solid ' + (traderTierFilter === v ? '#f59e0b' : '#374151')), background: traderTierFilter === v ? 'rgba(245,158,11,0.15)' : '#111827', color: traderTierFilter === v ? '#f59e0b' : '#9ca3af', fontSize: 11, cursor: 'pointer' }}>{l}</button>
                          ))}
                        </div>
                        <div style={{ color: '#9ca3af', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 7 }}>Bot status</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                          {[['all','All'],['online','Online'],['offline','Offline']].map(([v,l]) => (
                            <button key={v} onClick={() => setTraderBotFilter(v)}
                              style={{ padding: '5px 10px', borderRadius: 12, border: ('0.5px solid ' + (traderBotFilter === v ? '#f59e0b' : '#374151')), background: traderBotFilter === v ? 'rgba(245,158,11,0.15)' : '#111827', color: traderBotFilter === v ? '#f59e0b' : '#9ca3af', fontSize: 11, cursor: 'pointer' }}>{l}</button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  {/* Sort button */}
                  <div style={{ flex: 1, position: 'relative' }} onClick={e => e.stopPropagation()}>
                    <button onClick={() => setTraderDrop(d => d?.type === 'sort' ? null : { type: 'sort' })}
                      style={{ width: '100%', background: '#111827', border: '0.5px solid #374151', padding: '8px 12px', borderRadius: 6, fontSize: 12, color: '#e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
                      <span style={{ color: '#9ca3af' }}>Sort</span>
                      <span style={{ color: '#f59e0b', display: 'flex', alignItems: 'center', gap: 4 }}>{traderSort === 'volume' ? 'Volume' : traderSort === 'trades' ? 'Trades' : 'Name'} ↓</span>
                    </button>
                    {traderDrop?.type === 'sort' && (
                      <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, background: '#1f2937', border: '1px solid #374151', borderRadius: 8, zIndex: 50, minWidth: 100, overflow: 'hidden' }}>
                        {[['volume','Volume'],['trades','Trades'],['name','Name']].map(([v,l]) => (
                          <button key={v} onClick={() => { setTraderSort(v); setTraderDrop(null); }}
                            style={{ width: '100%', textAlign: 'left', padding: '8px 12px', background: v === traderSort ? 'rgba(245,158,11,0.1)' : 'none', border: 'none', color: v === traderSort ? '#f59e0b' : '#d1d5db', fontSize: 12, cursor: 'pointer' }}>{l}</button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Trader cards */}
                {sorted.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '40px 0', color: '#6b7280', fontSize: 13 }}>No traders found</div>
                ) : sorted.map((t) => {
                  const ls = fmtLastSeen(t.last_seen_at, t.last_web_active);
                  const initials = (t.full_name || 'U').split(' ').map(w => w[0]).slice(0,2).join('').toUpperCase();
                  const tc = tierColor(t.tier);
                  const rc = roleColor(t.role);
                  const isSystem = t.role === 'owner' || t.email === 'admin@sparkp2p.com';
                  const vol = t.total_volume || 0;
                  const volStr = vol >= 1e9 ? (vol/1e9).toFixed(1)+'B' : vol >= 1e6 ? (vol/1e6).toFixed(2)+'M' : vol >= 1e3 ? Math.round(vol/1e3)+'K' : vol ? vol.toLocaleString() : null;
                  return (
                    <div key={t.id} style={{ background: '#111827', border: '0.5px solid #374151', borderRadius: 12, padding: 14, marginBottom: 10 }}>
                      {/* Top row: avatar + name/email/phone + volume/trades */}
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, cursor: 'pointer' }} onClick={() => openTraderPage(t)}>
                        <div style={{ width: 40, height: 40, borderRadius: '50%', background: isSystem ? '#1f2937' : avatarColor(t.full_name), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 500, color: '#c7d2fe', flexShrink: 0 }}>
                          {isSystem ? '🛡️' : initials}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.full_name}</span>
                            {t.role === 'admin' && <span style={{ background: 'rgba(245,158,11,0.18)', color: '#f59e0b', fontSize: 9, padding: '1px 5px', borderRadius: 3, fontWeight: 700, flexShrink: 0 }}>YOU</span>}
                            {isSystem && <span style={{ background: 'rgba(167,139,250,0.15)', color: '#a78bfa', fontSize: 9, padding: '1px 5px', borderRadius: 3, fontWeight: 700, flexShrink: 0 }}>SYSTEM</span>}
                            {t.binance_api_key_saved && !t.binance_api_key_invalid && (() => {
                              const mt = (t.binance_merchant_tier || t.binance_p2p_tier || '').toLowerCase();
                              const c = { gold: '#f59e0b', silver: '#cbd5e1', bronze: '#d97757' }[mt];
                              if (!c) return null;
                              return <svg title={`${mt} merchant`} width="13" height="13" viewBox="0 0 24 24" fill={c} stroke={c} strokeWidth="1" strokeLinejoin="round" style={{ flexShrink: 0 }}><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>;
                            })()}
                            {t.binance_api_key_saved && t.binance_api_key_invalid && <span title="Binance rejects this key — trader must reconnect" style={{ background: 'rgba(239,68,68,0.18)', color: '#ef4444', fontSize: 9, padding: '1px 5px', borderRadius: 3, fontWeight: 700, flexShrink: 0 }}>⚠ KEY</span>}
                            {!t.binance_api_key_invalid && (
                              <span title={t.binance_api_key_saved ? 'Binance API connected' : 'Binance API not connected'}
                                style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, fontWeight: 700, flexShrink: 0,
                                  background: t.binance_api_key_saved ? 'rgba(16,185,129,0.18)' : 'rgba(239,68,68,0.15)',
                                  color: t.binance_api_key_saved ? '#10b981' : '#ef4444' }}>
                                API {t.binance_api_key_saved ? '✓' : '✗'}
                              </span>
                            )}
                            <span title={t.relay_connected ? 'Relay connected (v1.9.2) — uses own IP' : 'Relay not connected (not on v1.9.2 / app off)'}
                              style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, fontWeight: 700, flexShrink: 0,
                                background: t.relay_connected ? 'rgba(16,185,129,0.18)' : 'rgba(107,114,128,0.15)',
                                color: t.relay_connected ? '#10b981' : '#9ca3af' }}>
                              Relay {t.relay_connected ? '✓' : '✗'}
                            </span>
                          </div>
                          <div style={{ color: '#6b7280', fontSize: 11, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.email}</div>
                          <div style={{ color: '#9ca3af', fontSize: 11, marginTop: 2 }}>{t.phone || 'No phone'}</div>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flexShrink: 0 }}>
                          <div style={{ color: volStr ? '#10b981' : '#4b5563', fontSize: 14, fontWeight: 500 }}>{volStr ? ('KES ' + volStr) : '—'}</div>
                          <div style={{ color: '#6b7280', fontSize: 10, marginTop: 2 }}>{t.total_trades || 0} trades</div>
                        </div>
                      </div>
                      {/* Bottom row: last-seen + tier▾ + role▾ + ⋮ */}
                      <div style={{ marginTop: 12, paddingTop: 10, borderTop: '0.5px solid #1f2937', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 4, fontSize: 10, fontWeight: 500, background: 'rgba(107,114,128,0.15)', color: '#9ca3af', flexShrink: 0 }}>
                          {ls.online && <span style={{ width: 5, height: 5, background: '#10b981', borderRadius: '50%' }} />}
                          {ls.label}
                        </span>
                        {/* Tier dropdown */}
                        <div style={{ position: 'relative' }} onClick={e => { e.stopPropagation(); if (!isSystem) setTraderDrop(d => d?.type === 'tier' && d?.id === t.id ? null : { type: 'tier', id: t.id }); }}>
                          <span style={{ padding: '3px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600, background: tc.bg, color: tc.color, display: 'inline-flex', alignItems: 'center', gap: 3, cursor: isSystem ? 'default' : 'pointer' }}>
                            {tierLabel(t.tier)}{!isSystem && <span style={{ fontSize: 8, opacity: 0.7 }}>▾</span>}
                          </span>
                          {traderDrop?.type === 'tier' && traderDrop?.id === t.id && (
                            <div style={{ position: 'absolute', bottom: '100%', left: 0, marginBottom: 4, background: '#1f2937', border: '1px solid #374151', borderRadius: 8, zIndex: 100, minWidth: 90, overflow: 'hidden' }}>
                              {[['standard','Free'],['starter','Starter'],['pro','Starter Pro'],['pro_max','Starter Pro Max']].map(([v,l]) => (
                                <button key={v} onClick={(e) => { e.stopPropagation(); handleTierChange(t.id, v); setTraderDrop(null); }}
                                  style={{ width: '100%', textAlign: 'left', padding: '7px 12px', background: (t.tier||'standard') === v ? 'rgba(245,158,11,0.1)' : 'none', border: 'none', color: (t.tier||'standard') === v ? '#f59e0b' : '#d1d5db', fontSize: 12, cursor: 'pointer' }}>{l}</button>
                              ))}
                            </div>
                          )}
                        </div>
                        {/* Role dropdown */}
                        <div style={{ position: 'relative' }} onClick={e => { e.stopPropagation(); if (!isSystem) setTraderDrop(d => d?.type === 'role' && d?.id === t.id ? null : { type: 'role', id: t.id }); }}>
                          <span style={{ padding: '3px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600, background: isSystem ? 'rgba(167,139,250,0.15)' : rc.bg, color: isSystem ? '#a78bfa' : rc.color, display: 'inline-flex', alignItems: 'center', gap: 3, cursor: isSystem ? 'default' : 'pointer' }}>
                            {isSystem ? 'Owner' : (t.role === 'admin' ? 'Admin' : 'Trader')}{!isSystem && <span style={{ fontSize: 8, opacity: 0.7 }}>▾</span>}
                          </span>
                          {traderDrop?.type === 'role' && traderDrop?.id === t.id && (
                            <div style={{ position: 'absolute', bottom: '100%', left: 0, marginBottom: 4, background: '#1f2937', border: '1px solid #374151', borderRadius: 8, zIndex: 100, minWidth: 90, overflow: 'hidden' }}>
                              {[['trader','Trader'],['admin','Admin'],['employee','Employee']].map(([v,l]) => (
                                <button key={v} onClick={(e) => { e.stopPropagation(); handleRoleChange(t.id, v); setTraderDrop(null); }}
                                  style={{ width: '100%', textAlign: 'left', padding: '7px 12px', background: (t.role||'trader') === v ? 'rgba(245,158,11,0.1)' : 'none', border: 'none', color: (t.role||'trader') === v ? '#f59e0b' : '#d1d5db', fontSize: 12, cursor: 'pointer' }}>{l}</button>
                              ))}
                            </div>
                          )}
                        </div>
                        {/* Action ⋮ */}
                        <div style={{ marginLeft: 'auto', position: 'relative' }} onClick={e => { e.stopPropagation(); if (!isSystem) setTraderDrop(d => d?.type === 'action' && d?.id === t.id ? null : { type: 'action', id: t.id }); }}>
                          <div style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, color: isSystem ? '#374151' : '#6b7280', cursor: isSystem ? 'not-allowed' : 'pointer', fontSize: 16 }}>⋮</div>
                          {traderDrop?.type === 'action' && traderDrop?.id === t.id && (
                            <div style={{ position: 'absolute', bottom: '100%', right: 0, marginBottom: 4, background: '#1f2937', border: '1px solid #374151', borderRadius: 8, zIndex: 100, minWidth: 130, overflow: 'hidden' }}>
                              <button onClick={(e) => { e.stopPropagation(); setTraderDrop(null); openTraderPage(t); }}
                                style={{ width: '100%', textAlign: 'left', padding: '8px 14px', background: 'none', border: 'none', color: '#d1d5db', fontSize: 12, cursor: 'pointer' }}>View details</button>
                              {[['active','Set active'],['paused','Pause bot'],['suspended','Suspend']].map(([v,l]) => (
                                <button key={v} onClick={(e) => { e.stopPropagation(); handleStatusChange(t.id, v); setTraderDrop(null); }}
                                  style={{ width: '100%', textAlign: 'left', padding: '8px 14px', background: 'none', border: 'none', color: v === 'suspended' ? '#f87171' : '#d1d5db', fontSize: 12, cursor: 'pointer' }}>{l}</button>
                              ))}
                              <div style={{ borderTop: '1px solid #374151' }} />
                              <button onClick={(e) => { e.stopPropagation(); setTraderDrop(null); handleDeleteTrader(t.id, t.full_name); }}
                                style={{ width: '100%', textAlign: 'left', padding: '8px 14px', background: 'none', border: 'none', color: '#f87171', fontSize: 12, cursor: 'pointer' }}>Delete trader</button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}

                {/* Footer */}
                <div style={{ color: '#6b7280', fontSize: 11, textAlign: 'center', padding: '8px 0' }}>
                  Showing {sorted.length} of {baseList.length} traders
                </div>
              </div>
            );
          })()}

          {/* ==================== TRADER DETAIL PAGE ==================== */}
          {activeTab === 'traders' && viewingTrader && (() => {
            const t = viewingTrader;
            const w = viewingTraderWallet;
            const initials = (t.full_name || '?').split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase();
            const statusColor = t.status === 'active' ? '#10b981' : t.status === 'suspended' ? '#ef4444' : '#f59e0b';
            const tierColor = t.tier === 'advanced' ? '#ef4444' : t.tier === 'pro_max' ? '#8b5cf6' : t.tier === 'pro' ? '#f59e0b' : t.tier === 'starter' ? '#3b82f6' : '#6b7280';

            const fmtCompact = (v) => {
              const n = Math.abs(v || 0);
              if (n >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
              if (n >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
              if (n >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
              return String(v || 0);
            };
            const tierLabel = t.tier === 'standard' ? 'Free' : t.tier === 'pro_max' ? 'Starter Pro Max' : t.tier === 'pro' ? 'Starter Pro' : t.tier === 'starter' ? 'Starter' : (t.tier || 'Free');
            const MT = { gold: { l: 'Gold Merchant', c: 'var(--gold)' }, silver: { l: 'Silver Merchant', c: '#cbd5e1' }, bronze: { l: 'Bronze Merchant', c: '#d97757' } };
            const merchant = (t.binance_api_key_saved && !t.binance_api_key_invalid) ? MT[(t.binance_merchant_tier || t.binance_p2p_tier || '').toLowerCase()] : null;
            const seen = fmtLastSeen(t.last_seen_at, t.last_web_active || t.last_login);

            return (
              <div className="tdx">
                {/* Back bar */}
                <div className="tdx-back">
                  <button onClick={() => setViewingTrader(null)} className="back-btn">
                    ← All Traders
                  </button>
                </div>

                {viewingTraderLoading && (
                  <div className="tdx-loading">Loading trader details…</div>
                )}

                {!viewingTraderLoading && (
                  <>
                    {/* ===== HERO ===== */}
                    <div className="card hero">
                      <div className="hero-main">
                        <div className="avatar">{initials}</div>
                        <div className="hero-id">
                          <div className="hero-name">{t.full_name}</div>
                          <div className="hero-sub">Trader ID #{t.id}{t.created_at ? ` · Joined ${fmtDateOnlyEAT(t.created_at)}` : ''}</div>
                          <div className="chips">
                            <span className={`chip ${t.status === 'active' ? 'chip--pos' : t.status === 'suspended' ? 'chip--neg' : 'chip--warn'}`}>{t.status || 'pending'}</span>
                            <span className="chip chip--brand">{tierLabel}</span>
                            <span className="chip">{t.role || 'trader'}</span>
                            {merchant && (
                              <span className="chip chip--gold" style={{ color: merchant.c, borderColor: merchant.c }}>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
                                {merchant.l}
                              </span>
                            )}
                            {(() => {
                              const connected = t.binance_api_key_saved && !t.binance_api_key_invalid;
                              const label = !t.binance_api_key_saved ? 'Binance API ✗' : t.binance_api_key_invalid ? 'Binance API ⚠' : 'Binance API ✓';
                              const title = !t.binance_api_key_saved ? 'No Binance API key connected' : t.binance_api_key_invalid ? 'Binance API key is invalid — trader must reconnect' : 'Binance API key connected';
                              return <span title={title} className={`chip ${connected ? 'chip--pos' : 'chip--neg'}`}>{label}</span>;
                            })()}
                            <span title={t.telegram_connected ? `Telegram connected${t.telegram_notify_scope && t.telegram_notify_scope !== 'both' ? ` (${t.telegram_notify_scope} alerts)` : ''}` : 'Telegram not connected'} className={`chip ${t.telegram_connected ? 'chip--pos' : 'chip--neg'}`}>{t.telegram_connected ? 'Telegram ✓' : 'Telegram ✗'}</span>
                            <span title={t.relay_connected ? 'Relay connected — Binance calls run from this trader’s own IP' : 'Relay not connected'} className={`chip ${t.relay_connected ? 'chip--pos' : ''}`}>{t.relay_connected ? 'Relay ✓' : 'Relay ✗'}</span>
                            {t.relay_ip && (
                              <span title={t.relay_connected ? "Trader's live relay IP (their real connection)" : "Trader's last-known relay IP"} className="chip" style={{ fontFamily: 'monospace' }}>
                                🌐 {t.relay_ip}
                              </span>
                            )}
                            <span className={`chip ${seen.online ? 'chip--pos' : ''}`}><span className="dot" style={{ background: seen.online ? 'var(--pos)' : 'var(--text-3)' }} />{seen.online ? seen.label : `Last seen ${seen.label}`}</span>
                          </div>
                        </div>
                      </div>
                      <div className="hero-actions">
                        <div className="field">
                          <label>Status</label>
                          <select value={t.status || 'pending'} onChange={async (e) => { const v = e.target.value; setViewingTrader(prev => ({ ...prev, status: v })); await handleStatusChange(t.id, v); await refreshTraderDetail(t.id); }}>
                            <option value="pending">Pending</option>
                            <option value="active">Active</option>
                            <option value="paused">Paused</option>
                            <option value="suspended">Suspended</option>
                          </select>
                        </div>
                        <div className="field">
                          <label>Tier</label>
                          <select value={t.tier || 'standard'} onChange={async (e) => {
                            const v = e.target.value;
                            const labelMap = { standard: null, starter: 'Starter', pro: 'Starter Pro', pro_max: 'Starter Pro Max' };
                            // Optimistic: tier chip + plan label update instantly
                            setViewingTrader(prev => ({ ...prev, tier: v, plan: v === 'standard' ? null : v, plan_label: labelMap[v] }));
                            await handleTierChange(t.id, v);
                            // Authoritative: pull fresh plan, daily limits, expiry
                            await refreshTraderDetail(t.id);
                          }}>
                            <option value="standard">Free</option>
                            <option value="starter">Starter — KES 3,000/mo</option>
                            <option value="pro">Starter Pro — KES 5,000/mo</option>
                            <option value="pro_max">Starter Pro Max — KES 10,000/mo</option>
                          </select>
                        </div>
                        <div className="field">
                          <label>Role</label>
                          <select value={t.role || 'trader'} onChange={async (e) => { const v = e.target.value; setViewingTrader(prev => ({ ...prev, role: v })); await handleRoleChange(t.id, v); await refreshTraderDetail(t.id); }}>
                            <option value="trader">Trader</option>
                            <option value="employee">Employee</option>
                            <option value="admin">Admin</option>
                          </select>
                        </div>
                        <div className="field">
                          <label>Price Tracker</label>
                          <select
                            value={t.price_tracker_enabled ? 'on' : 'off'}
                            onChange={async (e) => {
                              const on = e.target.value === 'on';
                              setViewingTrader(prev => ({ ...prev, price_tracker_enabled: on }));
                              try { await api.put(`/admin/traders/${t.id}/price-tracker?enabled=${on}`); } catch (_) {}
                              await refreshTraderDetail(t.id);
                            }}>
                            <option value="off">Off</option>
                            <option value="on">On</option>
                          </select>
                        </div>
                      </div>
                    </div>

                    {/* ===== PENDING ORDERS BANNER ===== */}
                    {typeof t.pending_orders_count === 'number' && (
                      <div className={`banner ${t.pending_orders_count > 0 ? 'banner--warn' : 'banner--dim'}`}>
                        <div className="banner-text">
                          <span className="banner-title">Pending orders</span>
                          <span className="banner-note">processing now</span>
                        </div>
                        <div className="banner-num">{t.pending_orders_count}</div>
                      </div>
                    )}

                    {/* ===== KPI ROW ===== */}
                    {(() => {
                      const net = (traderPnl?.summary?.net != null) ? traderPnl.summary.net : (t.live_today_net_profit || 0);
                      const sellTrades = traderPnl?.summary?.trades ?? 0;
                      return (
                        <div className="kpi-row">
                          <div className="kpi">
                            <div className="kpi-label">Live Balance</div>
                            <div className="kpi-val num" style={{ color: 'var(--pos)' }}>
                              {t.choice_account_id ? (cbBalance ? `KES ${(parseFloat(cbBalance.balance) || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—') : 'No account'}
                            </div>
                            <div className="kpi-delta">{t.choice_account_id ? (t.choice_account_id) : 'No Choice Bank account'}</div>
                          </div>
                          <div className="kpi">
                            <div className="kpi-label">Net P&amp;L · Today</div>
                            <div className="kpi-val num" style={{ color: net > 0 ? 'var(--pos)' : net < 0 ? 'var(--neg)' : 'var(--text)' }}>
                              {net > 0 ? '+' : net < 0 ? '-' : ''}KES {Math.abs(net).toLocaleString('en-KE', { maximumFractionDigits: 0 })}
                            </div>
                            <div className="kpi-delta">{sellTrades} completed sell orders</div>
                          </div>
                          {(() => {
                            const actSeg = (
                              <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
                                {[['24h', '24h'], ['7d', '7d'], ['30d', '30d'], ['all', 'Life']].map(([p, lbl]) => (
                                  <button key={p} onClick={() => { setActivityPeriod(p); loadTraderActivity(t.id, p); }}
                                    style={{ flex: 1, padding: '3px 0', borderRadius: 5, fontSize: 10, fontWeight: 600, cursor: 'pointer',
                                      border: `1px solid ${activityPeriod === p ? 'var(--brand)' : 'var(--line)'}`,
                                      background: activityPeriod === p ? 'rgba(242,145,30,.14)' : 'transparent',
                                      color: activityPeriod === p ? 'var(--brand)' : 'var(--text-3)' }}>
                                    {lbl}
                                  </button>
                                ))}
                              </div>
                            );
                            return (
                              <>
                                <div className="kpi">
                                  <div className="kpi-label">Total Trades</div>
                                  <div className="kpi-val num">{activityPeriod === 'all' ? (t.total_trades ?? 0) : (activityLoading ? '…' : (activity?.trades ?? 0))}</div>
                                  {actSeg}
                                </div>
                                <div className="kpi">
                                  <div className="kpi-label">Volume</div>
                                  <div className="kpi-val num">{activityPeriod === 'all' ? fmtKES(t.total_volume) : (activityLoading ? '…' : fmtKES(activity?.volume))}</div>
                                  {actSeg}
                                </div>
                              </>
                            );
                          })()}
                        </div>
                      );
                    })()}

                    {/* ===== GRID2: ACCOUNT INFO + CHOICE BANK ===== */}
                    <div className="grid2">
                      {/* Account Information */}
                      <div className="card">
                        <div className="card-h"><h3>Account Information</h3></div>
                        <div className="card-b">
                          <div className="kv">
                            <div className="kv-row"><span className="kv-k">Email</span><span className="kv-v">{t.email || '—'}</span></div>
                            <div className="kv-row"><span className="kv-k">Phone</span><span className="kv-v">{t.phone || '—'}</span></div>
                            <div className="kv-row"><span className="kv-k">Trades</span><span className="kv-v num">{t.total_trades ?? '—'}</span></div>
                            <div className="kv-row"><span className="kv-k">Volume</span><span className="kv-v num">{fmtKES(t.total_volume)}</span></div>
                            <div className="kv-row"><span className="kv-k">Joined</span><span className="kv-v">{t.created_at ? fmtDateOnlyEAT(t.created_at) : '—'}</span></div>
                            <div className="kv-row"><span className="kv-k">Last Login</span><span className="kv-v">{t.last_login ? fmtDateEAT(t.last_login) : '—'}</span></div>
                            <div className="kv-row"><span className="kv-k">Bot Last Sync</span><span className="kv-v">{t.last_seen_at ? fmtDateEAT(t.last_seen_at) : '—'}</span></div>
                            <div className="kv-row"><span className="kv-k">Web Last Active</span><span className="kv-v">{t.last_login ? fmtDateEAT(t.last_login) : '—'}</span></div>
                            <div className="kv-row"><span className="kv-k">Security Q</span><span className="kv-v">{t.security_question || '—'}</span></div>
                            <div className="kv-row">
                              <span className="kv-k">Answer</span>
                              <span className="kv-v" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                {showSecurityAnswer ? (t.security_answer || '—') : '••••••••'}
                                <button className="mini-btn" onClick={() => setShowSecurityAnswer(v => !v)}>{showSecurityAnswer ? 'Hide' : 'Show'}</button>
                              </span>
                            </div>
                            {t.google_id && (
                              <div className="kv-row"><span className="kv-k">Google ID</span><span className="kv-v" style={{ fontSize: 12, wordBreak: 'break-all' }}>{t.google_id}</span></div>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Choice Bank */}
                      <div className="card">
                        <div className="card-h">
                          <h3>Choice Bank</h3>
                          <button className="ghost-btn" disabled={cbBalanceLoading} onClick={() => { setCbBalanceLoading(true); adminGetTraderChoiceBalance(t.id).then(r => { setCbBalance(r.data); setCbBalanceLoading(false); }).catch(() => setCbBalanceLoading(false)); }}>
                            <RefreshCw size={13} /> {cbBalanceLoading ? 'Loading…' : 'Refresh'}
                          </button>
                        </div>
                        <CbBalancePoller traderId={t.id} onData={setCbBalance} />
                        <div className="card-b">
                          {t.choice_account_id ? (
                            cbBalance ? (
                              <>
                                <div className="cb-bal-label">Live Balance</div>
                                <div className="cb-bal num">KES {(parseFloat(cbBalance.balance) || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                                <div className="cb-acct num">{t.choice_account_id}</div>
                                <div className="cb-tags">
                                  {[['Status', cbBalance.account_status, cbBalance.account_status === 'Normal'],
                                    ['Dormant', cbBalance.dormant_status, cbBalance.dormant_status === 'Normal'],
                                    ['Freeze', cbBalance.freeze_status, cbBalance.freeze_status === 'Normal'],
                                  ].map(([lbl, val, ok]) => (
                                    <span key={lbl} className={`cb-tag ${ok ? 'cb-tag--ok' : 'cb-tag--bad'}`}>{lbl}: {val}</span>
                                  ))}
                                </div>
                              </>
                            ) : (
                              <div className="muted">Click Refresh to load balance</div>
                            )
                          ) : (
                            <div className="muted">No Choice Bank account</div>
                          )}
                          <button className="danger-btn" disabled={resetPwLoading}
                            onClick={async () => {
                              setResetPwLoading(true);
                              try {
                                await api.post(`/admin/traders/${t.id}/reset-password`);
                                setResetPwMsg('Password reset! New password sent via SMS.');
                              } catch (e) { setResetPwMsg('Failed to reset password.'); }
                              setResetPwLoading(false);
                            }}>
                            {resetPwLoading ? 'Resetting…' : 'Reset Password'}
                          </button>
                          {resetPwMsg && <div className="reset-msg" style={{ color: resetPwMsg.includes('Failed') ? 'var(--neg)' : 'var(--pos)' }}>{resetPwMsg}</div>}
                        </div>
                      </div>
                    </div>

                    {/* ===== SUBSCRIPTION & DAILY LIMITS ===== */}
                    <div className="card">
                      <div className="card-h"><h3>Subscription &amp; Daily Limits</h3></div>
                      <div className="card-b">
                        <div className="sub-head">
                          <div>
                            <div className="kv-k">Current Plan</div>
                            <div className="sub-plan" style={{ color: t.plan ? 'var(--brand)' : 'var(--text-3)' }}>{t.plan_label || 'No active subscription'}</div>
                          </div>
                          {t.subscription_expires_at && (
                            <div style={{ textAlign: 'right' }}>
                              <div className="kv-k">Expires</div>
                              <div className="sub-exp">
                                {new Date(t.subscription_expires_at).toLocaleDateString('en-KE', { timeZone: 'Africa/Nairobi', day: '2-digit', month: 'short', year: 'numeric' })}
                                {(() => { const d = Math.ceil((new Date(t.subscription_expires_at) - new Date()) / 86400000); return d >= 0 ? <span className="sub-days"> · {d}d left</span> : <span className="sub-days sub-days--exp"> · expired</span>; })()}
                              </div>
                            </div>
                          )}
                        </div>
                        {/* Set / extend the expiry date+time without having to switch plan. For a free
                            trader, pick a plan via the Tier dropdown above (which opens the same picker). */}
                        {t.account_number && (
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, padding: '9px 12px', borderRadius: 9, background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)' }}>
                            <span style={{ color: '#9aa4b2', fontSize: 12 }}>Paybill account no.</span>
                            <b style={{ color: '#f59e0b', fontSize: 14, letterSpacing: 0.5 }}>{t.account_number}</b>
                          </div>
                        )}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, padding: '9px 12px', borderRadius: 9, background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.2)' }}>
                          <span style={{ color: '#9aa4b2', fontSize: 12 }}>Subscription (Paybill) balance</span>
                          <b style={{ color: '#10b981', fontSize: 15 }}>KES {Number(t.subscription_balance || 0).toLocaleString()}</b>
                        </div>
                        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                          <button
                            onClick={() => setTierGrant({ traderId: t.id, tier: (t.tier && t.tier !== 'standard') ? t.tier : 'starter' })}
                            style={{ flex: 1, padding: '11px', borderRadius: 10, border: '1px solid #f59e0b', background: 'rgba(245,158,11,0.10)', color: '#f59e0b', fontWeight: 700, fontSize: 12.5, cursor: 'pointer' }}>
                            📅 {t.subscription_expires_at ? 'Change / extend expiry' : 'Grant subscription'}
                          </button>
                          <button
                            onClick={() => setSmsTarget({ traderId: t.id, name: t.full_name })}
                            style={{ flex: 1, padding: '11px', borderRadius: 10, border: '1px solid #2a3142', background: 'rgba(59,130,246,0.10)', color: '#60a5fa', fontWeight: 700, fontSize: 12.5, cursor: 'pointer' }}>
                            💬 Send SMS
                          </button>
                        </div>
                        <div className="limit-grid">
                          {[
                            ['Trades today', t.daily_trade_unlimited, t.daily_trade_used, t.daily_trade_limit, 'var(--info)'],
                            ['Telegram alerts today', t.daily_tg_unlimited, t.daily_tg_used, t.daily_tg_limit, 'var(--pos)'],
                          ].map(([label, unlimited, used, limit, color]) => (
                            <div key={label} className="limit-card">
                              <div className="kv-k">{label}</div>
                              <div className="limit-val num" style={{ color }}>{used ?? 0} <span className="limit-sub">/ {unlimited ? 'unlimited' : (limit ?? 0)}</span></div>
                            </div>
                          ))}
                        </div>
                        <div className="fine-print">Daily limits reset at 3:00 AM (EAT). Non-subscribers are not blocked.</div>
                      </div>
                    </div>

                    {/* ===== REVENUE SIMULATION (BUY ORDERS) ===== */}
                    <div className="card">
                      <div className="card-h">
                        <h3>
                          💰 Revenue Simulation
                          <span className={`tag ${revMode === 'prod' ? 'tag--buy' : 'tag--out'}`} style={{ marginLeft: 8, verticalAlign: 'middle' }}>
                            {revMode === 'prod' ? 'PRODUCTION' : 'SIMULATION'}
                          </span>
                        </h3>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <button
                            onClick={() => {
                              const next = revMode === 'prod' ? 'sim' : 'prod';
                              if (next === 'prod' && !window.confirm('Switch revenue tracking to PRODUCTION?\n\nUse this only once Choice Microfinance approval is live and we are actually collecting these fees.')) return;
                              setRevMode(next);
                              localStorage.setItem('sparkp2p_revenue_mode', next);
                            }}
                            style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid var(--line)', background: 'var(--s2)', color: 'var(--text-2)', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}
                          >
                            {revMode === 'prod' ? 'Back to Simulation' : 'Switch to Production'}
                          </button>
                          <div className="seg">
                            {[['auto', 'Auto'], ['mpesa', 'M-Pesa'], ['pesalink', 'Pesalink']].map(([m, lbl]) => (
                              <button key={m} className={revSimMethod === m ? 'active' : ''} title="Assumed payout rail — inferred from amount, since historical orders don't record it" onClick={async () => { setRevSimMethod(m); await loadTraderRevenueSim(t.id, revSimPeriod, m); }}>
                                {lbl}
                              </button>
                            ))}
                          </div>
                          <div className="seg">
                            {['today', 'week', 'month'].map(p => (
                              <button key={p} className={revSimPeriod === p ? 'active' : ''} onClick={async () => { setRevSimPeriod(p); await loadTraderRevenueSim(t.id, p, revSimMethod); }}>
                                {p === 'today' ? 'Today' : p === 'week' ? '7 Days' : '30 Days'}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                      <div className="card-b">
                        {revSimLoading ? (
                          <div className="muted center">Loading…</div>
                        ) : traderRevSim ? (() => {
                          const T = traderRevSim.total, M = traderRevSim.channels.MPESA, P = traderRevSim.channels.PESALINK;
                          const kes = n => `KES ${Math.round(n || 0).toLocaleString('en-KE')}`;
                          return (
                            <>
                              <p className="muted" style={{ marginTop: 0, marginBottom: 14, fontSize: 12 }}>
                                {revMode === 'prod' ? 'Live' : 'Projected'} outbound-fee revenue from <strong>{T.count}</strong> completed buy order{T.count === 1 ? '' : 's'} — the fee earned when we pay the seller from the trader's Choice Bank account. Sell orders carry no outbound fee.
                                {' '}{revSimMethod === 'auto'
                                  ? <>Rail is <strong>inferred by amount</strong> — M-Pesa up to KES 250,000/order, Pesalink above (the actual rail isn't recorded on historical orders).</>
                                  : revSimMethod === 'mpesa'
                                    ? <>Assuming <strong>every payout via M-Pesa</strong> (what-if).</>
                                    : <>Assuming <strong>every payout via Pesalink</strong> (what-if).</>}
                              </p>
                              <div className="pnl-grid">
                                <div className="pnl-card"><div className="kv-k">Merchant Charged</div><div className="pnl-val num" style={{ color: 'var(--text)' }}>{kes(T.merchant_charged)}</div></div>
                                <div className="pnl-card"><div className="kv-k">Choice Bank Keeps</div><div className="pnl-val num" style={{ color: 'var(--neg)' }}>{kes(T.choice_keeps)}</div></div>
                                <div className="pnl-card"><div className="kv-k">SparkP2P Profit</div><div className="pnl-val num" style={{ color: 'var(--pos)' }}>{kes(T.our_profit)}</div></div>
                                <div className="pnl-card"><div className="kv-k">Buy Orders</div><div className="pnl-val num" style={{ color: 'var(--brand)' }}>{T.count}</div></div>
                              </div>
                              <div className="tbl-wrap" style={{ marginTop: 12 }}>
                                <table className="tdx-tbl">
                                  <thead><tr><th>Method</th><th className="r">Orders</th><th className="r">Volume</th><th className="r">Merchant Charged</th><th className="r">Choice Keeps</th><th className="r">SparkP2P Profit</th></tr></thead>
                                  <tbody>
                                    {[['M-Pesa', M], ['Pesalink', P]].map(([label, c]) => (
                                      <tr key={label}>
                                        <td><span className={`tag ${label === 'M-Pesa' ? 'tag--buy' : 'tag--sell'}`}>{label}</span></td>
                                        <td className="r num">{c.count}</td>
                                        <td className="r num">{kes(c.volume)}</td>
                                        <td className="r num">{kes(c.merchant_charged)}</td>
                                        <td className="r num" style={{ color: 'var(--neg)' }}>{kes(c.choice_keeps)}</td>
                                        <td className="r num" style={{ color: 'var(--pos)', fontWeight: 700 }}>{kes(c.our_profit)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </>
                          );
                        })() : <div className="muted center">No buy orders in this period.</div>}
                      </div>
                    </div>

                    {/* ===== PROFIT & LOSS ===== */}
                    <div className="card">
                      <div className="card-h">
                        <h3><TrendingUp size={15} style={{ color: 'var(--pos)', verticalAlign: '-2px', marginRight: 6 }} />Profit &amp; Loss</h3>
                        <div className="seg">
                          {['today', 'week', 'month'].map(p => (
                            <button key={p} className={pnlPeriod === p ? 'active' : ''} onClick={async () => { setPnlPeriod(p); await loadTraderPnl(t.id, p); }}>
                              {p === 'today' ? 'Today' : p === 'week' ? '7 Days' : '30 Days'}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="card-b">
                        {pnlLoading ? (
                          <div className="muted center">Loading…</div>
                        ) : traderPnl ? (() => {
                          const s = traderPnl.summary;
                          return (
                            <>
                              <div className="pnl-grid">
                                {[
                                  { label: 'Gross Revenue', value: s.revenue, color: 'var(--pos)', prefix: '+' },
                                  { label: 'Fees Paid', value: s.fees, color: 'var(--neg)', prefix: '-' },
                                  { label: 'Net P&L', value: s.net, color: s.net > 0 ? 'var(--pos)' : s.net < 0 ? 'var(--neg)' : 'var(--text)', prefix: s.net > 0 ? '+' : s.net < 0 ? '-' : '' },
                                  { label: 'Completed Orders', value: s.completed_orders ?? s.trades, color: 'var(--brand)', isCount: true, breakdown: { buy: s.buy_orders ?? 0, sell: s.sell_orders ?? 0 } },
                                ].map(({ label, value, color, isCount, prefix, breakdown }) => (
                                  <div key={label} className="pnl-card">
                                    <div className="kv-k">{label}</div>
                                    <div className="pnl-val num" style={{ color }}>{isCount ? value : `${prefix || ''}KES ${Math.abs(value).toLocaleString('en-KE', { maximumFractionDigits: 0 })}`}</div>
                                    {breakdown && (
                                      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                                        <span className="tag tag--buy">{breakdown.buy} Buy</span>
                                        <span className="tag tag--sell">{breakdown.sell} Sell</span>
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                              {traderPnl.daily.length > 1 && (
                                <div className="tbl-wrap">
                                  <table className="tdx-tbl">
                                    <thead><tr><th>Date</th><th>Orders</th><th className="r">Revenue</th><th className="r">Fees</th><th className="r">Net P&amp;L</th></tr></thead>
                                    <tbody>
                                      {[...traderPnl.daily].reverse().map(row => (
                                        <tr key={row.date}>
                                          <td className="dim">{new Date(row.date + 'T12:00:00Z').toLocaleDateString('en-KE', { timeZone: 'Africa/Nairobi', weekday: 'short', month: 'short', day: 'numeric' })}</td>
                                          <td><span className="pill pill--brand">{row.trades}</span></td>
                                          <td className="r num" style={{ color: 'var(--pos)' }}>{row.revenue > 0 ? `+KES ${row.revenue.toLocaleString()}` : '—'}</td>
                                          <td className="r num" style={{ color: 'var(--neg)' }}>{row.fees > 0 ? `-KES ${row.fees.toLocaleString()}` : '—'}</td>
                                          <td className="r num" style={{ color: row.net >= 0 ? 'var(--info)' : 'var(--neg)', fontWeight: 700 }}>{(row.net != null && row.net !== 0) ? `${row.net >= 0 ? '+' : ''}KES ${(row.net || 0).toLocaleString()}` : '—'}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                              {traderPnl.daily.length === 1 && (s.completed_orders ?? s.trades) === 0 && (
                                <div className="muted center">No completed orders today.</div>
                              )}
                            </>
                          );
                        })() : null}
                      </div>
                    </div>

                    {/* ===== WITHDRAWAL METHOD ===== */}
                    <div className="card">
                      <div className="card-h">
                        <h3>Withdrawal Method</h3>
                        {t.settlement_changed_at && <span className="card-count">Changed {fmtDateOnlyEAT(t.settlement_changed_at)}</span>}
                      </div>
                      <div className="card-b">
                        {(() => {
                          const method = (t.settlement_method || '').toString().toLowerCase();
                          const isBank = method === 'bank' || method === 'bank_paybill';
                          const methodLabel = method === 'mpesa' ? 'M-Pesa' : method === 'paybill' ? 'Paybill' : isBank ? 'I&M Bank' : method || '—';
                          const pendingMethod = (t.pending_settlement_method || '').toString().toLowerCase();
                          const isPendBank = pendingMethod === 'bank' || pendingMethod === 'bank_paybill' || pendingMethod === 'im_update';
                          const pendingLabel = (pendingMethod === 'mpesa' || pendingMethod === 'mpesa_update') ? 'M-Pesa' : pendingMethod === 'paybill' ? 'Paybill' : isPendBank ? 'I&M Bank' : pendingMethod || '';
                          return (
                            <>
                              <div className="wd-head">
                                <span className="wd-method">{methodLabel}</span>
                                {pendingMethod && <span className="wd-pending">Pending change → {pendingLabel}</span>}
                              </div>
                              <div className="kv">
                                {method === 'mpesa' && t.settlement_phone && <div className="kv-row"><span className="kv-k">M-Pesa Phone</span><span className="kv-v">{t.settlement_phone}</span></div>}
                                {method === 'paybill' && t.settlement_paybill && <div className="kv-row"><span className="kv-k">Paybill Number</span><span className="kv-v">{t.settlement_paybill}</span></div>}
                                {method === 'paybill' && t.settlement_account && <div className="kv-row"><span className="kv-k">Account Reference</span><span className="kv-v">{t.settlement_account}</span></div>}
                                {isBank && t.settlement_account && <div className="kv-row"><span className="kv-k">Account Number</span><span className="kv-v">{t.settlement_account}</span></div>}
                                {isBank && t.settlement_bank_name && <div className="kv-row"><span className="kv-k">Bank Name</span><span className="kv-v">{t.settlement_bank_name}</span></div>}
                                {isBank && t.settlement_phone && <div className="kv-row"><span className="kv-k">M-Pesa Fallback</span><span className="kv-v">{t.settlement_phone}</span></div>}
                              </div>
                              {pendingMethod && (
                                <div className="wd-pending-box">
                                  <div className="wd-pending-title">Pending Change (48hr cooldown)</div>
                                  <div className="kv">
                                    {pendingMethod === 'mpesa' && t.pending_settlement_phone && <div className="kv-row"><span className="kv-k">New Phone</span><span className="kv-v">{t.pending_settlement_phone}</span></div>}
                                    {pendingMethod === 'paybill' && t.pending_settlement_paybill && <div className="kv-row"><span className="kv-k">New Paybill</span><span className="kv-v">{t.pending_settlement_paybill}</span></div>}
                                    {pendingMethod === 'paybill' && t.pending_settlement_account && <div className="kv-row"><span className="kv-k">New Account Ref</span><span className="kv-v">{t.pending_settlement_account}</span></div>}
                                    {isPendBank && t.pending_settlement_account && <div className="kv-row"><span className="kv-k">New Account</span><span className="kv-v">{t.pending_settlement_account}</span></div>}
                                    {isPendBank && t.pending_settlement_bank_name && <div className="kv-row"><span className="kv-k">New Bank</span><span className="kv-v">{t.pending_settlement_bank_name}</span></div>}
                                  </div>
                                </div>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    </div>

                    {/* ===== CHOICE BANK ACCOUNT ===== */}
                    <div className="card">
                      <div className="card-h">
                        <h3>Choice Bank Account</h3>
                        <span className="card-count" style={{ color: t.choice_account_id ? 'var(--pos)' : 'var(--warn)' }}>{t.choice_account_id ? 'Approved' : t.choice_kyc_status ? t.choice_kyc_status : 'Not verified'}</span>
                      </div>
                      <div className="card-b">
                        <div className="limit-grid">
                          <div className="limit-card"><div className="kv-k">Account Number</div><div className="limit-val num">{t.choice_account_id || '—'}</div></div>
                          <div className="limit-card"><div className="kv-k">Paybill</div><div className="limit-val num" style={{ color: 'var(--gold)' }}>{connProfile?.choice_paybill || '444174'}</div></div>
                          <div className="limit-card"><div className="kv-k">KYC Status</div><div className="limit-val" style={{ fontSize: 14, color: t.choice_account_id ? 'var(--pos)' : 'var(--warn)' }}>{t.choice_account_id ? 'Approved' : t.choice_kyc_status || 'Not started'}</div></div>
                          <div className="limit-card"><div className="kv-k">Account Status</div><div className="limit-val" style={{ fontSize: 14, color: cbBalance?.account_status === 'Normal' ? 'var(--pos)' : cbBalance ? 'var(--neg)' : 'var(--text-3)' }}>{cbBalance?.account_status || '—'}</div></div>
                        </div>
                      </div>
                    </div>

                    {/* ===== RESOLVE UNMATCHED PAYMENT ===== */}
                    <div className="card card--warn">
                      <div className="card-h"><h3 style={{ color: 'var(--brand)' }}>Resolve Unmatched Payment</h3></div>
                      <div className="card-b">
                        <p className="resolve-desc">Enter the M-Pesa reference and amount to verify with Safaricom and credit this trader's wallet.</p>
                        <div className="resolve-row">
                          <input className="tdx-input" value={resolveRef} onChange={e => setResolveRef(e.target.value.toUpperCase())} placeholder="M-Pesa Ref e.g. QK12AB3CD4" />
                          <input className="tdx-input" value={resolveAmount} onChange={e => setResolveAmount(e.target.value)} placeholder="Amount (KES)" type="number" />
                          <button className="verify-btn" disabled={resolveLoading || !resolveRef || !resolveAmount}
                            onClick={async () => {
                              setResolveLoading(true);
                              setResolveMsg({ text: '', type: '' });
                              try {
                                const res = await api.post(`/admin/traders/${t.id}/resolve-payment`, {
                                  mpesa_ref: resolveRef,
                                  amount: parseFloat(resolveAmount),
                                });
                                const { status, message } = res.data;

                                // Fast path: payment already in our DB — credited immediately
                                if (status === 'credited') {
                                  setResolveMsg({ text: message, type: 'success' });
                                  setResolveRef(''); setResolveAmount('');
                                  api.get(`/admin/traders/${t.id}/wallet`).then(r => setViewingTraderWallet(r.data)).catch(() => {});
                                  setResolveLoading(false);
                                  return;
                                }

                                // Slow path: not in DB, waiting for Safaricom async callback
                                setResolveMsg({ text: message || 'Querying Safaricom...', type: 'info' });
                                let attempts = 0;
                                const poll = setInterval(async () => {
                                  attempts++;
                                  try {
                                    const r = await api.get(`/admin/traders/${t.id}/resolve-payment/status?mpesa_ref=${resolveRef}`);
                                    const { status: st, message: msg } = r.data;
                                    if (st === 'credited') {
                                      setResolveMsg({ text: msg, type: 'success' });
                                      setResolveRef(''); setResolveAmount('');
                                      clearInterval(poll);
                                      api.get(`/admin/traders/${t.id}/wallet`).then(r => setViewingTraderWallet(r.data)).catch(() => {});
                                    } else if (st === 'failed') {
                                      setResolveMsg({ text: msg, type: 'error' });
                                      clearInterval(poll);
                                    } else if (attempts >= 12) {
                                      setResolveMsg({ text: 'Safaricom took too long to respond. Try again.', type: 'error' });
                                      clearInterval(poll);
                                    }
                                  } catch (e) { clearInterval(poll); }
                                }, 3000);
                              } catch (e) {
                                setResolveMsg({ text: e.response?.data?.detail || 'Failed to resolve payment.', type: 'error' });
                              }
                              setResolveLoading(false);
                            }}>
                            {resolveLoading ? 'Submitting…' : 'Verify & Credit'}
                          </button>
                        </div>
                        {resolveMsg.text && (
                          <div className={`resolve-msg resolve-msg--${resolveMsg.type || 'info'}`}>{resolveMsg.text}</div>
                        )}
                      </div>
                    </div>

                    {/* ===== LEDGER (tabbed) ===== */}
                    {(() => {
                      const txTotalPages = Math.ceil(viewingTraderTx.length / PAGE_SIZE);
                      const txSlice = viewingTraderTx.slice((txPage - 1) * PAGE_SIZE, txPage * PAGE_SIZE);
                      const ordTotalPages = Math.ceil(viewingTraderOrders.length / PAGE_SIZE);
                      const ordSlice = viewingTraderOrders.slice((ordersPage - 1) * PAGE_SIZE, ordersPage * PAGE_SIZE);
                      return (
                        <div className="card">
                          <div className="tabs">
                            <button className={`tab ${ledgerTab === 'activity' ? 'tab--on' : ''}`} onClick={() => setLedgerTab('activity')}>Recent Activity <span className="tab-count">{viewingTraderTx.length}</span></button>
                            <button className={`tab ${ledgerTab === 'orders' ? 'tab--on' : ''}`} onClick={() => setLedgerTab('orders')}>Recent Orders <span className="tab-count">{viewingTraderOrders.length}</span></button>
                            <button className={`tab ${ledgerTab === 'logs' ? 'tab--on' : ''}`} onClick={() => setLedgerTab('logs')}>Bot Activity Logs</button>
                            {ledgerTab === 'logs' && (
                              <button className="ghost-btn tabs-action" onClick={async () => {
                                setBotLogsLoading(true);
                                try { const r = await getAdminTraderBotLogs(viewingTrader.id); setTraderBotLogs(r.data || []); } catch (_) {}
                                setBotLogsLoading(false);
                              }}>
                                <RefreshCw size={12} /> {botLogsLoading ? 'Refreshing…' : 'Refresh'}
                              </button>
                            )}
                          </div>

                          {/* ACTIVITY PANE */}
                          {ledgerTab === 'activity' && (
                            <div className="pane">
                              <div className="tbl-wrap">
                                <table className="tdx-tbl">
                                  <thead><tr><th>Type</th><th>Direction</th><th>Amount</th><th>Balance After</th><th>M-Pesa Code</th><th>Description</th><th>Status</th><th>Time</th></tr></thead>
                                  <tbody>
                                    {txSlice.length === 0 ? (
                                      <tr><td colSpan={8} className="empty">No transactions</td></tr>
                                    ) : txSlice.map((tx) => (
                                      <tr key={tx.id}>
                                        <td style={{ textTransform: 'capitalize' }}>{(tx.transaction_type || '').replace(/_/g, ' ')}</td>
                                        <td><span className={`tag ${tx.direction === 'inbound' ? 'tag--in' : 'tag--out'}`}>{tx.direction === 'inbound' ? 'IN' : 'OUT'}</span></td>
                                        <td className="num" style={{ fontWeight: 600, color: tx.direction === 'inbound' ? 'var(--pos)' : 'var(--brand)' }}>{tx.direction === 'inbound' ? '+' : '-'}{fmtKESFee(tx.amount)}</td>
                                        <td className="dim num">{tx.balance_after != null ? fmtKES(tx.balance_after) : '—'}</td>
                                        <td className="num" style={{ color: 'var(--brand)', fontSize: 11 }}>{tx.mpesa_transaction_id || tx.bill_ref_number || '—'}</td>
                                        <td className="dim" style={{ fontSize: 12, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tx.description || '—'}</td>
                                        <td><span className={`st ${tx.status === 'completed' ? 'st--done' : tx.status === 'failed' ? 'st--cancel' : 'st--pend'}`}>{tx.status}</span></td>
                                        <td className="dim">{tx.created_at ? fmtDateEAT(tx.created_at) : '—'}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                              {txTotalPages > 1 && (
                                <div className="pager">
                                  <button onClick={() => setTxPage(p => Math.max(1, p - 1))} disabled={txPage === 1}>← Prev</button>
                                  <span>Page {txPage} of {txTotalPages} · {viewingTraderTx.length} transactions</span>
                                  <button onClick={() => setTxPage(p => Math.min(txTotalPages, p + 1))} disabled={txPage === txTotalPages}>Next →</button>
                                </div>
                              )}
                            </div>
                          )}

                          {/* ORDERS PANE */}
                          {ledgerTab === 'orders' && (
                            <div className="pane">
                              <div className="tbl-wrap">
                                <table className="tdx-tbl">
                                  <thead><tr><th>Order #</th><th>Side</th><th>Crypto</th><th>Fiat Amount</th><th>Rate</th><th>Counterparty</th><th>Status</th><th>Created</th></tr></thead>
                                  <tbody>
                                    {ordSlice.length === 0 ? (
                                      <tr><td colSpan={8} className="empty">No orders</td></tr>
                                    ) : ordSlice.map((o) => (
                                      <tr key={o.id}>
                                        <td className="num" style={{ fontSize: 11 }}>{o.binance_order_number || o.id}</td>
                                        <td><span className={`tag ${o.side === 'BUY' ? 'tag--buy' : 'tag--sell'}`}>{o.side}</span></td>
                                        <td className="num" style={{ fontWeight: 600 }}>{o.crypto_amount} {o.asset || 'USDT'}</td>
                                        <td className="num" style={{ fontWeight: 600, color: 'var(--pos)' }}>{fmtKES(o.fiat_amount)}</td>
                                        <td className="dim num" style={{ fontSize: 12 }}>{o.price ? `${(o.price).toLocaleString()}/${o.asset || 'USDT'}` : '—'}</td>
                                        <td style={{ fontSize: 12 }}>{o.counterparty || '—'}</td>
                                        <td><span className={`st ${o.status === 'completed' ? 'st--done' : o.status === 'disputed' ? 'st--cancel' : o.status === 'cancelled' ? 'st--cancel' : 'st--pend'}`}>{o.status}</span></td>
                                        <td className="dim">{o.created_at ? fmtDateEAT(o.created_at) : '—'}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                              {ordTotalPages > 1 && (
                                <div className="pager">
                                  <button onClick={() => setOrdersPage(p => Math.max(1, p - 1))} disabled={ordersPage === 1}>← Prev</button>
                                  <span>Page {ordersPage} of {ordTotalPages} · {viewingTraderOrders.length} orders</span>
                                  <button onClick={() => setOrdersPage(p => Math.min(ordTotalPages, p + 1))} disabled={ordersPage === ordTotalPages}>Next →</button>
                                </div>
                              )}
                            </div>
                          )}

                          {/* LOGS PANE */}
                          {ledgerTab === 'logs' && (
                            <div className="pane">
                              <div className="logs">
                                {traderBotLogs.length === 0 ? (
                                  <div className="empty">No logs yet — logs appear here once the trader's bot sends activity.</div>
                                ) : traderBotLogs.map((log, i) => {
                                  const colors = { success: 'var(--pos)', error: 'var(--neg)', warning: 'var(--warn)', warn: 'var(--warn)', info: 'var(--text-3)' };
                                  const badges = { success: '✓', error: '✕', warning: '⚠', warn: '⚠', info: '·' };
                                  const color = colors[log.level] || 'var(--text-3)';
                                  const badge = badges[log.level] || '·';
                                  const time = log.time ? new Date(log.time).toLocaleTimeString('en-KE', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
                                  return (
                                    <div key={i} className="log-row">
                                      <span className="log-badge" style={{ color }}>{badge}</span>
                                      <span className="log-time num">{time}</span>
                                      <span className="log-msg" style={{ color: log.level === 'error' ? '#fca5a5' : log.level === 'success' ? '#6ee7b7' : (log.level === 'warning' || log.level === 'warn') ? '#fcd34d' : 'var(--text-2)' }}>{log.message}</span>
                                    </div>
                                  );
                                })}
                              </div>
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
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {disputes.map((d) => (
                          <tr key={d.id}>
                            <td className="mono" style={{ fontSize: 11 }}>{d.binance_order_number}</td>
                            <td>
                              <button
                                onClick={() => { setActiveTab('traders'); openTraderPage({ id: d.trader_id, full_name: d.trader_name }); }}
                                style={{ background: 'none', border: 'none', color: '#6366f1', cursor: 'pointer', fontWeight: 600, fontSize: 13, padding: 0, textDecoration: 'underline' }}
                              >
                                {d.trader_name}
                              </button>
                            </td>
                            <td><span className={`adm-badge ${d.side === 'BUY' ? 'green' : 'red'}`}>{d.side}</span></td>
                            <td>KES {(d.fiat_amount || 0).toLocaleString()}</td>
                            <td>{d.risk_score || '-'}</td>
                            <td>{fmtDateEAT(d.created_at)}</td>
                            <td>
                              <button
                                onClick={() => { setResolveModal(d); setResolveAction('cancel'); setResolveNote(''); }}
                                style={{ padding: '4px 12px', borderRadius: 6, border: 'none', background: 'linear-gradient(135deg, #10b981, #059669)', color: '#fff', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}
                              >
                                Resolve
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Resolve Dispute Modal */}
                {resolveModal && (
                  <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 28, width: 420, maxWidth: '90vw' }}>
                      <h3 style={{ margin: '0 0 6px', fontSize: 16 }}>Resolve Dispute</h3>
                      <p style={{ color: 'var(--text-dim)', fontSize: 12, margin: '0 0 20px' }}>
                        Order: <span className="mono" style={{ fontSize: 11 }}>{resolveModal.binance_order_number}</span> — KES {resolveModal.fiat_amount?.toLocaleString()} ({resolveModal.trader_name})
                      </p>

                      <div style={{ marginBottom: 16 }}>
                        <label style={{ fontSize: 12, color: 'var(--text-dim)', display: 'block', marginBottom: 6 }}>Action</label>
                        <div style={{ display: 'flex', gap: 8 }}>
                          {[['cancel', 'Cancel Order', '#ef4444'], ['release', 'Mark Completed', '#10b981']].map(([val, label, color]) => (
                            <button key={val} onClick={() => setResolveAction(val)}
                              style={{ flex: 1, padding: '8px 0', borderRadius: 8, border: `2px solid ${resolveAction === val ? color : 'var(--border)'}`, background: resolveAction === val ? `${color}22` : 'transparent', color: resolveAction === val ? color : 'var(--text-dim)', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div style={{ marginBottom: 20 }}>
                        <label style={{ fontSize: 12, color: 'var(--text-dim)', display: 'block', marginBottom: 6 }}>Resolution Note</label>
                        <textarea
                          value={resolveNote}
                          onChange={e => setResolveNote(e.target.value)}
                          placeholder="Describe how the dispute was resolved…"
                          style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 13, resize: 'vertical', minHeight: 80, boxSizing: 'border-box' }}
                        />
                      </div>

                      <div style={{ display: 'flex', gap: 10 }}>
                        <button onClick={() => setResolveModal(null)} style={{ flex: 1, padding: '10px 0', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-dim)', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                          Cancel
                        </button>
                        <button
                          disabled={resolving || !resolveNote.trim()}
                          onClick={async () => {
                            setResolving(true);
                            try {
                              await api.put(`/admin/disputes/${resolveModal.id}/resolve`, { resolution: resolveNote, action: resolveAction });
                              setDisputes(prev => prev.filter(d => d.id !== resolveModal.id));
                              setResolveModal(null);
                            } catch (e) {
                              alert(e?.response?.data?.detail || 'Failed to resolve dispute');
                            }
                            setResolving(false);
                          }}
                          style={{ flex: 1, padding: '10px 0', borderRadius: 8, border: 'none', background: resolveAction === 'release' ? 'linear-gradient(135deg,#10b981,#059669)' : 'linear-gradient(135deg,#ef4444,#dc2626)', color: '#fff', fontWeight: 600, fontSize: 13, cursor: resolving || !resolveNote.trim() ? 'not-allowed' : 'pointer', opacity: resolving || !resolveNote.trim() ? 0.6 : 1 }}
                        >
                          {resolving ? 'Resolving…' : resolveAction === 'release' ? 'Mark Completed' : 'Cancel Order'}
                        </button>
                      </div>
                    </div>
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
                              Trader #{ticket.trader_id} · {fmtDateEAT(ticket.updated_at)}
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
                                        {m.role === 'user' ? 'Trader' : m.role === 'admin' ? 'Admin' : 'AI Support'} · {m.ts ? fmtTimeEAT(m.ts) : ''}
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
          {activeTab === 'unmatched' && (() => {
            const deposits = unmatched.deposits || [];
            const withdrawals = unmatched.withdrawals || [];
            const active = unmatchedTab === 'deposits' ? deposits : withdrawals;
            return (
              <div className="adm-card">
                <div className="adm-card-header">
                  <h3>Unmatched Payments</h3>
                  <span className="adm-card-count">{deposits.length + withdrawals.length} total</span>
                </div>

                {/* Sub-tabs */}
                <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)', marginBottom: 0 }}>
                  {[['deposits', 'Unmatched Deposits', deposits.length, '#10b981'], ['withdrawals', 'Unmatched Withdrawals', withdrawals.length, '#f59e0b']].map(([key, label, count, color]) => (
                    <button key={key} onClick={() => setUnmatchedTab(key)}
                      style={{
                        padding: '10px 22px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13,
                        borderBottom: unmatchedTab === key ? `2px solid ${color}` : '2px solid transparent',
                        color: unmatchedTab === key ? color : 'var(--text-dim)',
                        fontWeight: unmatchedTab === key ? 700 : 400,
                        display: 'flex', alignItems: 'center', gap: 8,
                      }}
                    >
                      {label}
                      {count > 0 && (
                        <span style={{ background: color, color: '#000', borderRadius: 10, padding: '1px 7px', fontSize: 11, fontWeight: 700 }}>{count}</span>
                      )}
                    </button>
                  ))}
                </div>

                <p style={{ color: 'var(--text-dim)', fontSize: 12, padding: '10px 20px 0' }}>
                  {unmatchedTab === 'deposits'
                    ? 'Inbound M-Pesa payments whose account number didn\'t match any trader or order.'
                    : 'Outbound disbursements with no destination, no linked order, or failed status.'}
                </p>

                {active.length === 0 ? (
                  <p className="adm-empty">No unmatched {unmatchedTab}</p>
                ) : unmatchedTab === 'deposits' ? (
                  <div className="adm-table-wrap">
                    <table className="adm-table">
                      <thead>
                        <tr>
                          <th>Amount</th>
                          <th>Phone</th>
                          <th>Sender</th>
                          <th>Account Used</th>
                          <th>M-Pesa Code</th>
                          <th>Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {deposits.map((p) => (
                          <tr key={p.id}>
                            <td style={{ color: '#10b981', fontWeight: 600 }}>+KES {(p.amount || 0).toLocaleString()}</td>
                            <td>{p.phone && p.phone.length > 20 ? '—' : (p.phone || '—')}</td>
                            <td>{p.sender_name || '—'}</td>
                            <td className="mono" style={{ color: p.bill_ref_number ? '#f59e0b' : '#ef4444' }}>{p.bill_ref_number || 'No account'}</td>
                            <td className="mono" style={{ fontSize: 11 }}>{p.mpesa_transaction_id || '—'}</td>
                            <td style={{ color: '#6b7280', fontSize: 12 }}>{fmtDateEAT(p.created_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="adm-table-wrap">
                    <table className="adm-table">
                      <thead>
                        <tr>
                          <th>Amount</th>
                          <th>Type</th>
                          <th>Destination</th>
                          <th>Status</th>
                          <th>Remarks</th>
                          <th>M-Pesa Code</th>
                          <th>Time</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {withdrawals.map((p) => (
                          <tr key={p.id}>
                            <td style={{ color: '#ef4444', fontWeight: 600 }}>-KES {(p.amount || 0).toLocaleString()}</td>
                            <td><span className="adm-badge dim">{p.transaction_type || '—'}</span></td>
                            <td style={{ color: p.destination ? '#9ca3af' : '#ef4444' }}>{p.destination || 'No destination'}</td>
                            <td>
                              <span className={`adm-badge ${p.status === 'completed' ? 'green' : p.status === 'failed' ? 'red' : 'yellow'}`}>
                                {p.status || 'unknown'}
                              </span>
                            </td>
                            <td style={{ color: '#6b7280', fontSize: 12 }}>{p.remarks || '—'}</td>
                            <td className="mono" style={{ fontSize: 11 }}>{p.mpesa_transaction_id || '—'}</td>
                            <td style={{ color: '#6b7280', fontSize: 12 }}>{fmtDateEAT(p.created_at)}</td>
                            <td>
                              <button
                                onClick={async () => {
                                  try {
                                    await resolveUnmatchedPayment(p.id);
                                    const r = await getUnmatchedPayments();
                                    setUnmatched(r.data || { deposits: [], withdrawals: [] });
                                  } catch (e) {
                                    alert(e?.response?.data?.detail || 'Failed to resolve');
                                  }
                                }}
                                style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid #10b981', background: 'rgba(16,185,129,0.1)', color: '#10b981', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                                ✓ Resolve
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })()}


                              {/* ==================== WITHDRAWALS ==================== */}                    {/* ==================== WITHDRAWALS ==================== */}
          {activeTab === 'withdrawals' && (
            <div>
              {/* Page header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                <div>
                  <h2 style={{ fontSize: 22, fontWeight: 700, color: '#fff', margin: '0 0 4px' }}>Bank Withdrawals</h2>
                  <p style={{ color: '#6b7280', fontSize: 13, margin: 0 }}>Choice Microfinance → External Bank transfers by traders</p>
                </div>
                <button onClick={() => loadWithdrawals(wdStatus, wdPeriod, 1)}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 8, border: '1px solid #374151', background: 'transparent', color: '#9ca3af', cursor: 'pointer', fontSize: 13 }}>
                  <RefreshCw size={14} /> Refresh
                </button>
              </div>

              {/* Summary cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 20 }}>
                <div className="adm-card" style={{ padding: '16px 20px' }}>
                  <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700, marginBottom: 6 }}>Total Disbursed</div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: '#10b981' }}>{fmtKES(withdrawals.summary?.total_amount || 0)}</div>
                  <div style={{ fontSize: 11, color: '#4b5563', marginTop: 4 }}>{withdrawals.summary?.total_count || 0} total transfers</div>
                </div>
                <div className="adm-card" style={{ padding: '16px 20px' }}>
                  <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700, marginBottom: 6 }}>Completed</div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: '#3b82f6' }}>{withdrawals.summary?.completed_count || 0}</div>
                  <div style={{ fontSize: 11, color: '#4b5563', marginTop: 4 }}>Successfully transferred</div>
                </div>
                <div className="adm-card" style={{ padding: '16px 20px' }}>
                  <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700, marginBottom: 6 }}>Failed</div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: '#ef4444' }}>{withdrawals.summary?.failed_count || 0}</div>
                  <div style={{ fontSize: 11, color: '#4b5563', marginTop: 4 }}>Transfer failures</div>
                </div>
              </div>

              {/* Filters */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', gap: 0, background: '#111827', borderRadius: 8, padding: 4, border: '1px solid #1f2937' }}>
                  {[['all','All Status'], ['completed','Completed'], ['failed','Failed']].map(([v,l]) => (
                    <button key={v} onClick={() => { setWdStatus(v); setWdPage(1); loadWithdrawals(v, wdPeriod, 1); }}
                      style={{ padding: '5px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                        background: wdStatus === v ? '#f59e0b' : 'transparent', color: wdStatus === v ? '#000' : '#6b7280' }}>
                      {l}
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 0, background: '#111827', borderRadius: 8, padding: 4, border: '1px solid #1f2937' }}>
                  {[['today','Today'], ['week','This Week'], ['month','This Month'], ['all','All Time']].map(([v,l]) => (
                    <button key={v} onClick={() => { setWdPeriod(v); setWdPage(1); loadWithdrawals(wdStatus, v, 1); }}
                      style={{ padding: '5px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                        background: wdPeriod === v ? '#1f2937' : 'transparent', color: wdPeriod === v ? '#fff' : '#6b7280' }}>
                      {l}
                    </button>
                  ))}
                </div>
              </div>

              {/* Table */}
              <div className="adm-card">
                {wdLoading ? (
                  <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>Loading...</div>
                ) : !withdrawals.withdrawals || withdrawals.withdrawals.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 40 }}>
                    <div style={{ fontSize: 32, marginBottom: 12 }}>&#127974;</div>
                    <div style={{ color: '#fff', fontWeight: 600, marginBottom: 6 }}>No withdrawals yet</div>
                    <div style={{ color: '#6b7280', fontSize: 13 }}>Trader bank transfers from Choice Microfinance will appear here.</div>
                  </div>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid #1f2937', color: '#6b7280', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.6px' }}>
                          <th style={{ padding: '10px 16px', textAlign: 'left' }}>Trader</th>
                          <th style={{ padding: '10px 16px', textAlign: 'left' }}>From (Choice Bank)</th>
                          <th style={{ padding: '10px 16px', textAlign: 'left' }}>Destination</th>
                          <th style={{ padding: '10px 16px', textAlign: 'left' }}>Beneficiary</th>
                          <th style={{ padding: '10px 16px', textAlign: 'left' }}>Amount</th>
                          <th style={{ padding: '10px 16px', textAlign: 'left' }}>Status</th>
                          <th style={{ padding: '10px 16px', textAlign: 'left' }}>Reference</th>
                          <th style={{ padding: '10px 16px', textAlign: 'left' }}>Date</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(withdrawals.withdrawals || []).map(wd => {
                          const nameHash = (wd.trader_name || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
                          const colors = ['#10b981','#3b82f6','#8b5cf6','#f59e0b','#ef4444','#ec4899'];
                          const avatarColor = colors[nameHash % colors.length];
                          const initials = (wd.trader_name || '??').split(' ').map(w => w[0]).slice(0, 2).join('');
                          return (
                            <tr key={wd.id} style={{ borderBottom: '1px solid #111827' }}
                              onMouseEnter={e => e.currentTarget.style.background = '#0d111a'}
                              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                              <td style={{ padding: '12px 16px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                  <div style={{ width: 32, height: 32, borderRadius: '50%', background: avatarColor + '22', border: '1px solid ' + avatarColor + '44', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: avatarColor, flexShrink: 0 }}>
                                    {initials}
                                  </div>
                                  <div>
                                    <div style={{ fontWeight: 600, color: '#fff', fontSize: 13 }}>{wd.trader_name}</div>
                                    <div style={{ fontSize: 11, color: '#6b7280' }}>{wd.trader_phone}</div>
                                  </div>
                                </div>
                              </td>
                              <td style={{ padding: '12px 16px' }}>
                                <div style={{ fontSize: 12, color: '#a78bfa', fontWeight: 600 }}>Choice Microfinance</div>
                                <div style={{ fontSize: 11, color: '#6b7280', fontFamily: 'monospace' }}>{wd.from_account}</div>
                              </td>
                              <td style={{ padding: '12px 16px' }}>
                                <div style={{ fontSize: 12, fontWeight: 600, color: '#fff' }}>{wd.to_bank || '—'}</div>
                                <div style={{ fontSize: 11, color: '#6b7280', fontFamily: 'monospace' }}>{wd.to_account}</div>
                              </td>
                              <td style={{ padding: '12px 16px', fontSize: 12, color: '#9ca3af' }}>{wd.beneficiary}</td>
                              <td style={{ padding: '12px 16px', fontWeight: 700, color: '#10b981', fontSize: 14 }}>{fmtKES(wd.amount)}</td>
                              <td style={{ padding: '12px 16px' }}>
                                <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
                                  background: wd.status === 'completed' ? 'rgba(16,185,129,0.15)' : wd.status === 'failed' ? 'rgba(239,68,68,0.15)' : 'rgba(245,158,11,0.15)',
                                  color: wd.status === 'completed' ? '#10b981' : wd.status === 'failed' ? '#ef4444' : '#f59e0b' }}>
                                  {wd.status === 'completed' ? 'Completed' : wd.status === 'failed' ? 'Failed' : wd.status}
                                </span>
                              </td>
                              <td style={{ padding: '12px 16px', fontFamily: 'monospace', fontSize: 11, color: '#6b7280' }}>{wd.reference}</td>
                              <td style={{ padding: '12px 16px', color: '#9ca3af', fontSize: 12, whiteSpace: 'nowrap' }}>
                                {wd.created_at ? new Date(wd.created_at).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', dateStyle: 'short', timeStyle: 'short' }) : '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {(withdrawals.pages || 1) > 1 && (
                  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, padding: '16px 0', borderTop: '1px solid #1f2937' }}>
                    <button onClick={() => { const p = Math.max(1, wdPage - 1); setWdPage(p); loadWithdrawals(wdStatus, wdPeriod, p); }}
                      disabled={wdPage === 1}
                      style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #374151', background: 'transparent', color: wdPage === 1 ? '#4b5563' : '#fff', cursor: wdPage === 1 ? 'not-allowed' : 'pointer' }}>
                      ← Prev
                    </button>
                    <span style={{ color: '#6b7280', fontSize: 13 }}>Page {wdPage} of {withdrawals.pages} · {withdrawals.total} transfers</span>
                    <button onClick={() => { const p = Math.min(withdrawals.pages, wdPage + 1); setWdPage(p); loadWithdrawals(wdStatus, wdPeriod, p); }}
                      disabled={wdPage === withdrawals.pages}
                      style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #374151', background: 'transparent', color: wdPage === withdrawals.pages ? '#4b5563' : '#fff', cursor: wdPage === withdrawals.pages ? 'not-allowed' : 'pointer' }}>
                      Next →
                    </button>
                  </div>
                )}
              </div>
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
                    <h3>Audit Log — Staff Activity</h3>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => { setAuditImportantOnly(v => !v); setAuditPage(1); }}
                        style={{ background: auditImportantOnly ? 'rgba(245,158,11,0.15)' : 'none', border: `1px solid ${auditImportantOnly ? '#f59e0b' : '#374151'}`, color: auditImportantOnly ? '#f59e0b' : '#9ca3af', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>
                        {auditImportantOnly ? '★ Important only' : 'Show all'}
                      </button>
                      <button onClick={() => { setAuditLogs([]); setAuditLoading(false); }} style={{ background: 'none', border: '1px solid #374151', color: '#9ca3af', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>
                        Refresh
                      </button>
                    </div>
                  </div>
                  {auditLoading ? (
                    <div style={{ padding: 24, color: '#9ca3af', textAlign: 'center' }}>Loading...</div>
                  ) : (() => {
                    const ROUTINE = ['list_traders', 'view_trader_detail'];
                    const shown = auditImportantOnly ? auditLogs.filter(l => !ROUTINE.includes(l.action)) : auditLogs;
                    if (shown.length === 0) return (
                      <div style={{ padding: 24, color: '#6b7280', textAlign: 'center', fontSize: 13 }}>
                        {auditImportantOnly ? 'No staff actions yet — logins, changes, password resets, payments and denied attempts will appear here.' : 'No audit logs yet.'}
                      </div>
                    );
                    const totalPages = Math.ceil(shown.length / AUDIT_PER_PAGE);
                    const pageLogs = shown.slice((auditPage - 1) * AUDIT_PER_PAGE, auditPage * AUDIT_PER_PAGE);
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
                                  <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{log.created_at ? fmtDateEAT(log.created_at) : '—'}</td>
                                  <td>#{log.actor_id}</td>
                                  <td><span style={{ background: log.actor_role === 'admin' ? '#7c3aed22' : '#0e3a5a', color: log.actor_role === 'admin' ? '#a78bfa' : '#38bdf8', borderRadius: 4, padding: '2px 7px', fontSize: 11, fontWeight: 600 }}>{log.actor_role}</span></td>
                                  <td style={{ fontSize: 12, fontWeight: 600, color: isAuditDanger(log.action) ? '#ef4444' : '#f59e0b' }}>{fmtAuditAction(log.action)}</td>
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
                              Showing {(auditPage - 1) * AUDIT_PER_PAGE + 1}–{Math.min(auditPage * AUDIT_PER_PAGE, shown.length)} of {shown.length} entries
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

          {/* ==================== PAYBILL TRANSACTIONS ==================== */}
          {activeTab === 'paybill' && (
            <div>
              {/* Page header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                <div>
                  <h2 style={{ fontSize: 22, fontWeight: 700, color: '#fff', margin: '0 0 4px' }}>Subscriptions</h2>
                  <p style={{ color: '#6b7280', fontSize: 13, margin: 0 }}>Platform plan subscriptions and trade credit purchases</p>
                </div>
                <button onClick={() => loadSubData(subView, subPeriod, subPage)}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 8, border: '1px solid #374151', background: 'transparent', color: '#9ca3af', cursor: 'pointer', fontSize: 13 }}>
                  <RefreshCw size={14} /> Refresh
                </button>
              </div>

              {/* Sub-tabs + period filter row */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', gap: 0, background: '#111827', borderRadius: 10, padding: 4, border: '1px solid #1f2937' }}>
                  {[['plans', 'Platform Plans']].map(([v, l]) => (
                    <button key={v} onClick={() => { setSubView(v); setSubPage(1); loadSubData(v, subPeriod, 1); }}
                      style={{ padding: '7px 20px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                        background: subView === v ? '#f59e0b' : 'transparent',
                        color: subView === v ? '#000' : '#6b7280' }}>
                      {l}
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 4, background: '#111827', borderRadius: 8, padding: 4, border: '1px solid #1f2937' }}>
                  {[['today','Today'], ['week','This Week'], ['month','This Month'], ['all','All Time']].map(([v, l]) => (
                    <button key={v} onClick={() => { setSubPeriod(v); setSubPage(1); loadSubData(subView, v, 1); }}
                      style={{ padding: '5px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                        background: subPeriod === v ? '#1f2937' : 'transparent',
                        color: subPeriod === v ? '#fff' : '#6b7280' }}>
                      {l}
                    </button>
                  ))}
                </div>
              </div>

              {/* Summary cards */}
              {subView === 'plans' ? (
                <>
                  {/* Total revenue bar */}
                  <div className="adm-card" style={{ padding: '14px 20px', marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700, marginBottom: 4 }}>Total Revenue</div>
                      <div style={{ fontSize: 26, fontWeight: 800, color: '#10b981' }}>{fmtKES(subData.summary?.total || 0)}</div>
                    </div>
                    <div style={{ fontSize: 13, color: '#6b7280' }}>
                      {(subData.summary?.starter_count || 0) + (subData.summary?.pro_count || 0) + (subData.summary?.pro_max_count || 0) + (subData.summary?.advanced_count || 0)} active plan{((subData.summary?.starter_count || 0) + (subData.summary?.pro_count || 0) + (subData.summary?.pro_max_count || 0) + (subData.summary?.advanced_count || 0)) !== 1 ? 's' : ''}
                    </div>
                  </div>
                  {/* 4 plan cards */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
                    {[
                      { key: 'starter', label: 'Starter', color: '#10b981', bg: 'rgba(16,185,129,0.12)', kes: 5000 },
                      { key: 'pro',     label: 'Pro',     color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', kes: 10000 },
                      { key: 'pro_max', label: 'Pro Max', color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)', kes: 20000 },
                      { key: 'advanced',label: 'Advanced',color: '#ef4444', bg: 'rgba(239,68,68,0.12)',  kes: 40000 },
                    ].map(p => (
                      <div key={p.key} className="adm-card" style={{ padding: '14px 16px', borderTop: `2px solid ${p.color}` }}>
                        <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.6px', fontWeight: 700, marginBottom: 8 }}>{p.label}</div>
                        <div style={{ fontSize: 28, fontWeight: 800, color: p.color, lineHeight: 1 }}>{subData.summary?.[p.key + '_count'] || 0}</div>
                        <div style={{ fontSize: 10, color: '#6b7280', marginTop: 6 }}>subscriber{(subData.summary?.[p.key + '_count'] || 0) !== 1 ? 's' : ''}</div>
                        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #1f2937' }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: '#fff' }}>{fmtKES(subData.summary?.[p.key] || 0)}</div>
                          <div style={{ fontSize: 10, color: '#4b5563', marginTop: 2 }}>{fmtKES(p.kes)}/mo each</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 20 }}>
                  <>
                    <div className="adm-card" style={{ padding: '16px 20px' }}>
                      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>Total Revenue</div>
                      <div style={{ fontSize: 24, fontWeight: 800, color: '#10b981' }}>{fmtKES(subData.summary?.total_revenue || 0)}</div>
                      <div style={{ fontSize: 11, color: '#4b5563', marginTop: 4 }}>All credit purchases</div>
                    </div>
                    <div className="adm-card" style={{ padding: '16px 20px' }}>
                      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>Credits Sold</div>
                      <div style={{ fontSize: 24, fontWeight: 800, color: '#f59e0b' }}>{(subData.summary?.total_credits || 0).toLocaleString()}</div>
                      <div style={{ fontSize: 11, color: '#4b5563', marginTop: 4 }}>Trade tokens</div>
                    </div>
                    <div className="adm-card" style={{ padding: '16px 20px' }}>
                      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>Purchases</div>
                      <div style={{ fontSize: 24, fontWeight: 800, color: '#3b82f6' }}>{subData.total || 0}</div>
                      <div style={{ fontSize: 11, color: '#4b5563', marginTop: 4 }}>Total transactions</div>
                    </div>
                  </>
                </div>
              )}

              {/* Table */}
              <div className="adm-card">
                {subLoading ? (
                  <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>Loading...</div>
                ) : !subData.transactions?.length ? (
                  <div style={{ textAlign: 'center', padding: 40 }}>
                    <div style={{ fontSize: 32, marginBottom: 12 }}>💳</div>
                    <div style={{ color: '#fff', fontWeight: 600, marginBottom: 6 }}>No records found</div>
                    <div style={{ color: '#6b7280', fontSize: 13 }}>No {subView === 'plans' ? 'subscription payments' : 'credit purchases'} for this period.</div>
                  </div>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid #1f2937', color: '#6b7280', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.6px' }}>
                          <th style={{ padding: '10px 16px', textAlign: 'left' }}>Trader</th>
                          {subView === 'plans' ? (
                            <>
                              <th style={{ padding: '10px 16px', textAlign: 'left' }}>Plan</th>
                              <th style={{ padding: '10px 16px', textAlign: 'left' }}>Amount</th>
                              <th style={{ padding: '10px 16px', textAlign: 'left' }}>Started</th>
                              <th style={{ padding: '10px 16px', textAlign: 'left' }}>Expires</th>
                              <th style={{ padding: '10px 16px', textAlign: 'left' }}>Receipt</th>
                            </>
                          ) : (
                            <>
                              <th style={{ padding: '10px 16px', textAlign: 'left' }}>Credits</th>
                              <th style={{ padding: '10px 16px', textAlign: 'left' }}>Amount Paid</th>
                              <th style={{ padding: '10px 16px', textAlign: 'left' }}>Rate / Credit</th>
                              <th style={{ padding: '10px 16px', textAlign: 'left' }}>Source</th>
                              <th style={{ padding: '10px 16px', textAlign: 'left' }}>Date</th>
                            </>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {subData.transactions.map(tx => {
                          const nameHash = (tx.trader_name || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
                          const avatarColors = ['#10b981','#3b82f6','#8b5cf6','#f59e0b','#ef4444','#ec4899'];
                          const avatarColor = avatarColors[nameHash % avatarColors.length];
                          const initials = (tx.trader_name || '??').split(' ').map(w => w[0]).slice(0, 2).join('');
                          return (
                            <tr key={tx.id} style={{ borderBottom: '1px solid #111827', transition: 'background 0.15s' }}
                              onMouseEnter={e => e.currentTarget.style.background = '#0d111a'}
                              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                              <td style={{ padding: '12px 16px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                  <div style={{ width: 34, height: 34, borderRadius: '50%', background: avatarColor + '22', border: `1px solid ${avatarColor}55`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: avatarColor, flexShrink: 0 }}>
                                    {initials}
                                  </div>
                                  <div>
                                    <div
                                      onClick={() => { setActiveTab('traders'); openTraderPage({ id: tx.trader_id, full_name: tx.trader_name, email: tx.trader_email || '', phone: tx.trader_phone || '' }); }}
                                      style={{ fontWeight: 600, color: '#fff', cursor: 'pointer', fontSize: 13, transition: 'color 0.15s' }}
                                      onMouseEnter={e => e.currentTarget.style.color = '#f59e0b'}
                                      onMouseLeave={e => e.currentTarget.style.color = '#fff'}
                                    >
                                      {tx.trader_name || '—'}
                                    </div>
                                    <div style={{ fontSize: 11, color: '#6b7280' }}>{tx.trader_email || tx.trader_phone || ''}</div>
                                  </div>
                                </div>
                              </td>
                              {subView === 'plans' ? (
                                <>
                                  <td style={{ padding: '12px 16px' }}>
                                    <span style={{ fontSize: 12, fontWeight: 700, padding: '3px 12px', borderRadius: 20,
                                      background: (tx.plan || '').toLowerCase() === 'pro' ? 'rgba(139,92,246,0.15)' : 'rgba(245,158,11,0.15)',
                                      color: (tx.plan || '').toLowerCase() === 'pro' ? '#8b5cf6' : '#f59e0b' }}>
                                      {(tx.plan || '—').toUpperCase()}
                                    </span>
                                  </td>
                                  <td style={{ padding: '12px 16px', fontWeight: 700, color: '#10b981', fontSize: 14 }}>{fmtKES(tx.amount)}</td>
                                  <td style={{ padding: '12px 16px', color: '#9ca3af', fontSize: 12, whiteSpace: 'nowrap' }}>
                                    {tx.started_at ? new Date(tx.started_at).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', dateStyle: 'short', timeStyle: 'short' }) : '—'}
                                  </td>
                                  <td style={{ padding: '12px 16px', color: '#9ca3af', fontSize: 12, whiteSpace: 'nowrap' }}>
                                    {tx.expires_at ? new Date(tx.expires_at).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', dateStyle: 'short', timeStyle: 'short' }) : '—'}
                                  </td>
                                  <td style={{ padding: '12px 16px', fontFamily: 'monospace', fontSize: 11, color: '#6b7280' }}>
                                    {tx.mpesa_transaction_id || '—'}
                                  </td>
                                </>
                              ) : (
                                <>
                                  <td style={{ padding: '12px 16px' }}>
                                    <span style={{ fontSize: 15, fontWeight: 800, color: '#f59e0b' }}>{(tx.tokens_granted || 0).toLocaleString()}</span>
                                    <span style={{ fontSize: 11, color: '#6b7280', marginLeft: 4 }}>credits</span>
                                  </td>
                                  <td style={{ padding: '12px 16px', fontWeight: 700, color: (tx.amount_kes || 0) > 0 ? '#10b981' : '#6b7280', fontSize: 14 }}>
                                    {(tx.amount_kes || 0) > 0 ? fmtKES(tx.amount_kes) : 'Free'}
                                  </td>
                                  <td style={{ padding: '12px 16px', color: '#9ca3af', fontSize: 12 }}>
                                    {(tx.rate_per_token || 0) > 0 ? fmtKES(tx.rate_per_token) : '—'}
                                  </td>
                                  <td style={{ padding: '12px 16px' }}>
                                    <span style={{ fontSize: 11, padding: '2px 10px', borderRadius: 12,
                                      background: tx.source === 'admin' ? 'rgba(139,92,246,0.15)' : tx.source === 'balance' ? 'rgba(16,185,129,0.15)' : 'rgba(245,158,11,0.15)',
                                      color: tx.source === 'admin' ? '#8b5cf6' : tx.source === 'balance' ? '#10b981' : '#f59e0b', fontWeight: 600 }}>
                                      {tx.source || '—'}
                                    </span>
                                  </td>
                                  <td style={{ padding: '12px 16px', color: '#9ca3af', fontSize: 12, whiteSpace: 'nowrap' }}>
                                    {tx.created_at ? new Date(tx.created_at).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', dateStyle: 'short', timeStyle: 'short' }) : '—'}
                                  </td>
                                </>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {/* Pagination */}
                {(subData.pages || 1) > 1 && (
                  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, padding: '16px 0', borderTop: '1px solid #1f2937' }}>
                    <button onClick={() => { const p = Math.max(1, subPage - 1); setSubPage(p); loadSubData(subView, subPeriod, p); }}
                      disabled={subPage === 1}
                      style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #374151', background: 'transparent', color: subPage === 1 ? '#4b5563' : '#fff', cursor: subPage === 1 ? 'not-allowed' : 'pointer' }}>
                      ← Prev
                    </button>
                    <span style={{ color: '#6b7280', fontSize: 13 }}>Page {subPage} of {subData.pages}</span>
                    <button onClick={() => { const p = Math.min(subData.pages, subPage + 1); setSubPage(p); loadSubData(subView, subPeriod, p); }}
                      disabled={subPage === subData.pages}
                      style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #374151', background: 'transparent', color: subPage === subData.pages ? '#4b5563' : '#fff', cursor: subPage === subData.pages ? 'not-allowed' : 'pointer' }}>
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

              {/* Employee List */}
              <div className="adm-card" style={{ marginBottom: 20 }}>
                <div className="adm-card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Users size={18} /> Employee Accounts</h3>
                  <button className="adm-btn-secondary" style={{ fontSize: 12, padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 4 }} onClick={loadEmployees} disabled={employeesLoading}>
                    <RefreshCw size={13} style={{ animation: employeesLoading ? 'spin 1s linear infinite' : 'none' }} />
                    {employeesLoading ? 'Loading…' : 'Refresh'}
                  </button>
                </div>
                {empMsg && <div style={{ padding: '6px 16px', fontSize: 13, color: empMsg.includes('Failed') ? '#ef4444' : '#10b981' }}>{empMsg}</div>}
                {!employeesLoading && employees.length === 0 && (
                  <p className="adm-empty">No employee accounts yet. Create one above.</p>
                )}
                {employees.length > 0 && (
                  <div style={{ padding: '0 16px 16px' }}>
                    {employees.map(emp => (
                      <div key={emp.id} style={{ background: '#0a0e1a', border: '1px solid #1f2937', borderRadius: 12, padding: '16px 18px', marginBottom: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
                          <div>
                            <div style={{ fontWeight: 700, color: '#fff', fontSize: 15 }}>{emp.full_name}</div>
                            <div style={{ fontSize: 13, color: '#9ca3af', marginTop: 2 }}>{emp.email}</div>
                            {emp.phone && emp.phone !== '0000000000' && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{emp.phone}</div>}
                          </div>
                          <button
                            style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444', padding: '5px 12px', borderRadius: 7, fontSize: 12, cursor: 'pointer', opacity: empDeleting === emp.id ? 0.5 : 1 }}
                            disabled={empDeleting === emp.id}
                            onClick={() => handleDeleteEmployee(emp.id, emp.full_name)}
                          >
                            {empDeleting === emp.id ? 'Deleting…' : 'Delete'}
                          </button>
                        </div>
                        <div>
                          <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Page Access</div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                            {[
                              { key: 'disputes', label: 'Disputes' },
                              { key: 'orders', label: 'Orders' },
                              { key: 'chat', label: 'Chat' },
                              { key: 'transactions', label: 'Transactions' },
                              { key: 'withdrawals', label: 'Withdrawals' },
                              { key: 'survey', label: 'Survey Responses' },
                            ].map(({ key, label }) => {
                              const enabled = emp.permissions?.[key] ?? false;
                              return (
                                <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', padding: '6px 12px', borderRadius: 8, border: `1px solid ${enabled ? '#f59e0b' : '#374151'}`, background: enabled ? 'rgba(245,158,11,0.08)' : 'transparent', fontSize: 13, color: enabled ? '#f59e0b' : '#6b7280', opacity: permSaving === emp.id ? 0.6 : 1 }}>
                                  <input
                                    type="checkbox"
                                    checked={enabled}
                                    disabled={permSaving === emp.id}
                                    onChange={e => handlePermissionToggle(emp.id, key, e.target.checked)}
                                    style={{ accentColor: '#f59e0b', width: 14, height: 14 }}
                                  />
                                  {label}
                                </label>
                              );
                            })}
                          </div>
                          {permSaving === emp.id && <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 8 }}>Saving…</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
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
          {/* ==================== AFFILIATES ==================== */}
          {activeTab === 'affiliates' && (
            <div>
              {affiliateActionMsg && (
                <div style={{ background: '#10b981', color: '#fff', padding: '10px 16px', borderRadius: 8, marginBottom: 16, fontWeight: 600 }}>
                  {affiliateActionMsg}
                </div>
              )}

              {/* Stats row */}
              {affiliateStats && (
                <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
                  {[
                    { label: 'Total', value: affiliateStats.total, color: '#9ca3af' },
                    { label: 'Pending', value: affiliateStats.pending, color: '#f59e0b' },
                    { label: 'Approved', value: affiliateStats.approved, color: '#10b981' },
                    { label: 'Total Owed', value: `KES ${(affiliateStats.total_owed || 0).toLocaleString()}`, color: '#f97316' },
                  ].map(s => (
                    <div key={s.label} className="adm-card" style={{ flex: '1 1 120px', padding: '14px 18px', textAlign: 'center' }}>
                      <div style={{ fontSize: 22, fontWeight: 800, color: s.color }}>{s.value}</div>
                      <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>{s.label}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Filter tabs */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                {['all', 'pending', 'approved', 'rejected'].map(f => (
                  <button key={f} onClick={() => setAffiliateFilter(f)}
                    style={{ padding: '6px 16px', borderRadius: 20, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13,
                      background: affiliateFilter === f ? '#f59e0b' : '#1f2937', color: affiliateFilter === f ? '#000' : '#9ca3af' }}>
                    {f.charAt(0).toUpperCase() + f.slice(1)}
                  </button>
                ))}
              </div>

              {affiliateLoading ? (
                <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>Loading...</div>
              ) : (
                <div className="adm-card" style={{ padding: 0, overflow: 'hidden' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: '#111827', borderBottom: '1px solid #374151' }}>
                        {['Trader', 'Email', 'Status', 'Referral Code', 'Referrals', 'Pending (KES)', 'Total Earned', 'Applied', 'Actions'].map(h => (
                          <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: '#6b7280', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {affiliateList
                        .filter(a => affiliateFilter === 'all' || a.status === affiliateFilter)
                        .map((a, i) => (
                          <tr key={a.id} style={{ borderBottom: '1px solid #1f2937', background: i % 2 === 0 ? 'transparent' : '#0d1117' }}>
                            <td style={{ padding: '10px 12px', fontWeight: 600, color: '#f9fafb' }}>{a.trader_name}</td>
                            <td style={{ padding: '10px 12px', color: '#9ca3af' }}>{a.trader_email}</td>
                            <td style={{ padding: '10px 12px' }}>
                              <span style={{ padding: '2px 10px', borderRadius: 12, fontSize: 11, fontWeight: 700,
                                background: a.status === 'approved' ? '#065f46' : a.status === 'pending' ? '#78350f' : '#450a0a',
                                color: a.status === 'approved' ? '#34d399' : a.status === 'pending' ? '#fcd34d' : '#fca5a5' }}>
                                {a.status.toUpperCase()}
                              </span>
                            </td>
                            <td style={{ padding: '10px 12px', fontFamily: 'monospace', color: '#60a5fa' }}>
                              {a.referral_code || '—'}
                            </td>
                            <td style={{ padding: '10px 12px', textAlign: 'center', color: '#f9fafb' }}>{a.referral_count}</td>
                            <td style={{ padding: '10px 12px', color: '#f97316', fontWeight: 700 }}>
                              {(a.pending_balance || 0).toLocaleString()}
                            </td>
                            <td style={{ padding: '10px 12px', color: '#10b981', fontWeight: 600 }}>
                              {(a.total_earned || 0).toLocaleString()}
                            </td>
                            <td style={{ padding: '10px 12px', color: '#6b7280', fontSize: 12 }}>
                              {a.applied_at ? new Date(a.applied_at).toLocaleDateString('en-KE') : '—'}
                            </td>
                            <td style={{ padding: '10px 12px' }}>
                              <div style={{ display: 'flex', gap: 6 }}>
                                {a.status !== 'approved' && (
                                  <button onClick={() => handleAffiliateApprove(a.id)}
                                    style={{ padding: '4px 10px', background: '#10b981', border: 'none', borderRadius: 6, color: '#fff', fontSize: 12, cursor: 'pointer', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                                    <Check size={12} /> Approve
                                  </button>
                                )}
                                {a.status !== 'rejected' && (
                                  <button onClick={() => handleAffiliateReject(a.id)}
                                    style={{ padding: '4px 10px', background: '#ef4444', border: 'none', borderRadius: 6, color: '#fff', fontSize: 12, cursor: 'pointer', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                                    <XCircle size={12} /> Reject
                                  </button>
                                )}
                                {a.status === 'approved' && (
                                  <span style={{ color: '#34d399', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                                    <Check size={12} /> Active
                                  </span>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                  {affiliateList.filter(a => affiliateFilter === 'all' || a.status === affiliateFilter).length === 0 && (
                    <p className="adm-empty">No affiliates in this category.</p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ==================== SURVEY RESPONSES ==================== */}
          {activeTab === 'survey' && (
            <div>
              {/* Stats row */}
              <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
                {[
                  { label: 'Total', value: surveyResponses.length, color: '#9ca3af' },
                  { label: 'Qualified', value: surveyResponses.filter(r => r.is_qualified).length, color: '#10b981' },
                  { label: 'Not Qualified', value: surveyResponses.filter(r => !r.is_qualified && !r.disqualified).length, color: '#f59e0b' },
                  { label: 'Disqualified', value: surveyResponses.filter(r => r.disqualified).length, color: '#ef4444' },
                  { label: 'Invite Sent', value: surveyResponses.filter(r => r.invite_sent).length, color: '#60a5fa' },
                ].map(s => (
                  <div key={s.label} className="adm-card" style={{ flex: '1 1 100px', padding: '14px 18px', textAlign: 'center' }}>
                    <div style={{ fontSize: 24, fontWeight: 800, color: s.color }}>{s.value}</div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{s.label}</div>
                  </div>
                ))}
              </div>

              <div className="adm-card">
                <div className="adm-card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                  <h3>Responses</h3>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    {['all', 'qualified', 'disqualified', 'invited'].map(f => (
                      <button
                        key={f}
                        className={`adm-btn-secondary${surveyFilter === f ? ' active' : ''}`}
                        style={{ fontSize: 12, padding: '4px 12px', background: surveyFilter === f ? 'rgba(245,158,11,0.15)' : '', borderColor: surveyFilter === f ? '#f59e0b' : '', color: surveyFilter === f ? '#f59e0b' : '' }}
                        onClick={() => setSurveyFilter(f)}
                      >
                        {f.charAt(0).toUpperCase() + f.slice(1)}
                      </button>
                    ))}
                    <button className="adm-btn-secondary" style={{ fontSize: 12, padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 4 }} onClick={loadSurveyResponses} disabled={surveyLoading}>
                      <RefreshCw size={13} style={{ animation: surveyLoading ? 'spin 1s linear infinite' : 'none' }} />
                      {surveyLoading ? 'Loading…' : 'Refresh'}
                    </button>
                  </div>
                </div>

                {surveyMsg && (
                  <div style={{ padding: '8px 16px', fontSize: 13, color: surveyMsg.includes('Failed') ? '#ef4444' : '#10b981' }}>{surveyMsg}</div>
                )}

                {surveyLoading && <p className="adm-empty">Loading responses…</p>}
                {!surveyLoading && surveyResponses.length === 0 && <p className="adm-empty">No survey responses yet. Share your survey link: <strong>sparkp2p.com/survey</strong></p>}

                {!surveyLoading && surveyResponses.length > 0 && (() => {
                  const filtered = surveyResponses.filter(r => {
                    if (surveyFilter === 'qualified') return r.is_qualified;
                    if (surveyFilter === 'disqualified') return r.disqualified;
                    if (surveyFilter === 'invited') return r.invite_sent;
                    return true;
                  });

                  return (
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid #1f2937' }}>
                            {['Name', 'Phone', 'Merchant?', 'Frequency', 'Daily Volume', 'Status', 'Submitted', 'Action'].map(h => (
                              <th key={h} style={{ padding: '10px 14px', textAlign: 'left', color: '#6b7280', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {filtered.map(r => (
                            <tr key={r.id} style={{ borderBottom: '1px solid #111827' }}>
                              <td style={{ padding: '12px 14px', color: '#fff', fontWeight: 600 }}>{r.full_name}</td>
                              <td style={{ padding: '12px 14px', color: '#9ca3af' }}>{r.phone}</td>
                              <td style={{ padding: '12px 14px' }}>
                                <span style={{ color: r.q1_is_merchant === 'yes' ? '#10b981' : '#ef4444' }}>
                                  {r.q1_is_merchant === 'yes' ? '✓ Yes' : '✗ No'}
                                </span>
                              </td>
                              <td style={{ padding: '12px 14px', color: '#d1d5db', maxWidth: 140 }}>{r.q2_trade_frequency || '—'}</td>
                              <td style={{ padding: '12px 14px', color: '#d1d5db', maxWidth: 140 }}>{r.q3_daily_volume || '—'}</td>
                              <td style={{ padding: '12px 14px' }}>
                                {r.disqualified ? (
                                  <span style={{ background: 'rgba(239,68,68,0.12)', color: '#ef4444', padding: '3px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600 }}>Disqualified</span>
                                ) : r.is_qualified ? (
                                  <span style={{ background: 'rgba(16,185,129,0.12)', color: '#10b981', padding: '3px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600 }}>Qualified</span>
                                ) : (
                                  <span style={{ background: 'rgba(245,158,11,0.12)', color: '#f59e0b', padding: '3px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600 }}>Reviewed</span>
                                )}
                              </td>
                              <td style={{ padding: '12px 14px', color: '#6b7280', whiteSpace: 'nowrap' }}>
                                {r.submitted_at ? fmtDateOnlyEAT(r.submitted_at) : '—'}
                              </td>
                              <td style={{ padding: '12px 14px' }}>
                                {r.invite_sent ? (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span style={{ color: '#60a5fa', fontSize: 12 }}>✓ Invite sent</span>
                                    <button
                                      className="adm-btn-secondary"
                                      style={{ fontSize: 11, padding: '2px 8px', opacity: surveyInviting === r.id ? 0.6 : 1 }}
                                      disabled={surveyInviting === r.id}
                                      onClick={() => handleSendSurveyInvite(r.id)}
                                    >
                                      {surveyInviting === r.id ? '…' : 'Resend'}
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    className="adm-btn-secondary"
                                    style={{ fontSize: 12, padding: '4px 12px', opacity: surveyInviting === r.id ? 0.6 : 1 }}
                                    disabled={surveyInviting === r.id}
                                    onClick={() => handleSendSurveyInvite(r.id)}
                                  >
                                    {surveyInviting === r.id ? 'Sending…' : 'Send Invite'}
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {filtered.length === 0 && <p className="adm-empty">No responses match this filter.</p>}
                    </div>
                  );
                })()}
              </div>

              {/* Full answer detail - expandable */}
              {surveyResponses.filter(r => {
                if (surveyFilter === 'qualified') return r.is_qualified;
                if (surveyFilter === 'disqualified') return r.disqualified;
                if (surveyFilter === 'invited') return r.invite_sent;
                return true;
              }).length > 0 && (
                <div className="adm-card" style={{ marginTop: 16 }}>
                  <div className="adm-card-header"><h3>Full Answers</h3></div>
                  {surveyResponses.filter(r => {
                    if (surveyFilter === 'qualified') return r.is_qualified;
                    if (surveyFilter === 'disqualified') return r.disqualified;
                    if (surveyFilter === 'invited') return r.invite_sent;
                    return true;
                  }).map(r => (
                    <div key={r.id} style={{ padding: '14px 16px', borderBottom: '1px solid #1f2937' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                        <span style={{ fontWeight: 700, color: '#fff' }}>{r.full_name}</span>
                        <span style={{ fontSize: 12, color: '#6b7280' }}>{r.phone}</span>
                      </div>
                      {[
                        ['Q2 — Frequency', r.q2_trade_frequency],
                        ['Q3 — Daily Volume', r.q3_daily_volume],
                        ['Q4 — I&M Frozen', r.q4_account_frozen],
                        ['Q5 — Automation', r.q5_has_automation === 'yes' ? `Yes — ${r.q5_automation_name || 'not specified'}` : r.q5_has_automation === 'no' ? 'No' : null],
                        ['Q6 — Biggest Challenge', r.q6_biggest_challenge],
                        ['Q7 — Daily Transactions', r.q7_daily_transactions],
                      ].filter(([, v]) => v).map(([label, value]) => (
                        <div key={label} style={{ display: 'flex', gap: 8, marginBottom: 4, fontSize: 13 }}>
                          <span style={{ color: '#6b7280', minWidth: 180 }}>{label}</span>
                          <span style={{ color: '#d1d5db' }}>{value}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'expenses' && (
            <div>
              {/* Page header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                <div>
                  <h2 style={{ fontSize: 22, fontWeight: 700, color: '#fff', margin: '0 0 4px' }}>Financials</h2>
                  <p style={{ color: '#6b7280', fontSize: 13, margin: 0 }}>Revenue from subscriptions and platform expenses</p>
                </div>
                <button onClick={() => { adminGetExpenses().then(r => { setExpenses(r.data.expenses || []); setExpensesTotal(r.data.total || 0); }).catch(() => {}); loadRevenueBreakdown(revPeriod, revPlan, 1); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 8, border: '1px solid #374151', background: 'transparent', color: '#9ca3af', cursor: 'pointer', fontSize: 13 }}>
                  <RefreshCw size={14} /> Refresh
                </button>
              </div>

              {/* Profit Summary — always visible */}
              {(() => {
                const subRevenue = revBreakdown?.summary?.total ?? 0;
                const outboundRevenue = revBreakdown?.summary?.outbound_markup ?? 0;
                const totalRevenue = subRevenue + outboundRevenue;
                const totalExpenses = expensesTotal ?? 0;
                const netProfit = totalRevenue - totalExpenses;
                const isProfit = netProfit >= 0;
                return (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20 }}>
                    <div style={{ padding: '16px 20px', background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: 12 }}>
                      <div style={{ color: '#6b7280', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 8 }}>Total Revenue</div>
                      <div style={{ color: '#10b981', fontWeight: 800, fontSize: 24 }}>{fmtKES(totalRevenue)}</div>
                      <div style={{ color: '#4b5563', fontSize: 11, marginTop: 4 }}>Subscriptions {fmtKES(subRevenue)} + outbound fees {fmtKES(outboundRevenue)}</div>
                    </div>
                    <div style={{ padding: '16px 20px', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 12 }}>
                      <div style={{ color: '#6b7280', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 8 }}>Total Expenses</div>
                      <div style={{ color: '#ef4444', fontWeight: 800, fontSize: 24 }}>{fmtKES(totalExpenses)}</div>
                      <div style={{ color: '#4b5563', fontSize: 11, marginTop: 4 }}>All logged expenses</div>
                    </div>
                    <div style={{ padding: '16px 20px', background: isProfit ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)', border: `1px solid ${isProfit ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}`, borderRadius: 12 }}>
                      <div style={{ color: '#6b7280', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 8 }}>Net Profit</div>
                      <div style={{ color: isProfit ? '#10b981' : '#ef4444', fontWeight: 800, fontSize: 24 }}>{isProfit ? '+' : '-'}{fmtKES(Math.abs(netProfit))}</div>
                      <div style={{ color: '#4b5563', fontSize: 11, marginTop: 4 }}>Revenue minus expenses</div>
                    </div>
                  </div>
                );
              })()}

              {/* Sub-tab switcher */}
              <div style={{ display: 'flex', gap: 0, background: '#111827', borderRadius: 10, padding: 4, border: '1px solid #1f2937', marginBottom: 20, width: 'fit-content' }}>
                {[['revenue','Revenue'], ['expenses','Expenses']].map(([v, l]) => (
                  <button key={v} onClick={() => setExpSubView(v)}
                    style={{ padding: '7px 24px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                      background: expSubView === v ? '#f59e0b' : 'transparent',
                      color: expSubView === v ? '#000' : '#6b7280' }}>
                    {l}
                  </button>
                ))}
              </div>

              {/* ── Revenue sub-view ── */}
              {expSubView === 'revenue' && (
                <>
              {/* Period + Plan filters */}
                <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
                  <div style={{ display: 'flex', gap: 4, background: 'var(--surface)', borderRadius: 8, padding: 4, border: '1px solid var(--border)' }}>
                    {[['all','All Time'], ['month','This Month'], ['week','This Week'], ['today','Today']].map(([val, label]) => (
                      <button key={val} onClick={() => { setRevPeriod(val); setRevPage(1); loadRevenueBreakdown(val, revPlan, 1); }}
                        style={{ padding: '5px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                          background: revPeriod === val ? '#f59e0b' : 'transparent', color: revPeriod === val ? '#000' : '#9ca3af' }}>
                        {label}
                      </button>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 4, background: 'var(--surface)', borderRadius: 8, padding: 4, border: '1px solid var(--border)' }}>
                    {[['all','All Plans'], ['starter','Starter'], ['pro','Starter Pro'], ['pro_max','Starter Pro Max']].map(([val, label]) => (
                      <button key={val} onClick={() => { setRevPlan(val); setRevPage(1); loadRevenueBreakdown(revPeriod, val, 1); }}
                        style={{ padding: '5px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                          background: revPlan === val ? '#10b981' : 'transparent', color: revPlan === val ? '#000' : '#9ca3af' }}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Summary: Total Revenue bar + 4 plan cards */}
                <div className="adm-card" style={{ padding: '14px 20px', marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700, marginBottom: 4 }}>Total Subscription Revenue (Paid Only)</div>
                    <div style={{ fontSize: 26, fontWeight: 800, color: '#10b981' }}>{fmtKES(revBreakdown?.summary?.total ?? 0)}</div>
                  </div>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>Excludes admin-granted plans</div>
                </div>
                {/* Outbound transaction-fee revenue (our markup, remitted monthly by Choice Bank) */}
                <div className="adm-card" style={{ padding: '14px 20px', marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderLeft: '3px solid #3b82f6' }}>
                  <div>
                    <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700, marginBottom: 4 }}>Outbound Fee Revenue (Our Markup)</div>
                    <div style={{ fontSize: 26, fontWeight: 800, color: '#3b82f6' }}>{fmtKES(revBreakdown?.summary?.outbound_markup ?? 0)}</div>
                  </div>
                  <div style={{ fontSize: 12, color: '#6b7280', textAlign: 'right' }}>
                    Withheld by Choice Bank, remitted monthly<br/>
                    Gross fees charged: {fmtKES(revBreakdown?.summary?.outbound_gross ?? 0)}
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
                  {[
                    { key: 'starter',  label: 'Starter',         color: '#10b981', kes: 3000  },
                    { key: 'pro',      label: 'Starter Pro',     color: '#f59e0b', kes: 5000  },
                    { key: 'pro_max',  label: 'Starter Pro Max', color: '#8b5cf6', kes: 10000 },
                  ].map(p => (
                    <div key={p.key} className="adm-card" style={{ padding: '14px 16px', borderTop: `2px solid ${p.color}` }}>
                      <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.6px', fontWeight: 700, marginBottom: 8 }}>{p.label}</div>
                      <div style={{ fontSize: 26, fontWeight: 800, color: p.color, lineHeight: 1 }}>{revBreakdown?.summary?.[p.key + '_count'] ?? 0}</div>
                      <div style={{ fontSize: 10, color: '#6b7280', marginTop: 5 }}>paid subscriber{(revBreakdown?.summary?.[p.key + '_count'] ?? 0) !== 1 ? 's' : ''}</div>
                      <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #1f2937' }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#fff' }}>{fmtKES(revBreakdown?.summary?.[p.key] ?? 0)}</div>
                        <div style={{ fontSize: 10, color: '#4b5563', marginTop: 2 }}>{fmtKES(p.kes)}/mo each</div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Subscription payments table */}
                <div className="adm-card" style={{ marginBottom: 16 }}>
                  <div className="adm-card-header">
                    <h3>Subscription Payments</h3>
                    <span className="adm-card-count">{revBreakdown?.total ?? 0} total</span>
                  </div>
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
                              <th>Plan</th>
                              <th>M-Pesa TX</th>
                              <th>Expires</th>
                              <th style={{ textAlign: 'right' }}>Amount</th>
                            </tr>
                          </thead>
                          <tbody>
                            {revBreakdown.transactions.map((tx) => (
                              <tr key={tx.id}>
                                <td style={{ fontSize: 12, color: '#9ca3af', whiteSpace: 'nowrap' }}>{fmtDateEAT(tx.started_at)}</td>
                                <td>
                                  <div style={{ fontWeight: 500, fontSize: 13 }}>{tx.trader_name}</div>
                                  <div style={{ fontSize: 11, color: '#6b7280' }}>{tx.trader_phone}</div>
                                </td>
                                <td>
                                  <span style={{ padding: '2px 10px', borderRadius: 12, fontSize: 11, fontWeight: 700,
                                    background: tx.plan === 'pro' ? 'rgba(139,92,246,0.15)' : 'rgba(245,158,11,0.15)',
                                    color: tx.plan === 'pro' ? '#8b5cf6' : '#f59e0b', textTransform: 'uppercase' }}>
                                    {tx.plan}
                                  </span>
                                </td>
                                <td className="mono" style={{ fontSize: 11 }}>{tx.mpesa_transaction_id || '—'}</td>
                                <td style={{ fontSize: 12, color: '#6b7280' }}>{tx.expires_at ? fmtDateEAT(tx.expires_at) : '—'}</td>
                                <td style={{ textAlign: 'right', fontWeight: 700, color: '#10b981' }}>+{fmtKESFee(tx.amount)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {revBreakdown.pages > 1 && (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderTop: '1px solid var(--border)' }}>
                          <button onClick={() => { setRevPage(p => p - 1); loadRevenueBreakdown(revPeriod, revPlan, revPage - 1); }} disabled={revPage <= 1}
                            style={{ padding: '6px 16px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: revPage <= 1 ? '#4b5563' : '#fff', cursor: revPage <= 1 ? 'default' : 'pointer', fontSize: 13 }}>Prev</button>
                          <span style={{ fontSize: 13, color: '#6b7280' }}>Page {revPage} of {revBreakdown.pages} &middot; {revBreakdown.total} payments</span>
                          <button onClick={() => { setRevPage(p => p + 1); loadRevenueBreakdown(revPeriod, revPlan, revPage + 1); }} disabled={revPage >= revBreakdown.pages}
                            style={{ padding: '6px 16px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: revPage >= revBreakdown.pages ? '#4b5563' : '#fff', cursor: revPage >= revBreakdown.pages ? 'default' : 'pointer', fontSize: 13 }}>Next</button>
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="adm-empty">No subscription payments for this period</p>
                  )}
                </div>

                {/* Monthly volume breakdown */}
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

              {/* ── Expenses sub-view ── */}
              {expSubView === 'expenses' && (
                <>
                  {/* Add expense form */}
                  <div className="adm-card" style={{ marginBottom: 16, padding: 20 }}>
                    <h3 style={{ margin: '0 0 14px', color: '#fff', fontSize: 15 }}>Log New Expense</h3>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: 10, alignItems: 'end' }}>
                      <div>
                        <label style={{ display: 'block', fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Description</label>
                        <input className="adm-input" placeholder="e.g. Server costs" value={expenseForm.description} onChange={e => setExpenseForm(f => ({ ...f, description: e.target.value }))} style={{ width: '100%' }} />
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Amount (KES)</label>
                        <input className="adm-input" type="number" placeholder="e.g. 5000" value={expenseForm.amount} onChange={e => setExpenseForm(f => ({ ...f, amount: e.target.value }))} style={{ width: 140 }} />
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Category</label>
                        <select className="adm-select" value={expenseForm.category} onChange={e => setExpenseForm(f => ({ ...f, category: e.target.value }))} style={{ width: 140 }}>
                          {[['general','General'],['hosting','Hosting'],['marketing','Marketing'],['salaries','Salaries'],['software','Software'],['bank_fees','Bank Fees'],['other','Other']].map(([v,l]) => (
                            <option key={v} value={v}>{l}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Date</label>
                        <input className="adm-input" type="date" value={expenseForm.expense_date} onChange={e => setExpenseForm(f => ({ ...f, expense_date: e.target.value }))} style={{ width: 140 }} />
                      </div>
                    </div>
                    <div style={{ marginTop: 12, textAlign: 'right' }}>
                      <button className="adm-btn adm-btn-danger" disabled={expenseSubmitting} onClick={async () => {
                        if (!expenseForm.description || !expenseForm.amount) return;
                        setExpenseSubmitting(true);
                        try {
                          await adminAddExpense({ description: expenseForm.description, amount: parseFloat(expenseForm.amount), category: expenseForm.category, expense_date: expenseForm.expense_date });
                          setExpenseForm(f => ({ ...f, description: '', amount: '' }));
                          const r = await adminGetExpenses();
                          setExpenses(r.data.expenses || []); setExpensesTotal(r.data.total || 0);
                        } catch(err) {} finally { setExpenseSubmitting(false); }
                      }} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <PlusCircle size={14} /> {expenseSubmitting ? 'Adding...' : 'Add Expense'}
                      </button>
                    </div>
                  </div>

                  {/* Expenses table */}
                  <div className="adm-card" style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid #1f2937' }}>
                          {['Date', 'Description', 'Category', 'Amount', ''].map(h => (
                            <th key={h} style={{ padding: '10px 14px', textAlign: 'left', color: '#6b7280', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {expenses.length === 0 && (
                          <tr><td colSpan={5} style={{ textAlign: 'center', color: '#6b7280', padding: 40 }}>No expenses logged yet</td></tr>
                        )}
                        {expenses.map(e => (
                          <tr key={e.id} style={{ borderBottom: '1px solid #111827' }}>
                            <td style={{ padding: '10px 14px', color: '#9ca3af' }}>{e.expense_date}</td>
                            <td style={{ padding: '10px 14px', color: '#fff' }}>{e.description}</td>
                            <td style={{ padding: '10px 14px' }}>
                              <span style={{ padding: '3px 10px', borderRadius: 12, background: 'rgba(239,68,68,0.1)', color: '#f87171', fontSize: 11, fontWeight: 600 }}>
                                {e.category}
                              </span>
                            </td>
                            <td style={{ padding: '10px 14px', color: '#ef4444', fontWeight: 700 }}>{fmtKES(e.amount)}</td>
                            <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                              <button
                                onClick={async () => {
                                  if (!window.confirm('Delete this expense?')) return;
                                  try {
                                    await adminDeleteExpense(e.id);
                                    const r = await adminGetExpenses();
                                    setExpenses(r.data.expenses || []);
                                    setExpensesTotal(r.data.total || 0);
                                  } catch(err) {}
                                }}
                                style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', padding: 4 }}
                              >
                                <Trash2 size={14} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}

          {activeTab === 'kyc' && (
            <div>
              <div className="adm-card-header" style={{ marginBottom: 16 }}>
                <h2 style={{ color: '#fff', margin: 0 }}>KYC Verification Status</h2>
                <button className="adm-btn" onClick={() => adminGetKycTraders().then(r => setKycTraders(r.data.traders || [])).catch(() => {})} style={{ fontSize: 12 }}>
                  <RefreshCw size={13} /> Refresh
                </button>
              </div>

              {/* Trader KYC table */}
              <div className="adm-card" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #1f2937' }}>
                      {['#', 'Name', 'Phone', 'DB Status', 'Account ID', 'Actions'].map(h => (
                        <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: '#6b7280', fontWeight: 600 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {kycTraders.map(t => {
                      const status = t.choice_kyc_status || '';
                      let badge = { label: 'None', color: '#374151' };
                      if (status === 'approved') badge = { label: 'Approved ✅', color: '#065f46' };
                      else if (status === 'rejected') badge = { label: 'Rejected ❌', color: '#7f1d1d' };
                      else if (status.startsWith('pending:')) badge = { label: 'Pending Review ⏳', color: '#78350f' };
                      else if (status.startsWith('onboarding:')) badge = { label: 'Submitted', color: '#1e3a5f' };
                      return (
                        <tr key={t.id} style={{ borderBottom: '1px solid #111827' }}>
                          <td style={{ padding: '10px 12px', color: '#6b7280' }}>{t.id}</td>
                          <td style={{ padding: '10px 12px', color: '#fff', fontWeight: 600 }}>{t.full_name}</td>
                          <td style={{ padding: '10px 12px', color: '#9ca3af' }}>{t.phone || '—'}</td>
                          <td style={{ padding: '10px 12px' }}>
                            <span style={{ background: badge.color, color: '#fff', padding: '2px 8px', borderRadius: 4, fontSize: 11 }}>{badge.label}</span>
                          </td>
                          <td style={{ padding: '10px 12px', color: '#9ca3af', fontSize: 12 }}>
                            {t.choice_account_id || (t.onboarding_id ? t.onboarding_id.slice(-12) : '—')}
                          </td>
                          <td style={{ padding: '10px 12px' }}>
                            {t.onboarding_id ? (
                              <button
                                className="adm-btn"
                                style={{ fontSize: 11, padding: '4px 10px' }}
                                disabled={kycLiveLoading && kycSelectedTrader === t.id}
                                onClick={async () => {
                                  setKycSelectedTrader(t.id);
                                  setKycLiveResult(null);
                                  setKycLiveLoading(true);
                                  try {
                                    const r = await adminGetKycLiveStatus(t.id);
                                    setKycLiveResult(r.data);
                                  } catch (e) {
                                    setKycLiveResult({ error: e?.response?.data?.detail || 'API error' });
                                  } finally {
                                    setKycLiveLoading(false);
                                  }
                                }}
                              >
                                {kycLiveLoading && kycSelectedTrader === t.id ? 'Checking...' : 'Check Live'}
                              </button>
                            ) : (
                              <span style={{ fontSize: 11, color:
                                t.choice_kyc_status === 'approved' ? '#6b7280' :
                                t.choice_kyc_status === 'rejected' ? '#ef4444' : '#374151'
                              }}>
                                {t.choice_kyc_status === 'approved' ? '✅ Approved' :
                                 t.choice_kyc_status === 'rejected' ? '❌ Rejected' : 'Not started'}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Live KYC result panel */}
              {kycLiveResult && (
                <div className="adm-card" style={{ marginTop: 16 }}>
                  {kycLiveResult.error ? (
                    <div style={{ color: '#f87171', padding: 16 }}>Error: {kycLiveResult.error}</div>
                  ) : (() => {
                    const k = kycLiveResult.kyc || {};
                    const o = kycLiveResult.onboarding || {};
                    const statusColors = { 'Passed': '#065f46', 'Rejected': '#7f1d1d', 'Manual Review': '#78350f', 'Processing': '#1e3a5f', 'Submitted': '#1e3a5f' };
                    const profileColors = { 'Validated': '#065f46', 'Declined': '#7f1d1d' };
                    const sColor = statusColors[k.status_label?.split(' ')[0]] || '#374151';
                    const pColor = profileColors[k.profile_check_label] || '#374151';
                    return (
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                          <h3 style={{ margin: 0, color: '#fff' }}>{kycLiveResult.trader_name}</h3>
                          <button onClick={() => setKycLiveResult(null)} style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 18 }}>✕</button>
                        </div>
                        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 16 }}>
                          Onboarding ID: {kycLiveResult.onboarding_id}
                        </div>

                        {/* Status badges */}
                        <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
                          <div style={{ background: sColor, color: '#fff', padding: '6px 14px', borderRadius: 6, fontWeight: 700, fontSize: 13 }}>
                            KYC: {k.status_label}
                          </div>
                          <div style={{ background: pColor, color: '#fff', padding: '6px 14px', borderRadius: 6, fontWeight: 700, fontSize: 13 }}>
                            Profile Check: {k.profile_check_label}
                          </div>
                        </div>

                        {/* Profile check result */}
                        {k.profile_check_result_text && (
                          <div style={{ background: '#0d1117', border: '1px solid #1f2937', borderRadius: 8, padding: 12, marginBottom: 16 }}>
                            <span style={{ color: '#6b7280', fontSize: 12 }}>Profile Check Result: </span>
                            <span style={{ color: '#d1d5db', fontSize: 13 }}>{k.profile_check_result_text} ({k.profile_check_result_code})</span>
                          </div>
                        )}

                        {/* KYC fields */}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 24px', marginBottom: 16 }}>
                          {[
                            ['Full Name', k.full_name],
                            ['ID Number', k.id_number],
                            ['KRA PIN', k.kra_pin],
                            ['Mobile', k.mobile],
                            ['Email', k.email],
                            ['Employment', k.employment_status],
                          ].map(([label, val]) => val ? (
                            <div key={label}>
                              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>{label}</div>
                              <div style={{ color: '#fff', fontSize: 13, fontWeight: 500 }}>{val}</div>
                            </div>
                          ) : null)}
                        </div>

                        {/* Account ID if approved */}
                        {o.account_id && (
                          <div style={{ background: '#052e16', border: '1px solid #166534', borderRadius: 8, padding: 12, marginBottom: 12 }}>
                            <div style={{ fontSize: 11, color: '#4ade80', marginBottom: 4 }}>Choice Bank Account ID</div>
                            <div style={{ color: '#86efac', fontFamily: 'monospace', fontSize: 15, fontWeight: 700 }}>{o.account_id}</div>
                          </div>
                        )}

                        {/* Rejection reasons */}
                        {o.rejection_reason_msgs && o.rejection_reason_msgs.length > 0 && (
                          <div style={{ background: '#1c0a0a', border: '1px solid #991b1b', borderRadius: 8, padding: 12 }}>
                            <div style={{ fontSize: 11, color: '#f87171', marginBottom: 8, fontWeight: 600 }}>Rejection Reasons</div>
                            {o.rejection_reason_msgs.map((msg, i) => (
                              <div key={i} style={{ color: '#fca5a5', fontSize: 13, marginBottom: 4 }}>• {msg}</div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          )}

        </div>
      </div>

      {/* Mobile bottom navigation bar */}
      <nav className="mob-bottom-nav">
        {[
          { key: 'dashboard',    icon: LayoutDashboard, label: 'Dashboard' },
          { key: 'traders',      icon: Users,           label: 'Traders'   },
          { key: 'transactions', icon: ArrowRightLeft,  label: 'Orders'    },
          { key: 'disputes',     icon: AlertTriangle,   label: 'Alerts',
            badge: (unreadTicketCount || 0) + (unmatched.deposits?.length || 0) + (unmatched.withdrawals?.length || 0) },
          { key: 'more',         icon: MoreHorizontal,  label: 'More'      },
        ].map(({ key, icon: Icon, label, badge }) => {
          const primaryKeys = ['dashboard','traders','transactions','disputes'];
          const isActive = activeTab === key || (key === 'more' && !primaryKeys.includes(activeTab));
          return (
            <button
              key={key}
              className={`mob-nav-btn${isActive ? ' mob-active' : ''}`}
              onClick={() => key === 'more' ? setMobMoreOpen(true) : setActiveTab(key)}
            >
              <Icon size={22} />
              {badge > 0 && <span className="mob-nav-badge">{badge > 99 ? '99+' : badge}</span>}
              <span className="mob-nav-label">{label}</span>
            </button>
          );
        })}
      </nav>

      {/* Mobile more menu overlay */}
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
            {/* Switch back to the trader dashboard */}
            <button
              onClick={() => { setMobMoreOpen(false); navigate('/dashboard'); }}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 14,
                padding: '14px 24px', background: 'rgba(245,158,11,0.10)', border: 'none',
                borderBottom: '1px solid #374151', cursor: 'pointer', color: '#F59E0B', fontSize: 14, fontWeight: 600 }}
            >
              <LayoutDashboard size={20} color="#F59E0B" />
              Switch to Trader Dashboard
            </button>
            {[
              { key: 'withdrawals', label: 'Withdrawals',       icon: Wallet        },
              { key: 'paybill',     label: 'Paybill Txns',      icon: Banknote      },
              { key: 'kyc',         label: 'KYC Verification',  icon: UserCheck     },
              { key: 'revenue',     label: 'Revenue',           icon: TrendingUp    },
              { key: 'expenses',    label: 'Expenses',          icon: Receipt       },
              { key: 'affiliates',  label: 'Affiliates',        icon: Share2        },
              { key: 'security',    label: 'Security',          icon: Shield        },
              { key: 'settings',    label: 'Settings',          icon: Settings      },
              { key: 'survey',      label: 'Survey Responses',  icon: MessageSquare },
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
          </div>
        </div>
      )}

    </div>
  );
}
