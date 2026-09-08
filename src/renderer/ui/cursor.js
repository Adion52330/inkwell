// The brush cursor.
//
// A crosshair tells you where the pointer is but nothing about what you are
// about to lay down. This draws the actual nib instead: a dot the exact size
// the stroke will be, in the colour it will be, scaled with the zoom. Picking a
// 24pt highlighter at 200% shows a 48px disc, so the width is something you
// judge by eye rather than by reading a number off a slider.
//
// It is a DOM element rather than a CSS `cursor: url(...)`: Chromium refuses
// cursor images beyond roughly 128px and silently falls back to the default,
// which is exactly the size range a fat eraser lives in.

const SIZED_TOOLS = new Set(['pen', 'highlighter', 'eraser']);
const PRECISE_TOOLS = new Set(['lasso', 'shape', 'text', 'note']);

// Below this a true-to-size dot would be a single hard-to-see pixel, so the
// ring is floored - the fill still shows the real width.
const MIN_VISIBLE = 5;

export class BrushCursor {
  /**
   * @param {object} deps
   * @param {HTMLElement} deps.viewer scrolling container the cursor applies to
   * @param {object} deps.tools live tool settings
   * @param {object} deps.view supplies the current zoom scale
   */
  constructor({ viewer, tools, view }) {
    this.viewer = viewer;
    this.tools = tools;
    this.view = view;
    this.visible = false;
    this.frame = 0;
    this.point = { x: 0, y: 0 };

    this.el = document.createElement('div');
    this.el.className = 'brush-cursor';
    this.el.setAttribute('aria-hidden', 'true');
    document.body.append(this.el);

    this.onMove = this.onMove.bind(this);
    this.onLeave = this.onLeave.bind(this);
    this.flush = this.flush.bind(this);

    // Bound to the window so the ring keeps tracking during a stroke that
    // wanders outside the viewer, and hidden again as soon as it settles
    // somewhere else.
    window.addEventListener('pointermove', this.onMove, { passive: true });
    viewer.addEventListener('pointerleave', this.onLeave);
    window.addEventListener('blur', this.onLeave);

    this.update();
  }

  destroy() {
    window.removeEventListener('pointermove', this.onMove);
    this.viewer.removeEventListener('pointerleave', this.onLeave);
    window.removeEventListener('blur', this.onLeave);
    this.el.remove();
  }

  onMove(event) {
    // A finger pans and never draws, so it gets no nib.
    if (event.pointerType === 'touch') return this.onLeave();
    const inside = event.target instanceof Element && this.viewer.contains(event.target);
    if (!inside || !this.kind) return this.onLeave();

    this.point.x = event.clientX;
    this.point.y = event.clientY;
    if (!this.frame) this.frame = requestAnimationFrame(this.flush);
  }

  flush() {
    this.frame = 0;
    this.el.style.transform = `translate3d(${this.point.x}px, ${this.point.y}px, 0) translate(-50%, -50%)`;
    if (!this.visible) {
      this.visible = true;
      this.el.classList.add('on');
    }
  }

  onLeave() {
    if (!this.visible) return;
    this.visible = false;
    this.el.classList.remove('on');
  }

  /** Which flavour of cursor the active tool wants, if any. */
  get kind() {
    const tool = this.tools.tool;
    if (SIZED_TOOLS.has(tool)) return tool;
    if (PRECISE_TOOLS.has(tool)) return 'precise';
    return null; // hand and anything else keep the platform cursor
  }

  /** Recompute size and colour. Call on tool change, setting change and zoom. */
  update() {
    const kind = this.kind;
    this.el.className = `brush-cursor${this.visible ? ' on' : ''}${kind ? ` is-${kind}` : ''}`;
    this.viewer.classList.toggle('hide-cursor', kind != null);
    if (!kind) {
      this.onLeave();
      return;
    }

    const scale = this.view.scale || 1;
    let size = 10;
    let colour = 'currentColor';

    if (kind === 'pen') {
      size = this.tools.size * scale;
      colour = this.tools.color;
    } else if (kind === 'highlighter') {
      size = this.tools.highlighterSize * scale;
      colour = this.tools.highlighterColor;
    } else if (kind === 'eraser') {
      size = this.tools.eraserSize * scale;
      colour = 'transparent';
    } else {
      // Placement and selection tools have no width; a small precise dot marks
      // the exact point that will be used.
      size = 7;
      colour = this.tools.color;
    }

    this.el.style.setProperty('--cursor-size', `${Math.max(size, MIN_VISIBLE)}px`);
    this.el.style.setProperty('--cursor-color', colour);
  }
}
