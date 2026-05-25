import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import axios from 'axios';
import '@smile_identity/smart-camera-web';

const API = '/api';
const STEPS = ['personal', 'contact', 'id-front', 'id-back', 'selfie', 'otp', 'polling', 'done'];
const PROGRESS_STEPS = ['personal', 'contact', 'id-front', 'id-back', 'selfie'];

export default function KycMobilePage() {
  const { token } = useParams();
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
  }, [token]);

  useEffect(() => {
    const cam = smileRef.current;
    if (!cam) return;
    const onCapture = (e) => {
      const imgs = ((e.detail) || {}).images || [];
      if (imgs[0] && imgs[0].image) {
        setFiles(f => ({ ...f, selfie: imgs[0].image }));
        setSmileOpen(false);
      }
    };
    cam.addEventListener('imagesComputed', onCapture);
    return () => cam.removeEventListener('imagesComputed', onCapture);
  }, [smileOpen]);

  const toBase64 = (file) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result.split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });

  const handleFile = async (e, key, autoAdvance) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const b64 = await toBase64(file);
    setFiles(f => ({ ...f, [key]: b64 }));
    if (autoAdvance) setTimeout(() => setStep(autoAdvance), 400);
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

  // Styles
  const wrap = { minHeight: '100vh', background: '#0d0f1e', padding: '0 0 48px', fontFamily: '-apple-system,BlinkMacSystemFont,sans-serif' };
  const header = { background: '#13151f', borderBottom: '1px solid #1f2937', padding: '16px 20px 0' };
  const body = { padding: '24px 20px 0' };
  const lbl = { color: '#9ca3af', fontSize: 14, display: 'block', marginBottom: 8, fontWeight: 500 };
  const inp = { width: '100%', background: '#0d0f1e', border: '1px solid #374151', borderRadius: 12, color: '#fff', padding: '15px 16px', fontSize: 16, outline: 'none', boxSizing: 'border-box', marginBottom: 20 };
  const nextBtn = (disabled) => ({ width: '100%', padding: '16px 0', borderRadius: 12, border: 'none', fontWeight: 800, fontSize: 17, cursor: disabled ? 'not-allowed' : 'pointer', background: disabled ? '#1f2937' : 'linear-gradient(135deg,#10b981,#059669)', color: disabled ? '#6b7280' : '#fff', marginTop: 8 });
  const centerWrap = { ...wrap, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 32 };

  // Progress bar (only for steps 1-5)
  const progressIdx = PROGRESS_STEPS.indexOf(step);
  const ProgressBar = () => progressIdx >= 0 ? (
    <div style={{ padding: '12px 20px 16px' }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        {PROGRESS_STEPS.map((s, i) => (
          <div key={s} style={{ flex: 1, height: 4, borderRadius: 4, background: i <= progressIdx ? '#10b981' : '#1f2937', transition: 'background 0.3s' }} />
        ))}
      </div>
      <div style={{ color: '#6b7280', fontSize: 12 }}>Step {progressIdx + 1} of {PROGRESS_STEPS.length}</div>
    </div>
  ) : null;

  const MsgBox = () => msg ? (
    <div style={{ padding: '12px 16px', borderRadius: 10, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444', fontSize: 14, marginBottom: 20 }}>
      {msg.text}
    </div>
  ) : null;

  const StepTitle = ({ icon, title, sub }) => (
    <div style={{ marginBottom: 28 }}>
      {icon && <div style={{ fontSize: 32, marginBottom: 10 }}>{icon}</div>}
      <div style={{ color: '#fff', fontSize: 22, fontWeight: 800, marginBottom: 6 }}>{title}</div>
      {sub && <div style={{ color: '#9ca3af', fontSize: 14, lineHeight: 1.6 }}>{sub}</div>}
    </div>
  );

  const Field = ({ label, fkey, required, type, placeholder }) => (
    <div>
      <label style={lbl}>{label}{required && <span style={{ color: '#ef4444' }}> *</span>}</label>
      <input value={form[fkey]} onChange={e => setForm(f => ({ ...f, [fkey]: e.target.value }))}
        placeholder={placeholder || ''} style={inp} type={type || 'text'} />
    </div>
  );

  if (loading) return (
    <div style={centerWrap}>
      <div style={{ width: 40, height: 40, border: '3px solid rgba(16,185,129,0.3)', borderTop: '3px solid #10b981', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
      <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
    </div>
  );

  if (err) return (
    <div style={centerWrap}>
      <div style={{ fontSize: 44, marginBottom: 16 }}>&#x26A0;</div>
      <div style={{ color: '#ef4444', fontSize: 15, maxWidth: 320, lineHeight: 1.7 }}>{err}</div>
      <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
    </div>
  );

  if (step === 'done') return (
    <div style={centerWrap}>
      <div style={{ fontSize: 80, marginBottom: 20 }}>&#x2705;</div>
      <div style={{ color: '#10b981', fontSize: 26, fontWeight: 800, marginBottom: 10 }}>Verification Complete!</div>
      <div style={{ color: '#9ca3af', fontSize: 15, maxWidth: 300, lineHeight: 1.7 }}>Your Choice Bank account is now linked. Return to SparkP2P on your computer to start trading.</div>
      <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
    </div>
  );

  if (step === 'polling') return (
    <div style={centerWrap}>
      <div style={{ width: 60, height: 60, border: '5px solid rgba(16,185,129,0.2)', borderTop: '5px solid #10b981', borderRadius: '50%', animation: 'spin 1s linear infinite', marginBottom: 28 }} />
      <div style={{ color: '#fff', fontWeight: 800, fontSize: 22, marginBottom: 10 }}>Under Review</div>
      <div style={{ color: '#9ca3af', fontSize: 15, maxWidth: 300, lineHeight: 1.7 }}>Choice Bank is reviewing your documents. This usually takes 2–5 minutes. This page will update automatically.</div>
      {msg && <div style={{ marginTop: 20, color: '#f59e0b', fontSize: 13 }}>{msg.text}</div>}
      <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
    </div>
  );

  if (step === 'otp') return (
    <div style={wrap}>
      <div style={header}>
        <div style={{ color: '#fff', fontSize: 18, fontWeight: 800, paddingBottom: 16 }}>Enter OTP</div>
      </div>
      <div style={body}>
        <StepTitle icon="📱" title="Confirm your phone" sub="Enter the 6-digit code sent to your registered phone number." />
        <MsgBox />
        <label style={lbl}>OTP Code</label>
        <input type="tel" maxLength={6} value={otp} onChange={e => setOtp(e.target.value)}
          style={{ ...inp, fontSize: 30, letterSpacing: 14, textAlign: 'center', fontWeight: 800 }} placeholder="------" />
        <button onClick={handleOtp} disabled={submitting} style={nextBtn(submitting)}>
          {submitting ? 'Verifying...' : 'Confirm OTP'}
        </button>
      </div>
      <style>{'@keyframes spin{to{transform:rotate(360deg)}} *{box-sizing:border-box}'}</style>
    </div>
  );

  // ── Step: Personal Info ────────────────────────────────────────────────────
  if (step === 'personal') {
    const ok = form.firstName && form.lastName && form.birthday;
    return (
      <div style={wrap}>
        <div style={header}>
          <ProgressBar />
        </div>
        <div style={body}>
          <StepTitle icon="👤" title="Your Name & Birthday" sub="Enter your details exactly as they appear on your National ID." />
          <Field label="First Name" fkey="firstName" required placeholder="e.g. John" />
          <Field label="Middle Name" fkey="middleName" placeholder="Optional" />
          <Field label="Last Name" fkey="lastName" required placeholder="e.g. Doe" />
          <Field label="Date of Birth" fkey="birthday" required type="date" />
          <button onClick={() => { if (!ok) { setMsg({ text: 'Please fill First Name, Last Name, and Date of Birth.' }); return; } setMsg(null); setStep('contact'); }} style={nextBtn(!ok)}>
            Continue →
          </button>
          <MsgBox />
        </div>
        <style>{'*{box-sizing:border-box} input::placeholder{color:#4b5563}'}</style>
      </div>
    );
  }

  // ── Step: Contact & ID ────────────────────────────────────────────────────
  if (step === 'contact') {
    const ok = form.mobile && form.idNumber;
    return (
      <div style={wrap}>
        <div style={header}><ProgressBar /></div>
        <div style={body}>
          <button onClick={() => setStep('personal')} style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: 14, cursor: 'pointer', padding: '0 0 16px', display: 'flex', alignItems: 'center', gap: 6 }}>
            ← Back
          </button>
          <StepTitle icon="🪪" title="ID & Contact Info" sub="We need this to create your Choice Bank sub-account." />
          <Field label="Phone Number" fkey="mobile" required type="tel" placeholder="07XX XXX XXX" />
          <Field label="National ID Number" fkey="idNumber" required />
          <div>
            <label style={lbl}>Gender <span style={{ color: '#ef4444' }}>*</span></label>
            <select value={form.gender} onChange={e => setForm(f => ({ ...f, gender: e.target.value }))} style={{ ...inp }}>
              <option value="1">Male</option>
              <option value="0">Female</option>
            </select>
          </div>
          <Field label="Email" fkey="email" type="email" placeholder="Optional" />
          <Field label="Address" fkey="address" placeholder="Optional" />
          <button onClick={() => { if (!ok) { setMsg({ text: 'Please enter your phone number and ID number.' }); return; } setMsg(null); setStep('id-front'); }} style={nextBtn(!ok)}>
            Continue →
          </button>
          <MsgBox />
        </div>
        <style>{'*{box-sizing:border-box} input::placeholder{color:#4b5563} select option{background:#0d0f1e}'}</style>
      </div>
    );
  }

  // ── Step: ID Front ────────────────────────────────────────────────────────
  if (step === 'id-front') return (
    <div style={wrap}>
      <div style={header}><ProgressBar /></div>
      <div style={body}>
        <button onClick={() => setStep('contact')} style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: 14, cursor: 'pointer', padding: '0 0 16px', display: 'flex', alignItems: 'center', gap: 6 }}>← Back</button>
        <StepTitle icon="📸" title="ID Front Photo" sub="Take a clear photo of the FRONT side of your National ID. Make sure all text is visible and not blurry." />
        {files.front ? (
          <div>
            <div style={{ borderRadius: 12, overflow: 'hidden', marginBottom: 20, border: '2px solid #10b981' }}>
              <img src={`data:image/jpeg;base64,${files.front}`} alt="ID Front" style={{ width: '100%', display: 'block' }} />
            </div>
            <button onClick={() => setFiles(f => ({ ...f, front: '' }))} style={{ width: '100%', padding: '13px 0', borderRadius: 12, border: '1px solid #374151', background: 'transparent', color: '#9ca3af', fontWeight: 600, fontSize: 15, cursor: 'pointer', marginBottom: 12 }}>
              Retake Photo
            </button>
            <button onClick={() => setStep('id-back')} style={nextBtn(false)}>Looks Good — Continue →</button>
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

  // ── Step: ID Back ─────────────────────────────────────────────────────────
  if (step === 'id-back') return (
    <div style={wrap}>
      <div style={header}><ProgressBar /></div>
      <div style={body}>
        <button onClick={() => setStep('id-front')} style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: 14, cursor: 'pointer', padding: '0 0 16px', display: 'flex', alignItems: 'center', gap: 6 }}>← Back</button>
        <StepTitle icon="🔄" title="ID Back Photo" sub="Now take a clear photo of the BACK side of your National ID." />
        {files.back ? (
          <div>
            <div style={{ borderRadius: 12, overflow: 'hidden', marginBottom: 20, border: '2px solid #10b981' }}>
              <img src={`data:image/jpeg;base64,${files.back}`} alt="ID Back" style={{ width: '100%', display: 'block' }} />
            </div>
            <button onClick={() => setFiles(f => ({ ...f, back: '' }))} style={{ width: '100%', padding: '13px 0', borderRadius: 12, border: '1px solid #374151', background: 'transparent', color: '#9ca3af', fontWeight: 600, fontSize: 15, cursor: 'pointer', marginBottom: 12 }}>
              Retake Photo
            </button>
            <button onClick={() => setStep('selfie')} style={nextBtn(false)}>Looks Good — Continue →</button>
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

  // ── Step: Selfie / Liveness ───────────────────────────────────────────────
  if (step === 'selfie') return (
    <div style={wrap}>
      <div style={header}><ProgressBar /></div>
      <div style={body}>
        <button onClick={() => setStep('id-back')} style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: 14, cursor: 'pointer', padding: '0 0 16px', display: 'flex', alignItems: 'center', gap: 6 }}>← Back</button>
        <StepTitle icon="🤳" title="Live Selfie" sub="Look directly at the camera. The liveness check confirms you are a real person." />
        <MsgBox />
        {files.selfie ? (
          <div>
            <div style={{ borderRadius: 12, overflow: 'hidden', marginBottom: 20, border: '2px solid #10b981' }}>
              <img src={`data:image/jpeg;base64,${files.selfie}`} alt="Selfie" style={{ width: '100%', display: 'block' }} />
            </div>
            <button onClick={() => { setFiles(f => ({ ...f, selfie: '' })); setSmileOpen(false); }} style={{ width: '100%', padding: '13px 0', borderRadius: 12, border: '1px solid #374151', background: 'transparent', color: '#9ca3af', fontWeight: 600, fontSize: 15, cursor: 'pointer', marginBottom: 12 }}>
              Retake Selfie
            </button>
            <button onClick={submitKyc} disabled={submitting} style={nextBtn(submitting)}>
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
