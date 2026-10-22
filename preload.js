const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  gonder: (k, ...a) => ipcRenderer.send(k, ...a),
  al: (k, ...a) => ipcRenderer.invoke(k, ...a),
  durum: (f) => ipcRenderer.on('durum', (e, s) => f(s))
});
