#!/usr/bin/env node
// The sidebar: page thumbnails, search results and edit history.
//
// The thumbnail check exists because of a bug that only appeared on a long
// document: thumbnails are flex items in a column, and flex items shrink by
// default, so once the list overflowed its container every thumbnail was
// squashed to nothing and the sidebar became a stack of hairlines. Asserting a
// thumbnail keeps its aspect-ratio height catches that at any page count.
//
// Usage: node scripts/test-sidebar.mjs

import { launch, evaluate, drag, sleep, createReporter } from './lib/cdp.mjs';
import { clearSidecar, samplePdf } from './lib/fixture.mjs';

const PORT = 9340;

async function main() {
  clearSidecar();
  const report = createReporter();
  const { send, close, consoleLines } = await launch({ port: PORT, pdf: samplePdf() });

  try {
    await evaluate(send, `document.getElementById('btn-sidebar').click()`);
    await sleep(1800);

    // --- 1. thumbnails keep their shape -----------------------------------
    const thumbs = await evaluate(
      send,
      `(() => {
        const items = [...document.querySelectorAll('.thumb')];
        if (!items.length) return null;
        return items.slice(0, 3).map((item) => {
          const box = item.getBoundingClientRect();
          const ratio = item.querySelector('canvas').style.aspectRatio.split('/').map(Number);
          return {
            height: Math.round(box.height),
            expected: Math.round((box.width * ratio[1]) / ratio[0]),
          };
        });
      })()`
    );
    const squashed = (thumbs || []).filter((t) => Math.abs(t.height - t.expected) > 8);
    report.check(
      'thumbnails keep their aspect-ratio height',
      thumbs?.length > 0 && squashed.length === 0,
      thumbs ? thumbs.map((t) => `${t.height}/${t.expected}`).join(' ') : 'no thumbnails'
    );

    // --- 2. history records what was done ---------------------------------
    await evaluate(send, `document.querySelector('.tool[aria-label="Pen"]').click()`);
    await sleep(300);
    await drag(send, { x: 520, y: 545 }, { x: 860, y: 552 }, 14);
    await sleep(800);

    await evaluate(send, `document.querySelectorAll('.sidebar-tabs button')[2].click()`);
    await sleep(500);
    const history = await evaluate(
      send,
      `JSON.stringify([...document.querySelectorAll('.history-row .history-label')].map((n) => n.textContent))`
    );
    report.check(
      'history lists the stroke that was drawn',
      (history || '').includes('Pen stroke'),
      history
    );

    // --- 3. travelling back through history --------------------------------
    const strokesNow = () =>
      evaluate(send, `document.getElementById('doc-subtitle').textContent`);

    await evaluate(send, `document.querySelector('.history-row.base').click()`);
    await sleep(700);
    const atOrigin = await strokesNow();
    report.check('clicking “Original document” undoes everything', /0 strokes/.test(atOrigin), atOrigin);

    // The undone entry stays listed, so it can be travelled back to.
    await evaluate(
      send,
      `[...document.querySelectorAll('.history-row')].find((r) => r.textContent.includes('Pen stroke')).click()`
    );
    await sleep(700);
    const restored = await strokesNow();
    report.check('travelling forward restores it', /1 stroke/.test(restored), restored);

    // --- 4. search results are listed by page ------------------------------
    const results = await evaluate(
      send,
      `(async () => {
        document.getElementById('search-bar').hidden = false;
        document.querySelectorAll('.sidebar-tabs button')[1].click();
        const input = document.getElementById('search-input');
        input.value = 'highlighter';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 3000));
        return JSON.stringify({
          rows: document.querySelectorAll('.result').length,
          pages: [...document.querySelectorAll('.result-page')].map((n) => n.textContent),
          marked: document.querySelector('.result mark')?.textContent ?? null,
        });
      })()`
    );
    const parsed = JSON.parse(results || '{}');
    report.check('results are listed', (parsed.rows ?? 0) > 0, `${parsed.rows} rows`);
    report.check(
      'results are grouped by page number',
      (parsed.pages || []).every((label) => /^Page \d+$/.test(label)) && parsed.pages.length > 0,
      (parsed.pages || []).join(', ')
    );
    report.check(
      'each result shows the matched text',
      (parsed.marked || '').toLowerCase() === 'highlighter',
      JSON.stringify(parsed.marked)
    );

    const problems = consoleLines.filter((line) => /error|exception/i.test(line));
    report.check('no renderer errors', problems.length === 0, problems.slice(0, 2).join(' | '));
  } finally {
    await close();
    clearSidecar();
  }

  report.finish('the sidebar lists pages, search results by page, and a travellable history');
}

main().catch((err) => {
  console.error(err.message);
  clearSidecar();
  process.exit(1);
});
