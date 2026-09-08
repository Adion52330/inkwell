// Text boxes and sticky notes.
//
// These are real DOM elements rather than canvas drawings. Typing into a canvas
// means reimplementing the caret, selection, IME, spellcheck and screen-reader
// support badly; a contenteditable div gets all of that from the platform for
// free, and the text stays crisp at any zoom because it is never rasterised.

export const NOTE_COLORS = ['#FFD60A', '#FF9F0A', '#FF6482', '#BF5AF2', '#0A84FF', '#30D158'];

export function defaultTextObject(x, y, tools) {
  return {
    kind: 'text',
    x,
    y,
    width: 220,
    text: '',
    color: tools.textColor,
    fontSize: tools.fontSize,
    weight: 400,
  };
}

export function defaultNoteObject(x, y, tools) {
  return {
    kind: 'note',
    x,
    y,
    text: '',
    color: tools.noteColor,
    collapsed: false,
  };
}

/**
 * Build the DOM for one object. Positioning is left to the caller, which knows
 * the current scale — this only owns appearance and editing behaviour.
 */
export function createObjectElement(object, { onEdit, onSelect, onDragEnd, onDelete }) {
  const el = document.createElement('div');
  el.className = `obj obj-${object.kind}`;
  el.dataset.id = object.id;

  if (object.kind === 'text') {
    const editor = document.createElement('div');
    editor.className = 'obj-text-body';
    editor.contentEditable = 'plaintext-only';
    editor.spellcheck = false;
    editor.textContent = object.text;
    editor.dataset.placeholder = 'Type…';
    el.append(editor);

    editor.addEventListener('blur', () => {
      el.classList.remove('editing');
      if (editor.textContent !== object.text) onEdit({ text: editor.textContent });
      // An empty text box left behind on blur is clutter nobody asked for.
      if (!editor.textContent.trim()) onDelete();
    });
    editor.addEventListener('focus', () => el.classList.add('editing'));
    editor.addEventListener('keydown', (event) => {
      event.stopPropagation(); // never let typing trigger tool shortcuts
      if (event.key === 'Escape') editor.blur();
    });
  } else {
    const dot = document.createElement('button');
    dot.className = 'obj-note-dot';
    dot.type = 'button';
    dot.setAttribute('aria-label', 'Sticky note');

    const bubble = document.createElement('div');
    bubble.className = 'obj-note-bubble';

    const editor = document.createElement('div');
    editor.className = 'obj-note-body';
    editor.contentEditable = 'plaintext-only';
    editor.spellcheck = false;
    editor.textContent = object.text;
    editor.dataset.placeholder = 'Note…';

    const remove = document.createElement('button');
    remove.className = 'obj-note-delete';
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Delete note';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      onDelete();
    });

    bubble.append(editor, remove);
    el.append(dot, bubble);
    el.classList.toggle('collapsed', object.collapsed);

    dot.addEventListener('click', (event) => {
      event.stopPropagation();
      const collapsed = !el.classList.contains('collapsed');
      el.classList.toggle('collapsed', collapsed);
      onEdit({ collapsed });
      if (!collapsed) editor.focus();
    });
    editor.addEventListener('blur', () => {
      if (editor.textContent !== object.text) onEdit({ text: editor.textContent });
    });
    editor.addEventListener('keydown', (event) => event.stopPropagation());
  }

  // Dragging: grab anywhere that is not the editable text itself.
  let drag = null;
  el.addEventListener('pointerdown', (event) => {
    if (event.target.isContentEditable) return;
    if (event.button !== 0) return;
    event.stopPropagation();
    onSelect();
    drag = { startX: event.clientX, startY: event.clientY, moved: false };
    el.setPointerCapture(event.pointerId);
    el.classList.add('dragging');
  });
  el.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    el.style.setProperty('--drag-x', `${dx}px`);
    el.style.setProperty('--drag-y', `${dy}px`);
  });
  const endDrag = (event) => {
    if (!drag) return;
    el.classList.remove('dragging');
    el.style.removeProperty('--drag-x');
    el.style.removeProperty('--drag-y');
    if (drag.moved) {
      onDragEnd(event.clientX - drag.startX, event.clientY - drag.startY);
    } else if (object.kind === 'text') {
      el.querySelector('.obj-text-body')?.focus();
    }
    drag = null;
  };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);

  return el;
}

export function focusObject(el) {
  const editor = el.querySelector('[contenteditable]');
  if (!editor) return;
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}
