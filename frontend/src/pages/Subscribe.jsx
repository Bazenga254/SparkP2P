import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { getSubscriptionStatus, initiateSubscription, renewSubscription } from '../services/api';
import { ArrowLeft, Check, Crown, Zap, Shield, Clock } from 'lucide-react';

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
          <p>Choose a plan to automate your Binance P2P trades</p>
        </div>

        {/* Current Status */}
        {subscription?.has_subscription && (
          <div className="current-plan-banner">
            <div className="current-plan-info">
              <Shield size={20} />
              <div>
                <strong>{subscription.plan === 'pro' ? 'Pro' : 'Starter'} Plan</strong>
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
          <div
            className={`plan-card ${selectedPlan === 'starter' ? 'selected' : ''}`}
            onClick={() => setSelectedPlan('starter')}
          >
            <div className="plan-card-header">
              <Zap size={24} />
              <h2>Starter</h2>
            </div>
            <div className="plan-price">
              <span className="price-amount">KES 5,000</span>
              <span className="price-period">/month</span>
            </div>
            <ul className="plan-features">
              <li><Check size={16} /> Sell-side automation</li>
              <li><Check size={16} /> Auto crypto release</li>
              <li><Check size={16} /> Payment matching</li>
              <li><Check size={16} /> Chat notifications</li>
              <li className="feature-disabled">Buy-side auto-pay</li>
            </ul>
            <div className="plan-card-select">
              {selectedPlan === 'starter' ? 'Selected' : 'Select Plan'}
            </div>
          </div>

          <div
            className={`plan-card pro ${selectedPlan === 'pro' ? 'selected' : ''}`}
            onClick={() => setSelectedPlan('pro')}
          >
            <div className="plan-badge">Most Popular</div>
            <div className="plan-card-header">
              <Crown size={24} />
              <h2>Pro</h2>
            </div>
            <div className="plan-price">
              <span className="price-amount">KES 10,000</span>
              <span className="price-period">/month</span>
            </div>
            <ul className="plan-features">
              <li><Check size={16} /> Everything in Starter</li>
              <li><Check size={16} /> Buy-side auto-pay</li>
              <li><Check size={16} /> Priority settlement</li>
              <li><Check size={16} /> Advanced analytics</li>
              <li><Check size={16} /> Priority support</li>
            </ul>
            <div className="plan-card-select">
              {selectedPlan === 'pro' ? 'Selected' : 'Select Plan'}
            </div>
          </div>
        </div>

        {/* Payment Form */}
        {selectedPlan && (
          <div className="payment-form">
            <h3>
              {subscription?.has_subscription ? 'Renew' : 'Pay'} with M-Pesa
            </h3>
            <p className="payment-summary">
              {selectedPlan === 'pro' ? 'Pro' : 'Starter'} Plan — KES {selectedPlan === 'pro' ? '10,000' : '5,000'}
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
              {polling ? 'Waiting for payment...' : submitting ? 'Sending STK Push...' : `Pay KES ${selectedPlan === 'pro' ? '10,000' : '5,000'}`}
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
