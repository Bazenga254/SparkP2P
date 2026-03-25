import { useState, useEffect, useRef, useCallback } from 'react';

const WS_BASE = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const API_HOST = window.location.host;

export default function RemoteBrowser({ onConnected, onClose }) {
  const [status, setStatus] = useState('connecting'); // connecting, active, logged_in, saved, error
  const [message, setMessage] = useState('Launching browser...');
  const [url, setUrl] = useState('');
  const canvasRef = useRef(null);
  const wsRef = useRef(null);
  const imgRef = useRef(new Image());
  const scaleRef = useRef({ x: 1, y: 1 });

  // Get token
  const token = localStorage.getItem('token');

  const connectWs = useCallback(() => {
    const ws = new WebSocket(`${WS_BASE}//${API_HOST}/api/browser/login-stream?token=${token}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('active');
      setMessage('Browser ready — log into Binance below');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === 'screenshot' && msg.data) {
          const img = imgRef.current;
          img.onload = () => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);

            // Calculate scale for mouse events
            const rect = canvas.getBoundingClientRect();
            scaleRef.current = {
              x: img.width / rect.width,
              y: img.height / rect.height,
            };
          };
          img.src = `data:image/jpeg;base64,${msg.data}`;

          if (msg.url) setUrl(msg.url);
          if (msg.logged_in && status !== 'logged_in' && status !== 'saved') {
            setStatus('logged_in');
            setMessage('Login detected! Click "Save & Start Bot" to activate.');
          }
        }

        if (msg.type === 'status') {
          if (msg.logged_in) {
            setStatus('logged_in');
            setMessage(msg.message || 'Logged in!');
          }
        }

        if (msg.type === 'session_saved') {
          setStatus('saved');
          setMessage(`${msg.message} (${msg.cookie_count} cookies)`);
          if (onConnected) onConnected();
        }

        if (msg.type === 'error') {
          setMessage(msg.message);
        }
      } catch (e) {
        console.error('WS parse error:', e);
      }
    };

    ws.onerror = () => {
      setStatus('error');
      setMessage('Connection error. Please try again.');
    };

    ws.onclose = () => {
      if (status !== 'saved') {
        setStatus('error');
        setMessage('Browser session ended.');
      }
    };
  }, [token, status, onConnected]);

  useEffect(() => {
    connectWs();
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Send message to WebSocket
  const send = (msg) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  };

  // Get canvas coordinates scaled to browser viewport
  const getCoords = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.round((e.clientX - rect.left) * scaleRef.current.x),
      y: Math.round((e.clientY - rect.top) * scaleRef.current.y),
    };
  };

  // Mouse handlers
  const handleClick = (e) => {
    const { x, y } = getCoords(e);
    send({ type: 'click', x, y });
  };

  const handleMouseDown = (e) => {
    const { x, y } = getCoords(e);
    send({ type: 'mousedown', x, y });
  };

  const handleMouseMove = (e) => {
    // Only send during drag (button pressed)
    if (e.buttons === 1) {
      const { x, y } = getCoords(e);
      send({ type: 'mousemove', x, y });
    }
  };

  const handleMouseUp = () => {
    send({ type: 'mouseup' });
  };

  const handleWheel = (e) => {
    e.preventDefault();
    const { x, y } = getCoords(e);
    send({ type: 'scroll', x, y, deltaX: e.deltaX, deltaY: e.deltaY });
  };

  // Keyboard handler
  const handleKeyDown = (e) => {
    e.preventDefault();
    const specialKeys = ['Enter', 'Tab', 'Backspace', 'Delete', 'Escape',
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];

    if (specialKeys.includes(e.key)) {
      send({ type: 'key', key: e.key });
    } else if (e.key.length === 1) {
      send({ type: 'type', text: e.key });
    }
  };

  const handleSaveSession = () => {
    send({ type: 'save_session' });
    setMessage('Saving session...');
  };

  const handleClose = () => {
    send({ type: 'close' });
    if (wsRef.current) wsRef.current.close();
    if (onClose) onClose();
  };

  const statusColor = {
    connecting: '#f59e0b',
    active: '#3b82f6',
    logged_in: '#10b981',
    saved: '#10b981',
    error: '#ef4444',
  }[status];

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.85)', zIndex: 9999,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '20px 20px 10px',
    }}>
      {/* Header bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        width: '100%', maxWidth: 1320, marginBottom: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 10, height: 10, borderRadius: '50%',
            background: statusColor, boxShadow: `0 0 8px ${statusColor}`,
          }} />
          <span style={{ color: '#fff', fontSize: 14, fontWeight: 600 }}>
            {message}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          {status === 'logged_in' && (
            <button
              onClick={handleSaveSession}
              style={{
                padding: '8px 20px', borderRadius: 8, border: 'none',
                background: '#10b981', color: '#fff', fontWeight: 600,
                cursor: 'pointer', fontSize: 13,
              }}
            >
              Save & Start Bot
            </button>
          )}
          <button
            onClick={handleClose}
            style={{
              padding: '8px 20px', borderRadius: 8,
              border: '1px solid #4b5563', background: 'transparent',
              color: '#9ca3af', cursor: 'pointer', fontSize: 13,
            }}
          >
            {status === 'saved' ? 'Done' : 'Cancel'}
          </button>
        </div>
      </div>

      {/* URL bar */}
      <div style={{
        width: '100%', maxWidth: 1320, padding: '6px 14px',
        background: '#1f2937', borderRadius: '8px 8px 0 0',
        fontSize: 12, color: '#6b7280', fontFamily: 'monospace',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {url || 'Loading...'}
      </div>

      {/* Browser canvas */}
      <div style={{
        width: '100%', maxWidth: 1320, flex: 1,
        overflow: 'hidden', background: '#111',
        borderRadius: '0 0 8px 8px', position: 'relative',
      }}>
        <canvas
          ref={canvasRef}
          tabIndex={0}
          onClick={handleClick}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onWheel={handleWheel}
          onKeyDown={handleKeyDown}
          style={{
            width: '100%', height: '100%',
            objectFit: 'contain', cursor: 'default',
            outline: 'none',
          }}
        />

        {status === 'connecting' && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.7)', color: '#fff', fontSize: 16,
          }}>
            Launching browser...
          </div>
        )}

        {status === 'saved' && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.8)',
          }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>&#10003;</div>
            <div style={{ color: '#10b981', fontSize: 20, fontWeight: 700 }}>
              Binance Connected!
            </div>
            <div style={{ color: '#9ca3af', fontSize: 14, marginTop: 8 }}>
              Your bot session has been saved. Trading automation is ready.
            </div>
            <button
              onClick={handleClose}
              style={{
                marginTop: 20, padding: '10px 30px', borderRadius: 8,
                border: 'none', background: '#10b981', color: '#fff',
                fontWeight: 600, cursor: 'pointer', fontSize: 14,
              }}
            >
              Close
            </button>
          </div>
        )}
      </div>

      {/* Help text */}
      <div style={{
        maxWidth: 1320, width: '100%', marginTop: 8,
        fontSize: 12, color: '#6b7280', textAlign: 'center',
      }}>
        Click and type directly in the browser above. Drag to solve CAPTCHA puzzles.
        {status === 'active' && ' Log into your Binance account to connect.'}
      </div>
    </div>
  );
}
