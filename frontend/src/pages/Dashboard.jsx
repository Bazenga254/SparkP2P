import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { getProfile, getWallet, getOrderStats, getOrders, requestWithdrawal, getWalletTransactions } from '../services/api';
import { useNavigate } from 'react-router-dom';
import { Wallet, TrendingUp, ArrowDownCircle, ArrowUpCircle, RefreshCw, LogOut, Settings, Clock, Shield } from 'lucide-react';
import SettingsPanel from '../components/SettingsPanel';

export default function Dashboard() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [profile, setProfile] = useState(null);
  const [wallet, setWallet] = useState(null);
  const [stats, setStats] = useState(null);
  const [orders, setOrders] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [activeTab, setActiveTab] = useState('overview');
  const [refreshing, setRefreshing] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);

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
      ]);
      if (results[0].status === 'fulfilled') setProfile(results[0].value.data);
      if (results[1].status === 'fulfilled') setWallet(results[1].value.data);
      if (results[2].status === 'fulfilled') setStats(results[2].value.data);
      if (results[3].status === 'fulfilled') setOrders(results[3].value.data);
      if (results[4].status === 'fulfilled') setTransactions(results[4].value.data);
    } catch (err) {
      console.error('Failed to load data:', err);
    }
    setRefreshing(false);
  };

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

  // Redirect to onboarding if not complete (only for traders, not admin/employees)
  useEffect(() => {
    if (profile && profile.onboarding_complete === false && profile.role === 'trader') {
      navigate('/onboarding');
    }
  }, [profile]);

  const handleWithdraw = async () => {
    if (!wallet || wallet.balance <= 0) return;
    if (!confirm(`Withdraw KES ${wallet.balance.toLocaleString()} to your account?`)) return;

    setWithdrawing(true);
    try {
      await requestWithdrawal();
      await loadData();
    } catch (err) {
      alert(err.response?.data?.detail || 'Withdrawal failed');
    }
    setWithdrawing(false);
  };

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
      <header className="dash-header">
        <div className="dash-header-left">
          <img src="/logo.png" alt="SparkP2P" className="header-logo" />
          <h1>SparkP2P</h1>
          <span className={`status-badge ${profile?.binance_connected ? 'connected' : 'disconnected'}`}>
            {profile?.binance_connected ? 'Binance Connected' : 'Binance Disconnected'}
          </span>
        </div>
        <div className="dash-header-right">
          <span className="user-name">{user?.full_name}</span>
          <span className="tier-badge">{profile?.tier || 'standard'}</span>
          {(profile?.role === 'employee' || profile?.is_admin) && (
            <button className="icon-btn" onClick={() => navigate(profile?.is_admin ? '/admin' : '/employee')} title={profile?.is_admin ? 'Admin' : 'Employee Portal'}>
              <Shield size={18} />
            </button>
          )}
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
      </nav>

      <main className="dash-content">
        {/* Subscription Banner */}
        {profile && !profile.subscription_plan && (
          <div className="subscription-banner">
            <div className="subscription-banner-text">
              <strong>No active subscription.</strong> Subscribe to start automating your trades.
            </div>
            <button className="subscription-banner-btn" onClick={() => navigate('/subscribe')}>
              Subscribe Now
            </button>
          </div>
        )}

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
                </div>
                <div className="wallet-mini-amount">KES {wallet?.balance?.toLocaleString() || '0'}</div>
                <div className="wallet-mini-stats">
                  <span>Earned: KES {wallet?.total_earned?.toLocaleString() || '0'}</span>
                  <span>Fees: KES {wallet?.total_fees_paid?.toLocaleString() || '0'}</span>
                </div>
                <button
                  className="withdraw-btn-mini"
                  onClick={handleWithdraw}
                  disabled={withdrawing || !wallet || wallet.balance <= 0}
                >
                  {withdrawing ? 'Processing...' : 'Withdraw'}
                </button>
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
          <div className="card">
            <h3>Wallet Transactions</h3>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Amount</th>
                  <th>Balance After</th>
                  <th>Description</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((txn) => (
                  <tr key={txn.id}>
                    <td>{txn.type.replace('_', ' ')}</td>
                    <td className={txn.amount >= 0 ? 'positive' : 'negative'}>
                      {txn.amount >= 0 ? '+' : ''}{txn.amount.toLocaleString()}
                    </td>
                    <td>KES {txn.balance_after.toLocaleString()}</td>
                    <td>{txn.description}</td>
                    <td>{new Date(txn.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'settings' && <SettingsPanel profile={profile} onUpdate={loadData} />}
      </main>
    </div>
  );
}
