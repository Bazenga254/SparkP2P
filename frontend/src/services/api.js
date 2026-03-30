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
export const login = (email, password, otp_code) => api.post('/auth/login', { email, password, otp_code });
export const register = (data) => api.post('/auth/register', data);
export const sendVerificationCode = (email) => api.post('/auth/send-verification', { email });

// Trader
export const getProfile = () => api.get('/traders/me');
export const connectBinance = (data) => api.post('/traders/connect-binance', data);
export const updateSettlement = (data) => api.put('/traders/settlement', data);
export const updateVerification = (data) => api.put('/traders/verification', data);
export const updateTradingConfig = (data) => api.put('/traders/trading-config', data);
export const getWallet = () => api.get('/traders/wallet');
export const requestWithdrawal = () => api.post('/traders/wallet/withdraw');
export const getWalletTransactions = (limit = 50) => api.get(`/traders/wallet/transactions?limit=${limit}`);
export const getSessionHealth = () => api.get('/traders/session-health');
export const getBinanceAccountData = () => api.get('/ext/account-data');
export const getMarketPrices = () => api.get('/ext/market-prices');
export const initiateDeposit = (amount, phone) => api.post('/traders/deposit', { amount, phone });
export const getDepositHistory = (limit = 50) => api.get(`/traders/deposit/history?limit=${limit}`);
export const checkDepositStatus = (checkoutId) => api.get(`/traders/deposit/status/${checkoutId}`);
export const internalTransfer = (recipient, amount) => api.post('/traders/wallet/transfer', { recipient, amount });

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
export const getAdminTransactions = (period = 'today', limit = 50, search = '') =>
  api.get(`/admin/transactions?period=${period}&limit=${limit}${search ? '&search=' + encodeURIComponent(search) : ''}`);
export const getAdminAnalytics = () => api.get('/admin/analytics');
export const getAdminOnlineTraders = () => api.get('/admin/online-traders');

// Message Templates
export const getMessageTemplates = () => api.get('/admin/templates');
export const updateMessageTemplate = (key, data) => api.put(`/admin/templates/${key}`, data);
export const seedMessageTemplates = () => api.post('/admin/templates/seed');

// Employee
export const employeeLogin = (email, password) => api.post('/auth/employee/login', { email, password });
export const getDisputeDetails = (orderId) => api.get(`/admin/disputes/${orderId}/details`);
export const resolveDispute = (orderId, data) => api.put(`/admin/disputes/${orderId}/resolve`, data);
export const assignDispute = (orderId) => api.put(`/admin/disputes/${orderId}/assign`);
export const sendChatMessage = (data) => api.post('/chat/send', data);
export const getChatHistory = (orderId) => api.get(`/chat/history/${orderId}`);

export default api;
