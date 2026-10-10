const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('api', {
  info: () => ipcRenderer.invoke('info'),
  openFolder: () => ipcRenderer.invoke('openFolder'),
  showFile: (p) => ipcRenderer.invoke('showFile', p),
  chooseFolder: () => ipcRenderer.invoke('chooseFolder'),
  onReceived: (cb) => ipcRenderer.on('received', (_, f) => cb(f)),
  devices: () => ipcRenderer.invoke('devices'),
  pickFiles: (to) => ipcRenderer.invoke('pickFiles', to),
  addDropped: (files, to) => ipcRenderer.invoke('addFiles', [...files].map((f) => webUtils.getPathForFile(f)), to),
  thumb: (p, size) => ipcRenderer.invoke('thumb', p, size),
  setPinned: (v) => ipcRenderer.invoke('setPinned', v),
  hide: () => ipcRenderer.invoke('hide'),
  removeFile: (id) => ipcRenderer.invoke('removeFile', id),
});
