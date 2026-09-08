// Turning stroke data into geometry.
//
// Every consumer — the wet canvas, the committed canvas, the thumbnail
// sidebar, and the PDF exporter — comes through here, so a stroke can never
// look one way on screen and another way in the exported file.

import { getStroke } from 'perfect-freehand';

// Pens taper with pressure; highlighters are a flat chisel that must not vary,
// or overlapping passes show banding where the width wobbled.
const PROFILES = {
  pen: { thinning: 0.6, smoothing: 0.55, streamline: 0.42, capStart: true, capEnd: true },
  highlighter: { thinning: 0, smoothing: 0.5, streamline: 0.5, capStart: false, capEnd: false },
};

export function strokeOptions(stroke, { live = false } = {}) {
  const profile = PROFILES[stroke.tool] || PROFILES.pen;
  return {
    size: stroke.size,
    thinning: profile.thinning,
    smoothing: profile.smoothing,
    streamline: profile.streamline,
    // Pressure is supplied by the input layer (real for a pen, velocity-derived
    // for a mouse), so perfect-freehand must not invent its own.
    simulatePressure: false,
    // `last: false` leaves the tail open while the stroke is still being drawn,
    // which stops the end cap from popping as new samples arrive.
    last: !live,
    start: { cap: profile.capStart, taper: 0 },
    end: { cap: profile.capEnd, taper: 0 },
  };
}

/** perfect-freehand's outline polygon → a fillable Path2D. */
export function outlineToPath(outline) {
  const path = new Path2D();
  if (!outline || outline.length < 2) return path;
  path.moveTo(outline[0][0], outline[0][1]);
  // Midpoint-quadratic smoothing: each vertex becomes a control point, so the
  // polygon reads as a curve instead of a chain of facets.
  for (let i = 1; i < outline.length; i += 1) {
    const [x0, y0] = outline[i - 1];
    const [x1, y1] = outline[i];
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  path.closePath();
  return path;
}

export function strokeToPath(stroke, { live = false } = {}) {
  return outlineToPath(getStroke(stroke.points, strokeOptions(stroke, { live })));
}

/** Same outline, as flat [[x,y], …] — what the PDF exporter needs. */
export function strokeToOutline(stroke) {
  return getStroke(stroke.points, strokeOptions(stroke, { live: false }));
}

/**
 * Draw one stroke. The context is expected to already be transformed into page
 * space (points, top-left origin), so nothing here deals in device pixels.
 */
export function drawStroke(ctx, stroke, { live = false } = {}) {
  if (!stroke.points || stroke.points.length === 0) return;
  ctx.save();
  if (stroke.tool === 'highlighter') {
    // Multiply keeps the words underneath legible — the whole point of a
    // highlighter, and the thing naive alpha compositing gets wrong.
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = stroke.opacity ?? 0.4;
  } else {
    ctx.globalAlpha = stroke.opacity ?? 1;
  }
  ctx.fillStyle = stroke.color;
  ctx.fill(strokeToPath(stroke, { live }));
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

function arrowHead(ctx, x0, y0, x1, y1, size) {
  const angle = Math.atan2(y1 - y0, x1 - x0);
  const len = Math.max(size * 3.2, 8);
  const spread = Math.PI / 7;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - len * Math.cos(angle - spread), y1 - len * Math.sin(angle - spread));
  ctx.lineTo(x1 - len * Math.cos(angle + spread), y1 - len * Math.sin(angle + spread));
  ctx.closePath();
  ctx.fill();
}

export function shapePath(shape) {
  const path = new Path2D();
  const { x, y, x2, y2 } = shape;
  switch (shape.shape) {
    case 'line':
    case 'arrow':
      path.moveTo(x, y);
      path.lineTo(x2, y2);
      break;
    case 'rect': {
      const r = Math.min(shape.radius ?? 0, Math.abs(x2 - x) / 2, Math.abs(y2 - y) / 2);
      path.roundRect(Math.min(x, x2), Math.min(y, y2), Math.abs(x2 - x), Math.abs(y2 - y), r);
      break;
    }
    case 'ellipse':
      path.ellipse(
        (x + x2) / 2,
        (y + y2) / 2,
        Math.abs(x2 - x) / 2,
        Math.abs(y2 - y) / 2,
        0,
        0,
        Math.PI * 2
      );
      break;
    default:
      break;
  }
  return path;
}

export function drawShape(ctx, shape) {
  ctx.save();
  ctx.globalAlpha = shape.opacity ?? 1;
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  ctx.lineWidth = shape.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (shape.fill) {
    ctx.globalAlpha = (shape.opacity ?? 1) * 0.18;
    ctx.fill(shapePath(shape));
    ctx.globalAlpha = shape.opacity ?? 1;
  }
  ctx.stroke(shapePath(shape));
  if (shape.shape === 'arrow') arrowHead(ctx, shape.x, shape.y, shape.x2, shape.y2, shape.size);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Hit testing — used by the eraser and the lasso
// ---------------------------------------------------------------------------

function bboxHit(bbox, x, y, radius) {
  return (
    x >= bbox[0] - radius && x <= bbox[2] + radius && y >= bbox[1] - radius && y <= bbox[3] + radius
  );
}

function segmentDistanceSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) ** 2 + (py - cy) ** 2;
}

/** True when (x, y) is within `radius` of the stroke's centreline. */
export function strokeHit(stroke, x, y, radius) {
  if (!bboxHit(stroke.bbox, x, y, radius)) return false;
  const reach = radius + stroke.size / 2;
  const reachSq = reach * reach;
  const points = stroke.points;
  if (points.length === 1) {
    return (points[0][0] - x) ** 2 + (points[0][1] - y) ** 2 <= reachSq;
  }
  for (let i = 1; i < points.length; i += 1) {
    if (segmentDistanceSq(x, y, points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]) <= reachSq) {
      return true;
    }
  }
  return false;
}

/**
 * Hit test a shape against its outline rather than its bounding box. Testing
 * the box would let the eraser swallow a large rectangle from the empty middle,
 * nowhere near anything actually drawn.
 */
export function shapeHit(shape, x, y, radius) {
  const reach = radius + shape.size / 2;
  const reachSq = reach * reach;
  const { x: ax, y: ay, x2: bx, y2: by } = shape;

  switch (shape.shape) {
    case 'line':
    case 'arrow':
      return segmentDistanceSq(x, y, ax, ay, bx, by) <= reachSq;

    case 'rect': {
      const left = Math.min(ax, bx);
      const right = Math.max(ax, bx);
      const top = Math.min(ay, by);
      const bottom = Math.max(ay, by);
      // A filled shape is grabbable anywhere inside it; an outline only at its edges.
      if (shape.fill) {
        return x >= left - reach && x <= right + reach && y >= top - reach && y <= bottom + reach;
      }
      const edges = [
        [left, top, right, top],
        [right, top, right, bottom],
        [right, bottom, left, bottom],
        [left, bottom, left, top],
      ];
      return edges.some(([sx, sy, ex, ey]) => segmentDistanceSq(x, y, sx, sy, ex, ey) <= reachSq);
    }

    case 'ellipse': {
      const cx = (ax + bx) / 2;
      const cy = (ay + by) / 2;
      const rx = Math.abs(bx - ax) / 2;
      const ry = Math.abs(by - ay) / 2;
      if (rx < 0.5 || ry < 0.5) return false;
      // Normalised radius: 1 is exactly on the rim. Converting the reach into
      // that space is approximate for very eccentric ellipses but plenty
      // accurate for deciding whether a pointer is on the line.
      const normalized = Math.hypot((x - cx) / rx, (y - cy) / ry);
      const tolerance = reach / Math.min(rx, ry);
      return shape.fill ? normalized <= 1 + tolerance : Math.abs(normalized - 1) <= tolerance;
    }

    default:
      return false;
  }
}

/** Approximate footprint of a placed object, in page space. */
export function objectBounds(object) {
  if (object.kind === 'shape') {
    return [
      Math.min(object.x, object.x2),
      Math.min(object.y, object.y2),
      Math.max(object.x, object.x2),
      Math.max(object.y, object.y2),
    ];
  }
  if (object.kind === 'text') {
    const width = object.width || 220;
    // `height` is cached by the viewer from the rendered element; before that
    // has happened, one line is a safe assumption.
    const height = object.height || (object.fontSize || 15) * 1.4;
    return [object.x, object.y, object.x + width, object.y + height];
  }
  // A note is anchored by its dot; give it a small square to grab.
  const r = 9;
  return [object.x - r, object.y - r, object.x + r, object.y + r];
}

/** Whether the eraser at (x, y) should take this object. */
export function objectHit(object, x, y, radius) {
  if (object.kind === 'shape') return shapeHit(object, x, y, radius);
  const [x0, y0, x1, y1] = objectBounds(object);
  return x >= x0 - radius && x <= x1 + radius && y >= y0 - radius && y <= y1 + radius;
}

/** Ray casting against the lasso polygon. */
export function pointInPolygon(polygon, x, y) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * A stroke counts as lassoed when most of it is enclosed. Requiring every point
 * makes the tool feel broken on long strokes; requiring one makes it grab
 * neighbours you did not mean to catch.
 */
export function strokeInPolygon(stroke, polygon, threshold = 0.6) {
  const points = stroke.points;
  let inside = 0;
  for (const [x, y] of points) if (pointInPolygon(polygon, x, y)) inside += 1;
  return inside / points.length >= threshold;
}
