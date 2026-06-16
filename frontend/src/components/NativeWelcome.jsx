import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

// Animated branded entry screen shown only inside the native mobile app (not the web browser).
// The Spark AI logo eases in with a glowing halo, gentle float, and a light-sweep "spark", then the
// tagline and Login button rise in below. Pure CSS animations (see .nw-* in App.css).
export default function NativeWelcome() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && user) navigate('/dashboard', { replace: true });
  }, [user, loading, navigate]);

  return (
    <div className="nw-wrap">
      <div className="nw-spacer" />

      <div className="nw-stage">
        <div className="nw-glow" />
        <div className="nw-logo-box">
          <img src="/spark-ai-logo.png" alt="Spark AI" />
          <div className="nw-shine" />
        </div>
      </div>

      <div className="nw-title">SparkP2P</div>
      <div className="nw-sub">Automated Binance P2P trading — verify payments and release crypto, 24/7.</div>

      <div className="nw-spacer" />

      <button className="nw-btn" onClick={() => navigate('/login')}>Login</button>
      <div className="nw-footer">Powered by Spark AI</div>
    </div>
  );
}
