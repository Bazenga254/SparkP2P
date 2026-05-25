import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import axios from 'axios';
import '@smile_identity/smart-camera-web';

const API = '/api';
const PROGRESS_STEPS = ['personal', 'contact', 'id-front', 'id-back', 'selfie'];

// Compress image to max 1280px wide, 80% JPEG quality — reduces 5MB photo to ~300KB
function compressImage(file, maxW = 1280, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxW / img.width);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(blob => {
        if (!blob) { reject(new Error('Canvas toBlob failed')); return; }
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      }, 'image/jpeg', quality);
    };
    img.onerror = reject;
    img.src = url;
  });
}

// ─── Styles (module-level so they never change between renders) ───────────────
const S = {
  wrap:   { minHeight: '100vh', background: '#0d0f1e', padding: '0 0 48px', fontFamily: '-apple-system,BlinkMacSystemFont,sans-serif' },
  header: { background: '#13151f', borderBottom: '1px solid #1f2937', padding: '16px 20px 0' },
  body:   { padding: '24px 20px 0' },
  lbl:    { color: '#9ca3af', fontSize: 14, display: 'block', marginBottom: 8, fontWeight: 500 },
  inp:    { width: '100%', background: '#0d0f1e', border: '1px solid #374151', borderRadius: 12, color: '#fff', padding: '15px 16px', fontSize: 16, outline: 'none', boxSizing: 'border-box', marginBottom: 20 },
  nextBtn:(disabled) => ({ width: '100%', padding: '16px 0', borderRadius: 12, border: 'none', fontWeight: 800, fontSize: 17, cursor: disabled ? 'not-allowed' : 'pointer', background: disabled ? '#1f2937' : 'linear-gradient(135deg,#10b981,#059669)', color: disabled ? '#6b7280' : '#fff', marginTop: 8 }),
  center: { minHeight: '100vh', background: '#0d0f1e', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 32, fontFamily: '-apple-system,BlinkMacSystemFont,sans-serif' },
  back:   { background: 'none', border: 'none', color: '#6b7280', fontSize: 14, cursor: 'pointer', padding: '0 0 16px', display: 'flex', alignItems: 'center', gap: 6 },
};

// ─── Field — defined OUTSIDE the page component so React never remounts it ───
// If Field is defined inside KycMobilePage, React treats it as a new component
// type on every render, unmounting the <input> and losing keyboard focus.
function Field({ value, onChange, label, required, type, placeholder }) {
  return (
    <div>
      <label style={S.lbl}>{label}{required && <span style={{ color: '#ef4444' }}> *</span>}</label>
      <input
        value={value}
        onChange={onChange}
        placeholder={placeholder || ''}
        style={S.inp}
        type={type || 'text'}
        autoComplete="off"
      />
    </div>
  );
}

// ─── Device detection ─────────────────────────────────────────────────────────
function getDeviceType() {
  const ua = navigator.userAgent;
  const hasTouch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
  const w = window.screen.width;

  // iPad — modern iOS reports as "Macintosh" in desktop mode but has touch points
  if (/iPad/i.test(ua)) return 'tablet';
  if (/Mac/i.test(ua) && hasTouch && w >= 768) return 'tablet';

  // Android tablet — has Android but no "Mobile" keyword
  if (/Android/i.test(ua) && !/Mobile/i.test(ua)) return 'tablet';

  // No touch = desktop
  if (!hasTouch) return 'desktop';

  // Large touch screen = tablet (e.g. some Android tablets do report "Mobile")
  if (w >= 768) return 'tablet';

  return 'mobile';
}

// ─── Wrong-device screens ─────────────────────────────────────────────────────
function DesktopBlock({ url }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2500); };
  return (
    <div style={S.center}>
      <div style={{ fontSize: 52, marginBottom: 16 }}>📱</div>
      <div style={{ color: '#fff', fontSize: 22, fontWeight: 800, marginBottom: 10 }}>Open on Your Phone</div>
      <div style={{ color: '#9ca3af', fontSize: 14, maxWidth: 340, lineHeight: 1.7, marginBottom: 28 }}>
        KYC verification must be completed on a <strong style={{ color: '#f59e0b' }}>mobile phone</strong>. Your phone camera is needed for ID photos and the liveness check.
      </div>
      <div style={{ background: '#fff', borderRadius: 16, padding: 20, marginBottom: 20 }}>
        <QRCodeSVG value={url} size={180} />
      </div>
      <div style={{ color: '#6b7280', fontSize: 13, marginBottom: 16 }}>— or copy the link —</div>
      <div style={{ display: 'flex', gap: 10, width: '100%', maxWidth: 400 }}>
        <div style={{ flex: 1, background: '#13151f', border: '1px solid #1f2937', borderRadius: 10, padding: '10px 14px', color: '#6b7280', fontSize: 12, fontFamily: 'monospace', wordBreak: 'break-all', textAlign: 'left' }}>{url}</div>
        <button onClick={copy} style={{ flexShrink: 0, padding: '10px 16px', borderRadius: 10, border: 'none', background: copied ? '#10b981' : '#374151', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
          {copied ? '✓' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

function TabletBlock() {
  return (
    <div style={S.center}>
      <div style={{ fontSize: 52, marginBottom: 16 }}>🚫</div>
      <div style={{ color: '#fff', fontSize: 22, fontWeight: 800, marginBottom: 10 }}>Mobile Phone Required</div>
      <div style={{ color: '#9ca3af', fontSize: 14, maxWidth: 340, lineHeight: 1.7 }}>
        KYC verification must be completed on a <strong style={{ color: '#f59e0b' }}>mobile phone</strong>, not a tablet. Please open this link on your phone to continue.
      </div>
    </div>
  );
}

// ─── Progress bar ─────────────────────────────────────────────────────────────
function ProgressBar({ step }) {
  const idx = PROGRESS_STEPS.indexOf(step);
  if (idx < 0) return null;
  return (
    <div style={{ padding: '12px 20px 16px' }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        {PROGRESS_STEPS.map((s, i) => (
          <div key={s} style={{ flex: 1, height: 4, borderRadius: 4, background: i <= idx ? '#10b981' : '#1f2937', transition: 'background 0.3s' }} />
        ))}
      </div>
      <div style={{ color: '#6b7280', fontSize: 12 }}>Step {idx + 1} of {PROGRESS_STEPS.length}</div>
    </div>
  );
}

function StepTitle({ icon, title, sub }) {
  return (
    <div style={{ marginBottom: 28 }}>
      {icon && <div style={{ fontSize: 32, marginBottom: 10 }}>{icon}</div>}
      <div style={{ color: '#fff', fontSize: 22, fontWeight: 800, marginBottom: 6 }}>{title}</div>
      {sub && <div style={{ color: '#9ca3af', fontSize: 14, lineHeight: 1.6 }}>{sub}</div>}
    </div>
  );
}

function MsgBox({ msg }) {
  if (!msg) return null;
  return (
    <div style={{ padding: '12px 16px', borderRadius: 10, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444', fontSize: 14, marginBottom: 20 }}>
      {msg.text}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function KycMobilePage() {
  const { token } = useParams();
  const [device] = useState(() => getDeviceType());
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [step, setStep] = useState('personal');
  const [form, setForm] = useState({ firstName: '', lastName: '', middleName: '', mobile: '', idNumber: '', birthday: '', gender: '1', email: '', address: '' });
  const [files, setFiles] = useState({ front: '', back: '', selfie: '' });
  const [smileOpen, setSmileOpen] = useState(false);
  const smileRef = useRef(null);
  const [requestId, setRequestId] = useState('');
  const [otp, setOtp] = useState('');
  const [msg, setMsg] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // Skip API call if device is wrong — just show block screen
    if (device !== 'mobile') { setLoading(false); return; }
    axios.get(`${API}/kyc/validate/${token}`)
      .then(r => {
        if (r.data.verified) { setStep('done'); setLoading(false); return; }
        if (r.data.phone) {
          const ph = r.data.phone.replace(/^\+254/, '').replace(/^0/, '');
          setForm(f => ({ ...f, mobile: ph }));
        }
        setLoading(false);
      })
      .catch(() => { setErr('This link is invalid or has expired. Please request a new one from the SparkP2P app.'); setLoading(false); });
  }, [token, device]);

  useEffect(() => {
    const cam = smileRef.current;
    if (!cam) return;
    const onCapture = (e) => {
      const imgs = ((e.detail) || {}).images || [];
      if (imgs[0] && imgs[0].image) { setFiles(f => ({ ...f, selfie: imgs[0].image })); setSmileOpen(false); }
    };
    cam.addEventListener('imagesComputed', onCapture);
    return () => cam.removeEventListener('imagesComputed', onCapture);
  }, [smileOpen]);

  const handleFile = async (e, key, next) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const b64 = await compressImage(file);
      setFiles(f => ({ ...f, [key]: b64 }));
      if (next) setTimeout(() => setStep(next), 400);
    } catch {
      // Fallback: read as-is if compression fails
      const reader = new FileReader();
      reader.onload = ev => { setFiles(f => ({ ...f, [key]: ev.target.result.split(',')[1] })); if (next) setTimeout(() => setStep(next), 400); };
      reader.readAsDataURL(file);
    }
  };

  const submitKyc = async () => {
    setSubmitting(true); setMsg(null);
    try {
      const clean = form.mobile.replace(/^\+254/, '').replace(/^0/, '').replace(/\s/g, '').slice(-9);
      const res = await axios.post(`${API}/kyc/submit/${token}`, {
        first_name: form.firstName, last_name: form.lastName, middle_name: form.middleName,
        mobile: clean, id_number: form.idNumber, birthday: form.birthday,
        gender: parseInt(form.gender), email: form.email, address: form.address,
        front_photo_b64: files.front, back_photo_b64: files.back, selfie_b64: files.selfie,
      });
      if (res.data.status === 'already_verified') { setStep('done'); return; }
      setRequestId(res.data.onboardingRequestId);
      setStep('otp');
    } catch (e) {
      setMsg({ text: (e.response && e.response.data && e.response.data.detail) || 'Submission failed. Please try again.' });
    } finally { setSubmitting(false); }
  };

  const handleOtp = async () => {
    if (!otp.trim()) { setMsg({ text: 'Please enter the OTP.' }); return; }
    setSubmitting(true); setMsg(null);
    try {
      await axios.post(`${API}/kyc/otp/${token}`, { onboarding_request_id: requestId, otp: otp.trim() });
      setStep('polling');
      let attempts = 0;
      const iv = setInterval(async () => {
        attempts++;
        try {
          const r = await axios.get(`${API}/kyc/poll/${token}/${requestId}`);
          const st = r.data.status;
          if (st === 3 || st === 7 || st === '3' || st === '7') { clearInterval(iv); setStep('done'); }
        } catch (ex) {}
        if (attempts >= 36) { clearInterval(iv); setMsg({ text: 'Still reviewing. This page will update when done.' }); }
      }, 10000);
    } catch (e) {
      setMsg({ text: (e.response && e.response.data && e.response.data.detail) || 'OTP failed. Please try again.' });
    } finally { setSubmitting(false); }
  };

  const setField = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }));

  // ── Wrong device blocks ────────────────────────────────────────────────────
  if (device === 'desktop') return <DesktopBlock url={window.location.href} />;
  if (device === 'tablet')  return <TabletBlock />;

  if (loading) return (
    <div style={S.center}>
      <div style={{ width: 40, height: 40, border: '3px solid rgba(16,185,129,0.3)', borderTop: '3px solid #10b981', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
      <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
    </div>
  );

  if (err) return (
    <div style={S.center}>
      <div style={{ fontSize: 44, marginBottom: 16 }}>&#x26A0;</div>
      <div style={{ color: '#ef4444', fontSize: 15, maxWidth: 320, lineHeight: 1.7 }}>{err}</div>
    </div>
  );

  if (step === 'done') return (
    <div style={S.center}>
      <div style={{ fontSize: 80, marginBottom: 20 }}>&#x2705;</div>
      <div style={{ color: '#10b981', fontSize: 26, fontWeight: 800, marginBottom: 10 }}>Verification Complete!</div>
      <div style={{ color: '#9ca3af', fontSize: 15, maxWidth: 300, lineHeight: 1.7 }}>Your Choice Bank account is now linked. Return to SparkP2P on your computer to start trading.</div>
    </div>
  );

  if (step === 'polling') return (
    <div style={S.center}>
      <div style={{ width: 60, height: 60, border: '5px solid rgba(16,185,129,0.2)', borderTop: '5px solid #10b981', borderRadius: '50%', animation: 'spin 1s linear infinite', marginBottom: 28 }} />
      <div style={{ color: '#fff', fontWeight: 800, fontSize: 22, marginBottom: 10 }}>Under Review</div>
      <div style={{ color: '#9ca3af', fontSize: 15, maxWidth: 300, lineHeight: 1.7 }}>Choice Bank is reviewing your documents. This usually takes 2–5 minutes. This page updates automatically.</div>
      {msg && <div style={{ marginTop: 20, color: '#f59e0b', fontSize: 13 }}>{msg.text}</div>}
      <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
    </div>
  );

  if (step === 'otp') return (
    <div style={S.wrap}>
      <div style={S.header}><div style={{ color: '#fff', fontSize: 18, fontWeight: 800, paddingBottom: 16 }}>Enter OTP</div></div>
      <div style={S.body}>
        <StepTitle icon="📱" title="Confirm your phone" sub="Enter the 6-digit code sent to your registered phone number." />
        <MsgBox msg={msg} />
        <label style={S.lbl}>OTP Code</label>
        <input type="tel" maxLength={6} value={otp} onChange={e => setOtp(e.target.value)}
          style={{ ...S.inp, fontSize: 30, letterSpacing: 14, textAlign: 'center', fontWeight: 800 }} placeholder="------" />
        <button onClick={handleOtp} disabled={submitting} style={S.nextBtn(submitting)}>
          {submitting ? 'Verifying...' : 'Confirm OTP'}
        </button>
      </div>
      <style>{'@keyframes spin{to{transform:rotate(360deg)}} *{box-sizing:border-box}'}</style>
    </div>
  );

  // ── Step 1: Personal ───────────────────────────────────────────────────────
  if (step === 'personal') {
    const ok = form.firstName && form.lastName && form.birthday;
    return (
      <div style={S.wrap}>
        <div style={S.header}><ProgressBar step={step} /></div>
        <div style={S.body}>
          <StepTitle icon="👤" title="Your Name & Birthday" sub="Enter your details exactly as they appear on your National ID." />
          <Field label="First Name" value={form.firstName} onChange={setField('firstName')} required placeholder="e.g. John" />
          <Field label="Middle Name" value={form.middleName} onChange={setField('middleName')} placeholder="Optional" />
          <Field label="Last Name" value={form.lastName} onChange={setField('lastName')} required placeholder="e.g. Doe" />
          <Field label="Date of Birth" value={form.birthday} onChange={setField('birthday')} required type="date" />
          <MsgBox msg={msg} />
          <button onClick={() => { if (!ok) { setMsg({ text: 'Please fill First Name, Last Name, and Date of Birth.' }); return; } setMsg(null); setStep('contact'); }} style={S.nextBtn(!ok)}>
            Continue →
          </button>
        </div>
        <style>{'*{box-sizing:border-box} input::placeholder{color:#4b5563}'}</style>
      </div>
    );
  }

  // ── Step 2: Contact & ID ───────────────────────────────────────────────────
  if (step === 'contact') {
    const ok = form.mobile && form.idNumber;
    return (
      <div style={S.wrap}>
        <div style={S.header}><ProgressBar step={step} /></div>
        <div style={S.body}>
          <button onClick={() => setStep('personal')} style={S.back}>← Back</button>
          <StepTitle icon="🪪" title="ID & Contact Info" sub="We need this to create your Choice Bank sub-account." />
          <Field label="Phone Number" value={form.mobile} onChange={setField('mobile')} required type="tel" placeholder="07XX XXX XXX" />
          <Field label="National ID Number" value={form.idNumber} onChange={setField('idNumber')} required />
          <div>
            <label style={S.lbl}>Gender <span style={{ color: '#ef4444' }}>*</span></label>
            <select value={form.gender} onChange={setField('gender')} style={{ ...S.inp }}>
              <option value="1">Male</option>
              <option value="0">Female</option>
            </select>
          </div>
          <Field label="Email" value={form.email} onChange={setField('email')} type="email" placeholder="Optional" />
          <Field label="Address" value={form.address} onChange={setField('address')} placeholder="Optional" />
          <MsgBox msg={msg} />
          <button onClick={() => { if (!ok) { setMsg({ text: 'Please enter your phone number and ID number.' }); return; } setMsg(null); setStep('id-front'); }} style={S.nextBtn(!ok)}>
            Continue →
          </button>
        </div>
        <style>{'*{box-sizing:border-box} input::placeholder{color:#4b5563} select option{background:#0d0f1e}'}</style>
      </div>
    );
  }

  // ── Step 3: ID Front ───────────────────────────────────────────────────────
  if (step === 'id-front') return (
    <div style={S.wrap}>
      <div style={S.header}><ProgressBar step={step} /></div>
      <div style={S.body}>
        <button onClick={() => setStep('contact')} style={S.back}>← Back</button>
        <StepTitle icon="📸" title="ID Front Photo" sub="Take a clear photo of the FRONT side of your National ID. Make sure all text is visible and in focus." />
        {files.front ? (
          <div>
            <div style={{ borderRadius: 12, overflow: 'hidden', marginBottom: 20, border: '2px solid #10b981' }}>
              <img src={`data:image/jpeg;base64,${files.front}`} alt="ID Front" style={{ width: '100%', display: 'block' }} />
            </div>
            <button onClick={() => setFiles(f => ({ ...f, front: '' }))} style={{ width: '100%', padding: '13px 0', borderRadius: 12, border: '1px solid #374151', background: 'transparent', color: '#9ca3af', fontWeight: 600, fontSize: 15, cursor: 'pointer', marginBottom: 12 }}>
              Retake Photo
            </button>
            <button onClick={() => setStep('id-back')} style={S.nextBtn(false)}>Looks Good — Continue →</button>
          </div>
        ) : (
          <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: '48px 24px', borderRadius: 16, border: '2px dashed #374151', background: '#13151f', cursor: 'pointer', textAlign: 'center' }}>
            <span style={{ fontSize: 52 }}>📷</span>
            <span style={{ color: '#d1d5db', fontWeight: 700, fontSize: 17 }}>Tap to take photo</span>
            <span style={{ color: '#6b7280', fontSize: 13 }}>Opens your camera</span>
            <input type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={e => handleFile(e, 'front', null)} />
          </label>
        )}
      </div>
      <style>{'*{box-sizing:border-box}'}</style>
    </div>
  );

  // ── Step 4: ID Back ────────────────────────────────────────────────────────
  if (step === 'id-back') return (
    <div style={S.wrap}>
      <div style={S.header}><ProgressBar step={step} /></div>
      <div style={S.body}>
        <button onClick={() => setStep('id-front')} style={S.back}>← Back</button>
        <StepTitle icon="🔄" title="ID Back Photo" sub="Now take a clear photo of the BACK side of your National ID." />
        {files.back ? (
          <div>
            <div style={{ borderRadius: 12, overflow: 'hidden', marginBottom: 20, border: '2px solid #10b981' }}>
              <img src={`data:image/jpeg;base64,${files.back}`} alt="ID Back" style={{ width: '100%', display: 'block' }} />
            </div>
            <button onClick={() => setFiles(f => ({ ...f, back: '' }))} style={{ width: '100%', padding: '13px 0', borderRadius: 12, border: '1px solid #374151', background: 'transparent', color: '#9ca3af', fontWeight: 600, fontSize: 15, cursor: 'pointer', marginBottom: 12 }}>
              Retake Photo
            </button>
            <button onClick={() => setStep('selfie')} style={S.nextBtn(false)}>Looks Good — Continue →</button>
          </div>
        ) : (
          <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: '48px 24px', borderRadius: 16, border: '2px dashed #374151', background: '#13151f', cursor: 'pointer', textAlign: 'center' }}>
            <span style={{ fontSize: 52 }}>📷</span>
            <span style={{ color: '#d1d5db', fontWeight: 700, fontSize: 17 }}>Tap to take photo</span>
            <span style={{ color: '#6b7280', fontSize: 13 }}>Back of your National ID</span>
            <input type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={e => handleFile(e, 'back', null)} />
          </label>
        )}
      </div>
      <style>{'*{box-sizing:border-box}'}</style>
    </div>
  );

  // ── Step 5: Selfie / Liveness ──────────────────────────────────────────────
  if (step === 'selfie') return (
    <div style={S.wrap}>
      <div style={S.header}><ProgressBar step={step} /></div>
      <div style={S.body}>
        <button onClick={() => setStep('id-back')} style={S.back}>← Back</button>
        <StepTitle icon="🤳" title="Live Selfie" sub="Look directly at the camera. The liveness check confirms you are a real person." />
        <MsgBox msg={msg} />
        {files.selfie ? (
          <div>
            <div style={{ borderRadius: 12, overflow: 'hidden', marginBottom: 20, border: '2px solid #10b981' }}>
              <img src={`data:image/jpeg;base64,${files.selfie}`} alt="Selfie" style={{ width: '100%', display: 'block' }} />
            </div>
            <button onClick={() => { setFiles(f => ({ ...f, selfie: '' })); setSmileOpen(false); }} style={{ width: '100%', padding: '13px 0', borderRadius: 12, border: '1px solid #374151', background: 'transparent', color: '#9ca3af', fontWeight: 600, fontSize: 15, cursor: 'pointer', marginBottom: 12 }}>
              Retake Selfie
            </button>
            <button onClick={submitKyc} disabled={submitting} style={S.nextBtn(submitting)}>
              {submitting ? 'Submitting...' : 'Submit for KYC Review'}
            </button>
          </div>
        ) : (
          <div>
            <button type="button" onClick={() => setSmileOpen(o => !o)}
              style={{ width: '100%', padding: '48px 24px', borderRadius: 16, border: smileOpen ? '2px solid #f59e0b' : '2px dashed #374151', background: '#13151f', cursor: 'pointer', color: smileOpen ? '#f59e0b' : '#6b7280', fontSize: 16, fontWeight: 600, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 52 }}>&#x1F933;</span>
              {smileOpen ? 'Close Camera' : 'Open Camera for Selfie'}
            </button>
            {smileOpen && (
              <div style={{ marginTop: 16, borderRadius: 12, overflow: 'hidden' }}>
                <smart-camera-web ref={smileRef} />
              </div>
            )}
          </div>
        )}
      </div>
      <style>{'*{box-sizing:border-box}'}</style>
    </div>
  );

  return null;
}
