#!/usr/bin/env node
// Removing things from a page.
//
// Covers three reported problems:
//   1. Erasing a shape appeared to work, then the shape came back. The eraser
//      collected shape ids but only ever called removeStrokes, so nothing was
//      deleted and the next repaint restored it.
//   2. Text boxes had no delete affordance at all.
//   3. Selecting a note and pressing Delete did nothing, because the view and
//      the ink engine each held their own copy of the selection - and even once
//      the model was updated, the object DOM layer was never rebuilt.
//
// The page is inspected through the DOM and the ink canvas only; no test-only
// hooks exist in the app, so this drives exactly the paths a user drives.
//
// Usage: node scripts/test-objects.mjs

import { launch, evaluate, drag, sleep, FIND_RED, createReporter } from './lib/cdp.mjs';
import { seedSidecar, clearSidecar, redRect, textBox, note, samplePdf } from './lib/fixture.mjs';

const PORT = 9336;

async function main() {
  seedSidecar({ objects: [redRect(), textBox(), note()] });
  const report = createReporter();
  const { send, close } = await launch({ port: PORT, pdf: samplePdf() });

  try {
    // --- 1. the shape is there to begin with -------------------------------
    const before = await evaluate(send, FIND_RED());
    report.check('seeded rectangle renders', (before?.count ?? 0) > 0, `${before?.count ?? 0} red px`);
    if (!before?.count) throw new Error('nothing to erase; aborting');

    // --- 2. erase across its top edge --------------------------------------
    await evaluate(send, `document.querySelector('.tool[aria-label="Eraser"]').click()`);
    await sleep(300);
    const { x0, x1, y0 } = before.client;
    await drag(send, { x: x0 - 10, y: y0 + 2 }, { x: x1 + 10, y: y0 + 2 });
    await sleep(600);

    const erased = await evaluate(send, FIND_RED());
    report.check('erased shape is gone', (erased?.count ?? 0) === 0, `${erased?.count ?? 0} red px`);

    // The original symptom was that it returned on the next repaint, so force
    // one by scrolling the page out of view and back.
    await evaluate(send, `document.getElementById('viewer').scrollTop += 400`);
    await sleep(500);
    await evaluate(send, `document.getElementById('viewer').scrollTop -= 400`);
    await sleep(900);
    const repainted = await evaluate(send, FIND_RED());
    report.check(
      'erased shape stays gone after a repaint',
      (repainted?.count ?? 0) === 0,
      `${repainted?.count ?? 0} red px`
    );

    // --- 3. undo brings it back --------------------------------------------
    // Objects live in the DOM as well as on canvas, so an undo that only
    // restored the model would leave the screen wrong.
    await evaluate(send, `document.getElementById('btn-undo').click()`);
    await sleep(700);
    const undone = await evaluate(send, FIND_RED());
    report.check('undo restores the erased shape', (undone?.count ?? 0) > 0, `${undone?.count ?? 0} red px`);

    // --- 4. a text box can be deleted from its own button ------------------
    const textDeleted = await evaluate(
      send,
      `(async () => {
        const box = document.querySelector('.obj-text');
        if (!box) return 'no text box rendered';
        const button = box.querySelector('.obj-remove');
        if (!button) return 'no delete button';
        button.click();
        await new Promise((r) => setTimeout(r, 400));
        return document.querySelector('.obj-text') ? 'still present' : 'removed';
      })()`
    );
    report.check('text box deletes from its × button', textDeleted === 'removed', textDeleted);

    // --- 5. a note can be selected and deleted with the keyboard -----------
    const noteDeleted = await evaluate(
      send,
      `(async () => {
        const el = document.querySelector('.obj-note');
        if (!el) return 'no note rendered';
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        await new Promise((r) => setTimeout(r, 200));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
        await new Promise((r) => setTimeout(r, 400));
        return document.querySelector('.obj-note') ? 'still present' : 'removed';
      })()`
    );
    report.check('note deletes via select + Delete', noteDeleted === 'removed', noteDeleted);
  } finally {
    await close();
    clearSidecar();
  }

  report.finish('shapes, text boxes and notes can all be removed, restored and stay that way');
}

main().catch((err) => {
  console.error(err.message);
  clearSidecar();
  process.exit(1);
});
