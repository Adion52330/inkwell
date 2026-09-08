#!/usr/bin/env python3
"""Verify that exported ink lands where it was drawn.

Ink is stored in viewport space — the coordinate system the user actually sees.
So a probe stroke drawn at page-space (x, y) must appear at (x, y) in a 72 dpi
raster of the exported page. Checking this against a rendered image, rather than
against our own maths, is what makes the test meaningful: it catches a wrong
rotation mapping that a unit test written from the same assumptions would miss.

Usage: check-export.py <exported.pdf> [x0 x1 y]
"""

import glob
import os
import subprocess
import sys
import tempfile

from PIL import Image


def is_red(pixel):
    r, g, b = pixel[:3]
    return r > 170 and g < 90 and b < 90


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    pdf = sys.argv[1]
    x0, x1, y = (int(v) for v in (sys.argv[2:5] or [100, 300, 200]))

    with tempfile.TemporaryDirectory() as tmp:
        prefix = os.path.join(tmp, "probe")
        subprocess.run(
            ["pdftoppm", "-png", "-r", "72", pdf, prefix],
            check=True,
            capture_output=True,
        )
        pages = sorted(glob.glob(prefix + "*.png"))
        if not pages:
            print("FAIL: pdftoppm produced no pages")
            return 1

        failures = 0
        for page_path in pages:
            image = Image.open(page_path).convert("RGB")
            width, height = image.size
            centre = ((x0 + x1) // 2, y)
            pixel = image.getpixel(centre)

            reds = [
                (px, py)
                for py in range(0, height, 2)
                for px in range(0, width, 2)
                if is_red(image.getpixel((px, py)))
            ]
            bbox = (
                (min(p[0] for p in reds), min(p[1] for p in reds),
                 max(p[0] for p in reds), max(p[1] for p in reds))
                if reds
                else None
            )

            ok = is_red(pixel)
            # The stroke is 12pt wide, so its painted extent overshoots the
            # centreline by roughly half that plus the round cap.
            span_ok = bbox is not None and abs(bbox[1] - (y - 8)) <= 6 and abs(bbox[3] - (y + 8)) <= 6
            status = "ok" if ok and span_ok else "FAIL"
            print(
                f"{os.path.basename(page_path)}: {width}x{height} "
                f"centre{centre}={pixel} red_bbox={bbox} [{status}]"
            )
            if not (ok and span_ok):
                failures += 1

        if failures:
            print(f"\nFAIL: ink was misplaced on {failures} page(s)")
            return 1
        print(f"\nPASS: ink lands exactly where it was drawn on all {len(pages)} pages")
        return 0


if __name__ == "__main__":
    sys.exit(main())
