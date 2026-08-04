import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Payments from './pages/Payments';
import Admin from './pages/Admin';
import AdminLogin from './pages/AdminLogin';
import Employee from './pages/Employee';
import EmployeeLogin from './pages/EmployeeLogin';
import Subscribe from './pages/Subscribe';
import Onboarding from './pages/Onboarding';
import ResetPassword from './pages/ResetPassword';
import Install from './pages/Install';
import Contact from './pages/Contact';
import Survey from './pages/Survey';
import BinanceP2PBotKenya from './pages/BinanceP2PBotKenya';
import AutomateBinanceP2PMpesa from './pages/AutomateBinanceP2PMpesa';
import Blog from './pages/Blog';
import BiometricGate from './components/BiometricGate';
import './App.css';

import KycVerifyPage from './pages/KycVerifyPage';
import KycMobilePage from './pages/KycMobilePage';
function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading">Loading...</div>;
  if (!user) return <Navigate to="/login" />;
  return children;
}

// Onboarding gate: a trader who signed up but hasn't finished setup (Binance +
// settlement + security question + 2FA) is sent to /onboarding and can't reach
// the dashboard until it's done — so "finishing signup" means "onboarded".
// Admins/employees are exempt, and accounts that have already traded are
// grandfathered so an active merchant is never locked out of a dashboard they
// were already using.
function RequireOnboarded({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading">Loading...</div>;
  if (!user) return <Navigate to="/login" />;
  const isTrader = (user.role || 'trader') === 'trader' && !user.is_admin;
  // Dashboard access needs an ADMIN-APPROVED onboarding. Anything else
  // (in_progress / submitted / rejected) is sent to /onboarding, which shows the
  // right screen — the steps, or a "waiting for approval" message. Accounts that
  // have already traded are grandfathered so no active merchant is locked out.
  const approved = user.onboarding_status === 'approved';
  const mustOnboard = isTrader && !approved && !(user.total_trades > 0);
  if (mustOnboard) return <Navigate to="/onboarding" replace />;
  return children;
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <BiometricGate>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/dashboard" element={<RequireOnboarded><Dashboard /></RequireOnboarded>} />
          <Route path="/payments" element={<RequireOnboarded><Payments /></RequireOnboarded>} />
          <Route path="/admin/login" element={<AdminLogin />} />
          <Route path="/admin" element={<ProtectedRoute><Admin /></ProtectedRoute>} />
          <Route path="/subscribe" element={<ProtectedRoute><Subscribe /></ProtectedRoute>} />
          <Route path="/onboarding" element={<ProtectedRoute><Onboarding /></ProtectedRoute>} />
          <Route path="/employee/login" element={<EmployeeLogin />} />
          <Route path="/employee" element={<ProtectedRoute><Employee /></ProtectedRoute>} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/install" element={<Install />} />
          <Route path="/blog" element={<Blog />} />
          <Route path="/binance-p2p-bot-kenya" element={<BinanceP2PBotKenya />} />
          <Route path="/automate-binance-p2p-mpesa" element={<AutomateBinanceP2PMpesa />} />
          <Route path="/contact" element={<Contact />} />
          <Route path="/survey" element={<Survey />} />
          <Route path="/verify-kyc" element={<KycVerifyPage />} />
      <Route path="/kyc/:token" element={<KycMobilePage />} />
      <Route path="*" element={<Navigate to="/dashboard" />} />
        </Routes>
        </BiometricGate>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
