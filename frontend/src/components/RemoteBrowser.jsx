import { useState, useEffect, useRef, useCallback } from 'react';

export default function RemoteBrowser({ onConnected, onClose }) {
  const [status, setStatus] = useState('starting');  // starting, live, logged_in, saving, done, error
  const [message, setMessage] = useState('Launching Binance...');
  const [url, setUrl] = useState('');
  const canvasRef = useRef(null);
  const wsRef = useRef(null);
  const imgRef = useRef(new Image());
  const scaleRef = useRef({ x: 1, y: 1 });
  const isDragging = useRef(false);

  const token = localStorage.getItem('token');

  const connectWs = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/browser/login-stream?token=${token}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('live');
      setMessage('Log into your Binance account');
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
            canvas.getContext('2d').drawImage(img, 0, 0);
            const rect = canvas.getBoundingClientRect();
            scaleRef.current = { x: img.width / rect.width, y: img.height / rect.height };
          };
          img.src = `data:image/jpeg;base64,${msg.data}`;
          if (msg.url) setUrl(msg.url);
          if (msg.logged_in && status !== 'done') {
            setStatus('logged_in');
            setMessage('Login detected! Click "Save & Start Bot" to activate.');
          }
        }
        if (msg.type === 'session_saved') {
          setStatus('done');
          setMessage(`Connected! ${msg.cookie_count} cookies saved.`);
          if (onConnected) onConnected();
        }
        if (msg.type === 'error') setMessage(msg.message);
      } catch (_) {}
    };

    ws.onerror = () => { setStatus('error'); setMessage('Connection error'); };
    ws.onclose = () => { if (status !== 'done') { setStatus('error'); setMessage('Session ended'); } };
  }, [token, onConnected]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    connectWs();
    return () => { if (wsRef.current) wsRef.current.close(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const send = (msg) => {
    if (wsRef.current?.readyState === WebSocket.OPEN)
      wsRef.current.send(JSON.stringify(msg));
  };

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
  const onMouseDown = (e) => {
    isDragging.current = true;
    const { x, y } = getCoords(e);
    send({ type: 'mousedown', x, y });
  };
  const onMouseMove = (e) => {
    if (isDragging.current) {
      const { x, y } = getCoords(e);
      send({ type: 'mousemove', x, y });
    }
  };
  const onMouseUp = (e) => {
    if (isDragging.current) {
      isDragging.current = false;
      send({ type: 'mouseup' });
    } else {
      const { x, y } = getCoords(e);
      send({ type: 'click', x, y });
    }
  };
  const onClick = (e) => {
    if (!isDragging.current) {
      const { x, y } = getCoords(e);
      send({ type: 'click', x, y });
    }
  };
  const onWheel = (e) => {
    e.preventDefault();
    send({ type: 'scroll', deltaX: e.deltaX, deltaY: e.deltaY });
  };
  const onKeyDown = (e) => {
    e.preventDefault();
    const special = ['Enter', 'Tab', 'Backspace', 'Delete', 'Escape',
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    if (special.includes(e.key)) send({ type: 'key', key: e.key });
    else if (e.key.length === 1) send({ type: 'type', text: e.key });
  };

  const handleSave = () => { send({ type: 'save_session' }); setStatus('saving'); setMessage('Saving...'); };
  const handleClose = () => { send({ type: 'close' }); wsRef.current?.close(); onClose?.(); };

  const dotColor = { starting: '#f59e0b', live: '#3b82f6', logged_in: '#10b981', saving: '#f59e0b', done: '#10b981', error: '#ef4444' }[status];

  return (
    <div style={{
      position: 'fixed', inset: 0, background: '#000', zIndex: 9999,
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Top bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 16px', background: '#111', borderBottom: '1px solid #222',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, boxShadow: `0 0 6px ${dotColor}` }} />
          <span style={{ color: '#e5e7eb', fontSize: 13, fontWeight: 500 }}>{message}</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {status === 'logged_in' && (
            <button onClick={handleSave} style={{
              padding: '6px 18px', borderRadius: 6, border: 'none',
              background: '#10b981', color: '#fff', fontWeight: 600, fontSize: 12, cursor: 'pointer',
            }}>
              Save & Start Bot
            </button>
          )}
          <button onClick={handleClose} style={{
            padding: '6px 18px', borderRadius: 6, border: '1px solid #333',
            background: 'transparent', color: '#9ca3af', fontSize: 12, cursor: 'pointer',
          }}>
            {status === 'done' ? 'Done' : 'Cancel'}
          </button>
        </div>
      </div>

      {/* URL bar */}
      <div style={{
        padding: '4px 16px', background: '#1a1a1a', borderBottom: '1px solid #222',
        fontSize: 11, color: '#6b7280', fontFamily: 'monospace',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        flexShrink: 0,
      }}>
        {url || 'Loading...'}
      </div>

      {/* Browser view */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', background: '#0a0a0a' }}>
        <canvas
          ref={canvasRef}
          tabIndex={0}
          onClick={onClick}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onWheel={onWheel}
          onKeyDown={onKeyDown}
          style={{
            maxWidth: '100%', maxHeight: '100%',
            cursor: 'default', outline: 'none',
          }}
        />
        {status === 'starting' && (
          <div style={{ position: 'absolute', color: '#f59e0b', fontSize: 15 }}>
            Launching browser... this takes a few seconds
          </div>
        )}
        {status === 'done' && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.85)',
          }}>
            <div style={{ fontSize: 48, color: '#10b981', marginBottom: 12 }}>&#10003;</div>
            <div style={{ color: '#10b981', fontSize: 20, fontWeight: 700 }}>Binance Connected!</div>
            <div style={{ color: '#9ca3af', fontSize: 13, marginTop: 8 }}>Bot session saved. Trading automation ready.</div>
            <button onClick={handleClose} style={{
              marginTop: 20, padding: '10px 30px', borderRadius: 8, border: 'none',
              background: '#10b981', color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer',
            }}>Close</button>
          </div>
        )}
      </div>

      {/* Footer hint */}
      <div style={{
        padding: '6px 16px', background: '#111', borderTop: '1px solid #222',
        fontSize: 11, color: '#4b5563', textAlign: 'center', flexShrink: 0,
      }}>
        Click and type directly. Drag to solve CAPTCHA puzzles.
        Your credentials go directly to Binance — never stored by SparkP2P.
      </div>
    </div>
  );
}
