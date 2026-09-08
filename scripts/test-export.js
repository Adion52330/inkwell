// End-to-end check of the export coordinate mapping.
//
// The invariant worth testing is this: ink is stored in *viewport* space, which
// is exactly what the user sees. So a stroke drawn at page-space (x, y) must
// land at (x, y) in a 72 dpi raster of the exported page — including on a page
// with /Rotate 90, where the naive mapping silently transposes everything.
//
// Run via `npm run test:export`, which bundles this and rasterises the result.

import fs from 'fs';
import path from 'path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import { Store } from '../src/renderer/store.js';
import { buildAnnotatedPdf } from '../src/renderer/export.js';

// Paths come from argv: this file is bundled before it runs, so import.meta.url
// points at the bundle rather than at the repository.
const samplePath = process.argv[2] || path.join(process.cwd(), 'sample', 'sample.pdf');
const outPath = process.argv[3] || path.join(process.cwd(), 'sample', 'export-test.pdf');

// Where the probe strokes go, in page space (PDF points from the top-left).
export const PROBE = { x0: 100, x1: 300, y: 200, size: 12 };

// In Node the worker has to be pointed at explicitly; without it pdf.js falls
// back to a "fake worker" that cannot resolve its own module path.
pdfjs.GlobalWorkerOptions.workerSrc = path.join(
  process.cwd(),
  'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'
);

async function main() {
  const bytes = new Uint8Array(fs.readFileSync(samplePath));

  // Read real viewport matrices from pdf.js — the whole point is to verify the
  // exporter against the same numbers the viewer lays pages out with.
  const doc = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false }).promise;
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

  const store = new Store();
  store.open({
    path: samplePath,
    name: 'sample.pdf',
    hash: 'test',
    pageCount: doc.numPages,
    sizes,
  });

  // A pure red horizontal bar on every page, at identical page-space coords.
  for (let i = 0; i < doc.numPages; i += 1) {
    const points = [];
    for (let x = PROBE.x0; x <= PROBE.x1; x += 4) points.push([x, PROBE.y, 0.9]);
    store.addStroke(i, {
      tool: 'pen',
      color: '#FF0000',
      size: PROBE.size,
      opacity: 1,
      points,
    });
  }

  const out = await buildAnnotatedPdf({
    store,
    originalBytes: bytes,
    sourceBytes: new Map(),
  });
  fs.writeFileSync(outPath, out);
  console.log(
    JSON.stringify({
      out: outPath,
      pages: doc.numPages,
      rotations: sizes.map((s) => s.rotate),
      viewportSizes: sizes.map((s) => [Math.round(s.width), Math.round(s.height)]),
      probe: PROBE,
    })
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
