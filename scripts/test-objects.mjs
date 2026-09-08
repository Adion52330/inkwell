#!/usr/bin/env node
// Integration test for removing things from a page.
//
// Covers three reported problems:
//   1. Erasing a shape appeared to work, then the shape came back. The eraser
//      collected shape ids but only ever called removeStrokes, so nothing was
//      actually deleted and the next repaint restored it.
//   2. Text boxes had no delete affordance at all.
//   3. Selecting a note and pressing Delete did nothing, because the view and
//      the ink engine each held their own copy of the selection.
//
// The page is inspected through the DOM and the ink canvas only — no internals
// are exposed for testing — so this exercises the same paths a user drives.
//
// Usage: node scripts/test-objects.mjs

import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const PORT = 9336;
const root = process.cwd();
const electron = path.join(root, 'node_modules/electron/dist/electron');
const pdf = path.join(root, 'sample/sample.pdf');
const sidecar = path.join(root, 'sample/sample.ink.json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const uid = () => crypto.randomUUID();

// A pure-red rectangle, a text box and a note, at known page coordinates.
function seedSidecar() {
  const bytes = fs.readFileSync(pdf);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32);
  const page = {
    strokes: [],
    objects: [
      {
        id: uid(),
        kind: 'shape',
        shape: 'rect',
        x: 120,
        y: 430,
        x2: 420,
        y2: 560,
        color: '#FF0000',
        size: 3,
        opacity: 1,
        fill: false,
      },
      {
        id: uid(),
        kind: 'text',
        x: 120,
        y: 600,
        width: 200,
        text: 'delete me',
        color: '#1C1C1E',
        fontSize: 15,
      },
      { id: uid(), kind: 'note', x: 470, y: 610, text: 'note', color: '#FFD60A', collapsed: true },
    ],
    rotation: 0,
    inserted: false,
  };
  const blank = { strokes: [], objects: [], rotation: 0, inserted: false };
  fs.writeFileSync(
    sidecar,
    JSON.stringify({
      version: 1,
      app: 'inkwell',
      hash,
      savedAt: new Date().toISOString(),
      sizes: [
        { width: 612, height: 792, rotate: 0, transform: [1, 0, 0, -1, 0, 792] },
        { width: 595.28, height: 841.89, rotate: 0, transform: [1, 0, 0, -1, 0, 841.89] },
        { width: 792, height: 612, rotate: 90, transform: [0, 1, 1, 0, 0, 0] },
      ],
      order: [0, 1, 2],
      pages: [page, blank, blank],
    })
  );
}

async function findTarget() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json`);
      const targets = await response.json();
      const found = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (found) return found;
    } catch {
      /* not up yet */
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

const evaluate = async (send, expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result?.result?.exceptionDetails) {
    throw new Error(result.result.exceptionDetails.exception?.description || 'evaluate failed');
  }
  return result?.result?.result?.value;
};

const mouse = (send, type, x, y) =>
  send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: 1,
    pointerType: 'mouse',
  });

// Locate the red rectangle by reading the committed ink canvas, then convert to
// client coordinates. Keeps the test free of any knowledge of zoom or layout.
const FIND_RED = `(() => {
  const canvas = document.querySelector('.page[data-index="0"] .ink-layer');
  if (!canvas || !canvas.width) return null;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, count = 0;
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const i = (y * canvas.width + x) * 4;
      if (data[i] > 170 && data[i + 1] < 90 && data[i + 2] < 90 && data[i + 3] > 40) {
        count += 1;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (!count) return { count: 0 };
  const rect = canvas.getBoundingClientRect();
  const toClientX = (px) => rect.left + (px / canvas.width) * rect.width;
  const toClientY = (py) => rect.top + (py / canvas.height) * rect.height;
  return {
    count,
    client: { x0: toClientX(x0), y0: toClientY(y0), x1: toClientX(x1), y1: toClientY(y1) },
  };
})()`;

async function main() {
  if (!fs.existsSync(pdf)) throw new Error('run `npm run sample` first');
  seedSidecar();

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-profile-'));
  const child = spawn(
    electron,
    ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, pdf],
    { stdio: 'ignore', env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } }
  );

  const failures = [];
  const check = (name, ok, detail) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures.push(name);
  };

  try {
    const target = await findTarget();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const send = connect(ws);
    await send('Runtime.enable');
    await sleep(4500);

    // --- 1. the shape is there to begin with -------------------------------
    const before = await evaluate(send, FIND_RED);
    check('seeded rectangle renders', !!before && before.count > 0, `${before?.count ?? 0} red px`);
    if (!before?.count) throw new Error('nothing to erase; aborting');

    // --- 2. erase across its top edge --------------------------------------
    await evaluate(send, `document.querySelector('.tool[aria-label="Eraser"]').click()`);
    await sleep(300);
    const { x0, x1, y0 } = before.client;
    await mouse(send, 'mousePressed', x0 - 10, y0 + 2);
    for (let i = 1; i <= 20; i += 1) {
      await mouse(send, 'mouseMoved', x0 - 10 + ((x1 - x0 + 20) * i) / 20, y0 + 2);
    }
    await mouse(send, 'mouseReleased', x1 + 10, y0 + 2);
    await sleep(600);

    const afterErase = await evaluate(send, FIND_RED);
    check('erased shape is gone', (afterErase?.count ?? 0) === 0, `${afterErase?.count ?? 0} red px`);

    // The original symptom was that it returned on the next repaint, so force
    // one (scroll away and back) and look again.
    await evaluate(
      send,
      `(() => { const v = document.getElementById('viewer'); v.scrollTop += 400; })()`
    );
    await sleep(500);
    await evaluate(
      send,
      `(() => { const v = document.getElementById('viewer'); v.scrollTop -= 400; })()`
    );
    await sleep(900);
    const afterRepaint = await evaluate(send, FIND_RED);
    check(
      'erased shape stays gone after a repaint',
      (afterRepaint?.count ?? 0) === 0,
      `${afterRepaint?.count ?? 0} red px`
    );

    // --- 3. a text box can be deleted from its own button ------------------
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
    check('text box deletes from its × button', textDeleted === 'removed', textDeleted);

    // --- 4. a note can be selected and deleted with the keyboard -----------
    const noteDeleted = await evaluate(
      send,
      `(async () => {
        const note = document.querySelector('.obj-note');
        if (!note) return 'no note rendered';
        note.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        note.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        await new Promise((r) => setTimeout(r, 200));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
        await new Promise((r) => setTimeout(r, 400));
        return document.querySelector('.obj-note') ? 'still present' : 'removed';
      })()`
    );
    check('note deletes via select + Delete', noteDeleted === 'removed', noteDeleted);

    ws.close();
  } finally {
    child.kill('SIGTERM');
    await sleep(400);
    child.kill('SIGKILL');
    fs.rmSync(sidecar, { force: true });
  }

  if (failures.length) {
    console.log(`\nFAIL: ${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nPASS: shapes, text boxes and notes can all be removed and stay removed');
}

main().catch((err) => {
  console.error(err.message);
  fs.rmSync(sidecar, { force: true });
  process.exit(1);
});
