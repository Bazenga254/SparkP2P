import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import axios from 'axios';
import '@smile_identity/smart-camera-web';

const API = '/api';

export default function KycMobilePage() {
  const { token } = useParams();
  const [loading, setLoading] = useState(true);
  const [trader, setTrader] = useState(null);
  const [err, setErr] = useState('');
  const [step, setStep] = useState('form');
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
        setTrader(r.data);
        if (r.data.phone) {
          const ph = r.data.phone.replace(/^\+254/, '').replace(/^0/, '');
          setForm(f => ({ ...f, mobile: ph }));
        }
        setLoading(false);
      })
      .catch(() => { setErr('This link is invalid or expired.'); setLoading(false); });
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

  const handleFile = async (e, key) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const b64 = await toBase64(file);
    setFiles(f => ({ ...f, [key]: b64 }));
  };

  const handleSubmit = async () => {
    const { firstName, lastName, mobile, idNumber, birthday } = form;
    if (!firstName || !lastName || !mobile || !idNumber || !birthday) {
      setMsg({ t: 'e', text: 'Please fill all required fields.' }); return;
    }
    if (!files.front || !files.back || !files.selfie) {
      setMsg({ t: 'e', text: 'Please upload ID front, ID back, and capture a verified selfie.' }); return;
    }
    setSubmitting(true); setMsg(null);
    try {
      const clean = mobile.replace(/^\+254/, '').replace(/^0/, '').replace(/\s/g, '').slice(-9);
      const res = await axios.post(`${API}/kyc/submit/${token}`, {
        first_name: firstName, last_name: lastName, middle_name: form.middleName,
        mobile: clean, id_number: idNumber, birthday: form.birthday,
        gender: parseInt(form.gender), email: form.email, address: form.address,
        front_photo_b64: files.front, back_photo_b64: files.back, selfie_b64: files.selfie,
      });
      if (res.data.status === 'already_verified') { setStep('done'); return; }
      setRequestId(res.data.onboardingRequestId);
      setStep('otp');
    } catch (e) {
      setMsg({ t: 'e', text: (e.response && e.response.data && e.response.data.detail) || 'Submission failed. Please try again.' });
    } finally { setSubmitting(false); }
  };

  const handleOtp = async () => {
    if (!otp.trim()) { setMsg({ t: 'e', text: 'Please enter the OTP.' }); return; }
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
        } catch (ex) { /* silent */ }
        if (attempts >= 36) { clearInterval(iv); setMsg({ t: 'w', text: 'Still reviewing. Come back in a few minutes.' }); }
      }, 10000);
    } catch (e) {
      setMsg({ t: 'e', text: (e.response && e.response.data && e.response.data.detail) || 'OTP failed.' });
    } finally { setSubmitting(false); }
  };

  const wrap = { minHeight: '100vh', background: '#0d0f1e', padding: '24px 16px 40px', fontFamily: '-apple-system,BlinkMacSystemFont,sans-serif' };
  const card = { background: '#13151f', border: '1px solid #1f2937', borderRadius: 14, padding: 20, marginBottom: 16 };
  const lbl = { color: '#9ca3af', fontSize: 14, display: 'block', marginBottom: 6, fontWeight: 500 };
  const inp = { width: '100%', background: '#0d0f1e', border: '1px solid #374151', borderRadius: 10, color: '#fff', padding: '14px 16px', fontSize: 16, outline: 'none', boxSizing: 'border-box' };
  const btn = { width: '100%', padding: '16px 0', borderRadius: 12, border: 'none', fontWeight: 800, fontSize: 17, cursor: 'pointer' };
  const centerWrap = { ...wrap, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', minHeight: '100vh' };

  const Field = ({ label, fkey, required, type, placeholder }) => (
    <div style={{ marginBottom: 16 }}>
      <label style={lbl}>{label}{required && <span style={{ color: '#ef4444' }}> *</span>}</label>
      <input value={form[fkey]} onChange={e => setForm(f => ({ ...f, [fkey]: e.target.value }))}
        placeholder={placeholder || ''} style={inp} type={type || 'text'} />
    </div>
  );

  const FileField = ({ label, fkey }) => (
    <div style={{ marginBottom: 16 }}>
      <label style={lbl}>{label} <span style={{ color: '#ef4444' }}>*</span></label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderRadius: 10, border: files[fkey] ? '1.5px solid #10b981' : '1.5px solid #374151', background: '#0d0f1e', cursor: 'pointer', color: files[fkey] ? '#10b981' : '#6b7280', fontSize: 15, fontWeight: 500 }}>
        <span style={{ fontSize: 20 }}>{files[fkey] ? '✓' : '📷'}</span>
        {files[fkey] ? 'Uploaded — tap to change' : 'Take photo / Choose file'}
        <input type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={e => handleFile(e, fkey)} />
      </label>
    </div>
  );

  const MsgBox = () => msg ? (
    <div style={{ padding: '12px 16px', borderRadius: 10, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444', fontSize: 14, marginBottom: 16 }}>
      {msg.text}
    </div>
  ) : null;

  if (loading) return <div style={centerWrap}><div style={{ width: 40, height: 40, border: '3px solid rgba(16,185,129,0.3)', borderTop: '3px solid #10b981', borderRadius: '50%', animation: 'spin 1s linear infinite' }} /><style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style></div>;

  if (err) return <div style={centerWrap}><div style={{ fontSize: 40, marginBottom: 12 }}>&#x26A0;</div><div style={{ color: '#ef4444', fontSize: 15, maxWidth: 320 }}>{err}</div></div>;

  if (step === 'done') return (
    <div style={centerWrap}>
      <div style={{ fontSize: 72, marginBottom: 20 }}>&#x2705;</div>
      <div style={{ color: '#10b981', fontSize: 24, fontWeight: 800, marginBottom: 10 }}>Verification Complete!</div>
      <div style={{ color: '#9ca3af', fontSize: 15, maxWidth: 320, lineHeight: 1.6 }}>Your Choice Bank account is linked. Return to SparkP2P on your computer to start trading.</div>
      <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
    </div>
  );

  if (step === 'polling') return (
    <div style={centerWrap}>
      <div style={{ width: 56, height: 56, border: '4px solid rgba(16,185,129,0.2)', borderTop: '4px solid #10b981', borderRadius: '50%', animation: 'spin 1s linear infinite', marginBottom: 24 }} />
      <div style={{ color: '#fff', fontWeight: 800, fontSize: 20, marginBottom: 8 }}>Under Review</div>
      <div style={{ color: '#9ca3af', fontSize: 14, maxWidth: 300, lineHeight: 1.6 }}>Choice Bank is verifying your documents. This page updates automatically.</div>
      {msg && <div style={{ marginTop: 20, color: '#f59e0b', fontSize: 13 }}>{msg.text}</div>}
      <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
    </div>
  );

  if (step === 'otp') return (
    <div style={wrap}>
      <div style={{ marginBottom: 28 }}>
        <div style={{ color: '#fff', fontSize: 22, fontWeight: 800, marginBottom: 6 }}>Enter OTP</div>
        <div style={{ color: '#9ca3af', fontSize: 14 }}>A 6-digit code was sent to your phone. Enter it to continue.</div>
      </div>
      <MsgBox />
      <div style={card}>
        <label style={lbl}>OTP Code</label>
        <input type="tel" maxLength={6} value={otp} onChange={e => setOtp(e.target.value)}
          style={{ ...inp, fontSize: 28, letterSpacing: 12, textAlign: 'center', fontWeight: 800 }} placeholder="------" />
      </div>
      <button onClick={handleOtp} disabled={submitting}
        style={{ ...btn, background: submitting ? '#1f2937' : 'linear-gradient(135deg,#10b981,#059669)', color: submitting ? '#6b7280' : '#fff' }}>
        {submitting ? 'Verifying...' : 'Confirm OTP'}
      </button>
      <style>{'@keyframes spin{to{transform:rotate(360deg)}} *{box-sizing:border-box}'}</style>
    </div>
  );

  return (
    <div style={wrap}>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 28, marginBottom: 8 }}>&#x1F3E6;</div>
        <div style={{ color: '#fff', fontSize: 22, fontWeight: 800, marginBottom: 4 }}>Bank Verification</div>
        <div style={{ color: '#9ca3af', fontSize: 14 }}>Complete your KYC to receive M-Pesa payments via SparkP2P.</div>
      </div>
      <MsgBox />

      <div style={card}>
        <div style={{ color: '#d1d5db', fontWeight: 700, fontSize: 15, marginBottom: 18 }}>Personal Details</div>
        <Field label="First Name" fkey="firstName" required placeholder="e.g. John" />
        <Field label="Last Name" fkey="lastName" required placeholder="e.g. Doe" />
        <Field label="Middle Name" fkey="middleName" placeholder="Optional" />
        <Field label="Phone Number" fkey="mobile" required type="tel" placeholder="07XX XXX XXX" />
        <Field label="National ID Number" fkey="idNumber" required />
        <Field label="Date of Birth" fkey="birthday" required type="date" />
        <div style={{ marginBottom: 16 }}>
          <label style={lbl}>Gender <span style={{ color: '#ef4444' }}>*</span></label>
          <select value={form.gender} onChange={e => setForm(f => ({ ...f, gender: e.target.value }))} style={inp}>
            <option value="1">Male</option>
            <option value="0">Female</option>
          </select>
        </div>
        <Field label="Email" fkey="email" type="email" placeholder="Optional" />
        <Field label="Address" fkey="address" placeholder="Optional" />
      </div>

      <div style={card}>
        <div style={{ color: '#d1d5db', fontWeight: 700, fontSize: 15, marginBottom: 4 }}>KYC Documents</div>
        <div style={{ color: '#6b7280', fontSize: 13, marginBottom: 18 }}>Use your phone camera for clear photos. The selfie must pass a liveness check.</div>
        <FileField label="ID Front" fkey="front" />
        <FileField label="ID Back" fkey="back" />
        <div style={{ marginBottom: 16 }}>
          <label style={lbl}>Live Selfie <span style={{ color: '#ef4444' }}>*</span> <span style={{ color: '#6b7280', fontSize: 12, fontWeight: 400 }}>liveness verified</span></label>
          {files.selfie ? (
            <div onClick={() => { setFiles(f => ({ ...f, selfie: '' })); setSmileOpen(false); }}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderRadius: 10, border: '1.5px solid #10b981', background: '#0d0f1e', cursor: 'pointer', color: '#10b981', fontSize: 15, fontWeight: 500 }}>
              <span style={{ fontSize: 20 }}>&#x2713;</span> Selfie verified — tap to retake
            </div>
          ) : (
            <div>
              <button type="button" onClick={() => setSmileOpen(function(o) { return !o; })}
                style={{ width: '100%', padding: '14px 16px', borderRadius: 10, border: smileOpen ? '1.5px solid #f59e0b' : '1.5px solid #374151', background: '#0d0f1e', cursor: 'pointer', color: smileOpen ? '#f59e0b' : '#6b7280', fontSize: 15, fontWeight: 500, textAlign: 'left', display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 20 }}>&#x1F933;</span>{smileOpen ? 'Close Camera' : 'Open Camera for Selfie'}
              </button>
              {smileOpen && (
                <div style={{ marginTop: 12, borderRadius: 10, overflow: 'hidden' }}>
                  <smart-camera-web ref={smileRef} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <button onClick={handleSubmit} disabled={submitting}
        style={{ ...btn, background: submitting ? '#1f2937' : 'linear-gradient(135deg,#10b981,#059669)', color: submitting ? '#6b7280' : '#fff', marginTop: 8 }}>
        {submitting ? 'Submitting...' : 'Submit for KYC Review'}
      </button>

      <style>{'@keyframes spin{to{transform:rotate(360deg)}} *{box-sizing:border-box} input::placeholder{color:#4b5563}'}</style>
    </div>
  );
}
