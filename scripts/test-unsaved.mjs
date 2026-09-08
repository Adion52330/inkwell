#!/usr/bin/env node
// Closing with unsaved work must ask first.
//
// The main process vetoes the close and hands the decision to the renderer,
// which puts a native Save / Don't Save / Cancel dialog up. A native dialog
// cannot be inspected over the DevTools Protocol, but its effect can: while it
// is waiting, the window must still exist. So the test asks whether the page
// target survives a close attempt - vetoed when dirty, gone when clean.
//
// Checking through the target list rather than through the page means a modal
// dialog cannot wedge the test.
//
// Usage: node scripts/test-unsaved.mjs

import { launch, evaluate, drag, sleep, createReporter } from './lib/cdp.mjs';
import { clearSidecar, samplePdf } from './lib/fixture.mjs';

const PORT = 9338;

const targetAlive = async () => {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/json`);
    const targets = await response.json();
    return targets.some((t) => t.type === 'page');
  } catch {
    return false;
  }
};

async function phase(report, { name, dirty }) {
  clearSidecar();
  const { send, close } = await launch({ port: PORT, pdf: samplePdf() });
  try {
    if (dirty) {
      // Draw, then attempt the close inside the autosave debounce so the
      // document is genuinely unsaved at the moment of the attempt.
      await drag(send, { x: 500, y: 545 }, { x: 820, y: 560 }, 16);
      await sleep(120);
      // The window title carries the unsaved marker.
      const state = await evaluate(send, `document.title`);
      report.check(`${name}: window title marks it unsaved`, state.startsWith('•'), state);
    } else {
      // Nothing drawn, so there is nothing outstanding to save.
      await sleep(400);
      const state = await evaluate(send, `document.title`);
      report.check(`${name}: window title has no unsaved marker`, !state.startsWith('•'), state);
    }

    // Fire and forget: if a dialog opens, this never resolves.
    evaluate(send, 'window.close()').catch(() => {});
    await sleep(1600);

    const alive = await targetAlive();
    if (dirty) {
      report.check(`${name}: close is held for confirmation`, alive, alive ? 'window still open' : 'window closed without asking');
    } else {
      report.check(`${name}: close goes straight through`, !alive, alive ? 'window still open' : 'window closed');
    }
  } finally {
    await close();
    clearSidecar();
    await sleep(300);
  }
}

async function main() {
  const report = createReporter();
  await phase(report, { name: 'clean', dirty: false });
  await phase(report, { name: 'unsaved', dirty: true });
  report.finish('closing with unsaved ink asks first, and closing a saved document does not');
}

main().catch((err) => {
  console.error(err.message);
  clearSidecar();
  process.exit(1);
});
