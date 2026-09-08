#!/usr/bin/env node
// Regression test: the live stroke must be drawn where the pointer actually is.
//
// The wet canvas is cleared in device pixels but must be handed back to the
// caller in page space. When that transform was left on the identity matrix,
// the in-progress stroke painted at raw pixel coordinates: it appeared offset
// and shrunk while drawing, then snapped into place on release when the
// committed layer repainted. The two positions disagreeing is the bug, so the
// test drives a drag, captures the page mid-stroke and again after release, and
// asserts the ink occupies the same box both times.
//
// Usage: node scripts/test-live-stroke.mjs [--out <dir>]
//        python3 scripts/check-live-stroke.py <dir>

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const PORT = 9335;
const root = process.cwd();
const electron = path.join(root, 'node_modules/electron/dist/electron');
const pdf = path.join(root, 'sample/sample.pdf');
const outArg = process.argv.indexOf('--out');
const outDir = outArg !== -1 ? process.argv[outArg + 1] : path.join(root, 'dist/live-stroke');

// Where to drag, in client coordinates: a blank band of page one between the
// last paragraph and the ruled area, so the only dark pixels there are ours.
const DRAG = { y: 545, x0: 500, x1: 900 };
const BAND = { top: 520, bottom: 575, left: 470, right: 930 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findTarget() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json`);
      const targets = await response.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* not listening yet */
    }
    await sleep(250);
  }
  throw new Error('DevTools endpoint never became available');
}

function connect(ws) {
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  });
  return (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
}

// Real trusted input, not synthesised DOM events — this exercises the same path
// a mouse does, including pointer capture and coalesced-event handling.
const mouse = (send, type, x, y, extra = {}) =>
  send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: 1,
    pointerType: 'mouse',
    ...extra,
  });

async function capture(send, file) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const data = shot?.result?.data;
  if (!data) throw new Error(`capture failed: ${JSON.stringify(shot)}`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

async function main() {
  if (!fs.existsSync(pdf)) throw new Error('run `npm run sample` first');
  fs.mkdirSync(outDir, { recursive: true });

  // A throwaway profile, so the test always runs against the default pen rather
  // than whatever tool and width a previous session happened to leave behind.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-profile-'));
  const child = spawn(
    electron,
    ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, pdf],
    { stdio: 'ignore', env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } }
  );

  try {
    const target = await findTarget();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const send = connect(ws);
    await send('Runtime.enable');
    await sleep(4500); // let pdf.js rasterise

    // Dismiss anything that might overlap the test area, and confirm the pen is
    // the active tool before drawing.
    await send('Runtime.evaluate', {
      expression: `(() => {
        document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        return document.querySelector('.tool.active')?.getAttribute('aria-label');
      })()`,
      returnByValue: true,
    }).then((r) => {
      const tool = r?.result?.result?.value;
      if (tool !== 'Pen') throw new Error(`expected the Pen tool to be active, got ${tool}`);
    });
    await sleep(500);

    await mouse(send, 'mousePressed', DRAG.x0, DRAG.y);
    const steps = 24;
    for (let i = 1; i <= steps; i += 1) {
      await mouse(send, 'mouseMoved', DRAG.x0 + ((DRAG.x1 - DRAG.x0) * i) / steps, DRAG.y);
    }
    await sleep(350); // let the rAF flush paint the wet layer

    const during = await capture(send, path.join(outDir, 'during.png'));

    await mouse(send, 'mouseReleased', DRAG.x1, DRAG.y);
    await sleep(500);
    const after = await capture(send, path.join(outDir, 'after.png'));

    ws.close();
    // The checker reads the search box from here rather than repeating it.
    fs.writeFileSync(
      path.join(outDir, 'meta.json'),
      JSON.stringify({ drag: DRAG, band: BAND }, null, 2)
    );
    console.log(`captured ${during} and ${after}`);
  } finally {
    child.kill('SIGTERM');
    await sleep(400);
    child.kill('SIGKILL');
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
