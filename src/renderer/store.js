// The document model and its undo stack.
//
// Coordinates are stored in *page space*: PDF points, origin at the page's
// top-left, measured on the unrotated page. Two consequences that matter:
//
//   - Zoom never degrades ink. Screen pixels are derived at paint time, so a
//     stroke drawn at 50% and viewed at 400% is as sharp as the page under it.
//   - Rotating a page moves the paper, not the notes. Ink keeps its position
//     relative to the words it annotates.
//
// Export flips y (PDF's own origin is bottom-left); nothing else has to care.

const uid = () => crypto.randomUUID();

export const SCHEMA_VERSION = 1;

/** Tools that produce freehand strokes rather than placed objects. */
export const STROKE_TOOLS = new Set(['pen', 'highlighter']);

function emptyPage() {
  return { strokes: [], objects: [], rotation: 0, inserted: false };
}

export function strokeBBox(points, padding = 0) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0 - padding, y0 - padding, x1 + padding, y1 + padding];
}

export class Store extends EventTarget {
  constructor() {
    super();
    this.doc = null;
    this.undoStack = [];
    this.redoStack = [];
    this.maxDepth = 200;
    this.savedAt = 0;
    this.revision = 0;
  }

  // --- lifecycle -----------------------------------------------------------

  open({ path, name, hash, pageCount, sizes }) {
    this.doc = {
      path,
      name,
      hash,
      version: SCHEMA_VERSION,
      // Page geometry is cached so export and hit-testing never need the
      // pdf.js document object.
      sizes,
      pages: Array.from({ length: pageCount }, emptyPage),
      // Maps a viewer page index to its index in the source PDF. Page
      // operations rewrite this instead of touching the original file.
      order: Array.from({ length: pageCount }, (_, i) => i),
    };
    this.undoStack = [];
    this.redoStack = [];
    this.revision = 0;
    this.savedAt = 0;
    this.#emit('open');
  }

  close() {
    this.doc = null;
    this.undoStack = [];
    this.redoStack = [];
    this.#emit('close');
  }

  /** Merge a sidecar file over a freshly opened document. */
  hydrate(sidecar) {
    if (!this.doc || !sidecar || !Array.isArray(sidecar.pages)) return false;
    const mismatched = sidecar.hash && this.doc.hash && sidecar.hash !== this.doc.hash;

    const pdfPageCount = this.doc.pages.length;
    this.doc.pages = sidecar.pages.map((page, index) => ({
      ...emptyPage(),
      ...page,
      strokes: (page.strokes || []).map((s) => ({
        ...s,
        id: s.id || uid(),
        bbox: s.bbox || strokeBBox(s.points || [], (s.size || 2) / 2),
      })),
      objects: (page.objects || []).map((o) => ({ ...o, id: o.id || uid() })),
      rotation: page.rotation || 0,
      inserted: page.inserted || this.doc.pages[index]?.inserted || false,
    }));
    // The two page counts can legitimately disagree: a sidecar written after
    // pages were inserted describes more, and one written before describes
    // fewer. Grow to whichever is longer so neither the PDF's own pages nor a
    // page of notes is ever dropped.
    while (this.doc.pages.length < pdfPageCount) this.doc.pages.push(emptyPage());
    if (Array.isArray(sidecar.order)) this.doc.order = sidecar.order;
    if (Array.isArray(sidecar.sizes) && sidecar.sizes.length) this.doc.sizes = sidecar.sizes;

    // Loading a sidecar is not an edit — the on-disk copy already matches.
    this.savedAt = this.revision;
    this.#emit('hydrate');
    return { mismatched };
  }

  serialize() {
    if (!this.doc) return null;
    return JSON.stringify(
      {
        version: SCHEMA_VERSION,
        app: 'inkwell',
        hash: this.doc.hash,
        savedAt: new Date().toISOString(),
        sizes: this.doc.sizes,
        order: this.doc.order,
        pages: this.doc.pages,
      },
      // Points carry sub-pixel precision that nobody can see; three decimals
      // keeps sidecars small on documents with thousands of strokes.
      (key, value) => (typeof value === 'number' ? Math.round(value * 1000) / 1000 : value)
    );
  }

  get isDirty() {
    return this.doc != null && this.revision !== this.savedAt;
  }

  markSaved() {
    this.savedAt = this.revision;
    this.#emit('saved');
  }

  // --- page access ---------------------------------------------------------

  page(index) {
    return this.doc?.pages[index] ?? null;
  }

  pageSize(index) {
    const page = this.doc?.pages[index];
    // Inserted and appended pages carry their own geometry; pages backed by
    // the original file look theirs up through the order map.
    if (page?.size) return page.size;
    const source = this.doc?.order[index];
    if (source != null && source >= 0) return this.doc.sizes[source] ?? { width: 612, height: 792 };
    return { width: 612, height: 792 };
  }

  get pageCount() {
    return this.doc?.pages.length ?? 0;
  }

  // --- command plumbing ----------------------------------------------------

  // Every mutation goes through here so undo/redo, autosave and repaint all
  // observe the same single choke point.
  apply(command) {
    command.redo();
    this.undoStack.push(command);
    if (this.undoStack.length > this.maxDepth) this.undoStack.shift();
    this.redoStack.length = 0;
    this.#changed(command.pages, command.structural);
  }

  undo() {
    const command = this.undoStack.pop();
    if (!command) return false;
    command.undo();
    this.redoStack.push(command);
    this.#changed(command.pages, command.structural);
    return true;
  }

  redo() {
    const command = this.redoStack.pop();
    if (!command) return false;
    command.redo();
    this.undoStack.push(command);
    this.#changed(command.pages, command.structural);
    return true;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  #changed(pages, structural) {
    this.revision += 1;
    this.dispatchEvent(
      new CustomEvent('change', { detail: { pages: pages ?? null, structural: !!structural } })
    );
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // --- ink -----------------------------------------------------------------

  addStroke(pageIndex, stroke) {
    const entry = { ...stroke, id: stroke.id || uid() };
    if (!entry.bbox) entry.bbox = strokeBBox(entry.points, entry.size / 2 + 1);
    const page = this.page(pageIndex);
    this.apply({
      pages: [pageIndex],
      redo: () => page.strokes.push(entry),
      undo: () => {
        const at = page.strokes.indexOf(entry);
        if (at !== -1) page.strokes.splice(at, 1);
      },
    });
    return entry;
  }

  removeStrokes(pageIndex, ids) {
    const page = this.page(pageIndex);
    const wanted = new Set(ids);
    // Positions are captured so undo restores z-order, not just membership.
    const removed = [];
    page.strokes.forEach((stroke, index) => {
      if (wanted.has(stroke.id)) removed.push({ index, stroke });
    });
    if (!removed.length) return false;
    this.apply({
      pages: [pageIndex],
      redo: () => {
        for (let i = removed.length - 1; i >= 0; i -= 1) page.strokes.splice(removed[i].index, 1);
      },
      undo: () => {
        for (const { index, stroke } of removed) page.strokes.splice(index, 0, stroke);
      },
    });
    return true;
  }

  /** Nudge strokes and objects together — the lasso drag. */
  translateSelection(pageIndex, strokeIds, objectIds, dx, dy) {
    if (!dx && !dy) return;
    const page = this.page(pageIndex);
    const strokes = page.strokes.filter((s) => strokeIds.has(s.id));
    const objects = page.objects.filter((o) => objectIds.has(o.id));
    const shift = (sx, sy) => {
      for (const stroke of strokes) {
        for (const point of stroke.points) {
          point[0] += sx;
          point[1] += sy;
        }
        stroke.bbox = [
          stroke.bbox[0] + sx,
          stroke.bbox[1] + sy,
          stroke.bbox[2] + sx,
          stroke.bbox[3] + sy,
        ];
      }
      for (const object of objects) {
        object.x += sx;
        object.y += sy;
      }
    };
    this.apply({
      pages: [pageIndex],
      redo: () => shift(dx, dy),
      undo: () => shift(-dx, -dy),
    });
  }

  // --- placed objects (text, notes, shapes) --------------------------------

  addObject(pageIndex, object) {
    const entry = { ...object, id: object.id || uid() };
    const page = this.page(pageIndex);
    this.apply({
      pages: [pageIndex],
      redo: () => page.objects.push(entry),
      undo: () => {
        const at = page.objects.indexOf(entry);
        if (at !== -1) page.objects.splice(at, 1);
      },
    });
    return entry;
  }

  updateObject(pageIndex, id, patch) {
    const page = this.page(pageIndex);
    const object = page.objects.find((o) => o.id === id);
    if (!object) return;
    const before = {};
    for (const key of Object.keys(patch)) before[key] = object[key];
    this.apply({
      pages: [pageIndex],
      redo: () => Object.assign(object, patch),
      undo: () => Object.assign(object, before),
    });
  }

  removeObjects(pageIndex, ids) {
    const page = this.page(pageIndex);
    const wanted = new Set(ids);
    const removed = [];
    page.objects.forEach((object, index) => {
      if (wanted.has(object.id)) removed.push({ index, object });
    });
    if (!removed.length) return false;
    this.apply({
      pages: [pageIndex],
      redo: () => {
        for (let i = removed.length - 1; i >= 0; i -= 1) page.objects.splice(removed[i].index, 1);
      },
      undo: () => {
        for (const { index, object } of removed) page.objects.splice(index, 0, object);
      },
    });
    return true;
  }

  // --- page operations -----------------------------------------------------

  rotatePage(pageIndex, delta) {
    const page = this.page(pageIndex);
    const before = page.rotation;
    const after = (((before + delta) % 360) + 360) % 360;
    this.apply({
      pages: [pageIndex],
      structural: true,
      redo: () => {
        page.rotation = after;
      },
      undo: () => {
        page.rotation = before;
      },
    });
  }

  insertBlankPage(afterIndex) {
    const doc = this.doc;
    const at = afterIndex + 1;
    // A blank page borrows the geometry of the page it follows, so inserting
    // into an A4 document does not produce a stray Letter-sized sheet.
    // Copy only the dimensions, never the neighbour's viewport matrix: a blank
    // page is unrotated, and inheriting a rotated page's transform would place
    // its ink through the wrong mapping on export.
    const neighbour = this.pageSize(Math.max(0, afterIndex));
    const size = { width: neighbour.width, height: neighbour.height };
    const page = { ...emptyPage(), inserted: true, size };
    this.apply({
      structural: true,
      redo: () => {
        doc.pages.splice(at, 0, page);
        doc.order.splice(at, 0, -1);
      },
      undo: () => {
        doc.pages.splice(at, 1);
        doc.order.splice(at, 1);
      },
    });
    return at;
  }

  deletePage(pageIndex) {
    const doc = this.doc;
    if (doc.pages.length <= 1) return false;
    const page = doc.pages[pageIndex];
    const source = doc.order[pageIndex];
    this.apply({
      structural: true,
      redo: () => {
        doc.pages.splice(pageIndex, 1);
        doc.order.splice(pageIndex, 1);
      },
      undo: () => {
        doc.pages.splice(pageIndex, 0, page);
        doc.order.splice(pageIndex, 0, source);
      },
    });
    return true;
  }

  movePage(from, to) {
    const doc = this.doc;
    if (from === to || to < 0 || to >= doc.pages.length) return false;
    const move = (a, b) => {
      doc.pages.splice(b, 0, doc.pages.splice(a, 1)[0]);
      doc.order.splice(b, 0, doc.order.splice(a, 1)[0]);
    };
    this.apply({
      structural: true,
      redo: () => move(from, to),
      undo: () => move(to, from),
    });
    return true;
  }

  /**
   * Record pages appended from a second PDF. The bytes stay in the viewer's
   * source registry; the store only tracks where they land in the order.
   */
  appendPages(sourceKey, count, sizes) {
    const doc = this.doc;
    const startIndex = doc.pages.length;
    const added = Array.from({ length: count }, (_, i) => ({
      ...emptyPage(),
      source: sourceKey,
      sourceIndex: i,
      size: sizes[i],
    }));
    this.apply({
      structural: true,
      redo: () => {
        doc.pages.push(...added);
        for (let i = 0; i < count; i += 1) doc.order.push(-1);
      },
      undo: () => {
        doc.pages.length = startIndex;
        doc.order.length = startIndex;
      },
    });
    return startIndex;
  }
}
