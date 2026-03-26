const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sparkp2p', {
  isDesktop: true,
  connectBinance: () => ipcRenderer.invoke('connect-binance'),
  setToken: (token) => ipcRenderer.invoke('set-token', token),
  setPin: (pin) => ipcRenderer.invoke('set-pin', pin),
  getBotStatus: () => ipcRenderer.invoke('get-bot-status'),
  takeScreenshot: () => ipcRenderer.invoke('take-screenshot'),
});
