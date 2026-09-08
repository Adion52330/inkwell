// The input engine.
//
// One delegated pointer listener drives every drawing tool. Its job is to turn
// raw pointer events into well-formed strokes with believable pressure, at
// frame rate, without ever letting a resting palm or a scrolling finger leave a
// mark on the page.

import { drawStroke, drawShape, strokeHit, strokeInPolygon, pointInPolygon } from './ink-render.js';
import { strokeBBox } from './store.js';

// After the pen is seen, touch is ignored for this long. Long enough to cover
// the pause while you reposition your hand mid-sentence, short enough that
// putting the pen down and scrolling with a finger still feels immediate.
const PALM_REJECT_MS = 700;

// Mouse and trackpad report a constant pressure, so width comes from speed
// instead. These bounds are in page points per millisecond.
const VELOCITY_MIN = 0.15;
const VELOCITY_MAX = 2.4;

const clamp = (value, lo, hi) => (value < lo ? lo : value > hi ? hi : value);

export class InkEngine {
  /**
   * @param {object} deps
   * @param {HTMLElement} deps.viewer   scrolling container holding the pages
   * @param {import('./store.js').Store} deps.store
   * @param {object} deps.tools         live tool settings (tool, color, size…)
   * @param {object} deps.view          page geometry + canvas access
   */
  constructor({ viewer, store, tools, view }) {
    this.viewer = viewer;
    this.store = store;
    this.tools = tools;
    this.view = view;

    /** @type {null | object} the gesture in flight */
    this.gesture = null;
    this.lastPenAt = 0;
    this.pendingFrame = 0;
    this.selection = { pageIndex: -1, strokeIds: new Set(), objectIds: new Set() };

    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.flush = this.flush.bind(this);

    viewer.addEventListener('pointerdown', this.onPointerDown);
    // Move/up are bound to the window so a stroke that leaves the page — or the
    // window — still finishes cleanly instead of hanging half-drawn.
    window.addEventListener('pointermove', this.onPointerMove, { passive: false });
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
  }

  destroy() {
    this.viewer.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
  }

  // --- device policy -------------------------------------------------------

  /** Which tool this particular pointer should drive right now. */
  #resolveTool(event) {
    // The eraser end of a stylus, and the barrel button, both mean "erase"
    // regardless of what is selected in the toolbar.
    if (event.pointerType === 'eraser') return 'eraser';
    if (event.pointerType === 'pen' && (event.buttons & 32) !== 0) return 'eraser';
    // Middle-drag pans, matching every other document viewer.
    if (event.button === 1) return 'hand';
    if (event.button === 2) return 'hand';
    return this.tools.tool;
  }

  #shouldIgnore(event) {
    if (event.pointerType === 'touch') {
      // Fingers pan and pinch; they never draw. A palm resting near a pen is
      // rejected outright so it cannot scroll the page mid-word either.
      return true;
    }
    if (event.pointerType === 'mouse' && event.button !== 0 && event.button !== 1 && event.button !== 2) {
      return true;
    }
    return false;
  }

  /** Pressure for this sample, chosen by device. */
  #pressureFor(event, gesture, x, y, timeStamp) {
    if (event.pointerType === 'pen') {
      // Some drivers report 0 on the initial contact; treat that as a light
      // touch rather than a zero-width invisible start.
      return event.pressure > 0 ? event.pressure : 0.35;
    }
    // Mouse/trackpad: fast movement thins the line, the way a real nib
    // lightens when you flick it. Smoothed so the width does not chatter.
    const previous = gesture.lastSample;
    if (!previous) return 0.62;
    const dt = Math.max(timeStamp - previous.t, 1);
    const distance = Math.hypot(x - previous.x, y - previous.y);
    const speed = distance / dt;
    const normalized = clamp(
      (speed - VELOCITY_MIN) / (VELOCITY_MAX - VELOCITY_MIN),
      0,
      1
    );
    const target = 0.95 - normalized * 0.6;
    gesture.smoothedPressure = gesture.smoothedPressure * 0.72 + target * 0.28;
    return gesture.smoothedPressure;
  }

  // --- event handling ------------------------------------------------------

  onPointerDown(event) {
    if (event.pointerType === 'pen') this.lastPenAt = event.timeStamp;
    if (this.gesture) return;
    if (this.#shouldIgnore(event)) return;
    if (!this.store.doc) return;

    const hit = this.view.pageAt(event.target);
    if (!hit) return;

    const tool = this.#resolveTool(event);
    if (tool === 'hand') return; // the view's own pan handler takes it

    const { x, y } = this.view.toPage(hit.pageIndex, event.clientX, event.clientY);
    const gesture = {
      tool,
      pointerId: event.pointerId,
      pageIndex: hit.pageIndex,
      pointerType: event.pointerType,
      smoothedPressure: 0.62,
      lastSample: null,
      queue: [],
      moved: false,
      startX: x,
      startY: y,
    };
    this.gesture = gesture;

    // Capture on the viewer keeps every later sample coming to us even when the
    // pointer crosses a page boundary or a floating toolbar.
    try {
      this.viewer.setPointerCapture(event.pointerId);
    } catch {
      /* capture is an optimisation, not a requirement */
    }

    switch (tool) {
      case 'pen':
      case 'highlighter':
        this.#beginStroke(gesture, event, x, y);
        break;
      case 'eraser':
        gesture.erased = new Set();
        this.#eraseAt(gesture, x, y);
        break;
      case 'lasso':
        gesture.polygon = [[x, y]];
        break;
      case 'shape':
        gesture.shape = {
          kind: 'shape',
          shape: this.tools.shape,
          x,
          y,
          x2: x,
          y2: y,
          color: this.tools.color,
          size: this.tools.size,
          opacity: 1,
          fill: this.tools.fill,
        };
        break;
      case 'text':
      case 'note':
        // Placed on release, so a stray drag does not create an object.
        break;
      default:
        this.gesture = null;
        return;
    }
    event.preventDefault();
  }

  onPointerMove(event) {
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (event.pointerType === 'pen') this.lastPenAt = event.timeStamp;

    // getCoalescedEvents recovers the samples Chromium buffered between frames.
    // A 240 Hz pen delivers roughly four per frame; dropping them is the single
    // biggest cause of lines that look faceted at speed.
    const samples = event.getCoalescedEvents ? event.getCoalescedEvents() : [event];
    for (const sample of samples.length ? samples : [event]) {
      gesture.queue.push({
        clientX: sample.clientX,
        clientY: sample.clientY,
        pressure: sample.pressure,
        pointerType: sample.pointerType || event.pointerType,
        buttons: sample.buttons,
        t: sample.timeStamp || event.timeStamp,
      });
    }
    gesture.moved = true;
    // Work is deferred to one rAF flush; handling every sample inline would
    // repaint far more often than the display can show.
    if (!this.pendingFrame) this.pendingFrame = requestAnimationFrame(this.flush);
    event.preventDefault();
  }

  flush() {
    this.pendingFrame = 0;
    const gesture = this.gesture;
    if (!gesture || !gesture.queue.length) return;
    const queue = gesture.queue;
    gesture.queue = [];

    for (const sample of queue) {
      const { x, y } = this.view.toPage(gesture.pageIndex, sample.clientX, sample.clientY);
      switch (gesture.tool) {
        case 'pen':
        case 'highlighter': {
          const pressure = this.#pressureFor(sample, gesture, x, y, sample.t);
          gesture.stroke.points.push([x, y, pressure]);
          gesture.lastSample = { x, y, t: sample.t };
          break;
        }
        case 'eraser':
          this.#eraseAt(gesture, x, y);
          break;
        case 'lasso': {
          const last = gesture.polygon[gesture.polygon.length - 1];
          // Thin the polygon: samples closer than a point add nothing but cost.
          if (Math.hypot(x - last[0], y - last[1]) > 1.2) gesture.polygon.push([x, y]);
          break;
        }
        case 'shape':
          gesture.shape.x2 = x;
          gesture.shape.y2 = y;
          break;
        default:
          break;
      }
    }
    this.#paintWet(gesture);
  }

  onPointerUp(event) {
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (this.pendingFrame) {
      cancelAnimationFrame(this.pendingFrame);
      this.pendingFrame = 0;
    }
    // Drain whatever arrived since the last frame so the stroke ends on the
    // sample the user actually lifted at, not the last one a frame happened to
    // catch.
    this.flush();

    try {
      this.viewer.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }

    const { pageIndex } = gesture;
    switch (gesture.tool) {
      case 'pen':
      case 'highlighter':
        this.#commitStroke(gesture);
        break;
      case 'eraser':
        if (gesture.erased.size) this.store.removeStrokes(pageIndex, [...gesture.erased]);
        break;
      case 'lasso':
        this.#commitLasso(gesture);
        break;
      case 'shape':
        this.#commitShape(gesture);
        break;
      case 'text':
      case 'note':
        if (!gesture.moved) {
          this.view.placeObject(pageIndex, gesture.tool, gesture.startX, gesture.startY);
        }
        break;
      default:
        break;
    }

    this.view.clearWet(pageIndex);
    this.gesture = null;
  }

  // --- tool implementations ------------------------------------------------

  #beginStroke(gesture, event, x, y) {
    const isHighlighter = gesture.tool === 'highlighter';
    gesture.stroke = {
      tool: gesture.tool,
      color: isHighlighter ? this.tools.highlighterColor : this.tools.color,
      size: isHighlighter ? this.tools.highlighterSize : this.tools.size,
      opacity: isHighlighter ? 0.4 : this.tools.opacity ?? 1,
      points: [[x, y, this.#pressureFor(event, gesture, x, y, event.timeStamp)]],
    };
    gesture.lastSample = { x, y, t: event.timeStamp };
  }

  #commitStroke(gesture) {
    const stroke = gesture.stroke;
    if (!stroke || stroke.points.length === 0) return;
    // A tap with no movement should still leave a dot, so give it a second
    // point a hair away — a single-point outline has no area to fill.
    if (stroke.points.length === 1) {
      const [x, y, p] = stroke.points[0];
      stroke.points.push([x + 0.01, y + 0.01, p]);
    }
    stroke.bbox = strokeBBox(stroke.points, stroke.size / 2 + 1);
    this.store.addStroke(gesture.pageIndex, stroke);
  }

  #eraseAt(gesture, x, y) {
    const page = this.store.page(gesture.pageIndex);
    if (!page) return;
    const radius = this.tools.eraserSize / 2;
    let changed = false;
    for (const stroke of page.strokes) {
      if (gesture.erased.has(stroke.id)) continue;
      if (strokeHit(stroke, x, y, radius)) {
        gesture.erased.add(stroke.id);
        changed = true;
      }
    }
    for (const object of page.objects) {
      if (gesture.erased.has(object.id)) continue;
      if (object.kind === 'shape' && this.#shapeHit(object, x, y, radius)) {
        gesture.erased.add(object.id);
        changed = true;
      }
    }
    // Erased strokes are hidden immediately by repainting the committed layer
    // with an exclusion set, then actually removed on pointerup as one
    // undoable command.
    if (changed) this.view.repaintInk(gesture.pageIndex, gesture.erased);
  }

  #shapeHit(shape, x, y, radius) {
    const pad = radius + shape.size;
    const inBox =
      x >= Math.min(shape.x, shape.x2) - pad &&
      x <= Math.max(shape.x, shape.x2) + pad &&
      y >= Math.min(shape.y, shape.y2) - pad &&
      y <= Math.max(shape.y, shape.y2) + pad;
    return inBox;
  }

  #commitLasso(gesture) {
    const polygon = gesture.polygon;
    const page = this.store.page(gesture.pageIndex);
    if (!page || polygon.length < 3) {
      this.clearSelection();
      return;
    }
    const strokeIds = new Set();
    const objectIds = new Set();
    for (const stroke of page.strokes) {
      if (strokeInPolygon(stroke, polygon)) strokeIds.add(stroke.id);
    }
    for (const object of page.objects) {
      if (pointInPolygon(polygon, object.x, object.y)) objectIds.add(object.id);
    }
    this.selection = { pageIndex: gesture.pageIndex, strokeIds, objectIds };
    this.view.setSelection(this.selection);
  }

  #commitShape(gesture) {
    const shape = gesture.shape;
    if (!shape) return;
    const dragged = Math.hypot(shape.x2 - shape.x, shape.y2 - shape.y);
    if (dragged < 3) return; // an accidental click, not a shape
    this.store.addObject(gesture.pageIndex, shape);
  }

  clearSelection() {
    this.selection = { pageIndex: -1, strokeIds: new Set(), objectIds: new Set() };
    this.view.setSelection(this.selection);
  }

  deleteSelection() {
    const { pageIndex, strokeIds, objectIds } = this.selection;
    if (pageIndex < 0) return false;
    let removed = false;
    if (strokeIds.size) removed = this.store.removeStrokes(pageIndex, [...strokeIds]) || removed;
    if (objectIds.size) removed = this.store.removeObjects(pageIndex, [...objectIds]) || removed;
    this.clearSelection();
    return removed;
  }

  // --- live painting -------------------------------------------------------

  #paintWet(gesture) {
    const ctx = this.view.wetCtx(gesture.pageIndex);
    if (!ctx) return;
    this.view.clearWet(gesture.pageIndex);
    switch (gesture.tool) {
      case 'pen':
      case 'highlighter':
        drawStroke(ctx, gesture.stroke, { live: true });
        break;
      case 'shape':
        drawShape(ctx, gesture.shape);
        break;
      case 'lasso': {
        ctx.save();
        ctx.setLineDash([6, 5]);
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = 'rgba(10,132,255,0.95)';
        ctx.fillStyle = 'rgba(10,132,255,0.10)';
        const path = new Path2D();
        path.moveTo(gesture.polygon[0][0], gesture.polygon[0][1]);
        for (const [px, py] of gesture.polygon.slice(1)) path.lineTo(px, py);
        path.closePath();
        ctx.fill(path);
        ctx.stroke(path);
        ctx.restore();
        break;
      }
      default:
        break;
    }
  }

  /** True while a resting palm should be ignored — consulted by the pan logic. */
  isPalmWindow(event) {
    return event.pointerType === 'touch' && event.timeStamp - this.lastPenAt < PALM_REJECT_MS;
  }
}
