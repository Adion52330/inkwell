// Find in document.
//
// Two halves that deliberately use different sources:
//
//   Counting  walks every page's text content, which works whether or not the
//             page has ever been on screen.
//   Highlight is derived from the rendered text layer's actual spans, using a
//             DOM Range. Ranges give exact glyph rectangles — including for a
//             match that spans several spans or wraps a line — which
//             reconstructing boxes from text-item transforms would only
//             approximate.
//
// Scanning is incremental and cancellable: on a thousand-page document the
// count climbs as it goes rather than freezing the window until it finishes.

const HIGHLIGHT_BUDGET = 500;

/** Fold case and collapse whitespace so a search behaves the way people expect. */
function normalize(text) {
  return text.toLowerCase().replace(/\s+/g, ' ');
}

export class Search extends EventTarget {
  constructor({ view, store }) {
    super();
    this.view = view;
    this.store = store;
    /** @type {Map<number, string>} page index → concatenated text */
    this.pageText = new Map();
    this.matches = [];
    this.current = -1;
    this.query = '';
    this.scanning = false;
    this.token = 0;

    // Re-draw highlights when a page (re)renders — zooming rebuilds the spans
    // the ranges point at.
    view.addEventListener('rendered', (event) => {
      if (this.matches.length) this.highlightPage(event.detail.page);
    });
  }

  reset() {
    this.pageText.clear();
    this.matches = [];
    this.current = -1;
    this.query = '';
    this.token += 1;
    this.clearHighlights();
    this.#emit();
  }

  /** Text of a page, from its rendered layer when possible, else from pdf.js. */
  async #textFor(index) {
    if (this.pageText.has(index)) return this.pageText.get(index);

    // A rendered page already has the exact strings the spans were built from.
    const layer = this.view.textLayerFor(index);
    if (layer?.textContentItemsStr) {
      const text = layer.textContentItemsStr.join('');
      this.pageText.set(index, text);
      return text;
    }

    const source = this.view.sourceForPage(index);
    if (!source) {
      this.pageText.set(index, '');
      return '';
    }
    try {
      const page = await source.doc.getPage(source.pageNumber);
      const content = await page.getTextContent({
        includeMarkedContent: true,
        disableNormalization: true,
      });
      const text = content.items.map((item) => item.str ?? '').join('');
      this.pageText.set(index, text);
      return text;
    } catch {
      this.pageText.set(index, '');
      return '';
    }
  }

  /**
   * Run a query across the document. Pages are scanned in order starting from
   * the one on screen, so the first hit found is usually the nearest one.
   */
  async run(query) {
    const token = ++this.token;
    this.query = query;
    this.matches = [];
    this.current = -1;
    this.clearHighlights();

    const needle = normalize(query);
    if (needle.length < 1) {
      this.scanning = false;
      this.#emit();
      return;
    }

    this.scanning = true;
    this.#emit();

    const count = this.store.pageCount;
    for (let i = 0; i < count; i += 1) {
      if (token !== this.token) return; // superseded by a newer query
      const text = await this.#textFor(i);
      if (token !== this.token) return;

      const haystack = normalize(text);
      let from = 0;
      for (;;) {
        const at = haystack.indexOf(needle, from);
        if (at === -1) break;
        this.matches.push({ page: i, start: at, end: at + needle.length });
        from = at + Math.max(1, needle.length);
      }

      // Jump to the first hit as soon as there is one, rather than waiting for
      // the whole document to be scanned.
      if (this.current === -1 && this.matches.length) {
        this.current = 0;
        this.#reveal();
      }
      if (this.matches.length) this.highlightPage(i);
      this.#emit();
      // Yield so typing and scrolling stay responsive mid-scan.
      if (i % 8 === 7) await new Promise((resolve) => setTimeout(resolve, 0));
    }

    this.scanning = false;
    this.#emit();
  }

  next() {
    if (!this.matches.length) return;
    this.current = (this.current + 1) % this.matches.length;
    this.#reveal();
    this.#emit();
  }

  previous() {
    if (!this.matches.length) return;
    this.current = (this.current - 1 + this.matches.length) % this.matches.length;
    this.#reveal();
    this.#emit();
  }

  #reveal() {
    const match = this.matches[this.current];
    if (!match) return;
    this.view.scrollToPage(match.page);
    // The page may need to render before its spans exist; the 'rendered' event
    // re-runs the highlight, and this covers the already-rendered case.
    requestAnimationFrame(() => this.highlightPage(match.page));
  }

  clearHighlights() {
    for (const el of this.view.pageEls) {
      el.querySelector('.search-layer')?.replaceChildren();
    }
  }

  /**
   * Paint every match on one page.
   *
   * Match offsets are into the page's concatenated text; walking the span
   * strings converts an offset into a (span, offset) pair, and a Range across
   * those yields the real glyph rectangles.
   */
  highlightPage(index) {
    const el = this.view.pageEls[index];
    if (!el) return;
    const layer = el.querySelector('.search-layer');
    if (!layer) return;
    layer.replaceChildren();

    const textLayer = this.view.textLayerFor(index);
    const divs = textLayer?.textDivs;
    const strings = textLayer?.textContentItemsStr;
    if (!divs || !strings) return;

    const onPage = this.matches.filter((match) => match.page === index).slice(0, HIGHLIGHT_BUDGET);
    if (!onPage.length) return;

    const pageRect = el.getBoundingClientRect();
    const active = this.matches[this.current];

    for (const match of onPage) {
      const range = this.#rangeFor(divs, strings, match);
      if (!range) continue;
      const isActive = active && match.start === active.start && match.page === active.page;
      for (const rect of range.getClientRects()) {
        if (rect.width < 0.5 || rect.height < 0.5) continue;
        const box = document.createElement('div');
        box.className = `search-hit${isActive ? ' active' : ''}`;
        box.style.left = `${rect.left - pageRect.left}px`;
        box.style.top = `${rect.top - pageRect.top}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
        layer.append(box);
      }
    }
  }

  /** Convert a match's character offsets into a DOM Range over the spans. */
  #rangeFor(divs, strings, match) {
    let offset = 0;
    let startNode = null;
    let startOffset = 0;
    let endNode = null;
    let endOffset = 0;

    for (let i = 0; i < strings.length; i += 1) {
      const length = strings[i].length;
      const node = divs[i]?.firstChild;
      if (length && node) {
        if (!startNode && match.start < offset + length) {
          startNode = node;
          startOffset = match.start - offset;
        }
        if (startNode && match.end <= offset + length) {
          endNode = node;
          endOffset = match.end - offset;
          break;
        }
      }
      offset += length;
    }
    if (!startNode || !endNode) return null;

    try {
      const range = document.createRange();
      range.setStart(startNode, Math.max(0, Math.min(startOffset, startNode.length)));
      range.setEnd(endNode, Math.max(0, Math.min(endOffset, endNode.length)));
      return range;
    } catch {
      return null;
    }
  }

  get status() {
    return {
      query: this.query,
      total: this.matches.length,
      index: this.current,
      scanning: this.scanning,
    };
  }

  #emit() {
    this.dispatchEvent(new CustomEvent('status', { detail: this.status }));
  }
}
