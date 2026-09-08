#!/usr/bin/env node
// Opening a second document while one is already open.
//
// This is the path that broke: load() begins by unloading whatever is open, and
// the teardown called a method pdf.js 6 no longer has. The throw meant the new
// document never loaded while the old one stayed on screen, so opening anything
// — from the file dialog or from the recent list — silently did nothing once a
// document was open. The first open always worked, which is exactly why nothing
// else in the suite caught it: every other test opens one document and stops.
//
// Usage: node scripts/test-open.mjs

import fs from 'fs';
import os from 'os';
import path from 'path';

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import { launch, evaluate, sleep, createReporter } from './lib/cdp.mjs';
import { clearSidecar, samplePdf } from './lib/fixture.mjs';

const PORT = 9341;
const SECOND_PAGES = 2;

/** A second document, deliberately a different length from the sample. */
async function makeSecondPdf(target) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < SECOND_PAGES; i += 1) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Second document, page ${i + 1}`, {
      x: 56,
      y: 700,
      size: 18,
      font,
      color: rgb(0.1, 0.1, 0.12),
    });
  }
  doc.setCreationDate(new Date('2024-01-01T00:00:00Z'));
  doc.setModificationDate(new Date('2024-01-01T00:00:00Z'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, await doc.save());
  return target;
}

const openRecent = (send, match) =>
  evaluate(
    send,
    `(() => {
      document.getElementById('btn-more').click();
      const items = [...document.querySelectorAll('.overflow-menu .menu-item')];
      const entry = items.find((b) => b.textContent.includes(${JSON.stringify(match)}));
      if (!entry) return 'not listed';
      entry.click();
      return 'clicked';
    })()`
  );

const state = (send) =>
  evaluate(
    send,
    `JSON.stringify({
      title: document.title,
      pages: document.getElementById('page-count').textContent,
      toast: document.getElementById('toast').textContent,
    })`
  );

async function main() {
  clearSidecar();
  const report = createReporter();
  const second = await makeSecondPdf(path.join(process.cwd(), 'dist/second.pdf'));
  let leftOn = null;
  // One profile across both launches, so the first document is in the recent
  // list by the time the second run needs to pick it.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-profile-'));

  // First run: open the second document once so it is recorded as recent.
  const seed = await launch({ port: PORT, pdf: second, profile, settleMs: 3000 });
  await seed.close();
  await sleep(500);

  const { send, close, consoleLines } = await launch({
    port: PORT,
    pdf: samplePdf(),
    profile,
  });

  try {
    const first = JSON.parse(await state(send));
    report.check(
      'the first document opens',
      first.title.includes('sample.pdf') && first.pages === '4',
      `${first.title} (${first.pages} pages)`
    );

    const clicked = await openRecent(send, 'second.pdf');
    report.check('the second document is offered in Recent', clicked === 'clicked', clicked);
    await sleep(4500);

    const swapped = JSON.parse(await state(send));
    report.check(
      'opening a second document replaces the first',
      swapped.title.includes('second.pdf'),
      swapped.title
    );
    report.check(
      'the new document’s own page count is shown',
      swapped.pages === String(SECOND_PAGES),
      `${swapped.pages} pages`
    );
    report.check('no error was reported to the user', swapped.toast === '', swapped.toast);

    // Back again, to be sure teardown is repeatable rather than working once.
    await openRecent(send, 'sample.pdf');
    await sleep(4500);
    const backAgain = JSON.parse(await state(send));
    report.check(
      'and back to the first',
      backAgain.title.includes('sample.pdf') && backAgain.pages === '4',
      `${backAgain.title} (${backAgain.pages} pages)`
    );

    const problems = consoleLines.filter((line) => /error|exception/i.test(line));
    report.check('no renderer errors', problems.length === 0, problems.slice(0, 2).join(' | '));

    // --- the reading position is remembered -------------------------------
    // Jump to a page the way a reader would, then let the debounced write land
    // before the window goes away.
    await evaluate(
      send,
      `(() => {
        const input = document.getElementById('page-input');
        input.focus();
        input.value = '3';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      })()`
    );
    await sleep(2000);
    // Whichever page this actually settles on is the one that must come back.
    // Asserting the exact number would be asserting how far a jump scrolls in a
    // document whose pages are different sizes, which is not what this covers.
    leftOn = await evaluate(send, `document.getElementById('page-input').value`);
    report.check('moved off the first page', leftOn !== '1', `left on page ${leftOn}`);
  } finally {
    await close();
    clearSidecar();
  }

  // Reopen the same document in the same profile.
  const resumed = await launch({ port: PORT, pdf: samplePdf(), profile });
  try {
    const landed = await evaluate(resumed.send, `document.getElementById('page-input').value`);
    report.check(
      'reopening returns to the page it was left on',
      landed === leftOn,
      `left on ${leftOn}, opened at ${landed}`
    );
  } finally {
    await resumed.close();
    clearSidecar();
    fs.rmSync(second, { force: true });
  }

  report.finish('documents open one after another, and reopen where they were left');
}

main().catch((err) => {
  console.error(err.message);
  clearSidecar();
  process.exit(1);
});
