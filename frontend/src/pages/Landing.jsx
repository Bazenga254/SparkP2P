import { Link } from 'react-router-dom';
import { useState } from 'react';

const FAQS = [
  {
    category: 'Getting Started',
    items: [
      {
        q: 'What is SparkP2P?',
        a: 'SparkP2P is a desktop application that automates your Binance P2P trading. It monitors incoming orders, verifies M-Pesa payments in real time, releases crypto automatically, and tracks your profits — all without you lifting a finger.',
      },
      {
        q: 'Do I need any coding or technical knowledge to use SparkP2P?',
        a: 'No. SparkP2P is designed for everyday traders. Download the app, connect your Binance account by scanning a QR code in the app, configure your M-Pesa number, and you\'re live. The whole setup takes less than 10 minutes.',
      },
      {
        q: 'Is SparkP2P safe to use with my Binance account?',
        a: 'Yes. SparkP2P never asks for your Binance API keys or password. It connects through the Binance website using your existing Chrome browser session — the same session you already use to trade manually. No credentials are stored or transmitted to our servers.',
      },
      {
        q: 'Which operating systems are supported?',
        a: 'Windows 10 and Windows 11 are fully supported. macOS and Linux versions are in development and coming soon.',
      },
      {
        q: 'Does SparkP2P work with any Binance account?',
        a: 'Yes, as long as you have a Binance P2P account that is verified and has active buy or sell ads. SparkP2P works with both individual and merchant accounts.',
      },
    ],
  },
  {
    category: 'Payments & Settlement',
    items: [
      {
        q: 'How does M-Pesa payment verification work?',
        a: 'SparkP2P connects to your M-Pesa business paybill and monitors incoming transactions in real time. When a buyer sends M-Pesa, the bot matches the amount and reference to the order, confirms receipt, and releases the crypto automatically — typically within seconds of the payment landing.',
      },
      {
        q: 'What if a buyer sends the wrong amount via M-Pesa?',
        a: 'If the payment amount does not match the order exactly, SparkP2P will not auto-release. The order stays open and you will receive an alert so you can investigate and act manually.',
      },
      {
        q: 'How do I receive my earnings?',
        a: 'Your trading profits accumulate in your SparkP2P wallet. You can request a withdrawal at any time — funds are sent directly to your registered M-Pesa number or I&M Bank account, depending on your selected settlement method.',
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
        a: 'Yes. The SparkP2P dashboard has a pause button that suspends order processing without disconnecting your Binance or M-Pesa sessions. You can resume with one click.',
      },
      {
        q: 'Does the bot handle both buy and sell orders?',
        a: 'Yes. Both sides are fully automated. For sell orders, the bot verifies the buyer\'s M-Pesa payment and releases crypto. For buy orders, the bot detects when crypto is received and auto-pays the seller via M-Pesa.',
      },
      {
        q: 'How many orders can the bot handle simultaneously?',
        a: 'SparkP2P processes one order at a time per trading session to ensure accuracy and avoid double-payments. High-volume traders can run the bot on multiple trading accounts if needed.',
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
        q: 'Does SparkP2P store my Binance login credentials?',
        a: 'No. SparkP2P uses your existing Chrome browser session to interact with Binance — your login credentials never pass through our servers. The only data we store are your trade records and wallet transactions.',
      },
      {
        q: 'Is my M-Pesa business paybill data secure?',
        a: 'Your M-Pesa credentials are stored encrypted on your local device and used only to connect to the M-Pesa org portal for payment verification. They are never transmitted to SparkP2P\'s servers.',
      },
      {
        q: 'What happens if SparkP2P releases crypto before payment arrives?',
        a: 'SparkP2P will never release crypto before confirming payment. The M-Pesa verification step is mandatory — the bot waits for the exact payment amount to appear in your paybill before triggering any release on Binance.',
      },
      {
        q: 'Can SparkP2P access or move my Binance crypto wallet funds?',
        a: 'No. SparkP2P only interacts with the Binance P2P order flow — it can release crypto held in escrow for active orders. It cannot initiate withdrawals, transfers, or any other actions outside of P2P order processing.',
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
            <a href="#faq">FAQ</a>
            <a href="#download">Download</a>
            <Link to="/login" className="land-nav-login">Login</Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="land-hero">
        <div className="land-hero-content">
          <div className="land-hero-badge">Trusted by P2P Traders</div>
          <h1>Automate Your<br /><span className="land-highlight">Binance P2P Trading</span></h1>
          <p className="land-hero-sub">
            Stop manually releasing crypto and verifying payments. SparkP2P handles everything — powered by Spark AI.
          </p>
          <div className="land-hero-actions">
            <Link to="/login" className="land-cta-primary">Get Started</Link>
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

      {/* Pricing — hidden (free access period) */}

      {/* Download Section */}
      <section className="land-download" id="download">
        <div className="land-section-inner">
          <h2>Download SparkP2P</h2>
          <p className="land-section-sub">Get the desktop app for automated P2P trading. Install once, trade forever.</p>
          <div className="land-download-grid">
            <div className="land-download-card">
              <div className="land-download-icon">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 12l2-2m0 0l7-7 7 7m-9-5v12m-4 4h12"/></svg>
              </div>
              <h3>Windows</h3>
              <p>Windows 10 / 11</p>
              <a href="https://github.com/Bazenga254/SparkP2P/releases/download/v1.1.8/SparkP2P.Setup.1.1.8.exe" className="land-download-btn" target="_blank" rel="noreferrer">Download .exe</a>
            </div>
            <div className="land-download-card">
              <div className="land-download-icon">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2z"/><path d="M12 8v8m-4-4h8"/></svg>
              </div>
              <h3>macOS</h3>
              <p>Intel & Apple Silicon</p>
              <span className="land-download-soon">Coming Soon</span>
            </div>
            <div className="land-download-card">
              <div className="land-download-icon">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
              </div>
              <h3>Linux</h3>
              <p>Ubuntu / Debian</p>
              <span className="land-download-soon">Coming Soon</span>
            </div>
          </div>
          <div style={{ textAlign: 'center', marginTop: 24, maxWidth: 520, margin: '24px auto 0' }}>
            <p style={{ color: '#6b7280', fontSize: 13 }}>
              v1.1.26 &middot; Auto-updates enabled &middot; Requires Google Chrome installed
            </p>
            <p style={{ color: '#9ca3af', fontSize: 12, marginTop: 10, lineHeight: 1.6 }}>
              If Chrome blocks the download, click the <strong style={{ color: '#e5e7eb' }}>&#8942;</strong> (three dots) next to the download and select <strong style={{ color: '#e5e7eb' }}>"Keep"</strong>. The file is safe — downloaded directly from our servers.
            </p>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="land-faq" id="faq">
        <div className="land-section-inner">
          <div className="land-section-header">
            <span className="land-section-tag">FAQ</span>
            <h2>Frequently Asked<br /><span className="land-highlight">Questions</span></h2>
            <p className="land-section-desc">Everything you need to know about SparkP2P. Can't find an answer? <a href="mailto:support@sparkp2p.com" style={{ color: 'var(--accent)', textDecoration: 'none' }}>Contact us</a>.</p>
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
            <a href="#faq">FAQ</a>
            <a href="#download">Download</a>
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
