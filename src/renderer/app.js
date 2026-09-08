// Application wiring: document lifecycle, autosave, commands and shortcuts.

import { Store } from './store.js';
import { PdfView, ZOOM_PRESETS } from './pdfview.js';
import { InkEngine } from './ink.js';
import { Toolbar } from './ui/toolbar.js';
import { Sidebar } from './ui/sidebar.js';
import { BrushCursor } from './ui/cursor.js';
import { DropdownMenu } from './ui/menu.js';
import { icon } from './ui/icons.js';
import { buildAnnotatedPdf, suggestExportName } from './export.js';
import { Search } from './search.js';

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
const zoomEl = $('zoom-readout');
const dropVeil = $('drop-veil');

// --- core objects -----------------------------------------------------------

const store = new Store();
const view = new PdfView({ container: viewerEl, store, tools });
const ink = new InkEngine({ viewer: viewerEl, store, tools, view });
const sidebar = new Sidebar({ mount: bodyEl, store, view });
const toolbar = new Toolbar({ mount: bodyEl, tools });
const brushCursor = new BrushCursor({ viewer: viewerEl, tools, view });
const search = new Search({ view, store });

// The sidebar must sit before the viewer in the flex row.
bodyEl.insertBefore(sidebar.el, viewerEl);

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
$('btn-more').innerHTML = icon('more');
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
zoomMenu.className = 'menu zoom-menu';
zoomMenu.hidden = true;
document.body.append(zoomMenu);

function buildZoomMenu() {
  zoomMenu.replaceChildren();
  const item = (label, detail, onPick, isCurrent = false) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menu-item zoom-item${isCurrent ? ' on' : ''}`;
    const name = document.createElement('span');
    name.className = 'menu-label';
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
  rule.className = 'menu-rule';
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

function toggleSidebar(tab) {
  if (tab && !sidebar.open) sidebar.setTab(tab);
  else if (tab && sidebar.tab !== tab) {
    sidebar.setTab(tab);
    $('btn-sidebar').classList.add('on');
    return;
  }
  const open = sidebar.toggle();
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

// --- find in document -------------------------------------------------------

const searchBar = $('search-bar');
const searchInput = $('search-input');
const searchCount = $('search-count');
$('search-icon').innerHTML = icon('search', 15);
$('search-prev').innerHTML = icon('chevronUp');
$('search-next').innerHTML = icon('chevronDown');
$('search-close').innerHTML = icon('close');

let searchTimer = 0;

function openSearch() {
  if (!store.doc) return;
  searchBar.hidden = false;
  requestAnimationFrame(() => searchBar.classList.add('on'));
  // Results live in the sidebar, so bring it out with the find bar rather than
  // making the page count the only thing you can see.
  if (!sidebar.open) toggleSidebar('results');
  else sidebar.setTab('results');
  searchInput.focus();
  searchInput.select();
}

function closeSearch() {
  searchBar.classList.remove('on');
  searchBar.hidden = true;
  search.reset();
  searchCount.textContent = '';
  // Hand the sidebar back to the pages it was showing before.
  if (sidebar.tab === 'results') sidebar.setTab('pages');
}

$('search-close').addEventListener('click', closeSearch);
$('search-next').addEventListener('click', () => search.next());
$('search-prev').addEventListener('click', () => search.previous());

searchInput.addEventListener('input', () => {
  // Debounced: every keystroke would otherwise restart a full-document scan.
  clearTimeout(searchTimer);
  const query = searchInput.value;
  searchTimer = setTimeout(() => search.run(query), 180);
});

searchInput.addEventListener('keydown', (event) => {
  // Typing must not trigger tool shortcuts, but Ctrl-combinations still should:
  // Ctrl+F from inside the field, for instance, or Ctrl+G for the next match.
  if (!event.ctrlKey && !event.metaKey) event.stopPropagation();
  if (event.key === 'Enter') {
    event.preventDefault();
    if (event.shiftKey) search.previous();
    else search.next();
  } else if (event.key === 'Escape') {
    closeSearch();
  }
});

search.addEventListener('status', (event) => {
  const { total, index, scanning, query } = event.detail;
  if (!query) {
    searchCount.textContent = '';
  } else if (!total) {
    searchCount.textContent = scanning ? 'searching…' : 'no matches';
  } else {
    searchCount.textContent = `${index + 1} of ${total}${scanning ? '…' : ''}`;
  }
  searchBar.classList.toggle('empty', !!query && !total && !scanning);
  $('search-next').disabled = total === 0;
  $('search-prev').disabled = total === 0;
  if (sidebar.open && sidebar.tab === 'results') sidebar.renderResults(event.detail);
});

// --- page indicator ---------------------------------------------------------

const pageInput = $('page-input');
const pageTotalEl = $('page-count');

function showPageNumber(index) {
  // Don't fight the user while they are typing a page number.
  if (document.activeElement === pageInput) return;
  pageInput.value = store.doc ? String(index + 1) : '–';
}

function commitPageNumber() {
  if (!store.doc) return;
  const wanted = parseInt(pageInput.value, 10);
  if (Number.isNaN(wanted)) {
    showPageNumber(view.currentPage);
    return;
  }
  const index = Math.min(Math.max(wanted, 1), store.pageCount) - 1;
  view.scrollToPage(index);
  pageInput.value = String(index + 1);
  pageInput.blur();
}

pageInput.addEventListener('focus', () => pageInput.select());
pageInput.addEventListener('keydown', (event) => {
  // Typing here must never reach the tool shortcuts.
  event.stopPropagation();
  if (event.key === 'Enter') commitPageNumber();
  else if (event.key === 'Escape') {
    showPageNumber(view.currentPage);
    pageInput.blur();
  }
});
pageInput.addEventListener('blur', () => showPageNumber(view.currentPage));

// --- overflow menu ----------------------------------------------------------

// Recents are fetched asynchronously but the menu is built synchronously when
// it opens, so the last known list is kept here.
let recentFiles = [];

const overflowMenu = new DropdownMenu({
  anchor: $('btn-more'),
  align: 'right',
  className: 'overflow-menu',
  items: () => {
    const hasDoc = !!store.doc;
    return [
      { label: 'Open PDF…', hint: 'Ctrl O', onSelect: () => openViaDialog() },
      ...(recentFiles.length
        ? [
            { heading: 'Recent' },
            ...recentFiles.slice(0, 5).map((entry) => ({
              label: entry.name,
              title: entry.path,
              onSelect: () => openDocument(entry.path),
            })),
          ]
        : []),
      { separator: true },
      { label: 'Save notes', hint: 'Ctrl S', disabled: !hasDoc, onSelect: () => command('save') },
      {
        label: 'Export annotated PDF…',
        hint: 'Ctrl E',
        disabled: !hasDoc,
        onSelect: () => exportDocument(),
      },
      { separator: true },
      { label: 'Undo', hint: 'Ctrl Z', disabled: !store.canUndo, onSelect: () => command('undo') },
      {
        label: 'Redo',
        hint: 'Ctrl ⇧ Z',
        disabled: !store.canRedo,
        onSelect: () => command('redo'),
      },
      {
        label: 'Select all ink',
        hint: 'Ctrl A',
        disabled: !hasDoc,
        onSelect: () => command('select-all'),
      },
      {
        label: 'Delete selection',
        hint: 'Del',
        disabled: ink.selection.pageIndex < 0,
        onSelect: () => command('delete'),
      },
      { separator: true },
      { label: 'Find…', hint: 'Ctrl F', disabled: !hasDoc, onSelect: () => openSearch() },
      {
        label: 'Pages sidebar',
        hint: 'Ctrl B',
        checked: sidebar.open,
        onSelect: () => toggleSidebar('pages'),
      },
      { separator: true },
      { heading: 'Pages' },
      {
        label: 'Insert blank page after this one',
        disabled: !hasDoc,
        onSelect: () => command('insert-page'),
      },
      { label: 'Append a PDF…', disabled: !hasDoc, onSelect: () => command('append-pdf') },
      { separator: true },
      { label: 'Fit width', hint: 'Ctrl 1', disabled: !hasDoc, onSelect: () => view.applyFit('width') },
      { label: 'Fit page', hint: 'Ctrl 2', disabled: !hasDoc, onSelect: () => view.applyFit('page') },
      { label: 'Actual size', hint: 'Ctrl 0', disabled: !hasDoc, onSelect: () => view.zoomTo(1) },
      { separator: true },
      { label: 'Full screen', hint: 'F11', onSelect: () => api.toggleFullScreen() },
      { label: 'Developer tools', hint: 'Ctrl ⇧ I', onSelect: () => api.toggleDevTools() },
      { separator: true },
      {
        label: 'Close document',
        hint: 'Ctrl W',
        disabled: !hasDoc,
        onSelect: () => command('close-doc'),
      },
      { label: 'Quit Inkwell', hint: 'Ctrl Q', danger: true, onSelect: () => api.quit() },
    ];
  },
});

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
        toast('The PDF changed since these notes were made - ink may not line up', 'warn');
      }
    }

    view.layout();
    view.applyFit('width');
    view.scrollToPage(0, 'auto');
    ink.clearSelection();

    search.reset();
    // The main process records this file as recent as it reads it, so the
    // cached list the overflow menu builds from is now a document behind.
    // Without this refresh, the file you just opened never appears in Recent
    // and neither does anything opened after it, until the app restarts.
    renderRecents();
    welcomeEl.hidden = true;
    pageTotalEl.textContent = String(store.pageCount);
    showPageNumber(0);
    updateWindowTitle();
    if (sidebar.open) sidebar.refresh();
    updateHistoryButtons();
  } catch (err) {
    console.error(err);
    toast(`Could not open that PDF: ${err.message}`, 'error');
  }
}

/**
 * The window's own title bar is the document's name, and carries the unsaved
 * marker - the usual convention, and the reason none of this needs repeating
 * inside the app's toolbar.
 */
function updateWindowTitle() {
  if (!store.doc) {
    document.title = 'Inkwell';
    return;
  }
  document.title = `${store.isDirty ? '• ' : ''}${store.doc.name} - Inkwell`;
}

/**
 * Put unsaved work to the user before it would be lost.
 * Returns 'save' | 'discard' | 'cancel'; 'save' has already been written by the
 * time this resolves. Discarding simply leaves the sidecar as it was on disk -
 * the last saved state - so nothing has to be rolled back in memory.
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
  closeSearch();
  welcomeEl.hidden = false;
  pageTotalEl.textContent = '–';
  showPageNumber(0);
  updateWindowTitle();
  renderRecents();
  return true;
}

// --- autosave ---------------------------------------------------------------

store.addEventListener('change', (event) => {
  const { pages, structural } = event.detail;
  if (structural) {
    view.layout();
    view.refreshAll();
    if (sidebar.open) sidebar.refresh();
  } else if (pages) {
    for (const index of pages) {
      view.repaintInk(index);
      // Text boxes and notes live in the DOM, not on the ink canvas, so they
      // need their own rebuild - otherwise a deleted note stays on screen and
      // an undone deletion never comes back.
      view.renderObjects(index);
      if (sidebar.open && sidebar.tab === 'pages') sidebar.invalidate(index);
    }
  }
  updateHistoryButtons();
  updateWindowTitle();
  if (sidebar.open && sidebar.tab === 'history') sidebar.renderHistory();
  if (store.doc) pageTotalEl.textContent = String(store.pageCount);
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
  updateWindowTitle();
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
    // Page geometry is measured lazily, so a page carrying ink restored from a
    // sidecar may never have been on screen. Resolve those before flattening,
    // or their ink would be placed through an assumed matrix.
    const annotated = store.doc.pages
      .map((page, index) => (page.strokes.length || page.objects.length ? index : -1))
      .filter((index) => index >= 0);
    await view.ensureSizes(annotated);

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
    case 'find':
      openSearch();
      break;
    case 'find-next':
      search.next();
      break;
    case 'find-previous':
      search.previous();
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
  8: 'select',
  h: 'hand',
  H: 'hand',
};

function isEditing(target) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
  );
}

/**
 * Shortcuts that used to come from the native menu bar. With the menu gone they
 * have to be bound here - which is also the only place that can tell whether a
 * text box has focus, so typing never triggers them.
 */
function handleModifierShortcut(event) {
  const key = event.key.toLowerCase();
  const shift = event.shiftKey;
  const actions = {
    o: () => command('open'),
    s: () => command('save'),
    e: () => command('export'),
    w: () => command('close-doc'),
    q: () => api.quit(),
    z: () => command(shift ? 'redo' : 'undo'),
    y: () => command('redo'),
    a: () => command('select-all'),
    f: () => openSearch(),
    g: () => command(shift ? 'find-previous' : 'find-next'),
    b: () => toggleSidebar(),
    i: () => (shift ? api.toggleDevTools() : null),
    0: () => view.zoomTo(1),
    1: () => view.applyFit('width'),
    2: () => view.applyFit('page'),
    '=': () => stepZoom(1),
    '+': () => stepZoom(1),
    '-': () => stepZoom(-1),
    _: () => stepZoom(-1),
  };
  const action = actions[key];
  if (!action) return false;
  // Copy is left to the platform so selecting PDF text and pressing Ctrl+C
  // behaves normally.
  event.preventDefault();
  action();
  return true;
}

window.addEventListener('keydown', (event) => {
  if (isEditing(event.target)) return;

  if (event.key === 'F11') {
    event.preventDefault();
    api.toggleFullScreen();
    return;
  }

  if (event.key === 'Escape') {
    ink.clearSelection();
    toolbar.closePopover();
    closeZoomMenu();
    if (!searchBar.hidden) closeSearch();
    return;
  }
  if ((event.key === 'Delete' || event.key === 'Backspace') && ink.selection.pageIndex >= 0) {
    event.preventDefault();
    ink.deleteSelection();
    return;
  }
  if (event.ctrlKey || event.metaKey) {
    handleModifierShortcut(event);
    return;
  }
  if (event.altKey) return;

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
  sidebar.setCurrent(event.detail.page);
  showPageNumber(event.detail.page);
});

sidebar.addEventListener('goto', (event) => view.scrollToPage(event.detail.page));
sidebar.addEventListener('goto-match', (event) => search.goTo(event.detail.index));
sidebar.addEventListener('travel', (event) => {
  if (store.travelTo(event.detail.count)) ink.clearSelection();
});
sidebar.addEventListener('tab', (event) => {
  if (event.detail.tab === 'results') sidebar.renderResults(search.status);
});
sidebar.addEventListener('warn', (event) => toast(event.detail.message, 'warn'));
sidebar.addEventListener('structural', () => {
  view.layout();
  view.refreshAll();
  sidebar.rebuild();
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
  recentFiles = list;
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
