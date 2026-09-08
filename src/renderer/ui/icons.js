// Inline SVG bodies, drawn on a 24×24 grid with a 1.6–1.7 stroke to match the
// weight of SF Symbols. Kept as markup strings rather than an icon font so they
// inherit currentColor and need no extra asset in the AppImage.

export const icons = {
  pen: '<path d="M4 20l4.5-1 9-9a2.1 2.1 0 0 0-3-3l-9 9L4 20z"/><path d="M13.5 6.5l3 3"/>',
  highlighter:
    '<path d="M5 19h5l8.2-8.2a2 2 0 0 0 0-2.8l-1.7-1.7a2 2 0 0 0-2.8 0L5.5 14.5 5 19z"/><path d="M4 21h16"/>',
  eraser:
    '<path d="M8.5 19H20"/><path d="M15.5 5.5l3.6 3.6a1.8 1.8 0 0 1 0 2.6L12 19H8l-3.4-3.4a1.8 1.8 0 0 1 0-2.6l7.3-7.5a1.8 1.8 0 0 1 2.6 0z"/>',
  lasso:
    '<path d="M12 4c4.4 0 8 2.5 8 5.6 0 3.1-3.6 5.6-8 5.6-1 0-2-.13-2.9-.37"/><path d="M9.1 14.8C6 14 4 12 4 9.6 4 6.5 7.6 4 12 4"/><path d="M8.4 15.2c-.7 1.5-.3 2.9.8 3.4 1.2.5 2.4-.3 2.5-1.6"/><circle cx="7.6" cy="19.4" r="1.7"/>',
  text: '<path d="M5 7V5h14v2"/><path d="M12 5v14"/><path d="M9.2 19h5.6"/>',
  note: '<path d="M5 5.8A1.8 1.8 0 0 1 6.8 4h10.4A1.8 1.8 0 0 1 19 5.8v7.4L13.2 19H6.8A1.8 1.8 0 0 1 5 17.2z"/><path d="M19 13.2h-4.2a1.6 1.6 0 0 0-1.6 1.6V19"/>',
  shapes:
    '<rect x="3.5" y="3.5" width="9" height="9" rx="1.6"/><circle cx="16" cy="16" r="4.6"/>',
  hand: '<path d="M8 11V5.6a1.6 1.6 0 0 1 3.2 0V11"/><path d="M11.2 10.6V4.6a1.6 1.6 0 0 1 3.2 0V11"/><path d="M14.4 11V6.4a1.6 1.6 0 0 1 3.2 0V15a5.5 5.5 0 0 1-5.5 5.5h-1A5.4 5.4 0 0 1 5.8 15v-3.3a1.55 1.55 0 0 1 2.9-.75"/>',

  line: '<path d="M5 19L19 5"/>',
  arrow: '<path d="M5 19L19 5"/><path d="M12.5 5H19v6.5"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="1.8"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8" ry="6"/>',

  undo: '<path d="M4 9h10.5a4.5 4.5 0 1 1 0 9H8"/><path d="M7.5 5.5L4 9l3.5 3.5"/>',
  redo: '<path d="M20 9H9.5a4.5 4.5 0 1 0 0 9H16"/><path d="M16.5 5.5L20 9l-3.5 3.5"/>',
  sidebar:
    '<rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><path d="M9.5 4.5v15"/>',
  zoomIn: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="M15.4 15.4L20 20"/><path d="M8.4 10.8h4.8M10.8 8.4v4.8"/>',
  zoomOut: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="M15.4 15.4L20 20"/><path d="M8.4 10.8h4.8"/>',
  fitWidth: '<path d="M3.5 12h17"/><path d="M7 8.5L3.5 12 7 15.5"/><path d="M17 8.5L20.5 12 17 15.5"/>',
  fitPage: '<rect x="5.5" y="3.5" width="13" height="17" rx="2"/><path d="M9 8h6M9 12h6M9 16h3.5"/>',
  open: '<path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h3.2l1.8 2h8A1.5 1.5 0 0 1 20 9.5v7A1.5 1.5 0 0 1 18.5 18h-13A1.5 1.5 0 0 1 4 16.5z"/>',
  export:
    '<path d="M12 15V4"/><path d="M8.5 7.5L12 4l3.5 3.5"/><path d="M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14"/>',
  rotateLeft:
    '<path d="M4 9h6.5"/><path d="M4 9V2.8"/><path d="M4.4 9A8 8 0 1 1 5 15.4"/>',
  rotateRight:
    '<path d="M20 9h-6.5"/><path d="M20 9V2.8"/><path d="M19.6 9A8 8 0 1 0 19 15.4"/>',
  trash: '<path d="M4.5 7h15"/><path d="M9.5 7V5.4A1.4 1.4 0 0 1 10.9 4h2.2a1.4 1.4 0 0 1 1.4 1.4V7"/><path d="M6.5 7l.8 11.2A1.9 1.9 0 0 0 9.2 20h5.6a1.9 1.9 0 0 0 1.9-1.8L17.5 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  append: '<rect x="3.5" y="5.5" width="11" height="14" rx="1.8"/><path d="M18 8v9M22 12.5h-8" transform="translate(-1.2)"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  droplet: '<path d="M12 3.5s6 6.3 6 10.2A6 6 0 0 1 6 13.7C6 9.8 12 3.5 12 3.5z"/>',
};

/** Build an <svg> with one of the icon bodies. */
export function icon(name, size = 24) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${
    icons[name] || ''
  }</svg>`;
}
