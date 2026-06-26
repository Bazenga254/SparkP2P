// SparkP2P SMS-OTP reader bridge.
//
// Choice Bank transaction OTPs arrive by SMS (email can't be verified). The native SmsReceiver
// catches them and posts them to the backend, which confirms the pending payout. These helpers just
// request the RECEIVE_SMS permission and report its status. Inert on the web.

const plugin = () =>
  (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.ChoiceSms) || null;

export const hasChoiceSms = () => !!plugin();

export async function requestSmsPermission() {
  const p = plugin();
  if (!p) return { ok: false, error: 'not native' };
  try { await p.requestPermission(); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
}

export async function smsPermissionStatus() {
  const p = plugin();
  if (!p) return { granted: false, native: false };
  try { const r = await p.status(); return { granted: !!r.granted, native: true }; }
  catch (_) { return { granted: false, native: true }; }
}
