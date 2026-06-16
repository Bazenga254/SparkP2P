import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
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

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <BiometricGate>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
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
