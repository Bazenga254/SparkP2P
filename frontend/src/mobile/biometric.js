// Wrapper around the native BiometricAuth plugin. Inert in a normal browser (no plugin) so it can
// ship to the web harmlessly. Used to lock the app on open for logged-in traders.
const plugin = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BiometricAuth;

export const bioSupported = () => !!plugin();

export async function bioAvailable() {
  const p = plugin();
  if (!p) return false;
  try { const r = await p.isAvailable(); return !!r.available; } catch (_) { return false; }
}

// Resolves true on success, false on cancel/error. No plugin (web) → resolves true (no-op).
export async function bioAuthenticate(reason) {
  const p = plugin();
  if (!p) return true;
  try { const r = await p.authenticate({ reason: reason || 'Unlock SparkP2P' }); return !!r.success; }
  catch (_) { return false; }
}

// localStorage flags
export const bioEnabled = () => localStorage.getItem('bio_enabled') === '1';
export const setBioEnabled = (on) => localStorage.setItem('bio_enabled', on ? '1' : '0');
export const bioAsked = () => localStorage.getItem('bio_asked') === '1';
export const markBioAsked = () => localStorage.setItem('bio_asked', '1');
