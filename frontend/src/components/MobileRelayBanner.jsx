import { useState, useEffect } from 'react';
import { isNative, startRelay, stopRelay, onRelayStatus } from '../mobile/relayAgent';

// Mobile-only control to run the trading relay from the phone. Renders nothing in a normal
// browser / on desktop (only active inside the Capacitor native wrapper).
export default function MobileRelayBanner() {
  const [on, setOn] = useState(localStorage.getItem('sparkp2p_relay_on') === '1');
  const [st, setSt] = useState(null);
  useEffect(() => onRelayStatus(setSt), []);
  if (!isNative()) return null;

  const live = on && st && st.lastPoll && (Date.now() - st.lastPoll < 70000);
  const toggle = async () => { const v = !on; setOn(v); if (v) await startRelay(); else await stopRelay(); };

  return (
    <div style={{ background: live ? 'rgba(51,194,122,.1)' : 'rgba(245,166,35,.1)', border: `1px solid ${live ? 'rgba(51,194,122,.3)' : 'rgba(245,166,35,.3)'}`, borderRadius: 12, padding: '12px 14px', margin: '0 0 16px', display: 'flex', alignItems: 'center', gap: 13, fontFamily: 'Inter,system-ui,sans-serif' }}>
      <div onClick={toggle} style={{ width: 46, height: 26, borderRadius: 20, background: on ? '#33C27A' : '#2a313b', position: 'relative', flex: '0 0 auto', cursor: 'pointer', transition: '.2s' }}>
        <span style={{ position: 'absolute', top: 3, left: on ? 23 : 3, width: 20, height: 20, borderRadius: '50%', background: '#fff', transition: '.2s' }} />
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: '#E7E9ED' }}>
          Run trading relay on this phone {on && <span style={{ fontSize: 12, fontWeight: 700, color: live ? '#4FD894' : '#FFBE52' }}>· {live ? '● Online' : '○ connecting…'}</span>}
        </div>
        <div style={{ fontSize: 12, color: '#929AA6', marginTop: 2 }}>
          {on
            ? `Keeping your relay online from your phone's connection${st?.jobs ? ` · ${st.jobs} requests served` : ''}. Keep the app installed; disable battery optimisation for SparkP2P so it stays alive in the background.`
            : 'Turn on to let the bot trade through your phone’s IP — no desktop needed. Works while your phone has internet.'}
        </div>
      </div>
    </div>
  );
}
