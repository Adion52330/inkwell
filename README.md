# Inkwell

A desktop PDF reader you can write on. Built for Linux, shipped as an AppImage.

Existing Linux options tend to split the problem in half: viewers that render
PDFs faithfully but annotate badly, and note apps that ink beautifully but treat
the PDF as a dumb backdrop. Inkwell does both — pdf.js rendering underneath a
low-latency, pressure-sensitive vector ink layer.

**Your original PDF is never modified.** Ink lives in a small `.ink.json` file
beside it and stays fully re-editable. Exporting produces a separate flattened
copy for sharing.

---

## Running it

```bash
npm install
npm run sample   # writes sample/sample.pdf to draw on
npm start
```

## Building the AppImage

```bash
npm run dist
```

The result lands in `release/Inkwell-<version>-x64.AppImage`. Mark it executable
and run it — no installation, no runtime dependencies beyond FUSE:

```bash
chmod +x release/Inkwell-*.AppImage
./release/Inkwell-*.AppImage
```

It registers as a handler for `application/pdf`, so it can be set as the system
PDF viewer once integrated (via Gear Lever, AppImageLauncher, or a hand-written
`.desktop` file).

---

## The writing experience

The point of the app is that writing feels immediate, so most of the
engineering is on the input path.

**Every sample is used.** Chromium delivers pointer events once per frame by
default, which throws away most of what a 240 Hz stylus reports.
`getCoalescedEvents()` recovers the full set — this is the difference between a
curve and a chain of visible facets when you write quickly.

**Work happens once per frame.** Samples are queued as they arrive and drained
in a single `requestAnimationFrame` flush, so a burst of input costs one repaint
rather than twenty.

**The in-progress stroke is isolated.** Each page has separate canvases for
committed ink and the stroke currently under your pen. Adding a point repaints a
transparent overlay instead of every stroke on the page, so the hundredth stroke
draws as fast as the first.

**The stroke model follows the device:**

| Input | Behaviour |
| --- | --- |
| Stylus | True pressure drives width; tilt is captured; the eraser end and the barrel button both erase without changing tools |
| Mouse / trackpad | Width is derived from pointer velocity, so lines still taper naturally instead of being uniform sausages |
| Finger | Pans and pinch-zooms. Never draws |

**Palm rejection.** Once the pen is seen, touch input is suppressed briefly —
including native touch scrolling — so a hand resting on the screen mid-sentence
can neither draw nor scroll the page out from under you.

## Tools

- **Pen** — pressure-tapered ink, twelve colours, 1–16 pt
- **Highlighter** — flat chisel nib with a multiply blend, so text underneath
  stays readable
- **Eraser** — removes whole strokes rather than nibbling pixels, which keeps
  files small and every erase undoable
- **Lasso** — selects ink by enclosure and drags it; Delete removes it
- **Text boxes** — real `contenteditable`, so the caret, selection and IME come
  from the platform and text stays crisp at any zoom
- **Sticky notes** — collapsible comments that export as genuine PDF `/Text`
  annotations other viewers can read
- **Shapes** — line, arrow, rectangle, ellipse, optionally filled
- **Page operations** — rotate, insert blank, delete, drag-to-reorder in the
  sidebar, and append another PDF

Tapping the tool you already have selected opens its settings — the GoodNotes
gesture, which is why the palette can stay a single row.

## Keyboard

| Key | Action |
| --- | --- |
| `1`–`7` | Pen, highlighter, eraser, lasso, text, note, shapes |
| `H` / hold `Space` | Pan |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| `Ctrl+O` / `Ctrl+S` / `Ctrl+E` | Open / save notes / export |
| `Ctrl+B` | Pages sidebar |
| `Ctrl` `+` / `−` / `0` / `1` / `2` | Zoom in, out, actual size, fit width, fit page |
| `Ctrl+wheel`, pinch | Zoom about the cursor |
| `Delete` | Delete selection |

---

## How it works

```
src/main/main.js      window, native menu, dialogs, atomic sidecar writes
src/main/preload.js   the only renderer→disk bridge (context isolation on)
src/renderer/
  store.js            document model + undo/redo command stack
  pdfview.js          page layout, virtualised rasterising, zoom, compositing
  ink.js              pointer capture, per-device stroke models, tool gestures
  ink-render.js       stroke geometry, shared by screen and exporter
  objects.js          text boxes and sticky notes as DOM
  export.js           flattening into a new PDF via pdf-lib
  ui/                 tool palette, popovers, thumbnail sidebar, icons
```

### Ink is stored in page space

Strokes are recorded in PDF points with the origin at the page's top-left, on
the *unrotated* page — not in screen pixels. Two things fall out of that: zoom
never degrades a stroke (a line drawn at 50% is sharp at 400%), and rotating a
page moves the paper rather than the notes, so ink keeps its position relative to
the words it annotates.

### Export gets coordinates right by construction

A PDF content stream works in user space (origin bottom-left, y up, unrotated
MediaBox), while ink is stored in viewport space. Rather than hand-deriving that
mapping for each `/Rotate` value, the exporter inverts the very matrix pdf.js
used to lay the page out. That is exact for rotated pages and for pages whose
MediaBox does not start at the origin — the two cases where hand-rolled maths
usually goes wrong. `sample/sample.pdf` deliberately includes a rotated page to
exercise it.

### Saving cannot corrupt your notes

The sidecar is written to a temporary file in the same directory and then
`rename`d over the target. Rename is atomic within a filesystem, so a crash or a
full disk mid-write leaves the previous version intact rather than a truncated
one. If ink is added while a save is in flight, the dirty flag is *not* cleared —
those strokes get their own save rather than being silently considered written.

The sidecar records a hash of the source PDF. Opening notes against a PDF that
has since changed warns you instead of quietly placing ink in the wrong spot.

### Memory is bounded

Pages rasterise as they approach the viewport and hand their canvases back when
they leave, so page count does not translate into memory. Zoom shows a scaled
bitmap immediately and re-renders crisply once the gesture settles, which is what
keeps zooming smooth rather than stuttering on every wheel tick.

---

## Known limitations

- **Pressure and tilt are untested on real hardware.** No stylus was available on
  the development machine; those paths were exercised with synthetic `pen`
  pointer events. The mouse and trackpad paths are tested normally.
- Exported text boxes use Helvetica, and characters outside WinAnsi are replaced.
  Ink, shapes and notes are unaffected.
- x86-64 only. An `arm64` AppImage would need the target added to
  `build.linux.target` in `package.json`.

## Licence

MIT.
