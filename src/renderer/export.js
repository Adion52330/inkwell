// Flattening ink into a shareable PDF.
//
// The original file is never touched. A fresh document is assembled by copying
// pages in the viewer's current order, then the ink is drawn into each one.
//
// The coordinate problem: ink is stored in *viewport* space (top-left origin,
// y down, intrinsic page rotation already applied), while a PDF content stream
// works in *user* space (bottom-left origin, y up, unrotated MediaBox). Rather
// than hand-deriving that mapping per rotation and hoping, we invert the very
// matrix pdf.js used to lay the page out. That is exact for every /Rotate
// value and for pages whose MediaBox does not start at the origin.

import { PDFDocument, StandardFonts, rgb, degrees, BlendMode } from 'pdf-lib';
import { strokeToOutline } from './ink-render.js';

const IDENTITY_FLIP = (height) => [1, 0, 0, -1, 0, height];

function invert([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  if (!det) return [1, 0, 0, 1, 0, 0];
  return [
    d / det,
    -b / det,
    -c / det,
    a / det,
    (c * f - d * e) / det,
    (b * e - a * f) / det,
  ];
}

const applyMatrix = ([a, b, c, d, e, f], x, y) => [a * x + c * y + e, b * x + d * y + f];

function hexToRgb(hex) {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((ch) => ch + ch).join('') : value;
  const int = parseInt(full, 16);
  return rgb(((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255);
}

/**
 * Build an SVG path in PDF user space. drawSvgPath applies scale(1, -1) after
 * translating, so y is pre-negated here and comes out the right way up.
 */
function outlineToUserPath(outline, matrix) {
  if (!outline || outline.length < 2) return '';
  const parts = [];
  const [firstX, firstY] = applyMatrix(matrix, outline[0][0], outline[0][1]);
  parts.push(`M ${firstX.toFixed(3)} ${(-firstY).toFixed(3)}`);
  // Same midpoint-quadratic smoothing the screen renderer uses, so an exported
  // stroke is the identical shape rather than a polygonal approximation.
  for (let i = 1; i < outline.length; i += 1) {
    const [cx, cy] = applyMatrix(matrix, outline[i - 1][0], outline[i - 1][1]);
    const [nx, ny] = applyMatrix(matrix, outline[i][0], outline[i][1]);
    const midX = (cx + nx) / 2;
    const midY = (cy + ny) / 2;
    parts.push(
      `Q ${cx.toFixed(3)} ${(-cy).toFixed(3)} ${midX.toFixed(3)} ${(-midY).toFixed(3)}`
    );
  }
  parts.push('Z');
  return parts.join(' ');
}

/** Convert a canvas Path2D-shaped record into an SVG path string. */
function shapeToUserPath(shape, matrix) {
  const point = (x, y) => {
    const [ux, uy] = applyMatrix(matrix, x, y);
    return `${ux.toFixed(3)} ${(-uy).toFixed(3)}`;
  };
  const { x, y, x2, y2 } = shape;
  switch (shape.shape) {
    case 'line':
    case 'arrow':
      return `M ${point(x, y)} L ${point(x2, y2)}`;
    case 'rect': {
      const left = Math.min(x, x2);
      const right = Math.max(x, x2);
      const top = Math.min(y, y2);
      const bottom = Math.max(y, y2);
      return `M ${point(left, top)} L ${point(right, top)} L ${point(right, bottom)} L ${point(
        left,
        bottom
      )} Z`;
    }
    case 'ellipse': {
      // Four cubic segments; k is the standard circle-to-Bezier constant.
      const cx = (x + x2) / 2;
      const cy = (y + y2) / 2;
      const rx = Math.abs(x2 - x) / 2;
      const ry = Math.abs(y2 - y) / 2;
      const k = 0.5522847498;
      return [
        `M ${point(cx - rx, cy)}`,
        `C ${point(cx - rx, cy - ry * k)} ${point(cx - rx * k, cy - ry)} ${point(cx, cy - ry)}`,
        `C ${point(cx + rx * k, cy - ry)} ${point(cx + rx, cy - ry * k)} ${point(cx + rx, cy)}`,
        `C ${point(cx + rx, cy + ry * k)} ${point(cx + rx * k, cy + ry)} ${point(cx, cy + ry)}`,
        `C ${point(cx - rx * k, cy + ry)} ${point(cx - rx, cy + ry * k)} ${point(cx - rx, cy)}`,
        'Z',
      ].join(' ');
    }
    default:
      return '';
  }
}

function arrowHeadPath(shape, matrix) {
  const angle = Math.atan2(shape.y2 - shape.y, shape.x2 - shape.x);
  const len = Math.max(shape.size * 3.2, 8);
  const spread = Math.PI / 7;
  const tip = [shape.x2, shape.y2];
  const left = [
    shape.x2 - len * Math.cos(angle - spread),
    shape.y2 - len * Math.sin(angle - spread),
  ];
  const right = [
    shape.x2 - len * Math.cos(angle + spread),
    shape.y2 - len * Math.sin(angle + spread),
  ];
  const point = ([x, y]) => {
    const [ux, uy] = applyMatrix(matrix, x, y);
    return `${ux.toFixed(3)} ${(-uy).toFixed(3)}`;
  };
  return `M ${point(tip)} L ${point(left)} L ${point(right)} Z`;
}

/** WinAnsi cannot encode every character; swap the ones Helvetica would reject. */
function sanitize(text) {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–-]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '?');
}

function wrapText(text, font, size, maxWidth) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !current) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }
  return lines;
}

/**
 * @param {object} params
 * @param {import('./store.js').Store} params.store
 * @param {Uint8Array} params.originalBytes  bytes of the opened PDF
 * @param {Map<string, Uint8Array>} params.sourceBytes  appended documents
 */
export async function buildAnnotatedPdf({ store, originalBytes, sourceBytes }) {
  const doc = store.doc;
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);

  const main = await PDFDocument.load(originalBytes, { ignoreEncryption: true });
  const loaded = new Map([['__main__', main]]);
  for (const [key, bytes] of sourceBytes) {
    loaded.set(key, await PDFDocument.load(bytes, { ignoreEncryption: true }));
  }

  // Copying is grouped per source document: copyPages rebuilds the object graph
  // each call, so one call per page is dramatically slower on large documents.
  const plan = doc.pages.map((page, index) => {
    if (page.inserted) return { kind: 'blank', index };
    if (page.source) return { kind: 'copy', key: page.source, srcIndex: page.sourceIndex, index };
    const srcIndex = doc.order[index];
    if (srcIndex == null || srcIndex < 0) return { kind: 'blank', index };
    return { kind: 'copy', key: '__main__', srcIndex, index };
  });

  const copied = new Map();
  for (const [key, srcDoc] of loaded) {
    const wanted = plan.filter((item) => item.kind === 'copy' && item.key === key);
    if (!wanted.length) continue;
    const pages = await out.copyPages(srcDoc, wanted.map((item) => item.srcIndex));
    wanted.forEach((item, i) => copied.set(item.index, pages[i]));
  }

  for (const item of plan) {
    const pageIndex = item.index;
    const model = doc.pages[pageIndex];
    const size = store.pageSize(pageIndex);

    let page;
    if (item.kind === 'blank') {
      page = out.addPage([size.width, size.height]);
    } else {
      page = out.addPage(copied.get(pageIndex));
    }

    if (model.rotation) {
      page.setRotation(degrees((page.getRotation().angle + model.rotation) % 360));
    }

    // Matrix from stored (viewport) space into this page's user space.
    const forward = size.transform || IDENTITY_FLIP(size.height);
    const matrix = invert(forward);

    // Highlighter underneath, matching the on-screen z-order.
    for (const stroke of model.strokes) {
      if (stroke.tool !== 'highlighter') continue;
      const path = outlineToUserPath(strokeToOutline(stroke), matrix);
      if (!path) continue;
      page.drawSvgPath(path, {
        x: 0,
        y: 0,
        color: hexToRgb(stroke.color),
        opacity: stroke.opacity ?? 0.4,
        // Multiply is what keeps the words under a highlight readable. Plain
        // alpha would wash them out.
        blendMode: BlendMode.Multiply,
        borderWidth: 0,
      });
    }

    for (const object of model.objects) {
      if (object.kind !== 'shape') continue;
      const path = shapeToUserPath(object, matrix);
      if (!path) continue;
      if (object.fill) {
        page.drawSvgPath(path, {
          x: 0,
          y: 0,
          color: hexToRgb(object.color),
          opacity: (object.opacity ?? 1) * 0.18,
          borderWidth: 0,
        });
      }
      page.drawSvgPath(path, {
        x: 0,
        y: 0,
        borderColor: hexToRgb(object.color),
        borderWidth: object.size,
        borderOpacity: object.opacity ?? 1,
      });
      if (object.shape === 'arrow') {
        page.drawSvgPath(arrowHeadPath(object, matrix), {
          x: 0,
          y: 0,
          color: hexToRgb(object.color),
          opacity: object.opacity ?? 1,
          borderWidth: 0,
        });
      }
    }

    for (const stroke of model.strokes) {
      if (stroke.tool === 'highlighter') continue;
      const path = outlineToUserPath(strokeToOutline(stroke), matrix);
      if (!path) continue;
      page.drawSvgPath(path, {
        x: 0,
        y: 0,
        color: hexToRgb(stroke.color),
        opacity: stroke.opacity ?? 1,
        borderWidth: 0,
      });
    }

    // Text is drawn along the page's own axis, derived from the matrix so it
    // stays upright on a page with intrinsic rotation.
    const [ox, oy] = applyMatrix(matrix, 0, 0);
    const [ax, ay] = applyMatrix(matrix, 1, 0);
    const angle = (Math.atan2(ay - oy, ax - ox) * 180) / Math.PI;

    for (const object of model.objects) {
      if (object.kind === 'text') {
        if (!object.text?.trim()) continue;
        const size2 = object.fontSize || 15;
        const lineHeight = size2 * 1.32;
        const lines = wrapText(sanitize(object.text), font, size2, object.width || 220);
        lines.forEach((line, i) => {
          // Stored y is the top of the box; the first baseline sits one ascent
          // below it.
          const [ux, uy] = applyMatrix(matrix, object.x, object.y + size2 * 0.85 + i * lineHeight);
          page.drawText(line, {
            x: ux,
            y: uy,
            size: size2,
            font,
            color: hexToRgb(object.color),
            rotate: degrees(angle),
          });
        });
      } else if (object.kind === 'note') {
        // A real /Text annotation, so other viewers show it as a comment
        // rather than a coloured square burned into the page.
        const [ux, uy] = applyMatrix(matrix, object.x, object.y);
        const colour = hexToRgb(object.color);
        const annot = out.context.obj({
          Type: 'Annot',
          Subtype: 'Text',
          Name: 'Comment',
          Rect: [ux, uy - 20, ux + 20, uy],
          Contents: sanitize(object.text || ''),
          T: 'Inkwell',
          C: [colour.red, colour.green, colour.blue],
          F: 4, // print
        });
        page.node.addAnnot(out.context.register(annot));
      }
    }
  }

  out.setProducer('Inkwell');
  out.setCreator('Inkwell');
  return out.save();
}

export function suggestExportName(pdfName) {
  return pdfName.replace(/\.pdf$/i, '') + '-annotated.pdf';
}
