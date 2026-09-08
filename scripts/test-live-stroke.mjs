#!/usr/bin/env node
// The live stroke must be drawn where the pointer actually is.
//
// The wet canvas is cleared in device pixels but must be handed back to the
// caller in page space. When that transform was left on the identity matrix,
// the in-progress stroke painted at raw pixel coordinates: it appeared offset
// and shrunk by the zoom factor while drawing, then snapped into place on
// release when the committed layer repainted. The two positions disagreeing is
// the bug, so this drives a drag, captures the page mid-stroke and again after
// release, and asserts the ink occupies the same box both times.
//
// Usage: node scripts/test-live-stroke.mjs [--out <dir>]
//        python3 scripts/check-live-stroke.py <dir>

import fs from 'fs';
import path from 'path';

import { launch, evaluate, mouse, sleep, screenshot } from './lib/cdp.mjs';
import { clearSidecar, samplePdf } from './lib/fixture.mjs';

const PORT = 9335;
const outArg = process.argv.indexOf('--out');
const outDir = outArg !== -1 ? process.argv[outArg + 1] : path.join(process.cwd(), 'dist/live-stroke');

// Where to drag, in client coordinates: a blank band of page one between the
// last paragraph and the ruled area, so the only dark pixels there are ours.
const DRAG = { y: 545, x0: 500, x1: 900 };
const BAND = { top: 520, bottom: 575, left: 470, right: 930 };

async function main() {
  if (!fs.existsSync(samplePdf())) throw new Error('run `npm run sample` first');
  clearSidecar();
  fs.mkdirSync(outDir, { recursive: true });

  const { send, close } = await launch({ port: PORT, pdf: samplePdf() });

  try {
    // Dismiss anything overlapping the test area, and confirm the default pen
    // is active before drawing.
    const tool = await evaluate(
      send,
      `(() => {
        document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        return document.querySelector('.tool.active')?.getAttribute('aria-label');
      })()`
    );
    if (tool !== 'Pen') throw new Error(`expected the Pen tool to be active, got ${tool}`);
    await sleep(500);

    // Press and move, but do not release - the bug only showed mid-gesture, so
    // the first capture has to happen before the pointer comes up.
    await mouse(send, 'mousePressed', DRAG.x0, DRAG.y);
    const steps = 24;
    for (let i = 1; i <= steps; i += 1) {
      await mouse(send, 'mouseMoved', DRAG.x0 + ((DRAG.x1 - DRAG.x0) * i) / steps, DRAG.y);
    }
    await sleep(350); // let the rAF flush paint the wet layer

    const during = await screenshot(send, path.join(outDir, 'during.png'));

    await mouse(send, 'mouseReleased', DRAG.x1, DRAG.y);
    await sleep(500);
    const after = await screenshot(send, path.join(outDir, 'after.png'));

    // The checker reads the search box from here rather than repeating it.
    fs.writeFileSync(
      path.join(outDir, 'meta.json'),
      JSON.stringify({ drag: DRAG, band: BAND }, null, 2)
    );
    console.log(`captured ${during} and ${after}`);
  } finally {
    await close();
    clearSidecar();
  }
}

main().catch((err) => {
  console.error(err.message);
  clearSidecar();
  process.exit(1);
});
