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
const SNIPPET_CONTEXT = 42;

/** A little of the surrounding line, for the results list. */
function snippetAround(text, start, end) {
  const from = Math.max(0, start - SNIPPET_CONTEXT);
  const to = Math.min(text.length, end + SNIPPET_CONTEXT);
  return {
    before: (from > 0 ? '…' : '') + text.slice(from, start).replace(/\s+/g, ' '),
    hit: text.slice(start, end).replace(/\s+/g, ' '),
    after: text.slice(end, to).replace(/\s+/g, ' ') + (to < text.length ? '…' : ''),
  };
}

/**
 * Fold case and collapse whitespace so a search behaves the way people expect,
 * keeping a map back to the original offsets.
 *
 * The map is the point. Collapsing runs of whitespace changes the length of the
 * string, so an offset found in the folded text does not address the same
 * character in the raw text — and the raw offsets are what the DOM ranges and
 * the snippets need. Searching the folded text and then reading the raw text at
 * the folded offset silently highlights the wrong words on any page that
 * contains a double space.
 */
function buildIndex(text) {
  let normalized = '';
  const map = [];
  let lastWasSpace = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (lastWasSpace) continue;
      normalized += ' ';
      map.push(i);
      lastWasSpace = true;
    } else {
      // Take one character: a few code points lengthen when lowercased, which
      // would put the map out of step with the string.
      normalized += ch.toLowerCase()[0] ?? ch;
      map.push(i);
      lastWasSpace = false;
    }
  }
  return { normalized, map, raw: text };
}

const foldQuery = (query) => query.toLowerCase().replace(/\s+/g, ' ').trim();

export class Search extends EventTarget {
  constructor({ view, store }) {
    super();
    this.view = view;
    this.store = store;
    /** @type {Map<number, {normalized, map, raw}>} page index → search index */
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

  /** Search index of a page, from its rendered layer when possible. */
  async #indexFor(index) {
    if (this.pageText.has(index)) return this.pageText.get(index);

    let text = '';
    // A rendered page already has the exact strings the spans were built from,
    // so offsets map straight onto the DOM.
    const layer = this.view.textLayerFor(index);
    if (layer?.textContentItemsStr) {
      text = layer.textContentItemsStr.join('');
    } else {
      const source = this.view.sourceForPage(index);
      if (source) {
        try {
          const page = await source.doc.getPage(source.pageNumber);
          const content = await page.getTextContent({
            includeMarkedContent: true,
            disableNormalization: true,
          });
          text = content.items.map((item) => item.str ?? '').join('');
        } catch {
          text = '';
        }
      }
    }
    const built = buildIndex(text);
    this.pageText.set(index, built);
    return built;
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

    const needle = foldQuery(query);
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
      const { normalized, map, raw } = await this.#indexFor(i);
      if (token !== this.token) return;

      let from = 0;
      for (;;) {
        const at = normalized.indexOf(needle, from);
        if (at === -1) break;
        // Back to raw offsets, which is what both the DOM ranges and the
        // snippet below are expressed in.
        const start = map[at];
        const end = (map[at + needle.length - 1] ?? start) + 1;
        this.matches.push({
          page: i,
          start,
          end,
          snippet: snippetAround(raw, start, end),
        });
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

  goTo(index) {
    if (index < 0 || index >= this.matches.length) return;
    this.current = index;
    this.#reveal();
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
      matches: this.matches,
    };
  }

  #emit() {
    this.dispatchEvent(new CustomEvent('status', { detail: this.status }));
  }
}
