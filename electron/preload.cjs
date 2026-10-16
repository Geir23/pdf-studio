const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  onOpenFile: (cb) => {
    const listener = (_e, file) => cb(file.name, file.bytes);
    ipcRenderer.on('open-file', listener);
    ipcRenderer.send('renderer-ready');
    return () => ipcRenderer.removeListener('open-file', listener);
  },
  saveFile: (bytes, suggestedName, filePath) => ipcRenderer.invoke('save-file', { bytes, suggestedName, filePath }),
  setDirty: (dirty) => ipcRenderer.send('set-dirty', !!dirty),
  listCertificates: () => ipcRenderer.invoke('list-certificates'),
  signWithCertificate: (thumbprint, bytes) => ipcRenderer.invoke('sign-with-certificate', { thumbprint, bytes }),
});
