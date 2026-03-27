const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sparkp2p', {
  isDesktop: true,
  connectBinance: () => ipcRenderer.invoke('connect-binance'),
  setToken: (token) => ipcRenderer.invoke('set-token', token),
  setPin: (pin) => ipcRenderer.invoke('set-pin', pin),
  setAIKey: (key) => ipcRenderer.invoke('set-ai-key', key),
  getBotStatus: () => ipcRenderer.invoke('get-bot-status'),
  takeScreenshot: () => ipcRenderer.invoke('take-screenshot'),
  runAIScan: () => ipcRenderer.invoke('run-ai-scan'),
  restartApp: () => ipcRenderer.invoke('restart-app'),
});
