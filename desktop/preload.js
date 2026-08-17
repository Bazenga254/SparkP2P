const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sparkp2p', {
  isDesktop: true,
  connectBinance: () => ipcRenderer.invoke('connect-binance'),
  connectIm: () => ipcRenderer.invoke('connect-im'),
  connectMpesa: () => ipcRenderer.invoke('connect-mpesa'),
  openGmailTab: () => ipcRenderer.invoke('open-gmail-tab'),
  unlockBrowser: () => ipcRenderer.invoke('unlock-browser'),
  lockBrowser: () => ipcRenderer.invoke('lock-browser'),
  pauseNavigation: (durationMs) => ipcRenderer.invoke('pause-navigation', durationMs),
  resumeNavigation: () => ipcRenderer.invoke('resume-navigation'),
  setToken: (token) => ipcRenderer.invoke('set-token', token),
  setPin: (pin) => ipcRenderer.invoke('set-pin', pin),
  saveImPin: (pin) => ipcRenderer.invoke('save-im-pin', pin),
  clearImPin: () => ipcRenderer.invoke('clear-im-pin'),
  hasImPin: () => ipcRenderer.invoke('has-im-pin'),
  saveGmailCredentials: (email, appPassword) => ipcRenderer.invoke('save-gmail-credentials', email, appPassword),
  loadGmailCredentials: () => ipcRenderer.invoke('load-gmail-credentials'),
  clearGmailCredentials: () => ipcRenderer.invoke('clear-gmail-credentials'),
  testEmailOtp: () => ipcRenderer.invoke('test-email-otp'),
  setTotpSecret: (secret) => ipcRenderer.invoke('set-totp-secret', secret),
  setAIKey: (key) => ipcRenderer.invoke('set-ai-key', key),
  getBotStatus: () => ipcRenderer.invoke('get-bot-status'),
  takeScreenshot: () => ipcRenderer.invoke('take-screenshot'),
  runAIScan: () => ipcRenderer.invoke('run-ai-scan'),
  restartApp: () => ipcRenderer.invoke('restart-app'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  manualMpesaSweep: (amount) => ipcRenderer.invoke('manual-mpesa-sweep', amount),
  getLogs: () => ipcRenderer.invoke('get-bot-logs'),
  onLog: (callback) => {
    ipcRenderer.removeAllListeners('bot-log');
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('bot-log', handler);
    return () => ipcRenderer.removeListener('bot-log', handler);
  },
  verifyLockTotp: (code) => ipcRenderer.invoke('verify-lock-totp', code),
});
