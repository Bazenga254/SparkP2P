import { useState, useEffect, useRef } from 'react';
import { isNative, startRelay, stopRelay } from '../mobile/relayAgent';
import { getRelayOnline } from '../services/api';

// Mobile-only relay control. As of the native auto-relay (app v1.1) the relay starts on its own
// whenever the trader is logged in, so this is now mainly a live status + an off switch. Status
// comes from the backend (ground truth) — it reflects the relay whether it was started natively
// or from JS. Renders nothing outside the native app.
export default function MobileRelayBanner() {
  const [on, setOn] = useState(localStorage.getItem('sparkp2p_relay_on') !== '0'); // on by default
  const [online, setOnline] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    if (!isNative()) return;
    const check = async () => { try { const r = await getRelayOnline(); setOnline(!!r.data?.online); } catch (_) {} };
    check();
    timer.current = setInterval(check, 5000);
    return () => clearInterval(timer.current);
  }, []);

  if (!isNative()) return null;

  const toggle = async () => {
    const v = !on;
    setOn(v);
    localStorage.setItem('sparkp2p_relay_on', v ? '1' : '0');
    try { if (v) await startRelay(); else await stopRelay(); } catch (_) {}
  };

  const live = on && online;
  const accent = live ? '#33C27A' : on ? '#FFBE52' : '#6b7280';
  const bg = live ? 'rgba(51,194,122,.1)' : on ? 'rgba(245,166,35,.1)' : 'rgba(255,255,255,.04)';

  return (
    <div style={{ background: bg, border: `1px solid ${accent}55`, borderRadius: 12, padding: '12px 14px', margin: '0 0 16px', display: 'flex', alignItems: 'center', gap: 13, fontFamily: 'Inter,system-ui,sans-serif' }}>
      <div onClick={toggle} style={{ width: 46, height: 26, borderRadius: 20, background: on ? '#33C27A' : '#2a313b', position: 'relative', flex: '0 0 auto', cursor: 'pointer', transition: '.2s' }}>
        <span style={{ position: 'absolute', top: 3, left: on ? 23 : 3, width: 20, height: 20, borderRadius: '50%', background: '#fff', transition: '.2s' }} />
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: '#E7E9ED' }}>
          Run trading relay on this phone
          {on && <span style={{ fontSize: 12, fontWeight: 700, color: accent }}> · {live ? '● Online' : '○ starting…'}</span>}
        </div>
        <div style={{ fontSize: 12, color: '#929AA6', marginTop: 2 }}>
          {on
            ? 'The bot trades through your phone’s connection. It runs automatically while you’re logged in — keep the app installed and battery optimisation off.'
            : 'Off — turn on to let the bot trade through your phone’s connection (no desktop needed).'}
        </div>
      </div>
    </div>
  );
}
