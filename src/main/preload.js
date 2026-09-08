// The only bridge between the renderer and the filesystem. Everything is
// funnelled through named IPC channels; the renderer never sees `fs` or
// `require`, so a malformed PDF cannot reach the disk.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('inkwell', {
  // --- documents -----------------------------------------------------------
  pickPdf: () => ipcRenderer.invoke('dialog:openPdf'),
  readPdf: (filePath) => ipcRenderer.invoke('file:readPdf', filePath),

  // --- sidecar annotations -------------------------------------------------
  readSidecar: (pdfPath) => ipcRenderer.invoke('sidecar:read', pdfPath),
  writeSidecar: (pdfPath, json) => ipcRenderer.invoke('sidecar:write', pdfPath, json),

  // --- export --------------------------------------------------------------
  exportPdf: (suggestedName, bytes) =>
    ipcRenderer.invoke('file:exportPdf', suggestedName, bytes),
  pickPdfToAppend: () => ipcRenderer.invoke('dialog:appendPdf'),

  // --- recents -------------------------------------------------------------
  getRecents: () => ipcRenderer.invoke('recents:get'),
  clearRecents: () => ipcRenderer.invoke('recents:clear'),

  // --- window / menu events ------------------------------------------------
  onMenu: (handler) => {
    const listener = (_event, command, payload) => handler(command, payload);
    ipcRenderer.on('menu', listener);
    return () => ipcRenderer.removeListener('menu', listener);
  },
  onOpenPath: (handler) => {
    const listener = (_event, filePath) => handler(filePath);
    ipcRenderer.on('open-path', listener);
    return () => ipcRenderer.removeListener('open-path', listener);
  },
  // Lets the renderer veto a close while a save is still in flight.
  setDirty: (dirty) => ipcRenderer.send('window:dirty', dirty),
  confirmDiscard: (name) => ipcRenderer.invoke('dialog:confirmDiscard', name),

  // --- frameless window chrome --------------------------------------------
  // The window is frameless so the titlebar can be part of the design, which
  // means the renderer has to drive minimise/maximise/close itself.
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  closeNow: () => ipcRenderer.send('window:close-now'),
  windowState: () => ipcRenderer.invoke('window:state'),
  ready: () => ipcRenderer.send('renderer:ready'),
});
