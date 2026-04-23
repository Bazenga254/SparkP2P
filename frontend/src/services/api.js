import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
});

// Add auth token to all requests + ping activity tracker so bot trading keeps session alive
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
    // Notify AuthContext that there is API activity (keeps inactivity timer reset)
    window.dispatchEvent(new Event('api-activity'));
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
export const requestPasswordReset = (email) => api.post('/auth/reset-password/request', { email });
export const confirmPasswordReset = (email, otp_code, new_password) => api.post('/auth/reset-password/confirm', { email, otp_code, new_password });

// Trader
export const getProfile = () => api.get('/traders/me');
export const connectBinance = (data) => api.post('/traders/connect-binance', data);
export const updateSettlement = (data) => api.put('/traders/settlement', data);
export const updateVerification = (data) => api.put('/traders/verification', data);
export const updateTradingConfig = (data) => api.put('/traders/trading-config', data);
export const getWallet = () => api.get('/traders/wallet');
export const requestWithdrawalOtp = () => api.post('/traders/wallet/withdraw/request-otp');
export const requestWithdrawal = (otp_code) => api.post('/traders/wallet/withdraw', { otp_code });
export const getWalletTransactions = (limit = 50, direction = null) => api.get(`/traders/wallet/transactions?limit=${limit}${direction ? '&direction=' + direction : ''}`);
export const getSessionHealth = () => api.get('/traders/session-health');
export const updateProfile = (data) => api.put('/traders/profile', data);
export const setSecurityQuestion = (data) => api.post('/traders/security-question', data);
export const getTotpSetup = () => api.get('/traders/setup-totp');
export const verifyAndSaveTotp = (data) => api.post('/traders/setup-totp/verify', data);
export const removeTotp = () => api.delete('/traders/setup-totp');
export const verifyTotp = (code) => api.post('/traders/verify-totp', { code });
export const requestChangePasswordOtp = () => api.post('/traders/change-password/request');
export const changePassword = (otp_code, new_password) => api.post('/traders/change-password', { otp_code, new_password });
export const getBinanceAccountData = () => api.get('/ext/account-data');
export const getMarketPrices = () => api.get('/ext/market-prices');
export const getMyAdPrices = () => api.get('/ext/my-ad-prices');
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
export const getAdminOrders = (period = 'today', limit = 50, search = '') =>
  api.get(`/admin/orders?period=${period}&limit=${limit}${search ? '&search=' + encodeURIComponent(search) : ''}`);
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

// Support Chat
export const sendSupportMessage = (message, ticket_id = null, attachment_url = null, attachment_name = null) => api.post('/support/chat', { message, ticket_id, attachment_url, attachment_name });
export const getSupportTickets = () => api.get('/support/tickets');
export const getActiveSupportTicket = () => api.get('/support/tickets/active');
export const getAdminSupportTickets = (params = {}) => api.get('/admin/support-tickets', { params });
export const closeSupportTicket = (ticketId) => api.put(`/admin/support-tickets/${ticketId}/close`);
export const replyToSupportTicket = (ticketId, message, attachmentUrl = null, attachmentName = null) => api.post(`/admin/support-tickets/${ticketId}/reply`, { message, attachment_url: attachmentUrl, attachment_name: attachmentName });
export const uploadSupportAttachment = (file) => { const fd = new FormData(); fd.append('file', file); return api.post('/support/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } }); };

// Withdrawals
export const getAdminWithdrawals = (params = {}) => api.get('/admin/withdrawals', { params });
export const getRevenueBreakdown = (params = {}) => api.get('/admin/revenue/breakdown', { params });
export const markWithdrawalComplete = (txId) => api.put(`/admin/withdrawals/${txId}/complete`);
export const markWithdrawalPending = (txId) => api.put(`/admin/withdrawals/${txId}/pending`);
export const deleteWithdrawal = (txId) => api.delete(`/admin/withdrawals/${txId}`);

export const getTodayStats = () => api.get('/traders/stats/today');

export const getTraderPnl = (traderId, period = 'today') => api.get(`/admin/traders/${traderId}/pnl?period=${period}`);
export const getAdminSweeps = (params = {}) => api.get('/admin/sweeps', { params });
export const retrySweep = (sweepId) => api.post(`/admin/sweeps/${sweepId}/retry`);
export const getAdminPaybillTransactions = (params = {}) => api.get('/admin/paybill-transactions', { params });

export default api;
