const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('api', {
  state: () => ipcRenderer.invoke('state'),
  saveCfg: c => ipcRenderer.invoke('save-cfg', c),
  openFolder: p => ipcRenderer.invoke('open-folder', p),
  openWord: id => ipcRenderer.invoke('open-word', id),
  markOpened: id => ipcRenderer.invoke('mark-opened', id),
  print: (size, silent) => ipcRenderer.invoke('print', size, silent),
  setPage: id => ipcRenderer.send('page', id),
  onGoto: cb => ipcRenderer.on('goto', (_, id) => cb(id)),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  openFile: (id, n) => ipcRenderer.invoke('open-file', id, n),
  openPdf: id => ipcRenderer.invoke('open-pdf', id),
  pickImages: () => ipcRenderer.invoke('pick-images'),
  wordFromFiles: (p, paper) => ipcRenderer.invoke('word-from-files', p, paper),
  setPref: (k, v) => ipcRenderer.invoke('set-pref', k, v),
  pickBg: () => ipcRenderer.invoke('pick-bg'),
  pathOf: f => webUtils.getPathForFile(f),
  onOrder: cb => ipcRenderer.on('new-order', (_, o) => cb(o)),
  onStatus: cb => ipcRenderer.on('status', (_, s) => cb(s))
});
