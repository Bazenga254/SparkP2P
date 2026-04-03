import { useState, useEffect, useRef } from 'react';
import { MessageCircle, X, Send, ChevronDown, Loader, AlertCircle, UserCheck } from 'lucide-react';
import { sendSupportMessage, getActiveSupportTicket } from '../services/api';

// ── Initial topic chips shown before the user types anything ─────────────────
const QUICK_TOPICS = [
  { icon: '💰', label: 'Wallet & Balance',    msg: 'How do I check my balance and when do I receive my earnings?' },
  { icon: '🔗', label: 'Connect Binance',     msg: 'How do I connect my Binance account to SparkP2P?' },
  { icon: '📤', label: 'Withdrawal issue',    msg: 'I have an issue with my withdrawal or M-Pesa payment.' },
  { icon: '📋', label: 'Order problem',       msg: 'I have a problem with one of my P2P orders.' },
  { icon: '⚙️', label: 'Account & Settings', msg: 'How do I update my account settings or change my settlement method?' },
  { icon: '💸', label: 'Fees & Charges',      msg: 'What are the fees for withdrawals, M-Pesa transfers, and platform charges?' },
];

export default function SupportChat({ forceOpen, onOpen }) {
  const [open, setOpen]           = useState(false);

  useEffect(() => { if (forceOpen) { setOpen(true); if (onOpen) onOpen(); } }, [forceOpen]);
  const [messages, setMessages]   = useState([]);
  const [input, setInput]         = useState('');
  const [loading, setLoading]     = useState(false);
  const [ticketId, setTicketId]   = useState(null);
  const [escalated, setEscalated] = useState(false);
  const [unread, setUnread]       = useState(false);
  const [suggestions, setSuggestions] = useState([]); // follow-up chips from last AI reply
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);

  // Load active ticket on mount
  useEffect(() => {
    const loadActiveTicket = async () => {
      try {
        const res = await getActiveSupportTicket();
        if (res.data) {
          setTicketId(res.data.id);
          const history = (res.data.messages || []).map((m) => ({ role: m.role, content: m.content }));
          setMessages(history);
          setEscalated(res.data.status === 'escalated');
        }
      } catch (_) {}
    };
    loadActiveTicket();
  }, []);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, open, suggestions]);

  useEffect(() => {
    if (open) {
      setUnread(false);
      setTimeout(() => inputRef.current?.focus(), 100);
      bottomRef.current?.scrollIntoView({ behavior: 'instant' });
    }
  }, [open]);

  const sendMessage = async (text) => {
    const msg = (text || input).trim();
    if (!msg || loading || escalated) return;

    setSuggestions([]); // clear old chips while waiting
    const newMessages = [...messages, { role: 'user', content: msg }];
    setMessages(newMessages);
    setInput('');
    setLoading(true);

    try {
      const res = await sendSupportMessage(msg, ticketId);
      const { ticket_id, reply, escalated: isEscalated, suggestions: newSuggestions } = res.data;
      setTicketId(ticket_id);
      setMessages([...newMessages, { role: 'assistant', content: reply }]);
      if (isEscalated) {
        setEscalated(true);
        setSuggestions([]);
      } else {
        setSuggestions(newSuggestions || []);
      }
      if (!open) setUnread(true);
    } catch {
      setMessages([...newMessages, {
        role: 'assistant',
        content: "I'm having trouble connecting right now. Please try again in a moment.",
      }]);
      setSuggestions(['Try again', 'Talk to an agent']);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const requestAgent = () => sendMessage('I need to speak with a human agent.');

  const startNew = () => {
    setTicketId(null);
    setEscalated(false);
    setMessages([]);
    setSuggestions([]);
  };

  const isBlank = messages.length === 0 && !loading;

  return (
    <>
      {/* ── Floating Button ── */}
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          position: 'fixed', bottom: 28, right: 28,
          width: 56, height: 56, borderRadius: '50%',
          background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
          border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 4px 20px rgba(99,102,241,0.5)',
          zIndex: 9999, transition: 'transform 0.2s',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.1)')}
        onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
        title="Support Chat"
      >
        {open ? <ChevronDown size={24} color="white" /> : <MessageCircle size={24} color="white" />}
        {unread && !open && (
          <span style={{
            position: 'absolute', top: 4, right: 4,
            width: 12, height: 12, borderRadius: '50%',
            background: '#ef4444', border: '2px solid white',
          }} />
        )}
      </button>

      {/* ── Chat Window ── */}
      {open && (
        <div style={{
          position: 'fixed', bottom: 96, right: 28,
          width: 360, maxHeight: 560,
          background: '#14172b',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 16,
          boxShadow: '0 8px 40px rgba(0,0,0,0.7)',
          display: 'flex', flexDirection: 'column',
          zIndex: 9998, overflow: 'hidden',
        }}>

          {/* Header */}
          <div style={{
            padding: '14px 16px',
            background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: '50%',
              background: 'rgba(255,255,255,0.2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <MessageCircle size={18} color="white" />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ color: 'white', fontWeight: 600, fontSize: 14 }}>SparkP2P Support</div>
              <div style={{ color: 'rgba(255,255,255,0.75)', fontSize: 11 }}>
                {escalated ? '⚡ Escalated to team' : '● Online · Usually replies instantly'}
              </div>
            </div>
            <button onClick={() => setOpen(false)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'white', padding: 4 }}>
              <X size={18} />
            </button>
          </div>

          {/* Messages */}
          <div style={{
            flex: 1, overflowY: 'auto',
            padding: '12px 14px',
            display: 'flex', flexDirection: 'column', gap: 10,
            minHeight: 200, maxHeight: 360,
          }}>

            {/* Welcome + topic chips */}
            {isBlank && (
              <>
                <div style={{
                  background: '#1e2240', borderRadius: 12,
                  padding: '12px 14px', fontSize: 13, color: '#9ca3af', lineHeight: 1.5,
                }}>
                  <strong style={{ color: '#e5e7eb', display: 'block', marginBottom: 4 }}>👋 Hi there!</strong>
                  I'm SparkP2P's AI assistant. Ask me anything or pick a topic below. I'll escalate to our team if needed.
                </div>

                {/* Topic chips */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingTop: 2 }}>
                  {QUICK_TOPICS.map((t) => (
                    <button key={t.label} onClick={() => sendMessage(t.msg)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 5,
                        padding: '6px 11px', borderRadius: 20, fontSize: 12,
                        background: '#1e2240', border: '1px solid rgba(99,102,241,0.4)',
                        color: '#c4b5fd', cursor: 'pointer',
                        transition: 'background 0.15s, border-color 0.15s',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = '#2d2f5e'; e.currentTarget.style.borderColor = '#6366f1'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = '#1e2240'; e.currentTarget.style.borderColor = 'rgba(99,102,241,0.4)'; }}
                    >
                      <span>{t.icon}</span> {t.label}
                    </button>
                  ))}
                </div>
              </>
            )}

            {/* Message history */}
            {messages.map((m, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                <div style={{
                  maxWidth: '80%', padding: '8px 12px',
                  borderRadius: m.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                  background: m.role === 'user' ? 'linear-gradient(135deg, #6366f1, #8b5cf6)' : '#1e2240',
                  color: m.role === 'user' ? 'white' : '#e5e7eb',
                  fontSize: 13, lineHeight: 1.5,
                  border: m.role === 'user' ? 'none' : '1px solid rgba(255,255,255,0.08)',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>
                  {m.content}
                </div>
              </div>
            ))}

            {/* Typing indicator */}
            {loading && (
              <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                <div style={{
                  padding: '10px 14px', borderRadius: '14px 14px 14px 4px',
                  background: '#1e2240', border: '1px solid rgba(255,255,255,0.08)',
                  display: 'flex', gap: 4, alignItems: 'center',
                }}>
                  {[0, 1, 2].map((d) => (
                    <span key={d} style={{
                      width: 7, height: 7, borderRadius: '50%', background: '#6366f1',
                      animation: `bounce 1.2s ease-in-out ${d * 0.2}s infinite`,
                    }} />
                  ))}
                </div>
              </div>
            )}

            {/* AI-generated follow-up suggestion chips */}
            {suggestions.length > 0 && !loading && !escalated && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingLeft: 2 }}>
                {suggestions.map((s) => (
                  <button key={s} onClick={() => sendMessage(s)}
                    style={{
                      padding: '5px 11px', borderRadius: 20, fontSize: 11,
                      background: 'transparent', border: '1px solid rgba(99,102,241,0.5)',
                      color: '#a5b4fc', cursor: 'pointer',
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = '#2d2f5e')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}

            {/* Escalation notice */}
            {escalated && (
              <div style={{
                display: 'flex', gap: 8, padding: '10px 12px',
                background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)',
                borderRadius: 10, fontSize: 12, color: '#d97706', alignItems: 'flex-start',
              }}>
                <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                <div>
                  Your case has been escalated to our support team. They will review it and reach out.{' '}
                  <button onClick={startNew}
                    style={{ background: 'none', border: 'none', color: '#6366f1', cursor: 'pointer', padding: 0, fontSize: 12, textDecoration: 'underline' }}>
                    Start new chat
                  </button>
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Input area */}
          {!escalated && (
            <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', background: '#14172b' }}>
              {/* Talk to agent strip */}
              <div style={{
                padding: '7px 12px 0',
                display: 'flex', justifyContent: 'flex-end',
              }}>
                <button onClick={requestAgent} disabled={loading}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    padding: '4px 10px', borderRadius: 12, fontSize: 11,
                    background: 'transparent', border: '1px solid rgba(255,255,255,0.12)',
                    color: '#9ca3af', cursor: loading ? 'not-allowed' : 'pointer',
                    transition: 'border-color 0.15s, color 0.15s',
                  }}
                  onMouseEnter={(e) => { if (!loading) { e.currentTarget.style.borderColor = '#6366f1'; e.currentTarget.style.color = '#c4b5fd'; } }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)'; e.currentTarget.style.color = '#9ca3af'; }}
                >
                  <UserCheck size={11} /> Talk to an agent
                </button>
              </div>

              {/* Text input row */}
              <div style={{ padding: '8px 12px 10px', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type a message…"
                  rows={1}
                  style={{
                    flex: 1, resize: 'none',
                    padding: '8px 12px', borderRadius: 20,
                    border: '1px solid rgba(255,255,255,0.1)',
                    background: '#1e2240', color: '#e5e7eb',
                    fontSize: 13, outline: 'none', fontFamily: 'inherit',
                    maxHeight: 80, overflowY: 'auto', lineHeight: '1.4',
                  }}
                />
                <button onClick={() => sendMessage()}
                  disabled={!input.trim() || loading}
                  style={{
                    width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                    background: !input.trim() || loading ? '#1e2240' : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    cursor: !input.trim() || loading ? 'not-allowed' : 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    transition: 'background 0.2s',
                  }}
                >
                  {loading
                    ? <Loader size={16} color="#6366f1" style={{ animation: 'spin 1s linear infinite' }} />
                    : <Send size={16} color={!input.trim() ? '#6b7280' : 'white'} />
                  }
                </button>
              </div>
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
