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

// On an expired/invalid session token (401 from an authenticated endpoint), clear it and send the
// user to log in again — otherwise the page silently fails every request (e.g. "Invalid or expired
// token" stuck on the API-key card). Login/register/reset 401s are left for those screens to handle.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    const url = error.config?.url || '';
    const isAuthEndpoint = /\/auth\/(login|register|send-verification|reset-password)/.test(url);
    if (status === 401 && !isAuthEndpoint && localStorage.getItem('token')) {
      const detail = error.response?.data?.detail;
      const msg = typeof detail === 'string' ? detail : '';
      // EXACT match only — this is the session-JWT failure (deps.py is the sole source). A broad
      // match also caught "Invalid or expired OTP code" and other 401s, which logged users out
      // immediately after sign-in (login loop).
      if (msg === 'Invalid or expired token' && !window.location.pathname.startsWith('/login')) {
        localStorage.removeItem('token');
        window.location.href = '/login?reason=expired';
      }
    }
    return Promise.reject(error);
  },
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
export const saveBinance2fa = (secret, code) => api.post('/traders/binance-2fa/save', { secret, code });
export const updateTradingConfig = (data) => api.put('/traders/trading-config', data);
export const saveBinanceApiKey = (data) => api.put('/traders/binance-api-key', data);
export const deleteBinanceApiKey = () => api.delete('/traders/binance-api-key');
export const getRelayOnline = () => api.get('/ext/relay/status');
export const getWallet = () => api.get('/traders/wallet');
export const requestWithdrawalOtp = () => api.post('/traders/wallet/withdraw/request-otp');
export const requestWithdrawal = (otp_code, amount) => api.post('/traders/wallet/withdraw', { otp_code, ...(amount != null ? { amount } : {}) });
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
export const postBotLog = (entry) => api.post('/ext/bot-log', entry);
export const getMyBotLogs = () => api.get('/traders/my-bot-logs');
export const initiateDeposit = (amount, phone) => api.post('/traders/deposit', { amount, phone });
export const getDepositHistory = (limit = 50) => api.get(`/traders/deposit/history?limit=${limit}`);
export const checkDepositStatus = (checkoutId) => api.get(`/traders/deposit/status/${checkoutId}`);
export const internalTransfer = (recipient, amount) => api.post('/traders/wallet/transfer', { recipient, amount });

// Orders
export const getOrders = (params = {}) => api.get('/orders', { params });
// Export orders to .xlsx. range: 24h|7d|30d|1y|all (24h = since 3AM EAT). type: all|incoming|outgoing.
export const exportOrders = (range, type) => api.get('/orders/export', { params: { range, type }, responseType: 'blob' });
export const getOrderStats = () => api.get('/orders/stats');
export const createOrder = (data) => api.post('/orders', data);

// Subscriptions
export const initiateSubscription = (plan, phone) => api.post('/subscriptions/initiate', { plan, phone });
export const getSubscriptionStatus = () => api.get('/subscriptions/status');
export const getPaymentInfo = () => api.get('/subscriptions/payment-info');
export const subscriptionDepositInitiate = (amount, phone) => api.post('/subscriptions/deposit/initiate', { amount, phone });
export const payChoiceInitiate = (plan) => api.post('/subscriptions/pay-choice/initiate', { plan });
export const payChoiceConfirm = (otp) => api.post('/subscriptions/pay-choice/confirm', { otp });
export const adminSendSms = (body) => api.post('/admin/sms/send', body);
export const renewSubscription = (plan, phone) => api.post('/subscriptions/renew', { plan, phone });
export const getRateLimit = () => api.get('/traders/rate-limit');

// Admin
export const getAdminDashboard = () => api.get('/admin/dashboard');
export const getAdminTraders = (params = {}) => api.get('/admin/traders', { params });
export const updateTraderStatus = (id, status) => api.put(`/admin/traders/${id}/status?new_status=${status}`);
export const updateTraderTier = (id, tier, expiresAt = '') => api.put(`/admin/traders/${id}/tier?tier=${tier}${expiresAt ? `&expires_at=${encodeURIComponent(expiresAt)}` : ''}`);
export const getDisputedOrders = () => api.get('/admin/orders/disputed');
export const getUnmatchedPayments = () => api.get('/admin/payments/unmatched');
export const resolveUnmatchedPayment = (id) => api.delete('/admin/payments/unmatched/' + id);
export const getAdminTransactions = (period = 'today', limit = 50, search = '', category = 'choice') =>
  api.get(`/admin/transactions?period=${period}&limit=${limit}&category=${category}${search ? '&search=' + encodeURIComponent(search) : ''}`);
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
export const getSystemStatus = () => api.get('/system-status');
export const sendTelegramTest = () => api.post('/telegram/test');

// Withdrawals
export const getAdminWithdrawals = (params = {}) => api.get('/admin/withdrawals', { params });
export const getRevenueBreakdown = (params = {}) => api.get("/admin/revenue/breakdown", { params });
export const getSubscriptionRevenue = (params = {}) => api.get("/admin/revenue/subscriptions", { params });
export const markWithdrawalComplete = (txId) => api.put(`/admin/withdrawals/${txId}/complete`);
export const markWithdrawalPending = (txId) => api.put(`/admin/withdrawals/${txId}/pending`);
export const deleteWithdrawal = (txId) => api.delete(`/admin/withdrawals/${txId}`);

export const getTodayStats = () => api.get('/traders/stats/today');

export const getTraderPnl = (traderId, period = 'today') => api.get(`/admin/traders/${traderId}/pnl?period=${period}`);
export const getAdminSweeps = (params = {}) => api.get('/admin/sweeps', { params });
export const retrySweep = (sweepId) => api.post(`/admin/sweeps/${sweepId}/retry`);
export const getAdminPaybillTransactions = (params = {}) => api.get('/admin/paybill-transactions', { params });

// Survey
export const getSurveyResponses = () => api.get('/survey/responses');
export const sendSurveyInvite = (id) => api.post(`/survey/${id}/send-invite`);

// Employees
export const getEmployees = () => api.get('/admin/employees');
export const updateEmployeePermissions = (id, permissions) => api.put(`/admin/employees/${id}/permissions`, permissions);
export const deleteEmployee = (id) => api.delete(`/admin/employees/${id}`);
export const deleteTrader = (id) => api.delete(`/admin/traders/${id}`);
export const getMyPermissions = () => api.get('/traders/my-permissions');

// Affiliates
export const getMyAffiliate = () => api.get('/affiliates/me');
export const getMyReferrals = () => api.get('/affiliates/me/referrals');
export const getMyPayouts = () => api.get('/affiliates/me/payouts');
export const applyForAffiliate = (message = '') => api.post('/affiliates/apply', { message });
export const validateReferralCode = (code) => api.get(`/affiliates/validate/${code}`);

// Admin — Bot Logs
export const getAdminTraderBotLogs = (traderId) => api.get(`/admin/traders/${traderId}/bot-logs`);
export const adminGetKycTraders = () => api.get('/admin/kyc/traders');
export const adminGetKycLiveStatus = (traderId) => api.get(`/admin/kyc/status/${traderId}`);
export const adminGetTraderChoiceBalance = (traderId) => api.get(`/admin/traders/${traderId}/choice-balance`);
export const adminGetChoicePlatformFloat = () => api.get('/admin/choice/platform-float');
export const adminGetExpenses = () => api.get('/admin/expenses');
export const adminPostExpense = (body) => api.post('/admin/expenses', body);
export const adminDeleteExpense = (id) => api.delete(`/admin/expenses/${id}`);



export const choiceOnboardWallet = (data) => api.post('/choice/onboard/wallet', data);
export const choiceConfirmOtp = (data) => api.post('/choice/onboard/otp', data);
export const choiceOnboardStatus = (requestId, traderId) => api.get(`/choice/onboard/status/${requestId}`, { params: { trader_id: traderId } });
export const choiceGetBalance = (traderId) => api.get(`/choice/balance/${traderId}`);
export const choiceDeposit = (body) => api.post('/choice/deposit', body);
export const getMyTransactions = (limit = 100) => api.get(`/traders/my-transactions?limit=${limit}`);
export const getCbWithdrawalBank = () => api.get('/traders/cb-withdrawal-bank');
export const verifyBankAccount = (bank_code, account) => api.get('/traders/verify-bank-account', { params: { bank_code, account } });
export const saveCbWithdrawalBank = (body) => api.post('/traders/cb-withdrawal-bank', body);
export const cbWithdrawToBank = (otp, amount) => api.post('/traders/cb-withdraw-to-bank', { otp, amount });
export const cbWithdrawInitiate = (amount) => api.post('/traders/cb-withdraw-to-bank/initiate', { amount });
export const cbWithdrawToMpesa = (otp, amount) => api.post("/traders/cb-withdraw-to-bank", { otp, amount });
export const cbWithdrawToMpesaInitiate = (amount) => api.post("/traders/cb-withdraw-to-mpesa/initiate", { amount });
// Payments Hub — Send Money to any M-Pesa number (OTP-confirmed)
export const cbSendMoneyInitiate = (body) => api.post('/choice/pay/send-money/initiate', body);
export const cbSendMoneyConfirm = (otp) => api.post('/choice/pay/send-money/confirm', { otp });
// Payments Hub — M-Pesa Paybill / Till (OTP-confirmed)
export const cbLookupShortcode = (code) => api.get('/choice/pay/lookup-shortcode', { params: { code } });
export const cbPaybillInitiate = (body) => api.post('/choice/pay/paybill/initiate', body);
export const cbPaybillConfirm = (otp) => api.post('/choice/pay/paybill/confirm', { otp });
// Payments Hub — Bank transfers (PesaLink / internal / RTGS / M-Pesa deposit)
export const cbGetBanks = () => api.get('/choice/banks');
export const cbLookupMpesaName = (phone) => api.get('/choice/pay/lookup-mpesa-name', { params: { phone } });
export const cbLookupBankAccount = (account_id, bank_code = '') => api.get('/choice/pay/lookup-account', { params: { account_id, bank_code } });
export const cbBankTransferInitiate = (body) => api.post('/choice/pay/bank-transfer/initiate', body);
export const cbBankTransferConfirm = (otp) => api.post('/choice/pay/bank-transfer/confirm', { otp });
export const cbRtgsInitiate = (body) => api.post('/choice/pay/rtgs/initiate', body);
export const cbRtgsConfirm = (otp) => api.post('/choice/pay/rtgs/confirm', { otp });
export const cbMpesaToBank = (body) => api.post('/choice/pay/mpesa-to-bank', body);
export const cbResendOtp = (flow) => api.post('/choice/pay/resend-otp', { flow });
export const kycCreateSession = () => api.post('/kyc/session');
export default api;
