// Shared Terms & Conditions modal — used by both the login/register form and the
// stepped RegisterWizard. Renders nothing unless `open` is true.
export default function TermsModal({ open, onClose, onAgree }) {
  if (!open) return null;
  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#111827', border: '1px solid #374151', borderRadius: 16,
          maxWidth: 680, width: '100%', maxHeight: '88vh', display: 'flex', flexDirection: 'column',
          boxShadow: '0 25px 60px rgba(0,0,0,0.6)',
        }}
      >
        {/* Header */}
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid #1f2937', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, color: '#f9fafb', fontWeight: 700 }}>Terms & Conditions</h2>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: '#6b7280' }}>SparkP2P Automated P2P Trading Platform — Last updated: April 2026</p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: 22, cursor: 'pointer', lineHeight: 1, padding: 4 }}>×</button>
        </div>

        {/* Scrollable body */}
        <div style={{ overflowY: 'auto', padding: '20px 24px', flex: 1, fontSize: 13.5, color: '#d1d5db', lineHeight: 1.75 }}>

          <p style={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 10, padding: '12px 16px', color: '#f59e0b', fontSize: 13, marginBottom: 20 }}>
            <strong>IMPORTANT:</strong> Please read these Terms carefully before creating an account. By registering, you agree to be legally bound by these Terms. If you do not agree, do not create an account.
          </p>

          <Section title="1. Acceptance of Terms">
            By accessing or using SparkP2P ("the Platform", "we", "our", "us"), you confirm that you are at least 18 years of age, have legal capacity to enter into binding contracts, and agree to be bound by these Terms & Conditions ("Terms"), our Privacy Policy, and all applicable laws and regulations of the Republic of Kenya. These Terms constitute a legally binding agreement between you ("User", "you") and SparkP2P.
          </Section>

          <Section title="2. Account Security & Unauthorized Access">
            <strong>You are solely responsible for the security of your SparkP2P account.</strong> SparkP2P shall not be liable for any losses, damages, trades executed, or funds transferred as a result of unauthorized access to your account by any third party, including but not limited to:
            <ul style={{ paddingLeft: 20, marginTop: 8 }}>
              <li>Sharing your login credentials with another person (knowingly or unknowingly)</li>
              <li>Allowing a friend, family member, colleague, or any third party to use your account</li>
              <li>Failing to log out of your account on a shared or public device</li>
              <li>Weak or reused passwords that allow unauthorized access</li>
              <li>Account takeover as a result of phishing, social engineering, or other external attacks on you personally</li>
            </ul>
            You agree to immediately notify us at support@sparkp2p.com if you suspect unauthorized access. Any trades or transactions that occur before we can suspend the account remain your sole responsibility.
          </Section>

          <Section title="3. No Password Storage on Our Servers">
            SparkP2P does <strong>not</strong> store your Binance account password, M-Pesa PIN, banking PINs, or any other external account credentials on our servers. The SparkP2P platform authenticates via session cookies/tokens provided by your browser's interaction with Binance. We have no access to your financial institution credentials at any time. You are responsible for maintaining the security of all credentials you use in connection with our platform.
          </Section>

          <Section title="4. Stolen or Lost Device">
            If your device (computer, phone, or any other hardware) is stolen, lost, or accessed by an unauthorized person, SparkP2P <strong>will not be liable</strong> for any financial losses, unauthorized trades, or unauthorized account access that results therefrom. You are strongly advised to:
            <ul style={{ paddingLeft: 20, marginTop: 8 }}>
              <li>Enable full-disk encryption on your device</li>
              <li>Use a strong device PIN, password, or biometric lock</li>
              <li>Never save your SparkP2P password in an unsecured location on your device</li>
              <li>Enable Google Authenticator (TOTP) as a second factor on your SparkP2P account</li>
              <li>Contact us immediately at support@sparkp2p.com to suspend your account if your device is stolen</li>
            </ul>
          </Section>

          <Section title="5. Trading Losses & Financial Risk">
            Peer-to-peer cryptocurrency trading involves <strong>substantial financial risk</strong>. SparkP2P is an automation tool and does not provide financial advice, investment advice, or trading recommendations. You acknowledge and accept that:
            <ul style={{ paddingLeft: 20, marginTop: 8 }}>
              <li>Cryptocurrency markets are highly volatile and prices may change rapidly</li>
              <li>You may lose some or all of the funds involved in your P2P trades</li>
              <li>SparkP2P is not responsible for any trading losses, missed opportunities, or adverse market movements</li>
              <li>The platform automates the payment verification and release process; it does not guarantee profitability or the suitability of any trade</li>
              <li>You are solely responsible for the trading decisions you make on Binance P2P</li>
              <li>Any prices, spreads, or profit projections we display are illustrative only and not guaranteed</li>
            </ul>
          </Section>

          <Section title="6. Bot Automation & Technical Risks">
            SparkP2P automates actions on the Binance P2P platform on your behalf. By using our automation features, you acknowledge that:
            <ul style={{ paddingLeft: 20, marginTop: 8 }}>
              <li>Automated bots may malfunction, encounter errors, or fail to execute due to changes in third-party website structures, internet connectivity issues, or software bugs</li>
              <li>SparkP2P shall not be liable for failed, missed, or incorrectly executed transactions caused by automation errors, system downtime, or API failures</li>
              <li>Binance P2P may modify its platform at any time, which may temporarily or permanently affect our bot's functionality</li>
              <li>You are responsible for monitoring your active trades and ensuring funds are appropriately managed</li>
              <li>Running automation bots may violate Binance's Terms of Service; you accept all risks and consequences associated with this, and SparkP2P takes no responsibility for any account suspension or ban by Binance</li>
              <li>You are responsible for ensuring sufficient float (crypto balance) for your configured trade orders</li>
            </ul>
          </Section>

          <Section title="7. Third-Party Services">
            SparkP2P integrates with and relies on third-party services including but not limited to Binance, M-Pesa (Safaricom), I&M Bank, and other payment providers. SparkP2P is <strong>not affiliated with</strong> and <strong>not endorsed by</strong> any of these companies. We are not liable for:
            <ul style={{ paddingLeft: 20, marginTop: 8 }}>
              <li>Downtime, outages, or changes to Binance P2P, M-Pesa, or banking services</li>
              <li>Payment delays, reversals, or failures caused by M-Pesa, banks, or other payment processors</li>
              <li>Actions taken by Binance against your account, including freezes, bans, or trade cancellations</li>
              <li>Any fees charged by third-party payment processors</li>
              <li>Changes to Binance's P2P policies that affect your trading</li>
            </ul>
          </Section>

          <Section title="8. No Financial or Investment Advice">
            Nothing on the SparkP2P platform constitutes financial advice, investment advice, trading advice, or any other kind of advice. We do not recommend any specific cryptocurrency, trading strategy, or P2P ad configuration. All decisions are made entirely at your own discretion and risk. You should seek independent financial advice if you are uncertain about any trading decision.
          </Section>

          <Section title="9. Service Availability & Modifications">
            SparkP2P does not guarantee uninterrupted or error-free service. We reserve the right to:
            <ul style={{ paddingLeft: 20, marginTop: 8 }}>
              <li>Modify, suspend, or discontinue the platform (or any feature) at any time, with or without notice</li>
              <li>Change subscription pricing with reasonable advance notice to registered users</li>
              <li>Perform scheduled or emergency maintenance that may temporarily interrupt service</li>
            </ul>
            We shall not be liable for any loss or damage arising from service interruptions, modifications, or discontinuation.
          </Section>

          <Section title="10. Subscription & Refund Policy">
            SparkP2P operates on a subscription basis. Subscriptions are charged in advance and are <strong>non-refundable</strong> except where required by applicable Kenyan consumer protection law. If you believe you are entitled to a refund, contact us within 7 days of the charge at support@sparkp2p.com. We reserve the right to suspend or terminate your subscription for violation of these Terms without refund.
          </Section>

          <Section title="11. Account Termination">
            SparkP2P reserves the right to suspend or permanently terminate your account at any time, without notice, if you:
            <ul style={{ paddingLeft: 20, marginTop: 8 }}>
              <li>Violate any provision of these Terms</li>
              <li>Engage in fraudulent, abusive, or illegal activity through the platform</li>
              <li>Attempt to reverse-engineer, scrape, or exploit the platform</li>
              <li>Fail to pay subscription fees when due</li>
              <li>Pose a security or legal risk to SparkP2P or other users</li>
            </ul>
            Upon termination, your right to access the platform ceases immediately. Any active trades remain your responsibility to manage manually.
          </Section>

          <Section title="12. Limitation of Liability">
            To the maximum extent permitted by applicable law, SparkP2P, its directors, employees, agents, and affiliates shall <strong>not be liable</strong> for any:
            <ul style={{ paddingLeft: 20, marginTop: 8 }}>
              <li>Direct, indirect, incidental, special, consequential, or punitive damages</li>
              <li>Loss of profits, revenue, data, goodwill, or other intangible losses</li>
              <li>Damages arising from unauthorized account access, stolen devices, third-party failures, or automation errors</li>
              <li>Any amount exceeding the total subscription fees you paid to SparkP2P in the 3 months preceding the claim</li>
            </ul>
            These limitations apply regardless of the theory of liability (contract, tort, negligence, or otherwise) and even if SparkP2P has been advised of the possibility of such damages.
          </Section>

          <Section title="13. Indemnification">
            You agree to indemnify, defend, and hold harmless SparkP2P and its officers, directors, employees, and agents from and against any claims, liabilities, damages, judgments, awards, losses, costs, and expenses (including legal fees) arising out of or relating to:
            <ul style={{ paddingLeft: 20, marginTop: 8 }}>
              <li>Your use or misuse of the platform</li>
              <li>Your violation of these Terms</li>
              <li>Your violation of any applicable law or regulation</li>
              <li>Any unauthorized access to your account that you failed to prevent or report</li>
              <li>Any third-party claims arising from your P2P trading activities</li>
            </ul>
          </Section>

          <Section title="14. Data Protection & Privacy">
            SparkP2P collects and processes personal data (name, email, phone number) solely for the purpose of providing the platform's services. We do not sell your personal data to third parties. Data is stored securely and in accordance with applicable Kenyan data protection legislation, including the Data Protection Act, 2019. For full details, refer to our Privacy Policy. By registering, you consent to the collection and processing of your personal data as described.
          </Section>

          <Section title="15. Governing Law & Dispute Resolution">
            These Terms shall be governed by and construed in accordance with the laws of the <strong>Republic of Kenya</strong>. Any disputes arising from or in connection with these Terms shall first be attempted to be resolved through good-faith negotiation. If unresolved within 30 days, disputes shall be subject to the exclusive jurisdiction of the courts of Nairobi, Kenya. You waive any right to a jury trial or class action proceedings to the maximum extent permitted by law.
          </Section>

          <Section title="16. Amendments to Terms">
            SparkP2P reserves the right to update or modify these Terms at any time. Material changes will be communicated via email or a notice on the platform at least 7 days before taking effect. Your continued use of the platform after such notice constitutes acceptance of the revised Terms. If you do not agree to the revised Terms, you must stop using the platform and contact us to close your account.
          </Section>

          <Section title="17. Entire Agreement">
            These Terms, together with our Privacy Policy, constitute the entire agreement between you and SparkP2P with respect to the platform and supersede all prior agreements, representations, and understandings. If any provision of these Terms is found to be invalid or unenforceable, the remaining provisions shall continue in full force and effect.
          </Section>

          <p style={{ marginTop: 24, padding: '12px 16px', background: '#1f2937', borderRadius: 10, fontSize: 12, color: '#9ca3af', border: '1px solid #374151' }}>
            For questions about these Terms, contact us at <strong style={{ color: '#d1d5db' }}>support@sparkp2p.com</strong>. SparkP2P is operated in Nairobi, Kenya.
          </p>
        </div>

        {/* Footer */}
        <div style={{ padding: '16px 24px', borderTop: '1px solid #1f2937', display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            style={{ padding: '10px 20px', borderRadius: 10, border: '1px solid #374151', background: 'transparent', color: '#9ca3af', fontSize: 14, cursor: 'pointer' }}
          >
            Close
          </button>
          <button
            onClick={onAgree}
            style={{ padding: '10px 24px', borderRadius: 10, border: 'none', background: '#f59e0b', color: '#000', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
          >
            I Agree
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h3 style={{ color: '#f9fafb', fontSize: 14, fontWeight: 700, marginBottom: 8, marginTop: 0 }}>{title}</h3>
      <div style={{ color: '#d1d5db' }}>{children}</div>
    </div>
  );
}
