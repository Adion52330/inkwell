// A dropdown menu.
//
// Used for the overflow (⋯) menu and the zoom presets. Items are built fresh
// each time it opens so they can reflect the current state - whether undo is
// available, which zoom level is active, what the recent files are - rather
// than being wired once and then kept in sync by hand.

const clamp = (value, lo, hi) => (value < lo ? lo : value > hi ? hi : value);

export class DropdownMenu {
  /**
   * @param {object} options
   * @param {HTMLElement} options.anchor  element the menu hangs from
   * @param {() => Array} options.items   built on open; see #render for shapes
   * @param {'left'|'right'} [options.align] which edge to line up with
   */
  constructor({ anchor, items, align = 'right', className = '' }) {
    this.anchor = anchor;
    this.buildItems = items;
    this.align = align;

    this.el = document.createElement('div');
    this.el.className = `menu ${className}`.trim();
    this.el.hidden = true;
    this.el.setAttribute('role', 'menu');
    document.body.append(this.el);

    anchor.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggle();
    });

    // Any click elsewhere, or Escape, dismisses it.
    document.addEventListener('pointerdown', (event) => {
      if (this.el.hidden) return;
      if (this.el.contains(event.target) || this.anchor.contains(event.target)) return;
      this.close();
    });
  }

  get isOpen() {
    return !this.el.hidden;
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  open() {
    this.#render(this.buildItems());
    this.el.hidden = false;
    this.#position();
    requestAnimationFrame(() => this.el.classList.add('on'));
  }

  close() {
    this.el.classList.remove('on');
    this.el.hidden = true;
  }

  #position() {
    const rect = this.anchor.getBoundingClientRect();
    const width = this.el.offsetWidth;
    const height = this.el.offsetHeight;
    const left = this.align === 'right' ? rect.right - width : rect.left;
    this.el.style.top = `${clamp(rect.bottom + 6, 8, window.innerHeight - height - 8)}px`;
    this.el.style.left = `${clamp(left, 8, window.innerWidth - width - 8)}px`;
  }

  /**
   * Item shapes:
   *   { separator: true }
   *   { heading: 'Recent' }
   *   { label, hint?, disabled?, checked?, danger?, onSelect }
   */
  #render(items) {
    this.el.replaceChildren();
    for (const item of items) {
      if (!item) continue;

      if (item.separator) {
        const rule = document.createElement('div');
        rule.className = 'menu-rule';
        this.el.append(rule);
        continue;
      }

      if (item.heading) {
        const heading = document.createElement('div');
        heading.className = 'menu-heading';
        heading.textContent = item.heading;
        this.el.append(heading);
        continue;
      }

      const button = document.createElement('button');
      button.type = 'button';
      button.className = `menu-item${item.checked ? ' on' : ''}${item.danger ? ' danger' : ''}`;
      button.setAttribute('role', 'menuitem');
      button.disabled = !!item.disabled;

      const label = document.createElement('span');
      label.className = 'menu-label';
      label.textContent = item.label;
      button.append(label);

      if (item.hint) {
        const hint = document.createElement('kbd');
        hint.textContent = item.hint;
        button.append(hint);
      }
      if (item.title) button.title = item.title;

      button.addEventListener('click', () => {
        this.close();
        item.onSelect?.();
      });
      this.el.append(button);
    }
  }
}
