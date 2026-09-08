// Application wiring: document lifecycle, autosave, commands and shortcuts.

import { Store } from './store.js';
import { PdfView, ZOOM_PRESETS } from './pdfview.js';
import { InkEngine } from './ink.js';
import { Toolbar } from './ui/toolbar.js';
import { Thumbnails } from './ui/thumbnails.js';
import { BrushCursor } from './ui/cursor.js';
import { icon } from './ui/icons.js';
import { buildAnnotatedPdf, suggestExportName } from './export.js';

const api = window.inkwell;
const SETTINGS_KEY = 'inkwell.tools.v1';
const AUTOSAVE_MS = 800;

// --- tool state -------------------------------------------------------------

const defaults = {
  tool: 'pen',
  color: '#1C1C1E',
  size: 2.6,
  opacity: 1,
  highlighterColor: '#FFE234',
  highlighterSize: 18,
  eraserSize: 20,
  shape: 'rect',
  fill: false,
  textColor: '#1C1C1E',
  fontSize: 15,
  noteColor: '#FFD60A',
  // Where the floating palette sits, and how far along that edge.
  dock: 'bottom',
  dockOffset: 0.5,
};

const tools = { ...defaults, ...loadSettings() };

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(tools));
  } catch {
    /* a full or disabled localStorage must not break drawing */
  }
}

// --- element handles --------------------------------------------------------

const $ = (id) => document.getElementById(id);
const viewerEl = $('viewer');
const bodyEl = $('body');
const welcomeEl = $('welcome');
const toastEl = $('toast');
const titleEl = $('doc-title');
const subtitleEl = $('doc-subtitle');
const zoomEl = $('zoom-readout');
const dropVeil = $('drop-veil');

// --- core objects -----------------------------------------------------------

const store = new Store();
const view = new PdfView({ container: viewerEl, store, tools });
const ink = new InkEngine({ viewer: viewerEl, store, tools, view });
const thumbs = new Thumbnails({ mount: bodyEl, store, view });
const toolbar = new Toolbar({ mount: bodyEl, tools });
const brushCursor = new BrushCursor({ viewer: viewerEl, tools, view });

// The sidebar must sit before the viewer in the flex row.
bodyEl.insertBefore(thumbs.el, viewerEl);

let originalBytes = null;
let currentPath = null;
let saveTimer = 0;
let closing = false;

// --- chrome -----------------------------------------------------------------

for (const [id, name] of [
  ['btn-sidebar', 'sidebar'],
  ['btn-open', 'open'],
  ['btn-undo', 'undo'],
  ['btn-redo', 'redo'],
  ['btn-zoom-out', 'zoomOut'],
  ['btn-zoom-in', 'zoomIn'],
  ['btn-fit-width', 'fitWidth'],
  ['btn-export', 'export'],
]) {
  $(id).innerHTML = icon(name);
}
$('welcome-mark').innerHTML = icon('pen', 40);

$('btn-open').addEventListener('click', () => openViaDialog());
$('btn-open-big').addEventListener('click', () => openViaDialog());
$('btn-undo').addEventListener('click', () => command('undo'));
$('btn-redo').addEventListener('click', () => command('redo'));
$('btn-zoom-in').addEventListener('click', () => stepZoom(1));
$('btn-zoom-out').addEventListener('click', () => stepZoom(-1));
$('btn-fit-width').addEventListener('click', () => view.applyFit('width'));
$('btn-export').addEventListener('click', () => exportDocument());
$('btn-sidebar').addEventListener('click', () => toggleSidebar());
zoomEl.addEventListener('click', () => toggleZoomMenu());

/**
 * Step to the next standard zoom level rather than multiplying blindly, so the
 * button lands on round numbers instead of drifting to 137%.
 */
function stepZoom(direction) {
  const current = view.scale;
  if (direction > 0) {
    const next = ZOOM_PRESETS.find((preset) => preset > current + 1e-3);
    view.zoomTo(next ?? current * 1.25);
  } else {
    const previous = [...ZOOM_PRESETS].reverse().find((preset) => preset < current - 1e-3);
    view.zoomTo(previous ?? current * 0.8);
  }
}

// --- zoom menu --------------------------------------------------------------

const zoomMenu = document.createElement('div');
zoomMenu.className = 'zoom-menu';
zoomMenu.hidden = true;
document.body.append(zoomMenu);

function buildZoomMenu() {
  zoomMenu.replaceChildren();
  const item = (label, detail, onPick, isCurrent = false) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `zoom-item${isCurrent ? ' on' : ''}`;
    const name = document.createElement('span');
    name.textContent = label;
    button.append(name);
    if (detail) {
      const hint = document.createElement('kbd');
      hint.textContent = detail;
      button.append(hint);
    }
    button.addEventListener('click', () => {
      closeZoomMenu();
      onPick();
    });
    zoomMenu.append(button);
  };

  item('Fit width', 'Ctrl 1', () => view.applyFit('width'), view.fitMode === 'width');
  item('Fit page', 'Ctrl 2', () => view.applyFit('page'), view.fitMode === 'page');
  const rule = document.createElement('div');
  rule.className = 'zoom-rule';
  zoomMenu.append(rule);
  for (const preset of ZOOM_PRESETS) {
    item(
      `${Math.round(preset * 100)}%`,
      preset === 1 ? 'Ctrl 0' : '',
      () => view.zoomTo(preset),
      !view.fitMode && Math.abs(view.scale - preset) < 0.005
    );
  }
}

function toggleZoomMenu() {
  if (!zoomMenu.hidden) return closeZoomMenu();
  buildZoomMenu();
  const rect = zoomEl.getBoundingClientRect();
  zoomMenu.hidden = false;
  // Right-aligned to the readout, and clamped so it cannot run off the edge.
  const width = zoomMenu.offsetWidth;
  zoomMenu.style.top = `${rect.bottom + 6}px`;
  zoomMenu.style.left = `${Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8)}px`;
  requestAnimationFrame(() => zoomMenu.classList.add('on'));
}

function closeZoomMenu() {
  zoomMenu.classList.remove('on');
  zoomMenu.hidden = true;
}

document.addEventListener('pointerdown', (event) => {
  if (zoomMenu.hidden) return;
  if (zoomMenu.contains(event.target) || event.target === zoomEl) return;
  closeZoomMenu();
});

function toggleSidebar() {
  const open = thumbs.toggle();
  $('btn-sidebar').classList.toggle('on', open);
  // The sidebar takes width away from the viewer, so a fitted document has to
  // be refitted or it starts overflowing horizontally. Wait for the slide
  // animation to finish, otherwise the fit is computed against a width the
  // sidebar is still in the middle of vacating.
  if (view.fitMode) {
    const mode = view.fitMode;
    setTimeout(() => view.applyFit(mode), 280);
  }
}

// --- toast ------------------------------------------------------------------

let toastTimer = 0;
function toast(message, kind = '') {
  toastEl.textContent = message;
  toastEl.className = `toast on ${kind}`.trim();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.className = `toast ${kind}`.trim();
  }, 2600);
}

// --- opening a document -----------------------------------------------------

async function openViaDialog() {
  const path = await api.pickPdf();
  if (path) await openDocument(path);
}

async function openDocument(filePath) {
  if (store.doc && store.doc.path !== filePath) {
    if ((await confirmUnsaved()) === 'cancel') return;
  }
  try {
    const file = await api.readPdf(filePath);
    // pdf.js takes ownership of the buffer it is given, so the exporter needs
    // its own copy of the original bytes taken before that happens.
    originalBytes = file.bytes.slice();
    currentPath = file.path;

    const { pageCount, sizes } = await view.load(file.bytes);
    store.open({ path: file.path, name: file.name, hash: file.hash, pageCount, sizes });

    const sidecar = await api.readSidecar(file.path);
    if (sidecar) {
      const result = store.hydrate(sidecar);
      if (result?.mismatched) {
        toast('The PDF changed since these notes were made — ink may not line up', 'warn');
      }
    }

    view.layout();
    view.applyFit('width');
    view.scrollToPage(0, 'auto');
    ink.clearSelection();

    welcomeEl.hidden = true;
    titleEl.firstChild.textContent = file.name;
    updateSubtitle();
    document.title = `${file.name} — Inkwell`;
    if (thumbs.open) thumbs.rebuild();
    updateHistoryButtons();
  } catch (err) {
    console.error(err);
    toast(`Could not open that PDF: ${err.message}`, 'error');
  }
}

function updateSubtitle() {
  if (!store.doc) {
    subtitleEl.textContent = 'No document open';
    return;
  }
  const count = store.pageCount;
  const strokes = store.doc.pages.reduce((sum, page) => sum + page.strokes.length, 0);
  const saved = store.isDirty ? 'unsaved changes' : 'saved';
  subtitleEl.textContent = `${count} page${count === 1 ? '' : 's'} · ${strokes} stroke${
    strokes === 1 ? '' : 's'
  } · ${saved}`;
}

/**
 * Put unsaved work to the user before it would be lost.
 * Returns 'save' | 'discard' | 'cancel'; 'save' has already been written by the
 * time this resolves. Discarding simply leaves the sidecar as it was on disk —
 * the last saved state — so nothing has to be rolled back in memory.
 */
async function confirmUnsaved() {
  if (!store.doc || !store.isDirty) return 'save';
  const choice = await api.confirmDiscard(store.doc.name);
  if (choice === 'save') {
    const ok = await flushSave();
    // A failed write must not be mistaken for a clean exit.
    if (!ok) return 'cancel';
  }
  if (choice === 'discard') {
    // Stop the pending autosave from writing the changes anyway.
    clearTimeout(saveTimer);
    store.markSaved();
    api.setDirty(false);
  }
  return choice;
}

async function closeDocument() {
  if ((await confirmUnsaved()) === 'cancel') return false;
  await view.unload();
  store.close();
  originalBytes = null;
  currentPath = null;
  welcomeEl.hidden = false;
  titleEl.firstChild.textContent = 'Inkwell';
  document.title = 'Inkwell';
  updateSubtitle();
  renderRecents();
  return true;
}

// --- autosave ---------------------------------------------------------------

store.addEventListener('change', (event) => {
  const { pages, structural } = event.detail;
  if (structural) {
    view.layout();
    view.refreshAll();
    if (thumbs.open) thumbs.rebuild();
  } else if (pages) {
    for (const index of pages) {
      view.repaintInk(index);
      // Text boxes and notes live in the DOM, not on the ink canvas, so they
      // need their own rebuild — otherwise a deleted note stays on screen and
      // an undone deletion never comes back.
      view.renderObjects(index);
      if (thumbs.open) thumbs.invalidate(index);
    }
  }
  updateHistoryButtons();
  updateSubtitle();
  scheduleSave();
});

function scheduleSave() {
  api.setDirty(true);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, AUTOSAVE_MS);
}

async function flushSave() {
  clearTimeout(saveTimer);
  if (!store.doc || !currentPath) {
    api.setDirty(false);
    return true;
  }
  if (!store.isDirty) {
    api.setDirty(false);
    return true;
  }
  const revisionAtSave = store.revision;
  const result = await api.writeSidecar(currentPath, store.serialize());
  if (!result?.ok) {
    toast(`Could not save notes: ${result?.error ?? 'unknown error'}`, 'error');
    return false;
  }
  // Only clear the dirty flag if nothing was drawn while the write was in
  // flight; otherwise those strokes would be silently considered saved.
  if (store.revision === revisionAtSave) {
    store.savedAt = revisionAtSave;
    api.setDirty(false);
  }
  updateSubtitle();
  return true;
}

function updateHistoryButtons() {
  $('btn-undo').disabled = !store.canUndo;
  $('btn-redo').disabled = !store.canRedo;
}

// --- export -----------------------------------------------------------------

let exporting = false;
async function exportDocument() {
  if (!store.doc || exporting) return;
  exporting = true;
  toast('Preparing annotated PDF…');
  try {
    const bytes = await buildAnnotatedPdf({
      store,
      originalBytes,
      sourceBytes: view.sourceBytes,
    });
    const result = await api.exportPdf(suggestExportName(store.doc.name), bytes);
    if (result.ok) toast(`Exported to ${result.path.split('/').pop()}`);
    else if (!result.canceled) toast(`Export failed: ${result.error}`, 'error');
  } catch (err) {
    console.error(err);
    toast(`Export failed: ${err.message}`, 'error');
  } finally {
    exporting = false;
  }
}

// --- page operations --------------------------------------------------------

async function appendPdf() {
  if (!store.doc) return;
  const picked = await api.pickPdfToAppend();
  if (!picked) return;
  const key = `src-${Date.now()}`;
  const { pageCount, sizes } = await view.addSource(key, picked.bytes);
  store.appendPages(key, pageCount, sizes);
  toast(`Appended ${pageCount} page${pageCount === 1 ? '' : 's'}`);
}

// --- commands ---------------------------------------------------------------

async function command(name, payload) {
  switch (name) {
    case 'open':
      await openViaDialog();
      break;
    case 'open-path':
      await openDocument(payload);
      break;
    case 'save':
      if (await flushSave()) toast('Notes saved');
      break;
    case 'export':
      await exportDocument();
      break;
    case 'close-doc':
      await closeDocument();
      break;
    case 'undo':
      if (store.undo()) ink.clearSelection();
      break;
    case 'redo':
      if (store.redo()) ink.clearSelection();
      break;
    case 'delete':
      ink.deleteSelection();
      break;
    case 'select-all': {
      const page = store.page(view.currentPage);
      if (!page) break;
      ink.selection = {
        pageIndex: view.currentPage,
        strokeIds: new Set(page.strokes.map((s) => s.id)),
        objectIds: new Set(page.objects.map((o) => o.id)),
      };
      view.setSelection(ink.selection);
      break;
    }
    case 'tool':
      toolbar.setTool(payload);
      applyToolCursor();
      break;
    case 'zoom-in':
      stepZoom(1);
      break;
    case 'zoom-out':
      stepZoom(-1);
      break;
    case 'zoom-reset':
      view.zoomTo(1);
      break;
    case 'fit-width':
      view.applyFit('width');
      break;
    case 'fit-page':
      view.applyFit('page');
      break;
    case 'sidebar':
      toggleSidebar();
      break;
    case 'insert-page': {
      if (!store.doc) break;
      const at = store.insertBlankPage(view.currentPage);
      toast('Blank page inserted');
      requestAnimationFrame(() => view.scrollToPage(at));
      break;
    }
    case 'append-pdf':
      await appendPdf();
      break;
    case 'clear-recents':
      await api.clearRecents();
      renderRecents();
      break;
    case 'confirm-close': {
      // The main process has vetoed the close and is waiting on us.
      const choice = await confirmUnsaved();
      if (choice === 'cancel') {
        // Re-arm the guard: the veto consumed nothing, but the main process
        // needs to know the document is still dirty for the next attempt.
        api.setDirty(store.isDirty);
        break;
      }
      closing = true;
      api.closeNow();
      break;
    }
    default:
      break;
  }
}

api.onMenu((name, payload) => {
  command(name, payload);
});
api.onOpenPath((filePath) => openDocument(filePath));

// --- keyboard ---------------------------------------------------------------

const TOOL_KEYS = {
  1: 'pen',
  2: 'highlighter',
  3: 'eraser',
  4: 'lasso',
  5: 'text',
  6: 'note',
  7: 'shape',
  h: 'hand',
  H: 'hand',
};

function isEditing(target) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
  );
}

window.addEventListener('keydown', (event) => {
  if (isEditing(event.target)) return;

  if (event.key === 'Escape') {
    ink.clearSelection();
    toolbar.closePopover();
    closeZoomMenu();
    return;
  }
  if ((event.key === 'Delete' || event.key === 'Backspace') && ink.selection.pageIndex >= 0) {
    event.preventDefault();
    ink.deleteSelection();
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  const tool = TOOL_KEYS[event.key];
  if (tool) {
    event.preventDefault();
    toolbar.setTool(tool);
    applyToolCursor();
    return;
  }
  if (event.key === 'PageDown' || event.key === 'ArrowRight') {
    view.scrollToPage(Math.min(view.currentPage + 1, store.pageCount - 1));
  } else if (event.key === 'PageUp' || event.key === 'ArrowLeft') {
    view.scrollToPage(Math.max(view.currentPage - 1, 0));
  }
});

// Holding space temporarily switches to panning, as in every drawing app.
let spaceHeld = false;
window.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || spaceHeld || isEditing(event.target)) return;
  spaceHeld = true;
  viewerEl.classList.add('tool-hand');
});
window.addEventListener('keyup', (event) => {
  if (event.code !== 'Space') return;
  spaceHeld = false;
  applyToolCursor();
});

function applyToolCursor() {
  // Rewriting className drops the class BrushCursor manages, so it always gets
  // the last word.
  viewerEl.className = `viewer tool-${tools.tool}`;
  brushCursor.update();
}
applyToolCursor();

toolbar.addEventListener('tool', () => {
  applyToolCursor();
  ink.clearSelection();
  saveSettings();
});
toolbar.addEventListener('settings', () => {
  saveSettings();
  // The nib shows the live size and colour, so it has to follow the sliders.
  brushCursor.update();
});

// Reserve room on whichever edge the palette is docked to, so it never sits on
// top of the page. The clearance is a little more than the palette itself, to
// leave the page visibly clear of it rather than flush against it.
const PALETTE_CLEARANCE = 104;
toolbar.addEventListener('dock', (event) => {
  const side = event.detail.dock;
  view.setEdgeInsets({ [side]: PALETTE_CLEARANCE });
});
view.setEdgeInsets({ [tools.dock || 'bottom']: PALETTE_CLEARANCE });

// --- panning ----------------------------------------------------------------

// Hand tool, middle-drag, right-drag and space-drag all pan. This runs at the
// capture phase so it wins over the ink engine when the hand tool is active.
viewerEl.addEventListener(
  'pointerdown',
  (event) => {
    const wantsPan =
      tools.tool === 'hand' || spaceHeld || event.button === 1 || event.button === 2;
    if (!wantsPan || event.pointerType === 'touch') return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = viewerEl.scrollLeft;
    const startTop = viewerEl.scrollTop;
    viewerEl.classList.add('panning');

    const move = (moveEvent) => {
      viewerEl.scrollLeft = startLeft - (moveEvent.clientX - startX);
      viewerEl.scrollTop = startTop - (moveEvent.clientY - startY);
    };
    const up = () => {
      viewerEl.classList.remove('panning');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  },
  { capture: true }
);

viewerEl.addEventListener('contextmenu', (event) => event.preventDefault());

// Palm rejection has to reach native touch scrolling too, not just the ink
// engine: while the pen is in use, touch-action is switched off so a resting
// hand cannot scroll the page mid-word.
let palmTimer = 0;
viewerEl.addEventListener(
  'pointerdown',
  (event) => {
    if (event.pointerType !== 'pen') return;
    viewerEl.style.touchAction = 'none';
    clearTimeout(palmTimer);
    palmTimer = setTimeout(() => {
      viewerEl.style.touchAction = '';
    }, 900);
  },
  { capture: true }
);

// --- view events ------------------------------------------------------------

// The view owns what is visually selected; the ink engine owns what Delete acts
// on. Clicking a text box or note went through the view only, so the engine's
// copy stayed empty and Delete did nothing. One event keeps them in step.
view.addEventListener('selection', (event) => {
  ink.selection = event.detail;
});

view.addEventListener('zoom', () => {
  zoomEl.textContent = `${Math.round(view.scale * 100)}%`;
  // The nib is drawn at true size, so it scales with the page.
  brushCursor.update();
});
view.addEventListener('page', (event) => {
  thumbs.setCurrent(event.detail.page);
});

thumbs.addEventListener('goto', (event) => view.scrollToPage(event.detail.page));
thumbs.addEventListener('warn', (event) => toast(event.detail.message, 'warn'));
thumbs.addEventListener('structural', () => {
  view.layout();
  view.refreshAll();
  thumbs.rebuild();
});

// --- drag and drop ----------------------------------------------------------

let dragDepth = 0;
window.addEventListener('dragenter', (event) => {
  if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
  dragDepth += 1;
  dropVeil.classList.add('on');
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropVeil.classList.remove('on');
});
window.addEventListener('drop', async (event) => {
  event.preventDefault();
  dragDepth = 0;
  dropVeil.classList.remove('on');
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  const filePath = window.inkwell.pathForFile?.(file) || file.path;
  if (filePath && /\.pdf$/i.test(filePath)) await openDocument(filePath);
  else toast('That is not a PDF', 'warn');
});

// --- recents on the welcome screen -----------------------------------------

async function renderRecents() {
  const list = await api.getRecents();
  const box = $('recents');
  if (!list.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.replaceChildren();
  const heading = document.createElement('div');
  heading.className = 'recents-title';
  heading.textContent = 'Recent';
  box.append(heading);

  for (const entry of list.slice(0, 6)) {
    const button = document.createElement('button');
    button.className = 'recent';
    button.type = 'button';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.name;
    const path = document.createElement('span');
    path.className = 'path';
    path.textContent = entry.path;
    button.append(name, path);
    button.addEventListener('click', () => openDocument(entry.path));
    box.append(button);
  }
}

// --- boot -------------------------------------------------------------------

window.addEventListener('beforeunload', () => {
  if (!closing && store.isDirty) flushSave();
});

renderRecents();
zoomEl.textContent = '100%';
api.ready();
