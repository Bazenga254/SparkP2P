import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import api, { getProfile, getWallet, getOrderStats, getOrders, requestWithdrawal, requestWithdrawalOtp, getWalletTransactions, getSessionHealth, getBinanceAccountData, getMarketPrices, initiateDeposit, getDepositHistory, checkDepositStatus, internalTransfer } from '../services/api';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Wallet, TrendingUp, ArrowDownCircle, ArrowUpCircle, RefreshCw, LogOut, Settings, Clock, Shield, Plus, X, Bell, Copy, CreditCard, Eye, EyeOff, MessageSquare } from 'lucide-react';
import SettingsPanel from '../components/SettingsPanel';
import SupportChat from '../components/SupportChat';

function SpreadCalculator() {
  const [buyPrice, setBuyPrice] = useState('');
  const [sellPrice, setSellPrice] = useState('');
  const [volume, setVolume] = useState('500000');
  const [autoLoaded, setAutoLoaded] = useState(false);

  useEffect(() => {
    const fetchPrices = async () => {
      try {
        const res = await getMarketPrices();
        const d = res.data;
        if (d.best_buy > 0 && d.best_sell > 0) {
          setBuyPrice(String(d.best_buy));
          setSellPrice(String(d.best_sell));
          setAutoLoaded(true);
        }
      } catch (e) {}
    };
    fetchPrices();
    const interval = setInterval(fetchPrices, 60000);
    return () => clearInterval(interval);
  }, []);

  const buy = parseFloat(buyPrice) || 0;
  const sell = parseFloat(sellPrice) || 0;
  const vol = parseFloat(volume) || 0;
  const spread = sell - buy;
  const spreadPct = buy > 0 ? ((spread / buy) * 100) : 0;
  const usdtAmount = buy > 0 ? vol / buy : 0;
  const profit = usdtAmount * spread;
  const profitable = spread > 0;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header">
        <TrendingUp size={20} />
        <h3>Spread Calculator</h3>
        {autoLoaded && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: '#10b981', display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981', animation: 'pulse-green 1.5s ease-in-out infinite' }} />
            Live from Binance
          </span>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, padding: '12px 0' }}>
        <div>
          <label style={{ fontSize: 12, color: '#9ca3af', display: 'block', marginBottom: 4 }}>Buy Price (KSh/USDT)</label>
          <input
            type="number" step="0.01" placeholder="130.23"
            value={buyPrice} onChange={(e) => setBuyPrice(e.target.value)}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 14 }}
          />
        </div>
        <div>
          <label style={{ fontSize: 12, color: '#9ca3af', display: 'block', marginBottom: 4 }}>Sell Price (KSh/USDT)</label>
          <input
            type="number" step="0.01" placeholder="130.74"
            value={sellPrice} onChange={(e) => setSellPrice(e.target.value)}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 14 }}
          />
        </div>
        <div>
          <label style={{ fontSize: 12, color: '#9ca3af', display: 'block', marginBottom: 4 }}>Volume (KES)</label>
          <input
            type="number" step="1000" placeholder="500000"
            value={volume} onChange={(e) => setVolume(e.target.value)}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 14 }}
          />
        </div>
      </div>

      {buy > 0 && sell > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginTop: 8 }}>
          <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: '#9ca3af' }}>Spread</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: profitable ? '#10b981' : '#ef4444' }}>
              KSh {spread.toFixed(2)}
            </div>
            <div style={{ fontSize: 11, color: '#6b7280' }}>{spreadPct.toFixed(2)}% per USDT</div>
          </div>
          <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: '#9ca3af' }}>USDT Traded</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#f59e0b' }}>
              {usdtAmount.toFixed(2)}
            </div>
            <div style={{ fontSize: 11, color: '#6b7280' }}>at KSh {buy}</div>
          </div>
          <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: '#9ca3af' }}>Profit per Trade</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: profitable ? '#10b981' : '#ef4444' }}>
              KSh {profit.toFixed(0)}
            </div>
            <div style={{ fontSize: 11, color: '#6b7280' }}>{profitable ? 'profit' : 'loss'}</div>
          </div>
          <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: '#9ca3af' }}>Daily (5 trades)</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: profitable ? '#10b981' : '#ef4444' }}>
              KSh {(profit * 5).toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </div>
            <div style={{ fontSize: 11, color: '#6b7280' }}>
              Monthly: KSh {(profit * 5 * 30).toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </div>
          </div>
        </div>
      )}

      {!profitable && buy > 0 && sell > 0 && (
        <div style={{ marginTop: 8, padding: '8px 12px', background: 'rgba(239,68,68,0.1)', borderRadius: 8, fontSize: 12, color: '#ef4444' }}>
          Negative spread — you would lose money. Sell price must be higher than buy price.
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [scanning, setScanning] = useState(searchParams.get('scanning') === '1');
  const scanPollRef = useRef(null);
  const [profile, setProfile] = useState(null);
  const [wallet, setWallet] = useState(null);
  const [stats, setStats] = useState(null);
  const [orders, setOrders] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [activeTab, setActiveTab] = useState('overview');
  const [txnTab, setTxnTab] = useState('deposits');
  const [refreshing, setRefreshing] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [showBalance, setShowBalance] = useState(false);
  const [showWithdrawModal, setShowWithdrawModal] = useState(false);
  const [withdrawPreview, setWithdrawPreview] = useState(null);
  const [withdrawOtp, setWithdrawOtp] = useState('');
  const [withdrawOtpSent, setWithdrawOtpSent] = useState(false);
  const [withdrawOtpLoading, setWithdrawOtpLoading] = useState(false);
  const [withdrawMsg, setWithdrawMsg] = useState('');
  const [sessionHealth, setSessionHealth] = useState(null);
  const [identityError, setIdentityError] = useState('');
  const [notifications, setNotifications] = useState([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [openSupportChat, setOpenSupportChat] = useState(false);
  const [showPaybill, setShowPaybill] = useState(false);
  const [copied, setCopied] = useState('');
  const [binanceData, setBinanceData] = useState(null);
  const [showDepositModal, setShowDepositModal] = useState(false);
  const [depositAmount, setDepositAmount] = useState('');
  const [depositPhone, setDepositPhone] = useState('');
  const [depositLoading, setDepositLoading] = useState(false);
  const [depositStatus, setDepositStatus] = useState(null); // null, 'pending', 'success', 'failed'
  const [depositMessage, setDepositMessage] = useState('');
  const [depositHistory, setDepositHistory] = useState([]);
  const depositPollRef = useRef(null);
  const [showSendModal, setShowSendModal] = useState(false);
  const [sendRecipient, setSendRecipient] = useState('');
  const [sendAmount, setSendAmount] = useState('');
  const [sendLoading, setSendLoading] = useState(false);
  const [sendMessage, setSendMessage] = useState('');
  const [sendStatus, setSendStatus] = useState(null); // null, 'success', 'error'

  const loadData = async () => {
    if (!localStorage.getItem('token')) return;
    setRefreshing(true);
    try {
      const results = await Promise.allSettled([
        getProfile(),
        getWallet(),
        getOrderStats(),
        getOrders({ limit: 20 }),
        getWalletTransactions(20),
        getSessionHealth(),
        getBinanceAccountData(),
      ]);
      if (results[0].status === 'fulfilled') setProfile(results[0].value.data);
      if (results[1].status === 'fulfilled') setWallet(results[1].value.data);
      if (results[2].status === 'fulfilled') setStats(results[2].value.data);
      if (results[3].status === 'fulfilled') setOrders(results[3].value.data);
      if (results[4].status === 'fulfilled') setTransactions(results[4].value.data);
      if (results[5].status === 'fulfilled') setSessionHealth(results[5].value.data);
      if (results[6].status === 'fulfilled') setBinanceData(results[6].value.data);

      // Fetch notifications
      try {
        const notifRes = await api.get('/traders/notifications');
        if (notifRes.data) {
          setNotifications(notifRes.data);
          setUnreadCount(notifRes.data.filter(n => !n.read).length);
        }
      } catch (e) {}
    } catch (err) {
      console.error('Failed to load data:', err);
    }
    setRefreshing(false);
  };

  // Listen for identity mismatch event from desktop bot
  useEffect(() => {
    const handler = (e) => setIdentityError(e.detail?.message || 'Identity verification failed. Please log in with your registered Binance account.');
    window.addEventListener('identity-mismatch', handler);
    return () => window.removeEventListener('identity-mismatch', handler);
  }, []);

  useEffect(() => {
    // Wait a tick to ensure token is stored after login redirect
    const timer = setTimeout(() => {
      if (localStorage.getItem('token')) {
        loadData();
      }
    }, 100);
    const interval = setInterval(() => {
      if (localStorage.getItem('token')) {
        loadData();
      }
    }, 15000);
    return () => { clearTimeout(timer); clearInterval(interval); };
  }, []);

  // Fast wallet poll every 5s for real-time balance updates
  useEffect(() => {
    const walletPoll = setInterval(async () => {
      if (!localStorage.getItem('token')) return;
      try {
        const res = await getWallet();
        if (res.data) {
          setWallet(prev => {
            if (prev && res.data.balance !== prev.balance) {
              // Balance changed — also refresh transactions
              getWalletTransactions(20).then(r => { if (r.data) setTransactions(r.data); }).catch(() => {});
            }
            return res.data;
          });
        }
      } catch (e) {}
    }, 5000);
    return () => clearInterval(walletPoll);
  }, []);

  // Redirect to onboarding if not complete (only for traders, not admin/employees)
  useEffect(() => {
    if (profile && profile.onboarding_complete === false && profile.role === 'trader') {
      navigate('/onboarding');
    }
  }, [profile]);

  // Scanning overlay: poll until first extension sync received
  useEffect(() => {
    if (!scanning) return;
    // Clear the URL param without re-render
    setSearchParams({}, { replace: true });
    scanPollRef.current = setInterval(async () => {
      try {
        const res = await getProfile();
        if (res.data.last_extension_sync) {
          clearInterval(scanPollRef.current);
          setScanning(false);
        }
      } catch (_) {}
    }, 3000);
    // Safety timeout: remove overlay after 90s even if scan never signals
    const timeout = setTimeout(() => {
      clearInterval(scanPollRef.current);
      setScanning(false);
    }, 90000);
    return () => { clearInterval(scanPollRef.current); clearTimeout(timeout); };
  }, [scanning]);

  const handleWithdraw = async () => {
    if (!wallet || wallet.balance <= 0) return;

    // Get fee preview first
    try {
      const preview = await api.get('/traders/wallet/withdraw/preview');
      const p = preview.data;

      if (!p.can_withdraw) {
        if (p.cooldown_active) {
          alert(`Your payment method was recently changed. Withdrawals available in ${p.cooldown_hours} hours.`);
        } else {
          alert('Cannot withdraw at this time.');
        }
        return;
      }

      setWithdrawPreview(p);
      setWithdrawOtp('');
      setWithdrawOtpSent(false);
      setWithdrawMsg('');
      setShowWithdrawModal(true);
    } catch (err) {
      alert(err.response?.data?.detail || 'Could not check withdrawal');
    }
  };

  const handleDeposit = async () => {
    const amt = parseFloat(depositAmount);
    if (!amt || amt < 100 || amt > 500000) {
      setDepositMessage('Amount must be between KES 100 and KES 500,000');
      return;
    }
    if (!depositPhone || depositPhone.length < 9) {
      setDepositMessage('Please enter a valid M-Pesa phone number');
      return;
    }

    setDepositLoading(true);
    setDepositMessage('');
    setDepositStatus(null);

    try {
      const res = await initiateDeposit(amt, depositPhone);
      const checkoutId = res.data.checkout_request_id;
      setDepositStatus('pending');
      setDepositMessage('STK Push sent. Enter your M-Pesa PIN on your phone...');

      // Poll for status
      let attempts = 0;
      depositPollRef.current = setInterval(async () => {
        attempts++;
        try {
          const statusRes = await checkDepositStatus(checkoutId);
          if (statusRes.data.status === 'completed') {
            clearInterval(depositPollRef.current);
            setDepositStatus('success');
            setDepositMessage(`Deposit successful! New balance: KES ${statusRes.data.balance_after?.toLocaleString()}`);
            setDepositLoading(false);
            loadData(); // Refresh wallet
          } else if (statusRes.data.status === 'failed') {
            clearInterval(depositPollRef.current);
            setDepositStatus('failed');
            setDepositMessage('Deposit failed. Please try again.');
            setDepositLoading(false);
          }
        } catch (e) {
          // Ignore poll errors
        }
        if (attempts >= 30) {
          // Stop polling after ~60 seconds
          clearInterval(depositPollRef.current);
          setDepositStatus('failed');
          setDepositMessage('Timed out waiting for payment confirmation. Check your M-Pesa and try again.');
          setDepositLoading(false);
        }
      }, 2000);
    } catch (err) {
      setDepositStatus('failed');
      setDepositMessage(err.response?.data?.detail || 'Failed to initiate deposit');
      setDepositLoading(false);
    }
  };

  const closeDepositModal = () => {
    if (depositPollRef.current) clearInterval(depositPollRef.current);
    setShowDepositModal(false);
    setDepositAmount('');
    setDepositStatus(null);
    setDepositMessage('');
    setDepositLoading(false);
  };

  const handleSend = async () => {
    const amt = parseFloat(sendAmount);
    if (!amt || amt < 10) {
      setSendMessage('Minimum transfer is KES 10');
      setSendStatus('error');
      return;
    }
    if (!sendRecipient || sendRecipient.trim().length < 5) {
      setSendMessage('Enter a valid phone number or email');
      setSendStatus('error');
      return;
    }
    setSendLoading(true);
    setSendMessage('');
    setSendStatus(null);
    try {
      const res = await internalTransfer(sendRecipient.trim(), amt);
      setSendStatus('success');
      setSendMessage(res.data.message || 'Transfer successful!');
      loadData();
    } catch (err) {
      setSendStatus('error');
      setSendMessage(err.response?.data?.detail || 'Transfer failed');
    }
    setSendLoading(false);
  };

  const closeSendModal = () => {
    setShowSendModal(false);
    setSendRecipient('');
    setSendAmount('');
    setSendMessage('');
    setSendStatus(null);
    setSendLoading(false);
  };

  // Pre-fill phone from profile
  useEffect(() => {
    if (profile?.phone) setDepositPhone(profile.phone);
  }, [profile]);

  // Load deposit history when transactions tab is opened
  useEffect(() => {
    if (activeTab === 'transactions') {
      getDepositHistory(20).then(res => setDepositHistory(res.data)).catch(() => {});
    }
  }, [activeTab]);

  const getStatusColor = (status) => {
    const colors = {
      pending: '#f59e0b',
      payment_received: '#3b82f6',
      released: '#10b981',
      completed: '#10b981',
      disputed: '#ef4444',
      cancelled: '#6b7280',
    };
    return colors[status] || '#6b7280';
  };

  return (
    <div className="dashboard">
      {/* Binance initial scan overlay */}
      {scanning && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(10,12,28,0.92)',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          gap: 24, cursor: 'wait',
        }}>
          <div style={{
            width: 72, height: 72,
            border: '5px solid rgba(245,158,11,0.2)',
            borderTop: '5px solid #f59e0b',
            borderRadius: '50%',
            animation: 'spin 0.9s linear infinite',
          }} />
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#f59e0b', marginBottom: 8 }}>
              Scanning Binance Orders...
            </div>
            <div style={{ fontSize: 14, color: '#9ca3af', maxWidth: 300 }}>
              Your bot is performing the initial scan. This may take up to a minute. Please wait.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            {[0, 1, 2].map(i => (
              <div key={i} style={{
                width: 8, height: 8, borderRadius: '50%', background: '#f59e0b',
                animation: `bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
              }} />
            ))}
          </div>
        </div>
      )}

      {/* Identity mismatch alert */}
      {identityError && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9998,
          background: '#7f1d1d', borderBottom: '2px solid #ef4444',
          padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <span style={{ fontSize: 20 }}>🚫</span>
          <div style={{ flex: 1 }}>
            <div style={{ color: '#fca5a5', fontWeight: 700, fontSize: 14 }}>Identity Verification Failed</div>
            <div style={{ color: '#fecaca', fontSize: 13, marginTop: 2 }}>{identityError}</div>
          </div>
          <button onClick={() => setIdentityError('')} style={{ background: 'transparent', border: '1px solid #ef4444', color: '#fca5a5', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontSize: 13 }}>Dismiss</button>
        </div>
      )}

      <header className="dash-header">
        <div className="dash-header-left">
          <img src="/logo.png" alt="SparkP2P" className="header-logo" />
          <h1>SparkP2P</h1>
          <span className={`status-badge ${profile?.binance_connected ? 'connected' : 'disconnected'}`}>
            {profile?.binance_connected ? 'Binance Connected' : 'Binance Disconnected'}
          </span>
          <span
            style={{
              display: 'inline-block',
              width: 10,
              height: 10,
              borderRadius: '50%',
              marginLeft: 6,
              backgroundColor: profile?.binance_connected ? '#10b981' : '#ef4444',
              boxShadow: profile?.binance_connected ? '0 0 6px #10b981' : '0 0 4px #ef4444',
              animation: profile?.binance_connected ? 'pulse-green 1.5s ease-in-out infinite' : 'none',
            }}
            title={profile?.binance_connected ? 'Binance Connected' : 'Disconnected'}
          />
        </div>
        <div className="dash-header-right">
          <span className="user-name">{user?.full_name}</span>
          <span className="tier-badge">{profile?.tier || 'standard'}</span>
          {(profile?.role === 'employee' || profile?.is_admin) && (
            <button className="icon-btn" onClick={() => navigate(profile?.is_admin ? '/admin' : '/employee')} title={profile?.is_admin ? 'Admin' : 'Employee Portal'}>
              <Shield size={18} />
            </button>
          )}
          <div style={{ position: 'relative' }}>
            <button
              className="icon-btn"
              title="Messages"
              onClick={() => { setOpenSupportChat(true); }}
            >
              <MessageSquare size={18} />
              {notifications.filter(n => !n.read && n.type === 'support').length > 0 && (
                <span style={{ position: 'absolute', top: -2, right: -2, background: '#6366f1', color: '#fff', borderRadius: '50%', width: 16, height: 16, fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>
                  {notifications.filter(n => !n.read && n.type === 'support').length}
                </span>
              )}
            </button>
          </div>
          <div style={{ position: 'relative' }}>
            <button className="icon-btn" onClick={() => { setShowNotifications(!showNotifications); setUnreadCount(0); api.post('/traders/notifications/mark-read').catch(() => {}); }}>
              <Bell size={18} />
              {unreadCount > 0 && (
                <span style={{ position: 'absolute', top: -2, right: -2, background: '#ef4444', color: '#fff', borderRadius: '50%', width: 16, height: 16, fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </button>
            {showNotifications && (
              <div style={{ position: 'absolute', top: 36, right: 0, width: 320, maxHeight: 400, overflowY: 'auto', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 8px 30px rgba(0,0,0,0.4)', zIndex: 100 }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 14 }}>Notifications</div>
                {notifications.length === 0 ? (
                  <div style={{ padding: 20, textAlign: 'center', color: '#6b7280', fontSize: 13 }}>No notifications yet</div>
                ) : (
                  notifications.slice(0, 20).map((n, i) => (
                    <div key={i} style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', fontSize: 13, opacity: n.read ? 0.6 : 1 }}>
                      <div style={{ fontWeight: n.read ? 400 : 600, color: n.type === 'payment' ? '#10b981' : n.type === 'release' ? '#3b82f6' : '#e5e7eb' }}>
                        {n.title}
                      </div>
                      <div style={{ color: '#9ca3af', fontSize: 12, marginTop: 2 }}>{n.message}</div>
                      <div style={{ color: '#6b7280', fontSize: 11, marginTop: 4 }}>{n.time}</div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
          <button className="icon-btn" onClick={loadData} disabled={refreshing}>
            <RefreshCw size={18} className={refreshing ? 'spinning' : ''} />
          </button>
          <button className="icon-btn" onClick={logout}><LogOut size={18} /></button>
        </div>
      </header>

      <nav className="dash-tabs">
        {['overview', 'orders', 'transactions', 'settings'].map((tab) => (
          <button
            key={tab}
            className={`tab-btn ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
        {!profile?.binance_connected && (
          <button
            className="tab-btn"
            style={{ color: '#f59e0b', fontWeight: 600 }}
            onClick={() => setActiveTab('settings')}
          >
            Connect Binance
          </button>
        )}
        <div style={{ position: 'relative', marginLeft: 'auto' }}>
          <button
            className="tab-btn"
            style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#10b981', fontWeight: 600, fontSize: 13 }}
            onClick={() => setShowPaybill(!showPaybill)}
          >
            <CreditCard size={14} /> My Paybill
          </button>
          {showPaybill && (
            <div style={{ position: 'absolute', top: 40, right: 0, width: 340, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 8px 30px rgba(0,0,0,0.4)', zIndex: 100, padding: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Add to Binance Payment Method</div>
              <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 12 }}>
                Copy these details and add them as your M-Pesa Paybill payment method on Binance P2P.
              </div>

              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>Account Name</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg)', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)' }}>
                  <span style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>{profile?.full_name || 'Loading...'}</span>
                  <button onClick={() => { navigator.clipboard.writeText(profile?.full_name || ''); setCopied('name'); setTimeout(() => setCopied(''), 2000); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: copied === 'name' ? '#10b981' : '#9ca3af', padding: 2 }}>
                    <Copy size={14} />
                  </button>
                </div>
              </div>

              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>Account Number</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg)', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)' }}>
                  <span style={{ flex: 1, fontWeight: 600, fontSize: 13, fontFamily: 'monospace' }}>P2P-T{String(profile?.id || 0).padStart(4, '0')}</span>
                  <button onClick={() => { navigator.clipboard.writeText(`P2P-T${String(profile?.id || 0).padStart(4, '0')}`); setCopied('account'); setTimeout(() => setCopied(''), 2000); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: copied === 'account' ? '#10b981' : '#9ca3af', padding: 2 }}>
                    <Copy size={14} />
                  </button>
                </div>
              </div>

              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>Paybill Number</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg)', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)' }}>
                  <span style={{ flex: 1, fontWeight: 600, fontSize: 13, fontFamily: 'monospace' }}>4041355</span>
                  <button onClick={() => { navigator.clipboard.writeText('4041355'); setCopied('paybill'); setTimeout(() => setCopied(''), 2000); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: copied === 'paybill' ? '#10b981' : '#9ca3af', padding: 2 }}>
                    <Copy size={14} />
                  </button>
                </div>
              </div>

              {copied && (
                <div style={{ fontSize: 12, color: '#10b981', textAlign: 'center', marginBottom: 8 }}>Copied!</div>
              )}

              <div style={{ fontSize: 11, color: '#6b7280', lineHeight: 1.5, padding: '8px 0', borderTop: '1px solid var(--border)' }}>
                On Binance: Go to P2P → Post Ad → Payment Method → M-Pesa Paybill → paste these details. The account name must match your Binance KYC exactly.
              </div>
            </div>
          )}
        </div>
      </nav>

      <main className="dash-content">
{activeTab === 'overview' && (
          <>
            {/* Row 1: Greeting + Wallet */}
            <div className="overview-grid-top">
              <div className="card greeting-card">
                <div className="greeting-text">
                  <span className="greeting-hello">Good {new Date().getHours() < 12 ? 'Morning' : new Date().getHours() < 18 ? 'Afternoon' : 'Evening'}, {user?.full_name}!</span>
                  <span className="greeting-sub">Today's Earnings</span>
                  <span className="greeting-amount">KES {(stats?.today?.net_profit || 0).toLocaleString()}</span>
                </div>
                <div className="greeting-icon">
                  {(stats?.today?.net_profit || 0) >= 0 ? '📈' : '📉'}
                </div>
              </div>

              <div className="card wallet-mini-card">
                <div className="wallet-mini-header">
                  <Wallet size={18} />
                  <span>Wallet Balance</span>
                  <button
                    onClick={() => setShowBalance(v => !v)}
                    style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center' }}
                    title={showBalance ? 'Hide balance' : 'Show balance'}
                  >
                    {showBalance ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
                <div className="wallet-mini-amount">
                  {showBalance ? `KES ${wallet?.balance?.toLocaleString() || '0'}` : 'KES ••••••'}
                </div>
                {wallet?.reserved > 0 && (
                  <div className="wallet-reserved" style={{ fontSize: 12, color: '#f59e0b', marginBottom: 4 }}>
                    Reserved: {showBalance ? `KES ${wallet.reserved.toLocaleString()}` : 'KES ••••'}
                  </div>
                )}
                <div className="wallet-mini-stats">
                  <span>Earned: {showBalance ? `KES ${wallet?.total_earned?.toLocaleString() || '0'}` : 'KES ••••'}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button
                    className="deposit-btn-mini"
                    onClick={() => setShowDepositModal(true)}
                    style={{
                      flex: 1, padding: '8px 0', borderRadius: 8, border: 'none',
                      background: 'linear-gradient(135deg, #10b981, #059669)', color: '#fff',
                      fontWeight: 600, fontSize: 13, cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                    }}
                  >
                    <Plus size={14} /> Deposit
                  </button>
                  <button
                    onClick={() => setShowSendModal(true)}
                    style={{
                      flex: 1, padding: '8px 0', borderRadius: 8, border: 'none',
                      background: 'linear-gradient(135deg, #3b82f6, #2563eb)', color: '#fff',
                      fontWeight: 600, fontSize: 13, cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                    }}
                  >
                    <ArrowUpCircle size={14} /> Send
                  </button>
                  <button
                    className="withdraw-btn-mini"
                    onClick={handleWithdraw}
                    disabled={withdrawing || !wallet || wallet.balance <= 0}
                  >
                    {withdrawing ? 'Processing...' : 'Withdraw'}
                  </button>
                </div>
              </div>
            </div>

            {/* Row 2: Quick Stats */}
            <div className="overview-stats-row">
              <div className="mini-stat-card">
                <span className="mini-stat-value">{stats?.today?.total_trades || 0}</span>
                <span className="mini-stat-label">Total Trades</span>
              </div>
              <div className="mini-stat-card sell-card">
                <span className="mini-stat-value">{stats?.today?.sell_trades || 0}</span>
                <span className="mini-stat-label">Sell Orders</span>
              </div>
              <div className="mini-stat-card buy-card">
                <span className="mini-stat-value">{stats?.today?.buy_trades || 0}</span>
                <span className="mini-stat-label">Buy Orders</span>
              </div>
              <div className="mini-stat-card">
                <span className="mini-stat-value">KES {(stats?.today?.volume || 0).toLocaleString()}</span>
                <span className="mini-stat-label">Total Volume</span>
              </div>
              <div className="mini-stat-card">
                <span className="mini-stat-value">{stats?.limits?.remaining_today || 0}/{stats?.limits?.daily_limit || 0}</span>
                <span className="mini-stat-label">Daily Limit</span>
              </div>
            </div>


            {/* Row 3: Buy/Sell Breakdown + Profit */}
            <div className="overview-grid-mid">
              {/* Buying Summary */}
              <div className="card buysell-card buying">
                <div className="buysell-header">
                  <ArrowUpCircle size={20} />
                  <h3>Buying</h3>
                </div>
                <div className="buysell-amount">
                  <span className="buysell-crypto">{(stats?.today?.buy_crypto || 0).toFixed(2)} USDT</span>
                  <span className="buysell-fiat">KES {(stats?.today?.buy_volume || 0).toLocaleString()}</span>
                </div>
                <div className="buysell-detail">
                  <div><span>Orders</span><span>{stats?.today?.buy_trades || 0}</span></div>
                  <div><span>Avg Rate</span><span>KES {stats?.today?.avg_buy_rate || '0.00'}</span></div>
                </div>
                <div style={{ borderTop: '1px solid var(--border)', marginTop: 10, paddingTop: 8, fontSize: 12, color: '#9ca3af' }}>
                  Minimum: <strong style={{ color: '#f59e0b' }}>KES 100,000</strong>
                </div>
              </div>

              {/* Selling Summary */}
              <div className="card buysell-card selling">
                <div className="buysell-header">
                  <ArrowDownCircle size={20} />
                  <h3>Selling</h3>
                </div>
                <div className="buysell-amount">
                  <span className="buysell-crypto">{(stats?.today?.sell_crypto || 0).toFixed(2)} USDT</span>
                  <span className="buysell-fiat">KES {(stats?.today?.sell_volume || 0).toLocaleString()}</span>
                </div>
                <div className="buysell-detail">
                  <div><span>Orders</span><span>{stats?.today?.sell_trades || 0}</span></div>
                  <div><span>Avg Rate</span><span>KES {stats?.today?.avg_sell_rate || '0.00'}</span></div>
                </div>
                <div style={{ borderTop: '1px solid var(--border)', marginTop: 10, paddingTop: 8, fontSize: 12, color: '#9ca3af' }}>
                  Minimum: <strong style={{ color: '#10b981' }}>KES 1,000</strong>
                </div>
              </div>

              {/* Profit Summary */}
              <div className="card profit-card">
                <div className="card-header">
                  <TrendingUp size={20} />
                  <h3>Profit Breakdown</h3>
                </div>
                <div className="profit-amount">
                  <span className={`big-profit ${(stats?.today?.net_profit || 0) >= 0 ? 'positive' : 'negative'}`}>
                    KES {(stats?.today?.net_profit || 0).toLocaleString()}
                  </span>
                  <span className="profit-label">Net Profit</span>
                </div>
                <div className="profit-breakdown">
                  <div className="profit-row spread-row">
                    <span>Spread</span>
                    <span>KES {stats?.today?.spread || '0.00'} ({stats?.today?.spread_pct || '0.00'}%)</span>
                  </div>
                  <div className="profit-row">
                    <span>Gross Profit</span>
                    <span className="positive">KES {(stats?.today?.gross_profit || 0).toLocaleString()}</span>
                  </div>
                  <div className="profit-row fee-row">
                    <span>Fees</span>
                    <span>-KES {(stats?.today?.total_fees || 0).toLocaleString()}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Spread Calculator */}
            <SpreadCalculator />

            {/* Row 4: Recent Orders */}
            <div className="card orders-card">
              <div className="card-header">
                <Clock size={20} />
                <h3>Recent Orders</h3>
              </div>
              <div className="orders-list">
                {orders.slice(0, 5).map((order) => (
                  <div key={order.id} className="order-item">
                    <div className="order-side">
                      {order.side === 'sell' ? (
                        <ArrowDownCircle size={18} color="#10b981" />
                      ) : (
                        <ArrowUpCircle size={18} color="#3b82f6" />
                      )}
                      <span>{order.side.toUpperCase()}</span>
                    </div>
                    <div className="order-details">
                      <span>{order.crypto_amount} {order.crypto_currency} @ {order.exchange_rate}</span>
                      <span className="fiat">KES {order.fiat_amount.toLocaleString()}</span>
                    </div>
                    <div className="order-status" style={{ color: getStatusColor(order.status) }}>
                      {order.status.replace('_', ' ')}
                    </div>
                  </div>
                ))}
                {orders.length === 0 && <p className="empty-msg">No orders yet</p>}
              </div>
            </div>

            {/* Binance Account Data */}
            {binanceData && (binanceData.balances?.length > 0 || binanceData.active_ads?.length > 0 || binanceData.completed_orders?.length > 0 || binanceData.updated_at) && (
              <>
                {/* Binance Username */}
                {binanceData.nickname && (
                  <div style={{ padding: '10px 0 4px', fontSize: 14, color: '#9ca3af' }}>
                    Binance Account: <span style={{ color: '#f59e0b', fontWeight: 600 }}>{binanceData.nickname}</span>
                  </div>
                )}

                {/* Binance Wallet Balance */}
                <div className="card">
                  <div className="card-header">
                    <Wallet size={20} />
                    <h3>Binance Wallet</h3>
                    {binanceData.balances?.length === 0 && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 8, fontSize: 12, color: '#f59e0b', background: 'rgba(245,158,11,0.1)', borderRadius: 20, padding: '2px 10px' }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#f59e0b', display: 'inline-block', animation: 'pulse 1.4s ease-in-out infinite' }} />
                        Scanning...
                      </span>
                    )}
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: '#6b7280' }}>
                      {binanceData.updated_at ? `Synced: ${new Date(binanceData.updated_at).toLocaleTimeString()}` : ''}
                    </span>
                  </div>
                  {binanceData.balances?.length > 0 ? (
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', padding: '12px 0' }}>
                      {binanceData.balances.map((b, i) => (
                        <div key={i} style={{
                          background: 'var(--bg)', borderRadius: 10, padding: '14px 20px',
                          minWidth: 150, flex: '1 1 150px',
                          border: '1px solid var(--border)',
                        }}>
                          <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 4 }}>
                            {b.asset} {b.wallet ? <span style={{ fontSize: 10, opacity: 0.6 }}>({b.wallet})</span> : ''}
                          </div>
                          <div style={{ fontSize: 22, fontWeight: 700, color: '#f59e0b' }}>{b.total?.toFixed(4)}</div>
                          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                            Available: {b.free?.toFixed(4)} | Locked: {b.locked?.toFixed(4)}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ padding: '24px 0', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                      <div style={{ width: 36, height: 36, border: '3px solid rgba(245,158,11,0.2)', borderTop: '3px solid #f59e0b', borderRadius: '50%', animation: 'spin 0.9s linear infinite' }} />
                      <span style={{ color: '#9ca3af', fontSize: 13 }}>Bot is scanning your Binance account...</span>
                      <span style={{ color: '#6b7280', fontSize: 11 }}>Balance will appear once the initial scan completes</span>
                    </div>
                  )}
                </div>

                {/* Active Ads */}
                {binanceData.active_ads?.length > 0 && (
                  <div className="card">
                    <div className="card-header">
                      <TrendingUp size={20} />
                      <h3>Your Active Ads on Binance</h3>
                    </div>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Type</th>
                          <th>Asset</th>
                          <th>Price</th>
                          <th>Available</th>
                          <th>Limits</th>
                        </tr>
                      </thead>
                      <tbody>
                        {binanceData.active_ads.map((ad, i) => (
                          <tr key={i}>
                            <td className={ad.tradeType === 'SELL' ? 'sell' : 'buy'}>{ad.tradeType}</td>
                            <td>{ad.asset}</td>
                            <td>KES {ad.price?.toLocaleString()}</td>
                            <td>{ad.amount?.toFixed(2)} {ad.asset}</td>
                            <td>KES {ad.minLimit?.toLocaleString()} - {ad.maxLimit?.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Binance Order History */}
                {binanceData.completed_orders?.length > 0 && (
                  <div className="card">
                    <div className="card-header">
                      <Clock size={20} />
                      <h3>Binance Order History</h3>
                      <span style={{ marginLeft: 'auto', fontSize: 12, color: '#6b7280' }}>
                        Last synced: {binanceData.updated_at ? new Date(binanceData.updated_at).toLocaleTimeString() : 'Never'}
                      </span>
                    </div>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Type</th>
                          <th>Amount</th>
                          <th>Crypto</th>
                          <th>Rate</th>
                          <th>Counterparty</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {binanceData.completed_orders.map((o, i) => (
                          <tr key={i}>
                            <td className={o.tradeType === 'SELL' ? 'sell' : 'buy'}>{o.tradeType}</td>
                            <td>KES {o.totalPrice?.toLocaleString()}</td>
                            <td>{o.amount?.toFixed(2)} {o.asset}</td>
                            <td>KES {o.price?.toFixed(2)}</td>
                            <td>{o.counterparty || '-'}</td>
                            <td style={{ color: o.status === 4 ? '#10b981' : '#f59e0b' }}>
                              {o.status === 4 ? 'Completed' : o.status === 5 ? 'Cancelled' : 'Other'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {activeTab === 'orders' && (
          <div className="card">
            <h3>All Orders</h3>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Side</th>
                  <th>Amount</th>
                  <th>Crypto</th>
                  <th>Rate</th>
                  <th>Status</th>
                  <th>Reference</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id}>
                    <td className={`side-${order.side}`}>{order.side.toUpperCase()}</td>
                    <td>KES {order.fiat_amount.toLocaleString()}</td>
                    <td>{order.crypto_amount} {order.crypto_currency}</td>
                    <td>{order.exchange_rate}</td>
                    <td style={{ color: getStatusColor(order.status) }}>
                      {order.status.replace('_', ' ')}
                    </td>
                    <td className="mono">{order.account_reference || '-'}</td>
                    <td>{new Date(order.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'transactions' && (
          <>
            {/* Sub-tabs */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
              {['deposits', 'withdrawals'].map((t) => (
                <button
                  key={t}
                  onClick={() => setTxnTab(t)}
                  style={{
                    padding: '8px 22px', borderRadius: 8, border: 'none', cursor: 'pointer',
                    fontWeight: 600, fontSize: 13,
                    background: txnTab === t ? 'linear-gradient(135deg, #10b981, #059669)' : '#1f2937',
                    color: txnTab === t ? '#fff' : '#9ca3af',
                    transition: 'all 0.15s',
                  }}
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>

            {/* Deposits Tab */}
            {txnTab === 'deposits' && (
              <div className="card">
                <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <h3>Deposit History</h3>
                  <button
                    onClick={() => setShowDepositModal(true)}
                    style={{
                      padding: '6px 16px', borderRadius: 8, border: 'none',
                      background: 'linear-gradient(135deg, #10b981, #059669)', color: '#fff',
                      fontWeight: 600, fontSize: 12, cursor: 'pointer',
                      display: 'flex', alignItems: 'center', gap: 4,
                    }}
                  >
                    <Plus size={14} /> New Deposit
                  </button>
                </div>
                {depositHistory.length > 0 ? (
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Amount</th>
                        <th>Status</th>
                        <th>Receipt</th>
                        <th>Balance After</th>
                        <th>Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {depositHistory.map((dep) => (
                        <tr key={dep.id}>
                          <td className="positive">+KES {dep.amount.toLocaleString()}</td>
                          <td style={{
                            color: dep.status === 'completed' ? '#10b981' : dep.status === 'failed' ? '#ef4444' : '#f59e0b',
                          }}>
                            {dep.status}
                          </td>
                          <td className="mono">{dep.mpesa_receipt || '-'}</td>
                          <td>KES {dep.balance_after?.toLocaleString() || '-'}</td>
                          <td>{new Date(dep.created_at).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="empty-msg">No deposits yet. Deposit funds to enable auto-pay for buy orders.</p>
                )}
              </div>
            )}

            {/* Withdrawals Tab */}
            {txnTab === 'withdrawals' && (() => {
              // Group platform_fee + settlement_fee at the same timestamp into one "fees" row
              const negative = transactions.filter(t => t.amount < 0);
              const grouped = [];
              const feeMap = {}; // key = minute-truncated timestamp → accumulated fee amount

              negative.forEach(txn => {
                const minuteKey = txn.created_at.slice(0, 16); // "2026-04-01T11:44"
                if (txn.type === 'platform_fee' || txn.type === 'settlement_fee') {
                  if (!feeMap[minuteKey]) {
                    feeMap[minuteKey] = { type: 'fees', amount: 0, balance_after: txn.balance_after, description: 'Transaction fees', created_at: txn.created_at, id: 'fee-' + minuteKey };
                    grouped.push(feeMap[minuteKey]);
                  }
                  feeMap[minuteKey].amount += txn.amount;
                } else {
                  grouped.push(txn);
                }
              });

              return (
                <div className="card">
                  <h3>Withdrawals & Fees</h3>
                  {grouped.length > 0 ? (
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Type</th>
                          <th>Amount</th>
                          <th>Balance After</th>
                          <th>Sent To</th>
                          <th>Description</th>
                          <th>Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {grouped.map((txn) => {
                          const desc = (txn.description || '').toLowerCase();
                          let destination = null;
                          if (txn.type === 'withdrawal') {
                            if (desc.includes('mpesa') || desc.includes('m-pesa') || desc.includes('safaricom')) {
                              destination = { label: 'Safaricom M-Pesa', color: '#10b981', bg: 'rgba(16,185,129,0.1)' };
                            } else if (desc.includes('i&m') || desc.includes('im bank') || desc.includes('i & m')) {
                              destination = { label: 'I&M Bank', color: '#3b82f6', bg: 'rgba(59,130,246,0.1)' };
                            } else if (desc.includes('bank') || desc.includes('paybill') || desc.includes('till')) {
                              destination = { label: 'Bank', color: '#8b5cf6', bg: 'rgba(139,92,246,0.1)' };
                            }
                          }
                          return (
                            <tr key={txn.id}>
                              <td>{txn.type.replace(/_/g, ' ')}</td>
                              <td className="negative">{txn.amount.toLocaleString()}</td>
                              <td>KES {txn.balance_after.toLocaleString()}</td>
                              <td>
                                {destination ? (
                                  <span style={{
                                    padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                                    color: destination.color, background: destination.bg,
                                  }}>
                                    {destination.label}
                                  </span>
                                ) : '—'}
                              </td>
                              <td>{txn.description}</td>
                              <td>{new Date(txn.created_at).toLocaleString()}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  ) : (
                    <p className="empty-msg">No withdrawals yet.</p>
                  )}
                </div>
              );
            })()}
          </>
        )}

        {activeTab === 'settings' && <SettingsPanel profile={profile} onUpdate={loadData} />}
      </main>

      {/* Withdraw OTP Modal */}
      {showWithdrawModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#1f2937', borderRadius: 16, padding: 32, width: '100%', maxWidth: 420, boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 style={{ color: '#fff', fontSize: 18, margin: 0 }}>Confirm Withdrawal</h3>
              <button onClick={() => setShowWithdrawModal(false)} style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 20 }}>×</button>
            </div>

            {/* Fee summary */}
            {withdrawPreview && (
              <div style={{ background: '#111827', borderRadius: 10, padding: '14px 16px', marginBottom: 20, fontSize: 13 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, color: '#9ca3af' }}>
                  <span>Wallet Balance</span><span style={{ color: '#fff', fontWeight: 600 }}>KES {withdrawPreview.balance?.toLocaleString()}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, color: '#9ca3af' }}>
                  <span>Transaction Fee</span><span style={{ color: '#f59e0b', fontWeight: 600 }}>- KES {withdrawPreview.transaction_fee?.toLocaleString()}</span>
                </div>
                <div style={{ borderTop: '1px solid #374151', paddingTop: 8, display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#10b981', fontWeight: 700 }}>You Receive</span><span style={{ color: '#10b981', fontWeight: 700, fontSize: 15 }}>KES {withdrawPreview.you_receive?.toLocaleString()}</span>
                </div>
              </div>
            )}

            <div style={{
              display: 'flex', gap: 8, alignItems: 'flex-start',
              background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)',
              borderRadius: 8, padding: '10px 12px', marginBottom: 16,
            }}>
              <span style={{ fontSize: 15, flexShrink: 0 }}>💡</span>
              <p style={{ margin: 0, fontSize: 12, color: '#d97706', lineHeight: 1.5 }}>
                We recommend <strong>bulk withdrawals</strong> to reduce transaction charges and ensure you remain profitable.
              </p>
            </div>

            {!withdrawOtpSent ? (
              <>
                <p style={{ color: '#9ca3af', fontSize: 13, marginBottom: 16 }}>We'll send a one-time code to your registered phone number to authorize this withdrawal.</p>
                <button
                  onClick={async () => {
                    setWithdrawOtpLoading(true);
                    setWithdrawMsg('');
                    try {
                      const res = await requestWithdrawalOtp();
                      setWithdrawOtpSent(true);
                      setWithdrawMsg(res.data.message || 'OTP sent');
                    } catch (e) {
                      setWithdrawMsg(e.response?.data?.detail || 'Failed to send OTP');
                    }
                    setWithdrawOtpLoading(false);
                  }}
                  disabled={withdrawOtpLoading}
                  style={{ width: '100%', padding: '11px 0', borderRadius: 8, border: 'none', background: 'linear-gradient(135deg,#10b981,#059669)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}
                >
                  {withdrawOtpLoading ? 'Sending...' : 'Send OTP to my phone'}
                </button>
              </>
            ) : (
              <>
                <p style={{ color: '#10b981', fontSize: 13, marginBottom: 12 }}>{withdrawMsg}</p>
                <input
                  type="text"
                  maxLength={6}
                  placeholder="Enter 6-digit OTP"
                  value={withdrawOtp}
                  onChange={e => setWithdrawOtp(e.target.value.replace(/\D/g, ''))}
                  style={{ width: '100%', padding: '11px 14px', borderRadius: 8, border: '1px solid #374151', background: '#111827', color: '#fff', fontSize: 16, letterSpacing: 6, textAlign: 'center', marginBottom: 12, boxSizing: 'border-box' }}
                />
                {withdrawMsg && !withdrawMsg.includes('sent') && (
                  <p style={{ color: '#ef4444', fontSize: 12, marginBottom: 8 }}>{withdrawMsg}</p>
                )}
                <button
                  onClick={async () => {
                    if (withdrawOtp.length !== 6) { setWithdrawMsg('Enter the 6-digit code'); return; }
                    setWithdrawing(true);
                    setWithdrawMsg('');
                    try {
                      const res = await requestWithdrawal(withdrawOtp);
                      setShowWithdrawModal(false);
                      alert(res.data.message || 'Withdrawal sent!');
                      await loadData();
                    } catch (e) {
                      setWithdrawMsg(e.response?.data?.detail || 'Withdrawal failed');
                    }
                    setWithdrawing(false);
                  }}
                  disabled={withdrawing || withdrawOtp.length !== 6}
                  style={{ width: '100%', padding: '11px 0', borderRadius: 8, border: 'none', background: withdrawOtp.length === 6 ? 'linear-gradient(135deg,#10b981,#059669)' : '#374151', color: '#fff', fontWeight: 700, fontSize: 14, cursor: withdrawOtp.length === 6 ? 'pointer' : 'not-allowed', marginBottom: 8 }}
                >
                  {withdrawing ? 'Processing...' : 'Confirm Withdrawal'}
                </button>
                <button onClick={() => { setWithdrawOtpSent(false); setWithdrawOtp(''); setWithdrawMsg(''); }} style={{ width: '100%', padding: '8px 0', borderRadius: 8, border: '1px solid #374151', background: 'none', color: '#9ca3af', fontSize: 13, cursor: 'pointer' }}>
                  Resend OTP
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Deposit Modal */}
      {showDepositModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center',
          justifyContent: 'center', zIndex: 1000, padding: 16,
        }}>
          <div style={{
            background: 'var(--card-bg, #1a1d27)', borderRadius: 16, padding: 32,
            width: '100%', maxWidth: 420, position: 'relative',
            border: '1px solid var(--border, #2a2d3a)',
          }}>
            <button
              onClick={closeDepositModal}
              style={{
                position: 'absolute', top: 12, right: 12, background: 'none',
                border: 'none', color: '#9ca3af', cursor: 'pointer',
              }}
            >
              <X size={20} />
            </button>

            <h2 style={{ color: '#fff', fontSize: 20, marginBottom: 4 }}>Deposit Funds</h2>
            <p style={{ color: '#9ca3af', fontSize: 13, marginBottom: 20 }}>
              Add funds to your SparkP2P wallet for auto-pay buy orders.
            </p>

            {/* Manual Paybill Deposit Info */}
            <div style={{
              background: 'var(--bg, #0f1117)', borderRadius: 10, padding: 16,
              marginBottom: 20, border: '1px solid var(--border, #2a2d3a)',
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#10b981', marginBottom: 10 }}>
                Option 1: Pay via M-Pesa Paybill (Manual)
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px', fontSize: 13 }}>
                <span style={{ color: '#9ca3af' }}>Paybill Number</span>
                <span style={{ color: '#fff', fontWeight: 600 }}>4041355</span>
                <span style={{ color: '#9ca3af' }}>Account Number</span>
                <span style={{ color: '#f59e0b', fontWeight: 600 }}>P2P-T{String(profile?.id || 0).padStart(4, '0')}</span>
              </div>
              <p style={{ fontSize: 11, color: '#6b7280', marginTop: 8, marginBottom: 0 }}>
                Send any amount from M-Pesa, bank app, or agent. Your wallet will be credited automatically.
              </p>
            </div>

            <div style={{ fontSize: 13, fontWeight: 600, color: '#10b981', marginBottom: 10 }}>
              Option 2: Instant Deposit via STK Push
            </div>

            {depositStatus !== 'success' && (
              <>
                <label style={{ color: '#9ca3af', fontSize: 13, display: 'block', marginBottom: 6 }}>
                  Amount (KES)
                </label>
                <input
                  type="number"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  placeholder="e.g. 10000"
                  min="100"
                  max="500000"
                  disabled={depositLoading}
                  style={{
                    width: '100%', padding: '12px 14px', borderRadius: 10,
                    border: '1px solid var(--border, #2a2d3a)',
                    background: 'var(--bg, #0f1117)', color: '#fff', fontSize: 16,
                    marginBottom: 16, boxSizing: 'border-box',
                  }}
                />

                <label style={{ color: '#9ca3af', fontSize: 13, display: 'block', marginBottom: 6 }}>
                  M-Pesa Phone Number
                </label>
                <input
                  type="tel"
                  value={depositPhone}
                  onChange={(e) => setDepositPhone(e.target.value)}
                  placeholder="0712345678"
                  disabled={depositLoading}
                  style={{
                    width: '100%', padding: '12px 14px', borderRadius: 10,
                    border: '1px solid var(--border, #2a2d3a)',
                    background: 'var(--bg, #0f1117)', color: '#fff', fontSize: 16,
                    marginBottom: 20, boxSizing: 'border-box',
                  }}
                />

                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  {[1000, 5000, 10000, 50000].map((amt) => (
                    <button
                      key={amt}
                      onClick={() => setDepositAmount(String(amt))}
                      disabled={depositLoading}
                      style={{
                        flex: 1, padding: '8px 0', borderRadius: 8,
                        border: depositAmount === String(amt) ? '2px solid #10b981' : '1px solid var(--border, #2a2d3a)',
                        background: depositAmount === String(amt) ? 'rgba(16,185,129,0.1)' : 'var(--bg, #0f1117)',
                        color: '#fff', fontSize: 12, cursor: 'pointer',
                      }}
                    >
                      {(amt / 1000)}K
                    </button>
                  ))}
                </div>

                <button
                  onClick={handleDeposit}
                  disabled={depositLoading}
                  style={{
                    width: '100%', padding: '14px 0', borderRadius: 10, border: 'none',
                    background: depositLoading
                      ? '#374151'
                      : 'linear-gradient(135deg, #10b981, #059669)',
                    color: '#fff', fontWeight: 600, fontSize: 15, cursor: depositLoading ? 'default' : 'pointer',
                  }}
                >
                  {depositLoading ? 'Waiting for M-Pesa...' : 'Deposit via M-Pesa'}
                </button>
              </>
            )}

            {depositMessage && (
              <div style={{
                marginTop: 16, padding: 14, borderRadius: 10,
                background: depositStatus === 'success'
                  ? 'rgba(16,185,129,0.1)' : depositStatus === 'failed'
                    ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.1)',
                border: `1px solid ${depositStatus === 'success' ? '#10b981' : depositStatus === 'failed' ? '#ef4444' : '#f59e0b'}`,
                color: depositStatus === 'success' ? '#10b981' : depositStatus === 'failed' ? '#ef4444' : '#f59e0b',
                fontSize: 13, textAlign: 'center',
              }}>
                {depositMessage}
              </div>
            )}

            {depositStatus === 'success' && (
              <button
                onClick={closeDepositModal}
                style={{
                  width: '100%', padding: '14px 0', borderRadius: 10, border: 'none',
                  background: 'linear-gradient(135deg, #10b981, #059669)',
                  color: '#fff', fontWeight: 600, fontSize: 15, cursor: 'pointer', marginTop: 16,
                }}
              >
                Done
              </button>
            )}
          </div>
        </div>
      )}

      {/* Send Money Modal */}
      {showSendModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center',
          justifyContent: 'center', zIndex: 1000, padding: 16,
        }}>
          <div style={{
            background: 'var(--card-bg, #1a1d27)', borderRadius: 16, padding: 32,
            width: '100%', maxWidth: 420, position: 'relative',
            border: '1px solid var(--border, #2a2d3a)',
          }}>
            <button
              onClick={closeSendModal}
              style={{
                position: 'absolute', top: 12, right: 12, background: 'none',
                border: 'none', color: '#9ca3af', cursor: 'pointer',
              }}
            >
              <X size={20} />
            </button>

            <h2 style={{ color: '#fff', fontSize: 20, marginBottom: 4 }}>Send to SparkP2P User</h2>
            <p style={{ color: '#9ca3af', fontSize: 13, marginBottom: 8 }}>
              Transfer funds instantly to another SparkP2P trader.
            </p>
            <div style={{
              display: 'inline-block', padding: '4px 12px', borderRadius: 20,
              background: 'rgba(16,185,129,0.1)', border: '1px solid #10b981',
              color: '#10b981', fontSize: 12, fontWeight: 600, marginBottom: 20,
            }}>
              FREE - no transaction fees
            </div>

            {sendStatus !== 'success' && (
              <>
                <label style={{ color: '#9ca3af', fontSize: 13, display: 'block', marginBottom: 6 }}>
                  Recipient Phone or Email
                </label>
                <input
                  type="text"
                  value={sendRecipient}
                  onChange={(e) => setSendRecipient(e.target.value)}
                  placeholder="0712345678 or user@email.com"
                  disabled={sendLoading}
                  style={{
                    width: '100%', padding: '12px 14px', borderRadius: 10,
                    border: '1px solid var(--border, #2a2d3a)',
                    background: 'var(--bg, #0f1117)', color: '#fff', fontSize: 16,
                    marginBottom: 16, boxSizing: 'border-box',
                  }}
                />

                <label style={{ color: '#9ca3af', fontSize: 13, display: 'block', marginBottom: 6 }}>
                  Amount (KES)
                </label>
                <input
                  type="number"
                  value={sendAmount}
                  onChange={(e) => setSendAmount(e.target.value)}
                  placeholder="e.g. 5000"
                  min="10"
                  max="500000"
                  disabled={sendLoading}
                  style={{
                    width: '100%', padding: '12px 14px', borderRadius: 10,
                    border: '1px solid var(--border, #2a2d3a)',
                    background: 'var(--bg, #0f1117)', color: '#fff', fontSize: 16,
                    marginBottom: 16, boxSizing: 'border-box',
                  }}
                />

                <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                  {[500, 1000, 5000, 10000].map((amt) => (
                    <button
                      key={amt}
                      onClick={() => setSendAmount(String(amt))}
                      disabled={sendLoading}
                      style={{
                        flex: 1, padding: '8px 0', borderRadius: 8,
                        border: sendAmount === String(amt) ? '2px solid #3b82f6' : '1px solid var(--border, #2a2d3a)',
                        background: sendAmount === String(amt) ? 'rgba(59,130,246,0.1)' : 'var(--bg, #0f1117)',
                        color: '#fff', fontSize: 12, cursor: 'pointer',
                      }}
                    >
                      {amt >= 1000 ? `${amt / 1000}K` : amt}
                    </button>
                  ))}
                </div>

                {wallet && (
                  <div style={{
                    fontSize: 12, color: '#9ca3af', marginBottom: 16, textAlign: 'center',
                  }}>
                    Available balance: <span style={{ color: '#f59e0b', fontWeight: 600 }}>KES {wallet.balance?.toLocaleString()}</span>
                  </div>
                )}

                <button
                  onClick={handleSend}
                  disabled={sendLoading}
                  style={{
                    width: '100%', padding: '14px 0', borderRadius: 10, border: 'none',
                    background: sendLoading
                      ? '#374151'
                      : 'linear-gradient(135deg, #3b82f6, #2563eb)',
                    color: '#fff', fontWeight: 600, fontSize: 15, cursor: sendLoading ? 'default' : 'pointer',
                  }}
                >
                  {sendLoading ? 'Sending...' : 'Send Money'}
                </button>
              </>
            )}

            {sendMessage && (
              <div style={{
                marginTop: 16, padding: 14, borderRadius: 10,
                background: sendStatus === 'success'
                  ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
                border: `1px solid ${sendStatus === 'success' ? '#10b981' : '#ef4444'}`,
                color: sendStatus === 'success' ? '#10b981' : '#ef4444',
                fontSize: 13, textAlign: 'center',
              }}>
                {sendMessage}
              </div>
            )}

            {sendStatus === 'success' && (
              <button
                onClick={closeSendModal}
                style={{
                  width: '100%', padding: '14px 0', borderRadius: 10, border: 'none',
                  background: 'linear-gradient(135deg, #10b981, #059669)',
                  color: '#fff', fontWeight: 600, fontSize: 15, cursor: 'pointer', marginTop: 16,
                }}
              >
                Done
              </button>
            )}
          </div>
        </div>
      )}
      <SupportChat forceOpen={openSupportChat} onOpen={() => setOpenSupportChat(false)} />
    </div>
  );
}
