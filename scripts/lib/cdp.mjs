// Shared harness for driving the app over the Chrome DevTools Protocol.
//
// The tests all work the same way: launch the real application, drive it with
// real input, and check what actually got rendered. Going through CDP rather
// than a desktop automation tool means this behaves identically on X11, on
// Wayland and headless under xvfb — X11 grabbers cannot see a Wayland window
// at all.

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Launch the app with a throwaway profile and attach a debugger session.
 *
 * The fresh profile matters: tool settings persist to localStorage, so without
 * it a test would run against whatever pen width a previous session left
 * behind.
 *
 * @returns {Promise<{send, close, child}>}
 */
export async function launch({ port, pdf, args = [], settleMs = 4500 }) {
  const root = process.cwd();
  const binary = process.env.INKWELL_BIN || path.join(root, 'node_modules/electron/dist/electron');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-profile-'));

  // A packaged build already knows its own app directory; only the development
  // Electron needs pointing at one.
  const argv = process.env.INKWELL_BIN ? [] : ['.'];
  argv.push(`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...args);
  if (pdf) argv.push(pdf);

  const child = spawn(binary, argv, {
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });

  let target = null;
  for (let attempt = 0; attempt < 80 && !target; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      const targets = await response.json();
      target = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null;
    } catch {
      /* the debugger has not bound its port yet */
    }
    if (!target) await sleep(250);
  }
  if (!target) {
    child.kill('SIGKILL');
    throw new Error('DevTools endpoint never became available');
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

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
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Runtime.enable');
  await sleep(settleMs); // let pdf.js rasterise the first pages

  const close = async () => {
    try {
      ws.close();
    } catch {
      /* already gone */
    }
    child.kill('SIGTERM');
    await sleep(400);
    child.kill('SIGKILL');
  };

  return { send, close, child };
}

/** Evaluate an expression in the page and return its value. */
export async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  const failure = result?.result?.exceptionDetails;
  if (failure) throw new Error(failure.exception?.description || 'evaluate failed');
  return result?.result?.result?.value;
}

/** Real trusted mouse input — the same path a physical mouse takes. */
export const mouse = (send, type, x, y, extra = {}) =>
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

/** Drag in a straight line, in `steps` moves. */
export async function drag(send, from, to, steps = 24) {
  await mouse(send, 'mousePressed', from.x, from.y);
  for (let i = 1; i <= steps; i += 1) {
    await mouse(send, 'mouseMoved', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  }
  await mouse(send, 'mouseReleased', to.x, to.y);
}

export async function screenshot(send, file) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const data = shot?.result?.data;
  if (!data) throw new Error(`capture failed: ${JSON.stringify(shot)}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

/**
 * Locate a pure-red mark on a page's committed ink canvas and report it in
 * client coordinates. Reading the canvas keeps the tests free of any knowledge
 * of zoom or layout, and free of any test-only hooks in the app.
 */
export const FIND_RED = (pageIndex = 0) => `(() => {
  const canvas = document.querySelector('.page[data-index="${pageIndex}"] .ink-layer');
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
    centre: {
      x: (toClientX(x0) + toClientX(x1)) / 2,
      y: (toClientY(y0) + toClientY(y1)) / 2,
    },
  };
})()`;

/** Collects pass/fail lines and reports a single exit status. */
export function createReporter() {
  const failures = [];
  return {
    check(name, ok, detail) {
      console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
      if (!ok) failures.push(name);
    },
    finish(successMessage) {
      if (failures.length) {
        console.log(`\nFAIL: ${failures.length} check(s) failed`);
        process.exit(1);
      }
      console.log(`\nPASS: ${successMessage}`);
    },
  };
}
