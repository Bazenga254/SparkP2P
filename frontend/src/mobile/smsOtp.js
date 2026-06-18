// Native Android SMS Retriever bridge — auto-reads the incoming OTP SMS and hands the 6-digit
// code to the caller, so the login boxes fill themselves. No-op (returns a cleanup fn) on web or
// when the native plugin / Capacitor bridge isn't available, so callers can use it unconditionally.
import { isNative } from './relayAgent';

export function startSmsOtp(onCode) {
  const noop = () => {};
  try {
    if (!isNative()) return noop;
    const SmsOtp = window.Capacitor?.Plugins?.SmsOtp;
    if (!SmsOtp) return noop;

    let handle;
    SmsOtp.addListener('sms', (data) => {
      const text = data && data.message;
      if (!text) return;
      const m = String(text).match(/\d{6}/) || String(text).match(/\d{4,8}/);
      if (m) onCode(m[0].slice(0, 6));
    }).then((h) => { handle = h; });

    SmsOtp.start().catch(() => {});

    return () => {
      try { handle && handle.remove(); } catch (_) {}
      try { SmsOtp.stop(); } catch (_) {}
    };
  } catch (_) {
    return noop;
  }
}
