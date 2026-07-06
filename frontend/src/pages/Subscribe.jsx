import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { getSubscriptionStatus, initiateSubscription, renewSubscription, getProfile } from '../services/api';
import { ArrowLeft, Check, Crown, Zap, Shield, Clock, Rocket } from 'lucide-react';

// Plans mirror backend/app/services/plans.py PLAN_CONFIG.
// Display prices in USD; M-Pesa charges the KES equivalent in background.
// The frontend only sends the plan id; the backend sets the actual STK amount.
const PLANS = [
  {
    id: 'starter', name: 'Bronze', usdPrice: 75, kesPrice: 10000, icon: Zap,
    tier: 'bronze',
    features: ['Sell-side automation', 'Automatic crypto release', 'M-Pesa payment matching', 'Up to 30 trades/day', 'Telegram notifications'],
    description: 'Suited for Bronze merchants',
  },
  {
    id: 'pro', name: 'Silver', usdPrice: 85, kesPrice: 11000, icon: Crown,
    tier: 'silver',
    features: ['Everything in Bronze', 'Buy-side auto-pay', 'Up to 80 trades/day', 'Priority settlement', 'Advanced analytics'],
    description: 'Suited for Silver merchants',
  },
  {
    id: 'pro_max', name: 'Gold', usdPrice: 99, kesPrice: 13000, icon: Rocket, badge: 'Most Popular',
    tier: 'gold',
    features: ['Everything in Silver', 'Unlimited trades/day', 'Unlimited Telegram alerts', 'Priority support', 'Dedicated onboarding'],
    description: 'Suited for Gold merchants',
  },
];
const fmtUsd = n => '$' + Number(n).toLocaleString('en-US');
const fmtKes = n => 'KES ' + Number(n).toLocaleString('en-KE');
const planById = id => PLANS.find(p => p.id === id);

// Merchant tier → plan tier mapping
const TIER_PLAN = { bronze: 'starter', silver: 'pro', gold: 'pro_max' };

export default function Subscribe() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [subscription, setSubscription] = useState(null);
  const [merchantTier, setMerchantTier] = useState(null); // 'bronze'|'silver'|'gold'|null
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [polling, setPolling] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  const loadStatus = async () => {
    try {
      const [res, profileRes] = await Promise.all([
        getSubscriptionStatus(),
        getProfile().catch(() => null),
      ]);
      setSubscription(res.data);
      const tier = profileRes?.data?.binance_merchant_tier || null;
      setMerchantTier(tier);
      // Auto-select the matching plan when merchant tier is known
      if (tier && TIER_PLAN[tier]) setSelectedPlan(TIER_PLAN[tier]);
    } catch (err) {
      console.error('Failed to load subscription status:', err);
    }
    setLoading(false);
  };

  useEffect(() => {
    loadStatus();
  }, []);

  // Poll for payment confirmation
  useEffect(() => {
    if (!polling) return;
    const interval = setInterval(async () => {
      try {
        const res = await getSubscriptionStatus();
        if (res.data.has_subscription) {
          setSubscription(res.data);
          setPolling(false);
          setMessage({ type: 'success', text: 'Subscription activated successfully!' });
        }
      } catch (err) {
        // keep polling
      }
    }, 5000);
    const timeout = setTimeout(() => {
      setPolling(false);
      setMessage({ type: 'warning', text: 'Payment confirmation timeout. If you paid, refresh the page in a minute.' });
    }, 120000);
    return () => { clearInterval(interval); clearTimeout(timeout); };
  }, [polling]);

  const handleSubscribe = async () => {
    if (!selectedPlan || !phone) {
      setError('Please select a plan and enter your M-Pesa phone number.');
      return;
    }
    setError(null);
    setMessage(null);
    setSubmitting(true);

    try {
      const fn = subscription?.has_subscription ? renewSubscription : initiateSubscription;
      const res = await fn(selectedPlan, phone);
      setMessage({ type: 'info', text: res.data.message });
      setPolling(true);
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to initiate payment. Try again.');
    }
    setSubmitting(false);
  };

  // Plans visible to this user: if merchant tier known, show only matching plan; otherwise all
  const visiblePlans = merchantTier
    ? PLANS.filter(p => p.tier === merchantTier)
    : PLANS;

  const isPlanDisabled = (plan) => {
    // When a merchant tier is known, only the matching plan is selectable
    if (merchantTier && plan.tier !== merchantTier) return true;
    return submitting || polling;
  };

  if (loading) {
    return <div className="subscribe-page"><div className="loading">Loading...</div></div>;
  }

  return (
    <div className="subscribe-page">
      <div className="subscribe-container">
        <button className="back-btn" onClick={() => navigate('/dashboard')}>
          <ArrowLeft size={18} /> Back to Dashboard
        </button>

        <div className="subscribe-header">
          <Crown size={36} className="subscribe-icon" />
          <h1>SparkP2P Subscription</h1>
          <p>Choose a plan to automate your Binance P2P trades</p>
          {merchantTier && (
            <div className="tier-detected-badge" style={{ marginTop: 8, fontSize: 13, color: merchantTier === 'gold' ? '#FFBE52' : merchantTier === 'silver' ? '#D6DBE2' : '#F08A3C', fontWeight: 600 }}>
              Detected: {merchantTier.charAt(0).toUpperCase() + merchantTier.slice(1)} Merchant
            </div>
          )}
        </div>

        {/* Current Status */}
        {subscription?.has_subscription && (
          <div className="current-plan-banner">
            <div className="current-plan-info">
              <Shield size={20} />
              <div>
                <strong>{(planById(subscription.plan)?.name) || 'Bronze'} Plan</strong>
                <span className="plan-status active">Active</span>
              </div>
            </div>
            <div className="current-plan-details">
              <Clock size={16} />
              <span>{subscription.days_remaining} days remaining</span>
              <span className="plan-expires">Expires: {new Date(subscription.expires_at).toLocaleDateString()}</span>
            </div>
          </div>
        )}

        {!subscription?.has_subscription && (
          <div className="no-plan-banner">
            <p>You don't have an active subscription. Subscribe below to enable trade automation.</p>
          </div>
        )}

        {/* Plan Cards */}
        <div className="plan-cards">
          {visiblePlans.map(plan => {
            const Icon = plan.icon;
            const disabled = isPlanDisabled(plan);
            return (
              <div
                key={plan.id}
                className={`plan-card ${plan.badge ? 'pro' : ''} ${selectedPlan === plan.id ? 'selected' : ''} ${disabled ? 'disabled' : ''}`}
                onClick={() => !disabled && setSelectedPlan(plan.id)}
                style={disabled ? { opacity: 0.45, cursor: 'not-allowed' } : {}}
              >
                {plan.badge && <div className="plan-badge">{plan.badge}</div>}
                <div className="plan-card-header">
                  <Icon size={24} />
                  <h2>{plan.name}</h2>
                </div>
                <div className="plan-price">
                  <span className="price-amount">{fmtUsd(plan.usdPrice)}</span>
                  <span className="price-period">/month</span>
                </div>
                <div className="plan-kes-note" style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2, marginBottom: 8 }}>
                  M-Pesa: {fmtKes(plan.kesPrice)}
                </div>
                <div className="plan-desc" style={{ fontSize: 12.5, color: 'var(--text-2)', marginBottom: 12, fontStyle: 'italic' }}>
                  {plan.description}
                </div>
                <ul className="plan-features">
                  {plan.features.map(f => <li key={f}><Check size={16} /> {f}</li>)}
                </ul>
                <div className="plan-card-select">
                  {selectedPlan === plan.id ? 'Selected' : 'Select Plan'}
                </div>
              </div>
            );
          })}
        </div>

        {/* Payment Form */}
        {selectedPlan && (
          <div className="payment-form">
            <h3>
              {subscription?.has_subscription ? 'Renew' : 'Pay'} with M-Pesa
            </h3>
            <p className="payment-summary">
              {planById(selectedPlan)?.name} Plan — {fmtUsd(planById(selectedPlan)?.usdPrice)} ({fmtKes(planById(selectedPlan)?.kesPrice)} charged via M-Pesa)
            </p>

            <div className="phone-input-group">
              <label>M-Pesa Phone Number</label>
              <input
                type="tel"
                placeholder="e.g. 0712345678"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={submitting || polling}
              />
            </div>

            {error && <div className="sub-error">{error}</div>}
            {message && (
              <div className={`sub-message ${message.type}`}>
                {message.text}
              </div>
            )}

            <button
              className="pay-btn"
              onClick={handleSubscribe}
              disabled={submitting || polling || !phone}
            >
              {polling ? 'Waiting for payment...' : submitting ? 'Sending STK Push...' : `Pay ${fmtKes(planById(selectedPlan)?.kesPrice)} via M-Pesa`}
            </button>

            {polling && (
              <p className="polling-hint">
                Check your phone for the M-Pesa prompt. Enter your PIN to complete payment.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
