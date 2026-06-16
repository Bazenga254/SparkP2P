import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

// Simple branded entry screen shown only inside the native mobile app (not the web browser).
// Just the Spark AI logo + a Login button — none of the marketing landing content.
export default function NativeWelcome() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && user) navigate('/dashboard', { replace: true });
  }, [user, loading, navigate]);

  return (
    <div style={{
      minHeight: '100vh', width: '100%',
      background: 'radial-gradient(120% 80% at 50% 20%, #16224a 0%, #0a1226 60%, #070d1c 100%)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '32px 28px', boxSizing: 'border-box', fontFamily: 'Inter, system-ui, sans-serif',
    }}>
      <div style={{ flex: 1 }} />

      <img
        src="/spark-ai-logo.png"
        alt="Spark AI"
        style={{ width: 168, height: 168, objectFit: 'cover', borderRadius: 36, boxShadow: '0 20px 60px rgba(0,0,0,0.45)' }}
      />
      <div style={{ marginTop: 26, fontSize: 30, fontWeight: 800, color: '#fff', letterSpacing: '-0.02em' }}>SparkP2P</div>
      <div style={{ marginTop: 8, fontSize: 14.5, color: '#9fb0c9', textAlign: 'center', lineHeight: 1.5, maxWidth: 300 }}>
        Automated Binance P2P trading — verify payments and release crypto, 24/7.
      </div>

      <div style={{ flex: 1 }} />

      <button
        onClick={() => navigate('/login')}
        style={{
          width: '100%', maxWidth: 360, padding: '15px 20px', borderRadius: 14, border: 'none',
          background: 'linear-gradient(135deg, #FFC85A, #F5A623)', color: '#1a1206',
          fontSize: 17, fontWeight: 800, cursor: 'pointer', boxShadow: '0 10px 30px rgba(245,166,35,0.3)',
        }}
      >
        Login
      </button>
      <div style={{ marginTop: 18, fontSize: 12, color: '#5d6b85' }}>Powered by Spark AI</div>
    </div>
  );
}
