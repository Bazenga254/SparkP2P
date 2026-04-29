import { useState, useRef, useEffect } from 'react';
import axios from 'axios';

const GREETING = {
  role: 'assistant',
  content: "👋 Hi! I'm the SparkP2P assistant. Ask me anything about how the bot works, pricing, setup, or whether it's the right fit for you.",
};

export default function PublicChat() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([GREETING]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState([
    'How does it work?',
    'Is it free to use?',
    'What do I need to get started?',
  ]);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open, messages]);

  const send = async (text) => {
    const msg = text || input.trim();
    if (!msg || loading) return;
    setInput('');
    setSuggestions([]);

    const history = messages
      .filter(m => m.role !== 'assistant' || m !== GREETING)
      .map(m => ({ role: m.role, content: m.content }));

    const next = [...messages, { role: 'user', content: msg }];
    setMessages(next);
    setLoading(true);

    try {
      const { data } = await axios.post('/api/public-chat', {
        message: msg,
        history: history.slice(-10),
      });
      setMessages(prev => [...prev, { role: 'assistant', content: data.reply }]);
      if (data.suggestions?.length) setSuggestions(data.suggestions);
    } catch {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'Sorry, I\'m having trouble connecting. Email us at support@sparkp2p.com and we\'ll help you out.',
      }]);
    } finally {
      setLoading(false);
    }
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <>
      {/* Floating bubble */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          position: 'fixed', bottom: 28, right: 28, zIndex: 9999,
          width: 56, height: 56, borderRadius: '50%', border: 'none',
          background: open ? '#374151' : '#f59e0b',
          color: open ? '#fff' : '#000',
          fontSize: 24, cursor: 'pointer',
          boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'background 0.2s, transform 0.2s',
          transform: open ? 'rotate(45deg)' : 'none',
        }}
        title={open ? 'Close chat' : 'Chat with us'}
      >
        {open ? '✕' : '💬'}
      </button>

      {/* Unread dot when closed */}
      {!open && (
        <span style={{
          position: 'fixed', bottom: 72, right: 28, zIndex: 10000,
          width: 10, height: 10, borderRadius: '50%', background: '#10b981',
          border: '2px solid #0a0e1a',
        }} />
      )}

      {/* Chat panel */}
      {open && (
        <div style={{
          position: 'fixed', bottom: 96, right: 28, zIndex: 9998,
          width: 360, height: 520,
          background: '#111827', border: '1px solid #1f2937',
          borderRadius: 16, boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          animation: 'fadeSlideUp 0.2s ease',
        }}>

          {/* Header */}
          <div style={{
            padding: '14px 18px', borderBottom: '1px solid #1f2937',
            display: 'flex', alignItems: 'center', gap: 12,
            background: '#0d1117',
          }}>
            <img src="/logo.png" alt="" style={{ width: 30, height: 30, borderRadius: 6 }} />
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>SparkP2P Support</div>
              <div style={{ fontSize: 11, color: '#10b981', display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981', display: 'inline-block' }} />
                AI assistant · Online
              </div>
            </div>
            <button
              onClick={() => setOpen(false)}
              style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 18 }}
            >✕</button>
          </div>

          {/* Messages */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {messages.map((m, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                <div style={{
                  maxWidth: '82%', padding: '9px 13px', borderRadius: m.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                  background: m.role === 'user' ? '#f59e0b' : '#1f2937',
                  color: m.role === 'user' ? '#000' : '#e5e7eb',
                  fontSize: 13, lineHeight: 1.55, fontWeight: m.role === 'user' ? 600 : 400,
                }}>
                  {m.content}
                </div>
              </div>
            ))}
            {loading && (
              <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                <div style={{ background: '#1f2937', borderRadius: '14px 14px 14px 4px', padding: '10px 14px', display: 'flex', gap: 5 }}>
                  {[0, 1, 2].map(i => (
                    <span key={i} style={{
                      width: 7, height: 7, borderRadius: '50%', background: '#6b7280',
                      animation: `bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
                      display: 'inline-block',
                    }} />
                  ))}
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Suggestion chips */}
          {suggestions.length > 0 && !loading && (
            <div style={{ padding: '0 14px 10px', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {suggestions.map((s, i) => (
                <button key={i} onClick={() => send(s)} style={{
                  background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)',
                  color: '#f59e0b', borderRadius: 20, padding: '4px 12px',
                  fontSize: 11, cursor: 'pointer', fontWeight: 500,
                  transition: 'background 0.15s',
                }}>
                  {s}
                </button>
              ))}
            </div>
          )}

          {/* Input */}
          <div style={{ padding: '10px 14px 14px', borderTop: '1px solid #1f2937', display: 'flex', gap: 8 }}>
            <input
              ref={inputRef}
              value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKey}
              placeholder="Type a message…" disabled={loading}
              style={{
                flex: 1, padding: '9px 12px', borderRadius: 10, border: '1px solid #374151',
                background: '#0d1117', color: '#fff', fontSize: 13, outline: 'none',
              }}
            />
            <button
              onClick={() => send()}
              disabled={!input.trim() || loading}
              style={{
                width: 38, height: 38, borderRadius: 10, border: 'none',
                background: input.trim() && !loading ? '#f59e0b' : '#374151',
                color: input.trim() && !loading ? '#000' : '#6b7280',
                cursor: input.trim() && !loading ? 'pointer' : 'not-allowed',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 16, flexShrink: 0, transition: 'background 0.15s',
              }}
            >
              ➤
            </button>
          </div>
        </div>
      )}

      <style>{`
        @keyframes fadeSlideUp {
          from { opacity: 0; transform: translateY(16px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes bounce {
          0%, 80%, 100% { transform: translateY(0); }
          40%            { transform: translateY(-6px); }
        }
      `}</style>
    </>
  );
}
