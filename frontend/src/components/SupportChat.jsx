import { useState, useEffect, useRef } from 'react';
import { MessageCircle, X, Send, ChevronDown, Loader, AlertCircle, UserCheck, Paperclip } from 'lucide-react';
import { sendSupportMessage, getActiveSupportTicket, uploadSupportAttachment } from '../services/api';

const QUICK_TOPICS = [
  { icon: '💰', color: '#f97316', bg: 'rgba(249,115,22,0.15)', label: 'Wallet & Balance',    msg: 'How do I check my balance and when do I receive my earnings?' },
  { icon: '🔗', color: '#14b8a6', bg: 'rgba(20,184,166,0.15)', label: 'Connect Binance',     msg: 'How do I connect my Binance account to SparkP2P?' },
  { icon: '📤', color: '#ef4444', bg: 'rgba(239,68,68,0.15)',  label: 'Withdrawal Issue',    msg: 'I have an issue with my withdrawal or M-Pesa payment.' },
  { icon: '📋', color: '#3b82f6', bg: 'rgba(59,130,246,0.15)', label: 'Order Problem',       msg: 'I have a problem with one of my P2P orders.' },
  { icon: '⚙️', color: '#22c55e', bg: 'rgba(34,197,94,0.15)',  label: 'Account & Settings', msg: 'How do I update my account settings or change my settlement method?' },
  { icon: '💸', color: '#10b981', bg: 'rgba(16,185,129,0.15)', label: 'Fees & Charges',      msg: 'What are the fees for withdrawals, M-Pesa transfers, and platform charges?' },
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
  const [suggestions, setSuggestions] = useState([]);
  const [attachment, setAttachment]   = useState(null);
  const [uploading, setUploading]     = useState(false);
  const bottomRef  = useRef(null);
  const inputRef   = useRef(null);
  const fileRef    = useRef(null);

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

  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const res = await uploadSupportAttachment(file);
      setAttachment({ url: res.data.url, name: res.data.name, type: res.data.type });
    } catch {
      alert('Upload failed. Max 10 MB. Allowed: images, PDF, DOC, TXT.');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const sendMessage = async (text) => {
    const msg = (text || input).trim();
    if ((!msg && !attachment) || loading) return;

    setSuggestions([]);
    const userMsg = { role: 'user', content: msg };
    if (attachment) { userMsg.attachment_url = attachment.url; userMsg.attachment_name = attachment.name; userMsg.attachment_type = attachment.type; }
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    const sentAttachment = attachment;
    setAttachment(null);

    if (escalated) {
      sendSupportMessage(msg, ticketId, sentAttachment?.url, sentAttachment?.name).catch(() => {});
      return;
    }

    setLoading(true);
    try {
      const res = await sendSupportMessage(msg, ticketId, sentAttachment?.url, sentAttachment?.name);
      const { ticket_id, escalated: isEscalated, suggestions: newSuggestions, reply } = res.data;
      setTicketId(ticket_id);
      if (isEscalated) {
        setEscalated(true);
        setMessages(newMessages);
        setSuggestions([]);
      } else {
        setMessages([...newMessages, { role: 'assistant', content: reply }]);
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

  const isBlank = messages.length === 0 && !loading;

  return (
    <>
      {/* Floating Button */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="sc-fab"
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

      {/* Chat Window */}
      {open && (
        <div className="sc-window" style={{
          position: 'fixed', bottom: 96, right: 28,
          width: 360, maxHeight: 560,
          background: '#14172b',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 16,
          boxShadow: '0 8px 40px rgba(0,0,0,0.7)',
          display: 'flex', flexDirection: 'column',
          zIndex: 9998, overflow: 'hidden',
        }}>

          {/* Header — dark, no gradient */}
          <div style={{
            padding: '14px 16px',
            background: '#1a1d2e',
            borderBottom: '1px solid rgba(255,255,255,0.07)',
            display: 'flex', alignItems: 'center', gap: 10,
            flexShrink: 0,
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: '50%',
              background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <MessageCircle size={18} color="white" />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: '#f3f4f6', fontWeight: 700, fontSize: 14 }}>SparkP2P Support</div>
              <div style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 5, marginTop: 1 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: escalated ? '#f59e0b' : '#10b981', flexShrink: 0, display: 'inline-block' }} />
                <span style={{ color: escalated ? '#f59e0b' : '#10b981' }}>{escalated ? 'Escalated to team' : 'Online · Usually replies instantly'}</span>
              </div>
            </div>
            <button onClick={() => setOpen(false)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 4, flexShrink: 0, display: 'flex', alignItems: 'center' }}>
              <X size={18} />
            </button>
          </div>

          {/* Messages area */}
          <div style={{
            flex: 1, overflowY: 'auto',
            padding: '14px 14px 8px',
            display: 'flex', flexDirection: 'column', gap: 10,
          }}>

            {/* Welcome screen */}
            {isBlank && (
              <>
                <div style={{
                  background: '#1e2240', borderRadius: 12,
                  padding: '12px 14px', fontSize: 13, color: '#9ca3af', lineHeight: 1.6,
                }}>
                  <strong style={{ color: '#e5e7eb', display: 'block', marginBottom: 4, fontSize: 14 }}>👋 Hi there!</strong>
                  I'm SparkP2P's AI assistant. Ask me anything or pick a topic below. I'll escalate to our team if needed.
                </div>

                {/* Popular Topics label */}
                <div style={{ color: '#4b5563', fontSize: 10, fontWeight: 700, letterSpacing: '0.8px', textTransform: 'uppercase', marginTop: 4 }}>Popular Topics</div>

                {/* 2-column grid topic buttons */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {QUICK_TOPICS.map((t) => (
                    <button key={t.label} onClick={() => sendMessage(t.msg)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '10px 12px', borderRadius: 10, textAlign: 'left',
                        background: '#1a1d2e', border: '1px solid rgba(255,255,255,0.07)',
                        color: '#d1d5db', cursor: 'pointer', fontSize: 12, fontWeight: 500,
                        transition: 'border-color 0.15s, background 0.15s',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(99,102,241,0.4)'; e.currentTarget.style.background = '#1e2240'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)'; e.currentTarget.style.background = '#1a1d2e'; }}
                    >
                      <span style={{
                        width: 28, height: 28, borderRadius: 7, flexShrink: 0,
                        background: t.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15,
                      }}>{t.icon}</span>
                      <span style={{ lineHeight: 1.3 }}>{t.label}</span>
                    </button>
                  ))}
                </div>

                {/* Separator + Talk to human */}
                <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '2px 0' }} />
                <button onClick={requestAgent} disabled={loading}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    padding: '9px 0', borderRadius: 10, fontSize: 12, fontWeight: 500,
                    background: 'transparent', border: '1px solid rgba(255,255,255,0.1)',
                    color: '#9ca3af', cursor: loading ? 'not-allowed' : 'pointer',
                    transition: 'border-color 0.15s, color 0.15s',
                  }}
                  onMouseEnter={(e) => { if (!loading) { e.currentTarget.style.borderColor = '#6366f1'; e.currentTarget.style.color = '#c4b5fd'; } }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; e.currentTarget.style.color = '#9ca3af'; }}
                >
                  <UserCheck size={13} /> Talk to a human agent
                </button>
              </>
            )}

            {/* Message history */}
            {messages.map((m, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                <div style={{
                  maxWidth: '80%', padding: '8px 12px',
                  borderRadius: m.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                  background: m.role === 'user' ? 'linear-gradient(135deg, #6366f1, #8b5cf6)' : m.role === 'admin' ? 'rgba(16,185,129,0.15)' : '#1e2240',
                  color: m.role === 'user' ? 'white' : '#e5e7eb',
                  fontSize: 13, lineHeight: 1.5,
                  border: m.role === 'user' ? 'none' : '1px solid rgba(255,255,255,0.08)',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>
                  {m.role === 'admin' && <div style={{ fontSize: 10, color: '#6ee7b7', marginBottom: 3, fontWeight: 600 }}>Support Team</div>}
                  {m.content}
                  {m.attachment_url && (
                    <div style={{ marginTop: 6 }}>
                      {m.attachment_type?.startsWith('image/') ? (
                        <img src={m.attachment_url} alt={m.attachment_name} style={{ maxWidth: '100%', borderRadius: 8, display: 'block' }} />
                      ) : (
                        <a href={m.attachment_url} target="_blank" rel="noreferrer"
                          style={{ display: 'flex', alignItems: 'center', gap: 5, color: m.role === 'user' ? 'rgba(255,255,255,0.85)' : '#a5b4fc', fontSize: 12, textDecoration: 'none' }}>
                          📎 {m.attachment_name || 'Attachment'}
                        </a>
                      )}
                    </div>
                  )}
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

            {/* AI follow-up suggestion chips */}
            {suggestions.length > 0 && !loading && !escalated && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingLeft: 2 }}>
                {suggestions.map((sg) => (
                  <button key={sg} onClick={() => sendMessage(sg)}
                    style={{
                      padding: '5px 11px', borderRadius: 20, fontSize: 11,
                      background: 'transparent', border: '1px solid rgba(99,102,241,0.5)',
                      color: '#a5b4fc', cursor: 'pointer',
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = '#2d2f5e')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    {sg}
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
                <div>Your case has been escalated to our support team. You can still send messages and they will respond here.</div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Input area */}
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', background: '#14172b', flexShrink: 0 }}>
            {attachment && (
              <div style={{ padding: '4px 12px 0', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, color: '#a5b4fc', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  📎 {attachment.name}
                </span>
                <button onClick={() => setAttachment(null)} style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 14, padding: 0 }}>✕</button>
              </div>
            )}
            <div style={{ padding: '8px 12px 10px', display: 'flex', gap: 6, alignItems: 'flex-end' }}>
              <input ref={fileRef} type="file" accept="image/*,.pdf,.doc,.docx,.txt" style={{ display: 'none' }} onChange={handleFileSelect} />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                title="Attach file"
                style={{
                  width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
                  background: 'transparent', border: '1px solid rgba(255,255,255,0.1)',
                  cursor: uploading ? 'not-allowed' : 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                {uploading ? <Loader size={15} color="#6366f1" style={{ animation: 'spin 1s linear infinite' }} /> : <Paperclip size={15} color="#6b7280" />}
              </button>
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
                disabled={(!input.trim() && !attachment) || loading}
                style={{
                  width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                  background: (!input.trim() && !attachment) || loading ? '#1e2240' : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  cursor: (!input.trim() && !attachment) || loading ? 'not-allowed' : 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'background 0.2s',
                }}
              >
                {loading
                  ? <Loader size={16} color="#6366f1" style={{ animation: 'spin 1s linear infinite' }} />
                  : <Send size={16} color={!input.trim() && !attachment ? '#6b7280' : 'white'} />
                }
              </button>
            </div>
          </div>
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
        @media (max-width: 480px) {
          .sc-fab {
            bottom: 88px !important;
          }
          .sc-window {
            right: 8px !important;
            left: 8px !important;
            width: auto !important;
            bottom: 152px !important;
            max-height: 70vh !important;
          }
        }
      `}</style>
    </>
  );
}
