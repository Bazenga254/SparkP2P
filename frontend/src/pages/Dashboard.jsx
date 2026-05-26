import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import api, { getProfile, getWallet, getOrderStats, getOrders, requestWithdrawal, requestWithdrawalOtp, getWalletTransactions, getSessionHealth, getBinanceAccountData, getMarketPrices, getMyAdPrices, getTodayStats, initiateDeposit, getDepositHistory, checkDepositStatus, internalTransfer, getSystemStatus, getMyAffiliate, getMyReferrals, getMyPayouts, applyForAffiliate, updateProfile, purchaseCredits, pollCreditsStatus, choiceGetBalance } from '../services/api';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Wallet, TrendingUp, TrendingDown, ArrowDownCircle, ArrowUpCircle, ArrowDown, ArrowUp, RefreshCw, LogOut, Settings, Clock, Shield, Plus, X, Bell, Copy, CreditCard, Eye, EyeOff, MessageSquare, Activity, BarChart2, DollarSign, Repeat, SlidersHorizontal, Share2, Users, ChevronDown, ChevronUp } from 'lucide-react';
import SettingsPanel from '../components/SettingsPanel';
import { kycCreateSession } from '../services/api';
import SupportChat from '../components/SupportChat';

const B2C_FEES = [
  [1000,9],[1500,14],[2500,19],[3500,24],[5000,33],[7500,40],[10000,46],
  [15000,55],[20000,60],[25000,65],[30000,70],[35000,80],[40000,96],[45000,100],[50000,105],[150000,105],
];
function mpesaB2CFee(amount) {
  for (const [threshold, fee] of B2C_FEES) { if (amount <= threshold) return fee; }
  return 105;
}
const BANK_FLAT_FEES = [[20000,10],[50000,25],[150000,35],[300000,45],[500000,60]];
function bankFlatFee(amount) {
  for (const [threshold, fee] of BANK_FLAT_FEES) { if (amount <= threshold) return fee; }
  return 60;
}
function getWithdrawalFee(method, amount) {
  if (amount <= 0) return 0;
  if (method === 'mpesa') return mpesaB2CFee(amount) + 25;
  return bankFlatFee(amount);
}
const fmtCountdown = (secs) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
const fmtKES = (n) => 'KES ' + Math.abs(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
const fmtKESFee = (n) => 'KES ' + Math.abs(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDateEAT = (ts) => new Date(ts).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });
const fmtTimeEAT = (ts) => new Date(ts).toLocaleTimeString('en-KE', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit', second: '2-digit' });

const SUPPORTED_COINS = ['USDT', 'USDC', 'BTC', 'ETH', 'BNB', 'BUSD'];

function SpreadCalculator({ orderStats }) {
  const [coin, setCoin] = useState('USDT');
  const [buyPrice, setBuyPrice] = useState('130.00');
  const [sellPrice, setSellPrice] = useState('130.50');
  const [volume, setVolume] = useState('500000');
  const [withdrawMethod, setWithdrawMethod] = useState('mpesa');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [autoLoaded, setAutoLoaded] = useState(false);
  const [adSource, setAdSource] = useState(''); // 'orders' | 'ads' | 'market' | ''
  const [missingAd, setMissingAd] = useState(''); // 'buy' | 'sell' | ''
  const [todayStats, setTodayStats] = useState(null); // 24h live stats from backend
  const [statsLoading, setStatsLoading] = useState(true);

  // Priority 1: use actual avg rates from today's completed orders (most accurate)
  useEffect(() => {
    if (!orderStats) return;
    const avgBuy = orderStats.avg_buy_rate;
    const avgSell = orderStats.avg_sell_rate;
    if (avgBuy > 50 || avgSell > 50) {
      if (avgBuy > 50) setBuyPrice(String(avgBuy));
      if (avgSell > 50) setSellPrice(String(avgSell));
      setAutoLoaded(true);
      setAdSource('orders');
      setMissingAd(!avgBuy || avgBuy <= 50 ? 'buy' : !avgSell || avgSell <= 50 ? 'sell' : '');
    }
  }, [orderStats?.avg_buy_rate, orderStats?.avg_sell_rate]);

  useEffect(() => {
    const fetchPrices = async () => {
      // Skip ad/market fetch if we already have real order data for today
      if (orderStats?.avg_buy_rate > 50 && orderStats?.avg_sell_rate > 50) return;

      // Try trader's own ads (fallback when no orders yet today)
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

    // Live update when the desktop bot pushes fresh scraped prices
    // Only apply if we don't have real order data (order data takes priority)
    const onAdPricesUpdated = (e) => {
      if (orderStats?.avg_buy_rate > 50 && orderStats?.avg_sell_rate > 50) return;
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
            {adSource === 'orders'
              ? `Live from today's ${orderStats?.total_trades ?? ''} order${orderStats?.total_trades !== 1 ? 's' : ''}`
              : adSource === 'ads' ? 'Auto-filled from your ads' : 'Live market prices'}
            {missingAd && (
              <span style={{ color: '#f59e0b', marginLeft: 4 }}>
                ⚠ No {missingAd} ad found — enter {missingAd} price manually
              </span>
            )}
          </span>
        )}
      </div>

      {/* Inputs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 1fr 1fr', gap: 12, padding: '12px 0 0', alignItems: 'end' }}>
        <div>
          <label style={{ fontSize: 12, color: '#9ca3af', display: 'block', marginBottom: 4 }}>Coin</label>
          <select value={coin} onChange={(e) => setCoin(e.target.value)}
            style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 14, fontWeight: 700 }}>
            {SUPPORTED_COINS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 12, color: '#9ca3af', display: 'block', marginBottom: 4 }}>Buy Price (KSh/{coin})</label>
          <input type="number" step="0.01" placeholder="130.23" value={buyPrice} onChange={(e) => setBuyPrice(e.target.value)}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 14 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, color: '#9ca3af', display: 'block', marginBottom: 4 }}>Sell Price (KSh/{coin})</label>
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

          {/* Spread per coin — calculated from inputs */}
          <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: '#9ca3af' }}>Spread per {coin}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: profitable ? '#10b981' : '#ef4444' }}>KSh {spread.toFixed(2)}</div>
            <div style={{ fontSize: 11, color: '#6b7280' }}>{spreadPct.toFixed(3)}%</div>
          </div>

          {/* Crypto Traded — real 24h */}
          <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', border: '1px solid var(--border)', position: 'relative' }}>
            <div style={{ fontSize: 11, color: '#9ca3af', display: 'flex', alignItems: 'center', gap: 4 }}>
              {todayStats?.dominant_currency || coin} Traded
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
                {withdrawMethod === 'mpesa' ? 'tiered rate' : 'flat fee'}
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

  // Fetch Choice Bank balance — poll every 10s when account is verified
  useEffect(() => {
    if (!profile?.choice_account_id) return;
    const fetchCbBalance = async () => {
      setCbBalanceLoading(true);
      try {
        const res = await choiceGetBalance(profile.id);
        setCbDashBalance(res.data);
      } catch {}
      finally { setCbBalanceLoading(false); }
    };
    fetchCbBalance();
    const iv = setInterval(fetchCbBalance, 10000);
    return () => clearInterval(iv);
  }, [profile?.choice_account_id, profile?.id]);

  const [wallet, setWallet] = useState(null);
  const [stats, setStats] = useState(null);
  const [orders, setOrders] = useState([]);
  const [ordersPage, setOrdersPage] = useState(1);
  const [ordersHasMore, setOrdersHasMore] = useState(true);
  const ORDERS_PER_PAGE = 20;
  const [ordersFilter, setOrdersFilter] = useState('all'); // 'all' | 'incoming' | 'outgoing'
  const [showTierModal, setShowTierModal] = useState(false);
  const [tierModalSelection, setTierModalSelection] = useState('');
  const [tierModalSaving, setTierModalSaving] = useState(false);
  const [transactions, setTransactions] = useState([]);
  const [withdrawalTxns, setWithdrawalTxns] = useState([]);
  const [cbDashBalance, setCbDashBalance] = useState(null);
  const [cbBalanceLoading, setCbBalanceLoading] = useState(false);
  const [expandedWithdrawals, setExpandedWithdrawals] = useState({});
  const [depositPage, setDepositPage] = useState(1);
  const [withdrawalPage, setWithdrawalPage] = useState(1);
  const [sweepSecondsLeft, setSweepSecondsLeft] = useState(0);
  const [activeTab, setActiveTab] = useState('overview');
  const [creditPlan, setCreditPlan] = useState(null);
  const [creditPhone, setCreditPhone] = useState('');
  const [creditBuying, setCreditBuying] = useState(false);
  const [creditPolling, setCreditPolling] = useState(false);
  const [creditCheckoutId, setCreditCheckoutId] = useState(null);
  const [creditMsg, setCreditMsg] = useState(null);
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
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [botTradeMode, setBotTradeMode] = useState('both');
  const [savingConfig, setSavingConfig] = useState(false);
  const [configSaved, setConfigSaved] = useState(false);
  const configSavedAt = useRef(0);
  const [ddEnabled, setDdEnabled] = useState(false);
  const [ddMin30d, setDdMin30d] = useState(20);
  const [ddMinAll, setDdMinAll] = useState(0);
  const [ddAutoCancelNew, setDdAutoCancelNew] = useState(false);
  const [tgApprovalEnabled, setTgApprovalEnabled] = useState(false);
  const [tgConnectedForConfig, setTgConnectedForConfig] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState('binance'); // timestamp of last successful config save — prevents stale loadData responses from overwriting the saved value
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
  const [updateDownloading, setUpdateDownloading] = useState(null); // { version, percent } while downloading
  const [checkingUpdate, setCheckingUpdate] = useState(false); // manual check in progress
  const [upToDate, setUpToDate] = useState(null); // { version } when already on latest
  const upToDateTimerRef = useRef(null);
  const [affiliateData, setAffiliateData] = useState(null); // { affiliate: {...} | null }
  const [affiliateReferrals, setAffiliateReferrals] = useState(null);
  const [affiliateApplying, setAffiliateApplying] = useState(false);
  const [affiliateApplyMsg, setAffiliateApplyMsg] = useState('');
  const [affiliateCopied, setAffiliateCopied] = useState(false);
  const [expandedReferral, setExpandedReferral] = useState(null);

  // Listen for update events from Electron main process
  useEffect(() => {
    const readyHandler = (e) => {
      setUpdateDownloading(null);
      setCheckingUpdate(false);
      setUpToDate(null);
      setUpdateVersion(e.detail?.version || 'latest');
    };
    const downloadingHandler = (e) => {
      setCheckingUpdate(false);
      setUpToDate(null);
      setUpdateDownloading(prev => ({ ...prev, ...e.detail }));
    };
    const upToDateHandler = (e) => {
      setCheckingUpdate(false);
      setUpToDate(e.detail);
      clearTimeout(upToDateTimerRef.current);
      upToDateTimerRef.current = setTimeout(() => setUpToDate(null), 5000);
    };
    window.addEventListener('sparkp2p-update-ready', readyHandler);
    window.addEventListener('sparkp2p-update-downloading', downloadingHandler);
    window.addEventListener('sparkp2p-up-to-date', upToDateHandler);
    return () => {
      window.removeEventListener('sparkp2p-update-ready', readyHandler);
      window.removeEventListener('sparkp2p-update-downloading', downloadingHandler);
      window.removeEventListener('sparkp2p-up-to-date', upToDateHandler);
      clearTimeout(upToDateTimerRef.current);
    };
  }, []);

  // Sweep countdown timer — ticks every second, resets at each 15-min boundary
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const m = now.getMinutes();
      const nextM = (Math.floor(m / 15) + 1) * 15;
      const next = new Date(now);
      if (nextM >= 60) {
        next.setHours(next.getHours() + 1, 0, 0, 0);
      } else {
        next.setMinutes(nextM, 0, 0);
      }
      setSweepSecondsLeft(Math.max(0, Math.floor((next - now) / 1000)));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const loadData = async () => {
    if (!localStorage.getItem('token')) return;
    setRefreshing(true);
    try {
      const results = await Promise.allSettled([
        getProfile(),
        getWallet(),
        getOrderStats(),
        getOrders({ limit: 20, offset: 0 }),
        getWalletTransactions(50, 'positive'),
        getSessionHealth(),
        getBinanceAccountData(),
        getWalletTransactions(100, 'negative'),
      ]);
      if (results[0].status === 'fulfilled') { const p = results[0].value.data; setProfile(p); if (!p.binance_merchant_tier) setShowTierModal(true); if (Date.now() - configSavedAt.current > 30000) { setBotTradeMode(p.bot_trade_mode || 'both'); setDdEnabled(p.dd_enabled || false); setDdMin30d(p.dd_min_30d_trades ?? 20); setDdMinAll(p.dd_min_all_trades ?? 0); setDdAutoCancelNew(p.dd_auto_cancel_new || false); setTgApprovalEnabled(p.telegram_approval_enabled || false); setTgConnectedForConfig(p.telegram_connected || false); } }
      if (results[1].status === 'fulfilled') setWallet(results[1].value.data);
      if (results[2].status === 'fulfilled') setStats(results[2].value.data);
      if (results[3].status === 'fulfilled') { const od = results[3].value.data; setOrders(od); setOrdersPage(1); setOrdersHasMore(od.length === 20); }
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

  const loadAffiliateData = async () => {
    try {
      const res = await getMyAffiliate();
      setAffiliateData(res.data);
      if (res.data?.affiliate?.status === 'approved') {
        const refRes = await getMyReferrals();
        setAffiliateReferrals(refRes.data);
      }
    } catch (e) {}
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

  // Refresh profile every 30s so bot status stays live after the initial scan
  useEffect(() => {
    const id = setInterval(async () => {
      try { const res = await getProfile(); setProfile(res.data); } catch (_) {}
    }, 30000);
    return () => clearInterval(id);
  }, []);

  // Refresh orders every 20s so new Binance orders appear automatically
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const res = await getOrders({ limit: 20, offset: (ordersPage - 1) * 20 });
        setOrders(res.data);
        setOrdersHasMore(res.data.length === 20);
      } catch (_) {}
    }, 20000);
    return () => clearInterval(id);
  }, [ordersPage]);

  useEffect(() => {
    if (ordersPage === 1) return; // page 1 already loaded by loadData
    getOrders({ limit: 20, offset: (ordersPage - 1) * 20 })
      .then(res => { setOrders(res.data); setOrdersHasMore(res.data.length === 20); })
      .catch(() => {});
  }, [ordersPage]);

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
    // Fetch desktop app version from local bot server; fall back to build-time version for web browser
    setAppVersion(__APP_VERSION__);
    fetch('http://127.0.0.1:9223/status').then(r => r.json()).then(d => { if (d.version) setAppVersion(d.version); }).catch(() => {});
    // Wait a tick to ensure token is stored after login redirect
    const timer = setTimeout(() => {
      if (localStorage.getItem('token')) {
        loadData();
        loadAffiliateData();
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
      // Immediately refresh orders when bot detects a new Binance order
      if ((entry?.message || '').includes('New order detected')) {
        getOrders({ limit: 20, offset: (ordersPage - 1) * 20 }).then(r => { setOrders(r.data); setOrdersHasMore(r.data.length === 20); }).catch(() => {});
      }
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
        <div className="setup-banner">
          <span className="setup-banner-icon">⚠️</span>
          <div className="setup-banner-body">
            <div className="setup-banner-title">Bot Paused — Setup Incomplete</div>
            <div className="setup-banner-desc">
              Connect{' '}
              {bannerMissing.map((m, i) => (
                <span key={m}>
                  <strong style={{ color: '#fff' }}>{m}</strong>
                  {i < bannerMissing.length - 1 ? ', ' : ''}
                </span>
              ))}
              {' '}in Settings → Binance tab.
            </div>
          </div>
          <button className="setup-banner-btn" onClick={() => setActiveTab('settings')}>
            Go to Settings
          </button>
          <button className="setup-banner-dismiss" onClick={() => setSetupDismissed(true)}>
            ✕
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
          {/* Update button — only shown in desktop Electron app */}
          {window.sparkp2p?.isDesktop && (
            <div style={{ position: 'relative' }}>
              <button
                className="icon-btn"
                title={
                  updateVersion ? `v${updateVersion} ready — click to install` :
                  updateDownloading ? `Downloading update${updateDownloading.version ? ` v${updateDownloading.version}` : ''}... ${updateDownloading.percent ?? 0}%` :
                  checkingUpdate ? 'Checking for updates...' :
                  'Check for updates'
                }
                disabled={!!updateDownloading || checkingUpdate}
                onClick={() => {
                  if (updateVersion) { window.sparkp2p?.restartApp?.(); return; }
                  setCheckingUpdate(true);
                  setUpToDate(null);
                  window.sparkp2p?.checkForUpdates?.();
                  setTimeout(() => setCheckingUpdate(false), 15000);
                }}
                style={{
                  color: updateVersion ? '#10b981' : updateDownloading ? '#3b82f6' : checkingUpdate ? '#60a5fa' : undefined,
                  position: 'relative',
                }}
              >
                <ArrowUpCircle size={18} className={updateDownloading || checkingUpdate ? 'spinning' : ''} />
                {updateVersion && (
                  <span style={{
                    position: 'absolute', top: -4, right: -4,
                    width: 8, height: 8, borderRadius: '50%',
                    background: '#10b981', border: '2px solid var(--bg)',
                    boxShadow: '0 0 6px #10b981',
                    animation: 'pulse-green 1.5s ease-in-out infinite',
                  }} />
                )}
                {updateDownloading && !updateVersion && (
                  <span style={{
                    position: 'absolute', top: -6, right: -6,
                    background: '#3b82f6', color: '#fff', borderRadius: 8,
                    fontSize: 8, fontWeight: 700, padding: '1px 3px', lineHeight: 1,
                    minWidth: 18, textAlign: 'center',
                  }}>
                    {updateDownloading.percent ?? 0}%
                  </span>
                )}
              </button>
              {/* Up-to-date popup */}
              {upToDate && (
                <div style={{
                  position: 'absolute', top: 38, right: 0, zIndex: 200,
                  background: '#0c2a1a', border: '1px solid #10b981',
                  borderRadius: 10, padding: '10px 14px', whiteSpace: 'nowrap',
                  boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
                  animation: 'fadeIn 0.2s ease',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: '#10b981', fontSize: 16 }}>✓</span>
                    <div>
                      <div style={{ color: '#10b981', fontWeight: 700, fontSize: 13 }}>You are up to date!</div>
                      <div style={{ color: '#6ee7b7', fontSize: 12, marginTop: 2 }}>
                        SparkP2P v{upToDate.version} is the latest version.
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
          <button className="icon-btn" onClick={loadData} disabled={refreshing}>
            <RefreshCw size={18} className={refreshing ? 'spinning' : ''} />
          </button>
          <button className="icon-btn" onClick={logout}><LogOut size={18} /></button>
        </div>
      </header>

      <nav className="dash-tabs">
        {['overview', 'orders', 'logs', 'settings'].map((tab) => (
          <button
            key={tab}
            className={`tab-btn ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
        {affiliateData?.affiliate && (
          <button
            className={`tab-btn ${activeTab === 'affiliates' ? 'active' : ''}`}
            onClick={() => setActiveTab('affiliates')}
            style={{ display: 'flex', alignItems: 'center', gap: 5 }}
          >
            <Share2 size={13} /> Affiliates
          </button>
        )}
        {!profile?.binance_connected && (
          <button
            className="tab-btn"
            style={{ color: '#f59e0b', fontWeight: 600 }}
            onClick={() => setActiveTab('settings')}
          >
            Connect Binance
          </button>
        )}
        <button
          className="tab-btn"
          style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#f59e0b', fontWeight: 600 }}
          onClick={() => setShowConfigModal(true)}
          title="Configure Bot"
        >
          <SlidersHorizontal size={14} /> Configure
        </button>
        <button
          className={`tab-btn ${activeTab === 'credits' ? 'active' : ''}`}
          style={{ display: 'flex', alignItems: 'center', gap: 5, color: activeTab === 'credits' ? '#fff' : '#10b981', fontWeight: 700 }}
          onClick={() => setActiveTab('credits')}
        >
          <DollarSign size={14} /> Buy Credits
        </button>
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
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>🏦 Choice Bank Payment Details</div>
              <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 12 }}>
                Copy these details to receive payments via M-Pesa Paybill into your Choice Bank account.
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
                  <span style={{ flex: 1, fontWeight: 600, fontSize: 13, fontFamily: 'monospace' }}>{profile?.choice_account_number || profile?.choice_account_id || 'Pending verification'}</span>
                  <button onClick={() => { navigator.clipboard.writeText(profile?.choice_account_number || profile?.choice_account_id || ''); setCopied('account'); setTimeout(() => setCopied(''), 2000); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: copied === 'account' ? '#10b981' : '#9ca3af', padding: 2 }}>
                    <Copy size={14} />
                  </button>
                </div>
              </div>

              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>Paybill Number</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg)', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)' }}>
                  <span style={{ flex: 1, fontWeight: 600, fontSize: 13, fontFamily: 'monospace' }}>444174</span>
                  <button onClick={() => { navigator.clipboard.writeText('444174'); setCopied('paybill'); setTimeout(() => setCopied(''), 2000); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: copied === 'paybill' ? '#10b981' : '#9ca3af', padding: 2 }}>
                    <Copy size={14} />
                  </button>
                </div>
              </div>

              {copied && (
                <div style={{ fontSize: 12, color: '#10b981', textAlign: 'center', marginBottom: 8 }}>Copied!</div>
              )}

              <div style={{ fontSize: 11, color: '#6b7280', lineHeight: 1.5, padding: '8px 0', borderTop: '1px solid var(--border)' }}>
                Share these details with buyers on Binance P2P. Payments go directly to your Choice Bank account.
              </div>
            </div>
          )}
        </div>
      </nav>

      <main className="dash-content">
{activeTab === 'overview' && (
          <>
            {/* Choice Bank verification banner */}
            {!profile?.choice_account_id && (
              <div onClick={async () => {
                try {
                  const res = await kycCreateSession();
                  const url = `${window.location.origin}/verify-kyc?t=${res.data.token}`;
                  if (window.sparkp2p && window.sparkp2p.openExternal) {
                    window.sparkp2p.openExternal(url);
                  } else {
                    window.open(url, '_blank');
                  }
                } catch {
                  setSettingsInitialSection('bank');
                  setActiveTab('settings');
                }
              }}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 18px', marginBottom: 16, borderRadius: 10,
                  background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.35)', cursor: 'pointer' }}>
                <span style={{ fontSize: 18 }}>🏦</span>
                <div style={{ flex: 1 }}>
                  <span style={{ color: '#f59e0b', fontWeight: 700, fontSize: 13 }}>Complete Bank Verification</span>
                  <span style={{ color: '#9ca3af', fontSize: 12, marginLeft: 8 }}>Link your Choice Bank account to receive M-Pesa payments automatically.</span>
                </div>
                <span style={{ color: '#f59e0b', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>Set up →</span>
              </div>
            )}

            {/* Row 1: Greeting + Wallet */}
            <div className="overview-grid-top">
              <div className="card greeting-card">
                <div className="greeting-text">
                  <span className="greeting-hello">Good {new Date().getHours() < 12 ? 'Morning' : new Date().getHours() < 18 ? 'Afternoon' : 'Evening'}, {user?.full_name}!</span>
                  {(() => {
                    const ts = profile?.last_extension_sync || user?.last_extension_sync;
                    const diff = ts ? (Date.now() - new Date(ts).getTime()) / 1000 : null;
                    const online = diff !== null && diff < 60;
                    const label = !ts ? 'Bot Never Connected' : online ? 'Bot Online' : diff < 3600 ? `Last seen ${Math.floor(diff/60)}m ago` : diff < 86400 ? `Last seen ${Math.floor(diff/3600)}h ago` : `Last seen ${Math.floor(diff/86400)}d ago`;
                    return (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: online ? '#10b981' : '#9ca3af', marginBottom: 2 }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: online ? '#10b981' : '#6b7280', flexShrink: 0 }} />
                        {label}
                      </span>
                    );
                  })()}
                  <span className="greeting-sub">Today's Earnings</span>
                  <span className="greeting-amount">KES {(stats?.today?.net_profit || 0).toLocaleString()}</span>
                </div>
                <div className="greeting-icon">
                  {(stats?.today?.net_profit || 0) >= 0 ? '📈' : '📉'}
                </div>
              </div>

              <div className="card wallet-mini-card">
                <div className="wallet-mini-header">
                  <span style={{ fontSize: 17 }}>🏦</span>
                  <span>Choice Bank</span>
                  {profile?.choice_account_id && (
                    <button
                      onClick={async () => { setCbBalanceLoading(true); try { const r = await choiceGetBalance(profile.id); setCbDashBalance(r.data); } catch {} finally { setCbBalanceLoading(false); } }}
                      style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center' }}
                      title="Refresh balance"
                    >
                      <RefreshCw size={13} style={{ animation: cbBalanceLoading ? 'spin 1s linear infinite' : 'none' }} />
                    </button>
                  )}
                  <button
                    onClick={() => setShowBalance(v => !v)}
                    style={{ marginLeft: profile?.choice_account_id ? 0 : 'auto', background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center' }}
                    title={showBalance ? 'Hide balance' : 'Show balance'}
                  >
                    {showBalance ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>

                {profile?.choice_account_id ? (
                  <>
                    <div className="wallet-mini-amount">
                      {showBalance
                        ? `KES ${Number(cbDashBalance?.balance || 0).toLocaleString()}`
                        : 'KES ••••••'}
                    </div>
                    <div style={{ fontSize: 11, color: '#4b5563', marginBottom: 14, fontFamily: 'monospace', letterSpacing: 0.5 }}>
                      {profile.choice_account_number || profile.choice_account_id}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <div style={{ flex: 1, background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.15)', borderRadius: 9, padding: '9px 10px' }}>
                        <div style={{ color: '#6b7280', fontSize: 10, marginBottom: 3, display: 'flex', alignItems: 'center', gap: 3 }}>
                          <ArrowDownCircle size={10} style={{ color: '#10b981' }} /> Received Today
                        </div>
                        <div style={{ color: '#10b981', fontWeight: 700, fontSize: 14 }}>
                          {showBalance ? `KES ${(todayStats?.kes_volume || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '••••'}
                        </div>
                      </div>
                      <div style={{ flex: 1, background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)', borderRadius: 9, padding: '9px 10px' }}>
                        <div style={{ color: '#6b7280', fontSize: 10, marginBottom: 3, display: 'flex', alignItems: 'center', gap: 3 }}>
                          <ArrowUpCircle size={10} style={{ color: '#ef4444' }} /> Paid Out Today
                        </div>
                        <div style={{ color: '#ef4444', fontWeight: 700, fontSize: 14 }}>
                          {showBalance ? `KES ${(todayStats?.gross_profit != null ? Math.max(0, todayStats.kes_volume - todayStats.gross_profit) : 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '••••'}
                        </div>
                      </div>
                    </div>
                  </>
                ) : (
                  <div style={{ textAlign: 'center', padding: '20px 8px' }}>
                    <div style={{ fontSize: 28, marginBottom: 8 }}>🔒</div>
                    <div style={{ color: '#f59e0b', fontWeight: 700, fontSize: 13, marginBottom: 4 }}>Verification Required</div>
                    <div style={{ color: '#6b7280', fontSize: 11, lineHeight: 1.5 }}>Complete bank verification to see your live Choice Bank balance here.</div>
                  </div>
                )}
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



            {/* ── Trade Credits Progress Bar ── */}
            {(() => {
              const totalCredits = (profile?.trade_tokens || 0) + (profile?.trade_tokens_expiring || 0);
              const refMax = totalCredits >= 2000 ? 8000 : totalCredits >= 500 ? 2000 : totalCredits >= 167 ? 500 : 167;
              const pct = Math.min(100, Math.round((totalCredits / refMax) * 100));
              const barColor = pct > 50 ? '#10b981' : pct > 20 ? '#f59e0b' : '#ef4444';
              const label = totalCredits === 0 ? 'No credits — buy a pack to start trading' : pct <= 20 ? 'Credits running low — top up soon' : 'Trade credits available';
              return (
                <div style={{ margin: '0 0 16px', padding: '14px 20px', background: '#0d1117', border: `1px solid ${pct <= 20 ? 'rgba(239,68,68,0.25)' : pct <= 50 ? 'rgba(245,158,11,0.2)' : 'rgba(16,185,129,0.15)'}`, borderRadius: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 14 }}>🎯</span>
                      <div>
                        <span style={{ color: '#d1d5db', fontSize: 13, fontWeight: 600 }}>Trade Credits</span>
                        <span style={{ color: pct <= 20 ? '#ef4444' : '#6b7280', fontSize: 11, marginLeft: 10 }}>{label}</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                      <div style={{ textAlign: 'right' }}>
                        <span style={{ color: barColor, fontWeight: 800, fontSize: 18 }}>{totalCredits.toLocaleString()}</span>
                        <span style={{ color: '#4b5563', fontSize: 12, marginLeft: 4 }}>/ {refMax.toLocaleString()}</span>
                      </div>
                      <button onClick={() => setActiveTab('credits')}
                        style={{ padding: '5px 14px', borderRadius: 8, border: `1px solid ${barColor}44`, background: 'transparent', color: barColor, fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                        + Buy Credits
                      </button>
                    </div>
                  </div>
                  {/* Track */}
                  <div style={{ height: 8, background: '#1a1d27', borderRadius: 99, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${pct}%`, borderRadius: 99, background: `linear-gradient(90deg, ${barColor}99, ${barColor})`, transition: 'width 0.6s ease' }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5 }}>
                    <span style={{ color: '#374151', fontSize: 10 }}>0</span>
                    <span style={{ color: barColor, fontSize: 10, fontWeight: 600 }}>{pct}% remaining</span>
                    <span style={{ color: '#374151', fontSize: 10 }}>{refMax.toLocaleString()}</span>
                  </div>
                </div>
              );
            })()}

            {/* Row 3: Buy/Sell Breakdown + Profit */}
            <div className="overview-grid-mid">
              {/* Buying Summary */}
              <div className="card buysell-card buying">
                <div className="buysell-header">
                  <ArrowUpCircle size={24} />
                  <h3>Buying</h3>
                </div>
                <div className="buysell-amount">
                  <span className="buysell-crypto">{(stats?.today?.buy_crypto || 0).toFixed(2)} {stats?.today?.dominant_currency || 'USDT'}</span>
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
                  <span className="buysell-crypto">{(stats?.today?.sell_crypto || 0).toFixed(2)} {stats?.today?.dominant_currency || 'USDT'}</span>
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
                    <span>SparkP2P Fees</span>
                    <span>-KES {(stats?.today?.total_fees || 0).toLocaleString()}</span>
                  </div>
                  <div className="profit-row fee-row">
                    <span>Binance Fees ({profile?.binance_merchant_tier || 'bronze'} · KES {stats?.today?.binance_fee_per_trade ?? '0.40'}/trade)</span>
                    <span>-KES {(stats?.today?.binance_fees || 0).toLocaleString()}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Spread Calculator */}
            <SpreadCalculator orderStats={stats?.today} />

            {/* Affiliate Quick-Action Card */}
            {affiliateData !== null && (
              <div className="card" style={{ marginBottom: 16 }}>
                <div className="card-header" style={{ cursor: 'pointer' }} onClick={() => setActiveTab('affiliates')}>
                  <Share2 size={20} style={{ color: '#f59e0b' }} />
                  <h3>Affiliates</h3>
                  {affiliateData?.affiliate?.status === 'approved' && (
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 20, fontSize: 13, color: '#9ca3af' }}>
                      <span><strong style={{ color: '#f59e0b' }}>{affiliateReferrals?.summary?.total_referrals || 0}</strong> referrals</span>
                      <span>Pending: <strong style={{ color: '#10b981' }}>KES {(affiliateData.affiliate.pending_balance || 0).toLocaleString()}</strong></span>
                    </span>
                  )}
                  {affiliateData?.affiliate?.status === 'pending' && (
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: '#f59e0b', fontWeight: 600 }}>⏳ Application under review</span>
                  )}
                  {affiliateData?.affiliate?.status === 'rejected' && (
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: '#ef4444', fontWeight: 600 }}>Application rejected</span>
                  )}
                  <span style={{ marginLeft: affiliateData?.affiliate ? 12 : 'auto', color: '#3b82f6', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {affiliateData?.affiliate ? 'View →' : 'Apply as Affiliate →'}
                  </span>
                </div>
                {!affiliateData?.affiliate && (
                  <div style={{ padding: '8px 0 4px', color: '#9ca3af', fontSize: 13 }}>
                    Earn 10% commission on fees from every trader you refer. <button onClick={() => setActiveTab('affiliates')} style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', fontWeight: 600, padding: 0 }}>Apply now →</button>
                  </div>
                )}
              </div>
            )}

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
                        Last synced: {binanceData.updated_at ? fmtTimeEAT(binanceData.updated_at) : 'Never'}
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

        {activeTab === 'orders' && (() => {
          const loadFiltered = async (filter, page) => {
            const side = filter === 'incoming' ? 'sell' : filter === 'outgoing' ? 'buy' : undefined;
            const res = await getOrders({ limit: 20, offset: (page - 1) * 20, ...(side ? { side } : {}) });
            setOrders(res.data);
            setOrdersHasMore(res.data.length === 20);
          };

          const handleFilterChange = (f) => {
            setOrdersFilter(f);
            setOrdersPage(1);
            loadFiltered(f, 1);
          };

          const handlePageChange = (p) => {
            setOrdersPage(p);
            loadFiltered(ordersFilter, p);
          };

          const incomingCount = orders.filter(o => o.side === 'sell').length;
          const outgoingCount = orders.filter(o => o.side === 'buy').length;

          return (
            <div className="card">
              {/* Sub-tab filter */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[
                    { key: 'all',      label: 'All Orders',  color: '#9ca3af' },
                    { key: 'incoming', label: '↓ Incoming',  color: '#10b981' },
                    { key: 'outgoing', label: '↑ Outgoing',  color: '#3b82f6' },
                  ].map(({ key, label, color }) => (
                    <button key={key} onClick={() => handleFilterChange(key)}
                      style={{ padding: '7px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 13, transition: 'all 0.15s',
                        background: ordersFilter === key ? color : '#1f2937',
                        color: ordersFilter === key ? (key === 'all' ? '#111' : '#fff') : '#6b7280' }}>
                      {label}
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 16 }}>
                  <span style={{ fontSize: 12, color: '#10b981' }}>↓ Incoming = buyers pay you (sell orders)</span>
                  <span style={{ fontSize: 12, color: '#3b82f6' }}>↑ Outgoing = you pay sellers (buy orders)</span>
                </div>
              </div>

              <table className="data-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Amount (KES)</th>
                    <th>Crypto</th>
                    <th>Rate</th>
                    <th>Status</th>
                    <th>Reference</th>
                    <th>Time</th>
                    <th>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.length === 0 ? (
                    <tr><td colSpan={8} style={{ textAlign: 'center', color: '#6b7280', padding: '32px 0' }}>No orders found</td></tr>
                  ) : orders.map((order) => {
                    const { secs, live, overdue } = getOrderDuration(order);
                    const isIncoming = order.side === 'sell';
                    return (
                      <tr key={order.id}>
                        <td>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700,
                            background: isIncoming ? 'rgba(16,185,129,0.12)' : 'rgba(59,130,246,0.12)',
                            color: isIncoming ? '#10b981' : '#3b82f6',
                            border: `1px solid ${isIncoming ? 'rgba(16,185,129,0.3)' : 'rgba(59,130,246,0.3)'}` }}>
                            {isIncoming ? '↓ Incoming' : '↑ Outgoing'}
                          </span>
                        </td>
                        <td style={{ fontWeight: 600 }}>KES {order.fiat_amount.toLocaleString()}</td>
                        <td>{order.crypto_amount} {order.crypto_currency}</td>
                        <td style={{ color: '#9ca3af' }}>{order.exchange_rate}</td>
                        <td style={{ color: getStatusColor(order.status) }}>
                          {order.status.replace(/_/g, ' ')}
                        </td>
                        <td className="mono" style={{ fontSize: 12 }}>{order.account_reference || '—'}</td>
                        <td style={{ fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>{fmtDateEAT(order.created_at)}</td>
                        <td style={{ fontVariantNumeric: 'tabular-nums', color: overdue ? '#f97316' : live ? '#facc15' : '#9ca3af', fontWeight: live ? 600 : 400, whiteSpace: 'nowrap' }}>
                          {overdue && <span title="Binance timer expired" style={{ marginRight: 4 }}>⚠️</span>}
                          {formatDuration(secs)}
                          {live && <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.6 }}>●</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {/* Pagination */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 16 }}>
                <button onClick={() => handlePageChange(Math.max(1, ordersPage - 1))} disabled={ordersPage === 1}
                  style={{ padding: '6px 16px', borderRadius: 8, border: 'none', cursor: ordersPage === 1 ? 'not-allowed' : 'pointer',
                    background: ordersPage === 1 ? '#1f2937' : '#374151', color: ordersPage === 1 ? '#6b7280' : '#f9fafb', fontWeight: 600, fontSize: 13 }}>← Prev</button>
                <span style={{ fontSize: 13, color: '#6b7280' }}>Page {ordersPage}</span>
                <button onClick={() => handlePageChange(ordersPage + 1)} disabled={!ordersHasMore}
                  style={{ padding: '6px 16px', borderRadius: 8, border: 'none', cursor: !ordersHasMore ? 'not-allowed' : 'pointer',
                    background: !ordersHasMore ? '#1f2937' : '#374151', color: !ordersHasMore ? '#6b7280' : '#f9fafb', fontWeight: 600, fontSize: 13 }}>Next →</button>
              </div>
            </div>
          );
        })()}


        {activeTab === 'settings' && <SettingsPanel profile={profile} onUpdate={loadData} initialSection={settingsInitialSection} />}

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
                  const time = fmtTimeEAT(log.time);
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

        {/* ── Affiliates Tab ── */}
        {activeTab === 'affiliates' && (
          <div>
            {/* No affiliate record yet — Apply form */}
            {!affiliateData?.affiliate && (
              <div className="card" style={{ maxWidth: 520, margin: '0 auto' }}>
                <div className="card-header">
                  <Share2 size={20} style={{ color: '#f59e0b' }} />
                  <h3>Become an Affiliate</h3>
                </div>
                <p style={{ color: '#9ca3af', fontSize: 14, margin: '8px 0 20px' }}>
                  Earn <strong style={{ color: '#f59e0b' }}>10% commission</strong> on all fees we collect from every trader you refer — every single order they make. Payouts every Friday for balances ≥ KES 5,000.
                </p>
                {affiliateApplyMsg ? (
                  <div style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid #10b981', borderRadius: 8, padding: '12px 16px', color: '#10b981', fontSize: 14 }}>
                    {affiliateApplyMsg}
                  </div>
                ) : (
                  <button
                    onClick={async () => {
                      setAffiliateApplying(true);
                      try {
                        await applyForAffiliate();
                        setAffiliateApplyMsg('Application submitted! We will review and respond shortly.');
                        await loadAffiliateData();
                      } catch (e) {
                        setAffiliateApplyMsg(e?.response?.data?.detail || 'Failed to submit application.');
                      }
                      setAffiliateApplying(false);
                    }}
                    disabled={affiliateApplying}
                    style={{ width: '100%', padding: '12px 0', borderRadius: 8, border: 'none', background: 'linear-gradient(135deg, #f59e0b, #d97706)', color: '#000', fontWeight: 700, fontSize: 15, cursor: affiliateApplying ? 'not-allowed' : 'pointer', opacity: affiliateApplying ? 0.7 : 1 }}
                  >
                    {affiliateApplying ? 'Submitting...' : 'Apply as Affiliate'}
                  </button>
                )}
              </div>
            )}

            {/* Pending / Rejected state */}
            {affiliateData?.affiliate && affiliateData.affiliate.status !== 'approved' && (
              <div className="card" style={{ maxWidth: 520, margin: '0 auto', textAlign: 'center' }}>
                <Share2 size={40} style={{ color: affiliateData.affiliate.status === 'rejected' ? '#ef4444' : '#f59e0b', margin: '0 auto 12px' }} />
                {affiliateData.affiliate.status === 'pending' && (
                  <>
                    <h3 style={{ color: '#f59e0b', marginBottom: 8 }}>Application Under Review</h3>
                    <p style={{ color: '#9ca3af', fontSize: 14 }}>We've received your application and will review it shortly. You'll be notified once approved.</p>
                  </>
                )}
                {affiliateData.affiliate.status === 'rejected' && (
                  <>
                    <h3 style={{ color: '#ef4444', marginBottom: 8 }}>Application Rejected</h3>
                    <p style={{ color: '#9ca3af', fontSize: 14 }}>Unfortunately your application was not approved at this time. Contact support for details.</p>
                  </>
                )}
              </div>
            )}

            {/* Approved affiliate dashboard */}
            {affiliateData?.affiliate?.status === 'approved' && (
              <>
                {/* Stats row */}
                <div className="overview-stats-row" style={{ marginBottom: 16 }}>
                  <div className="mini-stat-card">
                    <Users size={18} style={{ color: '#3b82f6', marginBottom: 4 }} />
                    <span className="mini-stat-value">{affiliateReferrals?.summary?.total_referrals || 0}</span>
                    <span className="mini-stat-label">Referrals</span>
                  </div>
                  <div className="mini-stat-card">
                    <TrendingUp size={18} style={{ color: '#10b981', marginBottom: 4 }} />
                    <span className="mini-stat-value">KES {(affiliateData.affiliate.pending_balance || 0).toLocaleString()}</span>
                    <span className="mini-stat-label">Pending Payout</span>
                  </div>
                  <div className="mini-stat-card">
                    <DollarSign size={18} style={{ color: '#f59e0b', marginBottom: 4 }} />
                    <span className="mini-stat-value">KES {(affiliateData.affiliate.total_earned || 0).toLocaleString()}</span>
                    <span className="mini-stat-label">Total Earned</span>
                  </div>
                  <div className="mini-stat-card">
                    <BarChart2 size={18} style={{ color: '#8b5cf6', marginBottom: 4 }} />
                    <span className="mini-stat-value">KES {(affiliateReferrals?.summary?.this_week_earnings || 0).toLocaleString()}</span>
                    <span className="mini-stat-label">This Week</span>
                  </div>
                </div>

                {/* Referral link card */}
                <div className="card" style={{ marginBottom: 16 }}>
                  <div className="card-header">
                    <Share2 size={18} style={{ color: '#f59e0b' }} />
                    <h3>Your Referral Link</h3>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                    <div style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', fontFamily: 'monospace', fontSize: 13, color: '#e5e7eb', wordBreak: 'break-all' }}>
                      {affiliateData.affiliate.referral_link || `https://sparkp2p.com/login?ref=${affiliateData.affiliate.referral_code}`}
                    </div>
                    <button
                      onClick={() => {
                        const link = affiliateData.affiliate.referral_link || `https://sparkp2p.com/login?ref=${affiliateData.affiliate.referral_code}`;
                        navigator.clipboard.writeText(link).then(() => { setAffiliateCopied(true); setTimeout(() => setAffiliateCopied(false), 2000); });
                      }}
                      style={{ padding: '10px 16px', borderRadius: 8, border: 'none', background: affiliateCopied ? '#10b981' : '#3b82f6', color: '#fff', fontWeight: 600, cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}
                    >
                      <Copy size={14} /> {affiliateCopied ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                  <p style={{ color: '#6b7280', fontSize: 12, marginTop: 8 }}>
                    Code: <strong style={{ color: '#f59e0b' }}>{affiliateData.affiliate.referral_code}</strong> · Share this link and earn 10% of all fees from every trader who signs up through it.
                  </p>
                </div>

                {/* Referrals list */}
                <div className="card">
                  <div className="card-header">
                    <Users size={18} />
                    <h3>Your Referrals</h3>
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: '#6b7280' }}>{(affiliateReferrals?.referrals || []).length} trader{(affiliateReferrals?.referrals || []).length !== 1 ? 's' : ''}</span>
                  </div>
                  {(affiliateReferrals?.referrals || []).length === 0 ? (
                    <p className="empty-msg" style={{ padding: '20px 0' }}>No referrals yet. Share your link to start earning.</p>
                  ) : (
                    <div style={{ marginTop: 8 }}>
                      {(affiliateReferrals?.referrals || []).map((ref, i) => (
                        <div key={i} style={{ borderBottom: i < affiliateReferrals.referrals.length - 1 ? '1px solid var(--border)' : 'none' }}>
                          <div
                            style={{ display: 'flex', alignItems: 'center', padding: '12px 4px', cursor: ref.weekly_breakdown?.length > 0 ? 'pointer' : 'default' }}
                            onClick={() => ref.weekly_breakdown?.length > 0 && setExpandedReferral(expandedReferral === i ? null : i)}
                          >
                            <div style={{ flex: 1 }}>
                              <div style={{ fontWeight: 600, color: '#e5e7eb', fontSize: 14 }}>{ref.trader_name}</div>
                              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                                Joined {ref.joined_at ? new Date(ref.joined_at).toLocaleDateString('en-KE') : '—'}
                              </div>
                            </div>
                            <div style={{ textAlign: 'right', marginRight: ref.weekly_breakdown?.length > 0 ? 8 : 0 }}>
                              <div style={{ fontWeight: 700, color: '#10b981', fontSize: 14 }}>KES {(ref.total_earned || 0).toLocaleString()}</div>
                              <div style={{ fontSize: 11, color: '#6b7280' }}>Total earned</div>
                            </div>
                            {ref.weekly_breakdown?.length > 0 && (
                              expandedReferral === i ? <ChevronUp size={16} color="#6b7280" /> : <ChevronDown size={16} color="#6b7280" />
                            )}
                          </div>
                          {expandedReferral === i && ref.weekly_breakdown?.length > 0 && (
                            <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: '8px 12px', marginBottom: 8 }}>
                              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                <thead>
                                  <tr style={{ color: '#6b7280' }}>
                                    <th style={{ textAlign: 'left', padding: '4px 0', fontWeight: 500 }}>Week</th>
                                    <th style={{ textAlign: 'right', padding: '4px 0', fontWeight: 500 }}>Orders</th>
                                    <th style={{ textAlign: 'right', padding: '4px 0', fontWeight: 500 }}>Commission</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {ref.weekly_breakdown.map((w, wi) => (
                                    <tr key={wi} style={{ color: '#d1d5db' }}>
                                      <td style={{ padding: '4px 0' }}>Week of {new Date(w.week_start).toLocaleDateString('en-KE')}</td>
                                      <td style={{ padding: '4px 0', textAlign: 'right' }}>{w.order_count}</td>
                                      <td style={{ padding: '4px 0', textAlign: 'right', color: '#10b981', fontWeight: 600 }}>KES {(w.commission || 0).toLocaleString()}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
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
                <span style={{ color: '#fff', fontWeight: 600 }}>444174</span>
                <span style={{ color: '#9ca3af' }}>Account Number</span>
                <span style={{ color: '#f59e0b', fontWeight: 600 }}>{profile?.choice_account_number || profile?.choice_account_id || 'Pending'}</span>
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

        {/* ==================== BUY CREDITS TAB ==================== */}
        {activeTab === 'credits' && (() => {
          const PLANS = [
            { key: 'starter',  label: 'Starter',  icon: '⚡', amount: 5000,  credits: 167,  rate: 30, savings: 25, grad: 'linear-gradient(135deg,#374151,#1f2937)', accent: '#9ca3af', glow: '107,114,128', badge: null },
            { key: 'pro',      label: 'Pro',       icon: '🔥', amount: 10000, credits: 500,  rate: 20, savings: 50, grad: 'linear-gradient(135deg,#78350f,#451a03)', accent: '#f59e0b', glow: '245,158,11',  badge: null },
            { key: 'pro_max',  label: 'Pro Max',   icon: '🚀', amount: 20000, credits: 2000, rate: 10, savings: 75, grad: 'linear-gradient(135deg,#064e3b,#022c22)', accent: '#10b981', glow: '16,185,129',  badge: 'Most Popular' },
            { key: 'advanced', label: 'Advanced',  icon: '💎', amount: 40000, credits: 8000, rate: 5,  savings: 87, grad: 'linear-gradient(135deg,#4c1d95,#2e1065)', accent: '#a78bfa', glow: '139,92,246',  badge: 'Best Value' },
          ];

          const handleBuyCredits = async () => {
            if (!creditPlan || !creditPhone.trim()) { setCreditMsg({ type: 'error', text: 'Select a plan and enter your M-Pesa number.' }); return; }
            setCreditBuying(true); setCreditMsg(null);
            try {
              const res = await purchaseCredits(creditPlan, creditPhone.trim());
              const checkoutId = res.data.checkout_id;
              setCreditCheckoutId(checkoutId);
              setCreditMsg({ type: 'info', text: res.data.message });
              setCreditPolling(true);
              const interval = setInterval(async () => {
                try {
                  const s = await pollCreditsStatus(checkoutId);
                  if (s.data.status === 'completed') {
                    clearInterval(interval);
                    setCreditPolling(false);
                    setCreditCheckoutId(null);
                    setCreditMsg({ type: 'success', text: '✔ Payment confirmed! Credits have been added to your account.' });
                    setCreditPlan(null);
                    setCreditPhone('');
                    if (typeof loadData === 'function') loadData();
                  }
                } catch {}
              }, 5000);
              setTimeout(() => { clearInterval(interval); if (creditPolling) { setCreditPolling(false); setCreditMsg({ type: 'warning', text: 'Payment not yet confirmed. If you completed payment, your credits will appear shortly.' }); } }, 120000);
            } catch (err) {
              setCreditMsg({ type: 'error', text: err?.response?.data?.detail || 'Failed to send STK Push. Try again.' });
            }
            setCreditBuying(false);
          };

          const sel = PLANS.find(p => p.key === creditPlan);

          return (
            <div style={{ maxWidth: 900, margin: '0 auto', padding: '4px 0 40px' }}>

              {/* Header */}
              <div style={{ textAlign: 'center', marginBottom: 36 }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: 20, padding: '5px 14px', marginBottom: 16 }}>
                  <DollarSign size={13} color="#10b981" />
                  <span style={{ color: '#10b981', fontSize: 12, fontWeight: 600 }}>Trade Credits — Never Expire</span>
                </div>
                <h2 style={{ color: '#fff', fontSize: 26, fontWeight: 800, margin: '0 0 8px', letterSpacing: '-0.5px' }}>Choose Your Credit Pack</h2>
                <p style={{ color: '#6b7280', fontSize: 13, margin: '0 0 12px' }}>1 credit = 1 bot-completed buy order. Buy once, use forever.</p>
                {(() => {
                  const tc = (profile?.trade_tokens || 0) + (profile?.trade_tokens_expiring || 0);
                  const rm = tc >= 2000 ? 8000 : tc >= 500 ? 2000 : tc >= 167 ? 500 : 167;
                  const pp = Math.min(100, Math.round((tc / rm) * 100));
                  const bc = pp > 50 ? '#10b981' : pp > 20 ? '#f59e0b' : '#ef4444';
                  return (
                    <div style={{ display: 'inline-block', background: '#0d1117', border: '1px solid #1f2937', borderRadius: 12, padding: '10px 20px', minWidth: 220 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ color: '#6b7280', fontSize: 12 }}>Your balance</span>
                        <span style={{ color: bc, fontWeight: 800, fontSize: 16 }}>{tc.toLocaleString()} <span style={{ fontSize: 11, fontWeight: 500, color: '#6b7280' }}>credits</span></span>
                      </div>
                      <div style={{ height: 6, background: '#1a1d27', borderRadius: 99, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${pp}%`, background: `linear-gradient(90deg,${bc}88,${bc})`, borderRadius: 99, transition: 'width 0.6s ease' }} />
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                        <span style={{ color: '#374151', fontSize: 10 }}>0</span>
                        <span style={{ color: bc, fontSize: 10, fontWeight: 600 }}>{pp}%</span>
                        <span style={{ color: '#374151', fontSize: 10 }}>{rm.toLocaleString()}</span>
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* Plan cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 32 }}>
                {PLANS.map(p => {
                  const isSelected = creditPlan === p.key;
                  const isFeatured = p.badge === 'Most Popular';
                  return (
                    <div key={p.key} onClick={() => { setCreditPlan(p.key); setCreditMsg(null); }}
                      style={{ position: 'relative', borderRadius: 18, cursor: 'pointer', userSelect: 'none', transition: 'transform 0.15s, box-shadow 0.15s',
                        transform: isSelected ? 'translateY(-4px)' : isFeatured ? 'translateY(-2px)' : 'none',
                        boxShadow: isSelected ? `0 0 0 2px ${p.accent}, 0 12px 40px rgba(${p.glow},0.3)` : isFeatured ? `0 8px 30px rgba(${p.glow},0.2)` : '0 2px 8px rgba(0,0,0,0.3)',
                        border: `1px solid ${isSelected ? p.accent : isFeatured ? `rgba(${p.glow},0.4)` : '#1f2937'}`,
                        background: '#0d1117', overflow: 'hidden' }}>

                      {/* Gradient top stripe */}
                      <div style={{ height: 4, background: p.grad.replace('135deg', '90deg'), backgroundImage: `linear-gradient(90deg, ${p.accent}88, ${p.accent})` }} />

                      {/* Badge */}
                      {p.badge && (
                        <div style={{ position: 'absolute', top: 16, right: 14, background: p.accent, color: p.accent === '#f59e0b' ? '#000' : '#000', fontSize: 9, fontWeight: 800, padding: '3px 9px', borderRadius: 20, letterSpacing: '0.5px', textTransform: 'uppercase' }}>{p.badge}</div>
                      )}

                      <div style={{ padding: '18px 20px 20px' }}>
                        {/* Icon + name */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                          <div style={{ width: 36, height: 36, borderRadius: 10, background: `rgba(${p.glow},0.15)`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>{p.icon}</div>
                          <div>
                            <div style={{ color: p.accent, fontWeight: 800, fontSize: 13, letterSpacing: '0.3px' }}>{p.label}</div>
                            <div style={{ color: '#4b5563', fontSize: 10 }}>Save {p.savings}%</div>
                          </div>
                        </div>

                        {/* Credits — main focal point */}
                        <div style={{ marginBottom: 4 }}>
                          <span style={{ fontSize: 36, fontWeight: 900, color: '#fff', lineHeight: 1, letterSpacing: '-1px' }}>{p.credits.toLocaleString()}</span>
                          <span style={{ fontSize: 14, color: '#6b7280', marginLeft: 5, fontWeight: 500 }}>credits</span>
                        </div>

                        {/* Divider */}
                        <div style={{ height: 1, background: '#1a1d27', margin: '12px 0' }} />

                        {/* Price */}
                        <div style={{ marginBottom: 3 }}>
                          <span style={{ color: '#fff', fontSize: 20, fontWeight: 800 }}>KES {p.amount.toLocaleString()}</span>
                        </div>
                        <div style={{ color: '#4b5563', fontSize: 11 }}>KES {p.rate} per credit</div>

                        {/* Select button */}
                        <button style={{ width: '100%', marginTop: 16, padding: '9px 0', borderRadius: 9, border: isSelected ? 'none' : `1px solid ${p.accent}44`, cursor: 'pointer', fontWeight: 700, fontSize: 13, transition: 'background 0.15s',
                          background: isSelected ? p.accent : 'transparent',
                          color: isSelected ? (p.accent === '#9ca3af' ? '#111' : '#000') : p.accent }}>
                          {isSelected ? '✓ Selected' : 'Select Plan'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Payment panel */}
              {sel && (
                <div style={{ background: '#0d1117', border: `1px solid rgba(${sel.glow},0.3)`, borderRadius: 18, padding: 28, boxShadow: `0 0 40px rgba(${sel.glow},0.08)` }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 20 }}>

                    {/* Summary */}
                    <div style={{ flex: '1 1 220px' }}>
                      <div style={{ color: '#6b7280', fontSize: 12, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600 }}>Order Summary</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                        <div style={{ width: 40, height: 40, borderRadius: 10, background: `rgba(${sel.glow},0.15)`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>{sel.icon}</div>
                        <div>
                          <div style={{ color: '#fff', fontWeight: 700, fontSize: 14 }}>{sel.label} Pack</div>
                          <div style={{ color: '#6b7280', fontSize: 12 }}>{sel.credits.toLocaleString()} permanent credits</div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 20 }}>
                        <div><div style={{ color: '#6b7280', fontSize: 11 }}>Total</div><div style={{ color: '#fff', fontWeight: 800, fontSize: 18 }}>KES {sel.amount.toLocaleString()}</div></div>
                        <div><div style={{ color: '#6b7280', fontSize: 11 }}>Rate</div><div style={{ color: sel.accent, fontWeight: 700, fontSize: 14 }}>KES {sel.rate}/credit</div></div>
                        <div><div style={{ color: '#6b7280', fontSize: 11 }}>Savings</div><div style={{ color: '#10b981', fontWeight: 700, fontSize: 14 }}>{sel.savings}% off</div></div>
                      </div>
                    </div>

                    {/* Payment form */}
                    <div style={{ flex: '1 1 280px' }}>
                      <div style={{ color: '#6b7280', fontSize: 12, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600 }}>Pay via M-Pesa</div>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <input
                          type="tel"
                          placeholder="e.g. 0712 345 678"
                          value={creditPhone}
                          onChange={e => setCreditPhone(e.target.value)}
                          disabled={creditBuying || creditPolling}
                          style={{ flex: 1, background: '#13151f', border: `1px solid ${sel.accent}33`, borderRadius: 10, color: '#fff', padding: '11px 14px', fontSize: 14, outline: 'none' }}
                        />
                        <button
                          onClick={handleBuyCredits}
                          disabled={creditBuying || creditPolling || !creditPhone.trim()}
                          style={{ flexShrink: 0, padding: '11px 22px', borderRadius: 10, border: 'none', background: (creditBuying || creditPolling || !creditPhone.trim()) ? '#1f2937' : sel.accent, color: (creditBuying || creditPolling || !creditPhone.trim()) ? '#4b5563' : (sel.accent === '#9ca3af' ? '#111' : '#000'), fontWeight: 800, fontSize: 14, cursor: (creditBuying || creditPolling || !creditPhone.trim()) ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}>
                          {creditPolling ? 'Waiting...' : creditBuying ? 'Sending...' : 'Pay Now'}
                        </button>
                      </div>
                      {creditPolling && (
                        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#f59e0b', animation: 'pulse 1.5s ease-in-out infinite' }} />
                          <span style={{ color: '#9ca3af', fontSize: 12 }}>Check your phone for the M-Pesa PIN prompt...</span>
                        </div>
                      )}
                      {creditMsg && (
                        <div style={{ marginTop: 10, padding: '8px 14px', borderRadius: 9, fontSize: 12,
                          background: creditMsg.type === 'success' ? 'rgba(16,185,129,0.1)' : creditMsg.type === 'error' ? 'rgba(239,68,68,0.1)' : creditMsg.type === 'warning' ? 'rgba(245,158,11,0.1)' : 'rgba(59,130,246,0.08)',
                          color: creditMsg.type === 'success' ? '#10b981' : creditMsg.type === 'error' ? '#ef4444' : creditMsg.type === 'warning' ? '#f59e0b' : '#60a5fa',
                          border: `1px solid ${creditMsg.type === 'success' ? 'rgba(16,185,129,0.2)' : creditMsg.type === 'error' ? 'rgba(239,68,68,0.2)' : creditMsg.type === 'warning' ? 'rgba(245,158,11,0.2)' : 'rgba(59,130,246,0.15)'}` }}>
                          {creditMsg.text}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

            </div>
          );
        })()}


      <SupportChat forceOpen={openSupportChat} onOpen={() => setOpenSupportChat(false)} />

      {/* ── Configure Bot Modal ── */}
      {showConfigModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget) setShowConfigModal(false); }}>
          <div style={{ background: '#13151f', border: '1px solid #1f2937', borderRadius: 14, padding: 28, width: 460, maxWidth: '90vw', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <SlidersHorizontal size={20} color="#f59e0b" />
                <h3 style={{ color: '#fff', fontSize: 16, fontWeight: 700, margin: 0 }}>Configure Bot</h3>
              </div>
              <button onClick={() => setShowConfigModal(false)} style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', padding: 4 }}><X size={18} /></button>
            </div>

            <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 20 }}>
              Choose which order types the bot should automate. Orders outside the selected mode stay visible on Binance — you complete them manually.
            </p>

            {[
              {
                value: 'both',
                label: 'Buy & Sell (default)',
                desc: 'Bot fully automates both sides — pays sellers for incoming buy orders and releases USDT to buyers for sell orders.',
                note: null,
              },
              {
                value: 'buy_only',
                label: 'Buy orders only',
                desc: 'Bot pays sellers and acquires USDT automatically when buyers place orders.',
                note: 'Sell orders will not be automated. If a buyer places a sell order your ad is still live, you must release USDT to them manually on Binance.',
              },
              {
                value: 'sell_only',
                label: 'Sell orders only',
                desc: 'Bot receives M-Pesa payments and releases USDT to buyers automatically.',
                note: 'Buy orders will not be automated. If a seller lists an offer matching your buy ad, you must pay them and complete the order manually on Binance.',
              },
            ].map(opt => (
              <label key={opt.value} onClick={() => setBotTradeMode(opt.value)}
                style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 14px', borderRadius: 10, border: `1px solid ${botTradeMode === opt.value ? '#f59e0b' : '#1f2937'}`, background: botTradeMode === opt.value ? 'rgba(245,158,11,0.06)' : 'transparent', marginBottom: 10, cursor: 'pointer', transition: 'all 0.15s' }}>
                <div style={{ width: 18, height: 18, borderRadius: '50%', border: `2px solid ${botTradeMode === opt.value ? '#f59e0b' : '#374151'}`, background: botTradeMode === opt.value ? '#f59e0b' : 'transparent', flexShrink: 0, marginTop: 2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {botTradeMode === opt.value && <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#000' }} />}
                </div>
                <div>
                  <div style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 600, marginBottom: 3 }}>{opt.label}</div>
                  <div style={{ color: '#9ca3af', fontSize: 12, lineHeight: 1.4 }}>{opt.desc}</div>
                  {opt.note && (
                    <div style={{ marginTop: 6, fontSize: 11, color: '#f59e0b', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.18)', borderRadius: 6, padding: '5px 8px', lineHeight: 1.4 }}>
                      ⚠ {opt.note}
                    </div>
                  )}
                </div>
              </label>
            ))}

            {/* ── Counterparty Screening ── */}
            <div style={{ borderTop: '1px solid #1f2937', marginTop: 8, paddingTop: 20, marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <div>
                  <div style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 700 }}>Counterparty Screening</div>
                  <div style={{ color: '#6b7280', fontSize: 12, marginTop: 2 }}>
                    {tgConnectedForConfig ? 'Buyer details sent to your Telegram for approval before payment is shared' : 'Screen buyers automatically before sharing payment details'}
                  </div>
                </div>
                <div onClick={() => setDdEnabled(v => !v)}
                  style={{ width: 40, height: 22, borderRadius: 11, background: ddEnabled ? '#f59e0b' : '#374151', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
                  <div style={{ position: 'absolute', top: 3, left: ddEnabled ? 20 : 3, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
                </div>
              </div>

              {ddEnabled && (
                <div style={{ marginTop: 12 }}>
                  {tgConnectedForConfig ? (
                    <div style={{ background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: 10, padding: '14px 16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.8a19.79 19.79 0 01-3.07-8.63A2 2 0 012 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 14.92z"/></svg>
                        <span style={{ color: '#10b981', fontSize: 13, fontWeight: 700 }}>Telegram screening active</span>
                      </div>
                      {[
                        'Every new sell order pauses — buyer stats are sent to your Telegram before payment details are shared',
                        'You receive: buyer trade count, 30-day activity, avg pay time, completion rate, and whether they have traded with you before',
                        'Tap YES on Telegram to approve — the bot immediately sends payment details to the buyer',
                        'Tap NO to reject — the bot sends a polite excuse message and waits for the buyer to cancel',
                        'Returning buyers who have previously traded with you bypass the gate automatically',
                        'If you do not respond within 10 minutes, the order is skipped and re-evaluated next cycle',
                      ].map((item, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
                          <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#10b981', flexShrink: 0, marginTop: 6 }} />
                          <span style={{ color: '#d1d5db', fontSize: 12, lineHeight: 1.5 }}>{item}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 10, padding: '16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                        <span style={{ color: '#f59e0b', fontSize: 13, fontWeight: 700 }}>Telegram not connected</span>
                      </div>
                      <p style={{ margin: '0 0 14px', color: '#9ca3af', fontSize: 12, lineHeight: 1.6 }}>
                        You need to connect your Telegram first to use this feature. Once connected, every new sell order will send buyer details to your Telegram for you to approve or reject before payment info is shared.
                      </p>
                      <button
                        onClick={() => { setShowConfigModal(false); setSettingsInitialSection('notifications'); setActiveTab('settings'); }}
                        style={{ width: '100%', padding: '9px 0', borderRadius: 8, border: '1px solid rgba(245,158,11,0.5)', background: 'rgba(245,158,11,0.12)', color: '#f59e0b', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}
                      >
                        Connect Telegram → Settings / Notifications
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {configSaved && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px 0', borderRadius: 8, background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.3)', marginBottom: 8 }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                <span style={{ color: '#10b981', fontWeight: 600, fontSize: 14 }}>Bot configured successfully</span>
              </div>
            )}
            <button
              onClick={async () => {
                setSavingConfig(true);
                try {
                  await api.put('/traders/trading-config', { bot_trade_mode: botTradeMode, dd_enabled: ddEnabled, dd_min_30d_trades: ddMin30d, dd_min_all_trades: ddMinAll });
                  configSavedAt.current = Date.now();
                  setConfigSaved(true);
                  setTimeout(() => { setConfigSaved(false); setShowConfigModal(false); }, 1500);
                } catch (e) {}
                setSavingConfig(false);
              }}
              disabled={savingConfig || configSaved}
              style={{ width: '100%', marginTop: 8, padding: '11px 0', borderRadius: 8, border: 'none', background: 'linear-gradient(135deg,#f59e0b,#d97706)', color: '#000', fontWeight: 700, fontSize: 14, cursor: savingConfig || configSaved ? 'default' : 'pointer', opacity: savingConfig || configSaved ? 0.6 : 1 }}
            >
              {savingConfig ? 'Saving...' : 'Save Configuration'}
            </button>
          </div>
        </div>
      )}

      {/* Merchant Tier Modal — shown once for traders who haven't set their Binance tier */}
      {showTierModal && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div style={{ background: '#1a1d27', borderRadius: 16, padding: 32, maxWidth: 480, width: '100%', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 24px 64px rgba(0,0,0,0.6)' }}>
            <div style={{ textAlign: 'center', marginBottom: 8 }}>
              <div style={{ fontSize: 36, marginBottom: 8 }}>🏅</div>
              <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>What is your Binance Merchant Tier?</h2>
              <p style={{ margin: '8px 0 0', fontSize: 13, color: '#9ca3af' }}>
                Your tier determines the fee Binance deducts per trade. We use this to calculate your accurate net profit.
              </p>
            </div>

            <div style={{ display: 'flex', gap: 12, margin: '24px 0', flexWrap: 'wrap' }}>
              {[
                { value: 'gold',   label: 'Gold',   fee: '0.25', color: '#f59e0b', badge: '🥇', desc: 'Highest tier' },
                { value: 'silver', label: 'Silver', fee: '0.35', color: '#9ca3af', badge: '🥈', desc: 'Mid tier' },
                { value: 'bronze', label: 'Bronze', fee: '0.40', color: '#b45309', badge: '🥉', desc: 'Standard tier' },
              ].map(({ value, label, fee, color, badge, desc }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setTierModalSelection(value)}
                  style={{
                    flex: 1, minWidth: 110, padding: '18px 10px', borderRadius: 12, cursor: 'pointer',
                    border: `2px solid ${tierModalSelection === value ? color : '#374151'}`,
                    background: tierModalSelection === value ? `${color}22` : '#111827',
                    color: '#f9fafb', textAlign: 'center', transition: 'all 0.15s',
                    boxShadow: tierModalSelection === value ? `0 0 0 3px ${color}44` : 'none',
                  }}
                >
                  <div style={{ fontSize: 28, marginBottom: 6 }}>{badge}</div>
                  <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 2 }}>{label}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 6 }}>{desc}</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color, background: `${color}18`, borderRadius: 6, padding: '4px 0' }}>
                    KES {fee} / trade
                  </div>
                </button>
              ))}
            </div>

            {tierModalSelection && (
              <div style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: 10, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#6ee7b7' }}>
                At <strong>{tierModalSelection}</strong> tier — every completed P2P trade costs you <strong>KES {tierModalSelection === 'gold' ? '0.25' : tierModalSelection === 'silver' ? '0.35' : '0.40'}</strong> in Binance fees. This will be deducted from your net profit calculation.
              </div>
            )}

            <button
              disabled={!tierModalSelection || tierModalSaving}
              onClick={async () => {
                if (!tierModalSelection) return;
                setTierModalSaving(true);
                try {
                  await updateProfile({ binance_merchant_tier: tierModalSelection });
                  setProfile(p => ({ ...p, binance_merchant_tier: tierModalSelection }));
                  setShowTierModal(false);
                } catch {}
                setTierModalSaving(false);
              }}
              style={{
                width: '100%', padding: '13px 0', borderRadius: 10, border: 'none',
                background: tierModalSelection ? 'linear-gradient(135deg,#10b981,#059669)' : '#374151',
                color: '#fff', fontWeight: 700, fontSize: 15, cursor: tierModalSelection ? 'pointer' : 'not-allowed',
                opacity: tierModalSaving ? 0.7 : 1, transition: 'all 0.15s',
              }}
            >
              {tierModalSaving ? 'Saving…' : tierModalSelection ? `Confirm — I'm a ${tierModalSelection.charAt(0).toUpperCase() + tierModalSelection.slice(1)} Merchant` : 'Select your tier above'}
            </button>
            <p style={{ textAlign: 'center', fontSize: 12, color: '#6b7280', marginTop: 12 }}>
              You can change this anytime in Settings → Trading
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
