// The floating tool palette and its popover.
//
// The interaction to preserve here is the one GoodNotes and Apple Notes share:
// tapping a tool selects it, and tapping the *already selected* tool opens its
// settings. That keeps one row of controls doing the work of a settings panel,
// and it is why the palette can stay this small.

import { icon } from './icons.js';

export const PEN_COLORS = [
  '#1C1C1E',
  '#8E8E93',
  '#FF3B30',
  '#FF9500',
  '#FFCC00',
  '#34C759',
  '#30B0C7',
  '#007AFF',
  '#5856D6',
  '#AF52DE',
  '#FF2D55',
  '#FFFFFF',
];

export const HIGHLIGHT_COLORS = [
  '#FFE234',
  '#FFB340',
  '#FF7EB0',
  '#5BE49B',
  '#5AC8FA',
  '#C88CFF',
];

export const NOTE_COLORS = ['#FFD60A', '#FF9F0A', '#FF6482', '#BF5AF2', '#0A84FF', '#30D158'];

const TOOLS = [
  { id: 'pen', icon: 'pen', label: 'Pen', key: '1' },
  { id: 'highlighter', icon: 'highlighter', label: 'Highlighter', key: '2' },
  { id: 'eraser', icon: 'eraser', label: 'Eraser', key: '3' },
  { id: 'lasso', icon: 'lasso', label: 'Lasso select', key: '4' },
  { divider: true },
  { id: 'text', icon: 'text', label: 'Text box', key: '5' },
  { id: 'note', icon: 'note', label: 'Sticky note', key: '6' },
  { id: 'shapes', icon: 'shapes', label: 'Shapes', key: '7', tool: 'shape' },
  { divider: true },
  { id: 'hand', icon: 'hand', label: 'Pan', key: 'H' },
];

export class Toolbar extends EventTarget {
  constructor({ mount, tools }) {
    super();
    this.tools = tools;
    this.el = document.createElement('div');
    this.el.className = 'toolbar';
    this.popover = document.createElement('div');
    this.popover.className = 'popover';
    this.popover.hidden = true;
    this.buttons = new Map();

    for (const entry of TOOLS) {
      if (entry.divider) {
        const divider = document.createElement('div');
        divider.className = 'divider';
        this.el.append(divider);
        continue;
      }
      const button = document.createElement('button');
      button.className = 'tool';
      button.type = 'button';
      button.title = entry.key ? `${entry.label}  ·  ${entry.key}` : entry.label;
      button.setAttribute('aria-label', entry.label);
      button.innerHTML = icon(entry.icon);
      if (entry.id === 'pen' || entry.id === 'highlighter') {
        const dot = document.createElement('span');
        dot.className = 'swatch-dot';
        button.append(dot);
      }
      const toolId = entry.tool || entry.id;
      button.addEventListener('click', () => this.select(toolId));
      this.buttons.set(toolId, button);
      this.el.append(button);
    }

    mount.append(this.el, this.popover);

    // A click anywhere else dismisses the popover, the way a real popover does.
    document.addEventListener('pointerdown', (event) => {
      if (this.popover.hidden) return;
      if (this.popover.contains(event.target) || this.el.contains(event.target)) return;
      this.closePopover();
    });

    this.render();
  }

  select(toolId) {
    if (this.tools.tool === toolId) {
      this.togglePopover(toolId);
      return;
    }
    this.tools.tool = toolId;
    this.closePopover();
    this.render();
    this.dispatchEvent(new CustomEvent('tool', { detail: { tool: toolId } }));
  }

  /** Set the tool without treating it as a re-tap (used by menu shortcuts). */
  setTool(toolId) {
    if (!this.buttons.has(toolId)) return;
    this.tools.tool = toolId;
    this.closePopover();
    this.render();
    this.dispatchEvent(new CustomEvent('tool', { detail: { tool: toolId } }));
  }

  render() {
    for (const [toolId, button] of this.buttons) {
      button.classList.toggle('active', toolId === this.tools.tool);
    }
    const penDot = this.buttons.get('pen')?.querySelector('.swatch-dot');
    if (penDot) penDot.style.setProperty('--dot-color', this.tools.color);
    const hlDot = this.buttons.get('highlighter')?.querySelector('.swatch-dot');
    if (hlDot) hlDot.style.setProperty('--dot-color', this.tools.highlighterColor);
  }

  togglePopover(toolId) {
    if (!this.popover.hidden) {
      this.closePopover();
      return;
    }
    const content = this.#popoverFor(toolId);
    if (!content) return;
    this.popover.replaceChildren(content);

    // Spring the popover out of the button that opened it, not the centre of
    // the screen — the visual link is what makes it feel attached.
    const button = this.buttons.get(toolId);
    if (button) {
      const mountRect = this.popover.offsetParent?.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      // Centre the popover on its button, then clamp so it cannot hang off the
      // edge of a narrow window.
      const half = 134; // half of the popover's 268px width
      const left = buttonRect.left + buttonRect.width / 2 - (mountRect?.left ?? 0);
      const maxLeft = (mountRect?.width ?? window.innerWidth) - half - 12;
      this.popover.style.left = `${Math.min(Math.max(left, half + 12), maxLeft)}px`;
      // The spring grows out of the button, so the origin tracks how far the
      // popover had to be nudged to stay on screen.
      const clampedCentre = Math.min(Math.max(left, half + 12), maxLeft);
      this.popover.style.setProperty('--origin-x', `${half + (left - clampedCentre)}px`);
    }
    this.popover.hidden = false;
  }

  closePopover() {
    this.popover.hidden = true;
  }

  #popoverFor(toolId) {
    const frag = document.createDocumentFragment();
    const tools = this.tools;

    const title = (text) => {
      const node = document.createElement('div');
      node.className = 'popover-title';
      node.textContent = text;
      return node;
    };

    const swatchRow = (colors, current, onPick) => {
      const grid = document.createElement('div');
      grid.className = 'swatches';
      for (const colour of colors) {
        const swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.className = 'swatch';
        swatch.style.setProperty('--c', colour);
        swatch.classList.toggle('on', colour.toLowerCase() === current.toLowerCase());
        swatch.setAttribute('aria-label', colour);
        swatch.addEventListener('click', () => {
          onPick(colour);
          this.render();
          for (const other of grid.children) other.classList.remove('on');
          swatch.classList.add('on');
          this.dispatchEvent(new CustomEvent('settings'));
        });
        grid.append(swatch);
      }
      return grid;
    };

    const sizeRow = (value, min, max, colour, onChange) => {
      const row = document.createElement('div');
      row.className = 'slider-row';
      const preview = document.createElement('div');
      preview.className = 'preview';
      const dot = document.createElement('i');
      preview.append(dot);
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = String(min);
      slider.max = String(max);
      slider.step = '0.5';
      slider.value = String(value);

      const paint = (v) => {
        // The preview dot is the actual nib size, capped so a fat highlighter
        // does not overflow its well.
        const px = Math.min(26, Math.max(3, v));
        dot.style.width = `${px}px`;
        dot.style.height = `${px}px`;
        dot.style.background = colour();
      };
      paint(value);
      slider.addEventListener('input', () => {
        const next = Number(slider.value);
        onChange(next);
        paint(next);
        this.dispatchEvent(new CustomEvent('settings'));
      });
      row.append(preview, slider);
      return row;
    };

    switch (toolId) {
      case 'pen':
        frag.append(
          title('Colour'),
          swatchRow(PEN_COLORS, tools.color, (c) => {
            tools.color = c;
          }),
          title('Width'),
          sizeRow(tools.size, 1, 16, () => tools.color, (v) => {
            tools.size = v;
          })
        );
        break;

      case 'highlighter':
        frag.append(
          title('Colour'),
          swatchRow(HIGHLIGHT_COLORS, tools.highlighterColor, (c) => {
            tools.highlighterColor = c;
          }),
          title('Width'),
          sizeRow(tools.highlighterSize, 6, 48, () => tools.highlighterColor, (v) => {
            tools.highlighterSize = v;
          })
        );
        break;

      case 'eraser':
        frag.append(
          title('Eraser size'),
          sizeRow(tools.eraserSize, 6, 60, () => 'var(--label-secondary)', (v) => {
            tools.eraserSize = v;
          })
        );
        break;

      case 'shape': {
        frag.append(title('Shape'));
        const seg = document.createElement('div');
        seg.className = 'segmented';
        seg.style.marginBottom = '14px';
        for (const [id, iconName, label] of [
          ['line', 'line', 'Line'],
          ['arrow', 'arrow', 'Arrow'],
          ['rect', 'rect', 'Rectangle'],
          ['ellipse', 'ellipse', 'Ellipse'],
        ]) {
          const button = document.createElement('button');
          button.type = 'button';
          button.innerHTML = icon(iconName);
          button.title = label;
          button.classList.toggle('on', tools.shape === id);
          button.addEventListener('click', () => {
            tools.shape = id;
            for (const other of seg.children) other.classList.remove('on');
            button.classList.add('on');
            this.dispatchEvent(new CustomEvent('settings'));
          });
          seg.append(button);
        }
        frag.append(
          seg,
          title('Colour'),
          swatchRow(PEN_COLORS, tools.color, (c) => {
            tools.color = c;
          }),
          title('Line width'),
          sizeRow(tools.size, 1, 16, () => tools.color, (v) => {
            tools.size = v;
          })
        );

        const switchRow = document.createElement('div');
        switchRow.className = 'switch-row';
        switchRow.innerHTML = '<span>Fill shape</span>';
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = `switch${tools.fill ? ' on' : ''}`;
        toggle.setAttribute('role', 'switch');
        toggle.setAttribute('aria-checked', String(!!tools.fill));
        toggle.addEventListener('click', () => {
          tools.fill = !tools.fill;
          toggle.classList.toggle('on', tools.fill);
          toggle.setAttribute('aria-checked', String(tools.fill));
          this.dispatchEvent(new CustomEvent('settings'));
        });
        switchRow.append(toggle);
        frag.append(switchRow);
        break;
      }

      case 'text':
        frag.append(
          title('Colour'),
          swatchRow(PEN_COLORS, tools.textColor, (c) => {
            tools.textColor = c;
          }),
          title('Size'),
          sizeRow(tools.fontSize, 9, 48, () => tools.textColor, (v) => {
            tools.fontSize = v;
          })
        );
        break;

      case 'note':
        frag.append(
          title('Note colour'),
          swatchRow(NOTE_COLORS, tools.noteColor, (c) => {
            tools.noteColor = c;
          })
        );
        break;

      default:
        return null;
    }
    return frag;
  }
}
