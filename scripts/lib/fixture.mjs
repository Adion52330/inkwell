// Seeds a known sidecar next to the sample PDF, so tests start from a
// deterministic page instead of having to draw everything through the UI first.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const samplePdf = () => path.join(process.cwd(), 'sample/sample.pdf');
export const sampleSidecar = () => path.join(process.cwd(), 'sample/sample.ink.json');

export const uid = () => crypto.randomUUID();

/** Page geometry matching scripts/make-sample.js, including its rotated page. */
const SIZES = [
  { width: 612, height: 792, rotate: 0, transform: [1, 0, 0, -1, 0, 792] },
  { width: 595.28, height: 841.89, rotate: 0, transform: [1, 0, 0, -1, 0, 841.89] },
  { width: 792, height: 612, rotate: 90, transform: [0, 1, 1, 0, 0, 0] },
];

/** A pure-red rectangle: easy to find in a canvas, easy to reason about. */
export function redRect({ x = 120, y = 430, x2 = 420, y2 = 560, size = 3, fill = false } = {}) {
  return {
    id: uid(),
    kind: 'shape',
    shape: 'rect',
    x,
    y,
    x2,
    y2,
    color: '#FF0000',
    size,
    opacity: 1,
    fill,
  };
}

export function textBox({ x = 120, y = 600, text = 'delete me' } = {}) {
  return { id: uid(), kind: 'text', x, y, width: 200, text, color: '#1C1C1E', fontSize: 15 };
}

export function note({ x = 470, y = 610, text = 'note' } = {}) {
  return { id: uid(), kind: 'note', x, y, text, color: '#FFD60A', collapsed: true };
}

/** Write a sidecar whose first page carries the given strokes and objects. */
export function seedSidecar({ strokes = [], objects = [] } = {}) {
  const pdf = samplePdf();
  if (!fs.existsSync(pdf)) throw new Error('run `npm run sample` first');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(pdf)).digest('hex').slice(0, 32);
  const blank = { strokes: [], objects: [], rotation: 0, inserted: false };

  fs.writeFileSync(
    sampleSidecar(),
    JSON.stringify({
      version: 1,
      app: 'inkwell',
      hash,
      savedAt: new Date().toISOString(),
      sizes: SIZES,
      order: [0, 1, 2],
      pages: [{ ...blank, strokes, objects }, blank, blank],
    })
  );
  return sampleSidecar();
}

export function clearSidecar() {
  fs.rmSync(sampleSidecar(), { force: true });
}
