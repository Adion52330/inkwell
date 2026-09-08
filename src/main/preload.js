// The only bridge between the renderer and the filesystem. Everything is
// funnelled through named IPC channels; the renderer never sees `fs` or
// `require`, so a malformed PDF cannot reach the disk.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

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

  // --- links ---------------------------------------------------------------
  openExternal: (url) => ipcRenderer.invoke('link:open', url),

  // --- reading position ----------------------------------------------------
  rememberPage: (filePath, page) => ipcRenderer.invoke('view:remember', filePath, page),

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

  // The window uses native decorations, so the renderer only needs to tell the
  // main process when a pending save has landed and it is safe to close.
  closeNow: () => ipcRenderer.send('window:close-now'),
  toggleFullScreen: () => ipcRenderer.send('window:fullscreen'),
  toggleDevTools: () => ipcRenderer.send('window:devtools'),
  quit: () => ipcRenderer.send('app:quit'),
  ready: () => ipcRenderer.send('renderer:ready'),

  // Modern Electron removed File.path from the renderer; this is the supported
  // way to learn where a dropped file actually lives on disk.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },
});
