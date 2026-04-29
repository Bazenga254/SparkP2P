import { useState, useEffect } from 'react';
import api from '../services/api';

const STEPS = [
  { id: 'q1', label: 'Verification' },
  { id: 'q2', label: 'Trading Frequency' },
  { id: 'q3', label: 'Daily Volume' },
  { id: 'q4', label: 'Bank Issues' },
  { id: 'q5', label: 'Automation' },
  { id: 'q6', label: 'Challenges' },
  { id: 'q7', label: 'Transactions' },
];

const QUESTIONS = {
  q1: {
    text: 'Are you a verified Binance P2P merchant?',
    options: [
      { value: 'yes', label: 'Yes, I am verified ✓' },
      { value: 'no', label: 'No, I am not verified' },
    ],
  },
  q2: {
    text: 'How often do you trade on Binance P2P?',
    options: [
      { value: 'Multiple times every day', label: 'Multiple times every day' },
      { value: 'Once or twice every day', label: 'Once or twice every day' },
      { value: '4–6 times a week', label: '4–6 times a week' },
      { value: '1–3 times a week', label: '1–3 times a week' },
      { value: 'Less than once a week', label: 'Less than once a week' },
    ],
  },
  q3: {
    text: 'What is your approximate daily trading volume in KES?',
    options: [
      { value: 'Less than KES 500,000', label: 'Less than KES 500,000' },
      { value: 'KES 500,000 – KES 1,000,000', label: 'KES 500,000 – KES 1,000,000' },
      { value: 'KES 1,000,000 – KES 5,000,000', label: 'KES 1,000,000 – KES 5,000,000' },
      { value: 'KES 5,000,000 – KES 10,000,000', label: 'KES 5,000,000 – KES 10,000,000' },
      { value: 'More than KES 10,000,000', label: 'More than KES 10,000,000' },
    ],
  },
  q4: {
    text: 'Has your I&M bank account ever been frozen due to a fraudulent transaction that was not your fault?',
    options: [
      { value: 'Yes, it has happened', label: 'Yes, it has happened to me' },
      { value: 'No, never', label: 'No, never' },
      { value: "I don't use I&M bank", label: "I don't use I&M bank" },
    ],
  },
  q5: {
    text: 'Do you currently use any P2P automation tools to help manage your trades?',
    options: [
      { value: 'yes', label: 'Yes, I use automation tools' },
      { value: 'no', label: 'No, I manage everything manually' },
    ],
    hasFollowup: true,
    followupPlaceholder: 'Which tool(s) do you use?',
  },
  q6: {
    text: 'What is the biggest challenge you face as a P2P trader right now?',
    options: [
      { value: 'Payment delays / slow M-Pesa confirmations', label: 'Payment delays / slow M-Pesa confirmations' },
      { value: 'Account freezes / bank blocks', label: 'Account freezes / bank blocks' },
      { value: 'Missing trades while offline', label: 'Missing trades while offline' },
      { value: 'Managing multiple orders at once', label: 'Managing multiple orders at once' },
      { value: 'Price competition from other merchants', label: 'Price competition from other merchants' },
      { value: 'Fraud and scammers', label: 'Fraud and scammers' },
      { value: 'Other', label: 'Other' },
    ],
  },
  q7: {
    text: 'Approximately how many transactions do you complete every day?',
    options: [
      { value: 'Less than 5', label: 'Less than 5' },
      { value: '5 – 15', label: '5 – 15' },
      { value: '15 – 30', label: '15 – 30' },
      { value: '30 – 50', label: '30 – 50' },
      { value: 'More than 50', label: 'More than 50' },
    ],
  },
};

export default function Survey() {
  const params = new URLSearchParams(window.location.search);
  const urlName = decodeURIComponent(params.get('name') || '').trim();
  const urlPhone = decodeURIComponent(params.get('phone') || '').trim();
  const hasParams = !!(urlName && urlPhone);

  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState({});
  const [identity] = useState({ full_name: urlName, phone: urlPhone });
  const [followup, setFollowup] = useState('');
  const [disqualified, setDisqualified] = useState(false);
  const [result, setResult] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [previousSubmission, setPreviousSubmission] = useState(null); // { is_qualified, invite_sent }
  const [checking, setChecking] = useState(hasParams);

  useEffect(() => {
    if (!hasParams) return;
    api.get(`/survey/check?phone=${encodeURIComponent(urlPhone)}`)
      .then(res => {
        if (res.data.submitted) setPreviousSubmission(res.data);
      })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);

  const firstName = urlName ? urlName.split(' ')[0] : 'there';
  const currentStepId = STEPS[step]?.id;
  const progress = Math.round(((step + 1) / STEPS.length) * 100);

  const handleAnswer = (qId, value) => {
    if (qId === 'q1' && value === 'no') {
      setDisqualified(true);
      return;
    }
    setAnswers(prev => ({ ...prev, [qId]: value }));
    if (qId !== 'q5') {
      setTimeout(() => advanceStep(qId), 200);
    }
  };

  const advanceStep = (qId) => {
    const idx = STEPS.findIndex(s => s.id === qId);
    if (idx < STEPS.length - 1) {
      setStep(idx + 1);
    } else {
      submitSurvey();
    }
  };

  const handleQ5Next = () => {
    if (!answers.q5) return;
    setStep(prev => prev + 1);
  };

  const submitSurvey = async (finalAnswers = answers) => {
    setSubmitting(true);
    setError('');
    try {
      const res = await api.post('/survey/submit', {
        full_name: identity.full_name,
        phone: identity.phone,
        q1_is_merchant: finalAnswers.q1,
        q2_trade_frequency: finalAnswers.q2 || null,
        q3_daily_volume: finalAnswers.q3 || null,
        q4_account_frozen: finalAnswers.q4 || null,
        q5_has_automation: finalAnswers.q5 || null,
        q5_automation_name: finalAnswers.q5 === 'yes' ? followup : null,
        q6_biggest_challenge: finalAnswers.q6 || null,
        q7_daily_transactions: finalAnswers.q7 || null,
      });
      setResult(res.data);
      setStep(STEPS.length);
    } catch (e) {
      setError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleQ7Answer = (value) => {
    const updated = { ...answers, q7: value };
    setAnswers(updated);
    setTimeout(() => submitSurvey(updated), 200);
  };

  const s = { background: '#0a0e1a', minHeight: '100vh', display: 'flex', flexDirection: 'column', fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" };

  if (!hasParams) {
    return (
      <div style={s}>
        <Header />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px 16px' }}>
          <div style={cardStyle}>
            <div style={{ textAlign: 'center', padding: '40px 24px' }}>
              <div style={{ fontSize: 56, marginBottom: 20 }}>🔒</div>
              <h2 style={{ color: '#f59e0b', fontSize: 22, fontWeight: 700, marginBottom: 12 }}>Invitation Only</h2>
              <p style={{ color: '#9ca3af', fontSize: 15, lineHeight: 1.7 }}>
                This survey is only accessible via a personalized invite link.<br />
                If you received a message from us on WhatsApp, please use the link provided there.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (checking) {
    return (
      <div style={s}>
        <Header />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p style={{ color: '#6b7280', fontSize: 14 }}>Loading…</p>
        </div>
      </div>
    );
  }

  if (previousSubmission) {
    const ADMIN_WA = 'https://wa.me/254758930896';
    return (
      <div style={s}>
        <Header />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px 16px' }}>
          <div style={cardStyle}>
            <div style={{ textAlign: 'center', padding: '40px 28px' }}>
              {previousSubmission.is_qualified ? (
                <>
                  <div style={{ fontSize: 56, marginBottom: 20 }}>✅</div>
                  <h2 style={{ color: '#10b981', fontSize: 22, fontWeight: 700, marginBottom: 12 }}>Already Approved</h2>
                  <p style={{ color: '#9ca3af', fontSize: 15, lineHeight: 1.7 }}>
                    Hi {firstName}, you have already qualified for the SparkP2P Merchant Group.<br /><br />
                    {previousSubmission.invite_sent
                      ? 'Your WhatsApp invite was sent to your phone. Please check your messages.'
                      : 'Our team is reviewing your profile and will send your invite shortly.'}
                  </p>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 56, marginBottom: 20 }}>📋</div>
                  <h2 style={{ color: '#f59e0b', fontSize: 22, fontWeight: 700, marginBottom: 16 }}>Already Submitted</h2>
                  <p style={{ color: '#9ca3af', fontSize: 15, lineHeight: 1.8, marginBottom: 28 }}>
                    Hi {firstName}, we have already received your survey submission. Based on your responses,
                    you did not meet the qualification criteria for the SparkP2P Merchant Group at this time.
                    <br /><br />
                    If you believe there has been an error or your trading profile has changed,
                    please reach out to our team directly on WhatsApp and we will be happy to assist you.
                  </p>
                  <a
                    href={ADMIN_WA}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 10,
                      background: '#25D366', color: '#fff', textDecoration: 'none',
                      padding: '13px 28px', borderRadius: 10, fontWeight: 700, fontSize: 15,
                    }}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/></svg>
                    Contact Admin on WhatsApp
                  </a>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (disqualified) {
    return (
      <div style={s}>
        <Header />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px 16px' }}>
          <div style={cardStyle}>
            <div style={{ textAlign: 'center', padding: '40px 24px' }}>
              <div style={{ fontSize: 56, marginBottom: 20 }}>🙏</div>
              <h2 style={{ color: '#f59e0b', fontSize: 22, fontWeight: 700, marginBottom: 12 }}>Thank You for Your Interest</h2>
              <p style={{ color: '#9ca3af', fontSize: 15, lineHeight: 1.7 }}>
                This product is exclusive for verified Binance P2P merchants only.<br /><br />
                Once you get verified on Binance, you're welcome to apply again.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (step === STEPS.length && result) {
    return (
      <div style={s}>
        <Header />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px 16px' }}>
          <div style={cardStyle}>
            {result.is_qualified ? (
              <div style={{ textAlign: 'center', padding: '40px 24px' }}>
                <div style={{ fontSize: 56, marginBottom: 20 }}>🎉</div>
                <h2 style={{ color: '#10b981', fontSize: 24, fontWeight: 800, marginBottom: 12 }}>You Qualify!</h2>
                <p style={{ color: '#d1d5db', fontSize: 15, lineHeight: 1.7 }}>
                  Thank you {firstName}! Based on your answers you qualify for the SparkP2P Merchant Group.<br /><br />
                  Our team will review your profile and send your WhatsApp group invite shortly.
                </p>
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '40px 24px' }}>
                <div style={{ fontSize: 56, marginBottom: 20 }}>🙏</div>
                <h2 style={{ color: '#f59e0b', fontSize: 22, fontWeight: 700, marginBottom: 12 }}>Thank You!</h2>
                <p style={{ color: '#9ca3af', fontSize: 15, lineHeight: 1.7 }}>
                  We've received your responses.<br />
                  We'll be in touch when there's an opportunity that fits your profile.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const qId = currentStepId;
  const question = QUESTIONS[qId];

  return (
    <div style={s}>
      <Header />

      {/* Progress bar */}
      <div style={{ height: 4, background: '#1f2937' }}>
        <div style={{ height: '100%', background: '#f59e0b', width: `${progress}%`, transition: 'width 0.4s ease' }} />
      </div>

      {/* Step counter */}
      <div style={{ textAlign: 'center', padding: '12px 16px 0', fontSize: 12, color: '#6b7280' }}>
        Question {step + 1} of {STEPS.length}
      </div>

      <div style={{ flex: 1, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '16px 16px 40px' }}>
        <div style={{ ...cardStyle, width: '100%', maxWidth: 560 }}>

          {/* Question steps */}
          {step < STEPS.length && question && (
            <div style={{ padding: '28px 24px 24px' }}>
              {step === 0 && (
                <p style={{ color: '#9ca3af', fontSize: 14, marginBottom: 20 }}>
                  Hey {firstName}! This quick survey helps us understand your trading profile. It takes about 2 minutes.
                </p>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
                <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#f59e0b', color: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 800, flexShrink: 0 }}>
                  {step + 1}
                </div>
                <p style={{ color: '#fff', fontSize: 16, fontWeight: 600, margin: 0, lineHeight: 1.4 }}>
                  {question.text}
                </p>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {question.options.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => {
                      if (qId === 'q7') handleQ7Answer(opt.value);
                      else handleAnswer(qId, opt.value);
                    }}
                    style={{
                      ...optionBtnStyle,
                      borderColor: answers[qId] === opt.value ? '#f59e0b' : '#374151',
                      background: answers[qId] === opt.value ? 'rgba(245,158,11,0.1)' : '#0a0e1a',
                      color: answers[qId] === opt.value ? '#f59e0b' : '#d1d5db',
                    }}
                  >
                    <span style={{ width: 18, height: 18, borderRadius: '50%', border: `2px solid ${answers[qId] === opt.value ? '#f59e0b' : '#4b5563'}`, background: answers[qId] === opt.value ? '#f59e0b' : 'transparent', flexShrink: 0, display: 'inline-block' }} />
                    {opt.label}
                  </button>
                ))}
              </div>

              {/* Q5 followup */}
              {qId === 'q5' && answers.q5 === 'yes' && (
                <div style={{ marginTop: 16 }}>
                  <input
                    style={inputStyle}
                    placeholder="Which tool(s) do you use?"
                    value={followup}
                    onChange={e => setFollowup(e.target.value)}
                  />
                </div>
              )}

              {qId === 'q5' && (
                <button
                  style={{ ...nextBtnStyle, marginTop: 20, opacity: answers.q5 ? 1 : 0.4, cursor: answers.q5 ? 'pointer' : 'not-allowed' }}
                  onClick={handleQ5Next}
                  disabled={!answers.q5}
                >
                  Continue →
                </button>
              )}

              {/* Back button */}
              {step > 0 && (
                <button
                  style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: 13, cursor: 'pointer', marginTop: 16, display: 'block' }}
                  onClick={() => setStep(s => s - 1)}
                >
                  ← Back
                </button>
              )}

              {error && <div style={{ ...errStyle, marginTop: 12 }}>{error}</div>}
              {submitting && <div style={{ color: '#9ca3af', fontSize: 13, marginTop: 12 }}>Submitting...</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Header() {
  return (
    <div style={{ background: '#111827', borderBottom: '1px solid #1f2937', padding: '14px 24px', display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: 20, fontWeight: 800, color: '#f59e0b' }}>⚡ SparkP2P</span>
      <span style={{ fontSize: 13, color: '#6b7280' }}>Merchant Survey</span>
    </div>
  );
}

const cardStyle = {
  background: '#111827',
  border: '1px solid #1f2937',
  borderRadius: 16,
  overflow: 'hidden',
};

const inputStyle = {
  width: '100%',
  background: '#0a0e1a',
  border: '1px solid #374151',
  borderRadius: 10,
  padding: '12px 14px',
  color: '#fff',
  fontSize: 15,
  outline: 'none',
  boxSizing: 'border-box',
};

const labelStyle = {
  display: 'block',
  fontSize: 13,
  color: '#9ca3af',
  marginBottom: 8,
  fontWeight: 500,
};

const errStyle = {
  color: '#ef4444',
  fontSize: 12,
  marginTop: 5,
};

const nextBtnStyle = {
  width: '100%',
  background: '#f59e0b',
  color: '#000',
  border: 'none',
  borderRadius: 10,
  padding: '14px',
  fontSize: 15,
  fontWeight: 700,
  cursor: 'pointer',
};

const optionBtnStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '13px 16px',
  borderRadius: 10,
  border: '1px solid #374151',
  cursor: 'pointer',
  fontSize: 14,
  fontWeight: 500,
  textAlign: 'left',
  transition: 'all 0.15s',
};
