#!/usr/bin/env node
// The text layer: selection, search and links.
//
// All three ride on the same thing — pdf.js's transparent text spans sitting
// exactly over the rendered glyphs — so all three break together when the
// layer is misaligned. That is not hypothetical: the spans' geometry depends on
// CSS variables (--total-scale-factor and friends) that pdf.js declares on its
// own page element. Missing them, the layer still renders and still reports
// text, but every span is in the wrong place: selection grabs the wrong words
// and search highlights float away from what they matched.
//
// So the first check here is alignment, measured in PDF points against the
// coordinates scripts/make-sample.js actually drew the text at.
//
// Usage: node scripts/test-text.mjs

import { launch, evaluate, drag, sleep, createReporter } from './lib/cdp.mjs';
import { clearSidecar, samplePdf } from './lib/fixture.mjs';

const PORT = 9339;

// scripts/make-sample.js draws body text with its left edge at x = 56pt.
const TEXT_LEFT_PT = 56;

async function main() {
  clearSidecar();
  const report = createReporter();
  const { send, close, consoleLines } = await launch({ port: PORT, pdf: samplePdf() });

  try {
    // --- 1. the layer exists and lines up ---------------------------------
    const geometry = await evaluate(
      send,
      `(() => {
        const page = document.querySelector('.page[data-index="0"]');
        const rect = page.getBoundingClientRect();
        const scale = parseFloat(getComputedStyle(page).getPropertyValue('--scale-factor'));
        const spans = [...page.querySelectorAll('.textLayer span')];
        const span = spans.find((s) => s.textContent.startsWith('Write on this page'));
        if (!span) return { spans: spans.length };
        const box = span.getBoundingClientRect();
        return { spans: spans.length, scale, leftPt: (box.left - rect.left) / scale };
      })()`
    );
    report.check('text layer renders spans', (geometry?.spans ?? 0) > 0, `${geometry?.spans ?? 0} spans`);
    const drift = Math.abs((geometry?.leftPt ?? Infinity) - TEXT_LEFT_PT);
    report.check(
      'spans sit over the glyphs they describe',
      drift < 1,
      `left edge ${geometry?.leftPt?.toFixed(2)}pt vs ${TEXT_LEFT_PT}pt drawn`
    );

    // --- 2. selection ------------------------------------------------------
    await evaluate(send, `document.querySelector('.tool[aria-label="Select text"]').click()`);
    await sleep(400);
    const target = await evaluate(
      send,
      `(() => {
        const span = [...document.querySelectorAll('.page[data-index="0"] .textLayer span')]
          .find((s) => s.textContent.includes('multiply blend'));
        if (!span) return null;
        const r = span.getBoundingClientRect();
        return { x0: r.left + 2, x1: r.right - 2, y: r.top + r.height / 2 };
      })()`
    );
    if (target) {
      await drag(send, { x: target.x0, y: target.y }, { x: target.x1, y: target.y }, 14);
      await sleep(350);
    }
    const selected = await evaluate(send, `window.getSelection().toString()`);
    report.check(
      'dragging selects the text under the pointer',
      typeof selected === 'string' && selected.includes('multiply blend'),
      JSON.stringify((selected || '').slice(0, 48))
    );

    // --- 3. search ---------------------------------------------------------
    const found = await evaluate(
      send,
      `(async () => {
        const input = document.getElementById('search-input');
        document.getElementById('search-bar').hidden = false;
        input.value = 'multiply';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 2500));
        return document.getElementById('search-count').textContent;
      })()`
    );
    report.check('search reports matches', /\d+ of \d+/.test(found || ''), found);

    const overlap = await evaluate(
      send,
      `(() => {
        const hit = document.querySelector('.page[data-index="0"] .search-hit');
        const span = [...document.querySelectorAll('.page[data-index="0"] .textLayer span')]
          .find((s) => s.textContent.includes('multiply'));
        if (!hit || !span) return null;
        const h = hit.getBoundingClientRect();
        const s = span.getBoundingClientRect();
        // The highlight must sit on the line it matched, not merely somewhere.
        const verticalGap = Math.abs(h.top - s.top);
        const withinLine = h.left >= s.left - 2 && h.right <= s.right + 2;
        return { verticalGap, withinLine };
      })()`
    );
    report.check(
      'search highlight lands on the matched text',
      overlap && overlap.verticalGap < 6 && overlap.withinLine,
      overlap ? `${overlap.verticalGap.toFixed(1)}px above/below, within line: ${overlap.withinLine}` : 'no highlight'
    );

    // --- 4. links ----------------------------------------------------------
    await evaluate(send, `document.getElementById('viewer').scrollTop = 99999`);
    let links = 0;
    for (let attempt = 0; attempt < 14 && !links; attempt += 1) {
      await sleep(600);
      links = await evaluate(send, `document.querySelectorAll('.page[data-index="3"] .pdf-link').length`);
    }
    // Three contents entries plus one external URL.
    report.check('contents page exposes its links', links === 4, `${links} hotspots`);

    if (links) {
      await evaluate(send, `document.querySelectorAll('.page[data-index="3"] .pdf-link')[1].click()`);
      await sleep(1800);
      const landed = await evaluate(send, `document.getElementById('page-input').value`);
      report.check('following a contents entry jumps to its page', landed === '2', `page ${landed}`);
    }

    const problems = consoleLines.filter((line) => /error|exception/i.test(line));
    report.check('no renderer errors', problems.length === 0, problems.slice(0, 2).join(' | '));
  } finally {
    await close();
    clearSidecar();
  }

  report.finish('text selects, search finds and highlights accurately, and links navigate');
}

main().catch((err) => {
  console.error(err.message);
  clearSidecar();
  process.exit(1);
});
