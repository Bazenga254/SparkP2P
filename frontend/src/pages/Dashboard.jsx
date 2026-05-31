import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import api, { getProfile, getWallet, getOrderStats, getOrders, requestWithdrawal, requestWithdrawalOtp, getWalletTransactions, getSessionHealth, getBinanceAccountData, getMarketPrices, getMyAdPrices, getTodayStats, initiateDeposit, getDepositHistory, checkDepositStatus, internalTransfer, getSystemStatus, getMyAffiliate, getMyReferrals, getMyPayouts, applyForAffiliate, updateProfile, purchaseCredits, pollCreditsStatus, choiceGetBalance, choiceDeposit, getMyTransactions, getCbWithdrawalBank, saveCbWithdrawalBank, cbWithdrawToBank, cbWithdrawInitiate, cbWithdrawToMpesaInitiate } from '../services/api';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Wallet, TrendingUp, TrendingDown, ArrowDownCircle, ArrowUpCircle, ArrowDown, ArrowUp, RefreshCw, LogOut, Settings, Clock, Shield, Plus, X, Bell, Copy, CreditCard, Eye, EyeOff, MessageSquare, Activity, BarChart2, DollarSign, Repeat, SlidersHorizontal, Share2, Users, ChevronDown, ChevronUp, LayoutDashboard, List, ArrowRightLeft, MoreHorizontal, Wifi } from 'lucide-react';
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 12, padding: '12px 0 0', alignItems: 'end' }}>
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
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 12, marginTop: 10 }}>

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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 12 }}>

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
  const [showCbDepositModal, setShowCbDepositModal] = useState(false);
  const [cbDepositAmount, setCbDepositAmount] = useState('');
  const [cbDepositLoading, setCbDepositLoading] = useState(false);
  const [cbDepositMsg, setCbDepositMsg] = useState('');
  const [cbDepositPhone, setCbDepositPhone] = useState('');
  const [txFilter, setTxFilter] = useState('all');
  const [showCbWithdrawModal, setShowCbWithdrawModal] = useState(false);
  const [cbWithdrawAmount, setCbWithdrawAmount] = useState('');
  const [cbWithdrawOtp, setCbWithdrawOtp] = useState('');
  const [cbWithdrawOtpSent, setCbWithdrawOtpSent] = useState(false);
  const [cbWithdrawChannel, setCbWithdrawChannel] = useState('mpesa'); // 'mpesa' | 'bank'
  const [cbWithdrawOtpLoading, setCbWithdrawOtpLoading] = useState(false);
  const [cbWithdrawLoading, setCbWithdrawLoading] = useState(false);
  const [cbWithdrawMsg, setCbWithdrawMsg] = useState('');
  const [cbWithdrawBank, setCbWithdrawBank] = useState(null);
  const [allTxns, setAllTxns] = useState([]);
  const [allTxnsLoading, setAllTxnsLoading] = useState(false);
  const [expandedWithdrawals, setExpandedWithdrawals] = useState({});
  const [depositPage, setDepositPage] = useState(1);
  const [withdrawalPage, setWithdrawalPage] = useState(1);
  const [sweepSecondsLeft, setSweepSecondsLeft] = useState(0);
  const [activeTab, setActiveTab] = useState('overview');
  const [mobMoreOpen, setMobMoreOpen] = useState(false);
  const [creditPlan, setCreditPlan] = useState(null);
  const [creditPhone, setCreditPhone] = useState('');
  const [payGoAmount, setPayGoAmount] = useState('500');
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
  useEffect(() => { if (activeTab !== 'logs') window.scrollTo(0, 0); }, [activeTab]);
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
  const [cfEnabled, setCfEnabled] = useState(false);
  const [cfAllTradesMin, setCfAllTradesMin] = useState('0');
  const [cfAllTradesMinAll, setCfAllTradesMinAll] = useState('0');
  const [cfSync, setCfSync] = useState(null); // live Binance sync status: { available, synced, expected, binance_values }
  const checkCfSync = async () => {
    try { const r = await api.get('/traders/cf-sync-status'); setCfSync(r.data); } catch { setCfSync(null); }
  };
  const [profitData, setProfitData] = useState(null); // live daily profit from Binance order history (EP-16)
  const fetchProfit = async () => {
    try { const r = await api.get('/traders/profit-breakdown'); if (r.data?.available) setProfitData(r.data); } catch {}
  };
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
        api.get('/traders/binance-orders', { params: { limit: 20, offset: 0 } }),
        getWalletTransactions(50, 'positive'),
        getSessionHealth(),
        getBinanceAccountData(),
        getWalletTransactions(100, 'negative'),
      ]);
      if (results[0].status === 'fulfilled') { const p = results[0].value.data; setProfile(p); if (!p.binance_merchant_tier) setShowTierModal(true); if (Date.now() - configSavedAt.current > 30000) { setBotTradeMode(p.bot_trade_mode || 'both'); setDdEnabled(p.dd_enabled || false); setDdMin30d(p.dd_min_30d_trades ?? 20); setDdMinAll(p.dd_min_all_trades ?? 0); setDdAutoCancelNew(p.dd_auto_cancel_new || false); setTgApprovalEnabled(p.telegram_approval_enabled || false); setTgConnectedForConfig(p.telegram_connected || false); setCfEnabled(p.cf_filters_enabled || false); setCfAllTradesMin(String(p.cf_all_trades_min ?? 0)); setCfAllTradesMinAll(String(p.cf_all_trades_min_all ?? 0)); } }
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

  // Web presence heartbeat — marks this trader online while the dashboard is open
  useEffect(() => {
    const ping = () => { api.post('/traders/web-heartbeat').catch(() => {}); };
    ping();
    const id = setInterval(ping, 60000);
    return () => clearInterval(id);
  }, []);

  // Live daily profit from real Binance order history — refresh every 60s on Overview
  useEffect(() => {
    fetchProfit();
    const id = setInterval(fetchProfit, 60000);
    return () => clearInterval(id);
  }, []);

  // Live counterparty-filter sync check when the Configure tab opens
  useEffect(() => {
    if (activeTab === 'configure' || showConfigModal) checkCfSync();
  }, [activeTab, showConfigModal]);

  // Orders tab — load REAL Binance order history (EP-16), with filter + pagination, refresh 20s
  useEffect(() => {
    if (activeTab !== 'orders') return;
    const side = ordersFilter === 'all' ? '' : ordersFilter;
    const load = async () => {
      try {
        const res = await api.get('/traders/binance-orders', { params: { limit: 20, offset: (ordersPage - 1) * 20, side } });
        setOrders(res.data);
        setOrdersHasMore(res.data.length === 20);
      } catch (_) {}
    };
    load();
    const id = setInterval(load, 20000);
    return () => clearInterval(id);
  }, [activeTab, ordersFilter, ordersPage]);

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
    return m;
  })();
  const showSetupBanner = (setupMissing.length > 0 || missingConnections.length > 0) && !setupDismissed;
  const bannerMissing = setupMissing.length > 0 ? setupMissing : missingConnections;

  useEffect(() => {
    // Show the REAL installed desktop version via the preload bridge (works over https,
    // unlike the http://127.0.0.1 fetch which browsers block as mixed content).
    // Fall back to the build-time constant for plain web browsers.
    setAppVersion(__APP_VERSION__);
    try {
      if (window.sparkp2p?.getBotStatus) {
        window.sparkp2p.getBotStatus().then(s => { if (s?.version) setAppVersion(s.version); }).catch(() => {});
      }
    } catch (_) {}
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
      // Immediately refresh orders when bot detects a new Binance order (real Binance data)
      if ((entry?.message || '').includes('New order detected')) {
        api.get('/traders/binance-orders', { params: { limit: 20, offset: (ordersPage - 1) * 20 } }).then(r => { setOrders(r.data); setOrdersHasMore(r.data.length === 20); }).catch(() => {});
      }
    });
  }, []);

  useEffect(() => {
    if (activeTab === 'logs') logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    if (activeTab === 'transactions') {
      setAllTxnsLoading(true);
      getMyTransactions(100).then(r => { if (r.data) setAllTxns(r.data); }).catch(() => {}).finally(() => setAllTxnsLoading(false));
    }
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
        {['overview', 'orders', 'transactions', 'logs', 'settings'].map((tab) => (
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
                  <span style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>{profile?.choice_account_number || profile?.choice_account_id || 'Pending verification'}</span>
                  <button onClick={() => { navigator.clipboard.writeText(profile?.choice_account_number || profile?.choice_account_id || ''); setCopied('account'); setTimeout(() => setCopied(''), 2000); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: copied === 'account' ? '#10b981' : '#9ca3af', padding: 2 }}>
                    <Copy size={14} />
                  </button>
                </div>
              </div>

              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>Paybill Number</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg)', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)' }}>
                  <span style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>{profile?.choice_paybill || '444174'}</span>
                  <button onClick={() => { navigator.clipboard.writeText(profile?.choice_paybill || '444174'); setCopied('paybill'); setTimeout(() => setCopied(''), 2000); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: copied === 'paybill' ? '#10b981' : '#9ca3af', padding: 2 }}>
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

      <div className="dash-body">

        {/* ── Desktop / Tablet Sidebar ── */}
        <aside className="dash-sidebar">
          {/* Brand */}
          <div className="dsb-brand">
            <img src="/logo.png" alt="SparkP2P" style={{ width: 28, height: 28, borderRadius: 6 }} />
            <div style={{ lineHeight: 1.1 }}>
              <div style={{ color: '#F59E0B', fontWeight: 500, fontSize: 14 }}>SparkP2P</div>
              {appVersion && <div style={{ color: '#6B7280', fontSize: 10 }}>v{appVersion}</div>}
            </div>
          </div>

          {/* Main nav */}
          <div className="dsb-section-label">Main</div>
          {[
            { key: 'overview',      icon: LayoutDashboard, label: 'Overview'      },
            { key: 'orders',        icon: List,            label: 'Orders'        },
            { key: 'transactions',  icon: ArrowRightLeft,  label: 'Transactions'  },
            { key: 'logs',          icon: Activity,        label: 'Logs'          },
          ].map(({ key, icon: Icon, label }) => (
            <button key={key}
              className={`dsb-nav-item${activeTab === key ? ' dsb-active' : ''}`}
              onClick={() => setActiveTab(key)}
            >
              <Icon size={16} />
              <span>{label}</span>
            </button>
          ))}

          {/* Account nav */}
          <div className="dsb-section-label">Account</div>
          <button
            className={`dsb-nav-item${activeTab === 'settings' ? ' dsb-active' : ''}`}
            onClick={() => setActiveTab('settings')}
          >
            <Settings size={16} /><span>Settings</span>
          </button>
          {affiliateData?.affiliate && (
            <button
              className={`dsb-nav-item${activeTab === 'affiliates' ? ' dsb-active' : ''}`}
              onClick={() => setActiveTab('affiliates')}
            >
              <Share2 size={16} /><span>Affiliates</span>
            </button>
          )}
          <button
            className={`dsb-nav-item${activeTab === 'paybill' ? ' dsb-active' : ''}`}
            onClick={() => setActiveTab('paybill')}
          >
            <CreditCard size={16} /><span>My Paybill</span>
          </button>

          {/* Setup nav */}
          <div className="dsb-section-label">Setup</div>
          {!profile?.binance_connected && (
            <button className="dsb-nav-item dsb-warn" onClick={() => setActiveTab('settings')}>
              <Wifi size={16} /><span>Connect Binance</span>
            </button>
          )}
          <button
            className={`dsb-nav-item dsb-accent${activeTab === 'configure' ? ' dsb-active' : ''}`}
            onClick={() => setActiveTab('configure')}
          >
            <SlidersHorizontal size={16} /><span>Configure</span>
          </button>
          <button
            className={`dsb-nav-item dsb-green${activeTab === 'credits' ? ' dsb-active' : ''}`}
            onClick={() => setActiveTab('credits')}
          >
            <DollarSign size={16} /><span>Buy Credits</span>
          </button>

          {/* Footer */}
          <div className="dsb-footer">
            <div className="dsb-user-row">
              <div className="dsb-avatar">{(user?.full_name || 'U').charAt(0).toUpperCase()}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: '#E5E7EB', fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.full_name}</div>
                <div style={{ color: '#F59E0B', fontSize: 10, fontWeight: 500, textTransform: 'uppercase' }}>{profile?.tier || 'standard'}</div>
              </div>
              <button className="icon-btn" onClick={logout} title="Logout" style={{ padding: 4 }}>
                <LogOut size={15} />
              </button>
            </div>
          </div>
        </aside>

        <main className="dash-content">
{activeTab === 'overview' && (
          <>
            {/* Choice Bank verification banner — only after profile loads */}
            {profile && !profile.choice_account_id && (
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
                    // Online if the desktop bot app is open (window.sparkp2p) or synced recently (<3 min)
                    const appOpen = typeof window !== 'undefined' && !!window.sparkp2p;
                    const online = appOpen || (diff !== null && diff < 180);
                    const label = online ? 'Online' : !ts ? 'Bot Never Connected' : diff < 3600 ? `Last seen ${Math.floor(diff/60)}m ago` : diff < 86400 ? `Last seen ${Math.floor(diff/3600)}h ago` : `Last seen ${Math.floor(diff/86400)}d ago`;
                    return (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: online ? '#10b981' : '#9ca3af', marginBottom: 2 }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: online ? '#10b981' : '#6b7280', flexShrink: 0 }} />
                        {label}
                      </span>
                    );
                  })()}
                  <span className="greeting-sub">Today's Earnings</span>
                  <span className="greeting-amount">KES {(profitData?.net_profit ?? stats?.today?.net_profit ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
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
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#9ca3af', marginBottom: 14, letterSpacing: 0.5 }}>
                      {profile.choice_account_number || profile.choice_account_id}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        onClick={() => { setCbDepositMsg(''); setCbDepositAmount(''); setCbDepositPhone(profile?.phone || ''); setShowCbDepositModal(true); }}
                        style={{ flex: 1, padding: '10px 0', borderRadius: 9, border: 'none', background: 'linear-gradient(135deg, #10b981, #059669)', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}
                      >
                        ➕ Deposit
                      </button>
                      <button
                        onClick={async () => {
                          setCbWithdrawMsg(''); setCbWithdrawAmount(''); setCbWithdrawOtp('');
                          setCbWithdrawOtpSent(false);
                          try { const r = await getCbWithdrawalBank(); setCbWithdrawBank(r.data); } catch { setCbWithdrawBank(null); }
                          setShowCbWithdrawModal(true);
                        }}
                        style={{ flex: 1, padding: '10px 0', borderRadius: 9, border: '1px solid rgba(239,68,68,0.4)', background: 'rgba(239,68,68,0.08)', color: '#ef4444', fontWeight: 700, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}
                      >
                        ↗️ Withdraw
                      </button>
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
                <span className="mini-stat-value">{profitData ? ((profitData.buy?.orders || 0) + (profitData.sell?.orders || 0)) : (stats?.today?.total_trades || 0)}</span>
                <span className="mini-stat-label">Total Trades</span>
              </div>
              <div className="mini-stat-card sell-card">
                <ArrowDown size={18} style={{ color: '#10b981', marginBottom: 4 }} />
                <span className="mini-stat-value">{profitData?.sell?.orders ?? stats?.today?.sell_trades ?? 0}</span>
                <span className="mini-stat-label">Sell Orders</span>
              </div>
              <div className="mini-stat-card buy-card">
                <ArrowUp size={18} style={{ color: '#3b82f6', marginBottom: 4 }} />
                <span className="mini-stat-value">{profitData?.buy?.orders ?? stats?.today?.buy_trades ?? 0}</span>
                <span className="mini-stat-label">Buy Orders</span>
              </div>
              <div className="mini-stat-card">
                <DollarSign size={18} style={{ color: '#f59e0b', marginBottom: 4 }} />
                <span className="mini-stat-value">KES {(profitData ? ((profitData.buy?.kes || 0) + (profitData.sell?.kes || 0)) : (stats?.today?.volume || 0)).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
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
                  <span className="buysell-crypto">{(profitData?.buy?.usdt ?? stats?.today?.buy_crypto ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT</span>
                  <span className="buysell-fiat">KES {(profitData?.buy?.kes ?? stats?.today?.buy_volume ?? 0).toLocaleString()}</span>
                </div>
                <div className="buysell-detail">
                  <div><span>Orders</span><span>{profitData?.buy?.orders ?? stats?.today?.buy_trades ?? 0}</span></div>
                  <div><span>Avg Rate</span><span>KES {(profitData?.buy?.avg_rate ?? stats?.today?.avg_buy_rate ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
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
                  <span className="buysell-crypto">{(profitData?.sell?.usdt ?? stats?.today?.sell_crypto ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT</span>
                  <span className="buysell-fiat">KES {(profitData?.sell?.kes ?? stats?.today?.sell_volume ?? 0).toLocaleString()}</span>
                </div>
                <div className="buysell-detail">
                  <div><span>Orders</span><span>{profitData?.sell?.orders ?? stats?.today?.sell_trades ?? 0}</span></div>
                  <div><span>Avg Rate</span><span>KES {(profitData?.sell?.avg_rate ?? stats?.today?.avg_sell_rate ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
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
                  <span className={`big-profit ${(profitData?.net_profit ?? stats?.today?.net_profit ?? 0) >= 0 ? 'positive' : 'negative'}`}>
                    KES {(profitData?.net_profit ?? stats?.today?.net_profit ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                  <span className="profit-label">Net Profit{profitData ? ' · today' : ''}</span>
                </div>
                <div className="profit-breakdown">
                  <div className="profit-row spread-row">
                    <span>Spread</span>
                    <span>KES {(profitData?.spread ?? stats?.today?.spread ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ({(profitData?.spread_pct ?? stats?.today?.spread_pct ?? 0)}%)</span>
                  </div>
                  <div className="profit-row">
                    <span>Gross Profit</span>
                    <span className="positive">KES {(profitData?.gross_profit ?? stats?.today?.gross_profit ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                  </div>
                  <div className="profit-row fee-row">
                    <span>Binance Fees (actual commission)</span>
                    <span>-KES {(profitData?.fees_kes ?? stats?.today?.binance_fees ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
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
          // Fetching is handled by the binance-orders effect (keyed on filter/page);
          // these handlers just update state and the effect reloads.
          const handleFilterChange = (f) => {
            setOrdersFilter(f);
            setOrdersPage(1);
          };

          const handlePageChange = (p) => {
            setOrdersPage(p);
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
                        <td style={{ fontWeight: 600 }}>KES {(order.fiat_amount || 0).toLocaleString()}</td>
                        <td>{order.crypto_amount} {order.crypto_currency}</td>
                        <td style={{ color: '#9ca3af' }}>{order.exchange_rate}</td>
                        <td style={{ color: getStatusColor(order.status) }}>
                          {(order.status || '').replace(/_/g, ' ')}
                        </td>
                        <td className="mono" style={{ fontSize: 12 }}>{order.account_reference || '—'}</td>
                        <td style={{ fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>{fmtDateEAT(order.created_at)}</td>
                        <td style={{ fontVariantNumeric: 'tabular-nums', color: overdue ? '#f97316' : live ? '#facc15' : '#9ca3af', fontWeight: live ? 600 : 400, whiteSpace: 'nowrap' }}>
                          {order._binance ? '—' : (<>
                            {overdue && <span title="Binance timer expired" style={{ marginRight: 4 }}>⚠️</span>}
                            {formatDuration(secs)}
                            {live && <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.6 }}>●</span>}
                          </>)}
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

        {/* ── Transactions Tab ── */}
        {activeTab === 'transactions' && (
          <div>
            {/* Summary */}
            {(() => {
              const inTotal  = allTxns.filter(t => t.direction === 'in').reduce((s, t) => s + t.amount, 0);
              const outTotal = allTxns.filter(t => t.direction === 'out').reduce((s, t) => s + t.amount, 0);
              const fmt = v => 'KES ' + v.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              return (
                <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
                  <div style={{ flex: 1, background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: 12, padding: '14px 18px' }}>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Total Inbound</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: '#10b981' }}>{fmt(inTotal)}</div>
                  </div>
                  <div style={{ flex: 1, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 12, padding: '14px 18px' }}>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Total Outbound</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: '#ef4444' }}>{fmt(outTotal)}</div>
                  </div>
                  <div style={{ flex: 1, background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 12, padding: '14px 18px' }}>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Net</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: (inTotal - outTotal) >= 0 ? '#10b981' : '#ef4444' }}>{fmt(inTotal - outTotal)}</div>
                  </div>
                </div>
              );
            })()}

            {/* Filters + Refresh */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
              {[['all', 'All'], ['in', 'Inbound'], ['out', 'Outbound']].map(([v, l]) => (
                <button key={v} onClick={() => setTxFilter(v)} style={{ padding: '6px 16px', borderRadius: 20, border: '1px solid', borderColor: txFilter === v ? '#10b981' : 'var(--border)', background: txFilter === v ? 'rgba(16,185,129,0.15)' : 'transparent', color: txFilter === v ? '#10b981' : '#6b7280', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                  {l}
                </button>
              ))}
              <button
                onClick={() => { setAllTxnsLoading(true); getMyTransactions(100).then(r => { if (r.data) setAllTxns(r.data); }).catch(() => {}).finally(() => setAllTxnsLoading(false)); }}
                style={{ marginLeft: 'auto', padding: '6px 14px', borderRadius: 20, border: '1px solid var(--border)', background: 'transparent', color: '#6b7280', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}
              >
                <RefreshCw size={12} className={allTxnsLoading ? 'spinning' : ''} /> Refresh
              </button>
            </div>

            {/* List */}
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              {allTxnsLoading && allTxns.length === 0 && (
                <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading transactions…</div>
              )}
              {!allTxnsLoading && allTxns.length === 0 && (
                <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>No transactions yet</div>
              )}
              {allTxns
                .filter(t => txFilter === 'all' || t.direction === txFilter)
                .map((t, i, arr) => {
                  const isIn = t.direction === 'in';
                  const dateStr = new Date(t.created_at).toLocaleString('en-KE', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true });
                  const fmtAmt = v => 'KES ' + v.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                  return (
                    <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 18px', borderBottom: i < arr.length - 1 ? '1px solid #111827' : 'none' }}>
                      <div style={{ width: 38, height: 38, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: isIn ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)', fontSize: 17, flexShrink: 0 }}>
                        {t.icon || (isIn ? '↙️' : '↗️')}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', marginBottom: 2 }}>{t.label}</div>
                        <div style={{ fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {t.description !== t.label ? t.description : ''}{t.phone ? ' · ' + t.phone : ''} · {dateStr}
                        </div>
                        {t.reference && <div style={{ fontSize: 10, color: '#4b5563', marginTop: 1 }}>Ref: {t.reference}</div>}
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: isIn ? '#10b981' : '#ef4444' }}>
                          {isIn ? '+' : '-'}{fmtAmt(t.amount)}
                        </div>
                        {t.status === 'completed' && !isIn && (
                          <div style={{ fontSize: 10, color: '#10b981', marginTop: 2 }}>✓ completed</div>
                        )}
                        {t.status && t.status !== 'completed' && (
                          <div style={{ fontSize: 10, color: t.status === 'failed' ? '#ef4444' : '#f59e0b', marginTop: 2 }}>{t.status}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        )}

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
        {activeTab === 'configure' && (
          <div>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 28 }}>
              <div>
                <h2 style={{ color: '#fff', fontSize: 20, fontWeight: 700, margin: '0 0 4px' }}>Configure bot</h2>
                <p style={{ color: '#6b7280', fontSize: 13, margin: 0 }}>Control what the bot automates and how it screens counterparties</p>
              </div>
              <button
                onClick={async () => {
                  setSavingConfig(true);
                  try {
                    const res = await api.put('/traders/trading-config', { bot_trade_mode: botTradeMode, dd_enabled: ddEnabled, dd_min_30d_trades: ddMin30d, dd_min_all_trades: ddMinAll, cf_filters_enabled: cfEnabled, cf_all_trades_min: parseInt(cfAllTradesMin) || 0, cf_all_trades_min_all: parseInt(cfAllTradesMinAll) || 0 });
                    configSavedAt.current = Date.now();
                    setConfigSaved(true);
                    setTimeout(() => { setConfigSaved(false); }, 1500);
                    checkCfSync(); // refresh live Binance sync badge
                    if (res?.data?.warning) alert(res.data.warning);
                  } catch (e) {}
                  setSavingConfig(false);
                }}
                disabled={savingConfig || configSaved}
                style={{ padding: '9px 22px', borderRadius: 8, border: 'none', background: configSaved ? '#059669' : '#10b981', color: '#fff', fontWeight: 700, fontSize: 13, cursor: savingConfig || configSaved ? 'default' : 'pointer', flexShrink: 0, whiteSpace: 'nowrap', opacity: savingConfig ? 0.7 : 1, transition: 'background 0.2s' }}
              >
                {savingConfig ? 'Saving…' : configSaved ? '✓ Saved' : 'Save changes'}
              </button>
            </div>

            {/* ORDER TYPES */}
            <div style={{ color: '#6b7280', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: 6 }}>Order Types</div>
            <p style={{ color: '#9ca3af', fontSize: 13, marginBottom: 14 }}>Choose which order types the bot should automate. Orders outside the selected mode stay visible on Binance — you complete them manually.</p>
            <div className="cfg-order-grid">
              {[
                { value: 'both',      label: 'Buy & sell',       badge: 'DEFAULT', desc: 'Bot fully automates both sides — pays sellers for incoming buy orders and releases USDT to buyers for sell orders.',         footNote: 'Recommended for most traders', footColor: '#10b981', warn: null },
                { value: 'buy_only',  label: 'Buy orders only',  badge: null,      desc: 'Bot pays sellers and acquires USDT automatically when buyers place orders.',                                                   footNote: null, footColor: null, warn: "Sell orders won't be automated. Release USDT manually on Binance." },
                { value: 'sell_only', label: 'Sell orders only', badge: null,      desc: 'Bot receives M-Pesa payments and releases USDT to buyers automatically.',                                                      footNote: null, footColor: null, warn: "Buy orders won't be automated. Pay sellers manually on Binance." },
              ].map(opt => {
                const active = botTradeMode === opt.value;
                return (
                  <div key={opt.value} onClick={() => setBotTradeMode(opt.value)}
                    style={{ padding: 16, borderRadius: 10, border: `1px solid ${active ? '#f59e0b' : '#1f2937'}`, background: active ? 'rgba(245,158,11,0.06)' : '#0d1117', cursor: 'pointer', transition: 'all 0.15s', display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ width: 18, height: 18, borderRadius: '50%', border: `2px solid ${active ? '#f59e0b' : '#374151'}`, background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {active && <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#f59e0b' }} />}
                      </div>
                      {opt.badge && <span style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', background: '#1f2937', padding: '2px 8px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{opt.badge}</span>}
                    </div>
                    <div>
                      <div style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 700, marginBottom: 6 }}>{opt.label}</div>
                      <div style={{ color: '#9ca3af', fontSize: 12, lineHeight: 1.5 }}>{opt.desc}</div>
                    </div>
                    {opt.warn && <div style={{ fontSize: 11, color: '#f59e0b', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 6, padding: '6px 8px', lineHeight: 1.4 }}>{opt.warn}</div>}
                    {opt.footNote && <div style={{ fontSize: 11, color: opt.footColor, fontWeight: 500 }}>{opt.footNote}</div>}
                  </div>
                );
              })}
            </div>

            {/* COUNTERPARTY SCREENING */}
            <div style={{ color: '#6b7280', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.8px', margin: '28px 0 14px' }}>Counterparty Screening</div>

            {/* Telegram screening row */}
            <div style={{ background: '#0d1117', border: '0.5px solid #1f2937', borderRadius: 10, padding: '14px 16px', marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 600 }}>Screen via Telegram before sharing payment details</div>
                  <div style={{ color: '#6b7280', fontSize: 12, marginTop: 3 }}>
                    {tgConnectedForConfig ? 'Buyer details sent to your Telegram for approval before payment is shared.' : 'Screen buyers automatically before sharing payment details'}
                  </div>
                </div>
                <div onClick={() => setDdEnabled(v => !v)}
                  style={{ width: 44, height: 24, borderRadius: 12, background: ddEnabled ? '#f59e0b' : '#374151', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0, marginLeft: 20 }}>
                  <div style={{ position: 'absolute', top: 4, left: ddEnabled ? 22 : 4, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
                </div>
              </div>
              {ddEnabled && tgConnectedForConfig && (
                <div style={{ marginTop: 12, background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: 8, padding: '10px 14px' }}>
                  <div style={{ color: '#10b981', fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Telegram screening active</div>
                  <div style={{ color: '#9ca3af', fontSize: 12, lineHeight: 1.5 }}>Every new sell order pauses — buyer stats are sent to your Telegram before payment details are shared. Reply <span style={{ color: '#10b981' }}>/approve</span> or <span style={{ color: '#ef4444' }}>/reject</span>.</div>
                </div>
              )}
              {ddEnabled && !tgConnectedForConfig && (
                <div style={{ marginTop: 12, background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 8, padding: '12px 14px' }}>
                  <div style={{ color: '#f59e0b', fontSize: 13, fontWeight: 700, marginBottom: 6 }}>⚠ Telegram not connected</div>
                  <p style={{ margin: '0 0 10px', color: '#9ca3af', fontSize: 12, lineHeight: 1.5 }}>Connect your Telegram to use this feature.</p>
                  <button onClick={() => { setSettingsInitialSection('notifications'); setActiveTab('settings'); }}
                    style={{ padding: '8px 14px', borderRadius: 7, border: '1px solid rgba(245,158,11,0.4)', background: 'rgba(245,158,11,0.1)', color: '#f59e0b', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>
                    Connect Telegram → Settings / Notifications
                  </button>
                </div>
              )}
            </div>


            {/* High-risk regions row */}
            <div style={{ background: '#0d1117', border: '0.5px solid #1f2937', borderRadius: 10, padding: '14px 16px', marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 600 }}>Pause on high-risk regions</span>
                  <span style={{ fontSize: 10, color: '#6b7280', background: '#1f2937', padding: '1px 7px', borderRadius: 4, fontWeight: 600 }}>COMING SOON</span>
                </div>
                <div style={{ color: '#6b7280', fontSize: 12, marginTop: 3 }}>Require manual approval for flagged areas</div>
              </div>
              <div style={{ width: 44, height: 24, borderRadius: 12, background: '#374151', cursor: 'not-allowed', position: 'relative', flexShrink: 0, marginLeft: 20, opacity: 0.4 }}>
                <div style={{ position: 'absolute', top: 4, left: 4, width: 16, height: 16, borderRadius: '50%', background: '#fff' }} />
              </div>
            </div>

            {/* Binance Ad Counterparty Filters */}
            <div style={{ background: '#0d1117', border: `0.5px solid ${cfEnabled ? 'rgba(245,158,11,0.4)' : '#1f2937'}`, borderRadius: 10, padding: '14px 16px', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: cfEnabled ? 14 : 0 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 600 }}>Binance Ad Counterparty Filters</div>
                  <div style={{ color: '#6b7280', fontSize: 12, marginTop: 3 }}>
                    {profile?.cf_last_pushed_at
                      ? `Last pushed to Binance: ${new Date(profile.cf_last_pushed_at).toLocaleString('en-KE', { dateStyle: 'short', timeStyle: 'short' })}`
                      : 'Filters pushed to all your sell ads on save'}
                  </div>
                  {cfSync && (cfSync.available ? !cfSync.synced || cfEnabled : cfSync.reason !== 'no_api_key') && (
                    <div style={{ fontSize: 11, fontWeight: 600, marginTop: 4, color: !cfSync.available ? '#9ca3af' : cfSync.synced ? '#10b981' : '#ef4444' }}>
                      {!cfSync.available
                        ? (cfSync.reason === 'no_api_key' ? '' : "⚠ Can't verify with Binance — keep your bot/relay online")
                        : cfSync.synced
                          ? '✓ In sync with Binance'
                          : `⚠ Out of sync — Binance shows ${(cfSync.binance_values || []).join(', ') || '?'} (expected ${cfSync.expected}). Click Save to fix.`}
                    </div>
                  )}
                </div>
                <div onClick={() => setCfEnabled(v => !v)}
                  style={{ width: 44, height: 24, borderRadius: 12, background: cfEnabled ? '#f59e0b' : '#374151', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0, marginLeft: 20 }}>
                  <div style={{ position: 'absolute', top: 4, left: cfEnabled ? 22 : 4, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
                </div>
              </div>
              {cfEnabled && (
                <div style={{ display: 'flex', gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: '#9ca3af', fontSize: 11, fontWeight: 600, marginBottom: 5 }}>Min Total Trades (30D)</div>
                    <input type="number" min="0" value={cfAllTradesMin} onChange={e => setCfAllTradesMin(e.target.value)}
                      style={{ width: '100%', background: '#111827', border: '1px solid #374151', borderRadius: 7, padding: '8px 10px', color: '#e5e7eb', fontSize: 14, boxSizing: 'border-box' }} />
                    <div style={{ color: '#6b7280', fontSize: 10, marginTop: 3 }}>0 = off · bot enforced</div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: '#9ca3af', fontSize: 11, fontWeight: 600, marginBottom: 5 }}>Min Total Trades (All Time)</div>
                    <input type="number" min="0" value={cfAllTradesMinAll} onChange={e => setCfAllTradesMinAll(e.target.value)}
                      style={{ width: '100%', background: '#111827', border: '1px solid #374151', borderRadius: 7, padding: '8px 10px', color: '#e5e7eb', fontSize: 14, boxSizing: 'border-box' }} />
                    <div style={{ color: '#6b7280', fontSize: 10, marginTop: 3 }}>0 = off · Binance enforced 24/7</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'paybill' && (() => {
          const recentTxns = [...(transactions || []).map(t => ({ ...t, sign: 1 })), ...(withdrawalTxns || []).map(t => ({ ...t, sign: -1 }))]
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
            .slice(0, 5);
          const isLocked = profile?.settlement_cooldown_until && new Date(profile.settlement_cooldown_until) > new Date();
          return (
            <div>
              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
                <div>
                  <h2 style={{ color: '#fff', fontSize: 20, fontWeight: 700, margin: '0 0 4px' }}>My paybill</h2>
                  <p style={{ color: '#6b7280', fontSize: 13, margin: 0 }}>Bank details the bot uses to receive payouts</p>
                </div>
                <button onClick={() => { setSettingsInitialSection('bank'); setActiveTab('settings'); }}
                  style={{ padding: '8px 18px', borderRadius: 8, border: '1px solid #374151', background: 'transparent', color: '#e5e7eb', fontWeight: 600, fontSize: 13, cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap' }}>
                  Edit details
                </button>
              </div>

              <div className="paybill-two-col">
                {/* Left: bank details + transactions */}
                <div>
                  <div className="card" style={{ marginBottom: 14 }}>
                    {/* Bank header */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div style={{ width: 40, height: 40, borderRadius: 8, background: 'linear-gradient(135deg,#0d9488,#065f46)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
                        </div>
                        <div>
                          <div style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 700 }}>Choice Bank · Kenya</div>
                          <div style={{ color: '#6b7280', fontSize: 12, marginTop: 2 }}>Connected · paybill active</div>
                        </div>
                      </div>
                      <span style={{ fontSize: 11, fontWeight: 700, color: '#10b981', background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.3)', padding: '3px 10px', borderRadius: 20 }}>Verified</span>
                    </div>

                    {/* Fields */}
                    {[
                      { label: 'PAYBILL NUMBER',  value: profile?.choice_paybill || '444174',                                                key: 'pb' },
                      { label: 'ACCOUNT NUMBER',  value: profile?.choice_account_number || profile?.choice_account_id || '—',                key: 'ac' },
                      { label: 'ACCOUNT NAME',    value: profile?.full_name || '—',                                                          key: 'nm' },
                    ].map(({ label, value, key: ck }) => (
                      <div key={ck} style={{ marginBottom: 14 }}>
                        <div style={{ color: '#6b7280', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 6 }}>{label}</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#0a0d14', borderRadius: 8, padding: '10px 14px', border: '0.5px solid #374151' }}>
                          <span style={{ flex: 1, color: '#e5e7eb', fontSize: 14, fontWeight: 600 }}>{value}</span>
                          <button
                            onClick={() => { navigator.clipboard.writeText(String(value)); setCopied(ck); setTimeout(() => setCopied(''), 1800); }}
                            style={{ background: copied === ck ? 'rgba(16,185,129,0.12)' : 'transparent', border: `1px solid ${copied === ck ? 'rgba(16,185,129,0.3)' : '#374151'}`, cursor: 'pointer', color: copied === ck ? '#10b981' : '#6b7280', padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, flexShrink: 0, transition: 'all 0.15s' }}>
                            {copied === ck ? 'Copied!' : 'Copy'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Recent transactions */}
                  <div className="card">
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Activity size={16} style={{ color: '#6b7280' }} />
                        <span style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 700 }}>Recent paybill transactions</span>
                      </div>
                      <button onClick={() => setActiveTab('transactions')}
                        style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: 12, cursor: 'pointer', padding: 0 }}>
                        View all →
                      </button>
                    </div>
                    {recentTxns.length === 0 ? (
                      <p style={{ color: '#6b7280', fontSize: 13, padding: '12px 0', textAlign: 'center' }}>No transactions yet</p>
                    ) : (
                      recentTxns.map((t, i) => {
                        const amt = Math.abs(t.amount || 0);
                        const isPos = (t.amount || 0) > 0;
                        const desc = t.description || (isPos ? 'Incoming' : 'Payout to bank');
                        const shortDesc = desc.length > 28 ? desc.slice(0, 28) + '…' : desc;
                        const date = t.created_at ? new Date(t.created_at) : null;
                        const dateStr = date ? `${date.toLocaleDateString('en-KE')}, ${date.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })}` : '';
                        return (
                          <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: i < recentTxns.length - 1 ? '0.5px solid #1f2937' : 'none' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <div style={{ width: 8, height: 8, borderRadius: '50%', background: isPos ? '#10b981' : '#6b7280', flexShrink: 0 }} />
                              <div>
                                <div style={{ color: '#e5e7eb', fontSize: 13, fontWeight: 500 }}>{shortDesc}</div>
                                <div style={{ color: '#6b7280', fontSize: 11, marginTop: 2 }}>{dateStr}</div>
                              </div>
                            </div>
                            <span style={{ color: isPos ? '#10b981' : '#9ca3af', fontSize: 13, fontWeight: 700, flexShrink: 0 }}>
                              {isPos ? '+' : '−'} KES {amt.toLocaleString()}
                            </span>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                {/* Right: balance + auto-payout + locked notice */}
                <div>
                  <div style={{ marginBottom: 6 }}>
                    <div style={{ color: '#6b7280', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.7px', marginBottom: 6 }}>Current Balance</div>
                    <div style={{ fontSize: 34, fontWeight: 700, color: '#10b981', lineHeight: 1 }}>
                      KES {cbDashBalance !== null && cbDashBalance !== undefined ? (typeof cbDashBalance === 'object' ? (cbDashBalance.balance || 0) : cbDashBalance).toLocaleString() : '—'}
                    </div>
                    <div style={{ color: '#6b7280', fontSize: 12, marginTop: 6, marginBottom: 16 }}>Available for withdrawal</div>
                    <button
                      onClick={() => setShowWithdrawModal(true)}
                      style={{ width: '100%', padding: '12px 0', borderRadius: 8, border: 'none', background: 'linear-gradient(135deg,#10b981,#059669)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer', marginBottom: 16 }}>
                      Withdraw
                    </button>
                  </div>

                  <div className="card" style={{ marginBottom: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                      <span style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 700 }}>Auto-payout</span>
                      <div style={{ width: 44, height: 24, borderRadius: 12, background: profile?.batch_settlement_enabled ? '#f59e0b' : '#374151', position: 'relative', opacity: 0.6, cursor: 'default' }}>
                        <div style={{ position: 'absolute', top: 4, left: profile?.batch_settlement_enabled ? 22 : 4, width: 16, height: 16, borderRadius: '50%', background: '#fff' }} />
                      </div>
                    </div>
                    {[
                      { label: 'Trigger', value: `Balance ≥ KES ${(profile?.batch_threshold || 10000).toLocaleString()}` },
                      { label: 'Next payout', value: profile?.batch_settlement_enabled ? 'When triggered' : 'Disabled' },
                    ].map(({ label, value }) => (
                      <div key={label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0', borderTop: '0.5px solid #1f2937' }}>
                        <span style={{ color: '#6b7280', fontSize: 12 }}>{label}</span>
                        <span style={{ color: '#e5e7eb', fontSize: 12, fontWeight: 500 }}>{value}</span>
                      </div>
                    ))}
                  </div>

                  <div className="card">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: isLocked ? '#ef4444' : '#10b981', flexShrink: 0 }} />
                      <span style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 700 }}>{isLocked ? 'Account is locked' : 'Account security'}</span>
                    </div>
                    <p style={{ color: '#6b7280', fontSize: 12, lineHeight: 1.5, margin: 0 }}>
                      {isLocked
                        ? `Bank detail changes are locked until ${new Date(profile.settlement_cooldown_until).toLocaleDateString('en-KE')}. A 48-hour cooling-off period applies after changes.`
                        : 'Changes to bank details require 2FA + a 24-hour cooling-off period for your protection.'}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

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
            {affiliateData?.affiliate?.status === 'approved' && (() => {
              const link = affiliateData.affiliate.referral_link || `https://sparkp2p.com/login?ref=${affiliateData.affiliate.referral_code}`;
              const shareMsg = `Join SparkP2P — automate your Binance P2P trading. Sign up with my link: ${link}`;
              return (
                <>
                  {/* Stats grid — no icons */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
                    {[
                      { label: 'REFERRALS',      value: affiliateReferrals?.summary?.total_referrals || 0 },
                      { label: 'PENDING PAYOUT', value: `KES ${(affiliateData.affiliate.pending_balance || 0).toLocaleString()}` },
                      { label: 'TOTAL EARNED',   value: `KES ${(affiliateData.affiliate.total_earned || 0).toLocaleString()}` },
                      { label: 'THIS WEEK',      value: `KES ${(affiliateReferrals?.summary?.this_week_earnings || 0).toLocaleString()}` },
                    ].map(({ label, value }) => (
                      <div key={label} className="card" style={{ padding: '14px 18px' }}>
                        <div style={{ color: '#fff', fontWeight: 700, fontSize: 20, marginBottom: 4 }}>{value}</div>
                        <div style={{ color: '#6b7280', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
                      </div>
                    ))}
                  </div>

                  {/* 2-col layout */}
                  <div className="aff-two-col" style={{ display: "grid", gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr)", gap: 16, alignItems: "start" }}>

                    {/* Left: referral link + referrals list */}
                    <div>
                      <div className="card" style={{ marginBottom: 14 }}>
                        <div style={{ fontWeight: 700, color: '#fff', fontSize: 15, marginBottom: 12 }}>Your referral link</div>
                        {/* Inline URL + Copy button */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                          <div style={{ flex: 1, background: 'rgba(255,255,255,0.04)', border: '0.5px solid #374151', borderRadius: 8, padding: '9px 12px', fontFamily: 'monospace', fontSize: 12, color: '#d1d5db', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {link}
                          </div>
                          <button
                            onClick={() => { navigator.clipboard.writeText(link).then(() => { setAffiliateCopied(true); setTimeout(() => setAffiliateCopied(false), 2000); }); }}
                            style={{ flexShrink: 0, padding: '9px 18px', borderRadius: 8, border: 'none', background: affiliateCopied ? '#10b981' : '#3b82f6', color: '#fff', fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>
                            {affiliateCopied ? 'Copied!' : 'Copy'}
                          </button>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <span style={{ color: '#6b7280', fontSize: 12 }}>Your code: <strong style={{ color: '#f59e0b' }}>{affiliateData.affiliate.referral_code}</strong></span>
                          <span style={{ color: '#6b7280', fontSize: 12 }}>10% of all fees, lifetime</span>
                        </div>
                      </div>

                      <div className="card">
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                          <div style={{ fontWeight: 700, color: '#fff', fontSize: 15 }}>Your referrals</div>
                          <span style={{ fontSize: 12, color: '#6b7280' }}>{(affiliateReferrals?.referrals || []).length} trader{(affiliateReferrals?.referrals || []).length !== 1 ? 's' : ''}</span>
                        </div>
                        {(affiliateReferrals?.referrals || []).length === 0 ? (
                          <div style={{ textAlign: 'center', padding: '28px 0' }}>
                            <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'rgba(255,255,255,0.05)', margin: '0 auto 12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              <Users size={22} color="#6b7280" />
                            </div>
                            <div style={{ color: '#6b7280', fontSize: 14, fontWeight: 600, marginBottom: 4 }}>No referrals yet</div>
                            <div style={{ color: '#4b5563', fontSize: 12 }}>Share your link to start earning</div>
                          </div>
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
                                    <div style={{ fontSize: 11, color: '#6b7280' }}>earned</div>
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
                    </div>

                    {/* Right: Share quickly + How it works */}
                    <div>
                      <div className="card" style={{ marginBottom: 14 }}>
                        <div style={{ fontWeight: 700, color: '#fff', fontSize: 15, marginBottom: 14 }}>Share quickly</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <a href={`https://wa.me/?text=${encodeURIComponent(shareMsg)}`} target="_blank" rel="noopener noreferrer"
                            style={{ display: 'block', padding: '10px 16px', borderRadius: 8, background: '#25d366', color: '#fff', fontWeight: 700, fontSize: 14, textDecoration: 'none', textAlign: 'center' }}>
                            WhatsApp
                          </a>
                          <a href={`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Join SparkP2P — automate your Binance P2P trading!')}`} target="_blank" rel="noopener noreferrer"
                            style={{ display: 'block', padding: '10px 16px', borderRadius: 8, border: '1px solid rgba(0,136,204,0.4)', background: 'rgba(0,136,204,0.06)', color: '#0088cc', fontWeight: 700, fontSize: 14, textDecoration: 'none', textAlign: 'center' }}>
                            Telegram
                          </a>
                          <a href={`sms:?body=${encodeURIComponent(shareMsg)}`}
                            style={{ display: 'block', padding: '10px 16px', borderRadius: 8, border: '1px solid #374151', background: 'transparent', color: '#d1d5db', fontWeight: 700, fontSize: 14, textDecoration: 'none', textAlign: 'center' }}>
                            SMS
                          </a>
                        </div>
                      </div>

                      <div className="card">
                        <div style={{ fontWeight: 700, color: '#fff', fontSize: 15, marginBottom: 16 }}>How it works</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                          {[
                            { n: '1', color: '#f59e0b', bg: 'rgba(245,158,11,0.15)', title: 'Share your link',       desc: 'WhatsApp, Telegram, social — anywhere fellow traders are.' },
                            { n: '2', color: '#10b981', bg: 'rgba(16,185,129,0.15)', title: 'They sign up & trade',  desc: 'Your code is locked to their account forever.' },
                            { n: '3', color: '#10b981', bg: 'rgba(16,185,129,0.15)', title: 'You earn 10%',          desc: 'Paid to your M-Pesa every Monday. No cap.' },
                          ].map(({ n, color, bg, title, desc }) => (
                            <div key={n} style={{ display: 'flex', gap: 12 }}>
                              <div style={{ width: 24, height: 24, borderRadius: '50%', background: bg, color, fontSize: 12, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{n}</div>
                              <div>
                                <div style={{ color: '#e5e7eb', fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{title}</div>
                                <div style={{ color: '#6b7280', fontSize: 12, lineHeight: 1.4 }}>{desc}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                  </div>
                </>
              );
            })()}
          </div>
        )}
        {/* ==================== BUY CREDITS TAB ==================== */}
        {activeTab === 'credits' && (() => {
          const PAY_GO = { key: 'pay_on_the_go', label: 'Pay On The Go', subtitle: 'No commitment', amount: null, credits: null, rate: 40, savings: null, accent: '#fb923c', glow: '251,146,60', features: ['Pay any amount', 'Never expires', 'Instant credit'], topLabel: null, border: '#1f2937', flexible: true };
          const PLANS = [
            { key: 'starter',  label: 'Starter',  subtitle: 'Try the bot',    amount: 5000,  credits: 167,  rate: 30, savings: 25, accent: '#9ca3af', glow: '107,114,128', features: ['~167 buy orders', 'Never expires'],                            topLabel: null,          border: '#1f2937' },
            { key: 'pro',      label: 'Pro',       subtitle: 'Active trader',  amount: 10000, credits: 500,  rate: 20, savings: 50, accent: '#f59e0b', glow: '245,158,11',  features: ['~500 buy orders', 'Never expires'],                            topLabel: null,          border: 'rgba(245,158,11,0.35)' },
            { key: 'pro_max',  label: 'Pro Max',   subtitle: 'Power user',     amount: 20000, credits: 2000, rate: 10, savings: 75, accent: '#10b981', glow: '16,185,129',  features: ['~2,000 buy orders', 'Priority support', 'Never expires'],    topLabel: 'MOST POPULAR', border: 'rgba(16,185,129,0.35)' },
            { key: 'advanced', label: 'Advanced',  subtitle: 'High volume',    amount: 40000, credits: 8000, rate: 5,  savings: 87, accent: '#a78bfa', glow: '139,92,246',  features: ['~8,000 buy orders', 'Dedicated support', 'Never expires'],   topLabel: 'BEST VALUE',   border: 'rgba(167,139,250,0.35)' },
          ];

          const handleBuyCredits = async () => {
            if (!creditPlan || !creditPhone.trim()) { setCreditMsg({ type: 'error', text: 'Select a plan and enter your M-Pesa number.' }); return; }
            if (creditPlan === 'pay_on_the_go' && (!parseFloat(payGoAmount) || parseFloat(payGoAmount) < 500)) { setCreditMsg({ type: 'error', text: 'Minimum amount is KES 500 for Pay On The Go.' }); return; }
            setCreditBuying(true); setCreditMsg(null);
            try {
              const customAmt = creditPlan === 'pay_on_the_go' ? parseFloat(payGoAmount) : undefined;
              const res = await purchaseCredits(creditPlan, creditPhone.trim(), customAmt);
              const checkoutId = res.data.checkout_id;
              setCreditCheckoutId(checkoutId);
              setCreditMsg({ type: 'info', text: res.data.message });
              setCreditPolling(true);
              const interval = setInterval(async () => {
                try {
                  const ps = await pollCreditsStatus(checkoutId);
                  if (ps.data.status === 'completed') {
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

          const sel = creditPlan === 'pay_on_the_go' ? PAY_GO : PLANS.find(p => p.key === creditPlan);
          const tc = (profile?.trade_tokens || 0) + (profile?.trade_tokens_expiring || 0);
          const rm = tc >= 2000 ? 8000 : tc >= 500 ? 2000 : tc >= 167 ? 500 : 167;
          const pp = Math.min(100, Math.round((tc / rm) * 100));
          const bc = pp > 50 ? '#10b981' : pp > 20 ? '#f59e0b' : '#ef4444';

          const renderPaymentForm = (p) => (
            <div style={{ background: `rgba(${p.glow},0.05)`, border: `1px solid rgba(${p.glow},0.25)`, borderTop: 'none', borderRadius: '0 0 14px 14px', padding: '16px 20px' }}>
              {p.flexible && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ color: '#9ca3af', fontSize: 12, marginBottom: 6 }}>
                    Amount (min KES 500) · You get <strong style={{ color: p.accent }}>{Math.floor(parseFloat(payGoAmount || 0) / 40)}</strong> credits
                  </div>
                  <input type="number" min="500" step="100" placeholder="e.g. 1000" value={payGoAmount} onChange={e => setPayGoAmount(e.target.value)} disabled={creditBuying || creditPolling}
                    style={{ width: '100%', background: '#0d1117', border: `1px solid ${p.accent}55`, borderRadius: 10, color: '#fff', padding: '11px 14px', fontSize: 14, outline: 'none', boxSizing: 'border-box', marginBottom: 4 }} />
                  {parseFloat(payGoAmount) >= 500 && <div style={{ fontSize: 11, color: '#6b7280' }}>KES {parseFloat(payGoAmount).toLocaleString()} → {Math.floor(parseFloat(payGoAmount) / 40)} credits @ KES 40/credit</div>}
                </div>
              )}
              <div style={{ color: '#6b7280', fontSize: 11, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600 }}>Pay via M-Pesa</div>
              <input type="tel" placeholder="e.g. 0712 345 678" value={creditPhone} onChange={e => setCreditPhone(e.target.value)} disabled={creditBuying || creditPolling}
                style={{ width: '100%', background: '#0d1117', border: `1px solid ${p.accent}33`, borderRadius: 10, color: '#fff', padding: '11px 14px', fontSize: 14, outline: 'none', boxSizing: 'border-box', marginBottom: 8 }} />
              <button onClick={handleBuyCredits} disabled={creditBuying || creditPolling || !creditPhone.trim()}
                style={{ width: '100%', padding: '12px 0', borderRadius: 10, border: 'none',
                  background: (creditBuying || creditPolling || !creditPhone.trim()) ? '#1f2937' : p.accent,
                  color: (creditBuying || creditPolling || !creditPhone.trim()) ? '#4b5563' : (p.accent === '#9ca3af' ? '#111' : '#000'),
                  fontWeight: 800, fontSize: 14, cursor: (creditBuying || creditPolling || !creditPhone.trim()) ? 'not-allowed' : 'pointer' }}>
                {creditPolling ? 'Waiting...' : creditBuying ? 'Sending...' : 'Pay Now'}
              </button>
              {creditPolling && (
                <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#f59e0b' }} />
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
          );

          return (
            <div className="bc-outer" style={{ maxWidth: 560, margin: '0 auto', padding: '4px 0 40px' }}>

              {/* YOUR BALANCE */}
              <div style={{ background: '#0d1117', border: '1px solid #1f2937', borderRadius: 14, padding: '18px 20px', marginBottom: 6 }}>
                <div style={{ color: '#4b5563', fontSize: 10, fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', marginBottom: 8 }}>Your Balance</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
                  <span style={{ color: bc, fontWeight: 900, fontSize: 36, letterSpacing: '-1px' }}>{tc.toLocaleString(undefined, { maximumFractionDigits: 1 })}</span>
                  <span style={{ color: '#6b7280', fontSize: 14 }}>credits</span>
                </div>
                <div style={{ height: 6, background: '#1a1d27', borderRadius: 99, overflow: 'hidden', marginBottom: 6 }}>
                  <div style={{ height: '100%', width: `${pp}%`, background: bc, borderRadius: 99 }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: tc < 100 ? '#ef4444' : '#6b7280', fontSize: 11 }}>{tc < 100 ? '⚠ Low balance — top up to avoid interruptions' : 'Credits power your bot, withdrawals & alerts'}</span>
                  <span style={{ color: '#374151', fontSize: 11 }}>{tc.toLocaleString(undefined, { maximumFractionDigits: 1 })} / {rm.toLocaleString()}</span>
                </div>
              </div>

              {/* HOW CREDITS ARE USED */}
              <div style={{ background: '#0d1117', border: '1px solid #1f2937', borderRadius: 14, padding: '16px 20px', marginBottom: 6 }}>
                <div style={{ color: '#4b5563', fontSize: 10, fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', marginBottom: 12 }}>How Credits Are Used</div>
                {[
                  { label: 'Telegram notification', detail: 'per alert / approval message', cost: '0.1' },
                  { label: 'Bot-completed sell order', detail: 'inbound — buyer pays you', cost: '0.5' },
                  { label: 'Bot-completed buy order (to bank)', detail: 'outbound via PesaLink', cost: '20' },
                  { label: 'Withdraw to bank (PesaLink)', detail: 'flat, any amount', cost: '20' },
                ].map((r, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid #161b24' }}>
                    <div>
                      <div style={{ color: '#e5e7eb', fontSize: 13, fontWeight: 600 }}>{r.label}</div>
                      <div style={{ color: '#4b5563', fontSize: 11 }}>{r.detail}</div>
                    </div>
                    <span style={{ color: '#f59e0b', fontWeight: 800, fontSize: 14, whiteSpace: 'nowrap' }}>{r.cost} cr</span>
                  </div>
                ))}
                {/* M-Pesa tiered — applies to both M-Pesa withdrawals and buy orders paid to M-Pesa */}
                <div style={{ padding: '9px 0 2px' }}>
                  <div style={{ color: '#e5e7eb', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Withdraw / buy order to M-Pesa <span style={{ color: '#4b5563', fontWeight: 400, fontSize: 11 }}>· by amount</span></div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {[
                      { range: 'Up to KES 1,500', cost: '6' },
                      { range: 'KES 1,501 – 7,500', cost: '12' },
                      { range: 'KES 7,501 – 15,000', cost: '18' },
                      { range: 'KES 15,001 – 40,000', cost: '22' },
                      { range: 'KES 40,001 – 250,000', cost: '24' },
                    ].map((t, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                        <span style={{ color: '#6b7280' }}>{t.range}</span>
                        <span style={{ color: '#f59e0b', fontWeight: 700 }}>{t.cost} cr</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Section: Credit Packages */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '22px 0 14px' }}>
                <div style={{ flex: 1, height: 1, background: '#1f2937' }} />
                <span style={{ color: '#4b5563', fontSize: 10, fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase' }}>Credit Packages</span>
                <div style={{ flex: 1, height: 1, background: '#1f2937' }} />
              </div>

              {/* Plan cards */}
              <div className="bc-plans-grid">
              {PLANS.map(p => {
                const isSelected = creditPlan === p.key;
                return (
                  <div key={p.key} style={{ marginBottom: 10 }}>
                    {p.topLabel && (
                      <div style={{ background: p.accent === '#10b981' ? 'rgba(16,185,129,0.15)' : 'rgba(167,139,250,0.15)', color: p.accent, textAlign: 'center', padding: '5px 0', fontSize: 10, fontWeight: 800, letterSpacing: '0.8px', textTransform: 'uppercase', borderRadius: '12px 12px 0 0', border: `1px solid ${isSelected ? p.accent : p.border}`, borderBottom: 'none' }}>
                        ★ {p.topLabel}
                      </div>
                    )}
                    <div onClick={() => { setCreditPlan(p.key); setCreditMsg(null); }}
                      style={{ background: '#0d1117', border: `1px solid ${isSelected ? p.accent : p.border}`,
                        borderRadius: p.topLabel ? '0 0 14px 14px' : 14, padding: '18px 20px', cursor: 'pointer', userSelect: 'none',
                        ...(isSelected ? { borderBottomLeftRadius: 0, borderBottomRightRadius: 0, boxShadow: `0 0 0 1px ${p.accent}` } : {}) }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                        <div>
                          <div style={{ color: '#fff', fontWeight: 800, fontSize: 18 }}>{p.label}</div>
                          <div style={{ color: '#6b7280', fontSize: 12, marginTop: 2 }}>{p.subtitle}</div>
                        </div>
                        <span style={{ background: `rgba(${p.glow},0.12)`, color: p.accent, fontSize: 10, fontWeight: 700, padding: '4px 9px', borderRadius: 6, whiteSpace: 'nowrap', flexShrink: 0 }}>Save {p.savings}%</span>
                      </div>
                      <div style={{ marginBottom: 14 }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 40, fontWeight: 900, color: '#fff', lineHeight: 1.1, letterSpacing: '-1px' }}>{p.credits.toLocaleString()}</span>
                          <span style={{ fontSize: 14, color: '#6b7280' }}>credits</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                          <span style={{ color: p.accent, fontWeight: 800, fontSize: 20 }}>KES {p.amount.toLocaleString()}</span>
                          <span style={{ color: '#4b5563', fontSize: 11 }}>KES {p.rate}/credit</span>
                        </div>
                      </div>
                      <div style={{ borderTop: '1px dashed #1f2937', marginBottom: 12 }} />
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 16 }}>
                        {p.features.map((feat, i) => (
                          <div key={i} style={{ color: i === 0 ? p.accent : '#6b7280', fontSize: 13 }}>❆ {feat}</div>
                        ))}
                      </div>
                      <button style={{ width: '100%', padding: '11px 0', borderRadius: 10, cursor: 'pointer', fontWeight: 700, fontSize: 14,
                        border: isSelected ? 'none' : `1px solid ${p.accent}55`,
                        background: isSelected ? p.accent : 'transparent',
                        color: isSelected ? (p.accent === '#9ca3af' ? '#111' : '#000') : p.accent }}>
                        {isSelected ? '✓ Selected' : `Choose ${p.label} →`}
                      </button>
                    </div>
                    <div className="bc-plan-form">{isSelected && renderPaymentForm(p)}</div>
                  </div>
                );
              })}
              </div>
              {/* Desktop: selected plan payment form shown full-width below the grid */}
              <div className="bc-desktop-form">
                {creditPlan && creditPlan !== 'pay_on_the_go' && (() => {
                  const sp = PLANS.find(pp => pp.key === creditPlan);
                  return sp ? renderPaymentForm(sp) : null;
                })()}
              </div>

              {/* Section: Pay As You Go */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '22px 0 14px' }}>
                <div style={{ flex: 1, height: 1, background: '#1f2937' }} />
                <span style={{ color: '#fb923c', fontSize: 10, fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase' }}>Pay As You Go</span>
                <div style={{ flex: 1, height: 1, background: '#1f2937' }} />
              </div>

              {(() => {
                const p = PAY_GO;
                const isSelected = creditPlan === p.key;
                return (
                  <div style={{ marginBottom: 10 }}>
                    <div onClick={() => { setCreditPlan(p.key); setCreditMsg(null); }}
                      style={{ background: '#0d1117', border: `1px solid ${isSelected ? p.accent : '#1f2937'}`, borderRadius: 14, padding: '18px 20px', cursor: 'pointer', userSelect: 'none',
                        ...(isSelected ? { borderBottomLeftRadius: 0, borderBottomRightRadius: 0, boxShadow: '0 0 0 1px #fb923c' } : {}) }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
                        <div>
                          <div style={{ color: '#fff', fontWeight: 800, fontSize: 18 }}>Pay On The Go</div>
                          <div style={{ color: '#6b7280', fontSize: 12, marginTop: 2 }}>No commitment · buy only what you need</div>
                        </div>
                        <span style={{ background: 'rgba(251,146,60,0.12)', color: '#fb923c', fontSize: 10, fontWeight: 700, padding: '4px 9px', borderRadius: 6 }}>FLEXIBLE</span>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
                        <div style={{ background: 'rgba(251,146,60,0.07)', border: '1px solid rgba(251,146,60,0.15)', borderRadius: 10, padding: '12px 14px' }}>
                          <div style={{ color: '#6b7280', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>Rate</div>
                          <div style={{ color: '#fff', fontWeight: 900, fontSize: 24, lineHeight: 1 }}>KES 40</div>
                          <div style={{ color: '#6b7280', fontSize: 11, marginTop: 2 }}>per credit</div>
                        </div>
                        <div style={{ background: 'rgba(251,146,60,0.07)', border: '1px solid rgba(251,146,60,0.15)', borderRadius: 10, padding: '12px 14px' }}>
                          <div style={{ color: '#6b7280', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>Minimum</div>
                          <div style={{ color: '#fb923c', fontWeight: 900, fontSize: 24, lineHeight: 1 }}>KES 500</div>
                          <div style={{ color: '#6b7280', fontSize: 11, marginTop: 2 }}>any amount above</div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
                        {['Pay any amount', 'Never expires', 'Instant credit'].map(chip => (
                          <span key={chip} style={{ background: 'rgba(251,146,60,0.1)', color: '#fb923c', fontSize: 11, fontWeight: 600, padding: '4px 12px', borderRadius: 20 }}>{chip}</span>
                        ))}
                      </div>
                      <button style={{ width: '100%', padding: '11px 0', borderRadius: 10, cursor: 'pointer', fontWeight: 700, fontSize: 14,
                        border: isSelected ? 'none' : '1px solid rgba(251,146,60,0.4)',
                        background: isSelected ? '#fb923c' : 'transparent',
                        color: isSelected ? '#000' : '#fb923c' }}>
                        {isSelected ? '✓ Selected' : 'Pay as you go →'}
                      </button>
                    </div>
                    {isSelected && renderPaymentForm(p)}
                  </div>
                );
              })()}

            </div>
          );
        })()}


      <SupportChat forceOpen={openSupportChat} onOpen={() => setOpenSupportChat(false)} />

      </main>
      </div> {/* dash-body */}

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
                  style={{ width: '100%', padding: '11px 14px', borderRadius: 8, border: '1px solid #374151', background: '#111827', color: '#fff', fontSize: 20, fontWeight: 700, letterSpacing: 3, textAlign: 'center', marginBottom: 12, boxSizing: 'border-box' }}
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
                <span style={{ color: '#fff', fontWeight: 600 }}>{profile?.choice_paybill || '444174'}</span>
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

            {/* Binance Ad Counterparty Filters (modal) */}
            <div style={{ background: '#111827', border: `1px solid ${cfEnabled ? 'rgba(245,158,11,0.4)' : '#374151'}`, borderRadius: 10, padding: '14px 16px', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: cfEnabled ? 14 : 0 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 600 }}>Binance Ad Counterparty Filters</div>
                  <div style={{ color: '#6b7280', fontSize: 12, marginTop: 2 }}>
                    {profile?.cf_last_pushed_at
                      ? `Last pushed to Binance: ${new Date(profile.cf_last_pushed_at).toLocaleString('en-KE', { dateStyle: 'short', timeStyle: 'short' })}`
                      : 'Filters pushed to all your sell ads on save'}
                  </div>
                </div>
                <div onClick={() => setCfEnabled(v => !v)}
                  style={{ width: 40, height: 22, borderRadius: 11, background: cfEnabled ? '#f59e0b' : '#374151', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
                  <div style={{ position: 'absolute', top: 3, left: cfEnabled ? 20 : 3, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
                </div>
              </div>
              {cfEnabled && (
                <div style={{ display: 'flex', gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: '#9ca3af', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>Min Total Trades (30D)</div>
                    <input type="number" min="0" value={cfAllTradesMin} onChange={e => setCfAllTradesMin(e.target.value)}
                      style={{ width: '100%', background: '#0d1117', border: '1px solid #374151', borderRadius: 7, padding: '8px 10px', color: '#e5e7eb', fontSize: 14, boxSizing: 'border-box' }} />
                    <div style={{ color: '#6b7280', fontSize: 10, marginTop: 3 }}>0 = off · bot enforced</div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: '#9ca3af', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>Min Total Trades (All Time)</div>
                    <input type="number" min="0" value={cfAllTradesMinAll} onChange={e => setCfAllTradesMinAll(e.target.value)}
                      style={{ width: '100%', background: '#0d1117', border: '1px solid #374151', borderRadius: 7, padding: '8px 10px', color: '#e5e7eb', fontSize: 14, boxSizing: 'border-box' }} />
                    <div style={{ color: '#6b7280', fontSize: 10, marginTop: 3 }}>0 = off · Binance enforced 24/7</div>
                  </div>
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
                  const res = await api.put('/traders/trading-config', { bot_trade_mode: botTradeMode, dd_enabled: ddEnabled, dd_min_30d_trades: ddMin30d, dd_min_all_trades: ddMinAll, cf_filters_enabled: cfEnabled, cf_all_trades_min: parseInt(cfAllTradesMin) || 0, cf_all_trades_min_all: parseInt(cfAllTradesMinAll) || 0 });
                  configSavedAt.current = Date.now();
                  setConfigSaved(true);
                  setTimeout(() => { setConfigSaved(false); if (showConfigModal) setShowConfigModal(false); }, 1500);
                  checkCfSync(); // refresh live Binance sync badge
                  if (res?.data?.warning) alert(res.data.warning);
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

      {/* Choice Bank → Bank Withdrawal Modal */}
      {showCbWithdrawModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}>
          <div style={{ background: '#1f2937', borderRadius: 16, padding: 28, width: '100%', maxWidth: 420, boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 style={{ color: '#fff', fontSize: 18, margin: 0 }}>↗️ Withdraw from Choice Bank</h3>
              <button onClick={() => setShowCbWithdrawModal(false)} style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 22 }}>×</button>
            </div>

            {/* No bank configured */}
            {!cbWithdrawBank?.bank_code ? (
              <div style={{ textAlign: 'center', padding: '24px 0' }}>
                <div style={{ fontSize: 36, marginBottom: 12 }}>🏦</div>
                <p style={{ color: '#f59e0b', fontWeight: 700, marginBottom: 8 }}>No withdrawal bank set up</p>
                <p style={{ color: '#9ca3af', fontSize: 13, marginBottom: 20 }}>Go to Settings → Bank Account to add your bank account before withdrawing.</p>
                <button onClick={() => { setShowCbWithdrawModal(false); setSettingsInitialSection("bank"); setActiveTab("settings"); }} style={{ padding: "10px 24px", borderRadius: 8, border: "none", background: "#f59e0b", color: "#000", fontWeight: 700, cursor: "pointer" }}>
                  Go to Settings
                </button>
              </div>
            ) : (
              <>
                {/* Saved bank details */}
                <div style={{ background: '#111827', borderRadius: 10, padding: '14px 16px', marginBottom: 16 }}>
                  <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>Withdrawal Destination</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 2 }}>{cbWithdrawBank.bank_name}</div>
                  <div style={{ fontSize: 13, color: '#9ca3af' }}>{cbWithdrawBank.account} · {cbWithdrawBank.account_name}</div>
                </div>

                {/* Amount */}
                <div style={{ marginBottom: 16 }}>
                  <label style={{ display: 'block', color: '#9ca3af', fontSize: 12, marginBottom: 6 }}>
                    Amount (KES) · Balance: <span style={{ color: '#10b981', fontWeight: 700 }}>KES {Number(cbDashBalance?.balance || 0).toLocaleString()}</span>
                  </label>
                  <div style={{ position: 'relative' }}>
                    <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#6b7280', fontSize: 13 }}>KES</span>
                    <input type="number" min={100} step={1}
                      value={cbWithdrawAmount}
                      onChange={e => setCbWithdrawAmount(e.target.value)}
                      style={{ width: '100%', padding: '11px 14px 11px 44px', borderRadius: 8, border: '1px solid #374151', background: '#111827', color: '#fff', fontSize: 15, boxSizing: 'border-box' }}
                    />
                    <button onClick={() => setCbWithdrawAmount(String(Math.round((cbDashBalance?.balance || 0) * 100) / 100))}
                      style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#10b981', fontSize: 11, cursor: 'pointer', fontWeight: 700 }}>
                      MAX
                    </button>
                  </div>
                </div>

                {/* Fee breakdown */}
                {parseFloat(cbWithdrawAmount) > 0 && (() => {
                  const amt = parseFloat(cbWithdrawAmount) || 0;
                  const CREDIT_FEE = 20;
                  const traderCredits = profile?.trade_tokens || 0;
                  const hasCredits = traderCredits >= CREDIT_FEE;
                  return (
                    <div style={{ background: '#111827', borderRadius: 10, padding: '14px 16px', marginBottom: 16, fontSize: 13 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, color: '#9ca3af' }}>
                        <span>Withdrawal Amount</span><span style={{ color: '#fff', fontWeight: 600 }}>KES {amt.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                      </div>
                      <div style={{ borderTop: '1px solid #374151', paddingTop: 8, marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#10b981', fontWeight: 700 }}>You Receive</span>
                        <span style={{ color: '#10b981', fontWeight: 700, fontSize: 15 }}>KES {amt.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                      </div>
                      <div style={{ borderTop: '1px solid #1f2937', paddingTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <div style={{ color: '#a78bfa', fontWeight: 700, fontSize: 12 }}>SparkP2P Service Fee</div>
                          <div style={{ color: '#6b7280', fontSize: 11, marginTop: 2 }}>Your balance: {traderCredits.toLocaleString()} credits</div>
                        </div>
                        <span style={{ color: hasCredits ? '#a78bfa' : '#ef4444', fontWeight: 700, fontSize: 13 }}>
                          {CREDIT_FEE} credits {hasCredits ? '' : '(insufficient)'}
                        </span>
                      </div>
                    </div>
                  );
                })()}

                {cbWithdrawMsg && (
                  <p style={{ color: cbWithdrawMsg.includes('sent') || cbWithdrawMsg.includes('success') ? '#10b981' : '#ef4444', fontSize: 12, marginBottom: 10 }}>{cbWithdrawMsg}</p>
                )}

                {/* Channel selector */}
                <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                  {['mpesa', 'bank'].map(ch => (
                    <button key={ch} onClick={() => { setCbWithdrawChannel(ch); setCbWithdrawOtpSent(false); setCbWithdrawOtp(''); setCbWithdrawMsg(''); }}
                      style={{ flex: 1, padding: '8px 0', borderRadius: 8, border: `1px solid ${cbWithdrawChannel === ch ? '#10b981' : '#374151'}`, background: cbWithdrawChannel === ch ? 'rgba(16,185,129,0.15)' : 'none', color: cbWithdrawChannel === ch ? '#10b981' : '#9ca3af', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                      {ch === 'mpesa' ? '📱 M-Pesa' : '🏦 Bank (Pesalink)'}
                    </button>
                  ))}
                </div>
                {!cbWithdrawOtpSent ? (
                  <>
                    <p style={{ color: '#9ca3af', fontSize: 12, marginBottom: 14 }}>
                      {cbWithdrawChannel === 'mpesa'
                        ? `Funds will be sent to your M-Pesa settlement number${profile?.settlement_mpesa_phone ? ' (' + profile.settlement_mpesa_phone + ')' : ''}.`
                        : 'Funds will be sent to your configured bank account via Pesalink.'}
                    </p>
                    <button
                      disabled={cbWithdrawOtpLoading || !parseFloat(cbWithdrawAmount) || (profile?.trade_tokens || 0) < 20}
                      onClick={async () => {
                        const minAmt = cbWithdrawChannel === 'mpesa' ? 10 : 100; if (!parseFloat(cbWithdrawAmount) || parseFloat(cbWithdrawAmount) < minAmt) { setCbWithdrawMsg(`Minimum withdrawal is KES ${minAmt}`); return; }
                        if ((profile?.trade_tokens || 0) < 20) { setCbWithdrawMsg('You need at least 20 credits to withdraw'); return; }
                        setCbWithdrawOtpLoading(true); setCbWithdrawMsg('');
                        try {
                          const initFn = cbWithdrawChannel === 'mpesa' ? cbWithdrawToMpesaInitiate : cbWithdrawInitiate;
                          const r = await initFn(parseFloat(cbWithdrawAmount));
                          setCbWithdrawOtpSent(true);
                          setCbWithdrawMsg(r.data?.message || 'OTP sent to your phone. Enter it to confirm.');
                        } catch(e) { setCbWithdrawMsg(e.response?.data?.detail || 'Failed to send OTP'); }
                        setCbWithdrawOtpLoading(false);
                      }}
                      style={{ width: '100%', padding: '11px 0', borderRadius: 8, border: 'none', background: (parseFloat(cbWithdrawAmount) >= 100 && (profile?.trade_tokens || 0) >= 20) ? 'linear-gradient(135deg,#ef4444,#dc2626)' : '#374151', color: '#fff', fontWeight: 700, fontSize: 14, cursor: (parseFloat(cbWithdrawAmount) >= 100 && (profile?.trade_tokens || 0) >= 20) ? 'pointer' : 'not-allowed' }}
                    >
                      {cbWithdrawOtpLoading ? 'Sending OTP...' : (profile?.trade_tokens || 0) < 20 ? 'Insufficient credits (need 20)' : 'Send OTP to authorize'}
                    </button>
                  </>
                ) : (
                  <>
                    <input type="text" maxLength={8} placeholder="Enter OTP from Choice Bank"
                      value={cbWithdrawOtp}
                      onChange={e => setCbWithdrawOtp(e.target.value.replace(/\D/g, ''))}
                      style={{ width: '100%', padding: '11px 14px', borderRadius: 8, border: '1px solid #374151', background: '#111827', color: '#fff', fontSize: 20, fontWeight: 700, letterSpacing: 3, textAlign: 'center', marginBottom: 12, boxSizing: 'border-box' }}
                    />
                    <button
                      disabled={cbWithdrawLoading || cbWithdrawOtp.length < 4}
                      onClick={async () => {
                        if (cbWithdrawOtp.length < 4) return;
                        setCbWithdrawLoading(true); setCbWithdrawMsg('');
                        try {
                          const r = await cbWithdrawToBank(cbWithdrawOtp, parseFloat(cbWithdrawAmount));
                          setCbWithdrawMsg(r.data?.message || 'Withdrawal initiated!');
                          setTimeout(() => setShowCbWithdrawModal(false), 2500);
                        } catch(e) { setCbWithdrawMsg(e.response?.data?.detail || 'Withdrawal failed. Please try again.'); }
                        setCbWithdrawLoading(false);
                      }}
                      style={{ width: '100%', padding: '11px 0', borderRadius: 8, border: 'none', background: cbWithdrawOtp.length >= 4 ? 'linear-gradient(135deg,#ef4444,#dc2626)' : '#374151', color: '#fff', fontWeight: 700, fontSize: 14, cursor: cbWithdrawOtp.length >= 4 ? 'pointer' : 'not-allowed', marginBottom: 8 }}
                    >
                      {cbWithdrawLoading ? 'Processing...' : 'Confirm Withdrawal'}
                    </button>
                    <button onClick={() => { setCbWithdrawOtpSent(false); setCbWithdrawOtp(''); setCbWithdrawMsg(''); }}
                      style={{ width: '100%', padding: '8px 0', borderRadius: 8, border: '1px solid #374151', background: 'none', color: '#9ca3af', fontSize: 13, cursor: 'pointer' }}>
                      Resend OTP
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Choice Bank STK Push Deposit Modal */}
      {showCbDepositModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--surface)', borderRadius: 16, padding: 28, width: 360, border: '1px solid var(--border)', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 style={{ margin: 0, color: '#fff', fontSize: 18 }}>🏦 Deposit to Choice Bank</h3>
              <button onClick={() => setShowCbDepositModal(false)} style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 20 }}>✕</button>
            </div>
            <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 16, lineHeight: 1.5 }}>
              An M-Pesa STK push will be sent to the number below. Enter your M-Pesa PIN to complete the deposit into your Choice Bank account.
            </div>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>M-Pesa Number</div>
              <input
                type="tel"
                placeholder="e.g. 0712345678"
                value={cbDepositPhone}
                onChange={e => setCbDepositPhone(e.target.value)}
                style={{ width: '100%', padding: '12px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: '#fff', fontSize: 15, fontWeight: 600, boxSizing: 'border-box' }}
              />
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>You can use any M-Pesa number to fund your account</div>
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>Amount (KES)</div>
              <input
                type="number"
                min="1"
                placeholder="e.g. 5000"
                value={cbDepositAmount}
                onChange={e => setCbDepositAmount(e.target.value)}
                style={{ width: '100%', padding: '12px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: '#fff', fontSize: 16, fontWeight: 600, boxSizing: 'border-box' }}
              />
            </div>
            {cbDepositMsg && (
              <div style={{ marginBottom: 12, padding: '10px 14px', borderRadius: 8, background: cbDepositMsg.includes('✅') ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)', border: `1px solid ${cbDepositMsg.includes('✅') ? '#10b981' : '#ef4444'}44`, color: cbDepositMsg.includes('✅') ? '#10b981' : '#ef4444', fontSize: 13 }}>
                {cbDepositMsg}
              </div>
            )}
            <button
              disabled={cbDepositLoading || !cbDepositAmount || Number(cbDepositAmount) < 1 || !cbDepositPhone.trim()}
              onClick={async () => {
                setCbDepositLoading(true); setCbDepositMsg('');
                try {
                  await choiceDeposit({ amount: Math.floor(Number(cbDepositAmount)), mobile: cbDepositPhone.trim() });
                  setCbDepositMsg('✅ STK push sent! Check your phone and enter your M-Pesa PIN.');
                  setCbDepositAmount('');
                } catch (e) {
                  setCbDepositMsg(e?.response?.data?.detail || 'Failed to send STK push. Please try again.');
                }
                setCbDepositLoading(false);
              }}
              style={{ width: '100%', padding: '13px 0', borderRadius: 9, border: 'none', background: cbDepositLoading || !cbDepositAmount || !cbDepositPhone.trim() ? '#374151' : 'linear-gradient(135deg, #10b981, #059669)', color: '#fff', fontWeight: 700, fontSize: 15, cursor: cbDepositLoading || !cbDepositAmount || !cbDepositPhone.trim() ? 'not-allowed' : 'pointer' }}
            >
              {cbDepositLoading ? 'Sending STK Push…' : 'Send M-Pesa Prompt'}
            </button>
          </div>
        </div>
      )}

      {/* ── Mobile bottom navigation bar ── */}
      <nav className="mob-bottom-nav">
        {[
          { key: 'overview',      icon: LayoutDashboard, label: 'Overview'  },
          { key: 'orders',        icon: List,            label: 'Orders'    },
          { key: 'transactions',  icon: ArrowRightLeft,  label: 'Trades'    },
          { key: 'settings',      icon: Settings,        label: 'Settings'  },
          { key: 'more',          icon: MoreHorizontal,  label: 'More'      },
        ].map(({ key, icon: Icon, label }) => {
          const primaryKeys = ['overview','orders','transactions','settings'];
          const isActive = activeTab === key || (key === 'more' && !primaryKeys.includes(activeTab));
          return (
            <button
              key={key}
              className={`mob-nav-btn${isActive ? ' mob-active' : ''}`}
              onClick={() => key === 'more' ? setMobMoreOpen(true) : setActiveTab(key)}
            >
              <Icon size={22} />
              <span className="mob-nav-label">{label}</span>
            </button>
          );
        })}
      </nav>

      {/* ── Mobile more menu overlay ── */}
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
            {[
              { key: 'logs',         label: 'Bot Logs',    icon: Activity    },
              ...(affiliateData?.affiliate ? [{ key: 'affiliates', label: 'Affiliates', icon: Share2 }] : []),
              { key: 'credits',      label: 'Buy Credits', icon: DollarSign  },
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
