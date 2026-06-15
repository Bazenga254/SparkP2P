import { Link } from 'react-router-dom';
import { useSeo } from '../hooks/useSeo';

// Shared layout for SEO blog posts, modelled on the Binance blog format:
// title + date, a "Main Takeaways" summary, the article body, and a sticky
// table-of-contents sidebar. Pass `toc` (array of { id, label }) to enable the
// sidebar; omit it (e.g. the blog index) to render a single full-width column.
function ShareButton({ title }) {
  const onShare = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) await navigator.share({ title, url });
      else { await navigator.clipboard.writeText(url); alert('Link copied to clipboard'); }
    } catch (_) { /* user cancelled */ }
  };
  return (
    <button className="blogp-share" onClick={onShare} type="button">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
        <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
      </svg>
      Share Post
    </button>
  );
}

export default function ArticleLayout({
  seo, badge, title, accent, subtitle, date,
  takeaways, toc, furtherReading, children,
}) {
  useSeo(seo);
  const hasToc = Array.isArray(toc) && toc.length > 0;

  return (
    <div className="inst-page">
      <nav className="inst-nav">
        <div className="inst-nav-inner">
          <Link to="/" className="inst-nav-brand">
            <img src="/logo.png" alt="SparkP2P" className="inst-nav-logo" />
            <span>SparkP2P</span>
          </Link>
          <Link to="/login" className="inst-nav-login">Login</Link>
        </div>
      </nav>

      <div className="blogp-wrap">
        <header className="blogp-header">
          <div className="blogp-breadcrumb">
            <Link to="/">Home</Link> <span>›</span> <Link to="/blog">Blog</Link>
          </div>
          {badge && <div className="blogp-kicker">{badge}</div>}
          <h1 className="blogp-title">{title}{accent ? ` ${accent}` : ''}</h1>
          <div className="blogp-meta">
            {date && <span className="blogp-date">{new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</span>}
            <ShareButton title={title} />
          </div>
          {subtitle && <p className="blogp-sub">{subtitle}</p>}
        </header>

        <div className={hasToc ? 'blogp-grid' : 'blogp-grid blogp-grid-single'}>
          <article className="seo-article blogp-body">
            {Array.isArray(takeaways) && takeaways.length > 0 && (
              <section className="blogp-takeaways" id="main-takeaways">
                <h2>Main Takeaways</h2>
                <ul>{takeaways.map((t, i) => <li key={i}>{t}</li>)}</ul>
              </section>
            )}

            {children}

            {Array.isArray(furtherReading) && furtherReading.length > 0 && (
              <section className="blogp-further">
                <h2>Further reading</h2>
                <ul>
                  {furtherReading.map((f, i) => (
                    <li key={i}>{f.to.startsWith('http')
                      ? <a href={f.to}>{f.label}</a>
                      : <Link to={f.to}>{f.label}</Link>}</li>
                  ))}
                </ul>
              </section>
            )}
          </article>

          {hasToc && (
            <aside className="blogp-toc-side">
              <div className="blogp-toc-sticky">
                <div className="blogp-toc-title">On this page</div>
                <nav>
                  {takeaways && takeaways.length > 0 && <a href="#main-takeaways">Main Takeaways</a>}
                  {toc.map(item => <a key={item.id} href={`#${item.id}`}>{item.label}</a>)}
                </nav>
              </div>
            </aside>
          )}
        </div>
      </div>

      <div className="inst-cta">
        <div className="inst-cta-inner">
          <h2>Start automating your Binance P2P trading</h2>
          <p>Download SparkP2P and let it verify M-Pesa payments and release crypto for you, 24/7.</p>
          <div className="inst-cta-actions">
            <a href="/api/download/latest" className="inst-cta-btn-primary">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              Download for Windows
            </a>
            <Link to="/install" className="inst-cta-btn-secondary">View the install guide</Link>
          </div>
          <p className="inst-cta-note">Questions? Contact <a href="mailto:support@sparkp2p.com">support@sparkp2p.com</a></p>
        </div>
      </div>

      <footer className="inst-footer">
        <div className="inst-footer-inner">
          <Link to="/" className="inst-footer-brand">
            <img src="/logo.png" alt="" style={{ width: 24, height: 24, borderRadius: 6, objectFit: 'contain' }} />
            <span>SparkP2P</span>
          </Link>
          <div className="inst-footer-links">
            <Link to="/">Home</Link>
            <Link to="/blog">Blog</Link>
            <Link to="/binance-p2p-bot-kenya">Binance P2P Bot Kenya</Link>
            <Link to="/automate-binance-p2p-mpesa">Automate with M-Pesa</Link>
            <Link to="/install">Install Guide</Link>
          </div>
          <div className="inst-footer-copy">&copy; {new Date().getFullYear()} SparkP2P. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
}
