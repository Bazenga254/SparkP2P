import { Component } from 'react';

// Global error boundary. Without this, ANY uncaught render exception (e.g. calling .toFixed on an
// undefined field) unmounts the whole React tree → the window goes blank/black with an empty #root.
// This catches it and shows a recoverable screen instead, so one bad value can never blank the app.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    try { console.error('[SparkP2P] UI render crash:', error, info && info.componentStack); } catch (_) { /* ignore */ }
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: '100vh', background: '#0d0f1e', color: '#e5e7eb', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 24, fontFamily: '-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif' }}>
          <div style={{ fontSize: 46, marginBottom: 10 }}>⚠️</div>
          <h1 style={{ fontSize: 20, margin: '0 0 8px' }}>Something went wrong loading the page</h1>
          <p style={{ color: '#9ca3af', fontSize: 14, maxWidth: 440, margin: '0 0 18px' }}>
            The app hit an unexpected error while rendering. Reloading usually fixes it. If it keeps
            happening, contact support and share the details below.
          </p>
          <button
            onClick={() => { try { window.location.reload(); } catch (_) { /* ignore */ } }}
            style={{ padding: '10px 22px', borderRadius: 10, border: 'none', fontWeight: 700, fontSize: 15, cursor: 'pointer', background: 'linear-gradient(135deg,#f59e0b,#f97316)', color: '#1a1300' }}
          >
            Reload
          </button>
          <pre style={{ marginTop: 20, color: '#6b7280', fontSize: 11, maxWidth: 620, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {String((this.state.error && this.state.error.message) || this.state.error)}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}
