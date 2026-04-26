import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import api, { getProfile, getWallet, getOrderStats, getOrders, requestWithdrawal, requestWithdrawalOtp, getWalletTransactions, getSessionHealth, getBinanceAccountData, getMarketPrices, getMyAdPrices, getTodayStats, initiateDeposit, getDepositHistory, checkDepositStatus, internalTransfer, getSystemStatus } from '../services/api';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Wallet, TrendingUp, TrendingDown, ArrowDownCircle, ArrowUpCircle, ArrowDown, ArrowUp, RefreshCw, LogOut, Settings, Clock, Shield, Plus, X, Bell, Copy, CreditCard, Eye, EyeOff, MessageSquare, Activity, BarChart2, DollarSign, Repeat } from 'lucide-react';
import SettingsPanel from '../components/SettingsPanel';
import SupportChat from '../components/SupportChat';

const B2C_FEES = [
  [1000,9],[1500,14],[2500,19],[3500,24],[5000,33],[7500,40],[10000,46],
  [15000,55],[20000,60],[25000,65],[30000,70],[35000,80],[40000,96],[45000,100],[50000,105],[150000,105],
];
function mpesaB2CFee(amount) {
  for (const [threshold, fee] of B2C_FEES) { if (amount <= threshold) return fee; }
  return 105;
}
function getWithdrawalFee(method, amount) {
  if (amount <= 0) return 0;
  if (method === 'mpesa') return mpesaB2CFee(amount) + 25;
  // bank_paybill, bank, till, paybill — 0.05% flat
  return Math.round(amount * 0.0005 * 100) / 100;
}
const fmtKES = (n) => 'KES ' + Math.abs(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
const fmtKESFee = (n) => 'KES ' + Math.abs(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function SpreadCalculator() {
  const [buyPrice, setBuyPrice] = useState('130.00');
  const [sellPrice, setSellPrice] = useState('130.50');
  const [volume, setVolume] = useState('500000');
  const [withdrawMethod, setWithdrawMethod] = useState('mpesa');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [autoLoaded, setAutoLoaded] = useState(false);
  const [adSource, setAdSource] = useState(''); // 'ads' | 'market' | ''
  const [missingAd, setMissingAd] = useState(''); // 'buy' | 'sell' | ''
  const [todayStats, setTodayStats] = useState(null); // 24h live stats from backend
  const [statsLoading, setStatsLoading] = useState(true);

  useEffect(() => {
    const fetchPrices = async () => {
      // First try trader's own ads
      try {
        const adRes = await getMyAdPrices();
        const ad = adRes.data;
        if (ad.connected && (ad.buy || ad.sell)) {
          if (ad.buy) setBuyPrice(String(ad.buy));
          if (ad.sell) setSellPrice(String(ad.sell));
          setAutoLoaded(true);
          setAdSource('ads');
          setMissingAd(!ad.buy ? 'buy' : !ad.sell ? 'sell' : '');
          return;
        }
      } catch (e) {}

      // Fallback to market prices
      try {
        const res = await getMarketPrices();
        const d = res.data;
        if (d.best_buy > 0 && d.best_sell > 0) {
          setBuyPrice(String(d.best_buy));
          setSellPrice(String(d.best_sell));
          setAutoLoaded(true);
          setAdSource('market');
        }
      } catch (e) {}
    };
    fetchPrices();
    const priceInterval = setInterval(fetchPrices, 60000);

    // Live update when the desktop bot pushes fresh Vision-scraped prices
    const onAdPricesUpdated = (e) => {
      const { buy: b, sell: s } = e.detail || {};
      if (b && b > 50) { setBuyPrice(String(b)); setAutoLoaded(true); setAdSource('ads'); }
      if (s && s > 50) { setSellPrice(String(s)); setAutoLoaded(true); setAdSource('ads'); }
    };
    window.addEventListener('ad-prices-updated', onAdPricesUpdated);

    return () => {
      clearInterval(priceInterval);
      window.removeEventListener('ad-prices-updated', onAdPricesUpdated);
    };
  }, []);

  // Fetch real 24h stats, reset at midnight EAT
  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await getTodayStats();
        setTodayStats(res.data);
      } catch (e) {
        setTodayStats(null);
      } finally {
        setStatsLoading(false);
      }
    };
    fetchStats();

    // Refresh every 2 minutes so the dashboard stays live
    const statsInterval = setInterval(fetchStats, 120000);

    // Also schedule a refresh right after the next midnight EAT (UTC+3)
    const nowEAT = new Date(Date.now() + 3 * 3600 * 1000);
    const msToMidnightEAT =
      (24 * 3600 - (nowEAT.getUTCHours() * 3600 + nowEAT.getUTCMinutes() * 60 + nowEAT.getUTCSeconds())) * 1000;
    const midnightTimer = setTimeout(fetchStats, msToMidnightEAT + 2000); // +2s buffer

    return () => {
      clearInterval(statsInterval);
      clearTimeout(midnightTimer);
    };
  }, []);

  const buy = parseFloat(buyPrice) || 0;
  const sell = parseFloat(sellPrice) || 0;
  const vol = parseFloat(volume) || 0;
  const spread = sell - buy;
  const spreadPct = buy > 0 ? (spread / buy) * 100 : 0;
  const usdtAmount = buy > 0 ? vol / buy : 0;
  const grossProfit = usdtAmount * spread;
  const profitable = spread > 0;

  // Cash-out analysis — use real 24h gross profit as base, fall back to simulated spread profit
  const realProfit = todayStats?.gross_profit ?? null;
  const baseProfit = realProfit !== null ? realProfit : grossProfit;
  const wdAmt = parseFloat(withdrawAmount) || (baseProfit > 0 ? baseProfit : vol);
  const wdFee = getWithdrawalFee(withdrawMethod, wdAmt);
  const wdReceived = wdAmt - wdFee;
  const netProfit = baseProfit - wdFee;
  const netProfitable = netProfit > 0;
  const netPct = baseProfit > 0 ? (netProfit / baseProfit) * 100 : 0;
  const feePct = wdAmt > 0 ? (wdFee / wdAmt) * 100 : 0;
  // Break-even sell price needed to cover withdrawal fee
  const breakEvenSpreadKES = usdtAmount > 0 ? wdFee / usdtAmount : 0;
  const breakEvenSell = buy + breakEvenSpreadKES;
  const breakEvenPct = buy > 0 ? (breakEvenSpreadKES / buy) * 100 : 0;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header">
        <TrendingUp size={20} />
        <h3>Spread Calculator</h3>
        {autoLoaded && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: '#10b981', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981', animation: 'pulse-green 1.5s ease-in-out infinite' }} />
            {adSource === 'ads' ? 'Auto-filled from your ads' : 'Live market prices'}
            {missingAd && (
              <span style={{ color: '#f59e0b', marginLeft: 4 }}>
                ⚠ No {missingAd} ad found — enter {missingAd} price manually
              </span>
            )}
          </span>
        )}
      </div>

      {/* Inputs */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, padding: '12px 0 0' }}>
        <div>
          <label style={{ fontSize: 12, color: '#9ca3af', display: 'block', marginBottom: 4 }}>Buy Price (KSh/USDT)</label>
          <input type="number" step="0.01" placeholder="130.23" value={buyPrice} onChange={(e) => setBuyPrice(e.target.value)}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 14 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, color: '#9ca3af', display: 'block', marginBottom: 4 }}>Sell Price (KSh/USDT)</label>
          <input type="number" step="0.01" placeholder="130.74" value={sellPrice} onChange={(e) => setSellPrice(e.target.value)}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 14 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, color: '#9ca3af', display: 'block', marginBottom: 4 }}>
            Simulation Size (KES)
            <span style={{ marginLeft: 5, fontSize: 10, color: '#6b7280', fontWeight: 400 }}>— per trade estimate</span>
          </label>
          <input type="number" step="1000" placeholder="500000" value={volume} onChange={(e) => setVolume(e.target.value)}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 14 }} />
        </div>
      </div>

      {/* Spread % badge */}
      {buy > 0 && sell > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, margin: '12px 0 4px' }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            background: profitable ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)',
            border: `1px solid ${profitable ? '#10b981' : '#ef4444'}`,
            borderRadius: 20, padding: '4px 14px',
          }}>
            <span style={{ fontSize: 12, color: '#9ca3af' }}>Buy</span>
            <span style={{ fontWeight: 700, color: '#fff', fontSize: 14 }}>KSh {buy.toFixed(2)}</span>
            <span style={{ fontSize: 12, color: '#6b7280' }}>→</span>
            <span style={{ fontSize: 12, color: '#9ca3af' }}>Sell</span>
            <span style={{ fontWeight: 700, color: '#fff', fontSize: 14 }}>KSh {sell.toFixed(2)}</span>
            <span style={{ fontSize: 12, color: '#6b7280' }}>|</span>
            <span style={{ fontWeight: 800, fontSize: 15, color: profitable ? '#10b981' : '#ef4444' }}>
              {spreadPct >= 0 ? '+' : ''}{spreadPct.toFixed(3)}% margin
            </span>
          </div>
          {!profitable && (
            <span style={{ fontSize: 12, color: '#ef4444' }}>⚠ Sell below buy — you'd lose money</span>
          )}
        </div>
      )}

      {/* Stats row — left card is simulation, right 3 are real 24h data */}
      {buy > 0 && sell > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginTop: 10 }}>

          {/* Spread per USDT — calculated from inputs */}
          <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: '#9ca3af' }}>Spread per USDT</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: profitable ? '#10b981' : '#ef4444' }}>KSh {spread.toFixed(2)}</div>
            <div style={{ fontSize: 11, color: '#6b7280' }}>{spreadPct.toFixed(3)}%</div>
          </div>

          {/* USDT Traded — real 24h */}
          <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', border: '1px solid var(--border)', position: 'relative' }}>
            <div style={{ fontSize: 11, color: '#9ca3af', display: 'flex', alignItems: 'center', gap: 4 }}>
              USDT Traded
              <span style={{ fontSize: 9, background: 'rgba(16,185,129,0.15)', color: '#10b981', borderRadius: 4, padding: '1px 5px' }}>24h</span>
            </div>
            {statsLoading ? (
              <div style={{ fontSize: 18, fontWeight: 700, color: '#6b7280' }}>—</div>
            ) : todayStats ? (
              <>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#f59e0b' }}>{todayStats.usdt_traded.toFixed(2)}</div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>KES {todayStats.kes_volume.toLocaleString(undefined, { maximumFractionDigits: 0 })} vol</div>
              </>
            ) : (
              <div style={{ fontSize: 14, color: '#6b7280' }}>N/A</div>
            )}
          </div>

          {/* Gross Profit — real 24h */}
          <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: '#9ca3af', display: 'flex', alignItems: 'center', gap: 4 }}>
              Gross Profit
              <span style={{ fontSize: 9, background: 'rgba(16,185,129,0.15)', color: '#10b981', borderRadius: 4, padding: '1px 5px' }}>24h</span>
            </div>
            {statsLoading ? (
              <div style={{ fontSize: 18, fontWeight: 700, color: '#6b7280' }}>—</div>
            ) : todayStats ? (
              <>
                <div style={{ fontSize: 18, fontWeight: 700, color: todayStats.gross_profit >= 0 ? '#10b981' : '#ef4444' }}>
                  {fmtKES(todayStats.gross_profit)}
                </div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>from spread</div>
              </>
            ) : (
              <div style={{ fontSize: 14, color: '#6b7280' }}>N/A</div>
            )}
          </div>

          {/* Trades Today — real 24h */}
          <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: '#9ca3af', display: 'flex', alignItems: 'center', gap: 4 }}>
              Trades Today
              <span style={{ fontSize: 9, background: 'rgba(16,185,129,0.15)', color: '#10b981', borderRadius: 4, padding: '1px 5px' }}>24h</span>
            </div>
            {statsLoading ? (
              <div style={{ fontSize: 18, fontWeight: 700, color: '#6b7280' }}>—</div>
            ) : todayStats ? (
              <>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#a78bfa' }}>{todayStats.trades_count}</div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>resets midnight EAT</div>
              </>
            ) : (
              <div style={{ fontSize: 14, color: '#6b7280' }}>N/A</div>
            )}
          </div>

        </div>
      )}

      {/* Cash-out analysis */}
      {buy > 0 && sell > 0 && profitable && (
        <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 2 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 1 }}>
              Cash-Out Analysis
            </div>
            <div style={{ fontSize: 11, color: realProfit !== null ? '#10b981' : '#6b7280' }}>
              {realProfit !== null ? '● Live — based on today\'s actual trades' : '○ Simulated — no trades yet today'}
            </div>
          </div>
          <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 12 }}>
            {realProfit !== null
              ? `Today's gross profit from ${todayStats.trades_count} trade${todayStats.trades_count !== 1 ? 's' : ''} (${fmtKES(todayStats.kes_volume)} volume) — minus your withdrawal fee.`
              : 'Set your buy/sell prices above to see a profit estimate.'}
          </div>

          {/* Withdrawal method selector */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
            <div>
              <label style={{ fontSize: 12, color: '#9ca3af', display: 'block', marginBottom: 4 }}>Withdrawal Method</label>
              <select value={withdrawMethod} onChange={(e) => setWithdrawMethod(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 14 }}>
                <option value="mpesa">M-Pesa</option>
                <option value="bank">I&M Bank</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, color: '#9ca3af', display: 'block', marginBottom: 4 }}>
                {realProfit !== null ? 'Profit to Withdraw (KES)' : 'Amount to Withdraw (KES)'}
              </label>
              <input type="number" step="100"
                placeholder={baseProfit > 0 ? baseProfit.toFixed(0) : vol.toLocaleString()}
                value={withdrawAmount} onChange={(e) => setWithdrawAmount(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 14 }} />
            </div>
          </div>

          {/* Result cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>

            {/* Card 1 — Gross Profit */}
            <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, color: '#9ca3af' }}>{realProfit !== null ? 'Today\'s Gross Profit' : 'Est. Gross Profit'}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#10b981' }}>+ {fmtKESFee(baseProfit)}</div>
              <div style={{ fontSize: 11, color: '#6b7280' }}>{realProfit !== null ? 'from completed trades' : 'from spread × volume'}</div>
            </div>

            {/* Card 2 — Withdrawal Fee */}
            <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, color: '#9ca3af' }}>Withdrawal Fee</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#ef4444' }}>− {fmtKESFee(wdFee)}</div>
              <div style={{ fontSize: 11, color: '#6b7280' }}>
                {feePct > 0 ? `${feePct.toFixed(3)}% of amount` : withdrawMethod === 'mpesa' ? 'tiered rate' : '0.05% flat'}
              </div>
            </div>

            {/* Card 3 — Net Profit after fees */}
            <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', border: `1px solid ${netProfitable ? '#10b981' : '#ef4444'}` }}>
              <div style={{ fontSize: 11, color: '#9ca3af' }}>Net Profit (after fees)</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: netProfitable ? '#10b981' : '#ef4444' }}>
                {netProfitable ? '+' : '−'} {fmtKESFee(Math.abs(netProfit))}
              </div>
              <div style={{ fontSize: 11, color: netProfitable ? '#10b981' : '#ef4444' }}>
                {netPct >= 0 ? '+' : ''}{netPct.toFixed(2)}% of gross profit
              </div>
            </div>

            {/* Card 4 — Break-even Sell */}
            <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, color: '#9ca3af' }}>Min. Sell Price</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#f59e0b' }}>KSh {breakEvenSell.toFixed(2)}</div>
              <div style={{ fontSize: 11, color: '#6b7280' }}>to cover fees ({breakEvenPct.toFixed(3)}% margin)</div>
            </div>

          </div>

          {/* Summary banner */}
          {baseProfit > 0 && (
            <div style={{
              marginTop: 12, padding: '10px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600,
              background: netProfitable ? 'rgba(16,185,129,0.10)' : 'rgba(239,68,68,0.10)',
              border: `1px solid ${netProfitable ? '#10b981' : '#ef4444'}`,
              color: netProfitable ? '#10b981' : '#ef4444',
            }}>
              {netProfitable
                ? `✓ You keep ${fmtKES(netProfit)} after ${withdrawMethod === 'mpesa' ? 'M-Pesa' : 'I&M Bank'} fees`
                : `✗ Fees exceed profit by ${fmtKES(Math.abs(netProfit))} — increase your spread`}
            </div>
          )}
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
  const [scanStep, setScanStep] = useState(0);
  const scanPollRef = useRef(null);
  const scanStepRef = useRef(null);
  const [appVersion, setAppVersion] = useState(null);
  const [profile, setProfile] = useState(null);
  const [wallet, setWallet] = useState(null);
  const [stats, setStats] = useState(null);
  const [orders, setOrders] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [withdrawalTxns, setWithdrawalTxns] = useState([]);
  const [expandedWithdrawals, setExpandedWithdrawals] = useState({});
  const [depositPage, setDepositPage] = useState(1);
  const [withdrawalPage, setWithdrawalPage] = useState(1);
  const [activeTab, setActiveTab] = useState('overview');
  const [botLogs, setBotLogs] = useState([]);
  const logsEndRef = useRef(null);
  const [txnTab, setTxnTab] = useState('deposits');
  const [refreshing, setRefreshing] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [showBalance, setShowBalance] = useState(false);
  const [showWithdrawModal, setShowWithdrawModal] = useState(false);
  const [withdrawPreview, setWithdrawPreview] = useState(null);
  const [withdrawCustomAmount, setWithdrawCustomAmount] = useState('');
  const [withdrawOtp, setWithdrawOtp] = useState('');
  const [withdrawOtpSent, setWithdrawOtpSent] = useState(false);
  const [withdrawOtpLoading, setWithdrawOtpLoading] = useState(false);
  const [withdrawMsg, setWithdrawMsg] = useState('');
  const [withdrawAmtErr, setWithdrawAmtErr] = useState('');
  const [withdrawStatus, setWithdrawStatus] = useState(null); // null | 'processing' | 'succeeded'
  const withdrawPollRef = useRef(null);
  const [systemStatus, setSystemStatus] = useState(null);
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
  const [updateVersion, setUpdateVersion] = useState(null); // set when desktop update is ready

  // Listen for update-ready event from Electron main process
  useEffect(() => {
    const handler = (e) => setUpdateVersion(e.detail?.version || 'latest');
    window.addEventListener('sparkp2p-update-ready', handler);
    return () => window.removeEventListener('sparkp2p-update-ready', handler);
  }, []);

  const loadData = async () => {
    if (!localStorage.getItem('token')) return;
    setRefreshing(true);
    try {
      const results = await Promise.allSettled([
        getProfile(),
        getWallet(),
        getOrderStats(),
        getOrders({ limit: 20 }),
        getWalletTransactions(50, 'positive'),
        getSessionHealth(),
        getBinanceAccountData(),
        getWalletTransactions(100, 'negative'),
      ]);
      if (results[0].status === 'fulfilled') setProfile(results[0].value.data);
      if (results[1].status === 'fulfilled') setWallet(results[1].value.data);
      if (results[2].status === 'fulfilled') setStats(results[2].value.data);
      if (results[3].status === 'fulfilled') setOrders(results[3].value.data);
      if (results[4].status === 'fulfilled') setTransactions(results[4].value.data);
      if (results[5].status === 'fulfilled') setSessionHealth(results[5].value.data);
      if (results[6].status === 'fulfilled') setBinanceData(results[6].value.data);
      if (results[7].status === 'fulfilled') setWithdrawalTxns(results[7].value.data);

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

  // Refresh profile when desktop app signals Binance or I&M connected
  useEffect(() => {
    const handler = async () => {
      try {
        const res = await getProfile();
        setProfile(res.data);
      } catch (_) {}
    };
    window.addEventListener('binance-connected', handler);
    window.addEventListener('im-connected', handler);
    window.addEventListener('gmail-connected', handler);
    return () => {
      window.removeEventListener('binance-connected', handler);
      window.removeEventListener('im-connected', handler);
      window.removeEventListener('gmail-connected', handler);
    };
  }, []);

  const [setupMissing, setSetupMissing] = useState([]);
  const [setupDismissed, setSetupDismissed] = useState(false);

  // Listen for setup-incomplete / setup-complete events from desktop app
  useEffect(() => {
    const onIncomplete = (e) => { setSetupMissing(e.detail?.missing || []); setSetupDismissed(false); };
    const onComplete = () => setSetupMissing([]);
    window.addEventListener('setup-incomplete', onIncomplete);
    window.addEventListener('setup-complete', onComplete);
    return () => {
      window.removeEventListener('setup-incomplete', onIncomplete);
      window.removeEventListener('setup-complete', onComplete);
    };
  }, []);

  // Also derive missing connections directly from profile (catches page refresh)
  const missingConnections = (() => {
    if (!profile) return [];
    const m = [];
    if (!profile.binance_connected) m.push('Binance');
    if (!profile.gmail_connected) m.push('Gmail');
    if (!profile.im_connected) m.push('I&M Bank');
    return m;
  })();
  const showSetupBanner = (setupMissing.length > 0 || missingConnections.length > 0) && !setupDismissed;
  const bannerMissing = setupMissing.length > 0 ? setupMissing : missingConnections;

  useEffect(() => {
    // Fetch desktop app version from local bot server
    fetch('http://127.0.0.1:9223/status').then(r => r.json()).then(d => { if (d.version) setAppVersion(d.version); }).catch(() => {});
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

  // Fast wallet poll every 5s for real-time KES balance updates
  useEffect(() => {
    const walletPoll = setInterval(async () => {
      if (!localStorage.getItem('token')) return;
      try {
        const res = await getWallet();
        if (res.data) {
          setWallet(prev => {
            if (prev && res.data.balance !== prev.balance) {
              // Balance changed — also refresh transactions
              getWalletTransactions(50, 'positive').then(r => { if (r.data) setTransactions(r.data); }).catch(() => {});
              getWalletTransactions(100, 'negative').then(r => { if (r.data) setWithdrawalTxns(r.data); }).catch(() => {});
            }
            return res.data;
          });
        }
      } catch (e) {}
    }, 5000);
    return () => clearInterval(walletPoll);
  }, []);

  // Poll Binance account data (wallet balances) every 30s so the display stays current
  useEffect(() => {
    const binancePoll = setInterval(async () => {
      if (!localStorage.getItem('token')) return;
      try {
        const res = await getBinanceAccountData();
        if (res.data) setBinanceData(res.data);
      } catch (e) {}
    }, 30000);
    return () => clearInterval(binancePoll);
  }, []);

  // Redirect to onboarding if not complete (only for traders, not admin/employees)
  useEffect(() => {
    if (profile && profile.onboarding_complete === false && profile.role === 'trader') {
      navigate('/onboarding');
    }
  }, [profile]);

  // Recompute withdrawal amount error whenever amount or preview changes
  useEffect(() => {
    if (!withdrawPreview) { setWithdrawAmtErr(''); return; }
    const balance = withdrawPreview.balance ?? 0;
    const minWd = withdrawPreview.min_withdrawal ?? 1000;
    const customAmt = parseFloat(withdrawCustomAmount) || 0;
    const clampedAmt = Math.min(customAmt, balance);
    const remainingAfter = balance - clampedAmt;
    const wouldStrand = clampedAmt > 0 && clampedAmt < balance && remainingAfter > 0 && remainingAfter < minWd;
    if (customAmt > balance) setWithdrawAmtErr(`Max KES ${balance.toLocaleString()}`);
    else if (customAmt > 0 && customAmt < minWd) setWithdrawAmtErr(`Min KES ${minWd.toLocaleString()}`);
    else if (wouldStrand) setWithdrawAmtErr(`Withdrawing KES ${clampedAmt.toLocaleString()} would leave KES ${remainingAfter.toLocaleString()} which can't be withdrawn later. Withdraw the full KES ${balance.toLocaleString()} instead.`);
    else setWithdrawAmtErr('');
  }, [withdrawCustomAmount, withdrawPreview]);

  // Scanning overlay: poll until bot confirms Binance connection
  const SCAN_STEPS = [
    'Connecting to your Binance account...',
    'Loading your wallet balances...',
    'Confirming your Binance identity...',
    'Almost ready...',
  ];
  useEffect(() => {
    if (!scanning) return;
    setSearchParams({}, { replace: true });

    // Cycle through status messages every 8 seconds
    scanStepRef.current = setInterval(() => {
      setScanStep(s => Math.min(s + 1, SCAN_STEPS.length - 1));
    }, 8000);

    // Poll profile until bot has synced and confirmed Binance username
    scanPollRef.current = setInterval(async () => {
      try {
        const res = await getProfile();
        const { last_extension_sync } = res.data;
        if (last_extension_sync) {
          clearInterval(scanPollRef.current);
          clearInterval(scanStepRef.current);
          setScanning(false);
        }
      } catch (_) {}
    }, 3000);

    // Safety timeout: remove overlay after 2 minutes regardless
    const timeout = setTimeout(() => {
      clearInterval(scanPollRef.current);
      clearInterval(scanStepRef.current);
      setScanning(false);
    }, 120000);

    return () => {
      clearInterval(scanPollRef.current);
      clearInterval(scanStepRef.current);
      clearTimeout(timeout);
    };
  }, [scanning]);

  // Bot activity logs — only available in Electron desktop app
  useEffect(() => {
    if (!window.sparkp2p?.getLogs) return;
    window.sparkp2p.getLogs().then(logs => setBotLogs(logs || []));
    window.sparkp2p.onLog(entry => {
      setBotLogs(prev => {
        const next = [...prev, entry];
        return next.length > 400 ? next.slice(-400) : next;
      });
    });
  }, []);

  useEffect(() => {
    if (activeTab === 'logs') logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [botLogs, activeTab]);

  const handleWithdraw = async () => {
    if (!wallet || wallet.balance <= 0) return;

    // Block if there's already a pending withdrawal being processed
    if (wallet.pending_withdrawal) {
      alert(`You already have a withdrawal of ${fmtKES(wallet.pending_withdrawal_amount)} being processed. Please wait for it to complete before requesting another.`);
      return;
    }

    // Get fee preview first
    try {
      const preview = await api.get('/traders/wallet/withdraw/preview');
      const p = preview.data;

      if (!p.can_withdraw) {
        if (p.cooldown_active) {
          alert(`Your payment method was recently changed. Withdrawals available in ${p.cooldown_hours} hours.`);
        } else {
          alert(p.reason || 'Cannot withdraw at this time.');
        }
        return;
      }

      setWithdrawPreview(p);
      setWithdrawCustomAmount(String(Math.round((p.balance ?? 0) * 100) / 100));
      setWithdrawOtp('');
      setWithdrawOtpSent(false);
      setWithdrawMsg('');
      // Fetch system health status before showing modal
      try {
        const sysRes = await getSystemStatus();
        setSystemStatus(sysRes.data);
      } catch (_) {
        setSystemStatus(null);
      }
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
      releasing: '#a78bfa',
      released: '#10b981',
      completed: '#10b981',
      disputed: '#ef4444',
      expired: '#f97316',
      cancelled: '#6b7280',
    };
    return colors[status] || '#6b7280';
  };

  // Live clock — ticks every second so active order timers update in real time
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const formatDuration = (seconds) => {
    if (seconds < 0) seconds = 0;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  // Active statuses — timer keeps running until the order ends
  const ACTIVE_STATUSES = new Set(['pending', 'payment_received', 'releasing', 'payment_sent', 'disputed']);

  const getOrderDuration = (order) => {
    const start = new Date(order.created_at).getTime();
    // Released/completed — static duration to release time
    if (order.released_at) {
      return { secs: Math.floor((new Date(order.released_at) - start) / 1000), live: false, overdue: false };
    }
    // Cancelled — static duration to cancellation time (accurate if cancelled_at exists)
    if (order.status === 'cancelled') {
      const end = order.cancelled_at ? new Date(order.cancelled_at).getTime() : now;
      return { secs: Math.floor((end - start) / 1000), live: false, overdue: false };
    }
    // Active or expired-but-still-running — live elapsed time
    const secs = Math.floor((now - start) / 1000);
    const overdue = order.status === 'expired';
    const live = ACTIVE_STATUSES.has(order.status) || overdue;
    return { secs, live, overdue };
  };

  return (
    <div className="dashboard" style={showSetupBanner ? { paddingTop: 62 } : {}}>
      {/* Binance initial scan overlay */}
      {scanning && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: '#000',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          gap: 32,
        }}>
          <div style={{
            width: 56, height: 56,
            border: '3px solid rgba(255,255,255,0.08)',
            borderTop: '3px solid rgba(255,255,255,0.65)',
            borderRadius: '50%',
            animation: 'spin 0.9s linear infinite',
          }} />
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 15, color: 'rgba(255,255,255,0.75)', fontWeight: 500, letterSpacing: 0.2 }}>
              {SCAN_STEPS[scanStep]}
            </div>
          </div>
        </div>
      )}

      {/* Setup incomplete banner */}
      {showSetupBanner && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
          background: '#1c0808', borderBottom: '2px solid #ef4444',
          padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 14,
        }}>
          <span style={{ fontSize: 22 }}>⚠️</span>
          <div style={{ flex: 1 }}>
            <div style={{ color: '#f87171', fontWeight: 700, fontSize: 14 }}>
              Bot Paused — Setup Incomplete
            </div>
            <div style={{ color: '#fca5a5', fontSize: 13, marginTop: 2 }}>
              The following must be connected before trading can start:{' '}
              {bannerMissing.map((m, i) => (
                <span key={m}>
                  <strong style={{ color: '#fff' }}>{m}</strong>
                  {i < bannerMissing.length - 1 ? ', ' : ''}
                </span>
              ))}.
              {' '}Go to <strong>Settings → Binance tab</strong> to connect them.
            </div>
          </div>
          <button
            onClick={() => setActiveTab('settings')}
            style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#ef4444', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' }}
          >
            Go to Settings
          </button>
          <button
            onClick={() => setSetupDismissed(true)}
            style={{ background: 'transparent', border: '1px solid #ef4444', color: '#f87171', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 13 }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* App update ready banner */}
      {updateVersion && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 10000,
          background: '#0c2a1a', borderBottom: '2px solid #10b981',
          padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 14,
        }}>
          <span style={{ fontSize: 20 }}>🚀</span>
          <div style={{ flex: 1, color: '#6ee7b7', fontSize: 13 }}>
            <strong style={{ color: '#10b981' }}>SparkP2P v{updateVersion} is ready.</strong>
            {' '}Restart the app now to install the update.
          </div>
          <button
            onClick={() => window.sparkp2p?.restartApp?.()}
            style={{ padding: '7px 16px', borderRadius: 8, border: 'none', background: '#10b981', color: '#000', fontWeight: 700, cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' }}
          >
            Restart & Update
          </button>
          <button
            onClick={() => setUpdateVersion(null)}
            style={{ background: 'transparent', border: '1px solid #10b981', color: '#6ee7b7', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 13 }}
          >
            Later
          </button>
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
          {appVersion && (
            <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 500, letterSpacing: '0.02em', marginLeft: -2, marginTop: 2 }}>
              v{appVersion}
            </span>
          )}
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
        {['overview', 'orders', 'transactions', 'logs', 'settings'].map((tab) => (
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
                  <span style={{ flex: 1, fontWeight: 600, fontSize: 13, fontFamily: 'monospace' }}>P2PT{String(profile?.id || 0).padStart(4, '0')}</span>
                  <button onClick={() => { navigator.clipboard.writeText(`P2PT${String(profile?.id || 0).padStart(4, '0')}`); setCopied('account'); setTimeout(() => setCopied(''), 2000); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: copied === 'account' ? '#10b981' : '#9ca3af', padding: 2 }}>
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
                    disabled={withdrawing || !wallet || wallet.balance <= 0 || wallet.pending_withdrawal}
                    title={wallet?.pending_withdrawal ? `Withdrawal of ${fmtKES(wallet.pending_withdrawal_amount)} is being processed` : ''}
                    style={wallet?.pending_withdrawal ? { opacity: 0.6, cursor: 'not-allowed' } : {}}
                  >
                    {withdrawing ? 'Processing...' : wallet?.pending_withdrawal ? '⏳ Pending...' : 'Withdraw'}
                  </button>
                </div>
              </div>
            </div>

            {/* Row 2: Quick Stats */}
            <div className="overview-stats-row">
              <div className="mini-stat-card">
                <Activity size={18} style={{ color: '#f59e0b', marginBottom: 4 }} />
                <span className="mini-stat-value">{stats?.today?.total_trades || 0}</span>
                <span className="mini-stat-label">Total Trades</span>
              </div>
              <div className="mini-stat-card sell-card">
                <ArrowDown size={18} style={{ color: '#10b981', marginBottom: 4 }} />
                <span className="mini-stat-value">{stats?.today?.sell_trades || 0}</span>
                <span className="mini-stat-label">Sell Orders</span>
              </div>
              <div className="mini-stat-card buy-card">
                <ArrowUp size={18} style={{ color: '#3b82f6', marginBottom: 4 }} />
                <span className="mini-stat-value">{stats?.today?.buy_trades || 0}</span>
                <span className="mini-stat-label">Buy Orders</span>
              </div>
              <div className="mini-stat-card">
                <DollarSign size={18} style={{ color: '#f59e0b', marginBottom: 4 }} />
                <span className="mini-stat-value">KES {(stats?.today?.volume || 0).toLocaleString()}</span>
                <span className="mini-stat-label">Total Volume</span>
              </div>
              <div className="mini-stat-card">
                <BarChart2 size={18} style={{ color: '#8b5cf6', marginBottom: 4 }} />
                <span className="mini-stat-value">{stats?.limits?.remaining_today || 0}/{stats?.limits?.daily_limit || 0}</span>
                <span className="mini-stat-label">Daily Limit</span>
              </div>
            </div>


            {/* Row 3: Buy/Sell Breakdown + Profit */}
            <div className="overview-grid-mid">
              {/* Buying Summary */}
              <div className="card buysell-card buying">
                <div className="buysell-header">
                  <ArrowUpCircle size={24} />
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
                  <ArrowDownCircle size={24} />
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
                  <TrendingUp size={24} style={{ color: '#10b981' }} />
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
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => {
                  const { secs, live, overdue } = getOrderDuration(order);
                  return (
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
                    <td style={{
                      fontVariantNumeric: 'tabular-nums',
                      color: overdue ? '#f97316' : live ? '#facc15' : '#9ca3af',
                      fontWeight: live ? 600 : 400,
                      whiteSpace: 'nowrap',
                    }}>
                      {overdue && <span title="Binance timer expired — order still active" style={{ marginRight: 4 }}>⚠️</span>}
                      {formatDuration(secs)}
                      {live && <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.6 }}>●</span>}
                    </td>
                  </tr>
                  );
                })}
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
                  onClick={() => { setTxnTab(t); setDepositPage(1); setWithdrawalPage(1); }}
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
                {depositHistory.length > 0 ? (() => {
                  const PAGE_SIZE = 20;
                  const totalDepPages = Math.ceil(depositHistory.length / PAGE_SIZE);
                  const depSlice = depositHistory.slice((depositPage - 1) * PAGE_SIZE, depositPage * PAGE_SIZE);
                  return (
                    <>
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
                          {depSlice.map((dep) => (
                            <tr key={dep.id}>
                              <td className="positive">+KES {dep.amount.toLocaleString()}</td>
                              <td style={{ color: dep.status === 'completed' ? '#10b981' : dep.status === 'failed' ? '#ef4444' : '#f59e0b' }}>
                                {dep.status}
                              </td>
                              <td className="mono">{dep.mpesa_receipt || '-'}</td>
                              <td>KES {dep.balance_after?.toLocaleString() || '-'}</td>
                              <td>{new Date(dep.created_at).toLocaleString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {totalDepPages > 1 && (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderTop: '1px solid #1f2937', marginTop: 0 }}>
                          <span style={{ fontSize: 12, color: '#6b7280' }}>
                            Page {depositPage} of {totalDepPages} &nbsp;·&nbsp; {depositHistory.length} total
                          </span>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button
                              onClick={() => setDepositPage(p => Math.max(1, p - 1))}
                              disabled={depositPage === 1}
                              style={{ padding: '5px 14px', borderRadius: 6, border: '1px solid #374151', background: depositPage === 1 ? 'transparent' : '#1f2937', color: depositPage === 1 ? '#4b5563' : '#fff', fontSize: 12, cursor: depositPage === 1 ? 'default' : 'pointer' }}
                            >← Prev</button>
                            <button
                              onClick={() => setDepositPage(p => Math.min(totalDepPages, p + 1))}
                              disabled={depositPage === totalDepPages}
                              style={{ padding: '5px 14px', borderRadius: 6, border: '1px solid #374151', background: depositPage === totalDepPages ? 'transparent' : '#1f2937', color: depositPage === totalDepPages ? '#4b5563' : '#fff', fontSize: 12, cursor: depositPage === totalDepPages ? 'default' : 'pointer' }}
                            >Next →</button>
                          </div>
                        </div>
                      )}
                    </>
                  );
                })() : (
                  <p className="empty-msg">No deposits yet. Deposit funds to enable auto-pay for buy orders.</p>
                )}
              </div>
            )}

            {/* Withdrawals Tab */}
            {txnTab === 'withdrawals' && (() => {
              // Group withdrawal + its fees (platform_fee, settlement_fee) by minute-timestamp into one combined row
              const groups = {}; // minuteKey → { withdrawal, fees: [] }
              const order = [];  // preserve insertion order

              withdrawalTxns.forEach(txn => {
                const minuteKey = txn.created_at.slice(0, 16);
                if (!groups[minuteKey]) { groups[minuteKey] = { withdrawal: null, fees: [] }; order.push(minuteKey); }
                if (txn.type === 'withdrawal') groups[minuteKey].withdrawal = txn;
                else if (txn.type === 'platform_fee' || txn.type === 'settlement_fee') groups[minuteKey].fees.push(txn);
              });

              const rows = order.map(k => groups[k]);

              const getDestination = (txn) => {
                const method = (txn.settlement_method || '').toLowerCase();
                const desc = (txn.description || '').toLowerCase();
                if (method === 'mpesa' || desc.includes('mpesa') || desc.includes('m-pesa') || desc.includes('safaricom'))
                  return { label: 'Safaricom M-Pesa', color: '#10b981', bg: 'rgba(16,185,129,0.1)' };
                if (method === 'bank' || method === 'bank_paybill' || desc.includes('bank') || desc.includes('paybill'))
                  return { label: 'I&M Bank', color: '#3b82f6', bg: 'rgba(59,130,246,0.1)' };
                return null;
              };

              const WD_PAGE_SIZE = 20;
              const totalWdPages = Math.ceil(rows.length / WD_PAGE_SIZE);
              const wdSlice = rows.slice((withdrawalPage - 1) * WD_PAGE_SIZE, withdrawalPage * WD_PAGE_SIZE);

              return (
                <div className="card">
                  <h3>Withdrawals</h3>
                  {rows.length > 0 ? (
                    <>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Reference</th>
                          <th>Amount</th>
                          <th>Balance After</th>
                          <th>Sent To</th>
                          <th>Status</th>
                          <th>Time</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {wdSlice.map((group, idx) => {
                          const { withdrawal, fees } = group;
                          if (!withdrawal) return null;
                          const totalFees = fees.reduce((s, f) => s + f.amount, 0);
                          const totalDeducted = withdrawal.amount + totalFees; // both negative
                          const destination = getDestination(withdrawal);
                          const key = withdrawal.id;
                          const isExpanded = !!expandedWithdrawals[key];
                          const hasFees = fees.length > 0;
                          const refNum = `SPK-${String(withdrawal.id).padStart(6, '0')}`;
                          const wdStatus = (withdrawal.status || 'pending').toLowerCase();
                          const isBatchQueued = wdStatus === 'pending' && withdrawal.description?.includes('Batch withdrawal');
                          const statusBadge = wdStatus === 'completed'
                            ? { label: 'Completed', color: '#10b981', bg: 'rgba(16,185,129,0.1)' }
                            : wdStatus === 'cancelled'
                            ? { label: 'Cancelled', color: '#ef4444', bg: 'rgba(239,68,68,0.1)' }
                            : wdStatus === 'failed'
                            ? { label: 'Failed', color: '#ef4444', bg: 'rgba(239,68,68,0.1)' }
                            : isBatchQueued
                            ? { label: 'Queued (Batch)', color: '#6366f1', bg: 'rgba(99,102,241,0.1)' }
                            : { label: 'Pending', color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' };

                          const feeLabels = {
                            platform_fee: 'Service fee',
                            settlement_fee: 'Safaricom fee',
                          };

                          return (
                            <React.Fragment key={key}>
                              <tr style={{ cursor: hasFees ? 'pointer' : 'default' }}
                                  onClick={() => hasFees && setExpandedWithdrawals(prev => ({ ...prev, [key]: !prev[key] }))}>
                                <td>
                                  <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#9ca3af', letterSpacing: '0.5px' }}>
                                    {refNum}
                                  </span>
                                </td>
                                <td>
                                  <span className="negative" style={{ fontWeight: 600 }}>
                                    {fmtKES(Math.abs(totalDeducted))}
                                  </span>
                                  {hasFees && (
                                    <span style={{ marginLeft: 6, fontSize: 11, color: '#6b7280' }}>
                                      (incl. {fmtKESFee(Math.abs(totalFees))} fees)
                                    </span>
                                  )}
                                </td>
                                <td>KES {(withdrawal.balance_after ?? 0).toLocaleString()}</td>
                                <td>
                                  {destination ? (
                                    <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600, color: destination.color, background: destination.bg }}>
                                      {destination.label}
                                    </span>
                                  ) : '—'}
                                </td>
                                <td>
                                  <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600, color: statusBadge.color, background: statusBadge.bg }}>
                                    {statusBadge.label}
                                  </span>
                                </td>
                                <td style={{ whiteSpace: 'nowrap', fontSize: 12, color: '#9ca3af' }}>
                                  {new Date(withdrawal.created_at).toLocaleString()}
                                </td>
                                <td style={{ textAlign: 'right' }}>
                                  {hasFees && (
                                    <span style={{ fontSize: 12, color: '#6b7280', userSelect: 'none' }}>
                                      {isExpanded ? '▲ hide' : '▼ fees'}
                                    </span>
                                  )}
                                </td>
                              </tr>
                              {isExpanded && (
                                <>
                                  <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
                                    <td colSpan={7} style={{ paddingTop: 0, paddingBottom: 0 }}>
                                      <div style={{ padding: '8px 16px', borderLeft: '2px solid #374151', marginLeft: 8 }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 13, color: '#d1d5db' }}>
                                          <span>Net withdrawal</span>
                                          <span className="negative">{fmtKES(Math.abs(withdrawal.amount))}</span>
                                        </div>
                                        {fees.map(f => (
                                          <div key={f.id} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 13, color: '#9ca3af' }}>
                                            <span>{feeLabels[f.type] || f.type.replace(/_/g, ' ')}</span>
                                            <span className="negative">{fmtKESFee(Math.abs(f.amount))}</span>
                                          </div>
                                        ))}
                                        <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #374151', paddingTop: 4, marginTop: 4, fontSize: 13, fontWeight: 600, color: '#f9fafb' }}>
                                          <span>Total deducted</span>
                                          <span className="negative">{fmtKES(Math.abs(totalDeducted))}</span>
                                        </div>
                                      </div>
                                    </td>
                                  </tr>
                                </>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                    {totalWdPages > 1 && (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderTop: '1px solid #1f2937' }}>
                        <span style={{ fontSize: 12, color: '#6b7280' }}>
                          Page {withdrawalPage} of {totalWdPages} &nbsp;·&nbsp; {rows.length} total
                        </span>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            onClick={() => setWithdrawalPage(p => Math.max(1, p - 1))}
                            disabled={withdrawalPage === 1}
                            style={{ padding: '5px 14px', borderRadius: 6, border: '1px solid #374151', background: withdrawalPage === 1 ? 'transparent' : '#1f2937', color: withdrawalPage === 1 ? '#4b5563' : '#fff', fontSize: 12, cursor: withdrawalPage === 1 ? 'default' : 'pointer' }}
                          >← Prev</button>
                          <button
                            onClick={() => setWithdrawalPage(p => Math.min(totalWdPages, p + 1))}
                            disabled={withdrawalPage === totalWdPages}
                            style={{ padding: '5px 14px', borderRadius: 6, border: '1px solid #374151', background: withdrawalPage === totalWdPages ? 'transparent' : '#1f2937', color: withdrawalPage === totalWdPages ? '#4b5563' : '#fff', fontSize: 12, cursor: withdrawalPage === totalWdPages ? 'default' : 'pointer' }}
                          >Next →</button>
                        </div>
                      </div>
                    )}
                    </>
                  ) : (
                    <p className="empty-msg">No withdrawals yet.</p>
                  )}
                </div>
              );
            })()}
          </>
        )}

        {activeTab === 'settings' && <SettingsPanel profile={profile} onUpdate={loadData} />}

        {/* ── Logs Tab ── */}
        {activeTab === 'logs' && (
          <div className="card" style={{ fontFamily: 'monospace', fontSize: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ margin: 0 }}>Activity Logs</h3>
              <span style={{ color: '#6b7280', fontSize: 11 }}>{botLogs.length} entries</span>
            </div>
            {!window.sparkp2p ? (
              <p style={{ color: '#6b7280', textAlign: 'center', padding: 40 }}>Logs are only available in the desktop app.</p>
            ) : botLogs.length === 0 ? (
              <p style={{ color: '#6b7280', textAlign: 'center', padding: 40 }}>No activity yet. Logs will appear here as the bot runs.</p>
            ) : (
              <div style={{ maxHeight: 'calc(80vh - 140px)', minHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                {botLogs.map((log, i) => {
                  const colors = { success: '#10b981', error: '#ef4444', warning: '#f59e0b', info: '#6b7280' };
                  const badges = { success: '✓', error: '✕', warning: '⚠', info: '·' };
                  const color = colors[log.level] || '#6b7280';
                  const badge = badges[log.level] || '·';
                  const time = new Date(log.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                  return (
                    <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '4px 6px', borderRadius: 4, background: i % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent' }}>
                      <span style={{ color, minWidth: 14, marginTop: 1 }}>{badge}</span>
                      <span style={{ color: '#374151', minWidth: 70, fontSize: 10, marginTop: 2 }}>{time}</span>
                      <span style={{ color: log.level === 'error' ? '#fca5a5' : log.level === 'success' ? '#6ee7b7' : log.level === 'warning' ? '#fcd34d' : '#9ca3af', flex: 1, wordBreak: 'break-word' }}>{log.message}</span>
                    </div>
                  );
                })}
                <div ref={logsEndRef} />
              </div>
            )}
          </div>
        )}
      </main>

      {/* Withdraw OTP Modal */}
      {showWithdrawModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#1f2937', borderRadius: 16, padding: 32, width: '100%', maxWidth: 420, boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 style={{ color: '#fff', fontSize: 18, margin: 0 }}>Confirm Withdrawal</h3>
              <button onClick={() => { setShowWithdrawModal(false); setWithdrawStatus(null); clearInterval(withdrawPollRef.current); }} style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 20 }}>×</button>
            </div>

            {/* System degraded banner */}
            {systemStatus && (() => {
              const degradedSystems = Object.values(systemStatus).filter(s => s.degraded);
              if (degradedSystems.length === 0) return null;
              const names = degradedSystems.map(s => s.name).join(' and ');
              return (
                <div style={{
                  display: 'flex', gap: 10, alignItems: 'flex-start',
                  background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.35)',
                  borderRadius: 8, padding: '12px 14px', marginBottom: 16,
                }}>
                  <span style={{ fontSize: 16, flexShrink: 0 }}>⚠️</span>
                  <div>
                    <p style={{ margin: '0 0 4px', fontSize: 13, color: '#ef4444', fontWeight: 700 }}>
                      {names} {degradedSystems.length > 1 ? 'are' : 'is'} currently unavailable
                    </p>
                    <p style={{ margin: 0, fontSize: 12, color: '#f87171', lineHeight: 1.5 }}>
                      Withdrawals are temporarily on hold. Your balance is safe and will be processed as soon as the system recovers. Our team has been notified.
                    </p>
                  </div>
                </div>
              );
            })()}

            {/* Amount input */}
            {withdrawPreview && (() => {
              const balance = withdrawPreview.balance ?? 0;
              const minWd = withdrawPreview.min_withdrawal ?? 1000;
              const forceFullBalance = withdrawPreview.force_full_withdrawal;
              const customAmt = parseFloat(withdrawCustomAmount) || 0;
              const clampedAmt = Math.min(customAmt, balance);
              const liveFee = getWithdrawalFee(withdrawPreview.settlement_method || 'mpesa', clampedAmt);
              const liveReceive = Math.max(0, clampedAmt - liveFee);
              const remainingAfter = balance - clampedAmt;
              const wouldStrand = clampedAmt > 0 && clampedAmt < balance && remainingAfter > 0 && remainingAfter < minWd;
              const amtErr = customAmt > balance
                ? `Max KES ${balance.toLocaleString()}`
                : customAmt > 0 && customAmt < minWd
                  ? `Min KES ${minWd.toLocaleString()}`
                  : wouldStrand
                    ? `Withdrawing KES ${clampedAmt.toLocaleString()} would leave KES ${remainingAfter.toLocaleString()} which can't be withdrawn later. Withdraw the full KES ${balance.toLocaleString()} instead.`
                    : '';
              return (
                <>
                  {forceFullBalance && (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 8, padding: '10px 12px', marginBottom: 14 }}>
                      <span style={{ fontSize: 14, flexShrink: 0 }}>ℹ️</span>
                      <p style={{ margin: 0, fontSize: 12, color: '#d97706', lineHeight: 1.5 }}>
                        Your balance is below KES {(minWd * 2).toLocaleString()}. You must withdraw the <strong>full amount</strong> to avoid leaving a balance that cannot be withdrawn later.
                      </p>
                    </div>
                  )}
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: 'block', color: '#9ca3af', fontSize: 12, marginBottom: 6 }}>
                      Withdrawal Amount <span style={{ color: '#6b7280' }}>(Balance: KES {balance.toLocaleString()})</span>
                    </label>
                    <div style={{ position: 'relative' }}>
                      <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#6b7280', fontSize: 13 }}>KES</span>
                      <input
                        type="number"
                        min={0}
                        max={balance}
                        step={1}
                        value={withdrawCustomAmount}
                        onChange={e => { if (!forceFullBalance) setWithdrawCustomAmount(e.target.value); }}
                        readOnly={forceFullBalance}
                        style={{ width: '100%', padding: '11px 14px 11px 44px', borderRadius: 8, border: `1px solid ${amtErr ? '#ef4444' : '#374151'}`, background: forceFullBalance ? '#0f1117' : '#111827', color: '#fff', fontSize: 15, boxSizing: 'border-box', cursor: forceFullBalance ? 'not-allowed' : 'text' }}
                      />
                      {!forceFullBalance && (
                      <button
                        onClick={() => setWithdrawCustomAmount(String(Math.round(balance * 100) / 100))}
                        style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#10b981', fontSize: 11, cursor: 'pointer', fontWeight: 700 }}
                      >MAX</button>
                      )}
                    </div>
                    {amtErr && <p style={{ color: '#ef4444', fontSize: 11, margin: '4px 0 0' }}>{amtErr}</p>}
                  </div>
                  <div style={{ background: '#111827', borderRadius: 10, padding: '14px 16px', marginBottom: 20, fontSize: 13 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, color: '#9ca3af' }}>
                      <span>Withdrawal Amount</span><span style={{ color: '#fff', fontWeight: 600 }}>KES {clampedAmt.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, color: '#9ca3af' }}>
                      <span>Transaction Fee</span><span style={{ color: '#f59e0b', fontWeight: 600 }}>- KES {liveFee.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div style={{ borderTop: '1px solid #374151', paddingTop: 8, display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#10b981', fontWeight: 700 }}>You Receive</span><span style={{ color: '#10b981', fontWeight: 700, fontSize: 15 }}>KES {liveReceive.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                  </div>
                </>
              );
            })()}

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

            {withdrawStatus === 'processing' ? (
              <div style={{ textAlign: 'center', padding: '20px 0' }}>
                <div style={{ fontSize: 40, marginBottom: 16 }}>⏳</div>
                <p style={{ color: '#10b981', fontWeight: 700, fontSize: 16, marginBottom: 8 }}>Processing your withdrawal...</p>
                <p style={{ color: '#9ca3af', fontSize: 13, marginBottom: 24 }}>The bot is completing the bank transfer. This usually takes 1–3 minutes.</p>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981', animation: 'pulse 1.2s infinite' }} />
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981', animation: 'pulse 1.2s infinite 0.4s' }} />
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981', animation: 'pulse 1.2s infinite 0.8s' }} />
                </div>
              </div>
            ) : withdrawStatus === 'succeeded' ? (
              <div style={{ textAlign: 'center', padding: '20px 0' }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
                <p style={{ color: '#10b981', fontWeight: 700, fontSize: 18, marginBottom: 8 }}>Withdrawal Successful!</p>
                <p style={{ color: '#9ca3af', fontSize: 13, marginBottom: 24 }}>The funds have been transferred to your account.</p>
                <button onClick={() => { setShowWithdrawModal(false); setWithdrawStatus(null); }} style={{ padding: '11px 32px', borderRadius: 8, border: 'none', background: 'linear-gradient(135deg,#10b981,#059669)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>Done</button>
              </div>
            ) : !withdrawOtpSent ? (
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
                    const customAmt = parseFloat(withdrawCustomAmount);
                    const walletBal = withdrawPreview?.balance ?? 0;
                    const finalAmt = customAmt > 0 && customAmt < walletBal ? customAmt : undefined;
                    setWithdrawing(true);
                    setWithdrawMsg('');
                    try {
                      const res = await requestWithdrawal(withdrawOtp, finalAmt);
                      const s = res.data?.status;
                      if (s === 'queued') {
                        // Batch withdrawal queued — wallet balance already deducted
                        setShowWithdrawModal(false);
                        alert(res.data.message || 'Withdrawal queued! You will receive an SMS and email once the hourly batch transfer completes.');
                        await loadData();
                      } else if (s === 'processing') {
                        setWithdrawStatus('processing');
                        // Poll wallet every 5s until pending_withdrawal clears
                        withdrawPollRef.current = setInterval(async () => {
                          try {
                            const w = await getWallet();
                            if (!w.data.pending_withdrawal) {
                              clearInterval(withdrawPollRef.current);
                              setWithdrawStatus('succeeded');
                              await loadData();
                            }
                          } catch (_) {}
                        }, 5000);
                      } else {
                        setShowWithdrawModal(false);
                        alert(res.data.message || 'Withdrawal sent!');
                        await loadData();
                      }
                    } catch (e) {
                      setWithdrawMsg(e.response?.data?.detail || 'Withdrawal failed. Please try again.');
                    }
                    setWithdrawing(false);
                  }}
                  disabled={withdrawing || withdrawOtp.length !== 6 || !!withdrawAmtErr}
                  style={{ width: '100%', padding: '11px 0', borderRadius: 8, border: 'none', background: (withdrawOtp.length === 6 && !withdrawAmtErr) ? 'linear-gradient(135deg,#10b981,#059669)' : '#374151', color: '#fff', fontWeight: 700, fontSize: 14, cursor: (withdrawOtp.length === 6 && !withdrawAmtErr) ? 'pointer' : 'not-allowed', marginBottom: 8 }}
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
                <span style={{ color: '#f59e0b', fontWeight: 600 }}>P2PT{String(profile?.id || 0).padStart(4, '0')}</span>
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
