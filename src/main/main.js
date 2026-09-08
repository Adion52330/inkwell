const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const isDev = process.argv.includes('--dev');
const RECENTS_FILE = path.join(app.getPath('userData'), 'recents.json');
const MAX_RECENTS = 12;

/** @type {BrowserWindow | null} */
let win = null;
let rendererDirty = false;
// A PDF passed on argv (file manager "Open With", or the MIME association the
// AppImage registers) has to wait until the renderer signals it is listening.
let pendingPath = null;

// ---------------------------------------------------------------------------
// Recent files
// ---------------------------------------------------------------------------

async function readRecents() {
  try {
    const raw = await fsp.readFile(RECENTS_FILE, 'utf8');
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    // Drop entries whose file has since been moved or deleted.
    const alive = [];
    for (const entry of list) {
      if (entry && typeof entry.path === 'string' && fs.existsSync(entry.path)) alive.push(entry);
    }
    return alive;
  } catch {
    return [];
  }
}

async function pushRecent(filePath) {
  const list = await readRecents();
  const next = [
    { path: filePath, name: path.basename(filePath), openedAt: Date.now() },
    ...list.filter((entry) => entry.path !== filePath),
  ].slice(0, MAX_RECENTS);
  try {
    await fsp.mkdir(path.dirname(RECENTS_FILE), { recursive: true });
    await fsp.writeFile(RECENTS_FILE, JSON.stringify(next, null, 2));
  } catch {
    /* recents are a convenience; never block opening a document over them */
  }
  app.addRecentDocument(filePath);
  return next;
}

// ---------------------------------------------------------------------------
// Sidecar storage - <name>.ink.json beside the PDF
// ---------------------------------------------------------------------------

function sidecarPathFor(pdfPath) {
  const dir = path.dirname(pdfPath);
  const base = path.basename(pdfPath).replace(/\.pdf$/i, '');
  return path.join(dir, `${base}.ink.json`);
}

// Write to a temp file in the same directory and rename over the target. rename
// is atomic within a filesystem, so a crash or a full disk mid-write leaves the
// previous notes intact rather than a half-written file.
async function atomicWrite(target, contents) {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fsp.open(tmp, 'w');
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, target);
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 720,
    minHeight: 520,
    show: false,
    // Native window decorations and the native menu bar. A custom frameless
    // title bar breaks tiling window managers, window snapping and the desktop
    // environment's own theming, and gains nothing here.
    backgroundColor: '#232326',
    title: 'Inkwell',
    icon: path.join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, '../../dist/index.html'));
  win.once('ready-to-show', () => {
    win.show();
    if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  });

  win.on('closed', () => {
    win = null;
  });

  // Unsaved-ink guard. The close is vetoed and handed to the renderer, which
  // puts the choice to the user and then calls back with window:close-now.
  win.on('close', (event) => {
    if (!rendererDirty) return;
    event.preventDefault();
    win.webContents.send('menu', 'confirm-close');
  });

  // Keep external links out of the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function send(command, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('menu', command, payload);
}

// The application menu bar is removed: its contents live in the overflow (⋯)
// menu in the app's own toolbar instead. Every accelerator the menu used to
// provide is bound in the renderer, which is also where it can tell whether a
// text box has focus.
function clearMenu() {
  Menu.setApplicationMenu(null);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('dialog:openPdf', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Open PDF',
    filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('dialog:appendPdf', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Append PDF',
    filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const filePath = result.filePaths[0];
  const buffer = await fsp.readFile(filePath);
  return { path: filePath, bytes: new Uint8Array(buffer) };
});

ipcMain.handle('file:readPdf', async (_event, filePath) => {
  const buffer = await fsp.readFile(filePath);
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);
  await pushRecent(filePath);
  return {
    path: filePath,
    name: path.basename(filePath),
    hash,
    bytes: new Uint8Array(buffer),
  };
});

ipcMain.handle('sidecar:read', async (_event, pdfPath) => {
  try {
    const raw = await fsp.readFile(sidecarPathFor(pdfPath), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
});

ipcMain.handle('sidecar:write', async (_event, pdfPath, json) => {
  const target = sidecarPathFor(pdfPath);
  try {
    await atomicWrite(target, json);
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('file:exportPdf', async (_event, suggestedName, bytes) => {
  const result = await dialog.showSaveDialog(win, {
    title: 'Export Annotated PDF',
    defaultPath: suggestedName,
    filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    await fsp.writeFile(result.filePath, Buffer.from(bytes));
    return { ok: true, path: result.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// A link in a PDF is untrusted input, so only http(s) and mailto are ever
// handed to the desktop. file:// or a custom scheme could otherwise be used to
// launch something unexpected from a document the user merely opened.
ipcMain.handle('link:open', async (_event, url) => {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
      return { ok: false, error: `refused ${parsed.protocol} link` };
    }
    await shell.openExternal(parsed.href);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('recents:get', () => readRecents());

ipcMain.handle('recents:clear', async () => {
  try {
    await fsp.writeFile(RECENTS_FILE, '[]');
  } catch {
    /* ignore */
  }
  app.clearRecentDocuments();
  return [];
});

ipcMain.handle('dialog:confirmDiscard', async (_event, name) => {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    message: `Save your changes to ${name}?`,
    detail:
      'Your ink is stored in a file alongside the PDF; the PDF itself is never ' +
      'modified. If you don’t save, the changes made since the last save are lost.',
  });
  return ['save', 'discard', 'cancel'][response];
});

ipcMain.on('window:dirty', (_event, dirty) => {
  rendererDirty = Boolean(dirty);
});

// The renderer answers 'flush-and-close' once its save has landed.
ipcMain.on('window:close-now', () => {
  rendererDirty = false;
  if (win && !win.isDestroyed()) win.close();
});

// Window-level actions that used to be menu roles.
ipcMain.on('window:fullscreen', () => win?.setFullScreen(!win.isFullScreen()));
ipcMain.on('window:devtools', () => win?.webContents.toggleDevTools());
ipcMain.on('app:quit', () => app.quit());

// Renderer reports it is ready; hand over any file from argv or an OS open event.
ipcMain.on('renderer:ready', () => {
  if (pendingPath) {
    win?.webContents.send('open-path', pendingPath);
    pendingPath = null;
  }
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function pdfFromArgv(argv) {
  return (
    argv.slice(1).find((arg) => !arg.startsWith('-') && /\.pdf$/i.test(arg) && fs.existsSync(arg)) ||
    null
  );
}

// A second launch (double-clicking another PDF) should reuse this window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const filePath = pdfFromArgv(argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (filePath) win.webContents.send('open-path', filePath);
    }
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (win) win.webContents.send('open-path', filePath);
    else pendingPath = filePath;
  });

  app.whenReady().then(() => {
    clearMenu();
    pendingPath = pdfFromArgv(process.argv);
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
