const { contextBridge, ipcRenderer } = require('electron');

// Expose SparkP2P desktop APIs to the dashboard
contextBridge.exposeInMainWorld('sparkp2p', {
  getBotStatus: () => ipcRenderer.invoke('get-bot-status'),
  startBot: () => ipcRenderer.invoke('start-bot'),
  stopBot: () => ipcRenderer.invoke('stop-bot'),
  connectBinance: () => ipcRenderer.invoke('connect-binance'),
  setToken: (token) => ipcRenderer.invoke('set-token', token),
  isDesktop: true,
});
