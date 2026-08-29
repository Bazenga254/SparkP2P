import { useState, useEffect, useRef } from 'react';
import { mailboxList, mailboxThread, mailboxSend, mailboxReply, mailboxAttachment, mailboxMarkAllRead } from '../services/api';

const MAX_ATTACH_MB = 10;  // Brevo per-message attachment ceiling (safe margin)
const fileToB64 = (file) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1] || '');
  r.onerror = rej;
  r.readAsDataURL(file);
});
const humanSize = (b) => (b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB');

const fmtDate = (s) => {
  if (!s) return '';
  const d = new Date(s);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString('en-KE', { month: 'short', day: 'numeric' });
  return d.toLocaleDateString('en-KE', { month: 'short', day: 'numeric', year: '2-digit' });
};

// Gmail-styled palette (SparkP2P orange on dark navy)
const C = {
  orange: '#FF9F1C', orangeInk: '#3A2400',
  bg: '#0A0C10', line: '#1C2029', rowLine: '#14171E',
  unreadBg: '#12151B', hover: '#181C25',
  bright: '#ECEEF2', mid: '#B4B8C2', dim: '#7A8399', sub: '#8A8F9C', snip: '#5F6472',
  searchBg: '#151922', searchLine: '#232733', field: '#151922',
};

const S = {
  search: <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>,
  pencil: <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>,
  clip: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>,
  down: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke={C.orange} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
  star: (filled) => <svg viewBox="0 0 24 24" width="16" height="16" fill={filled ? C.orange : 'none'} stroke={filled ? C.orange : '#4A4F5B'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>,
};

const inp = {
  width: '100%', padding: '11px 13px', borderRadius: 8, border: `1px solid ${C.searchLine}`,
  background: C.field, color: C.bright, fontSize: 14, outline: 'none', boxSizing: 'border-box',
};

export default function AdminInbox() {
  const [folder, setFolder] = useState('inbox');
  const [supportOnly, setSupportOnly] = useState(false);
  const [msgs, setMsgs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(null);
  const [compose, setCompose] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [query, setQuery] = useState('');
  const [starred, setStarred] = useState(() => new Set());
  const fileRef = useRef();
  const replyFileRef = useRef();
  const [replyBody, setReplyBody] = useState('');
  const [replyAtts, setReplyAtts] = useState([]);
  const [replyBusy, setReplyBusy] = useState(false);

  const flash = (msg, ms = 2600) => { setToast(msg); setTimeout(() => setToast(''), ms); };

  // Open any link inside a rendered email externally: the desktop app routes to the
  // system browser (Chrome) via its preload bridge; a plain browser opens a new tab.
  const openExternal = (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || href.charAt(0) === '#') return;
    e.preventDefault();
    if (window.sparkp2p && typeof window.sparkp2p.openExternal === 'function') window.sparkp2p.openExternal(href);
    else window.open(href, '_blank', 'noopener,noreferrer');
  };

  const toggleStar = (id) => setStarred((prev) => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n;
  });

  const readFiles = async (fileList, existing) => {
    const files = Array.from(fileList || []);
    let running = (existing || []).reduce((s, a) => s + a.size, 0);
    const added = [];
    for (const f of files) {
      if (running + f.size > MAX_ATTACH_MB * 1048576) { flash(`Attachments must total under ${MAX_ATTACH_MB} MB`); break; }
      try { added.push({ name: f.name, size: f.size, content: await fileToB64(f) }); running += f.size; }
      catch { flash(`Could not read ${f.name}`); }
    }
    return added;
  };
  const pickFiles = async (fileList) => {
    const added = await readFiles(fileList, compose.attachments);
    if (added.length) setCompose((c) => ({ ...c, attachments: [...(c.attachments || []), ...added] }));
    if (fileRef.current) fileRef.current.value = '';
  };
  const pickReplyFiles = async (fileList) => {
    const added = await readFiles(fileList, replyAtts);
    if (added.length) setReplyAtts((a) => [...a, ...added]);
    if (replyFileRef.current) replyFileRef.current.value = '';
  };
  const removeAttach = (i) => setCompose((c) => ({ ...c, attachments: (c.attachments || []).filter((_, x) => x !== i) }));
  const removeReplyAtt = (i) => setReplyAtts((a) => a.filter((_, x) => x !== i));

  const downloadAttach = async (a) => {
    try {
      const r = await mailboxAttachment(a.id);
      const url = URL.createObjectURL(r.data);
      const link = document.createElement('a');
      link.href = url; link.download = a.filename || 'attachment';
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { flash('Download failed'); }
  };

  const markAllRead = async () => {
    try {
      await mailboxMarkAllRead();
      setMsgs((prev) => prev.map((m) => ({ ...m, is_read: true })));
      flash('All marked as read', 1800);
    } catch { flash('Could not mark all as read'); }
  };
  const unreadCount = msgs.filter((m) => !m.is_read).length;

  const load = async () => {
    setLoading(true);
    try {
      const r = await mailboxList({ folder, support: supportOnly ? 1 : 0, limit: 60 });
      setMsgs(r.data.messages || []);
    } catch { /* ignore */ } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [folder, supportOnly]);  // eslint-disable-line react-hooks/exhaustive-deps

  const openMsg = async (m) => {
    setReplyBody(''); setReplyAtts([]);
    try {
      const r = await mailboxThread(m.id);
      setOpen(r.data);
      setMsgs((prev) => prev.map((x) => (x.id === m.id ? { ...x, is_read: true } : x)));
    } catch { /* ignore */ }
  };

  const sendThreadReply = async () => {
    if (!replyBody.trim() || !open) return;
    setReplyBusy(true);
    try {
      await mailboxReply({ message_id: open.reply_to_id, body: replyBody,
        attachments: replyAtts.map((a) => ({ name: a.name, content: a.content })) });
      setReplyBody(''); setReplyAtts([]);
      const first = open.messages?.[0]?.id;
      if (first) { const r = await mailboxThread(first); setOpen(r.data); }
      if (folder === 'sent') load();
      flash('Reply sent', 1800);
    } catch (e) { flash(e.response?.data?.detail || 'Reply failed'); }
    finally { setReplyBusy(false); }
  };

  const doSend = async () => {
    if (!compose.body?.trim()) return;
    setBusy(true);
    const attachments = (compose.attachments || []).map((a) => ({ name: a.name, content: a.content }));
    try {
      if (compose.mode === 'reply') await mailboxReply({ message_id: compose.replyId, body: compose.body, attachments });
      else await mailboxSend({ to: compose.to.trim(), subject: compose.subject, body: compose.body, attachments });
      flash('Message sent', 2000);
      setCompose(null);
      if (folder === 'sent') load();
    } catch (e) {
      flash(e.response?.data?.detail || 'Send failed');
    } finally { setBusy(false); }
  };

  const initials = (name, addr) => ((name || addr || '?').trim()[0] || '?').toUpperCase();
  const avatarColor = (s) => {
    const palette = ['#FF9F1C', '#378ADD', '#639922', '#8b5cf6', '#D4537E', '#06b6d4', '#D85A30'];
    let h = 0; for (const ch of (s || '')) h = (h * 31 + ch.charCodeAt(0)) % palette.length;
    return palette[h];
  };

  const activeTab = folder === 'sent' ? 'sent' : (supportOnly ? 'support' : 'inbox');
  const setTab = (t) => {
    if (t === 'sent') { setFolder('sent'); setSupportOnly(false); }
    else if (t === 'support') { setFolder('inbox'); setSupportOnly(true); }
    else { setFolder('inbox'); setSupportOnly(false); }
  };

  const q = query.trim().toLowerCase();
  const shown = !q ? msgs : msgs.filter((m) => {
    const who = folder === 'sent' ? (m.to_addr || '') : (m.from_name || m.from_addr || '');
    return `${who} ${m.subject || ''} ${m.snippet || ''}`.toLowerCase().includes(q);
  });

  const Tab = ({ id, label }) => {
    const on = activeTab === id;
    return (
      <button onClick={() => setTab(id)}
        style={{ background: 'none', border: 'none', fontSize: 13, fontWeight: 500, padding: '9px 14px', cursor: 'pointer',
          color: on ? C.bright : C.dim, borderBottom: `2px solid ${on ? C.orange : 'transparent'}` }}>{label}</button>
    );
  };

  return (
    <div style={{ color: C.bright }}>
      <style>{`
        .mbx-row:hover { background: ${C.hover} !important; }
        .mbx-btn:hover { filter: brightness(1.08); }
        .mbx-ghost:hover { background: rgba(255,255,255,0.05); }
        .mbx-search::placeholder { color: ${C.dim}; }
      `}</style>

      {/* ===== Gmail-style list card (hidden while reading an email) ===== */}
      {!open && (<div style={{ background: C.bg, borderRadius: 12, overflow: 'hidden', border: `1px solid ${C.line}` }}>

        {/* header: logo + search + compose */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', borderBottom: `1px solid ${C.line}` }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: C.orange, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 15, color: C.orangeInk, flexShrink: 0 }}>S</div>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, background: C.searchBg, border: `1px solid ${C.searchLine}`, borderRadius: 8, padding: '8px 12px' }}>
            <span style={{ color: C.dim, display: 'flex' }}>{S.search}</span>
            <input className="mbx-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search mail"
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: C.bright, fontSize: 13 }} />
            {query && <button onClick={() => setQuery('')} style={{ background: 'none', border: 'none', color: C.dim, cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>×</button>}
          </div>
          <button className="mbx-btn" onClick={() => setCompose({ mode: 'new', to: '', subject: '', body: '' })}
            style={{ background: C.orange, color: C.orangeInk, border: 'none', borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', flexShrink: 0 }}>
            {S.pencil}Compose
          </button>
        </div>

        {/* tabs + actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px 0', borderBottom: `1px solid ${C.line}` }}>
          <Tab id="inbox" label="Inbox" />
          <Tab id="sent" label="Sent" />
          <Tab id="support" label="Support only" />
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, paddingRight: 6 }}>
            {folder === 'inbox' && unreadCount > 0 && (
              <button className="mbx-ghost" onClick={markAllRead}
                style={{ padding: '6px 12px', borderRadius: 7, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: `1px solid ${C.line}`, background: 'transparent', color: C.dim }}>
                Mark all read ({unreadCount})</button>
            )}
            <button className="mbx-ghost" onClick={load}
              style={{ padding: '6px 12px', borderRadius: 7, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: `1px solid ${C.line}`, background: 'transparent', color: C.dim }}>Refresh</button>
          </div>
        </div>

        {/* rows */}
        <div>
          {loading ? (
            <div style={{ padding: 48, textAlign: 'center', color: C.dim }}>Loading…</div>
          ) : shown.length === 0 ? (
            <div style={{ padding: 48, textAlign: 'center', color: C.dim }}>
              {query ? 'No mail matches your search.' : activeTab === 'support' ? 'No support emails.' : folder === 'sent' ? 'No sent messages yet.' : 'Your inbox is empty.'}
            </div>
          ) : shown.map((m) => {
            const who = folder === 'sent' ? (m.to_addr || '') : (m.from_name || m.from_addr || 'Unknown');
            const col = avatarColor(who);
            const isStar = starred.has(m.id);
            const unread = !m.is_read && folder === 'inbox';
            return (
              <div key={m.id} className="mbx-row" onClick={() => openMsg(m)}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 18px', borderBottom: `1px solid ${C.rowLine}`,
                  cursor: 'pointer', background: unread ? C.unreadBg : 'transparent', borderLeft: `3px solid ${unread ? C.orange : 'transparent'}`, transition: 'background .12s' }}>
                <input type="checkbox" onClick={(e) => e.stopPropagation()} style={{ width: 15, height: 15, accentColor: C.orange, flexShrink: 0, cursor: 'pointer' }} />
                <span onClick={(e) => { e.stopPropagation(); toggleStar(m.id); }} style={{ display: 'flex', flexShrink: 0, cursor: 'pointer' }} title="Star">{S.star(isStar)}</span>
                <div style={{ width: 28, height: 28, borderRadius: '50%', background: col + '22', color: col, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>{initials(m.from_name, folder === 'sent' ? m.to_addr : m.from_addr)}</div>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: unread ? 700 : 400, color: unread ? C.bright : C.mid, whiteSpace: 'nowrap', width: 160, overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 0 }}>
                    {folder === 'sent' ? 'To: ' : ''}{who}</span>
                  <span style={{ fontSize: 13, fontWeight: unread ? 600 : 400, color: unread ? C.bright : C.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
                    {m.subject || '(no subject)'}{m.snippet && <span style={{ color: C.snip, fontWeight: 400 }}> — {m.snippet}</span>}</span>
                </div>
                {m.is_support && <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.orange, border: `1px solid ${C.orange}55`, borderRadius: 5, padding: '2px 6px', flexShrink: 0 }}>Support</span>}
                {(m.has_attachments || m.attachment_count) ? <span style={{ color: C.dim, display: 'flex', flexShrink: 0 }}>{S.clip}</span> : null}
                <span style={{ fontSize: 12, color: unread ? C.bright : C.dim, fontWeight: unread ? 600 : 400, flexShrink: 0, width: 56, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtDate(m.received_at)}</span>
              </div>
            );
          })}
        </div>
      </div>)}

      {/* ===== full-page reading view (Gmail-style — the page scrolls, not a modal) ===== */}
      {open && (
        <div style={{ background: C.bg, borderRadius: 12, border: `1px solid ${C.line}`, overflow: 'hidden' }}>

            <div style={{ padding: '12px 18px', borderBottom: `1px solid ${C.line}`, display: 'flex', alignItems: 'center', gap: 12, position: 'sticky', top: 0, background: C.bg, zIndex: 3 }}>
              <button onClick={() => setOpen(null)} className="mbx-ghost" style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'transparent', border: `1px solid ${C.line}`, color: C.mid, cursor: 'pointer', fontSize: 13, fontWeight: 600, padding: '7px 12px', borderRadius: 8, flexShrink: 0 }}>
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
                Back
              </button>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ margin: 0, fontSize: 16.5, fontWeight: 700, lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{open.subject || '(no subject)'}</div>
                <div style={{ fontSize: 12, color: C.dim, marginTop: 2 }}>{open.messages?.length || 0} message{(open.messages?.length || 0) !== 1 ? 's' : ''} · with {open.counterparty}</div>
              </div>
            </div>

            {/* content flows down the page — the admin page scrolls, so tall emails read naturally */}
            <div style={{ padding: '18px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              {(open.messages || []).map((msg) => {
                const mine = msg.folder === 'sent';
                const who = mine ? 'You' : (msg.from_name || msg.from_addr);
                return (
                  <div key={msg.id} style={{ border: `1px solid ${C.line}`, borderRadius: 12, overflow: 'hidden',
                    borderLeft: mine ? `3px solid ${C.orange}` : `1px solid ${C.line}` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 15px', background: 'rgba(255,255,255,0.02)' }}>
                      <span style={{ width: 30, height: 30, borderRadius: 99, background: mine ? C.orange : avatarColor(who), color: mine ? C.orangeInk : '#fff',
                        display: 'grid', placeItems: 'center', fontSize: 13, fontWeight: 700, flex: '0 0 auto' }}>{mine ? 'Y' : initials(msg.from_name, msg.from_addr)}</span>
                      <div style={{ minWidth: 0, flex: '1 1 auto' }}>
                        <div style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{who}</div>
                        <div style={{ fontSize: 12, color: C.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{mine ? `to ${msg.to_addr}` : msg.from_addr}</div>
                      </div>
                      <span style={{ fontSize: 12, color: C.dim, flex: '0 0 auto' }}>{fmtDate(msg.received_at)}</span>
                    </div>
                    <div style={{ padding: '14px 16px' }}>
                      {msg.body_html
                        ? <div onClick={openExternal} style={{ background: '#fff', color: '#1a1a1a', borderRadius: 8, padding: 14, fontSize: 13.5, overflowX: 'auto' }} dangerouslySetInnerHTML={{ __html: msg.body_html }} />
                        : <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.6, color: C.bright }}>{msg.body_text || '(no content)'}</div>}
                      {msg.attachments?.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                          {msg.attachments.map((a) => (
                            <button key={a.id} className="mbx-ghost" onClick={() => downloadAttach(a)}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '7px 11px', borderRadius: 8, background: C.field, border: `1px solid ${C.line}`, fontSize: 12.5, color: C.bright, cursor: 'pointer' }}>
                              {S.down}
                              <span style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.filename}</span>
                              <span style={{ color: C.dim }}>{humanSize(a.size || 0)}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{ borderTop: `1px solid ${C.line}`, padding: '14px 24px', flex: '0 0 auto', background: C.bg }}>
              <div style={{ fontSize: 12, color: C.dim, marginBottom: 8 }}>Reply to <b style={{ color: C.bright }}>{open.counterparty}</b></div>
              <textarea value={replyBody} onChange={(e) => setReplyBody(e.target.value)} placeholder="Write a reply…"
                style={{ ...inp, minHeight: 74, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} />
              {replyAtts.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                  {replyAtts.map((a, i) => (
                    <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 8px 6px 11px', borderRadius: 8, background: C.field, border: `1px solid ${C.line}`, fontSize: 12.5, color: C.bright }}>
                      <span style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                      <span style={{ color: C.dim }}>{humanSize(a.size)}</span>
                      <button onClick={() => removeReplyAtt(i)} style={{ background: 'transparent', border: 'none', color: C.dim, cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
                    </span>
                  ))}
                </div>
              )}
              <input ref={replyFileRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => pickReplyFiles(e.target.files)} />
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
                <button className="mbx-ghost" onClick={() => replyFileRef.current?.click()}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 13px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: `1px solid ${C.line}`, background: 'transparent', color: C.dim }}>
                  {S.clip} Attach</button>
                <button className="mbx-btn" onClick={sendThreadReply} disabled={replyBusy || !replyBody.trim()}
                  style={{ padding: '9px 22px', borderRadius: 8, fontSize: 13.5, fontWeight: 700, cursor: 'pointer', border: 'none', background: C.orange, color: C.orangeInk, opacity: replyBusy || !replyBody.trim() ? 0.6 : 1 }}>
                  {replyBusy ? 'Sending…' : 'Send reply'}</button>
              </div>
            </div>

        </div>
      )}

      {/* ===== compose / reply overlay ===== */}
      {compose && (
        <div onClick={() => setCompose(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(6,8,12,.78)', zIndex: 310,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '6vh 16px', overflowY: 'auto' }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 660, background: C.bg,
            border: `1px solid ${C.line}`, borderRadius: 14, boxShadow: '0 24px 64px rgba(0,0,0,.6)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 22px', borderBottom: `1px solid ${C.line}` }}>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{compose.mode === 'reply' ? 'Reply' : 'New message'}</h2>
              <button onClick={() => setCompose(null)} style={{ background: 'transparent', border: 'none', color: C.dim, fontSize: 24, cursor: 'pointer', lineHeight: 1 }}>×</button>
            </div>
            <div style={{ padding: 22 }}>
              {compose.mode === 'new' ? (
                <>
                  <div style={{ marginBottom: 11 }}><input style={inp} placeholder="To (email address)" value={compose.to}
                    onChange={(e) => setCompose((c) => ({ ...c, to: e.target.value }))} /></div>
                  <div style={{ marginBottom: 11 }}><input style={inp} placeholder="Subject" value={compose.subject}
                    onChange={(e) => setCompose((c) => ({ ...c, subject: e.target.value }))} /></div>
                </>
              ) : (
                <div style={{ fontSize: 13.5, color: C.dim, marginBottom: 11 }}>To <b style={{ color: C.bright }}>{compose.to}</b> · {compose.subject}</div>
              )}
              <textarea style={{ ...inp, minHeight: 200, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} placeholder="Write your message…"
                value={compose.body} onChange={(e) => setCompose((c) => ({ ...c, body: e.target.value }))} />

              {(compose.attachments || []).length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                  {compose.attachments.map((a, i) => (
                    <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 8px 6px 11px', borderRadius: 8,
                      background: C.field, border: `1px solid ${C.line}`, fontSize: 12.5, color: C.bright }}>
                      <span style={{ maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                      <span style={{ color: C.dim }}>{humanSize(a.size)}</span>
                      <button onClick={() => removeAttach(i)} style={{ background: 'transparent', border: 'none', color: C.dim, cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
                    </span>
                  ))}
                </div>
              )}
              <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => pickFiles(e.target.files)} />

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, gap: 12, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
                  <button className="mbx-ghost" onClick={() => fileRef.current?.click()}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 13px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: `1px solid ${C.line}`, background: 'transparent', color: C.dim }}>
                    {S.clip} Attach</button>
                  <span style={{ fontSize: 11.5, color: C.snip }}>Sends as bonitocheluget@sparkp2p.com</span>
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button className="mbx-ghost" onClick={() => setCompose(null)}
                    style={{ padding: '9px 16px', borderRadius: 8, fontSize: 13.5, fontWeight: 600, cursor: 'pointer', border: `1px solid ${C.line}`, background: 'transparent', color: C.dim }}>Cancel</button>
                  <button className="mbx-btn" onClick={doSend} disabled={busy || !compose.body?.trim() || (compose.mode === 'new' && !compose.to?.trim())}
                    style={{ padding: '9px 22px', borderRadius: 8, fontSize: 13.5, fontWeight: 700, cursor: 'pointer', border: 'none', background: C.orange, color: C.orangeInk, opacity: busy ? 0.6 : 1 }}>
                    {busy ? 'Sending…' : 'Send'}</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {toast && <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 400,
        background: C.bg, border: `1px solid ${C.line}`, color: C.bright, padding: '11px 22px', borderRadius: 10, fontSize: 14, boxShadow: '0 10px 30px rgba(0,0,0,.5)' }}>{toast}</div>}
    </div>
  );
}
