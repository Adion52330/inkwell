# Contributing to Inkwell

Thanks for taking a look. This is a small codebase with a deliberately narrow
purpose: read PDFs, write on them well, never damage the original file.

## Getting set up

```bash
npm install
npm run sample   # generates sample/sample.pdf to draw on
npm start
```

`npm run watch` rebuilds the renderer on change; reload the window with
`Ctrl+R` to pick the rebuild up.

## Running the tests

```bash
npm test
```

Five suites, all of which check rendered output rather than internal state:

| Suite | What it proves |
| --- | --- |
| `npm run test:export` | Ink exported to a flattened PDF lands at the exact page coordinates it was drawn at, including on a `/Rotate 90` page. Rasterises with `pdftoppm` and inspects pixels. |
| `npm run test:live-stroke` | The in-progress stroke is painted where the pointer is, and does not move when the pointer is released. Drives a real drag over the DevTools Protocol and compares two frames. |
| `npm run test:objects` | Shapes, text boxes and sticky notes can be removed, stay removed after a repaint, and return on undo. |
| `npm run test:zoom` | Zoom anchors on the point under the pointer, actually scales the page, and the preset menu applies a level. |
| `npm run test:unsaved` | Closing with unsaved ink is held for confirmation; closing a saved document is not. |

`scripts/lib/cdp.mjs` is the shared harness — launching the app with a
throwaway profile, driving real input, reading back the ink canvas — and
`scripts/lib/fixture.mjs` seeds a known sidecar. A new test is usually a few
lines on top of those.

They need `pdftoppm` (poppler-utils), Python 3 with Pillow, and a display for
the four that launch the app (`xvfb-run -a npm test` works headless).

**Please test against rendered output, not against the maths.** Every
coordinate bug this project has had would have passed a unit test written from
the same assumptions as the code. The export test caught a rotation bug because
it looks at pixels in a rasterised page; the live-stroke test caught a transform
bug because it compares two real frames.

## How the code is laid out

```
src/main/main.js      window, native menu, dialogs, atomic sidecar writes
src/main/preload.js   the only renderer→disk bridge (context isolation on)
src/renderer/
  store.js            document model + undo/redo command stack
  pdfview.js          page layout, virtualised rasterising, zoom, compositing
  ink.js              pointer capture, per-device stroke models, tool gestures
  ink-render.js       stroke geometry and hit testing, shared with the exporter
  objects.js          text boxes and sticky notes as DOM
  export.js           flattening into a new PDF via pdf-lib
  ui/                 tool palette, popovers, thumbnail sidebar, icons
```

A few invariants worth knowing before you change things:

- **The original PDF is never written to.** Ink goes in a sidecar; export writes
  a new file. If a change could modify the source file, it is wrong.
- **Ink is stored in page space** — PDF points, origin top-left, on the
  unrotated page. Never store screen pixels; zoom and rotation would bake in.
- **Every model mutation goes through `Store.apply`**, which is the single choke
  point for undo, autosave and repainting. Mutating a page directly will leave
  the screen and the saved file disagreeing.
- **The store is the source of truth for the DOM layer too.** Text boxes and
  notes are real elements, so any command that adds or removes one has to
  trigger `view.renderObjects(page)` — otherwise undo won't bring it back.
- **Nothing may block the input path.** Pointer samples are queued and flushed
  once per animation frame. If you find yourself doing work per event, don't.
- **Layout is computed, not measured.** `PdfView` derives page positions from
  its own constants and the edge insets. Reading layout back from the DOM inside
  a zoom or scroll handler reintroduces the stutter that motivated this.

## Style

- Plain ES modules, no framework, no transpilation beyond bundling.
- Comments explain *why*, not *what*. If a line needs a comment to say what it
  does, rename something instead.
- Match the surrounding code rather than introducing a new idiom.

## Pull requests

Keep them focused, and say what you verified. If you fixed a rendering or
coordinate bug, add a check to the relevant suite that fails without your fix —
`scripts/test-objects.mjs` is the easiest one to extend.

By contributing you agree that your work is licensed under the MIT License.
