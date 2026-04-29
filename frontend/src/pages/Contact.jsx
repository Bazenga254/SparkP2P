import { useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import PublicChat from '../components/PublicChat';

export default function Contact() {
  const [form, setForm] = useState({ name: '', email: '', subject: '', message: '' });
  const [status, setStatus] = useState('idle'); // idle | sending | sent | error
  const [errorMsg, setErrorMsg] = useState('');

  const handleChange = (e) => setForm(f => ({ ...f, [e.target.name]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name || !form.email || !form.subject || !form.message) return;
    setStatus('sending');
    setErrorMsg('');
    try {
      await axios.post('/api/contact', form);
      setStatus('sent');
      setForm({ name: '', email: '', subject: '', message: '' });
    } catch (err) {
      setStatus('error');
      setErrorMsg(err?.response?.data?.detail || 'Something went wrong. Please try again.');
    }
  };

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
            <Link to="/#features">Features</Link>
            <Link to="/#faq">FAQ</Link>
            <Link to="/#download">Download</Link>
            <Link to="/install">Install Guide</Link>
            <Link to="/contact" style={{ color: '#f59e0b' }}>Contact</Link>
            <Link to="/login" className="land-nav-login">Login</Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section style={{ padding: '100px 20px 40px', textAlign: 'center' }}>
        <div style={{ display: 'inline-block', background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 20, padding: '4px 16px', fontSize: 13, color: '#f59e0b', marginBottom: 20 }}>
          We're here to help
        </div>
        <h1 style={{ fontSize: 'clamp(2rem, 5vw, 3.2rem)', fontWeight: 800, color: '#fff', margin: '0 0 16px' }}>
          Get in <span className="land-highlight">Touch</span>
        </h1>
        <p style={{ color: '#9ca3af', fontSize: 16, maxWidth: 500, margin: '0 auto' }}>
          Have a question, feedback, or need help? Send us a message and we'll get back to you as soon as possible.
        </p>
      </section>

      {/* Main content */}
      <section style={{ maxWidth: 960, margin: '0 auto', padding: '20px 20px 80px', display: 'grid', gridTemplateColumns: '1fr 340px', gap: 32, alignItems: 'start' }}>

        {/* Contact Form */}
        <div style={{ background: 'var(--surface, #111827)', border: '1px solid var(--border, #1f2937)', borderRadius: 16, padding: 32 }}>
          {status === 'sent' ? (
            <div style={{ textAlign: 'center', padding: '48px 20px' }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
              <h2 style={{ color: '#10b981', fontSize: 22, fontWeight: 700, margin: '0 0 12px' }}>Message Sent!</h2>
              <p style={{ color: '#9ca3af', fontSize: 15, margin: '0 0 24px' }}>
                Thanks for reaching out. We'll get back to you at your email address within 24 hours.
              </p>
              <button
                onClick={() => setStatus('idle')}
                style={{ background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.3)', color: '#f59e0b', borderRadius: 8, padding: '10px 24px', fontSize: 14, cursor: 'pointer', fontWeight: 600 }}
              >
                Send Another Message
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              <h2 style={{ color: '#fff', fontSize: 20, fontWeight: 700, margin: '0 0 24px' }}>Send a Message</h2>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 6 }}>Your Name</label>
                  <input
                    name="name" value={form.name} onChange={handleChange} required
                    placeholder="John Doe"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 6 }}>Email Address</label>
                  <input
                    name="email" type="email" value={form.email} onChange={handleChange} required
                    placeholder="john@example.com"
                    style={inputStyle}
                  />
                </div>
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 6 }}>Subject</label>
                <select name="subject" value={form.subject} onChange={handleChange} required style={inputStyle}>
                  <option value="">Select a subject…</option>
                  <option value="General Inquiry">General Inquiry</option>
                  <option value="Technical Support">Technical Support</option>
                  <option value="Billing & Subscription">Billing & Subscription</option>
                  <option value="Partnership">Partnership</option>
                  <option value="Bug Report">Bug Report</option>
                  <option value="Other">Other</option>
                </select>
              </div>

              <div style={{ marginBottom: 24 }}>
                <label style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 6 }}>Message</label>
                <textarea
                  name="message" value={form.message} onChange={handleChange} required rows={6}
                  placeholder="Describe your question or issue in detail…"
                  style={{ ...inputStyle, resize: 'vertical', minHeight: 140 }}
                />
              </div>

              {status === 'error' && (
                <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#ef4444', marginBottom: 16 }}>
                  {errorMsg}
                </div>
              )}

              <button
                type="submit"
                disabled={status === 'sending'}
                style={{
                  width: '100%', padding: '13px', borderRadius: 8, border: 'none',
                  background: status === 'sending' ? '#92400e' : '#f59e0b',
                  color: '#000', fontWeight: 700, fontSize: 15, cursor: status === 'sending' ? 'not-allowed' : 'pointer',
                  transition: 'background 0.2s',
                }}
              >
                {status === 'sending' ? 'Sending…' : 'Send Message'}
              </button>
            </form>
          )}
        </div>

        {/* Info Sidebar */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          <div style={cardStyle}>
            <div style={iconWrapStyle}>✉️</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', marginBottom: 4 }}>Email Support</div>
              <a href="mailto:support@sparkp2p.com" style={{ fontSize: 13, color: '#f59e0b', textDecoration: 'none' }}>
                support@sparkp2p.com
              </a>
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>Response within 24 hours</div>
            </div>
          </div>

          <div style={cardStyle}>
            <div style={iconWrapStyle}>📞</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', marginBottom: 4 }}>Phone / WhatsApp</div>
              <a href="tel:+254797750249" style={{ fontSize: 13, color: '#f59e0b', textDecoration: 'none' }}>
                +254 797 750 249
              </a>
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>Mon – Fri, 8 AM – 8 PM EAT</div>
            </div>
          </div>

          <div style={cardStyle}>
            <div style={iconWrapStyle}>⚡</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', marginBottom: 4 }}>Live Chat Support</div>
              <div style={{ fontSize: 13, color: '#9ca3af' }}>Already a user? Use the in-app chat on your dashboard for instant AI-powered help.</div>
              <Link to="/login" style={{ display: 'inline-block', marginTop: 8, fontSize: 12, color: '#f59e0b', textDecoration: 'none', fontWeight: 600 }}>
                Go to Dashboard →
              </Link>
            </div>
          </div>

          <div style={cardStyle}>
            <div style={iconWrapStyle}>🕐</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', marginBottom: 4 }}>Support Hours</div>
              <div style={{ fontSize: 13, color: '#9ca3af' }}>Mon – Fri: 8 AM – 8 PM EAT</div>
              <div style={{ fontSize: 13, color: '#9ca3af' }}>Sat – Sun: 9 AM – 5 PM EAT</div>
            </div>
          </div>

          <div style={cardStyle}>
            <div style={iconWrapStyle}>📍</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', marginBottom: 4 }}>Location</div>
              <div style={{ fontSize: 13, color: '#9ca3af' }}>Nairobi, Kenya</div>
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>Serving Binance P2P traders across East Africa</div>
            </div>
          </div>

        </div>
      </section>

      <PublicChat />

      {/* Footer */}
      <footer className="land-footer">
        <div className="land-footer-inner">
          <div className="land-footer-brand">
            <img src="/logo.png" alt="SparkP2P" className="land-footer-logo" />
            <span>SparkP2P</span>
            <span className="land-footer-powered">Powered by Spark AI</span>
          </div>
          <div className="land-footer-links">
            <Link to="/#features">Features</Link>
            <Link to="/#faq">FAQ</Link>
            <Link to="/#download">Download</Link>
            <Link to="/install">Install Guide</Link>
            <Link to="/login">Login</Link>
            <Link to="/contact" style={{ color: '#f59e0b' }}>Contact</Link>
          </div>
          <div className="land-footer-copy">
            &copy; {new Date().getFullYear()} SparkP2P. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
}

const inputStyle = {
  width: '100%', padding: '10px 12px', borderRadius: 8,
  border: '1px solid #1f2937', background: '#0a0e1a',
  color: '#fff', fontSize: 14, outline: 'none',
  boxSizing: 'border-box',
};

const cardStyle = {
  background: '#111827', border: '1px solid #1f2937',
  borderRadius: 12, padding: '16px 18px',
  display: 'flex', gap: 14, alignItems: 'flex-start',
};

const iconWrapStyle = {
  fontSize: 20, minWidth: 36, height: 36,
  background: 'rgba(245,158,11,0.1)', borderRadius: 8,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
