import { Link } from 'react-router-dom';
import { useState, useEffect } from 'react';
import PublicChat from '../components/PublicChat';
import NativeWelcome from '../components/NativeWelcome';
import { isNative } from '../mobile/relayAgent';
import { usePlans } from '../services/plans';

// Presentation only — plan names and prices are fetched from the backend (plans.py).
const LAND_PLAN_FEATURES = {
  starter: ['Full payment automation', 'Automatic order completion', 'M-Pesa payment matching', 'Unlimited transactions/day', 'Unlimited Telegram alerts', 'Market data: Bronze tier'],
  pro:     ['Everything in Bronze', 'Unlimited transactions/day', 'Unlimited Telegram alerts', 'Market data: Silver + Bronze', 'Priority settlement'],
  pro_max: ['Everything in Silver', 'Unlimited transactions/day', 'Unlimited Telegram alerts', 'Market data: all tiers', 'Priority support', 'Dedicated onboarding'],
};

const FAQS = [
  {
    category: 'Getting Started',
    items: [
      {
        q: 'What is SparkP2P?',
        a: 'SparkP2P is a desktop application that automates your payment workflows. It monitors incoming orders, verifies M-Pesa payments in real time, completes orders automatically, and tracks your results — all without you lifting a finger.',
      },
      {
        q: 'Do I need any coding or technical knowledge to use SparkP2P?',
        a: 'No. SparkP2P is designed for operators, not coders. Download the app, connect your marketplace account, configure your M-Pesa number, and you\'re live. The whole setup takes less than 10 minutes.',
      },
      {
        q: 'Is SparkP2P safe to use with my account?',
        a: 'Yes. SparkP2P never asks for your marketplace password or API keys. It connects through your existing Chrome browser session — the same session you already use — so no credentials are stored or transmitted to our servers.',
      },
      {
        q: 'Which operating systems are supported?',
        a: 'Windows 10 and Windows 11 are fully supported. macOS and Linux versions are in development and coming soon.',
      },
      {
        q: 'Does SparkP2P work with any account?',
        a: 'Yes, as long as your account is verified and active. SparkP2P works with both individual and business accounts.',
      },
    ],
  },
  {
    category: 'Payments & Settlement',
    items: [
      {
        q: 'How does M-Pesa payment verification work?',
        a: 'SparkP2P connects to your M-Pesa business paybill and monitors incoming transactions in real time. When a customer sends M-Pesa, the bot matches the amount and reference to the order, confirms receipt, and completes the order automatically — typically within seconds of the payment landing.',
      },
      {
        q: 'What if a buyer sends the wrong amount via M-Pesa?',
        a: 'If the payment amount does not match the order exactly, SparkP2P will not auto-complete it. The order stays open and you will receive an alert so you can investigate and act manually.',
      },
      {
        q: 'How do I receive my earnings?',
        a: 'Your proceeds accumulate in your SparkP2P wallet. You can request a withdrawal at any time — funds are sent directly to your registered M-Pesa number or I&M Bank account, depending on your selected settlement method.',
      },
      {
        q: 'What is the minimum withdrawal amount?',
        a: 'The minimum withdrawal is KES 1,000. For I&M Bank transfers the minimum is also KES 1,000.',
      },
      {
        q: 'How long do withdrawals take?',
        a: 'M-Pesa withdrawals are typically processed within minutes. I&M Bank withdrawals are batched hourly — your funds are swept and transferred in one combined operation, usually completing within 1–2 hours of your request.',
      },
      {
        q: 'Are there fees for withdrawals?',
        a: 'A small service fee applies to each withdrawal. You can preview the exact fee (including the Safaricom transaction fee) before confirming — there are no hidden charges.',
      },
    ],
  },
  {
    category: 'Bot & Automation',
    items: [
      {
        q: 'Does the bot run in the background while I use my computer?',
        a: 'Yes. SparkP2P runs as a background desktop app with a tray icon. You can use your computer normally while it monitors and processes orders silently in the background.',
      },
      {
        q: 'What happens if my computer goes to sleep or loses internet?',
        a: 'If the bot goes offline for more than 5 minutes, SparkP2P will send you an SMS and email alert so you can take action. Any pending orders at that time will not be auto-processed until the bot reconnects.',
      },
      {
        q: 'Will I get alerts if I intentionally close the app?',
        a: 'No — SparkP2P is smart enough to know the difference. When you close the app normally, it notifies the server that you\'ve stopped intentionally. The offline alert system is suppressed until you restart the app, so you won\'t be spammed with alerts when you\'re taking a break.',
      },
      {
        q: 'Can I pause the bot without closing the app?',
        a: 'Yes. The SparkP2P dashboard has a pause button that suspends order processing without disconnecting your marketplace or M-Pesa sessions. You can resume with one click.',
      },
      {
        q: 'Does the bot handle both incoming and outgoing payments?',
        a: 'Yes. Both sides are fully automated. For incoming payments, the bot verifies the customer\'s M-Pesa payment and completes the order. For outgoing payments, the bot detects when funds are received and auto-pays the recipient via M-Pesa.',
      },
      {
        q: 'How many orders can the bot handle simultaneously?',
        a: 'SparkP2P processes one order at a time per session to ensure accuracy and avoid double-payments. High-volume operators can run the bot on multiple accounts if needed.',
      },
    ],
  },
  {
    category: 'Account & Subscription',
    items: [
      {
        q: 'How do I create a SparkP2P account?',
        a: 'Contact us via the chat widget on this page or email support@sparkp2p.com to get started. We\'ll set up your account and walk you through the onboarding process.',
      },
      {
        q: 'Is there a free trial?',
        a: 'We periodically offer free access periods. Contact us to find out current availability and pricing.',
      },
      {
        q: 'Can I use SparkP2P on multiple devices?',
        a: 'Your SparkP2P account is tied to one active desktop session at a time. If you log in on a second device, the first session will be disconnected.',
      },
      {
        q: 'How do I update the SparkP2P desktop app?',
        a: 'SparkP2P has built-in auto-update. When a new version is released, the app will prompt you to update automatically. You can also download the latest installer directly from the Download section on this page.',
      },
      {
        q: 'What happens to my wallet balance if I cancel my subscription?',
        a: 'Your wallet balance remains yours. You can request a withdrawal of your full balance at any time — before, during, or after cancellation.',
      },
    ],
  },
  {
    category: 'Security & Privacy',
    items: [
      {
        q: 'Does SparkP2P store my marketplace login credentials?',
        a: 'No. SparkP2P uses your existing Chrome browser session — your login credentials never pass through our servers. The only data we store are your order records and wallet transactions.',
      },
      {
        q: 'Is my M-Pesa business paybill data secure?',
        a: 'Your M-Pesa credentials are stored encrypted on your local device and used only to connect to the M-Pesa org portal for payment verification. They are never transmitted to SparkP2P\'s servers.',
      },
      {
        q: 'What happens if SparkP2P completes an order before payment arrives?',
        a: 'SparkP2P will never complete an order before confirming payment. The M-Pesa verification step is mandatory — the bot waits for the exact payment amount to appear in your paybill before completing any order.',
      },
      {
        q: 'Can SparkP2P access or move my account funds?',
        a: 'No. SparkP2P only interacts with your active orders — it can complete orders that are pending payment. It cannot initiate withdrawals, transfers, or any other actions outside of order processing.',
      },
    ],
  },
];

function FaqItem({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`land-faq-item${open ? ' open' : ''}`} onClick={() => setOpen(o => !o)}>
      <div className="land-faq-q">
        <span>{q}</span>
        <svg className="land-faq-chevron" width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </div>
      {open && <div className="land-faq-a">{a}</div>}
    </div>
  );
}

export default function Landing() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [latestVersion, setLatestVersion] = useState(null);
  const { plans } = usePlans();

  const closeMenu = () => setMenuOpen(false);

  useEffect(() => {
    fetch('/api/download/version')
      .then(r => r.json())
      .then(d => setLatestVersion(d.version))
      .catch(() => {});
  }, []);

  // Inject the homepage FAQ structured data, built from the SAME FAQS that render visibly below,
  // so the markup always matches on-page content (a Google requirement). Lives here — not in the
  // shared index.html — so it appears only on the homepage and not on every SPA route.
  useEffect(() => {
    const el = document.createElement('script');
    el.type = 'application/ld+json';
    el.setAttribute('data-seo-route', 'home-faq');
    el.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      '@id': 'https://sparkp2p.com/#faq',
      mainEntity: FAQS.flatMap(c => c.items).map(({ q, a }) => ({
        '@type': 'Question',
        name: q,
        acceptedAnswer: { '@type': 'Answer', text: a },
      })),
    });
    document.head.appendChild(el);
    return () => { if (el.parentNode) el.parentNode.removeChild(el); };
  }, []);

  // Inside the native mobile app, skip the marketing landing and show a simple branded welcome.
  if (isNative()) return <NativeWelcome />;

  return (
    <div className="landing">

      {/* ── Navigation ─────────────────────────────────────────── */}
      <nav className="land-nav">
        <div className="land-nav-inner">
          <div className="land-nav-brand">
            <img src="/logo.png" alt="SparkP2P" className="land-nav-logo" />
            <span className="land-nav-name">SparkP2P</span>
          </div>
          <div className="land-nav-links">
            <a href="#features">Features</a>
            <a href="#why">Why Us</a>
            <a href="#how-it-works">How It Works</a>
            <a href="#pricing">Pricing</a>
            <a href="#download">Download</a>
            <a href="#products">Products</a>
            <a href="#faq">FAQ</a>
            <Link to="/blog">Blog</Link>
            <Link to="/contact">Contact</Link>
          </div>
          <div className="land-nav-actions">
            <Link to="/login" className="land-nav-login">Login</Link>
          </div>
          <div className="land-nav-mobile-actions">
            <Link to="/login" className="land-nav-login">Login</Link>
            <button
              className={`land-hamburger${menuOpen ? ' open' : ''}`}
              onClick={() => setMenuOpen(o => !o)}
              aria-label="Menu"
            >
              <span /><span /><span />
            </button>
          </div>
        </div>
      </nav>

      {/* Mobile drawer */}
      <div className={`land-mobile-drawer${menuOpen ? ' open' : ''}`}>
        <a href="#features" onClick={closeMenu}>Features</a>
        <a href="#why" onClick={closeMenu}>Why Us</a>
        <a href="#how-it-works" onClick={closeMenu}>How It Works</a>
        <a href="#pricing" onClick={closeMenu}>Pricing</a>
        <a href="#download" onClick={closeMenu}>Download</a>
        <a href="#products" onClick={closeMenu}>Products</a>
        <a href="#faq" onClick={closeMenu}>FAQ</a>
        <Link to="/blog" onClick={closeMenu}>Blog</Link>
        <Link to="/contact" onClick={closeMenu}>Contact</Link>
      </div>

      {/* ── Hero ───────────────────────────────────────────────── */}
      <section className="land-hero">
        <div className="land-hero-content">
          <div className="land-hero-badge">
            <span className="land-hero-badge-dot"></span>
            Trusted by businesses across Kenya
          </div>
          <h1>Automate Your<br /><span className="land-highlight">Payment Workflows</span></h1>
          <p className="land-hero-sub">
            Stop processing payments by hand. SparkP2P integrates any payment method — M-Pesa, paybills, and bank transfers — to automate your entire payment workflow, from verification and release to reconciliation, powered by Spark AI.
          </p>
          <div className="land-hero-actions">
            <Link to="/login" className="land-cta-primary">Get Started Free</Link>
            <a href="#how-it-works" className="land-cta-secondary">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z"/>
              </svg>
              See How It Works
            </a>
          </div>
        </div>
        <div className="land-hero-mobile-cta">
          <p>Payments verified. Orders completed. All on autopilot.</p>
          <Link to="/login" className="land-cta-primary" style={{ display: 'inline-block', marginTop: 16 }}>Get Started Free</Link>
        </div>
        <div className="land-hero-visual">
          <div className="land-support-panel">
            <span className="land-support-heading">We support the following <span className="land-highlight">integrations</span></span>
              <div className="land-support-list">
                <div className="land-support-row">
                  <div className="land-support-logo"><img src="/logos/im.jpg" alt="I&M Bank" /></div>
                  <div className="land-support-txt">
                    <span className="nm">I&amp;M Bank automations</span>
                    <span className="sub">Pay buy orders from your own I&amp;M account</span>
                  </div>
                </div>
                <div className="land-support-row">
                  <div className="land-support-logo"><img src="/logos/mpesa.jpg" alt="M-Pesa" /></div>
                  <div className="land-support-txt">
                    <span className="nm">M-Pesa B2C &amp; C2B</span>
                    <span className="sub">Pay &amp; collect on your own Paybill</span>
                  </div>
                </div>
                <div className="land-support-row">
                  <div className="land-support-logo"><img src="/logos/choice.jpg" alt="Choice Microfinance Bank" /></div>
                  <div className="land-support-txt">
                    <span className="nm">Choice Microfinance Bank</span>
                    <span className="sub">Bank rails, PesaLink &amp; withdrawals</span>
                  </div>
                </div>
              </div>
          </div>
        </div>
      </section>

      {/* ── Stats Bar ──────────────────────────────────────────── */}
      <section className="land-stats-bar">
        <div className="land-section-inner">
          <div className="land-stats-grid">
            <div className="land-stat">
              <span className="land-stat-num">500<span className="land-stat-plus">+</span></span>
              <span className="land-stat-label">Active Businesses</span>
            </div>
            <div className="land-stat-divider" />
            <div className="land-stat">
              <span className="land-stat-num">24/7</span>
              <span className="land-stat-label">Automated Payments</span>
            </div>
            <div className="land-stat-divider" />
            <div className="land-stat">
              <span className="land-stat-num">&lt;10s</span>
              <span className="land-stat-label">Avg. Completion Time</span>
            </div>
            <div className="land-stat-divider" />
            <div className="land-stat">
              <span className="land-stat-num">KES 50M<span className="land-stat-plus">+</span></span>
              <span className="land-stat-label">Volume Processed</span>
            </div>
          </div>
        </div>
      </section>

      {/* ── Features ───────────────────────────────────────────── */}
      <section className="land-features" id="features">
        <div className="land-section-inner">
          <div className="land-section-header">
            <span className="land-section-tag">Features</span>
            <h2>Everything You Need to<br /><span className="land-highlight">Run Hands-Free</span></h2>
            <p className="land-section-desc">One platform handles your entire payment workflow — from verification to settlement.</p>
          </div>
          <div className="land-features-grid">

            <div className="land-feature-card">
              <div className="land-feature-icon green-glow">
                <svg width="28" height="28" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h3>Auto-Complete</h3>
              <p>M-Pesa payment confirmed → the order completes in seconds. Zero manual intervention, zero missed orders.</p>
            </div>

            <div className="land-feature-card">
              <div className="land-feature-icon blue-glow">
                <svg width="28" height="28" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
              </div>
              <h3>Pay &amp; Collect Automation</h3>
              <p>Both sides handled. Outgoing orders auto-pay via M-Pesa. Incoming orders auto-verify and complete.</p>
            </div>

            <div className="land-feature-card">
              <div className="land-feature-icon accent-glow">
                <svg width="28" height="28" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              </div>
              <h3>Real-Time Profit Tracking</h3>
              <p>Live dashboard showing your spread, daily volume, completed orders, and net KES profit — updated after every order.</p>
            </div>

            <div className="land-feature-card">
              <div className="land-feature-icon purple-glow">
                <svg width="28" height="28" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                </svg>
              </div>
              <h3>Instant Wallet &amp; Withdrawals</h3>
              <p>Earnings land in your SparkP2P wallet after every order. Withdraw anytime to M-Pesa or I&amp;M Bank — funds arrive in minutes.</p>
            </div>

            <div className="land-feature-card">
              <div className="land-feature-icon green-glow">
                <svg width="28" height="28" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
              </div>
              <h3>Smart Alerts</h3>
              <p>SMS and email alerts when your bot goes offline unexpectedly, an order stalls, or a withdrawal is delayed. Stay informed 24/7.</p>
            </div>

            <div className="land-feature-card">
              <div className="land-feature-icon blue-glow">
                <svg width="28" height="28" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </div>
              <h3>In-App Chat Support</h3>
              <p>Reach the SparkP2P team directly from your dashboard. Get help with setup, withdrawals, or anything else — no email tickets.</p>
            </div>

            <div className="land-feature-card">
              <div className="land-feature-icon accent-glow">
                <svg width="28" height="28" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
              </div>
              <h3>Secure by Design</h3>
              <p>No API keys required. SparkP2P uses your existing Chrome session — your credentials never leave your device.</p>
            </div>

            <div className="land-feature-card">
              <div className="land-feature-icon purple-glow">
                <svg width="28" height="28" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
              </div>
              <h3>Full Order History</h3>
              <p>Every order, payment, and fee logged with timestamps and references. Export-ready records for accounting and dispute resolution.</p>
            </div>

            <div className="land-feature-card">
              <div className="land-feature-icon green-glow">
                <svg width="28" height="28" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </div>
              <h3>Auto-Updates</h3>
              <p>SparkP2P updates itself silently in the background. You always run the latest version with the newest features and security fixes.</p>
            </div>

          </div>
        </div>
      </section>

      {/* ── Why SparkP2P ───────────────────────────────────────── */}
      <section className="land-why" id="why">
        <div className="land-section-inner">
          <div className="land-why-inner">
            <div className="land-why-text">
              <span className="land-section-tag">Why SparkP2P</span>
              <h2>Built for Serious<br /><span className="land-highlight">Traders</span></h2>
              <p className="land-why-desc">
                SparkP2P is the only desktop tool that combines real-time M-Pesa verification, AI-powered order management, and instant settlement — all in one app built for Kenyan businesses.
              </p>
              <ul className="land-why-list">
                <li>
                  <span className="land-why-check">✓</span>
                  <div>
                    <strong>No API Keys Required</strong>
                    <p>Works with your existing Chrome session — zero credentials stored on our servers.</p>
                  </div>
                </li>
                <li>
                  <span className="land-why-check">✓</span>
                  <div>
                    <strong>Both Incoming &amp; Outgoing</strong>
                    <p>Full automation for incoming order completion and outgoing M-Pesa payments.</p>
                  </div>
                </li>
                <li>
                  <span className="land-why-check">✓</span>
                  <div>
                    <strong>Real-Time M-Pesa Matching</strong>
                    <p>Instantly matches payment amounts to orders — no manual checking required.</p>
                  </div>
                </li>
                <li>
                  <span className="land-why-check">✓</span>
                  <div>
                    <strong>Instant Withdrawals</strong>
                    <p>Earnings swept to M-Pesa or I&amp;M Bank within minutes of each completed order.</p>
                  </div>
                </li>
              </ul>
            </div>
            <div className="land-why-cards">
              <div className="land-why-card">
                <div className="land-why-card-num">01</div>
                <h4>Set Up Once</h4>
                <p>10-minute setup — connect your account, configure M-Pesa, and you're live. No coding, no API keys, no hassle.</p>
              </div>
              <div className="land-why-card">
                <div className="land-why-card-num">02</div>
                <h4>Run 24/7</h4>
                <p>SparkP2P runs in the background while you sleep, work, or travel — never miss an order again.</p>
              </div>
              <div className="land-why-card">
                <div className="land-why-card-num">03</div>
                <h4>Earn More</h4>
                <p>More completed orders, zero delays, instant payouts — your entire payment operation on autopilot.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── How It Works ───────────────────────────────────────── */}
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
                <h4>Create Your Listings</h4>
                <p>Set up your listings as usual</p>
              </div>
            </div>
            <div className="land-step-line"></div>
            <div className="land-step">
              <div className="land-step-num">2</div>
              <div className="land-step-content">
                <h4>Connect Your Account</h4>
                <p>Connect your marketplace account to SparkP2P</p>
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

      {/* ── Pricing ────────────────────────────────────────────── */}
      <section className="land-pricing" id="pricing">
        <div className="land-section-inner">
          <div className="land-section-header">
            <span className="land-section-tag">Pricing</span>
            <h2>Simple, Transparent<br /><span className="land-highlight">Pricing</span></h2>
            <p className="land-section-desc">Pick a plan and automate your payment workflows. Pay with M-Pesa, cancel anytime.</p>
          </div>
          <div className="land-pricing-grid">
            {/* Prices come from the backend (plans.py) — this page is public, so a hardcoded
                copy would advertise a price we don't charge. Features/badge stay local. */}
            {plans.map((pl, i) => ({
              key: pl.key,
              name: pl.label,
              price: pl.price.toLocaleString(),
              popular: i === plans.length - 1,
              features: LAND_PLAN_FEATURES[pl.key] || [],
            })).map(plan => (
              <div key={plan.key} className={`land-price-card${plan.popular ? ' popular' : ''}`}>
                {plan.popular && <div className="land-price-badge">Most Popular</div>}
                <h3 className="land-price-name">{plan.name}</h3>
                <div className="land-price-amount"><span className="land-price-cur">KES</span> {plan.price}<span className="land-price-per">/month</span></div>
                <ul className="land-price-features">
                  {plan.features.map(f => (
                    <li key={f}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                      {f}
                    </li>
                  ))}
                </ul>
                <Link to="/login" className="land-price-btn">Get Started</Link>
              </div>
            ))}
          </div>
          <p className="land-pricing-note">All plans include M-Pesa &amp; I&amp;M Bank settlement. Need help choosing? <Link to="/contact">Talk to us</Link>.</p>
        </div>
      </section>

      {/* ── CTA Banner ─────────────────────────────────────────── */}
      <section className="land-cta-banner">
        <div className="land-section-inner">
          <div className="land-cta-banner-inner">
            <div className="land-cta-banner-text">
              <h2>Ready to Automate Your<br /><span className="land-highlight">Payments?</span></h2>
              <p>Join hundreds of businesses running SparkP2P around the clock.</p>
            </div>
            <div className="land-cta-banner-actions">
              <Link to="/login" className="land-cta-primary">Get Started Today</Link>
              <Link to="/contact" className="land-cta-secondary">Talk to Us</Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── Download ───────────────────────────────────────────── */}
      <section className="land-download" id="download">
        <div className="land-section-inner">
          <div className="land-section-header">
            <span className="land-section-tag">Download</span>
            <h2>Get <span className="land-highlight">SparkP2P</span></h2>
            <p className="land-section-desc">Install once on Windows and automate forever. Auto-updates keep you on the latest version.</p>
          </div>
          <div className="land-download-grid">
            <div className="land-download-card featured-dl">
              <div className="land-download-icon">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="3" y="3" width="8" height="8"/><rect x="13" y="3" width="8" height="8"/>
                  <rect x="3" y="13" width="8" height="8"/><rect x="13" y="13" width="8" height="8"/>
                </svg>
              </div>
              <h3>Windows</h3>
              <p>Windows 10 / 11 &nbsp;·&nbsp; 64-bit</p>
              <a href="/api/download/latest" className="land-download-btn">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                </svg>
                Download .exe
              </a>
            </div>
            <div className="land-download-card featured-dl">
              <div className="land-download-icon">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M6 9a6 6 0 0 1 12 0v8a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V9z"/>
                  <path strokeLinecap="round" d="M8 4l-1.5-2M16 4l1.5-2M9 13h.01M15 13h.01"/>
                </svg>
              </div>
              <h3>Android</h3>
              <p>Phone &amp; tablet &nbsp;·&nbsp; APK</p>
              <a href="/api/download/android" className="land-download-btn">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                </svg>
                Download .apk
              </a>
            </div>
            <div className="land-download-card">
              <div className="land-download-icon muted">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2z"/>
                  <path d="M12 8v8m-4-4h8"/>
                </svg>
              </div>
              <h3>macOS</h3>
              <p>Intel &amp; Apple Silicon</p>
              <span className="land-download-soon">Coming Soon</span>
            </div>
            <div className="land-download-card">
              <div className="land-download-icon muted">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
                </svg>
              </div>
              <h3>Linux</h3>
              <p>Ubuntu / Debian</p>
              <span className="land-download-soon">Coming Soon</span>
            </div>
          </div>
          <div className="land-download-meta">
            <p>{latestVersion ? `v${latestVersion}` : 'Latest version'} &middot; Auto-updates enabled &middot; Requires Google Chrome installed</p>
            <p className="land-download-note">
              If Chrome blocks the download, click the <strong>&#8942;</strong> next to it and select <strong>"Keep"</strong>. The file is safe — downloaded directly from our servers.
            </p>
            <p style={{ marginTop: 16 }}>
              <Link to="/install" className="land-download-guide-link">
                Need help installing? View step-by-step guide →
              </Link>
            </p>
          </div>
        </div>
      </section>

      {/* ── Our Products ───────────────────────────────────────── */}
      <section className="land-products" id="products">
        <div className="land-section-inner">
          <div className="land-section-header">
            <span className="land-section-tag">Our Products</span>
            <h2>Companion <span className="land-highlight">apps</span></h2>
            <p className="land-section-desc">
              Optional desktop companions to SparkP2P — pay your orders straight from your own bank account or M-Pesa Paybill, fully automated.
            </p>
          </div>
          <div className="land-products-grid">
            {/* I&M Automation — the companion bot (SparkP2P itself lives in the Download section) */}
            <div className="land-product-card">
              <span className="land-product-badge alt">Companion · optional</span>
              <div className="land-product-head">
                <div className="land-product-logo im">
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 10l9-6 9 6M5 10v9h14v-9M9 19v-5h6v5"/>
                  </svg>
                </div>
                <div>
                  <h3>I&amp;M Automation</h3>
                  <p>Pay orders from your I&amp;M account</p>
                </div>
              </div>
              <p className="land-product-desc">
                A lightweight desktop bot that pays your orders directly from your own I&amp;M Bank account over M-Pesa &amp; PesaLink — fully automated. Links to SparkP2P in one click, and your bank login never leaves your computer.
              </p>
              <ul className="land-product-features">
                <li>M-Pesa &amp; PesaLink payouts</li>
                <li>One-click launch &amp; sign-in from SparkP2P</li>
                <li>Prepaid payout credits, pay as you go</li>
                <li>Your bank credentials stay on your machine</li>
              </ul>
              <a href="/api/download/im-bot" className="land-download-btn">Download for Windows</a>
              <p className="land-product-note">Windows 10 / 11 · 64-bit · Requires a SparkP2P account</p>
            </div>

            {/* Mpesa B2C — pays buys + collects sells on the merchant's own Paybill via Daraja */}
            <div className="land-product-card">
              <span className="land-product-badge alt">Companion · optional</span>
              <div className="land-product-head">
                <div className="land-product-logo b2c">
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <rect x="7" y="2.5" width="10" height="19" rx="2.4" strokeLinecap="round" strokeLinejoin="round"/>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M11 18.4h2"/>
                  </svg>
                </div>
                <div>
                  <h3>Mpesa B2C</h3>
                  <p>Pay &amp; collect on your own M-Pesa Paybill</p>
                </div>
              </div>
              <p className="land-product-desc">
                A desktop bot that pays your outgoing orders (B2C) and collects your incoming payments (C2B) straight through your own M-Pesa Paybill via Safaricom Daraja — no browser, with instant payer name verification. Links to SparkP2P in one click.
              </p>
              <ul className="land-product-features">
                <li>M-Pesa B2C payouts + C2B receipts</li>
                <li>Instant payer name verification on collections</li>
                <li>One-click launch &amp; sign-in from SparkP2P</li>
                <li>Prepaid credits or weekly unlimited plan</li>
              </ul>
              <a href="/api/download/b2c-bot" className="land-download-btn">Download for Windows</a>
              <p className="land-product-note">Windows 10 / 11 · 64-bit · Requires a SparkP2P account</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── FAQ ────────────────────────────────────────────────── */}
      <section className="land-faq" id="faq">
        <div className="land-section-inner">
          <div className="land-section-header">
            <span className="land-section-tag">FAQ</span>
            <h2>Frequently Asked<br /><span className="land-highlight">Questions</span></h2>
            <p className="land-section-desc">
              Everything you need to know about SparkP2P. Can't find an answer?{' '}
              <a href="mailto:support@sparkp2p.com" style={{ color: 'var(--accent)', textDecoration: 'none' }}>Contact us</a>.
            </p>
          </div>
          <div className="land-faq-categories">
            {FAQS.map(cat => (
              <div key={cat.category} className="land-faq-category">
                <div className="land-faq-cat-label">{cat.category}</div>
                <div className="land-faq-list">
                  {cat.items.map(item => (
                    <FaqItem key={item.q} q={item.q} a={item.a} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <PublicChat />

      {/* ── Footer ─────────────────────────────────────────────── */}
      <footer className="land-footer">
        <div className="land-footer-inner">
          <div className="land-footer-brand-col">
            <div className="land-footer-brand">
              <img src="/logo.png" alt="SparkP2P" className="land-footer-logo" />
              <span>SparkP2P</span>
            </div>
            <p className="land-footer-tagline">
              Automated payment workflows for Kenya's businesses. Powered by Spark AI.
            </p>
          </div>
          <div className="land-footer-col">
            <h5>Product</h5>
            <a href="#features">Features</a>
            <a href="#why">Why SparkP2P</a>
            <a href="#how-it-works">How It Works</a>
            <a href="#download">Download</a>
            <Link to="/install">Install Guide</Link>
          </div>
          <div className="land-footer-col">
            <h5>Support</h5>
            <a href="#faq">FAQ</a>
            <Link to="/contact">Contact Us</Link>
            <Link to="/login">Login</Link>
          </div>
          <div className="land-footer-col">
            <h5>Contact</h5>
            <a href="mailto:support@sparkp2p.com">support@sparkp2p.com</a>
          </div>
        </div>
        <div className="land-footer-bottom">
          <div className="land-footer-bottom-inner">
            <span>&copy; {new Date().getFullYear()} SparkP2P. All rights reserved.</span>
            <span className="land-footer-powered">Powered by Spark AI</span>
          </div>
        </div>
      </footer>

    </div>
  );
}
