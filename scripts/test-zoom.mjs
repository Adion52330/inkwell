#!/usr/bin/env node
// Zoom behaviour.
//
// The invariant that makes zooming feel right is anchoring: whatever sits under
// the pointer must stay under the pointer as the page grows or shrinks. Get it
// wrong and the document appears to slide away while you zoom, which is the
// difference between zoom that feels native and zoom that feels broken.
//
// Page positions are computed arithmetically rather than measured (measuring
// every page on every wheel tick forced a synchronous layout and made zooming
// stutter), so this guards that the arithmetic agrees with the real layout.
//
// Usage: node scripts/test-zoom.mjs

import {
  launch,
  evaluate,
  sleep,
  FIND_RED,
  createReporter,
} from './lib/cdp.mjs';
import { seedSidecar, clearSidecar, redRect, samplePdf } from './lib/fixture.mjs';

const PORT = 9337;

// Ctrl+wheel is how Chromium reports both a wheel zoom and a trackpad pinch.
const CTRL = 2;
const wheelZoom = (send, x, y, deltaY) =>
  send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x,
    y,
    deltaX: 0,
    deltaY,
    modifiers: CTRL,
    pointerType: 'mouse',
  });

const readScale = (send) =>
  evaluate(send, `parseFloat(document.getElementById('zoom-readout').textContent) / 100`);

/**
 * The canvas must hold exactly one backing pixel per device pixel, and the page
 * box must cover a whole number of device pixels.
 *
 * Either being off means the browser resamples a finished bitmap: rendered
 * glyphs get scaled by a non-integer factor, which speckles thin stems and
 * leaves stray dots between letters. Supersampling to 1.5x and letting the
 * browser scale back down looked like a quality improvement and was in fact the
 * cause of exactly that, which is why this is asserted rather than assumed.
 */
const PIXEL_FIT = `(() => {
  const page = document.querySelector('.page[data-index="0"]');
  const canvas = page.querySelector('.pdf-layer');
  const style = getComputedStyle(canvas);
  const cssW = parseFloat(style.width);
  const cssH = parseFloat(style.height);
  const dpr = window.devicePixelRatio;
  return {
    ratioW: canvas.width / cssW,
    ratioH: canvas.height / cssH,
    dpr,
    wholeW: Math.abs(cssW * dpr - Math.round(cssW * dpr)) < 1e-6,
    wholeH: Math.abs(cssH * dpr - Math.round(cssH * dpr)) < 1e-6,
    cssW,
  };
})()`;

function checkPixelFit(report, fit, when) {
  const exact =
    Math.abs(fit.ratioW - fit.dpr) < 1e-3 && Math.abs(fit.ratioH - fit.dpr) < 1e-3;
  report.check(
    `${when}: one canvas pixel per device pixel`,
    exact,
    `ratio ${fit.ratioW.toFixed(3)}x${fit.ratioH.toFixed(3)}, dpr ${fit.dpr}`
  );
  report.check(
    `${when}: page covers whole device pixels`,
    fit.wholeW && fit.wholeH,
    `css width ${fit.cssW}`
  );
}

async function main() {
  seedSidecar({ objects: [redRect({ x: 150, y: 380, x2: 330, y2: 470 })] });
  const report = createReporter();
  const { send, close } = await launch({ port: PORT, pdf: samplePdf() });

  try {
    const start = await evaluate(send, FIND_RED());
    report.check('marker renders', (start?.count ?? 0) > 0, `${start?.count ?? 0} red px`);
    if (!start?.count) throw new Error('nothing to anchor on');

    const startScale = await readScale(send);
    const anchor = start.centre;

    checkPixelFit(report, await evaluate(send, PIXEL_FIT), 'at open');

    // --- zoom in about the marker -----------------------------------------
    for (let i = 0; i < 6; i += 1) {
      await wheelZoom(send, anchor.x, anchor.y, -120);
      await sleep(60);
    }
    await sleep(700); // let the debounced re-raster settle

    const zoomedScale = await readScale(send);
    report.check(
      'ctrl+wheel zooms in',
      zoomedScale > startScale * 1.05,
      `${Math.round(startScale * 100)}% → ${Math.round(zoomedScale * 100)}%`
    );

    checkPixelFit(report, await evaluate(send, PIXEL_FIT), 'zoomed in');

    const zoomed = await evaluate(send, FIND_RED());
    report.check('marker still on screen after zooming', (zoomed?.count ?? 0) > 0);
    if (zoomed?.count) {
      const drift = Math.hypot(zoomed.centre.x - anchor.x, zoomed.centre.y - anchor.y);
      report.check(
        'content under the pointer stays under the pointer',
        drift < 6,
        `${drift.toFixed(1)}px drift`
      );

      // The marker must actually have grown, or "no drift" would be trivially
      // satisfied by a zoom that did nothing.
      const grew = (zoomed.client.x1 - zoomed.client.x0) / (start.client.x1 - start.client.x0);
      report.check(
        'the marker grew with the zoom',
        grew > 1.05,
        `${grew.toFixed(2)}× wider`
      );
    }

    // --- and back out ------------------------------------------------------
    for (let i = 0; i < 6; i += 1) {
      await wheelZoom(send, anchor.x, anchor.y, 120);
      await sleep(60);
    }
    await sleep(700);

    const back = await evaluate(send, FIND_RED());
    if (back?.count) {
      const drift = Math.hypot(back.centre.x - anchor.x, back.centre.y - anchor.y);
      report.check('anchor holds on the way back out', drift < 8, `${drift.toFixed(1)}px drift`);
    } else {
      report.check('anchor holds on the way back out', false, 'marker went off screen');
    }

    // --- the preset menu ---------------------------------------------------
    const menu = await evaluate(
      send,
      `(async () => {
        document.getElementById('zoom-readout').click();
        await new Promise((r) => setTimeout(r, 300));
        const items = [...document.querySelectorAll('.zoom-item')].map((b) => b.textContent);
        const hundred = [...document.querySelectorAll('.zoom-item')]
          .find((b) => b.textContent.startsWith('100%'));
        if (!hundred) return { items, applied: null };
        hundred.click();
        await new Promise((r) => setTimeout(r, 600));
        return { items, applied: document.getElementById('zoom-readout').textContent };
      })()`
    );
    report.check(
      'zoom menu offers fit and preset levels',
      (menu?.items?.length ?? 0) >= 8,
      `${menu?.items?.length ?? 0} entries`
    );
    report.check('choosing 100% applies it', menu?.applied === '100%', String(menu?.applied));
  } finally {
    await close();
    clearSidecar();
  }

  report.finish('zoom anchors on the pointer, scales the page, and the preset menu works');
}

main().catch((err) => {
  console.error(err.message);
  clearSidecar();
  process.exit(1);
});
