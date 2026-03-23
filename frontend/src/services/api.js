import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
});

// Add auth token to all requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle responses - just pass through, auth handled by AuthContext
api.interceptors.response.use(
  (response) => response,
  (error) => Promise.reject(error),
);

// Auth
export const login = (email, password) => api.post('/auth/login', { email, password });
export const register = (data) => api.post('/auth/register', data);
export const sendVerificationCode = (email) => api.post('/auth/send-verification', { email });

// Trader
export const getProfile = () => api.get('/traders/me');
export const connectBinance = (data) => api.post('/traders/connect-binance', data);
export const updateSettlement = (data) => api.put('/traders/settlement', data);
export const updateTradingConfig = (data) => api.put('/traders/trading-config', data);
export const getWallet = () => api.get('/traders/wallet');
export const requestWithdrawal = () => api.post('/traders/wallet/withdraw');
export const getWalletTransactions = (limit = 50) => api.get(`/traders/wallet/transactions?limit=${limit}`);

// Orders
export const getOrders = (params = {}) => api.get('/orders', { params });
export const getOrderStats = () => api.get('/orders/stats');
export const createOrder = (data) => api.post('/orders', data);

// Subscriptions
export const initiateSubscription = (plan, phone) => api.post('/subscriptions/initiate', { plan, phone });
export const getSubscriptionStatus = () => api.get('/subscriptions/status');
export const renewSubscription = (plan, phone) => api.post('/subscriptions/renew', { plan, phone });

// Admin
export const getAdminDashboard = () => api.get('/admin/dashboard');
export const getAdminTraders = (params = {}) => api.get('/admin/traders', { params });
export const updateTraderStatus = (id, status) => api.put(`/admin/traders/${id}/status?new_status=${status}`);
export const updateTraderTier = (id, tier) => api.put(`/admin/traders/${id}/tier?tier=${tier}`);
export const getDisputedOrders = () => api.get('/admin/orders/disputed');
export const getUnmatchedPayments = () => api.get('/admin/payments/unmatched');
export const getAdminTransactions = (period = 'today', limit = 50) =>
  api.get(`/admin/transactions?period=${period}&limit=${limit}`);
export const getAdminAnalytics = () => api.get('/admin/analytics');
export const getAdminOnlineTraders = () => api.get('/admin/online-traders');

export default api;
