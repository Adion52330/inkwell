#!/usr/bin/env node
// Bundles the renderer with esbuild and stages every asset pdf.js needs at
// runtime into dist/. Kept dependency-free beyond esbuild so `npm run dist`
// has no build-time surprises inside the AppImage.

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

const pdfjs = path.dirname(require.resolve('pdfjs-dist/package.json'));

function copyDir(from, to) {
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
  return true;
}

// pdf.js resolves the worker and its font/cmap tables by URL at runtime, so they
// have to exist as real files next to index.html rather than inside the bundle.
function stageAssets() {
  fs.mkdirSync(dist, { recursive: true });
  fs.copyFileSync(path.join(root, 'src/renderer/index.html'), path.join(dist, 'index.html'));
  copyDir(path.join(root, 'src/renderer/styles'), path.join(dist, 'styles'));

  const worker = path.join(pdfjs, 'build/pdf.worker.mjs');
  if (!fs.existsSync(worker)) throw new Error(`pdf.js worker not found at ${worker}`);
  fs.copyFileSync(worker, path.join(dist, 'pdf.worker.mjs'));

  copyDir(path.join(pdfjs, 'standard_fonts'), path.join(dist, 'standard_fonts'));
  copyDir(path.join(pdfjs, 'cmaps'), path.join(dist, 'cmaps'));
  // pdf.js 6 offloads JPEG2000/JBIG2 decoding to wasm and colour conversion to
  // ICC profiles; both are fetched by URL only when a document needs them.
  copyDir(path.join(pdfjs, 'wasm'), path.join(dist, 'wasm'));
  copyDir(path.join(pdfjs, 'iccs'), path.join(dist, 'iccs'));
}

const options = {
  entryPoints: [path.join(root, 'src/renderer/app.js')],
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  platform: 'browser',
  outfile: path.join(dist, 'renderer.js'),
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  logLevel: 'info',
};

async function main() {
  stageAssets();
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('[build] watching for changes');
  } else {
    await esbuild.build(options);
    console.log('[build] renderer bundled to dist/');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
