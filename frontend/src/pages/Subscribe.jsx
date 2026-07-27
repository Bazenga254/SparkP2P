import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { getSubscriptionStatus, initiateSubscription, renewSubscription, getPaymentInfo } from '../services/api';
import { ArrowLeft, Check, Crown, Zap, Shield, Clock, Rocket } from 'lucide-react';

// Presentation only. The plan NAME and PRICE are fetched from the backend
// (payment-info -> plans, sourced from plans.py PLAN_CONFIG — the same values that set the
// actual STK amount), so this page can never advertise a price we don't charge.
const PLAN_UI = {
  starter: {
    icon: Zap,
    features: ['Sell-side automation', 'Automatic crypto release', 'M-Pesa payment matching', 'Up to 30 trades/day', 'Telegram notifications'],
    disabled: ['Buy-side auto-pay'],
  },
  pro: {
    icon: Crown,
    features: ['Everything in Bronze', 'Buy-side auto-pay', 'Up to 80 trades/day', 'Priority settlement', 'Advanced analytics'],
  },
  pro_max: {
    icon: Rocket, badge: 'Most Popular',
    features: ['Everything in Silver', 'Unlimited trades/day', 'Unlimited Telegram alerts', 'Priority support', 'Dedicated onboarding'],
  },
};
// Mirrors plans.py; only used for the first paint, before the backend list arrives.
const PLAN_FALLBACK = [
  { key: 'starter', label: 'Bronze', price: 10000 },
  { key: 'pro',     label: 'Silver', price: 11000 },
  { key: 'pro_max', label: 'Gold',   price: 13000 },
];
const fmtKes = n => 'KES ' + Number(n).toLocaleString('en-KE');

export default function Subscribe() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [subscription, setSubscription] = useState(null);
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [polling, setPolling] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const [planList, setPlanList] = useState(PLAN_FALLBACK);

  // Pull the live plan names/prices from the backend so they always match what we charge.
  useEffect(() => {
    getPaymentInfo()
      .then(r => { if (r.data?.plans?.length) setPlanList(r.data.plans); })
      .catch(() => { /* keep the fallback */ });
  }, []);

  const PLANS = planList
    .filter(p => PLAN_UI[p.key])
    .map(p => ({ id: p.key, name: p.label, price: p.price, ...PLAN_UI[p.key] }));
  const planById = id => PLANS.find(p => p.id === id);
  // Plans are LOCKED to the merchant's live Binance P2P tier — gold→Gold, silver→Silver,
  // bronze→Bronze. Only the matching plan is selectable. (Tier unknown → leave all open.)
  const tierPlanKey = { gold: 'pro_max', silver: 'pro', bronze: 'starter' }[(user?.binance_merchant_tier || '').toLowerCase()] || null;

  // Default the selection to the tier-matching plan so the payment form is prefilled.
  useEffect(() => {
    if (tierPlanKey && !selectedPlan) setSelectedPlan(tierPlanKey);
  }, [tierPlanKey]);  // eslint-disable-line react-hooks/exhaustive-deps

  const loadStatus = async () => {
    try {
      const res = await getSubscriptionStatus();
      setSubscription(res.data);
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
    // Stop polling after 2 minutes
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
          <p>Your plan is set automatically by your Binance merchant tier{tierPlanKey ? ` — you're on ${planById(tierPlanKey)?.name || 'your'}` : ''}. All tiers get unlimited trades and Telegram alerts.</p>
        </div>

        {/* Current Status */}
        {subscription?.has_subscription && (
          <div className="current-plan-banner">
            <div className="current-plan-info">
              <Shield size={20} />
              <div>
                <strong>{(planById(subscription.plan)?.name) || 'Your'} Plan</strong>
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
          {PLANS.map(plan => {
            const Icon = plan.icon;
            const locked = tierPlanKey && plan.id !== tierPlanKey;
            return (
              <div
                key={plan.id}
                className={`plan-card ${plan.badge ? 'pro' : ''} ${selectedPlan === plan.id ? 'selected' : ''} ${locked ? 'locked' : ''}`}
                onClick={() => { if (!locked) setSelectedPlan(plan.id); }}
                style={locked ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
                title={locked ? 'Your plan is set automatically by your Binance merchant tier' : undefined}
              >
                {plan.badge && <div className="plan-badge">{plan.badge}</div>}
                <div className="plan-card-header">
                  <Icon size={24} />
                  <h2>{plan.name}</h2>
                </div>
                <div className="plan-price">
                  <span className="price-amount">{fmtKes(plan.price)}</span>
                  <span className="price-period">/month</span>
                </div>
                <ul className="plan-features">
                  {plan.features.map(f => <li key={f}><Check size={16} /> {f}</li>)}
                  {(plan.disabled || []).map(f => <li key={f} className="feature-disabled">{f}</li>)}
                </ul>
                <div className="plan-card-select">
                  {locked ? '🔒 Set by Binance tier' : selectedPlan === plan.id ? 'Selected' : 'Select Plan'}
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
              {planById(selectedPlan)?.name} Plan — {fmtKes(planById(selectedPlan)?.price)}
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
              {polling ? 'Waiting for payment...' : submitting ? 'Sending STK Push...' : `Pay ${fmtKes(planById(selectedPlan)?.price)}`}
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
