import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import axios from 'axios';

const API = '/api';

export default function KycVerifyPage() {
  const [params] = useSearchParams();
  const token = params.get('t') || '';
  const [trader, setTrader] = useState(null);
  const [error, setError] = useState('');
  const [verified, setVerified] = useState(false);
  const [copied, setCopied] = useState(false);

  const mobileUrl = `${window.location.origin}/kyc/${token}`;

  useEffect(() => {
    if (!token) { setError('No token found. Please click "Set up" from the SparkP2P app again.'); return; }
    // If already on a mobile device, skip the QR code and go straight to the form.
    const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    if (isMobile) { window.location.replace(mobileUrl); return; }
    axios.get(`${API}/kyc/validate/${token}`)
      .then(r => { if (r.data.verified) { setVerified(true); } else { setTrader(r.data); } })
      .catch(() => setError('This link is invalid or has expired. Please click "Set up" in the SparkP2P app to get a new link.'));
  }, [token]);

  useEffect(() => {
    if (!token || verified) return;
    const iv = setInterval(() => {
      axios.get(`${API}/kyc/validate/${token}`)
        .then(r => { if (r.data.verified) setVerified(true); })
        .catch(() => {});
    }, 5000);
    return () => clearInterval(iv);
  }, [token, verified]);

  const copy = () => {
    navigator.clipboard.writeText(mobileUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const bg = {
    minHeight: '100vh', background: '#0d0f1e', display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', fontFamily: '-apple-system,BlinkMacSystemFont,sans-serif', padding: 32,
  };

  if (error) return (
    <div style={bg}>
      <div style={{ fontSize: 40, marginBottom: 16 }}>⚠️</div>
      <div style={{ color: '#ef4444', fontSize: 16, textAlign: 'center', maxWidth: 400, lineHeight: 1.6 }}>{error}</div>
    </div>
  );

  if (verified) return (
    <div style={bg}>
      <div style={{ fontSize: 64, marginBottom: 16 }}>✅</div>
      <div style={{ color: '#10b981', fontSize: 26, fontWeight: 800, marginBottom: 10 }}>Verification Complete!</div>
      <div style={{ color: '#9ca3af', fontSize: 15, textAlign: 'center', maxWidth: 380 }}>
        Your Choice Bank account is now linked. You can close this tab and return to SparkP2P.
      </div>
    </div>
  );

  if (!trader) return (
    <div style={bg}>
      <div style={{ width: 40, height: 40, border: '3px solid rgba(245,158,11,0.3)', borderTop: '3px solid #f59e0b', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );

  return (
    <div style={bg}>
      <div style={{ maxWidth: 500, width: '100%' }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 36 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🏦</div>
          <div style={{ color: '#fff', fontSize: 26, fontWeight: 800, marginBottom: 8 }}>Complete Bank Verification</div>
          <div style={{ color: '#9ca3af', fontSize: 15, lineHeight: 1.6 }}>
            Hi <strong style={{ color: '#fff' }}>{trader.full_name}</strong>. To link your Choice Bank account, complete the KYC form on your <strong style={{ color: '#f59e0b' }}>mobile phone</strong>.
          </div>
        </div>

        {/* Option A — QR */}
        <div style={{ background: '#13151f', border: '1px solid #1f2937', borderRadius: 16, padding: 28, marginBottom: 16, textAlign: 'center' }}>
          <div style={{ color: '#d1d5db', fontWeight: 700, fontSize: 15, marginBottom: 18 }}>📷 Scan with your phone</div>
          <div style={{ background: '#fff', borderRadius: 12, padding: 20, display: 'inline-block', marginBottom: 14 }}>
            <QRCodeSVG value={mobileUrl} size={200} />
          </div>
          <div style={{ color: '#6b7280', fontSize: 12 }}>Point your phone camera at the QR code</div>
        </div>

        {/* Option B — Copy link */}
        <div style={{ background: '#13151f', border: '1px solid #1f2937', borderRadius: 16, padding: 20, marginBottom: 28 }}>
          <div style={{ color: '#d1d5db', fontWeight: 700, fontSize: 15, marginBottom: 12 }}>🔗 Or copy the link</div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <div style={{ flex: 1, background: '#0d0f1e', border: '1px solid #374151', borderRadius: 8, padding: '10px 14px', color: '#6b7280', fontSize: 12, fontFamily: 'monospace', wordBreak: 'break-all' }}>
              {mobileUrl}
            </div>
            <button onClick={copy} style={{ flexShrink: 0, padding: '10px 18px', borderRadius: 8, border: 'none', background: copied ? '#10b981' : '#374151', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer', transition: 'background 0.2s' }}>
              {copied ? '✓ Copied' : 'Copy'}
            </button>
          </div>
          <div style={{ color: '#4b5563', fontSize: 12, marginTop: 8 }}>Send this link to yourself via WhatsApp, SMS, or email and open it on your phone.</div>
        </div>

        {/* Waiting indicator */}
        <div style={{ textAlign: 'center' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: '#6b7280', fontSize: 13 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#f59e0b', display: 'inline-block', animation: 'pulse 2s infinite' }} />
            Waiting for you to complete verification on your phone...
          </span>
        </div>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
      `}</style>
    </div>
  );
}
