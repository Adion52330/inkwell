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

const MIN_SCALE = 0.1;
const MAX_SCALE = 10;
const PAGE_GAP = 18;
const PAGE_PAD = 24;

/** Offered by the zoom menu. */
export const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

const clamp = (value, lo, hi) => (value < lo ? lo : value > hi ? hi : value);

// Text is rasterised at exactly the display's device pixel ratio, and the page
// box is snapped so that lands on whole device pixels.
//
// Supersampling was tried here and made things visibly worse: rendering at 1.5x
// and letting the browser scale back down resamples finished glyphs by a
// non-integer factor, which speckles thin stems and leaves stray dots between
// letters. pdf.js antialiases while it rasterises, and it can only do that
// correctly if it draws at the resolution the pixels will be shown at. A
// fractional CSS size has the same effect: a page 2332.28px wide cannot map 1:1
// onto a device pixel grid, so the whole bitmap gets resampled.
//
// The budget below is the one case where the factor is allowed to fall under
// the device ratio - a page at extreme zoom would otherwise ask for a canvas
// the GPU refuses to allocate.
const MAX_CANVAS_PIXELS = 36e6;
const MAX_CANVAS_DIMENSION = 12000;

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
    // Clearance reserved around the page strip, so the floating palette never
    // permanently covers content. Written by setEdgeInsets.
    this.insets = { top: 0, right: 0, bottom: 0, left: 0 };

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

    // Only the first page is measured. Loading every page up front to collect
    // geometry meant a thousand-page document spent a long time - and a lot of
    // memory - before showing anything at all. The rest start as copies of page
    // one and are corrected the moment they actually render, which is what the
    // `estimated` flag tracks.
    const first = await this.pdfDoc.getPage(1);
    const viewport = first.getViewport({ scale: 1 });
    const measured = {
      width: viewport.width,
      height: viewport.height,
      rotate: first.rotate,
      // pdf.js's user-space → viewport matrix. The exporter inverts it to put
      // ink back into PDF coordinates exactly, whatever the page's own
      // /Rotate and MediaBox origin happen to be.
      transform: viewport.transform,
    };
    const sizes = [measured];
    for (let i = 1; i < this.pdfDoc.numPages; i += 1) {
      sizes.push({ ...measured, estimated: true });
    }
    return { pageCount: this.pdfDoc.numPages, sizes };
  }

  /**
   * Tear a loaded document down.
   *
   * pdf.js 6 removed destroy() from the document proxy; teardown belongs to the
   * loading task that produced it. Calling the old method threw, and because
   * unload() runs at the start of load(), that meant opening a second document
   * failed outright while the first stayed on screen.
   */
  async #destroyDocument(doc) {
    try {
      const task = doc?.loadingTask;
      if (typeof task?.destroy === 'function') await task.destroy();
      else if (typeof doc?.destroy === 'function') await doc.destroy();
    } catch {
      /* the document is being discarded either way */
    }
  }

  async unload() {
    if (this.pdfDoc) {
      await this.#destroyDocument(this.pdfDoc);
      this.pdfDoc = null;
    }
    for (const doc of this.sources.values()) await this.#destroyDocument(doc);
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
    const first = await doc.getPage(1);
    const viewport = first.getViewport({ scale: 1 });
    const measured = {
      width: viewport.width,
      height: viewport.height,
      rotate: first.rotate,
      transform: viewport.transform,
    };
    const sizes = [measured];
    for (let i = 1; i < doc.numPages; i += 1) sizes.push({ ...measured, estimated: true });
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
      // pdf.js's selectable text: transparent spans positioned over the glyphs.
      // It sits above the raster so it can take the pointer, and below the ink
      // so strokes are painted over the words rather than under them.
      const textLayer = document.createElement('div');
      textLayer.className = 'textLayer';
      // Link hotspots: contents entries, cross references and external URLs.
      const linkLayer = document.createElement('div');
      linkLayer.className = 'layer link-layer';
      // Search hit highlights, under the ink so notes stay on top.
      const searchLayer = document.createElement('div');
      searchLayer.className = 'layer search-layer';
      const inkLayer = document.createElement('canvas');
      inkLayer.className = 'layer ink-layer';
      const wetLayer = document.createElement('canvas');
      wetLayer.className = 'layer wet-layer';
      // A canvas defaults to a 300x150 backing store. Across a long document
      // that is real memory for pages that have never been looked at, so they
      // start at zero and are sized when they render.
      for (const canvas of [pdfLayer, inkLayer, wetLayer]) {
        canvas.width = 0;
        canvas.height = 0;
      }
      const objLayer = document.createElement('div');
      objLayer.className = 'layer obj-layer';

      const number = document.createElement('div');
      number.className = 'page-number';
      number.textContent = String(index + 1);

      el.append(pdfLayer, textLayer, linkLayer, searchLayer, inkLayer, wetLayer, objLayer, number);
      this.pagesEl.append(el);
      this.pageEls.push(el);
      this.observer.observe(el);
    }
    this.applySizes();
    this.dispatchEvent(new CustomEvent('layout'));
  }

  /**
   * Round a CSS length so it covers a whole number of device pixels. A page box
   * ending on a fraction of a pixel forces the browser to resample the canvas
   * inside it, which is what turns crisp glyphs speckly.
   */
  #snap(value) {
    return Math.max(1, Math.round(value * this.dpr)) / this.dpr;
  }

  /** How many PDF points the page spans horizontally, as displayed. */
  #pointsAcross(index) {
    const { width, height } = this.store.pageSize(index);
    return (this.store.page(index)?.rotation || 0) % 180 !== 0 ? height : width;
  }

  /** Displayed CSS size of a page, accounting for user rotation. */
  displaySize(index) {
    const { width, height } = this.store.pageSize(index);
    const rotation = this.store.page(index)?.rotation || 0;
    const swapped = rotation % 180 !== 0;
    return {
      width: this.#snap((swapped ? height : width) * this.scale),
      height: this.#snap((swapped ? width : height) * this.scale),
    };
  }

  /**
   * CSS pixels per PDF point actually used for this page. Snapping makes this
   * differ from `scale` by a fraction of a pixel, and everything converting
   * between page and screen coordinates must use it, or ink lands slightly off
   * the raster it was drawn against.
   */
  pageScale(index) {
    const across = this.#pointsAcross(index);
    return across ? this.displaySize(index).width / across : this.scale;
  }

  /** Device pixels per PDF point - the scale the page is rasterised at. */
  rasterScale(index) {
    return this.pageScale(index) * this.rasterFactor(index);
  }

  applySizes() {
    for (let index = 0; index < this.pageEls.length; index += 1) {
      const el = this.pageEls[index];
      const { width, height } = this.displaySize(index);
      el.style.width = `${width}px`;
      el.style.height = `${height}px`;
      // The text layer's geometry is driven by this: pdf.js writes span
      // positions in unscaled units and multiplies by it in CSS.
      el.style.setProperty('--scale-factor', String(this.scale));
    }
    // Written from the same constants the scroll maths uses, so the two can
    // never disagree about where a page actually sits.
    this.pagesEl.style.gap = `${PAGE_GAP}px`;
    this.pagesEl.style.padding = `${PAGE_PAD}px`;
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
    const scale = this.pageScale(index);
    const cx = (clientX - rect.left) / scale;
    const cy = (clientY - rect.top) / scale;
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
    const s = this.pageScale(index);
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
    this.applyPageTransform(ctx, index, this.rasterScale(index));
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

  /**
   * CSS pixels → backing-store pixels for a page.
   *
   * The device pixel ratio, pulled back only if the page would exceed the
   * canvas budget, so a very deep zoom degrades gently instead of failing to
   * allocate.
   */
  rasterFactor(index) {
    const { width, height } = this.displaySize(index);
    let factor = this.dpr;
    const area = width * height * factor * factor;
    if (area > MAX_CANVAS_PIXELS) factor *= Math.sqrt(MAX_CANVAS_PIXELS / area);
    const longest = Math.max(width, height) * factor;
    if (longest > MAX_CANVAS_DIMENSION) factor *= MAX_CANVAS_DIMENSION / longest;
    return factor;
  }

  #sizeCanvas(canvas, index) {
    const { width, height } = this.displaySize(index);
    const factor = this.rasterFactor(index);
    const backingWidth = Math.max(1, Math.round(width * factor));
    const backingHeight = Math.max(1, Math.round(height * factor));
    if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
      canvas.width = backingWidth;
      canvas.height = backingHeight;
    }
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }

  // --- rasterising ---------------------------------------------------------

  /** The rendered text layer for a page, if it has one. */
  textLayerFor(index) {
    return this.pageEls[index]?._textLayer ?? null;
  }

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
    const signature = `${this.rasterScale(index).toFixed(4)}:${
      this.store.page(index)?.rotation || 0
    }`;
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
        // First sight of this page: replace the estimate with its real
        // geometry, and re-lay-out if it differs from what was assumed.
        if (this.#resolveSize(index, page)) {
          this.applySizes();
          this.#sizeCanvas(canvas, index);
          // A page turning out wider than assumed changes what "fit width"
          // means, and the fit was computed before this page had ever been
          // measured. Without this the zoom level silently changes under the
          // reader moments after the document opens.
          this.#scheduleRefit();
        }
        const rotation = (page.rotate + (this.store.page(index)?.rotation || 0)) % 360;
        // Rasterise at exactly the canvas's own resolution, so pdf.js draws the
        // glyphs at the size they will actually be displayed.
        const viewport = page.getViewport({ scale: this.rasterScale(index), rotation });
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
    // Await the text layer: search highlights are derived from its spans, so
    // anything listening has to know it is actually there.
    await this.#renderTextLayer(el, index, source);
    this.#renderLinks(el, index, source);
    this.dispatchEvent(new CustomEvent('rendered', { detail: { page: index } }));
  }

  /**
   * Build the clickable hotspots for a page's link annotations.
   *
   * Rather than pdf.js's full AnnotationLayer - which needs a link service, an
   * editor manager and a stylesheet - this reads the annotations directly and
   * places plain elements, which is all a link needs.
   */
  async #renderLinks(el, index, source) {
    const container = el.querySelector('.link-layer');
    if (!container) return;
    container.replaceChildren();
    if (!source) return;
    try {
      const page = await source.doc.getPage(source.pageNumber);
      const annotations = await page.getAnnotations({ intent: 'display' });
      const rotation = (page.rotate + (this.store.page(index)?.rotation || 0)) % 360;
      const viewport = page.getViewport({ scale: this.scale, rotation });

      for (const annotation of annotations) {
        if (annotation.subtype !== 'Link') continue;
        const target = annotation.url || annotation.dest;
        if (!target) continue;

        // pdf.js 6 dropped convertToViewportRectangle; map the two opposite
        // corners instead, which also handles rotation correctly.
        const [ax, ay] = viewport.convertToViewportPoint(annotation.rect[0], annotation.rect[1]);
        const [bx, by] = viewport.convertToViewportPoint(annotation.rect[2], annotation.rect[3]);
        const [x0, y0, x1, y1] = [ax, ay, bx, by];
        const hotspot = document.createElement('a');
        hotspot.className = 'pdf-link';
        hotspot.style.left = `${Math.min(x0, x1)}px`;
        hotspot.style.top = `${Math.min(y0, y1)}px`;
        hotspot.style.width = `${Math.abs(x1 - x0)}px`;
        hotspot.style.height = `${Math.abs(y1 - y0)}px`;

        if (annotation.url) {
          hotspot.title = annotation.url;
          hotspot.addEventListener('click', (event) => {
            event.preventDefault();
            window.inkwell.openExternal(annotation.url);
          });
        } else {
          hotspot.title = 'Go to destination';
          hotspot.addEventListener('click', (event) => {
            event.preventDefault();
            this.goToDestination(annotation.dest, source.doc);
          });
        }
        container.append(hotspot);
      }
    } catch (err) {
      console.warn(`[inkwell] could not read links on page ${index + 1}`, err);
    }
  }

  /** Follow an internal destination - a contents entry or a cross reference. */
  async goToDestination(dest, doc = this.pdfDoc) {
    try {
      const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
      if (!Array.isArray(explicit) || !explicit.length) return;
      const ref = explicit[0];
      const sourceIndex =
        typeof ref === 'object' && ref !== null ? await doc.getPageIndex(ref) : Number(ref);
      // Map the source page onto its place in the viewer, which may have been
      // reordered or had pages inserted since the document was opened.
      const viewerIndex = this.store.doc ? this.store.doc.order.indexOf(sourceIndex) : sourceIndex;
      const target = viewerIndex >= 0 ? viewerIndex : sourceIndex;
      if (target >= 0 && target < this.pageEls.length) this.scrollToPage(target);
    } catch (err) {
      console.warn('[inkwell] could not follow link destination', err);
    }
  }

  /**
   * Render the selectable text for a page.
   *
   * The viewport handed to TextLayer is in CSS units, not device pixels: the
   * class applies the device pixel ratio itself, and passing an already-scaled
   * viewport makes the text drift away from the glyphs underneath it.
   */
  async #renderTextLayer(el, index, source) {
    const container = el.querySelector('.textLayer');
    if (!container) return;
    if (!source) {
      container.replaceChildren();
      return;
    }
    try {
      const page = await source.doc.getPage(source.pageNumber);
      const rotation = (page.rotate + (this.store.page(index)?.rotation || 0)) % 360;
      const viewport = page.getViewport({ scale: this.scale, rotation });

      // Rescaling an existing layer keeps the user's selection alive across a
      // zoom; rebuilding would silently drop it.
      if (el._textLayer) {
        try {
          await el._textLayer.update({ viewport });
          return;
        } catch {
          el._textLayer.cancel();
          el._textLayer = null;
        }
      }

      container.replaceChildren();
      const layer = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent({
          includeMarkedContent: true,
          disableNormalization: true,
        }),
        container,
        viewport,
      });
      el._textLayer = layer;
      await layer.render();
    } catch (err) {
      // Text selection is an enhancement; a page that cannot produce it should
      // still render and still be drawable.
      console.warn(`[inkwell] no text layer for page ${index + 1}`, err);
    }
  }

  /**
   * Re-apply the current fit once measurements settle.
   *
   * Deferred and coalesced: this is called from inside a page render, and
   * re-fitting immediately would re-enter rendering from its own call stack.
   */
  #scheduleRefit() {
    if (this._refitPending || !this.fitMode) return;
    this._refitPending = true;
    clearTimeout(this._refitTimer);
    this._refitTimer = setTimeout(() => {
      this._refitPending = false;
      if (this.fitMode) this.applyFit(this.fitMode);
    }, 60);
  }

  /**
   * Replace a page's estimated geometry with its real geometry.
   * @returns {boolean} whether the layout actually changed.
   */
  #resolveSize(index, page) {
    const size = this.store.pageSize(index);
    if (!size?.estimated) return false;
    const viewport = page.getViewport({ scale: 1 });
    const changed =
      Math.abs(size.width - viewport.width) > 0.5 || Math.abs(size.height - viewport.height) > 0.5;
    size.width = viewport.width;
    size.height = viewport.height;
    size.rotate = page.rotate;
    size.transform = viewport.transform;
    delete size.estimated;
    return changed;
  }

  /**
   * Resolve the real geometry of specific pages. Export needs this: a page can
   * carry ink restored from a sidecar without ever having been on screen, and
   * flattening it through an estimated matrix would misplace the ink.
   */
  async ensureSizes(indices) {
    for (const index of indices) {
      if (!this.store.pageSize(index)?.estimated) continue;
      const source = this.#sourceFor(index);
      if (!source) continue;
      try {
        this.#resolveSize(index, await source.doc.getPage(source.pageNumber));
      } catch (err) {
        console.warn(`[inkwell] could not measure page ${index + 1}`, err);
      }
    }
  }

  #releasePage(index) {
    const el = this.pageEls[index];
    if (!el) return;
    if (el._renderTask) {
      el._renderTask.cancel();
      el._renderTask = null;
    }
    if (el._textLayer) {
      el._textLayer.cancel();
      el._textLayer = null;
    }
    el.querySelector('.textLayer')?.replaceChildren();
    el.querySelector('.link-layer')?.replaceChildren();
    el.querySelector('.search-layer')?.replaceChildren();
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
   * @param {Set<string>} [exclude] ids to leave out - how the eraser shows its
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
    // Clearing has to happen in device pixels, but the context must be handed
    // back in page space. Leaving it on the identity transform made the live
    // stroke paint in raw pixels - it appeared offset and shrunk while drawing,
    // then jumped into place when the committed layer repainted on release.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.#setPageTransform(ctx, index);
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

  /**
   * Rebuild the DOM layer for a page's text boxes and notes. Public because the
   * store is the source of truth: any command that adds, removes or restores an
   * object - including an undo - has to be reflected here, not just on canvas.
   */
  renderObjects(index) {
    this.#renderObjects(index);
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
        // The bubble is a fixed width in screen pixels, so near the right edge
        // of a page it would hang off into the gutter. Flip it to open leftward
        // instead, the way a real popover reflects off the edge.
        const NOTE_BUBBLE_WIDTH = 232;
        if (left + NOTE_BUBBLE_WIDTH > this.displaySize(index).width) {
          node.classList.add('flip-left');
        }
      }
      node.classList.toggle('selected', this.selection.objectIds.has(object.id));
      layer.append(node);

      // Cache the rendered height in page space so the eraser and lasso can hit
      // a text box by its real footprint rather than guessing from font size.
      // Derived geometry, so it is set directly rather than through a command.
      if (object.kind === 'text') object.height = node.offsetHeight / this.scale;
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

  // --- layout arithmetic ---------------------------------------------------
  //
  // Page positions are computed from the same constants the CSS uses rather
  // than measured. Reading getBoundingClientRect for every page on every wheel
  // tick forced a synchronous layout each time, which is what made zooming
  // stutter on longer documents.

  /**
   * Reserve space around the page strip. The floating palette docks to an edge,
   * and that edge needs clearance or the palette sits on top of the document.
   * The view owns this rather than the caller styling the element directly, so
   * the scroll arithmetic below can never fall out of step with the padding.
   */
  setEdgeInsets({ top = 0, right = 0, bottom = 0, left = 0 } = {}) {
    this.insets = { top, right, bottom, left };
    this.container.style.padding = `${top}px ${right}px ${bottom}px ${left}px`;
    this.applySizes();
    if (this.fitMode) this.applyFit(this.fitMode);
  }

  /** Usable width inside the container, discounting the reserved edges. */
  #innerWidth() {
    return this.container.clientWidth - this.insets.left - this.insets.right;
  }

  /** Width of the scroll content: the widest page, or the viewport if wider. */
  contentWidth() {
    let widest = 0;
    for (let index = 0; index < this.pageEls.length; index += 1) {
      const { width } = this.displaySize(index);
      if (width > widest) widest = width;
    }
    return Math.max(widest, this.#innerWidth() - PAGE_PAD * 2);
  }

  /** Top of a page within the scroll content. */
  pageOffsetTop(index) {
    let top = PAGE_PAD + this.insets.top;
    for (let i = 0; i < index; i += 1) top += this.displaySize(i).height + PAGE_GAP;
    return top;
  }

  /** Left of a page within the scroll content; pages are centred on the strip. */
  pageOffsetLeft(index, contentWidth = this.contentWidth()) {
    return PAGE_PAD + this.insets.left + (contentWidth - this.displaySize(index).width) / 2;
  }

  /** Which page a scroll-content point falls on, and where on that page. */
  #locate(contentX, contentY) {
    const count = this.pageEls.length;
    let top = PAGE_PAD + this.insets.top;
    let index = count - 1;
    for (let i = 0; i < count; i += 1) {
      const { height } = this.displaySize(i);
      if (contentY < top + height + PAGE_GAP / 2 || i === count - 1) {
        index = i;
        break;
      }
      top += height + PAGE_GAP;
    }
    return {
      index,
      localX: contentX - this.pageOffsetLeft(index),
      localY: contentY - top,
    };
  }

  // --- zoom ----------------------------------------------------------------

  /**
   * Zoom about a screen point. Wheel and pinch events arrive far faster than
   * the display refreshes, so they are accumulated and applied once per frame -
   * the zoom still tracks the gesture exactly, but costs one relayout a frame
   * instead of one per event.
   */
  zoomBy(factor, clientX, clientY) {
    this._pendingZoom = (this._pendingZoom ?? 1) * factor;
    this._zoomAnchor = { x: clientX, y: clientY };
    if (this._zoomFrame) return;
    this._zoomFrame = requestAnimationFrame(() => {
      this._zoomFrame = 0;
      const accumulated = this._pendingZoom ?? 1;
      this._pendingZoom = 1;
      const anchor = this._zoomAnchor ?? {};
      this.setScale(this.scale * accumulated, anchor.x, anchor.y);
    });
  }

  /**
   * Ease to a target scale. Zoom is multiplicative, so the ramp is geometric:
   * interpolating linearly from 100% to 400% would crawl through the low end
   * and then leap through the high end.
   */
  zoomTo(target, { clientX, clientY, animate = true } = {}) {
    const to = clamp(target, MIN_SCALE, MAX_SCALE);
    const from = this.scale;
    cancelAnimationFrame(this._zoomAnimation);
    if (Math.abs(to - from) < 1e-4) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!animate || reduced) {
      this.setScale(to, clientX, clientY);
      return;
    }

    const started = performance.now();
    const duration = 200;
    const ratio = to / from;
    const step = (now) => {
      const t = Math.min(1, (now - started) / duration);
      const eased = 1 - (1 - t) ** 3;
      this.setScale(from * ratio ** eased, clientX, clientY);
      if (t < 1) this._zoomAnimation = requestAnimationFrame(step);
    };
    this._zoomAnimation = requestAnimationFrame(step);
  }

  setScale(next, clientX, clientY) {
    const scale = clamp(next, MIN_SCALE, MAX_SCALE);
    if (!this.pageEls.length) {
      this.scale = scale;
      return;
    }
    if (Math.abs(scale - this.scale) < 1e-4) return;

    const containerRect = this.container.getBoundingClientRect();
    const anchorX = clientX ?? containerRect.left + this.container.clientWidth / 2;
    const anchorY = clientY ?? containerRect.top + this.container.clientHeight / 2;

    // The anchor, in scroll-content coordinates, and the page point under it.
    const offsetX = anchorX - containerRect.left;
    const offsetY = anchorY - containerRect.top;
    const before = this.#locate(this.container.scrollLeft + offsetX, this.container.scrollTop + offsetY);

    const growth = scale / this.scale;
    this.scale = scale;
    this.fitMode = null;
    this.applySizes();

    // Put the same point on the same page back under the anchor. Page-local
    // offsets scale with the zoom; the padding and gaps around them do not,
    // which is exactly why this is computed rather than simply multiplied.
    const contentWidth = this.contentWidth();
    this.container.scrollTop = this.pageOffsetTop(before.index) + before.localY * growth - offsetY;
    this.container.scrollLeft =
      this.pageOffsetLeft(before.index, contentWidth) + before.localX * growth - offsetX;

    this.#scheduleReraster();
    this.dispatchEvent(new CustomEvent('zoom', { detail: { scale: this.scale } }));
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
    }, 120);
  }

  applyFit(mode) {
    if (!this.store.doc || !this.pageEls.length) return;
    // Fit against the *largest* page in the document, not the current one.
    // The page strip is as wide as its widest member, so fitting a portrait
    // page in a document that also contains a landscape one would leave every
    // portrait page pushed off-centre behind a horizontal scrollbar.
    let pageWidth = 0;
    let pageHeight = 0;
    for (let index = 0; index < this.store.pageCount; index += 1) {
      const { width, height } = this.store.pageSize(index);
      const rotated = (this.store.page(index)?.rotation || 0) % 180 !== 0;
      pageWidth = Math.max(pageWidth, rotated ? height : width);
      pageHeight = Math.max(pageHeight, rotated ? width : height);
    }
    if (!pageWidth || !pageHeight) return;
    // 48px of breathing room either side; a document flush to the window edge
    // reads as cramped.
    const availableWidth = this.#innerWidth() - PAGE_PAD * 2;
    const availableHeight =
      this.container.clientHeight - this.insets.top - this.insets.bottom - PAGE_PAD * 2;
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
