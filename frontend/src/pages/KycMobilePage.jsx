import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import axios from 'axios';
import '@smile_identity/smart-camera-web';

const API = '/api';
const PROGRESS_STEPS = ['personal', 'contact', 'financial', 'kra-cert', 'id-front', 'id-back', 'selfie'];

function compressImage(file, maxPx = 1280, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      // Limit LONGEST side so portrait selfies don't exceed maxPx either
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
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

function Field({ value, onChange, label, required, type, placeholder }) {
  return (
    <div>
      <label style={S.lbl}>{label}{required && <span style={{ color: '#ef4444' }}> *</span>}</label>
      <input value={value} onChange={onChange} placeholder={placeholder || ''} style={S.inp} type={type || 'text'} autoComplete="off" />
    </div>
  );
}

function SelectField({ value, onChange, label, required, options }) {
  return (
    <div>
      <label style={S.lbl}>{label}{required && <span style={{ color: '#ef4444' }}> *</span>}</label>
      <select value={value} onChange={onChange} style={{ ...S.inp }}>
        <option value="">&#8212; Select &#8212;</option>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function getDeviceType() {
  const ua = navigator.userAgent;
  const hasTouch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
  const w = window.screen.width;
  if (/iPad/i.test(ua)) return 'tablet';
  if (/Mac/i.test(ua) && hasTouch && w >= 768) return 'tablet';
  if (/Android/i.test(ua) && !/Mobile/i.test(ua)) return 'tablet';
  if (!hasTouch) return 'desktop';
  if (w >= 768) return 'tablet';
  return 'mobile';
}

function DesktopBlock({ url }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2500); };
  return (
    <div style={S.center}>
      <div style={{ fontSize: 52, marginBottom: 16 }}>&#128241;</div>
      <div style={{ color: '#fff', fontSize: 22, fontWeight: 800, marginBottom: 10 }}>Open on Your Phone</div>
      <div style={{ color: '#9ca3af', fontSize: 14, maxWidth: 340, lineHeight: 1.7, marginBottom: 28 }}>
        KYC verification must be completed on a <strong style={{ color: '#f59e0b' }}>mobile phone</strong>. Your phone camera is needed for ID photos and the liveness check.
      </div>
      <div style={{ background: '#fff', borderRadius: 16, padding: 20, marginBottom: 20 }}>
        <QRCodeSVG value={url} size={180} />
      </div>
      <div style={{ color: '#6b7280', fontSize: 13, marginBottom: 16 }}>&#8212; or copy the link &#8212;</div>
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
      <div style={{ fontSize: 52, marginBottom: 16 }}>&#128683;</div>
      <div style={{ color: '#fff', fontSize: 22, fontWeight: 800, marginBottom: 10 }}>Mobile Phone Required</div>
      <div style={{ color: '#9ca3af', fontSize: 14, maxWidth: 340, lineHeight: 1.7 }}>
        KYC verification must be completed on a <strong style={{ color: '#f59e0b' }}>mobile phone</strong>, not a tablet. Please open this link on your phone to continue.
      </div>
    </div>
  );
}

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

const EMPLOYMENT_OPTIONS = [
  { value: 'A', label: 'Employee' },
  { value: 'B', label: 'Self-Employed' },
  { value: 'C', label: 'Unemployed' },
  { value: 'D', label: 'Employer' },
  { value: 'E', label: 'Student' },
  { value: 'F', label: 'Other' },
];

const INCOME_OPTIONS = [
  { value: 'A', label: 'Less than KES 14,999' },
  { value: 'B', label: 'KES 15,000 – 24,999' },
  { value: 'C', label: 'KES 25,000 – 39,999' },
  { value: 'D', label: 'KES 40,000 – 59,999' },
  { value: 'E', label: 'KES 60,000 – 84,999' },
  { value: 'F', label: 'Above KES 85,000' },
];

export default function KycMobilePage() {
  const { token } = useParams();
  const [device] = useState(() => getDeviceType());
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [step, setStep] = useState('personal');
  const [form, setForm] = useState({
    firstName: '', lastName: '', middleName: '',
    mobile: '', idNumber: '', birthday: '', gender: '1', email: '',
    address: '', kraPin: '', employmentStatus: '', monthlyIncome: '',
  });
  const [files, setFiles] = useState({ front: '', back: '', selfie: '', kra: '' });
  const [kraContentType, setKraContentType] = useState('image'); // 'image' or 'pdf'
  const [requestId, setRequestId] = useState('');
  const [otp, setOtp] = useState('');
  const [msg, setMsg] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [rejectionMsg, setRejectionMsg] = useState('');
  const [uploadError, setUploadError] = useState('');
  const pollingRef = useRef(null);

  useEffect(() => {
    if (device !== 'mobile') { setLoading(false); return; }
    axios.get(`${API}/kyc/validate/${token}`)
      .then(r => {
        if (r.data.verified) { setStep('done'); setLoading(false); return; }
        const ks = r.data.kyc_status || '';
        // Staging flow: our admin pre-validation layer
        if (ks.startsWith('staging:') || ks.startsWith('rejected_admin:')) {
          const sub = r.data.submission_status;
          if (sub === 'otp_pending' && r.data.pending_onboarding_id) {
            // Admin approved — OTP sent, show OTP input
            setRequestId(r.data.pending_onboarding_id);
            setStep('otp');
          } else if (sub === 'submitted' && r.data.pending_onboarding_id) {
            // Images uploaded, waiting for Choice Bank decision
            setRequestId(r.data.pending_onboarding_id);
            setStep('polling');
          } else if (sub === 'rejected') {
            setRejectionMsg(r.data.admin_notes || 'Your submission requires corrections. Please fix and resubmit.');
            setStep('rejected_admin');
          } else {
            // pending_review or unknown — waiting for admin
            setStep('pending_review');
          }
          setLoading(false);
          return;
        }
        if (r.data.pending_onboarding_id) {
          // Already submitted directly to Choice Bank — go straight to polling
          setRequestId(r.data.pending_onboarding_id);
          setStep('polling');
          setLoading(false);
          return;
        }
        if (r.data.phone) {
          const ph = r.data.phone.replace(/^\+254/, '').replace(/^0/, '');
          setForm(f => ({ ...f, mobile: ph }));
        }
        setLoading(false);
      })
      .catch(() => { setErr('This link is invalid or has expired. Please request a new one from the SparkP2P app.'); setLoading(false); });
  }, [token, device]);

  // Auto-poll whenever we land on the polling step (from OTP confirm or from validate)
  useEffect(() => {
    if (step !== 'polling' || !requestId) return;
    if (pollingRef.current) return; // already polling
    let attempts = 0;
    pollingRef.current = setInterval(async () => {
      attempts++;
      try {
        const r = await axios.get(`${API}/kyc/poll/${token}/${requestId}`);
        const st = parseInt(r.data.status) || 0;
        if (st === 3) { clearInterval(pollingRef.current); pollingRef.current = null; setStep('done'); }
        else if (st === 4) {
          clearInterval(pollingRef.current); pollingRef.current = null;
          setRejectionMsg(r.data.rejectionReasonMsg || 'Your application was not approved.');
          setStep('rejected');
        }
      } catch (err) {
        // Token expired (400) — stop polling and tell the user to reopen the link
        if (err.response && err.response.status === 400) {
          clearInterval(pollingRef.current); pollingRef.current = null;
          setMsg({ text: 'Session expired. Please re-open the KYC link from the SparkP2P app to check your status.' });
        }
      }
      if (attempts >= 72) { clearInterval(pollingRef.current); pollingRef.current = null; setMsg({ text: 'Still reviewing. Check back later — re-open the KYC link from SparkP2P to see the latest status.' }); }
    }, 10000);
    return () => { if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; } };
  }, [step, requestId, token]);

  const handleFile = async (e, key) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const isPdf = file.type === 'application/pdf';
    if (key === 'kra') setKraContentType(isPdf ? 'pdf' : 'image');
    if (isPdf) {
      const reader = new FileReader();
      reader.onload = ev => setFiles(f => ({ ...f, [key]: ev.target.result.split(',')[1] }));
      reader.readAsDataURL(file);
      return;
    }
    try {
      const b64 = await compressImage(file);
      setFiles(f => ({ ...f, [key]: b64 }));
    } catch {
      // canvas failed — retry at half resolution before falling back to raw file
      try {
        const b64 = await compressImage(file, 640, 0.6);
        setFiles(f => ({ ...f, [key]: b64 }));
      } catch {
        const reader = new FileReader();
        reader.onload = ev => setFiles(f => ({ ...f, [key]: ev.target.result.split(',')[1] }));
        reader.readAsDataURL(file);
      }
    }
  };

  const submitKyc = async () => {
    setSubmitting(true); setMsg(null);
    try {
      const clean = form.mobile.replace(/^\+254/, '').replace(/^0/, '').replace(/\s/g, '').slice(-9);
      const res = await axios.post(`${API}/kyc/submit/${token}`, {
        first_name: form.firstName,
        last_name: form.lastName,
        middle_name: form.middleName,
        mobile: clean,
        id_number: form.idNumber,
        birthday: form.birthday,
        gender: parseInt(form.gender),
        email: form.email,
        address: form.address,
        kra_pin: form.kraPin,
        employment_status: form.employmentStatus,
        monthly_income: form.monthlyIncome,
        front_photo_b64: files.front || '',
        back_photo_b64: files.back || '',
        selfie_b64: files.selfie || '',
        kra_cert_b64: files.kra || '',
        kra_cert_content_type: kraContentType,
      });
      if (res.data.status === 'already_verified') { setStep('done'); return; }
      // Staging: saved to our DB for admin review
      if (res.data.status === 'pending_review') { setStep('pending_review'); return; }
      // Legacy (non-staging): OTP sent immediately
      setRequestId(res.data.onboardingRequestId);
      setStep('otp');
    } catch (e) {
      setMsg({ text: (e.response && e.response.data && e.response.data.detail) || 'Submission failed. Please try again.' });
    } finally { setSubmitting(false); }
  };

  const handleOtp = async () => {
    if (!otp.trim()) { setMsg({ text: 'Please enter the code from your email.' }); return; }
    setSubmitting(true); setMsg(null);
    try {
      const r = await axios.post(`${API}/kyc/otp/${token}`, { onboarding_request_id: requestId, otp: otp.trim() });
      if (r.data.status === 'submitted') {
        // Staged path: images already uploaded from DB — go straight to polling
        setRequestId(r.data.onboarding_id || requestId);
        setStep('polling');
      } else {
        // Legacy path: frontend uploads docs next
        setStep('uploading');
      }
    } catch (e) {
      setMsg({ text: (e.response && e.response.data && e.response.data.detail) || 'Verification failed. Please try again.' });
    } finally { setSubmitting(false); }
  };

  // Called automatically when landing on 'uploading', and also on manual retry
  const doUpload = async () => {
    setSubmitting(true); setUploadError('');
    try {
      // Guard: if any image exceeds 1.5 MB as base64, re-compress before sending
      const compress = async (b64, key) => {
        if (!b64 || b64.length <= 1.5 * 1024 * 1024) return b64;
        // Recreate blob from b64 then compress further
        const byteArr = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const blob = new Blob([byteArr], { type: 'image/jpeg' });
        const file = new File([blob], key + '.jpg', { type: 'image/jpeg' });
        try { return await compressImage(file, 800, 0.55); } catch { return b64; }
      };
      const front = await compress(files.front, 'front');
      const back  = await compress(files.back,  'back');
      const selfie = await compress(files.selfie, 'selfie');
      await axios.post(`${API}/kyc/upload-docs/${token}`, {
        onboarding_request_id: requestId,
        front_photo_b64: front,
        back_photo_b64: back,
        selfie_b64: selfie,
      });
      setStep('polling');
    } catch (e) {
      setUploadError((e.response && e.response.data && e.response.data.detail) || 'Upload failed — please tap Retry.');
    } finally { setSubmitting(false); }
  };

  // Auto-trigger upload when entering the uploading step
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (step === 'uploading' && !uploadError) doUpload(); }, [step]);

  const setField = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }));

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
      <div style={{ fontSize: 44, marginBottom: 16 }}>&#9888;</div>
      <div style={{ color: '#ef4444', fontSize: 15, maxWidth: 320, lineHeight: 1.7 }}>{err}</div>
    </div>
  );

  if (step === 'done') return (
    <div style={S.center}>
      <div style={{ fontSize: 80, marginBottom: 20 }}>&#9989;</div>
      <div style={{ color: '#10b981', fontSize: 26, fontWeight: 800, marginBottom: 10 }}>Verification Complete!</div>
      <div style={{ color: '#9ca3af', fontSize: 15, maxWidth: 300, lineHeight: 1.7 }}>Your Choice Bank account is now linked. Return to SparkP2P on your computer to start trading.</div>
    </div>
  );

  if (step === 'rejected') return (
    <div style={S.center}>
      <div style={{ fontSize: 64, marginBottom: 20 }}>&#10060;</div>
      <div style={{ color: '#ef4444', fontSize: 22, fontWeight: 800, marginBottom: 12 }}>Verification Not Approved</div>
      <div style={{ color: '#9ca3af', fontSize: 15, maxWidth: 320, lineHeight: 1.7, marginBottom: 24 }}>
        {rejectionMsg || 'Your KYC application was not approved by Choice Bank.'}
      </div>
      <div style={{ color: '#6b7280', fontSize: 13, maxWidth: 300, lineHeight: 1.6 }}>
        Please contact SparkP2P support for assistance, or request a new verification link to try again.
      </div>
    </div>
  );

  // Admin rejected our staging submission — show reason + fix button
  if (step === 'rejected_admin') return (
    <div style={S.center}>
      <div style={{ fontSize: 64, marginBottom: 20 }}>&#10060;</div>
      <div style={{ color: '#ef4444', fontSize: 22, fontWeight: 800, marginBottom: 12 }}>Submission Needs Correction</div>
      <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 12, padding: '16px 20px', maxWidth: 320, marginBottom: 24, textAlign: 'left' }}>
        <div style={{ color: '#f87171', fontSize: 12, fontWeight: 600, marginBottom: 8 }}>REQUIRED ACTION</div>
        <div style={{ color: '#fca5a5', fontSize: 14, lineHeight: 1.7 }}>{rejectionMsg}</div>
      </div>
      <div style={{ color: '#9ca3af', fontSize: 13, maxWidth: 300, lineHeight: 1.6, marginBottom: 28 }}>
        Please correct the issues above and resubmit your information for review.
      </div>
      <button onClick={() => { setRejectionMsg(''); setStep('personal'); }}
        style={{ padding: '14px 32px', borderRadius: 12, border: 'none', background: 'linear-gradient(135deg,#10b981,#059669)', color: '#fff', fontWeight: 800, fontSize: 16, cursor: 'pointer' }}>
        Fix &amp; Resubmit
      </button>
    </div>
  );

  // Submitted to our staging DB, waiting for admin review
  if (step === 'pending_review') return (
    <div style={S.center}>
      <div style={{ width: 60, height: 60, border: '5px solid rgba(245,158,11,0.2)', borderTop: '5px solid #f59e0b', borderRadius: '50%', animation: 'spin 1.5s linear infinite', marginBottom: 28 }} />
      <div style={{ color: '#fff', fontWeight: 800, fontSize: 22, marginBottom: 10 }}>Submission Under Review</div>
      <div style={{ color: '#9ca3af', fontSize: 15, maxWidth: 300, lineHeight: 1.7, marginBottom: 20 }}>
        Your documents have been submitted to the SparkP2P team for verification. We will review them and notify you by email once approved.
      </div>
      <div style={{ color: '#6b7280', fontSize: 13, maxWidth: 280, lineHeight: 1.6 }}>
        This usually takes 1–2 business days. You can close this page — we will email you when it is ready.
      </div>
      <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
    </div>
  );

  if (step === 'uploading') return (
    <div style={S.center}>
      {!uploadError ? (
        <>
          <div style={{ width: 60, height: 60, border: '5px solid rgba(16,185,129,0.2)', borderTop: '5px solid #10b981', borderRadius: '50%', animation: 'spin 1s linear infinite', marginBottom: 28 }} />
          <div style={{ color: '#fff', fontWeight: 800, fontSize: 22, marginBottom: 10 }}>Uploading Documents</div>
          <div style={{ color: '#9ca3af', fontSize: 15, maxWidth: 300, lineHeight: 1.7 }}>Sending your ID photos to Choice Bank. Please keep this page open…</div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 52, marginBottom: 16 }}>&#9888;&#65039;</div>
          <div style={{ color: '#ef4444', fontSize: 18, fontWeight: 800, marginBottom: 12 }}>Upload Failed</div>
          <div style={{ color: '#9ca3af', fontSize: 14, maxWidth: 300, lineHeight: 1.7, marginBottom: 24 }}>{uploadError}</div>
          <button onClick={() => { setUploadError(''); doUpload(); }} disabled={submitting}
            style={{ padding: '14px 32px', borderRadius: 12, border: 'none', background: 'linear-gradient(135deg,#10b981,#059669)', color: '#fff', fontWeight: 800, fontSize: 16, cursor: 'pointer' }}>
            {submitting ? 'Retrying…' : 'Retry Upload'}
          </button>
        </>
      )}
      <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
    </div>
  );

  if (step === 'polling') return (
    <div style={S.center}>
      <div style={{ width: 60, height: 60, border: '5px solid rgba(16,185,129,0.2)', borderTop: '5px solid #10b981', borderRadius: '50%', animation: 'spin 1s linear infinite', marginBottom: 28 }} />
      <div style={{ color: '#fff', fontWeight: 800, fontSize: 22, marginBottom: 10 }}>Under Review</div>
      <div style={{ color: '#9ca3af', fontSize: 15, maxWidth: 300, lineHeight: 1.7 }}>Choice Bank is reviewing your documents. This usually takes 2 to 5 minutes. This page updates automatically.</div>
      {msg && <div style={{ marginTop: 20, color: '#f59e0b', fontSize: 13 }}>{msg.text}</div>}
      <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
    </div>
  );

  if (step === 'otp') return (
    <div style={S.wrap}>
      <div style={S.header}><div style={{ color: '#fff', fontSize: 18, fontWeight: 800, paddingBottom: 16 }}>Enter OTP</div></div>
      <div style={S.body}>
        <StepTitle icon="&#9993;" title="Enter Verification Code" sub="Choice Bank sent you a code by EMAIL and by SMS. Check both — email may be in your spam/junk folder. Enter the 4-digit code below." />
        <MsgBox msg={msg} />
        <label style={S.lbl}>Verification Code</label>
        <input type="tel" maxLength={6} value={otp} onChange={e => setOtp(e.target.value)}
          style={{ ...S.inp, fontSize: 30, letterSpacing: 14, textAlign: 'center', fontWeight: 800 }} placeholder="------" />
        <button onClick={handleOtp} disabled={submitting} style={S.nextBtn(submitting)}>
          {submitting ? 'Verifying...' : 'Confirm OTP'}
        </button>
        <button onClick={async () => {
          if (!requestId) return;
          setMsg({ text: 'Resending...', color: '#f59e0b' });
          try {
            await axios.post(`${API}/kyc/resend-otp/${token}`, { onboarding_request_id: requestId });
            setMsg({ text: 'Code resent to your email AND SMS. Check both, including your spam folder.' });
          } catch { setMsg({ text: 'Could not resend. Please wait a moment and try again.' }); }
        }} disabled={submitting} style={{ marginTop: 12, background: 'none', border: 'none', color: '#6b7280', fontSize: 13, cursor: 'pointer', textDecoration: 'underline' }}>
          Didn't get the code? Resend
        </button>
      </div>
      <style>{'@keyframes spin{to{transform:rotate(360deg)}} *{box-sizing:border-box}'}</style>
    </div>
  );

  // Step 1: Personal
  if (step === 'personal') {
    const ok = form.firstName && form.lastName && form.birthday;
    return (
      <div style={S.wrap}>
        <div style={S.header}><ProgressBar step={step} /></div>
        <div style={S.body}>
          <StepTitle icon="&#128100;" title="Your Name & Birthday" sub="Enter your details exactly as they appear on your National ID." />
          <Field label="First Name" value={form.firstName} onChange={setField('firstName')} required placeholder="e.g. John" />
          <Field label="Middle Name" value={form.middleName} onChange={setField('middleName')} placeholder="Optional" />
          <Field label="Last Name" value={form.lastName} onChange={setField('lastName')} required placeholder="e.g. Doe" />
          <Field label="Date of Birth" value={form.birthday} onChange={setField('birthday')} required type="date" />
          <MsgBox msg={msg} />
          <button onClick={() => { if (!ok) { setMsg({ text: 'Please fill First Name, Last Name, and Date of Birth.' }); return; } setMsg(null); setStep('contact'); }} style={S.nextBtn(!ok)}>
            Continue &#8594;
          </button>
        </div>
        <style>{'*{box-sizing:border-box} input::placeholder{color:#4b5563}'}</style>
      </div>
    );
  }

  // Step 2: Contact & ID
  if (step === 'contact') {
    const ok = form.mobile && form.idNumber && form.address && form.email && /^\S+@\S+\.\S+$/.test(form.email);
    return (
      <div style={S.wrap}>
        <div style={S.header}><ProgressBar step={step} /></div>
        <div style={S.body}>
          <button onClick={() => setStep('personal')} style={S.back}>&#8592; Back</button>
          <StepTitle icon="&#128219;" title="ID & Contact Info" sub="We need this to create your Choice Bank account." />
          <Field label="Phone Number" value={form.mobile} onChange={setField('mobile')} required type="tel" placeholder="07XX XXX XXX" />
          <Field label="National ID Number" value={form.idNumber} onChange={setField('idNumber')} required />
          <SelectField label="Gender" value={form.gender} onChange={setField('gender')} required
            options={[{ value: '1', label: 'Male' }, { value: '0', label: 'Female' }]} />
          <Field label="Email Address" value={form.email} onChange={setField('email')} required type="email" placeholder="Same email as your Binance account" />
          <div style={{ color: '#9ca3af', fontSize: 11.5, marginTop: -8, marginBottom: 12, lineHeight: 1.5 }}>
            ⚠️ Use the <strong>same email as your Binance account</strong> — Choice sends transaction OTPs here, and the bot reads them to automate your payouts.
          </div>
          <Field label="Physical Address" value={form.address} onChange={setField('address')} required placeholder="e.g. Westlands, Nairobi" />
          <MsgBox msg={msg} />
          <button onClick={() => { if (!ok) { setMsg({ text: 'Please fill Phone, ID Number, a valid Email, and Physical Address.' }); return; } setMsg(null); setStep('financial'); }} style={S.nextBtn(!ok)}>
            Continue &#8594;
          </button>
        </div>
        <style>{'*{box-sizing:border-box} input::placeholder{color:#4b5563} select option{background:#0d0f1e}'}</style>
      </div>
    );
  }

  // Step 3: Financial Info
  if (step === 'financial') {
    const ok = form.kraPin && form.employmentStatus && form.monthlyIncome;
    return (
      <div style={S.wrap}>
        <div style={S.header}><ProgressBar step={step} /></div>
        <div style={S.body}>
          <button onClick={() => setStep('contact')} style={S.back}>&#8592; Back</button>
          <StepTitle icon="&#128188;" title="Financial Details" sub="Required by Choice Bank for account compliance." />
          <Field label="KRA PIN" value={form.kraPin} onChange={setField('kraPin')} required placeholder="e.g. A012345678B" />
          <SelectField label="Employment Status" value={form.employmentStatus} onChange={setField('employmentStatus')} required options={EMPLOYMENT_OPTIONS} />
          <SelectField label="Monthly Income" value={form.monthlyIncome} onChange={setField('monthlyIncome')} required options={INCOME_OPTIONS} />
          <MsgBox msg={msg} />
          <button onClick={() => { if (!ok) { setMsg({ text: 'Please fill KRA PIN, Employment Status, and Monthly Income.' }); return; } setMsg(null); setStep('kra-cert'); }} style={S.nextBtn(!ok)}>
            Continue &#8594;
          </button>
        </div>
        <style>{'*{box-sizing:border-box} input::placeholder{color:#4b5563} select option{background:#0d0f1e}'}</style>
      </div>
    );
  }

  // Step 4: KRA PIN Certificate
  if (step === 'kra-cert') return (
    <div style={S.wrap}>
      <div style={S.header}><ProgressBar step={step} /></div>
      <div style={S.body}>
        <button onClick={() => setStep('financial')} style={S.back}>&#8592; Back</button>
        <StepTitle icon="&#128196;" title="KRA PIN Certificate" sub="Upload your Kenya Revenue Authority (KRA) PIN certificate. You can upload a PDF (downloaded from iTax) or take a photo of the printed certificate." />
        {files.kra ? (
          <div>
            {kraContentType === 'pdf' ? (
              <div style={{ borderRadius: 12, padding: '20px 16px', marginBottom: 20, border: '2px solid #10b981', background: '#13151f', display: 'flex', alignItems: 'center', gap: 14 }}>
                <span style={{ fontSize: 36 }}>&#128196;</span>
                <div>
                  <div style={{ color: '#10b981', fontWeight: 700, fontSize: 15 }}>PDF uploaded</div>
                  <div style={{ color: '#6b7280', fontSize: 13, marginTop: 2 }}>KRA PIN certificate ready</div>
                </div>
              </div>
            ) : (
              <div style={{ borderRadius: 12, overflow: 'hidden', marginBottom: 20, border: '2px solid #10b981' }}>
                <img src={`data:image/jpeg;base64,${files.kra}`} alt="KRA Certificate" style={{ width: '100%', display: 'block' }} />
              </div>
            )}
            <button onClick={() => { setFiles(f => ({ ...f, kra: '' })); setKraContentType('image'); }} style={{ width: '100%', padding: '13px 0', borderRadius: 12, border: '1px solid #374151', background: 'transparent', color: '#9ca3af', fontWeight: 600, fontSize: 15, cursor: 'pointer', marginBottom: 12 }}>
              Upload Different File
            </button>
            <button onClick={() => setStep('id-front')} style={S.nextBtn(false)}>Looks Good &#8212; Continue &#8594;</button>
          </div>
        ) : (
          <div>
            <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: '36px 24px', borderRadius: 16, border: '2px dashed #374151', background: '#13151f', cursor: 'pointer', textAlign: 'center', marginBottom: 16 }}>
              <span style={{ fontSize: 48 }}>&#128196;</span>
              <span style={{ color: '#d1d5db', fontWeight: 700, fontSize: 17 }}>Upload PDF or Photo</span>
              <span style={{ color: '#6b7280', fontSize: 13, lineHeight: 1.5 }}>PDF from iTax recommended&#10;or photograph the printed certificate</span>
              <input type="file" accept="image/*,application/pdf" style={{ display: 'none' }} onChange={e => handleFile(e, 'kra')} />
            </label>
          </div>
        )}
      </div>
      <style>{'*{box-sizing:border-box}'}</style>
    </div>
  );

  // Step 5: ID Front
  if (step === 'id-front') return (
    <div style={S.wrap}>
      <div style={S.header}><ProgressBar step={step} /></div>
      <div style={S.body}>
        <button onClick={() => setStep('kra-cert')} style={S.back}>&#8592; Back</button>
        <StepTitle icon="&#128248;" title="ID Front Photo" sub="Take a clear photo of the FRONT side of your National ID. Make sure all text is visible and in focus." />
        {files.front ? (
          <div>
            <div style={{ borderRadius: 12, overflow: 'hidden', marginBottom: 20, border: '2px solid #10b981' }}>
              <img src={`data:image/jpeg;base64,${files.front}`} alt="ID Front" style={{ width: '100%', display: 'block' }} />
            </div>
            <button onClick={() => setFiles(f => ({ ...f, front: '' }))} style={{ width: '100%', padding: '13px 0', borderRadius: 12, border: '1px solid #374151', background: 'transparent', color: '#9ca3af', fontWeight: 600, fontSize: 15, cursor: 'pointer', marginBottom: 12 }}>
              Retake Photo
            </button>
            <button onClick={() => setStep('id-back')} style={S.nextBtn(false)}>Looks Good &#8212; Continue &#8594;</button>
          </div>
        ) : (
          <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: '48px 24px', borderRadius: 16, border: '2px dashed #374151', background: '#13151f', cursor: 'pointer', textAlign: 'center' }}>
            <span style={{ fontSize: 52 }}>&#128247;</span>
            <span style={{ color: '#d1d5db', fontWeight: 700, fontSize: 17 }}>Tap to take photo</span>
            <span style={{ color: '#6b7280', fontSize: 13 }}>Opens your camera</span>
            <input type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={e => handleFile(e, 'front')} />
          </label>
        )}
      </div>
      <style>{'*{box-sizing:border-box}'}</style>
    </div>
  );

  // Step 6: ID Back
  if (step === 'id-back') return (
    <div style={S.wrap}>
      <div style={S.header}><ProgressBar step={step} /></div>
      <div style={S.body}>
        <button onClick={() => setStep('id-front')} style={S.back}>&#8592; Back</button>
        <StepTitle icon="&#128260;" title="ID Back Photo" sub="Now take a clear photo of the BACK side of your National ID." />
        {files.back ? (
          <div>
            <div style={{ borderRadius: 12, overflow: 'hidden', marginBottom: 20, border: '2px solid #10b981' }}>
              <img src={`data:image/jpeg;base64,${files.back}`} alt="ID Back" style={{ width: '100%', display: 'block' }} />
            </div>
            <button onClick={() => setFiles(f => ({ ...f, back: '' }))} style={{ width: '100%', padding: '13px 0', borderRadius: 12, border: '1px solid #374151', background: 'transparent', color: '#9ca3af', fontWeight: 600, fontSize: 15, cursor: 'pointer', marginBottom: 12 }}>
              Retake Photo
            </button>
            <button onClick={() => setStep('selfie')} style={S.nextBtn(false)}>Looks Good &#8212; Continue &#8594;</button>
          </div>
        ) : (
          <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: '48px 24px', borderRadius: 16, border: '2px dashed #374151', background: '#13151f', cursor: 'pointer', textAlign: 'center' }}>
            <span style={{ fontSize: 52 }}>&#128247;</span>
            <span style={{ color: '#d1d5db', fontWeight: 700, fontSize: 17 }}>Tap to take photo</span>
            <span style={{ color: '#6b7280', fontSize: 13 }}>Back of your National ID</span>
            <input type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={e => handleFile(e, 'back')} />
          </label>
        )}
      </div>
      <style>{'*{box-sizing:border-box}'}</style>
    </div>
  );

  // Step 7: Selfie — Smile ID liveness check (same SDK that approved Benson & Bonito)
  const smileRef = useRef(null);
  useEffect(() => {
    if (step !== 'selfie') return;
    const cam = smileRef.current;
    if (!cam) return;
    const onCapture = (e) => {
      const imgs = ((e.detail) || {}).images || [];
      const img = imgs[0];
      if (img && img.image) {
        // strip data URI prefix if present
        const b64 = img.image.replace(/^data:image\/[^;]+;base64,/, '');
        setFiles(f => ({ ...f, selfie: b64 }));
      }
    };
    cam.addEventListener('imagesComputed', onCapture);
    return () => cam.removeEventListener('imagesComputed', onCapture);
  }, [step]);

  if (step === 'selfie') return (
    <div style={S.wrap}>
      <div style={S.header}><ProgressBar step={step} /></div>
      <div style={S.body}>
        <button onClick={() => setStep('id-back')} style={S.back}>&#8592; Back</button>
        <StepTitle icon="&#129331;" title="Liveness Check" sub="Complete the face scan below. Look directly at the camera and follow the on-screen prompts." />
        <MsgBox msg={msg} />
        {files.selfie ? (
          <div>
            <div style={{ borderRadius: 12, overflow: 'hidden', marginBottom: 20, border: '2px solid #10b981' }}>
              <img src={`data:image/jpeg;base64,${files.selfie}`} alt="Selfie" style={{ width: '100%', display: 'block' }} />
            </div>
            <button onClick={() => setFiles(f => ({ ...f, selfie: '' }))} style={{ width: '100%', padding: '13px 0', borderRadius: 12, border: '1px solid #374151', background: 'transparent', color: '#9ca3af', fontWeight: 600, fontSize: 15, cursor: 'pointer', marginBottom: 12 }}>
              Redo Liveness Check
            </button>
            <button onClick={submitKyc} disabled={submitting} style={S.nextBtn(submitting)}>
              {submitting ? 'Submitting...' : 'Submit for KYC Review'}
            </button>
          </div>
        ) : (
          <div style={{ borderRadius: 16, overflow: 'hidden', background: '#13151f', border: '1px solid #374151' }}>
            <smart-camera-web ref={smileRef} capture-id="selfie" />
          </div>
        )}
      </div>
      <style>{'*{box-sizing:border-box}'}</style>
    </div>
  );

  return null;
}
