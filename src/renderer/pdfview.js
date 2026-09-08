// The viewer: page layout, rasterisation, zoom, and the ink compositor.
//
// Each page owns four stacked layers:
//
//   pdf-layer   the rasterised page from pdf.js
//   ink-layer   committed strokes, repainted only when they change
//   wet-layer   the stroke currently under the pointer, plus selection chrome
//   obj-layer   text boxes and sticky notes, as real DOM
//
// Keeping the wet stroke on its own canvas is what makes drawing feel instant:
// a new sample repaints a transparent overlay, never the page underneath.

import * as pdfjs from 'pdfjs-dist';
import { drawStroke, drawShape } from './ink-render.js';
import { createObjectElement, defaultTextObject, defaultNoteObject, focusObject } from './objects.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.mjs', document.baseURI).href;

const MIN_SCALE = 0.2;
const MAX_SCALE = 8;
const PAGE_GAP = 18;

const clamp = (value, lo, hi) => (value < lo ? lo : value > hi ? hi : value);

export class PdfView extends EventTarget {
  constructor({ container, store, tools }) {
    super();
    this.container = container; // the scrolling element
    this.store = store;
    this.tools = tools;

    this.pdfDoc = null;
    /** Extra PDFs merged in by "append"; keyed by an opaque source id. */
    this.sources = new Map();
    this.sourceBytes = new Map();

    this.scale = 1;
    this.fitMode = 'width';
    this.currentPage = 0;
    this.pageEls = [];
    this.selection = { pageIndex: -1, strokeIds: new Set(), objectIds: new Set() };
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);

    this.pagesEl = document.createElement('div');
    this.pagesEl.className = 'pages';
    container.append(this.pagesEl);

    // Pages far from the viewport give their canvases back so a 500-page
    // document does not hold half a gigabyte of bitmaps.
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number(entry.target.dataset.index);
          if (entry.isIntersecting) this.#renderPage(index);
          else this.#releasePage(index);
        }
      },
      { root: container, rootMargin: '120% 0px', threshold: 0 }
    );

    this.#installScrollTracking();
    this.#installZoomGestures();

    window.addEventListener('resize', () => {
      const nextDpr = Math.min(window.devicePixelRatio || 1, 3);
      if (nextDpr !== this.dpr) {
        this.dpr = nextDpr;
        this.refreshAll();
      }
      if (this.fitMode) this.applyFit(this.fitMode);
    });
  }

  // --- document lifecycle --------------------------------------------------

  async load(bytes) {
    await this.unload();
    const task = pdfjs.getDocument({
      data: bytes,
      cMapUrl: new URL('cmaps/', document.baseURI).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('standard_fonts/', document.baseURI).href,
      wasmUrl: new URL('wasm/', document.baseURI).href,
      iccUrl: new URL('iccs/', document.baseURI).href,
    });
    this.pdfDoc = await task.promise;

    // Page geometry is read once up front so layout, hit-testing and export
    // never have to await pdf.js again.
    const sizes = [];
    for (let i = 1; i <= this.pdfDoc.numPages; i += 1) {
      const page = await this.pdfDoc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      sizes.push({
        width: viewport.width,
        height: viewport.height,
        rotate: page.rotate,
        // pdf.js's user-space → viewport matrix. The exporter inverts it to put
        // ink back into PDF coordinates exactly, whatever the page's own
        // /Rotate and MediaBox origin happen to be.
        transform: viewport.transform,
      });
    }
    return { pageCount: this.pdfDoc.numPages, sizes };
  }

  async unload() {
    if (this.pdfDoc) {
      await this.pdfDoc.destroy().catch(() => {});
      this.pdfDoc = null;
    }
    for (const doc of this.sources.values()) await doc.destroy().catch(() => {});
    this.sources.clear();
    this.sourceBytes.clear();
    this.observer.disconnect();
    this.pagesEl.replaceChildren();
    this.pageEls = [];
  }

  /** Register an extra PDF whose pages get appended to this document. */
  async addSource(key, bytes) {
    // pdf.js takes ownership of the buffer it is handed, so keep a copy for the
    // exporter to read later.
    this.sourceBytes.set(key, bytes.slice());
    const doc = await pdfjs.getDocument({ data: bytes }).promise;
    this.sources.set(key, doc);
    const sizes = [];
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      sizes.push({
        width: viewport.width,
        height: viewport.height,
        rotate: page.rotate,
        transform: viewport.transform,
      });
    }
    return { pageCount: doc.numPages, sizes };
  }

  // --- layout --------------------------------------------------------------

  /** (Re)build the page elements from the store's current page list. */
  layout() {
    this.observer.disconnect();
    this.pagesEl.replaceChildren();
    this.pageEls = [];

    const count = this.store.pageCount;
    for (let index = 0; index < count; index += 1) {
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.index = String(index);

      const pdfLayer = document.createElement('canvas');
      pdfLayer.className = 'layer pdf-layer';
      const inkLayer = document.createElement('canvas');
      inkLayer.className = 'layer ink-layer';
      const wetLayer = document.createElement('canvas');
      wetLayer.className = 'layer wet-layer';
      const objLayer = document.createElement('div');
      objLayer.className = 'layer obj-layer';

      const number = document.createElement('div');
      number.className = 'page-number';
      number.textContent = String(index + 1);

      el.append(pdfLayer, inkLayer, wetLayer, objLayer, number);
      this.pagesEl.append(el);
      this.pageEls.push(el);
      this.observer.observe(el);
    }
    this.applySizes();
    this.dispatchEvent(new CustomEvent('layout'));
  }

  /** Displayed CSS size of a page, accounting for user rotation. */
  displaySize(index) {
    const { width, height } = this.store.pageSize(index);
    const rotation = this.store.page(index)?.rotation || 0;
    const swapped = rotation % 180 !== 0;
    return {
      width: (swapped ? height : width) * this.scale,
      height: (swapped ? width : height) * this.scale,
    };
  }

  applySizes() {
    for (let index = 0; index < this.pageEls.length; index += 1) {
      const el = this.pageEls[index];
      const { width, height } = this.displaySize(index);
      el.style.width = `${width}px`;
      el.style.height = `${height}px`;
    }
    this.pagesEl.style.gap = `${PAGE_GAP}px`;
  }

  // --- coordinate mapping --------------------------------------------------

  /** Find the page under an event target. */
  pageAt(target) {
    const el = target instanceof Element ? target.closest('.page') : null;
    if (!el) return null;
    return { el, pageIndex: Number(el.dataset.index) };
  }

  /**
   * Client coordinates → page space (PDF points, top-left origin, unrotated).
   * The inverse of the transform installed by #setPageTransform.
   */
  toPage(index, clientX, clientY) {
    const el = this.pageEls[index];
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    const cx = (clientX - rect.left) / this.scale;
    const cy = (clientY - rect.top) / this.scale;
    const { width, height } = this.store.pageSize(index);
    switch (this.store.page(index)?.rotation || 0) {
      case 90:
        return { x: cy, y: height - cx };
      case 180:
        return { x: width - cx, y: height - cy };
      case 270:
        return { x: width - cy, y: cx };
      default:
        return { x: cx, y: cy };
    }
  }

  /** Page space → client coordinates, for positioning DOM objects. */
  toClientOffset(index, x, y) {
    const { width, height } = this.store.pageSize(index);
    const s = this.scale;
    switch (this.store.page(index)?.rotation || 0) {
      case 90:
        return { left: (height - y) * s, top: x * s };
      case 180:
        return { left: (width - x) * s, top: (height - y) * s };
      case 270:
        return { left: y * s, top: (width - x) * s };
      default:
        return { left: x * s, top: y * s };
    }
  }

  /**
   * Put a canvas context into page space so callers can draw in PDF points and
   * ignore zoom, device pixel ratio and rotation entirely.
   */
  #setPageTransform(ctx, index) {
    this.applyPageTransform(ctx, index, this.scale * this.dpr);
  }

  /**
   * Public form of the above, taking an explicit scale. The thumbnail sidebar
   * uses it to draw ink at its own much smaller scale.
   */
  applyPageTransform(ctx, index, k) {
    const { width, height } = this.store.pageSize(index);
    switch (this.store.page(index)?.rotation || 0) {
      case 90:
        ctx.setTransform(0, k, -k, 0, height * k, 0);
        break;
      case 180:
        ctx.setTransform(-k, 0, 0, -k, width * k, height * k);
        break;
      case 270:
        ctx.setTransform(0, -k, k, 0, 0, width * k);
        break;
      default:
        ctx.setTransform(k, 0, 0, k, 0, 0);
        break;
    }
  }

  #sizeCanvas(canvas, index) {
    const { width, height } = this.displaySize(index);
    const backingWidth = Math.max(1, Math.round(width * this.dpr));
    const backingHeight = Math.max(1, Math.round(height * this.dpr));
    if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
      canvas.width = backingWidth;
      canvas.height = backingHeight;
    }
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }

  // --- rasterising ---------------------------------------------------------

  /** Which document and page number backs a viewer page, if any. */
  sourceForPage(index) {
    return this.#sourceFor(index);
  }

  #sourceFor(index) {
    const page = this.store.page(index);
    if (!page) return null;
    if (page.inserted) return null; // a blank page inserted by the user
    if (page.source) {
      const doc = this.sources.get(page.source);
      return doc ? { doc, pageNumber: page.sourceIndex + 1 } : null;
    }
    const sourceIndex = this.store.doc.order[index];
    if (sourceIndex == null || sourceIndex < 0 || !this.pdfDoc) return null;
    return { doc: this.pdfDoc, pageNumber: sourceIndex + 1 };
  }

  async #renderPage(index) {
    const el = this.pageEls[index];
    if (!el) return;
    const canvas = el.querySelector('.pdf-layer');
    const signature = `${this.scale.toFixed(3)}:${this.dpr}:${this.store.page(index)?.rotation || 0}`;
    if (el.dataset.rendered === signature) {
      this.repaintInk(index);
      this.#renderObjects(index);
      return;
    }

    // A render already running for an older zoom level is worthless now.
    if (el._renderTask) {
      el._renderTask.cancel();
      el._renderTask = null;
    }

    this.#sizeCanvas(canvas, index);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const source = this.#sourceFor(index);
    if (source) {
      try {
        const page = await source.doc.getPage(source.pageNumber);
        const rotation = (page.rotate + (this.store.page(index)?.rotation || 0)) % 360;
        const viewport = page.getViewport({ scale: this.scale * this.dpr, rotation });
        const task = page.render({ canvasContext: ctx, viewport });
        el._renderTask = task;
        await task.promise;
        el._renderTask = null;
      } catch (err) {
        if (err?.name !== 'RenderingCancelledException') {
          console.error(`[inkwell] failed to render page ${index + 1}`, err);
        }
        return;
      }
    }

    el.dataset.rendered = signature;
    el.classList.add('ready');
    this.repaintInk(index);
    this.#renderObjects(index);
  }

  #releasePage(index) {
    const el = this.pageEls[index];
    if (!el) return;
    if (el._renderTask) {
      el._renderTask.cancel();
      el._renderTask = null;
    }
    // Zeroing a canvas is what actually frees its backing store.
    for (const canvas of el.querySelectorAll('canvas')) {
      canvas.width = 0;
      canvas.height = 0;
    }
    delete el.dataset.rendered;
    el.classList.remove('ready');
  }

  refreshAll() {
    for (const el of this.pageEls) delete el.dataset.rendered;
    this.applySizes();
    for (const el of this.pageEls) {
      const rect = el.getBoundingClientRect();
      const visible = rect.bottom > -window.innerHeight && rect.top < window.innerHeight * 2;
      if (visible) this.#renderPage(Number(el.dataset.index));
    }
  }

  // --- ink layers ----------------------------------------------------------

  /**
   * Repaint a page's committed strokes.
   * @param {Set<string>} [exclude] ids to leave out — how the eraser shows its
   *   work before the deletion is actually committed on pointer-up.
   */
  repaintInk(index, exclude) {
    const el = this.pageEls[index];
    const page = this.store.page(index);
    if (!el || !page || !el.dataset.rendered) return;
    const canvas = el.querySelector('.ink-layer');
    this.#sizeCanvas(canvas, index);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.#setPageTransform(ctx, index);

    // Highlighter first, so pen strokes always read on top of a wash.
    for (const stroke of page.strokes) {
      if (stroke.tool !== 'highlighter') continue;
      if (exclude?.has(stroke.id)) continue;
      drawStroke(ctx, stroke);
    }
    for (const object of page.objects) {
      if (object.kind !== 'shape' || exclude?.has(object.id)) continue;
      drawShape(ctx, object);
    }
    for (const stroke of page.strokes) {
      if (stroke.tool === 'highlighter') continue;
      if (exclude?.has(stroke.id)) continue;
      drawStroke(ctx, stroke);
    }
  }

  wetCtx(index) {
    const el = this.pageEls[index];
    if (!el) return null;
    const canvas = el.querySelector('.wet-layer');
    this.#sizeCanvas(canvas, index);
    const ctx = canvas.getContext('2d');
    this.#setPageTransform(ctx, index);
    return ctx;
  }

  clearWet(index) {
    const el = this.pageEls[index];
    if (!el) return;
    const canvas = el.querySelector('.wet-layer');
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Selection chrome lives on the wet layer, so it has to be redrawn every
    // time that layer is cleared.
    if (this.selection.pageIndex === index) this.#drawSelection(index);
  }

  setSelection(selection) {
    const previous = this.selection.pageIndex;
    this.selection = selection;
    if (previous >= 0 && previous !== selection.pageIndex) this.clearWet(previous);
    if (selection.pageIndex >= 0) this.clearWet(selection.pageIndex);
    this.#renderObjects(selection.pageIndex);
    this.dispatchEvent(new CustomEvent('selection', { detail: selection }));
  }

  #drawSelection(index) {
    const page = this.store.page(index);
    if (!page) return;
    const { strokeIds } = this.selection;
    if (!strokeIds.size) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const stroke of page.strokes) {
      if (!strokeIds.has(stroke.id)) continue;
      x0 = Math.min(x0, stroke.bbox[0]);
      y0 = Math.min(y0, stroke.bbox[1]);
      x1 = Math.max(x1, stroke.bbox[2]);
      y1 = Math.max(y1, stroke.bbox[3]);
    }
    if (!Number.isFinite(x0)) return;
    const ctx = this.wetCtx(index);
    const pad = 6;
    ctx.save();
    ctx.lineWidth = 1.5 / this.scale;
    ctx.setLineDash([5 / this.scale, 4 / this.scale]);
    ctx.strokeStyle = 'rgba(10,132,255,0.95)';
    ctx.fillStyle = 'rgba(10,132,255,0.08)';
    ctx.beginPath();
    ctx.roundRect(x0 - pad, y0 - pad, x1 - x0 + pad * 2, y1 - y0 + pad * 2, 8 / this.scale);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // --- placed objects ------------------------------------------------------

  placeObject(index, kind, x, y) {
    const object =
      kind === 'text' ? defaultTextObject(x, y, this.tools) : defaultNoteObject(x, y, this.tools);
    const created = this.store.addObject(index, object);
    this.#renderObjects(index);
    const el = this.pageEls[index]?.querySelector(`.obj[data-id="${created.id}"]`);
    if (el) {
      if (kind === 'text') focusObject(el);
      else el.querySelector('.obj-note-body')?.focus();
    }
    return created;
  }

  #renderObjects(index) {
    const el = this.pageEls[index];
    const page = this.store.page(index);
    if (!el || !page) return;
    const layer = el.querySelector('.obj-layer');
    layer.replaceChildren();

    for (const object of page.objects) {
      if (object.kind === 'shape') continue; // shapes live on the ink canvas
      const node = createObjectElement(object, {
        onEdit: (patch) => {
          this.store.updateObject(index, object.id, patch);
        },
        onSelect: () => {
          this.setSelection({
            pageIndex: index,
            strokeIds: new Set(),
            objectIds: new Set([object.id]),
          });
        },
        onDragEnd: (dxClient, dyClient) => {
          // Screen delta → page delta, undoing rotation so dragging a note on a
          // sideways page still follows the pointer.
          const rotation = page.rotation || 0;
          const dx = dxClient / this.scale;
          const dy = dyClient / this.scale;
          const mapped =
            rotation === 90
              ? { x: dy, y: -dx }
              : rotation === 180
                ? { x: -dx, y: -dy }
                : rotation === 270
                  ? { x: -dy, y: dx }
                  : { x: dx, y: dy };
          this.store.updateObject(index, object.id, {
            x: object.x + mapped.x,
            y: object.y + mapped.y,
          });
          this.#renderObjects(index);
        },
        onDelete: () => {
          this.store.removeObjects(index, [object.id]);
          this.#renderObjects(index);
        },
      });

      const { left, top } = this.toClientOffset(index, object.x, object.y);
      node.style.left = `${left}px`;
      node.style.top = `${top}px`;
      if (object.kind === 'text') {
        node.style.width = `${(object.width || 220) * this.scale}px`;
        node.style.fontSize = `${(object.fontSize || 15) * this.scale}px`;
        node.style.color = object.color;
      } else {
        node.style.setProperty('--note-color', object.color);
      }
      node.classList.toggle('selected', this.selection.objectIds.has(object.id));
      layer.append(node);
    }
  }

  // --- zoom & scroll -------------------------------------------------------

  #installScrollTracking() {
    let ticking = false;
    this.container.addEventListener(
      'scroll',
      () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          ticking = false;
          this.#updateCurrentPage();
        });
      },
      { passive: true }
    );
  }

  #updateCurrentPage() {
    const middle = this.container.scrollTop + this.container.clientHeight / 2;
    let best = 0;
    for (let index = 0; index < this.pageEls.length; index += 1) {
      const el = this.pageEls[index];
      if (el.offsetTop <= middle) best = index;
      else break;
    }
    if (best !== this.currentPage) {
      this.currentPage = best;
      this.dispatchEvent(new CustomEvent('page', { detail: { page: best } }));
    }
  }

  #installZoomGestures() {
    // Ctrl+wheel and trackpad pinch (which Chromium reports as ctrl+wheel).
    this.container.addEventListener(
      'wheel',
      (event) => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        const factor = Math.exp(-event.deltaY * 0.0018);
        this.zoomBy(factor, event.clientX, event.clientY);
      },
      { passive: false }
    );

    // Two-finger pinch on a touchscreen.
    const active = new Map();
    let pinch = null;
    this.container.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'touch') return;
      active.set(event.pointerId, event);
      if (active.size === 2) {
        const [a, b] = [...active.values()];
        pinch = {
          distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
          x: (a.clientX + b.clientX) / 2,
          y: (a.clientY + b.clientY) / 2,
        };
      }
    });
    this.container.addEventListener('pointermove', (event) => {
      if (event.pointerType !== 'touch' || !active.has(event.pointerId)) return;
      active.set(event.pointerId, event);
      if (active.size !== 2 || !pinch) return;
      const [a, b] = [...active.values()];
      const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (pinch.distance > 0) this.zoomBy(distance / pinch.distance, pinch.x, pinch.y);
      pinch.distance = distance;
    });
    const drop = (event) => {
      active.delete(event.pointerId);
      if (active.size < 2) pinch = null;
    };
    this.container.addEventListener('pointerup', drop);
    this.container.addEventListener('pointercancel', drop);
  }

  /**
   * Zoom about a screen point, keeping the page content under that point
   * exactly where it is. Anchoring on the page under the cursor (rather than on
   * scroll offsets) stays exact regardless of gaps and centring.
   */
  zoomBy(factor, clientX, clientY) {
    const next = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE);
    if (Math.abs(next - this.scale) < 1e-4) return;
    this.setScale(next, clientX, clientY);
  }

  setScale(next, clientX, clientY) {
    const scale = clamp(next, MIN_SCALE, MAX_SCALE);
    if (!this.pageEls.length) {
      this.scale = scale;
      return;
    }
    const containerRect = this.container.getBoundingClientRect();
    const anchorX = clientX ?? containerRect.left + this.container.clientWidth / 2;
    const anchorY = clientY ?? containerRect.top + this.container.clientHeight / 2;

    // Find the page under the anchor, and the point on it the user is looking
    // at. Anchoring on page content rather than on raw scroll offsets stays
    // exact no matter how the pages are centred or spaced.
    let anchorIndex = this.currentPage;
    for (let index = 0; index < this.pageEls.length; index += 1) {
      const rect = this.pageEls[index].getBoundingClientRect();
      if (anchorY >= rect.top && anchorY <= rect.bottom) {
        anchorIndex = index;
        break;
      }
    }
    const anchorPoint = this.toPage(anchorIndex, anchorX, anchorY);

    this.scale = scale;
    this.fitMode = null;
    this.applySizes();

    // Put that same page point back under the anchor at the new scale.
    const el = this.pageEls[anchorIndex];
    const origin = this.#offsetWithinScroller(el);
    const { left, top } = this.toClientOffset(anchorIndex, anchorPoint.x, anchorPoint.y);
    this.container.scrollTop = origin.top + top - (anchorY - containerRect.top);
    this.container.scrollLeft = origin.left + left - (anchorX - containerRect.left);

    this.#scheduleReraster();
    this.dispatchEvent(new CustomEvent('zoom', { detail: { scale: this.scale } }));
  }

  /** Offset of a page element within the scrolling container's content box. */
  #offsetWithinScroller(el) {
    let top = 0;
    let left = 0;
    let node = el;
    while (node && node !== this.container) {
      top += node.offsetTop;
      left += node.offsetLeft;
      node = node.offsetParent;
    }
    return { top, left };
  }

  // Re-rasterising every page on every wheel tick would stutter; the CSS-sized
  // canvas is scaled by the browser in the meantime, then replaced with a crisp
  // render once the gesture settles.
  #scheduleReraster() {
    this.pagesEl.classList.add('zooming');
    clearTimeout(this._rerasterTimer);
    this._rerasterTimer = setTimeout(() => {
      this.pagesEl.classList.remove('zooming');
      this.refreshAll();
    }, 160);
  }

  applyFit(mode) {
    if (!this.store.doc || !this.pageEls.length) return;
    const index = this.currentPage;
    const { width, height } = this.store.pageSize(index);
    const rotated = (this.store.page(index)?.rotation || 0) % 180 !== 0;
    const pageWidth = rotated ? height : width;
    const pageHeight = rotated ? width : height;
    // 48px of breathing room either side; a document flush to the window edge
    // reads as cramped.
    const availableWidth = this.container.clientWidth - 48;
    const availableHeight = this.container.clientHeight - 48;
    const scale =
      mode === 'width' ? availableWidth / pageWidth : Math.min(availableWidth / pageWidth, availableHeight / pageHeight);
    this.scale = clamp(scale, MIN_SCALE, MAX_SCALE);
    this.fitMode = mode;
    this.applySizes();
    this.refreshAll();
    this.dispatchEvent(new CustomEvent('zoom', { detail: { scale: this.scale } }));
  }

  scrollToPage(index, behavior = 'smooth') {
    const el = this.pageEls[index];
    if (!el) return;
    this.container.scrollTo({ top: el.offsetTop - 12, behavior });
  }
}
