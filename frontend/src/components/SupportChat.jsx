import { useState, useEffect, useRef } from 'react';
import { MessageCircle, X, Send, ChevronDown, Loader, AlertCircle } from 'lucide-react';
import { sendSupportMessage, getActiveSupportTicket } from '../services/api';

export default function SupportChat() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [ticketId, setTicketId] = useState(null);
  const [escalated, setEscalated] = useState(false);
  const [unread, setUnread] = useState(false);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  // Load active ticket on mount
  useEffect(() => {
    const loadActiveTicket = async () => {
      try {
        const res = await getActiveSupportTicket();
        if (res.data) {
          setTicketId(res.data.id);
          const history = (res.data.messages || []).map((m) => ({
            role: m.role,
            content: m.content,
          }));
          setMessages(history);
          setEscalated(res.data.status === 'escalated');
        }
      } catch (_) {}
    };
    loadActiveTicket();
  }, []);

  // Scroll to bottom when messages change
  useEffect(() => {
    if (open) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, open]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setUnread(false);
      setTimeout(() => inputRef.current?.focus(), 100);
      bottomRef.current?.scrollIntoView({ behavior: 'instant' });
    }
  }, [open]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || loading || escalated) return;

    const newMessages = [...messages, { role: 'user', content: text }];
    setMessages(newMessages);
    setInput('');
    setLoading(true);

    try {
      const res = await sendSupportMessage(text, ticketId);
      const { ticket_id, reply, escalated: isEscalated } = res.data;
      setTicketId(ticket_id);
      setMessages([...newMessages, { role: 'assistant', content: reply }]);
      if (isEscalated) setEscalated(true);
      if (!open) setUnread(true);
    } catch (err) {
      setMessages([
        ...newMessages,
        {
          role: 'assistant',
          content: "I'm having trouble connecting right now. Please try again in a moment.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const startNew = () => {
    setTicketId(null);
    setEscalated(false);
    setMessages([]);
  };

  const welcomeMessage = messages.length === 0 && !loading;

  return (
    <>
      {/* Floating Button */}
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          position: 'fixed',
          bottom: 28,
          right: 28,
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 4px 20px rgba(99,102,241,0.5)',
          zIndex: 9999,
          transition: 'transform 0.2s',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.1)')}
        onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
        title="Support Chat"
      >
        {open ? (
          <ChevronDown size={24} color="white" />
        ) : (
          <MessageCircle size={24} color="white" />
        )}
        {unread && !open && (
          <span
            style={{
              position: 'absolute',
              top: 4,
              right: 4,
              width: 12,
              height: 12,
              borderRadius: '50%',
              background: '#ef4444',
              border: '2px solid white',
            }}
          />
        )}
      </button>

      {/* Chat Window */}
      {open && (
        <div
          style={{
            position: 'fixed',
            bottom: 96,
            right: 28,
            width: 360,
            maxHeight: 520,
            background: '#14172b',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 16,
            boxShadow: '0 8px 40px rgba(0,0,0,0.7)',
            display: 'flex',
            flexDirection: 'column',
            zIndex: 9998,
            overflow: 'hidden',
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: '14px 16px',
              background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: '50%',
                background: 'rgba(255,255,255,0.2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <MessageCircle size={18} color="white" />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ color: 'white', fontWeight: 600, fontSize: 14 }}>SparkP2P Support</div>
              <div style={{ color: 'rgba(255,255,255,0.75)', fontSize: 11 }}>
                {escalated ? '⚡ Escalated to team' : '● Online · Usually replies instantly'}
              </div>
            </div>
            <button
              onClick={() => setOpen(false)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'white', padding: 4 }}
            >
              <X size={18} />
            </button>
          </div>

          {/* Messages */}
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '12px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              minHeight: 200,
              maxHeight: 340,
            }}
          >
            {welcomeMessage && (
              <div
                style={{
                  background: '#1e2240',
                  borderRadius: 12,
                  padding: '12px 14px',
                  fontSize: 13,
                  color: '#9ca3af',
                  lineHeight: 1.5,
                }}
              >
                <strong style={{ color: '#e5e7eb', display: 'block', marginBottom: 4 }}>
                  👋 Hi there!
                </strong>
                I'm SparkP2P's AI assistant. Ask me anything about your account, trades, or M-Pesa settlements. I'll escalate to our team if needed.
              </div>
            )}

            {messages.map((m, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start',
                }}
              >
                <div
                  style={{
                    maxWidth: '80%',
                    padding: '8px 12px',
                    borderRadius: m.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                    background: m.role === 'user' ? 'linear-gradient(135deg, #6366f1, #8b5cf6)' : '#1e2240',
                    color: m.role === 'user' ? 'white' : '#e5e7eb',
                    fontSize: 13,
                    lineHeight: 1.5,
                    border: m.role === 'user' ? 'none' : '1px solid rgba(255,255,255,0.08)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {m.content}
                </div>
              </div>
            ))}

            {loading && (
              <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                <div
                  style={{
                    padding: '10px 14px',
                    borderRadius: '14px 14px 14px 4px',
                    background: '#1e2240',
                    border: '1px solid rgba(255,255,255,0.08)',
                    display: 'flex',
                    gap: 4,
                    alignItems: 'center',
                  }}
                >
                  {[0, 1, 2].map((d) => (
                    <span
                      key={d}
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: '#6366f1',
                        animation: `bounce 1.2s ease-in-out ${d * 0.2}s infinite`,
                      }}
                    />
                  ))}
                </div>
              </div>
            )}

            {escalated && (
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  padding: '10px 12px',
                  background: 'rgba(245,158,11,0.1)',
                  border: '1px solid rgba(245,158,11,0.3)',
                  borderRadius: 10,
                  fontSize: 12,
                  color: '#d97706',
                  alignItems: 'flex-start',
                }}
              >
                <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                <div>
                  Your case has been escalated to our support team. They will review it and reach out to you.{' '}
                  <button
                    onClick={startNew}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#6366f1',
                      cursor: 'pointer',
                      padding: 0,
                      fontSize: 12,
                      textDecoration: 'underline',
                    }}
                  >
                    Start new chat
                  </button>
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Input */}
          {!escalated && (
            <div
              style={{
                padding: '10px 12px',
                borderTop: '1px solid rgba(255,255,255,0.08)',
                background: '#14172b',
                display: 'flex',
                gap: 8,
                alignItems: 'flex-end',
              }}
            >
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type a message…"
                rows={1}
                style={{
                  flex: 1,
                  resize: 'none',
                  padding: '8px 12px',
                  borderRadius: 20,
                  border: '1px solid rgba(255,255,255,0.1)',
                  background: '#1e2240',
                  color: '#e5e7eb',
                  fontSize: 13,
                  outline: 'none',
                  fontFamily: 'inherit',
                  maxHeight: 80,
                  overflowY: 'auto',
                  lineHeight: '1.4',
                }}
              />
              <button
                onClick={sendMessage}
                disabled={!input.trim() || loading}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: '50%',
                  background:
                    !input.trim() || loading
                      ? '#1e2240'
                      : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  cursor: !input.trim() || loading ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  transition: 'background 0.2s',
                }}
              >
                {loading ? (
                  <Loader size={16} color="#6366f1" style={{ animation: 'spin 1s linear infinite' }} />
                ) : (
                  <Send size={16} color={!input.trim() ? '#6b7280' : 'white'} />
                )}
              </button>
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes bounce {
          0%, 60%, 100% { transform: translateY(0); }
          30% { transform: translateY(-6px); }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </>
  );
}
