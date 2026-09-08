#!/usr/bin/env node
// Make sure the Electron binary is actually on disk.
//
// The `electron` package ships as a small stub whose postinstall script fetches
// the real ~100 MB binary. That postinstall does not always run — npm can be
// configured with ignore-scripts, and CI images often are — which leaves
// node_modules/electron present but node_modules/electron/dist missing. The
// failure then surfaces much later as a bare `spawn … ENOENT` from whatever
// tries to launch the app, which says nothing about the cause.
//
// This checks for the binary and runs the package's own installer if it is
// absent. It is idempotent and cheap when the binary is already there.
//
// Usage: node scripts/ensure-electron.mjs

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const root = process.cwd();
const installer = path.join(root, 'node_modules/electron/install.js');
const pathFile = path.join(root, 'node_modules/electron/path.txt');

function binaryPath() {
  try {
    // path.txt names the executable inside dist/ for the current platform.
    const name = fs.readFileSync(pathFile, 'utf8').trim();
    return path.join(root, 'node_modules/electron/dist', name);
  } catch {
    return path.join(root, 'node_modules/electron/dist/electron');
  }
}

async function main() {
  if (!fs.existsSync(installer)) {
    console.error('electron is not installed — run `npm ci` first');
    process.exit(1);
  }

  const binary = binaryPath();
  if (fs.existsSync(binary)) {
    console.log(`electron binary present: ${path.relative(root, binary)}`);
    return;
  }

  console.log('electron binary missing; downloading it now…');
  const code = await new Promise((resolve) => {
    spawn(process.execPath, [installer], { stdio: 'inherit', cwd: root }).on('close', resolve);
  });

  if (code !== 0 || !fs.existsSync(binary)) {
    console.error(`\nelectron install failed (exit ${code}).`);
    console.error('The GUI tests cannot run without it. Check network access to');
    console.error('github.com/electron/electron/releases, or set ELECTRON_MIRROR.');
    process.exit(1);
  }
  console.log(`electron binary installed: ${path.relative(root, binary)}`);
}

main();
