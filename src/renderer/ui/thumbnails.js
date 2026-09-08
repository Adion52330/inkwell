// The page sidebar: navigation plus the page operations.
//
// Thumbnails render lazily and at a fixed small width, so opening the sidebar
// on a long document costs one cheap raster per visible row rather than a burst
// of full-size renders.

import { icon } from './icons.js';
import { drawStroke, drawShape } from '../ink-render.js';

const THUMB_WIDTH = 150;

export class Thumbnails extends EventTarget {
  constructor({ mount, store, view }) {
    super();
    this.store = store;
    this.view = view;
    this.open = false;

    this.el = document.createElement('aside');
    this.el.className = 'sidebar';
    this.inner = document.createElement('div');
    this.inner.className = 'sidebar-inner';
    this.inner.innerHTML = '<div class="sidebar-head">Pages</div>';
    this.list = document.createElement('div');
    this.list.className = 'thumbs';
    this.inner.append(this.list);
    this.el.append(this.inner);
    mount.append(this.el);

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) this.#paint(Number(entry.target.dataset.index));
        }
      },
      { root: this.list, rootMargin: '200px 0px' }
    );
  }

  toggle(force) {
    this.open = force ?? !this.open;
    this.el.classList.toggle('open', this.open);
    if (this.open) this.rebuild();
    return this.open;
  }

  rebuild() {
    if (!this.open || !this.store.doc) return;
    this.observer.disconnect();
    this.list.replaceChildren();

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
      this.list.append(item);
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
    const item = this.list.querySelector(`.thumb[data-index="${index}"]`);
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
      for (const stroke of model.strokes) {
        if (stroke.tool === 'highlighter') drawStroke(ctx, stroke);
      }
      for (const object of model.objects) {
        if (object.kind === 'shape') drawShape(ctx, object);
      }
      for (const stroke of model.strokes) {
        if (stroke.tool !== 'highlighter') drawStroke(ctx, stroke);
      }
      ctx.restore();
    }
  }

  /** Force a repaint of one thumbnail after its page changed. */
  invalidate(index) {
    const item = this.list.querySelector(`.thumb[data-index="${index}"]`);
    if (!item) return;
    item.dataset.painted = 'no';
    this.#paint(index);
  }

  setCurrent(index) {
    for (const item of this.list.children) {
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
      for (const other of this.list.children) {
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
}
