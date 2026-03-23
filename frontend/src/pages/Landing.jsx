import { Link } from 'react-router-dom';

export default function Landing() {
  return (
    <div className="landing">
      {/* Navigation */}
      <nav className="land-nav">
        <div className="land-nav-inner">
          <div className="land-nav-brand">
            <img src="/logo.png" alt="SparkP2P" className="land-nav-logo" />
            <span className="land-nav-name">SparkP2P</span>
          </div>
          <div className="land-nav-links">
            <a href="#features">Features</a>
            <a href="#pricing">Pricing</a>
            <Link to="/login" className="land-nav-login">Login</Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="land-hero">
        <div className="land-hero-content">
          <div className="land-hero-badge">Trusted by Kenyan P2P Merchants</div>
          <h1>Automate Your<br /><span className="land-highlight">Binance P2P Trading</span></h1>
          <p className="land-hero-sub">
            Stop manually releasing crypto and verifying payments. SparkP2P handles everything — powered by Spark AI.
          </p>
          <div className="land-hero-actions">
            <Link to="/login" className="land-cta-primary">Get Started Free</Link>
            <a href="#how-it-works" className="land-cta-secondary">See How It Works</a>
          </div>
        </div>
        <div className="land-hero-visual">
          <div className="land-mockup">
            <div className="land-mockup-header">
              <div className="land-mockup-dots">
                <span></span><span></span><span></span>
              </div>
              <span className="land-mockup-title">SparkP2P Dashboard</span>
            </div>
            <div className="land-mockup-body">
              <div className="land-mockup-stat-row">
                <div className="land-mockup-stat">
                  <span className="land-ms-label">SELL VOLUME</span>
                  <span className="land-ms-val green">4.2 BTC</span>
                </div>
                <div className="land-mockup-stat">
                  <span className="land-ms-label">BUY VOLUME</span>
                  <span className="land-ms-val blue">3.8 BTC</span>
                </div>
                <div className="land-mockup-stat">
                  <span className="land-ms-label">NET PROFIT</span>
                  <span className="land-ms-val accent">KES 47,520</span>
                </div>
              </div>
              <div className="land-mockup-orders">
                <div className="land-mockup-order">
                  <span className="land-mo-side green">SELL</span>
                  <span className="land-mo-amount">0.15 BTC</span>
                  <span className="land-mo-status completed">Auto-Released</span>
                </div>
                <div className="land-mockup-order">
                  <span className="land-mo-side blue">BUY</span>
                  <span className="land-mo-amount">0.22 BTC</span>
                  <span className="land-mo-status completed">Auto-Paid</span>
                </div>
                <div className="land-mockup-order">
                  <span className="land-mo-side green">SELL</span>
                  <span className="land-mo-amount">0.08 BTC</span>
                  <span className="land-mo-status pending">Verifying...</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="land-features" id="features">
        <div className="land-section-inner">
          <div className="land-section-header">
            <span className="land-section-tag">Features</span>
            <h2>Everything You Need to<br /><span className="land-highlight">Trade Hands-Free</span></h2>
          </div>
          <div className="land-features-grid">
            <div className="land-feature-card">
              <div className="land-feature-icon green-glow">
                <svg width="28" height="28" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h3>Auto-Release</h3>
              <p>Payments verified via M-Pesa, crypto released automatically on Binance. Zero manual work.</p>
            </div>
            <div className="land-feature-card">
              <div className="land-feature-icon blue-glow">
                <svg width="28" height="28" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
              </div>
              <h3>Buy & Sell Automation</h3>
              <p>Both sides automated. Buy orders auto-pay sellers. Sell orders auto-release to buyers.</p>
            </div>
            <div className="land-feature-card">
              <div className="land-feature-icon accent-glow">
                <svg width="28" height="28" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              </div>
              <h3>Real-Time Profit Tracking</h3>
              <p>See your spread, volume, and net profit in real-time. Know exactly how much you're making.</p>
            </div>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="land-how" id="how-it-works">
        <div className="land-section-inner">
          <div className="land-section-header">
            <span className="land-section-tag">How It Works</span>
            <h2>Up and Running in<br /><span className="land-highlight">4 Simple Steps</span></h2>
          </div>
          <div className="land-steps">
            <div className="land-step">
              <div className="land-step-num">1</div>
              <div className="land-step-content">
                <h4>Create Your Ads</h4>
                <p>Create your P2P ads on Binance as usual</p>
              </div>
            </div>
            <div className="land-step-line"></div>
            <div className="land-step">
              <div className="land-step-num">2</div>
              <div className="land-step-content">
                <h4>Connect Binance</h4>
                <p>Connect your Binance account to SparkP2P</p>
              </div>
            </div>
            <div className="land-step-line"></div>
            <div className="land-step">
              <div className="land-step-num">3</div>
              <div className="land-step-content">
                <h4>Configure M-Pesa</h4>
                <p>Configure your M-Pesa settlement method</p>
              </div>
            </div>
            <div className="land-step-line"></div>
            <div className="land-step">
              <div className="land-step-num">4</div>
              <div className="land-step-content">
                <h4>Automate</h4>
                <p>Sit back — SparkP2P handles the rest automatically</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="land-pricing" id="pricing">
        <div className="land-section-inner">
          <div className="land-section-header">
            <span className="land-section-tag">Pricing</span>
            <h2>Simple, Monthly<br /><span className="land-highlight">Subscription</span></h2>
            <p className="land-section-desc">Choose the plan that fits your trading style. No per-trade fees.</p>
          </div>
          <div className="land-pricing-grid two-tier">
            <div className="land-price-card">
              <div className="land-price-tier">Starter</div>
              <div className="land-price-amount">
                <span className="land-price-currency">KES</span>
                <span className="land-price-number">5,000</span>
                <span className="land-price-per">/month</span>
              </div>
              <p className="land-price-desc">Perfect for sellers who want to automate crypto releases</p>
              <ul className="land-price-features">
                <li className="included">Sell-side automation</li>
                <li className="included">Auto-release on payment verification</li>
                <li className="included">M-Pesa payment matching</li>
                <li className="included">Real-time profit tracking</li>
                <li className="included">Unlimited sell trades</li>
                <li className="included">Dashboard & analytics</li>
                <li className="included">Email support</li>
                <li className="excluded">Buy-side automation</li>
                <li className="excluded">Auto-pay sellers</li>
                <li className="excluded">AI fraud detection</li>
              </ul>
              <Link to="/login" className="land-price-btn">Get Started</Link>
            </div>
            <div className="land-price-card featured">
              <div className="land-price-popular">Recommended</div>
              <div className="land-price-tier">Pro</div>
              <div className="land-price-amount">
                <span className="land-price-currency">KES</span>
                <span className="land-price-number">10,000</span>
                <span className="land-price-per">/month</span>
              </div>
              <p className="land-price-desc">Full automation for serious P2P merchants running both sides</p>
              <ul className="land-price-features">
                <li className="included">Everything in Starter</li>
                <li className="included">Buy-side automation</li>
                <li className="included">Auto-pay sellers via M-Pesa/Bank</li>
                <li className="included">AI fraud detection</li>
                <li className="included">Dynamic spread monitoring</li>
                <li className="included">Unlimited buy & sell trades</li>
                <li className="included">Binance chat bot</li>
                <li className="included">Priority support</li>
                <li className="included">Multi-payment method support</li>
                <li className="included">Advanced analytics</li>
              </ul>
              <Link to="/login" className="land-price-btn featured">Get Started</Link>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="land-footer">
        <div className="land-footer-inner">
          <div className="land-footer-brand">
            <img src="/logo.png" alt="SparkP2P" className="land-footer-logo" />
            <span>SparkP2P</span>
            <span className="land-footer-powered">Powered by Spark AI</span>
          </div>
          <div className="land-footer-links">
            <a href="#features">Features</a>
            <a href="#pricing">Pricing</a>
            <Link to="/login">Login</Link>
            <a href="mailto:support@sparkp2p.com">Contact</a>
          </div>
          <div className="land-footer-copy">
            &copy; {new Date().getFullYear()} SparkP2P. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
}
