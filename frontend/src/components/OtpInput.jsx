import { useRef } from 'react';

/**
 * Segmented OTP input — one box per digit (Co-op / banking style).
 * Autofill-friendly: the first box carries autocomplete="one-time-code", and when the OS (or a
 * paste of the whole SMS) dumps text in, we pull out the contiguous N-digit code with /\d{N}/
 * instead of concatenating every digit in the message, then spread it across the boxes.
 */
export default function OtpInput({ value = '', onChange, length = 6 }) {
  const refs = useRef([]);
  const digits = value.split('');

  const focus = (i) => {
    const el = refs.current[Math.max(0, Math.min(i, length - 1))];
    if (el) { el.focus(); el.select && el.select(); }
  };

  // Pull the OTP out of arbitrary text (a full SMS, an autofill dump, a paste): prefer a
  // contiguous run of exactly `length` digits — NOT every digit in the message (which would mix
  // in timestamps / phone numbers). Fall back to the longest digit run.
  const extract = (text) => {
    const t = text || '';
    const m = t.match(new RegExp(`\\d{${length}}`)) || t.match(/\d{2,}/);
    return m ? m[0].slice(0, length) : t.replace(/\D/g, '').slice(0, length);
  };

  const applyFull = (raw) => {
    const code = extract(raw);
    if (!code) return;
    onChange(code);
    focus(code.length);
  };

  const handleChange = (i, e) => {
    const v = e.target.value;
    if (v.length > 1) { applyFull(v); return; }   // autofill / paste dumped a multi-char value
    const arr = value.split('').slice(0, length);
    arr[i] = v.replace(/\D/g, '');
    onChange(arr.join('').slice(0, length));
    if (arr[i]) focus(i + 1);
  };

  const handleKeyDown = (i, e) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      const arr = value.split('').slice(0, length);
      if (arr[i]) { arr[i] = ''; onChange(arr.join('')); }
      else if (i > 0) { arr[i - 1] = ''; onChange(arr.join('')); focus(i - 1); }
    } else if (e.key === 'ArrowLeft') focus(i - 1);
    else if (e.key === 'ArrowRight') focus(i + 1);
  };

  const handlePaste = (e) => {
    e.preventDefault();
    applyFull(e.clipboardData.getData('text') || '');
  };

  return (
    <div className="otp-boxes">
      {Array.from({ length }).map((_, i) => (
        <input
          key={i}
          ref={(el) => (refs.current[i] = el)}
          className="otp-box"
          type="text"
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={i === 0 ? length : 1}
          value={digits[i] || ''}
          onChange={(e) => handleChange(i, e)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onPaste={handlePaste}
          autoFocus={i === 0}
          aria-label={`OTP digit ${i + 1}`}
        />
      ))}
    </div>
  );
}
