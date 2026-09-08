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

/**
 * Pull the text-layer rules out of pdf.js's own stylesheet.
 *
 * The selectable text layer is a stack of absolutely positioned spans whose
 * geometry pdf.js computes; its CSS is part of that contract, not decoration.
 * Extracting it from the installed package rather than hand-copying it means it
 * cannot silently drift out of step when pdfjs-dist is upgraded.
 */
function extractTextLayerCss() {
  const source = path.join(pdfjs, 'web/pdf_viewer.css');
  if (!fs.existsSync(source)) throw new Error(`pdf.js stylesheet not found at ${source}`);
  const css = fs.readFileSync(source, 'utf8');

  // Walk top-level rules, keeping the ones whose selector mentions textLayer.
  const blocks = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const rule = css.slice(start, i + 1);
        const selector = rule.slice(0, rule.indexOf('{'));
        if (selector.includes('textLayer')) blocks.push(rule.trim());
        start = i + 1;
      }
    }
  }
  if (!blocks.length) throw new Error('no .textLayer rules found in pdf_viewer.css');

  return [
    '/* Extracted from pdfjs-dist/web/pdf_viewer.css by scripts/build.js.',
    ' * Do not edit: this is part of pdf.js\'s text-layer geometry contract. */',
    '',
    ...blocks,
    '',
  ].join('\n');
}

// pdf.js resolves the worker and its font/cmap tables by URL at runtime, so they
// have to exist as real files next to index.html rather than inside the bundle.
function stageAssets() {
  fs.mkdirSync(dist, { recursive: true });
  fs.copyFileSync(path.join(root, 'src/renderer/index.html'), path.join(dist, 'index.html'));
  copyDir(path.join(root, 'src/renderer/styles'), path.join(dist, 'styles'));
  fs.writeFileSync(path.join(dist, 'styles/text-layer.css'), extractTextLayerCss());

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
