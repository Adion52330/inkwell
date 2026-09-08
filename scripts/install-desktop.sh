#!/usr/bin/env bash
# Install Inkwell into the desktop environment and, optionally, make it the
# default PDF handler.
#
# Everything is written under $HOME - nothing needs root, and nothing outside
# the user's own XDG directories is touched. Run with --uninstall to reverse it.
#
#   scripts/install-desktop.sh              install and set as default
#   scripts/install-desktop.sh --no-default install, but leave the default alone
#   scripts/install-desktop.sh --uninstall  remove it again

set -euo pipefail

APP_ID="inkwell"
DESKTOP_FILE="${APP_ID}.desktop"
APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps"
INSTALL_DIR="$HOME/Applications"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$INSTALL_DIR/Inkwell.AppImage"

refresh_caches() {
  # Both are best-effort: the entry still works without them, it may just take a
  # moment to show up in the launcher.
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 &&
    gtk-update-icon-cache -qtf "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor" || true
}

uninstall() {
  echo "Removing Inkwell from the desktop…"
  # Hand the PDF association back to whatever else is installed, rather than
  # leaving the system pointing at a launcher that no longer exists.
  if command -v xdg-mime >/dev/null 2>&1; then
    current="$(xdg-mime query default application/pdf 2>/dev/null || true)"
    if [ "$current" = "$DESKTOP_FILE" ]; then
      fallback="$(grep -l 'application/pdf' "$APPS_DIR"/*.desktop /usr/share/applications/*.desktop 2>/dev/null |
        grep -v "$DESKTOP_FILE" | head -1 || true)"
      if [ -n "$fallback" ]; then
        xdg-mime default "$(basename "$fallback")" application/pdf || true
        echo "  PDFs now open with $(basename "$fallback")"
      else
        echo "  no other PDF viewer found; your desktop will pick one"
      fi
    fi
  fi
  rm -f "$APPS_DIR/$DESKTOP_FILE" "$ICON_DIR/$APP_ID.png" "$TARGET"
  refresh_caches
  echo "Done."
  exit 0
}

[ "${1:-}" = "--uninstall" ] && uninstall

APPIMAGE="$(ls -t "$REPO_ROOT"/release/*.AppImage 2>/dev/null | head -1 || true)"
if [ -z "$APPIMAGE" ]; then
  echo "No AppImage found in release/. Build one first:" >&2
  echo "  npm run dist" >&2
  exit 1
fi

mkdir -p "$APPS_DIR" "$ICON_DIR" "$INSTALL_DIR"

# Copy rather than symlink: the desktop entry has to keep working after the
# repository is moved, rebuilt or cleaned.
install -m 755 "$APPIMAGE" "$TARGET"
install -m 644 "$REPO_ROOT/build/icon.png" "$ICON_DIR/$APP_ID.png"

cat > "$APPS_DIR/$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Inkwell
GenericName=PDF Annotator
Comment=Read PDFs and write on them
Exec=$TARGET %U
Icon=$APP_ID
Terminal=false
Categories=Office;Graphics;Viewer;
MimeType=application/pdf;
Keywords=pdf;annotate;handwriting;notes;ink;
StartupNotify=true
StartupWMClass=$APP_ID
EOF

chmod 644 "$APPS_DIR/$DESKTOP_FILE"
refresh_caches

echo "Installed:"
echo "  application  $TARGET"
echo "  launcher     $APPS_DIR/$DESKTOP_FILE"
echo "  icon         $ICON_DIR/$APP_ID.png"

if [ "${1:-}" = "--no-default" ]; then
  echo
  echo "Left the default PDF handler unchanged."
  exit 0
fi

if command -v xdg-mime >/dev/null 2>&1; then
  previous="$(xdg-mime query default application/pdf 2>/dev/null || echo none)"
  xdg-mime default "$DESKTOP_FILE" application/pdf
  echo
  echo "PDFs now open with Inkwell (was: $previous)."
  echo "To undo just this part:  xdg-mime default $previous application/pdf"
else
  echo
  echo "xdg-mime not found; set Inkwell as the PDF handler from your file manager." >&2
fi
