'use strict';
// The only bridge between the page and the main process. Nothing from Node is exposed directly.

const { contextBridge, ipcRenderer, webFrame } = require('electron');

const listen = (channel, cb) => {
  const handler = (_event, ...args) => cb(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('pyforge', {
  // window
  minimize: () => ipcRenderer.send('win:minimize'),
  toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
  close: () => ipcRenderer.send('win:close'),
  confirmClose: () => ipcRenderer.send('app:confirm-close'),
  onCloseRequest: (cb) => listen('app:close-request', cb),
  onMaximized: (cb) => listen('win:maximized', cb),

  // dialogs and files
  askSave: () => ipcRenderer.invoke('dialog:ask-save'),
  showError: (title, message) => ipcRenderer.invoke('dialog:error', title, message),
  pickOpen: () => ipcRenderer.invoke('file:pick-open'),
  readFile: (p) => ipcRenderer.invoke('file:read', p),
  pickSave: () => ipcRenderer.invoke('file:pick-save'),
  writeFile: (p, text) => ipcRenderer.invoke('file:write', p, text),
  pickImage: () => ipcRenderer.invoke('bg:pick'),

  // python
  runPython: (code, cwd) => ipcRenderer.invoke('py:run', code, cwd),
  stopPython: () => ipcRenderer.send('py:stop'),
  botsDefaultDir: () => ipcRenderer.invoke('bots:default-dir'),
  botsPickDir: (start) => ipcRenderer.invoke('bots:pick-dir', start),
  botsCreate: (opts) => ipcRenderer.invoke('bots:create', opts),
  botsCheckToken: (t) => ipcRenderer.invoke('bots:check-token', t),
  botsOpenDir: (d) => ipcRenderer.invoke('bots:open-dir', d),
  pickDir: () => ipcRenderer.invoke('fs:pick-dir'),
  listDir: (d) => ipcRenderer.invoke('fs:list', d),
  fsCreate: (o) => ipcRenderer.invoke('fs:create', o),
  fsRename: (o) => ipcRenderer.invoke('fs:rename', o),
  fsTrash: (p) => ipcRenderer.invoke('fs:trash', p),
  fsReveal: (p) => ipcRenderer.invoke('fs:reveal', p),
  gitStatus: (d) => ipcRenderer.invoke('git:status', d),
  gitCommit: (o) => ipcRenderer.invoke('git:commit', o),
  winGlassInfo: () => ipcRenderer.invoke('win:glass-info'),
  winGlassSet: (on) => ipcRenderer.invoke('win:glass-set', on),
  aiGet: () => ipcRenderer.invoke('ai:get'),
  aiSet: (o) => ipcRenderer.invoke('ai:set', o),
  aiChat: (o) => ipcRenderer.invoke('ai:chat', o),
  aiAbort: (id) => ipcRenderer.invoke('ai:abort', id),
  onAiChunk: (cb) => listen('ai:chunk', cb),
  onAiDone: (cb) => listen('ai:done', cb),
  onAiError: (cb) => listen('ai:error', cb),
  appInfo: () => ipcRenderer.invoke('app:info'),
  checkUpdate: () => ipcRenderer.invoke('app:check-update'),
  openUrl: (u) => ipcRenderer.invoke('app:open-url', u),
  setZoom: (f) => { const z = Math.min(1.6, Math.max(0.7, Number(f) || 1)); webFrame.setZoomFactor(z); return z; },
  listThemes: () => ipcRenderer.invoke('themes:list'),
  openThemesFolder: () => ipcRenderer.invoke('themes:open-folder'),
  onPyOut: (cb) => listen('py:out', cb),
  onPyErr: (cb) => listen('py:err', cb),
  onPyError: (cb) => listen('py:error', cb),
  onPyExit: (cb) => listen('py:exit', cb)
});
