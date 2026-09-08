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
  buildMenu();
  return next;
}

// ---------------------------------------------------------------------------
// Sidecar storage — <name>.ink.json beside the PDF
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
    frame: false,
    backgroundColor: '#1c1c1e',
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

  // Unsaved-ink guard. The renderer autosaves on a debounce, so this only fires
  // in the narrow window between a stroke and its save landing.
  win.on('close', (event) => {
    if (!rendererDirty) return;
    event.preventDefault();
    win.webContents.send('menu', 'flush-and-close');
  });

  // Keep external links out of the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  buildMenu();
}

function send(command, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('menu', command, payload);
}

function buildMenu() {
  readRecents().then((recents) => {
    const template = [
      {
        label: 'File',
        submenu: [
          { label: 'Open PDF…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
          {
            label: 'Open Recent',
            submenu: recents.length
              ? [
                  ...recents.map((entry) => ({
                    label: entry.name,
                    click: () => send('open-path', entry.path),
                  })),
                  { type: 'separator' },
                  { label: 'Clear Menu', click: () => send('clear-recents') },
                ]
              : [{ label: 'No Recent Documents', enabled: false }],
          },
          { type: 'separator' },
          { label: 'Save Notes', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
          {
            label: 'Export Annotated PDF…',
            accelerator: 'CmdOrCtrl+E',
            click: () => send('export'),
          },
          { type: 'separator' },
          { label: 'Close Document', accelerator: 'CmdOrCtrl+W', click: () => send('close-doc') },
          { role: 'quit' },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
          { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => send('redo') },
          { type: 'separator' },
          { label: 'Delete Selection', click: () => send('delete') },
          { label: 'Select All Ink', accelerator: 'CmdOrCtrl+A', click: () => send('select-all') },
        ],
      },
      {
        // No accelerators here on purpose. Electron menu accelerators are
        // global, so a bare "1" or "H" would be swallowed before it could reach
        // a text box the user is typing into. The renderer binds these keys
        // itself, where it can tell whether an editor has focus.
        label: 'Tools',
        submenu: [
          { label: 'Pen', click: () => send('tool', 'pen') },
          { label: 'Highlighter', click: () => send('tool', 'highlighter') },
          { label: 'Eraser', click: () => send('tool', 'eraser') },
          { label: 'Lasso', click: () => send('tool', 'lasso') },
          { label: 'Text Box', click: () => send('tool', 'text') },
          { label: 'Sticky Note', click: () => send('tool', 'note') },
          { label: 'Shapes', click: () => send('tool', 'shape') },
          { type: 'separator' },
          { label: 'Hand / Pan', click: () => send('tool', 'hand') },
          { type: 'separator' },
          { label: 'Insert Blank Page After Current', click: () => send('insert-page') },
          { label: 'Append PDF…', click: () => send('append-pdf') },
        ],
      },
      {
        label: 'View',
        submenu: [
          { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => send('zoom-in') },
          { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => send('zoom-out') },
          { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => send('zoom-reset') },
          { label: 'Fit Width', accelerator: 'CmdOrCtrl+1', click: () => send('fit-width') },
          { label: 'Fit Page', accelerator: 'CmdOrCtrl+2', click: () => send('fit-page') },
          { type: 'separator' },
          { label: 'Toggle Pages Sidebar', accelerator: 'CmdOrCtrl+B', click: () => send('sidebar') },
          { type: 'separator' },
          { role: 'togglefullscreen' },
          { label: 'Toggle Developer Tools', accelerator: 'CmdOrCtrl+Shift+I', role: 'toggledevtools' },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  });
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

ipcMain.handle('recents:get', () => readRecents());

ipcMain.handle('recents:clear', async () => {
  try {
    await fsp.writeFile(RECENTS_FILE, '[]');
  } catch {
    /* ignore */
  }
  app.clearRecentDocuments();
  buildMenu();
  return [];
});

ipcMain.handle('dialog:confirmDiscard', async (_event, name) => {
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    message: `Save your notes on ${name}?`,
    detail: 'Your ink is stored alongside the PDF. The PDF itself is never modified.',
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

ipcMain.on('window:minimize', () => win?.minimize());
ipcMain.on('window:toggle-maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('window:close', () => win?.close());

ipcMain.handle('window:state', () => ({ maximized: win?.isMaximized() ?? false }));

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
