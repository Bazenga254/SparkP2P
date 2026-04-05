const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sparkp2p', {
  isDesktop: true,
  connectBinance: () => ipcRenderer.invoke('connect-binance'),
  openGmailTab: () => ipcRenderer.invoke('open-gmail-tab'),
  unlockBrowser: () => ipcRenderer.invoke('unlock-browser'),
  lockBrowser: () => ipcRenderer.invoke('lock-browser'),
  pauseNavigation: () => ipcRenderer.invoke('pause-navigation'),
  resumeNavigation: () => ipcRenderer.invoke('resume-navigation'),
  setToken: (token) => ipcRenderer.invoke('set-token', token),
  setPin: (pin) => ipcRenderer.invoke('set-pin', pin),
  setTotpSecret: (secret) => ipcRenderer.invoke('set-totp-secret', secret),
  setAIKey: (key) => ipcRenderer.invoke('set-ai-key', key),
  getBotStatus: () => ipcRenderer.invoke('get-bot-status'),
  takeScreenshot: () => ipcRenderer.invoke('take-screenshot'),
  runAIScan: () => ipcRenderer.invoke('run-ai-scan'),
  restartApp: () => ipcRenderer.invoke('restart-app'),
});
