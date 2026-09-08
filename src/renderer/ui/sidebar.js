// The sidebar: page thumbnails, search results and edit history.
//
// One panel at a time, chosen by a segmented control. Search results and
// history both want a tall scrolling list next to the document, and neither
// deserves its own permanent strip of screen, so they share this one.

import { icon } from './icons.js';
import { drawStroke, drawShape } from '../ink-render.js';

const THUMB_WIDTH = 150;

const TABS = [
  { id: 'pages', label: 'Pages' },
  { id: 'results', label: 'Results' },
  { id: 'history', label: 'History' },
];

function timeOfDay(at) {
  if (!at) return '';
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export class Sidebar extends EventTarget {
  constructor({ mount, store, view }) {
    super();
    this.store = store;
    this.view = view;
    this.open = false;
    this.tab = 'pages';

    this.el = document.createElement('aside');
    this.el.className = 'sidebar';

    this.inner = document.createElement('div');
    this.inner.className = 'sidebar-inner';

    // --- tab strip ---------------------------------------------------------
    this.tabStrip = document.createElement('div');
    this.tabStrip.className = 'sidebar-tabs segmented';
    this.tabButtons = new Map();
    for (const tab of TABS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = tab.label;
      button.addEventListener('click', () => this.setTab(tab.id));
      this.tabStrip.append(button);
      this.tabButtons.set(tab.id, button);
    }

    this.panels = {
      pages: document.createElement('div'),
      results: document.createElement('div'),
      history: document.createElement('div'),
    };
    this.panels.pages.className = 'thumbs panel';
    this.panels.results.className = 'result-list panel';
    this.panels.history.className = 'history-list panel';

    this.inner.append(this.tabStrip, this.panels.pages, this.panels.results, this.panels.history);
    this.el.append(this.inner);
    mount.append(this.el);

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) this.#paint(Number(entry.target.dataset.index));
        }
      },
      { root: this.panels.pages, rootMargin: '200px 0px' }
    );

    this.setTab('pages');
  }

  // --- visibility ------------------------------------------------------------

  toggle(force) {
    this.open = force ?? !this.open;
    this.el.classList.toggle('open', this.open);
    if (this.open) this.refresh();
    return this.open;
  }

  setTab(name) {
    this.tab = name;
    for (const [id, button] of this.tabButtons) button.classList.toggle('on', id === name);
    for (const [id, panel] of Object.entries(this.panels)) panel.hidden = id !== name;
    this.refresh();
    this.dispatchEvent(new CustomEvent('tab', { detail: { tab: name } }));
  }

  /** Rebuild whichever panel is showing. */
  refresh() {
    if (!this.open) return;
    if (this.tab === 'pages') this.rebuild();
    else if (this.tab === 'history') this.renderHistory();
  }

  // --- pages -----------------------------------------------------------------

  rebuild() {
    if (!this.open || !this.store.doc || this.tab !== 'pages') return;
    this.observer.disconnect();
    const list = this.panels.pages;
    list.replaceChildren();

    for (let index = 0; index < this.store.pageCount; index += 1) {
      const item = document.createElement('div');
      item.className = 'thumb';
      item.dataset.index = String(index);
      item.draggable = true;

      const canvas = document.createElement('canvas');
      const { width, height } = this.#thumbSize(index);
      canvas.style.aspectRatio = `${width} / ${height}`;
      item.append(canvas);

      const label = document.createElement('span');
      label.className = 'thumb-label';
      label.textContent = String(index + 1);

      const actions = document.createElement('div');
      actions.className = 'thumb-actions';
      for (const [name, title, handler] of [
        ['rotateLeft', 'Rotate left', () => this.#rotate(index, -90)],
        ['rotateRight', 'Rotate right', () => this.#rotate(index, 90)],
        ['trash', 'Delete page', () => this.#delete(index)],
      ]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.title = title;
        button.innerHTML = icon(name);
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          handler();
        });
        actions.append(button);
      }

      item.append(label, actions);
      item.addEventListener('click', () => {
        this.dispatchEvent(new CustomEvent('goto', { detail: { page: index } }));
      });

      this.#wireDrag(item, index);
      list.append(item);
      this.observer.observe(item);
    }
    this.setCurrent(this.view.currentPage);
  }

  #thumbSize(index) {
    const { width, height } = this.store.pageSize(index);
    const rotated = (this.store.page(index)?.rotation || 0) % 180 !== 0;
    return { width: rotated ? height : width, height: rotated ? width : height };
  }

  async #paint(index) {
    const item = this.panels.pages.querySelector(`.thumb[data-index="${index}"]`);
    if (!item || item.dataset.painted === 'yes') return;
    item.dataset.painted = 'yes';

    const canvas = item.querySelector('canvas');
    const { width, height } = this.#thumbSize(index);
    const scale = THUMB_WIDTH / width;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * scale * dpr);
    canvas.height = Math.round(height * scale * dpr);

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const source = this.view.sourceForPage(index);
    if (source) {
      try {
        const page = await source.doc.getPage(source.pageNumber);
        const rotation = (page.rotate + (this.store.page(index)?.rotation || 0)) % 360;
        const viewport = page.getViewport({ scale: scale * dpr, rotation });
        await page.render({ canvasContext: ctx, viewport }).promise;
      } catch {
        item.dataset.painted = 'no';
        return;
      }
    }

    // Ink is drawn into the thumbnail too, so the sidebar shows which pages you
    // have actually written on.
    const model = this.store.page(index);
    if (model) {
      ctx.save();
      this.view.applyPageTransform(ctx, index, scale * dpr);
      for (const stroke of model.strokes) if (stroke.tool === 'highlighter') drawStroke(ctx, stroke);
      for (const object of model.objects) if (object.kind === 'shape') drawShape(ctx, object);
      for (const stroke of model.strokes) if (stroke.tool !== 'highlighter') drawStroke(ctx, stroke);
      ctx.restore();
    }
  }

  invalidate(index) {
    const item = this.panels.pages.querySelector(`.thumb[data-index="${index}"]`);
    if (!item) return;
    item.dataset.painted = 'no';
    this.#paint(index);
  }

  setCurrent(index) {
    for (const item of this.panels.pages.children) {
      item.classList.toggle('current', Number(item.dataset.index) === index);
    }
  }

  #rotate(index, delta) {
    this.store.rotatePage(index, delta);
    this.dispatchEvent(new CustomEvent('structural', { detail: { page: index } }));
  }

  #delete(index) {
    if (!this.store.deletePage(index)) {
      this.dispatchEvent(
        new CustomEvent('warn', { detail: { message: 'A document needs at least one page' } })
      );
      return;
    }
    this.dispatchEvent(new CustomEvent('structural', { detail: { page: index } }));
  }

  // Drag-to-reorder. HTML5 drag and drop is used rather than pointer events so
  // the browser supplies the drag image and autoscroll for free.
  #wireDrag(item, index) {
    item.addEventListener('dragstart', (event) => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      for (const other of this.panels.pages.children) {
        other.classList.remove('drop-before', 'drop-after');
      }
    });
    item.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const rect = item.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      item.classList.toggle('drop-after', after);
      item.classList.toggle('drop-before', !after);
    });
    item.addEventListener('dragleave', () => {
      item.classList.remove('drop-before', 'drop-after');
    });
    item.addEventListener('drop', (event) => {
      event.preventDefault();
      const from = Number(event.dataTransfer.getData('text/plain'));
      const rect = item.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      let to = after ? index + 1 : index;
      // Removing the dragged page first shifts everything after it up by one.
      if (from < to) to -= 1;
      item.classList.remove('drop-before', 'drop-after');
      if (from === to) return;
      this.store.movePage(from, to);
      this.dispatchEvent(new CustomEvent('structural', { detail: { page: to } }));
    });
  }

  // --- search results --------------------------------------------------------

  /**
   * Show every match grouped by the page it sits on, so a result is something
   * you can navigate by rather than just a count.
   */
  renderResults(status) {
    const list = this.panels.results;
    list.replaceChildren();

    if (!status.query) {
      list.append(this.#empty('Type in the find bar to search this document.'));
      return;
    }
    if (!status.total) {
      list.append(this.#empty(status.scanning ? 'Searching…' : `No matches for “${status.query}”.`));
      return;
    }

    const heading = document.createElement('div');
    heading.className = 'sidebar-head';
    heading.textContent = `${status.total} match${status.total === 1 ? '' : 'es'}${
      status.scanning ? ' so far…' : ''
    }`;
    list.append(heading);

    let lastPage = -1;
    status.matches.forEach((match, index) => {
      if (match.page !== lastPage) {
        lastPage = match.page;
        const group = document.createElement('div');
        group.className = 'result-page';
        group.textContent = `Page ${match.page + 1}`;
        list.append(group);
      }

      const row = document.createElement('button');
      row.type = 'button';
      row.className = `result${index === status.index ? ' on' : ''}`;
      const before = document.createElement('span');
      before.textContent = match.snippet?.before ?? '';
      const hit = document.createElement('mark');
      hit.textContent = match.snippet?.hit ?? '';
      const after = document.createElement('span');
      after.textContent = match.snippet?.after ?? '';
      row.append(before, hit, after);
      row.addEventListener('click', () => {
        this.dispatchEvent(new CustomEvent('goto-match', { detail: { index } }));
      });
      list.append(row);
    });

    // Keep the active result in view as Enter steps through them.
    list.querySelector('.result.on')?.scrollIntoView({ block: 'nearest' });
  }

  // --- history ---------------------------------------------------------------

  /**
   * The document's edit history, newest first. Entries below the applied point
   * have been undone and are shown greyed; clicking any entry travels to that
   * state, which is undo/redo without counting keystrokes.
   */
  renderHistory() {
    const list = this.panels.history;
    list.replaceChildren();
    if (!this.store.doc) {
      list.append(this.#empty('Open a document to see its edit history.'));
      return;
    }

    const { entries, applied } = this.store.history();
    if (!entries.length) {
      list.append(this.#empty('Nothing has been changed yet.'));
      return;
    }

    const heading = document.createElement('div');
    heading.className = 'sidebar-head';
    heading.textContent = `${entries.length} change${entries.length === 1 ? '' : 's'}`;
    list.append(heading);

    // Newest first: the most recent change is the one you are most likely to
    // want to step back past.
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `history-row${entry.undone ? ' undone' : ''}${
        i === applied - 1 ? ' current' : ''
      }`;

      const label = document.createElement('span');
      label.className = 'history-label';
      label.textContent = entry.label;

      const meta = document.createElement('span');
      meta.className = 'history-meta';
      meta.textContent = [entry.page != null ? `page ${entry.page + 1}` : null, timeOfDay(entry.at)]
        .filter(Boolean)
        .join(' · ');

      row.append(label, meta);
      row.title = entry.undone ? 'Redo up to here' : 'Go back to this point';
      row.addEventListener('click', () => {
        this.dispatchEvent(new CustomEvent('travel', { detail: { count: i + 1 } }));
      });
      list.append(row);
    }

    const base = document.createElement('button');
    base.type = 'button';
    base.className = `history-row base${applied === 0 ? ' current' : ''}`;
    base.innerHTML = '<span class="history-label">Original document</span>';
    base.title = 'Undo everything';
    base.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('travel', { detail: { count: 0 } }));
    });
    list.append(base);
  }

  #empty(message) {
    const node = document.createElement('p');
    node.className = 'sidebar-empty';
    node.textContent = message;
    return node;
  }
}
