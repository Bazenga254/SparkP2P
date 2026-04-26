import { Link } from 'react-router-dom';

const STEPS = [
  {
    num: 1,
    title: 'Download the Installer',
    desc: 'Click the "Download .exe" button on the SparkP2P website. The file is named SparkP2P-Setup-X.X.X.exe and is approximately 130 MB.',
    img: '/install-imgs/step1-download.png',
    tip: null,
    warning: null,
    illustration: (
      <div className="inst-illus-browser">
        <div className="inst-illus-bar">
          <span className="inst-illus-dot r" /><span className="inst-illus-dot y" /><span className="inst-illus-dot g" />
          <div className="inst-illus-url">sparkp2p.com</div>
        </div>
        <div className="inst-illus-body">
          <div className="inst-illus-dlbtn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Download .exe
          </div>
          <div className="inst-illus-label">SparkP2P v1.1.26 · Windows 10/11</div>
        </div>
      </div>
    ),
  },
  {
    num: 2,
    title: 'Handle Chrome\'s Download Warning',
    desc: 'Chrome may flag the installer because it\'s new software. Look for the download bar at the bottom of your browser. Click the three-dot menu (⋮) next to the file, then select "Keep" and confirm "Keep anyway".',
    img: '/install-imgs/step2-chrome-keep.png',
    tip: null,
    warning: 'The file is safe — it\'s downloaded directly from our GitHub release. Chrome shows this warning for any new executable that hasn\'t been widely downloaded yet.',
    illustration: (
      <div className="inst-illus-chrome-bar">
        <div className="inst-illus-dl-row">
          <div className="inst-illus-dl-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </div>
          <div className="inst-illus-dl-info">
            <div className="inst-illus-dl-name">SparkP2P-Setup-1.1.26.exe</div>
            <div className="inst-illus-dl-warn">⚠ This file may be dangerous</div>
          </div>
          <div className="inst-illus-dl-actions">
            <div className="inst-illus-dl-btn-keep">Keep</div>
            <div className="inst-illus-dl-more">⋮</div>
          </div>
        </div>
        <div className="inst-illus-dl-menu">
          <div className="inst-illus-dl-menu-item active">Keep anyway</div>
          <div className="inst-illus-dl-menu-item">Discard</div>
        </div>
      </div>
    ),
  },
  {
    num: 3,
    title: 'Bypass Windows SmartScreen',
    desc: 'Windows may show a blue SmartScreen warning saying "Windows protected your PC." This appears because the app is new and not yet widely distributed. Click "More info", then click "Run anyway" to proceed.',
    img: '/install-imgs/step3-smartscreen.png',
    tip: null,
    warning: 'This is normal for new software. SparkP2P is safe — you can verify the file by checking the GitHub release page where it was published.',
    illustration: (
      <div className="inst-illus-smartscreen">
        <div className="inst-illus-ss-header">
          <div className="inst-illus-ss-shield">🛡️</div>
          <div className="inst-illus-ss-title">Windows protected your PC</div>
        </div>
        <div className="inst-illus-ss-body">
          <p className="inst-illus-ss-text">Microsoft Defender SmartScreen prevented an unrecognized app from starting.</p>
          <div className="inst-illus-ss-app">
            <span className="inst-illus-ss-label">App:</span> SparkP2P-Setup-1.1.26.exe
          </div>
        </div>
        <div className="inst-illus-ss-actions">
          <div className="inst-illus-ss-more">More info</div>
          <div className="inst-illus-ss-run">Run anyway →</div>
        </div>
      </div>
    ),
  },
  {
    num: 4,
    title: 'Installation Completes Automatically',
    desc: 'SparkP2P uses a one-click installer — no wizard pages, no "Next" buttons. The installer runs silently, installs the app, and places a shortcut on your Desktop and Start Menu. The whole process takes about 10–20 seconds.',
    img: '/install-imgs/step4-installing.png',
    tip: 'SparkP2P is installed to your user profile folder (no admin password required on most setups).',
    warning: null,
    illustration: (
      <div className="inst-illus-progress">
        <div className="inst-illus-prog-icon">
          <img src="/logo.png" alt="SparkP2P" style={{ width: 48, height: 48, borderRadius: 12, objectFit: 'contain' }} onError={e => { e.target.style.display='none'; }} />
        </div>
        <div className="inst-illus-prog-name">Installing SparkP2P...</div>
        <div className="inst-illus-prog-bar-wrap">
          <div className="inst-illus-prog-bar" />
        </div>
        <div className="inst-illus-prog-status">Creating shortcuts on Desktop &amp; Start Menu</div>
      </div>
    ),
  },
  {
    num: 5,
    title: 'App Launches — Sign In',
    desc: 'SparkP2P opens automatically after installation and a SparkP2P icon appears in your system tray (bottom-right of your taskbar). Enter your email and password on the login screen to sign in.',
    img: '/install-imgs/step5-login.png',
    tip: 'If you don\'t have an account yet, contact support@sparkp2p.com or use the chat widget on the website to get set up.',
    warning: null,
    illustration: (
      <div className="inst-illus-app-login">
        <div className="inst-illus-app-header">
          <span className="inst-illus-dot r" /><span className="inst-illus-dot y" /><span className="inst-illus-dot g" />
          <span className="inst-illus-app-title">SparkP2P</span>
        </div>
        <div className="inst-illus-app-body">
          <div className="inst-illus-app-logo-row">
            <img src="/logo.png" alt="SparkP2P" style={{ width: 36, height: 36, borderRadius: 9, objectFit: 'contain' }} onError={e => { e.target.style.display='none'; }} />
            <span style={{ fontWeight: 700, color: '#f59e0b', fontSize: 16 }}>SparkP2P</span>
          </div>
          <div className="inst-illus-app-field">Email</div>
          <div className="inst-illus-app-input">you@example.com</div>
          <div className="inst-illus-app-field" style={{ marginTop: 10 }}>Password</div>
          <div className="inst-illus-app-input">••••••••••</div>
          <div className="inst-illus-app-btn">Sign In</div>
        </div>
      </div>
    ),
  },
  {
    num: 6,
    title: 'Connect Your Binance Account',
    desc: 'After signing in, SparkP2P will open Google Chrome and navigate to Binance P2P automatically. If you\'re already logged into Binance in Chrome, the bot will detect your session and connect instantly. If not, log into Binance manually in the Chrome window that opens.',
    img: '/install-imgs/step6-binance.png',
    tip: 'SparkP2P uses your existing Chrome session — it never asks for your Binance password or API keys.',
    warning: null,
    illustration: (
      <div className="inst-illus-browser">
        <div className="inst-illus-bar">
          <span className="inst-illus-dot r" /><span className="inst-illus-dot y" /><span className="inst-illus-dot g" />
          <div className="inst-illus-url">p2p.binance.com</div>
        </div>
        <div className="inst-illus-body" style={{ flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#10b981', flexShrink: 0 }} />
            <span style={{ color: '#10b981', fontSize: 12, fontWeight: 600 }}>Binance session detected</span>
          </div>
          <div style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: 8, padding: '10px 12px', fontSize: 12, color: '#6ee7b7' }}>
            SparkP2P connected to your P2P account
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            {['SELL', 'BUY', 'SELL'].map((s, i) => (
              <div key={i} style={{ flex: 1, background: '#1a1d27', borderRadius: 6, padding: '8px 6px', fontSize: 10, textAlign: 'center', border: '1px solid #2a2d3a' }}>
                <div style={{ color: s === 'BUY' ? '#3b82f6' : '#10b981', fontWeight: 700, fontSize: 11 }}>{s}</div>
                <div style={{ color: '#9ca3af', marginTop: 2 }}>Active</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
  },
  {
    num: 7,
    title: 'Connect the M-Pesa Org Portal',
    desc: 'SparkP2P opens a second tab for the M-Pesa Org Portal (org.ke.m-pesa.com). Log in with your M-Pesa business credentials. Once logged in, SparkP2P confirms the connection and will monitor all incoming payments automatically.',
    img: '/install-imgs/step7-mpesa.png',
    tip: 'SparkP2P saves your M-Pesa portal session in your Chrome profile. You usually only need to log in once — after that it reconnects automatically on each restart.',
    warning: null,
    illustration: (
      <div className="inst-illus-browser">
        <div className="inst-illus-bar">
          <span className="inst-illus-dot r" /><span className="inst-illus-dot y" /><span className="inst-illus-dot g" />
          <div className="inst-illus-url">org.ke.m-pesa.com</div>
        </div>
        <div className="inst-illus-body" style={{ flexDirection: 'column', gap: 10 }}>
          <div style={{ textAlign: 'center', padding: '8px 0' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#e4e4e7', marginBottom: 4 }}>M-Pesa Org Portal</div>
            <div style={{ fontSize: 11, color: '#9ca3af' }}>Business Dashboard</div>
          </div>
          <div style={{ background: '#1a1d27', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981' }} />
              <span style={{ fontSize: 11, color: '#6ee7b7', fontWeight: 600 }}>Portal connected · Monitoring payments</span>
            </div>
          </div>
          <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'center' }}>SparkP2P is watching for incoming M-Pesa transactions</div>
        </div>
      </div>
    ),
  },
  {
    num: 8,
    title: 'You\'re Live — Bot is Running!',
    desc: 'The SparkP2P dashboard shows your bot as online. From this point, the bot monitors your Binance P2P orders 24/7, verifies every M-Pesa payment, and releases crypto automatically. You can close the Chrome window — the bot will keep running in the system tray.',
    img: '/install-imgs/step8-running.png',
    tip: 'The green "Bot Online" indicator in the top bar confirms everything is connected and running. Keep your PC on and internet connected for continuous automation.',
    warning: null,
    illustration: (
      <div className="inst-illus-app-login">
        <div className="inst-illus-app-header">
          <span className="inst-illus-dot r" /><span className="inst-illus-dot y" /><span className="inst-illus-dot g" />
          <span className="inst-illus-app-title">SparkP2P · Dashboard</span>
        </div>
        <div className="inst-illus-app-body" style={{ gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: 8, padding: '8px 12px' }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981', boxShadow: '0 0 6px #10b981' }} />
            <span style={{ fontSize: 12, color: '#10b981', fontWeight: 600 }}>Bot Online · Monitoring orders</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            {[['Sell Volume', '0.00 BTC', '#10b981'], ['Buy Volume', '0.00 BTC', '#3b82f6'], ['Net Profit', 'KES 0', '#f59e0b'], ['Orders', '0 today', '#e4e4e7']].map(([l, v, c]) => (
              <div key={l} style={{ background: '#1a1d27', borderRadius: 8, padding: '8px 10px', border: '1px solid #2a2d3a' }}>
                <div style={{ fontSize: 9, color: '#6b7280', marginBottom: 2 }}>{l}</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: c }}>{v}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
  },
];

export default function Install() {
  return (
    <div className="inst-page">
      {/* Nav */}
      <nav className="inst-nav">
        <div className="inst-nav-inner">
          <Link to="/" className="inst-nav-brand">
            <img src="/logo.png" alt="SparkP2P" className="inst-nav-logo" />
            <span>SparkP2P</span>
          </Link>
          <Link to="/login" className="inst-nav-login">Login</Link>
        </div>
      </nav>

      {/* Hero */}
      <div className="inst-hero">
        <div className="inst-hero-inner">
          <div className="inst-hero-badge">Installation Guide</div>
          <h1>Get SparkP2P<br /><span className="inst-hero-accent">Running in Minutes</span></h1>
          <p className="inst-hero-sub">Follow these 8 steps to download, install, and connect SparkP2P on your Windows PC.</p>
          <div className="inst-hero-stats">
            <div className="inst-hero-stat">
              <span className="inst-hero-stat-val">8</span>
              <span className="inst-hero-stat-label">Steps</span>
            </div>
            <div className="inst-hero-stat-divider" />
            <div className="inst-hero-stat">
              <span className="inst-hero-stat-val">~5</span>
              <span className="inst-hero-stat-label">Minutes</span>
            </div>
            <div className="inst-hero-stat-divider" />
            <div className="inst-hero-stat">
              <span className="inst-hero-stat-val">Win 10/11</span>
              <span className="inst-hero-stat-label">Platform</span>
            </div>
          </div>
        </div>
      </div>

      {/* Steps */}
      <div className="inst-steps">
        {STEPS.map((step, idx) => (
          <div key={step.num} className="inst-step-card" id={`step-${step.num}`}>
            {/* Step connector line */}
            {idx < STEPS.length - 1 && <div className="inst-step-connector" />}

            <div className="inst-step-inner">
              {/* Left: number + meta */}
              <div className="inst-step-meta">
                <div className="inst-step-num">{step.num}</div>
                <div className="inst-step-progress">{step.num} of {STEPS.length}</div>
              </div>

              {/* Right: content */}
              <div className="inst-step-content">
                <h2 className="inst-step-title">{step.title}</h2>
                <p className="inst-step-desc">{step.desc}</p>

                {step.warning && (
                  <div className="inst-step-warning">
                    <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, color: '#f59e0b', marginTop: 1 }}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <span>{step.warning}</span>
                  </div>
                )}

                {step.tip && (
                  <div className="inst-step-tip">
                    <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, color: '#10b981', marginTop: 1 }}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span>{step.tip}</span>
                  </div>
                )}

                {/* Screenshot: real image if available, else illustration */}
                <div className="inst-step-screenshot">
                  <img
                    src={step.img}
                    alt={`Step ${step.num}: ${step.title}`}
                    className="inst-screenshot-img"
                    onError={e => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex'; }}
                  />
                  <div className="inst-screenshot-illus" style={{ display: 'none' }}>
                    {step.illustration}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* CTA */}
      <div className="inst-cta">
        <div className="inst-cta-inner">
          <h2>Ready to Install?</h2>
          <p>Download SparkP2P and start automating your Binance P2P trading today.</p>
          <div className="inst-cta-actions">
            <a
              href="https://github.com/Bazenga254/SparkP2P/releases/download/v1.1.26/SparkP2P-Setup-1.1.26.exe"
              className="inst-cta-btn-primary"
              target="_blank"
              rel="noreferrer"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              Download for Windows
            </a>
            <Link to="/login" className="inst-cta-btn-secondary">Sign In to Your Account</Link>
          </div>
          <p className="inst-cta-note">Need help? Contact <a href="mailto:support@sparkp2p.com">support@sparkp2p.com</a></p>
        </div>
      </div>

      {/* Footer */}
      <footer className="inst-footer">
        <div className="inst-footer-inner">
          <Link to="/" className="inst-footer-brand">
            <img src="/logo.png" alt="" style={{ width: 24, height: 24, borderRadius: 6, objectFit: 'contain' }} />
            <span>SparkP2P</span>
          </Link>
          <div className="inst-footer-links">
            <Link to="/">Home</Link>
            <Link to="/#faq">FAQ</Link>
            <Link to="/login">Login</Link>
            <a href="mailto:support@sparkp2p.com">Support</a>
          </div>
          <div className="inst-footer-copy">&copy; {new Date().getFullYear()} SparkP2P. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
}
