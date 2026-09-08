#!/usr/bin/env node
// Launch the app, screenshot the window, and exit.
//
// Uses the Chrome DevTools Protocol rather than a desktop screenshot tool
// because those are display-server specific - X11 grabbers cannot see a Wayland
// Electron window at all. Going through CDP captures the rendered page itself,
// so it works identically on X11, Wayland and headless CI.
//
// Usage: node scripts/screenshot.mjs <out.png> [pdf] [--wait ms] [--dark|--light]
//                                     [--click <css-selector>]... [--freeze]
//                                     [--move <x,y>]
//
// --move parks the pointer, so cursor-dependent UI (the brush nib) is captured.
//
// --click drives the UI before capturing, so states that only exist after
// interaction (an open sidebar, an open tool popover) can be screenshotted.

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const out = process.argv[2] || 'screenshot.png';
const pdf = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : null;
const waitArg = process.argv.indexOf('--wait');
const settleMs = waitArg !== -1 ? Number(process.argv[waitArg + 1]) : 3500;
const dark = process.argv.includes('--dark');
const light = process.argv.includes('--light');
const freeze = process.argv.includes('--freeze');
const moveArg = process.argv.indexOf('--move');
const move = moveArg !== -1 ? process.argv[moveArg + 1].split(',').map(Number) : null;
const clicks = process.argv.reduce(
  (acc, arg, i) => (arg === '--click' && process.argv[i + 1] ? [...acc, process.argv[i + 1]] : acc),
  []
);

const PORT = 9333;
// INKWELL_BIN points this at a packaged build (the AppImage) instead of the
// development Electron, so the same smoke test covers both.
const packaged = process.env.INKWELL_BIN;
const electron = packaged || path.join(process.cwd(), 'node_modules/electron/dist/electron');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findTarget() {
  // The debugger takes a moment to bind; poll rather than guess a delay.
  for (let attempt = 0; attempt < 60; attempt += 1) {
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

function cdp(ws) {
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const resolver = pending.get(message.id);
    if (resolver) {
      pending.delete(message.id);
      resolver(message);
    }
  });
  return (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
}

async function main() {
  // A packaged build already knows its own app directory; only the development
  // Electron needs to be pointed at one.
  const args = packaged ? [] : ['.'];
  args.push(`--remote-debugging-port=${PORT}`);
  if (pdf) args.push(pdf);

  const child = spawn(electron, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });

  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));

  try {
    const target = await findTarget();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const send = cdp(ws);

    await send('Runtime.enable');

    if (freeze) {
      // The window opens under the real cursor, and a stray drag from the
      // desktop lands as a stroke. Making the viewer inert keeps captures
      // deterministic; toolbar clicks are dispatched directly and still work.
      await send('Runtime.evaluate', {
        expression: `(() => { const s = document.createElement('style');
          s.textContent = '.viewer{pointer-events:none!important}';
          document.head.append(s); })()`,
      });
    }
    if (dark || light) {
      await send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }],
      });
    }

    // Give pdf.js time to rasterise the first pages.
    await sleep(settleMs);

    for (const selector of clicks) {
      const clicked = await send('Runtime.evaluate', {
        expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return 'missing';
          el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 }));
          el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0 }));
          el.click(); return 'ok'; })()`,
        returnByValue: true,
      });
      const status = clicked?.result?.result?.value;
      if (status !== 'ok') console.error(`click ${selector}: ${status}`);
      // Let the spring animations settle before the shutter.
      await sleep(700);
    }

    if (move) {
      // Real pointer input, so the brush cursor tracks it the way it would for
      // a physical mouse.
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: move[0],
        y: move[1],
        pointerType: 'mouse',
      });
      await sleep(300);
    }

    // Surface any renderer errors - a blank screenshot is otherwise silent.
    const errors = await send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__inkwellErrors || [])',
      returnByValue: true,
    });
    const captured = JSON.parse(errors?.result?.result?.value || '[]');
    if (captured.length) console.error('renderer errors:', captured);

    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const data = shot?.result?.data;
    if (!data) throw new Error(`capture failed: ${JSON.stringify(shot)}`);
    fs.writeFileSync(out, Buffer.from(data, 'base64'));
    console.log(`wrote ${out}`);
    ws.close();
  } catch (err) {
    console.error(err.message);
    console.error(logs.join('').split('\n').filter((l) => /ERROR|CONSOLE/.test(l)).slice(-15).join('\n'));
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await sleep(400);
    child.kill('SIGKILL');
  }
}

main();
