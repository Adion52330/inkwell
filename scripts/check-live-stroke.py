#!/usr/bin/env python3
"""Compare where ink appears mid-stroke against where it lands on release.

Pairs with scripts/test-live-stroke.mjs. The wet (in-progress) canvas and the
committed canvas are drawn by different code paths, and a transform mistake in
either one shows up as the stroke visibly jumping when you lift the pointer.
Comparing the two rendered frames catches that; no unit test on the maths would,
because both paths would be checked against the same wrong assumption.

Usage: check-live-stroke.py <dir>

Reads during.png, after.png and meta.json from the directory written by
scripts/test-live-stroke.mjs.

The window is searched only inside the given box, which must lie within the
white page: the viewer background is near-black in dark mode and would
otherwise be counted as ink.
"""

import json
import os
import sys

from PIL import Image

# The page is white with pale grey rules (~222); ink is near-black.
INK_MAX = 130


def ink_bbox(path, top, bottom, left, right):
    image = Image.open(path).convert("RGB")
    width, height = image.size
    top = max(0, top)
    bottom = min(height, bottom)
    left = max(0, left)
    right = min(width, right)
    pixels = image.load()

    xs, ys = [], []
    for y in range(top, bottom):
        for x in range(left, right, 2):
            r, g, b = pixels[x, y]
            if r < INK_MAX and g < INK_MAX and b < INK_MAX:
                xs.append(x)
                ys.append(y)
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    directory = sys.argv[1]
    during_path = os.path.join(directory, "during.png")
    after_path = os.path.join(directory, "after.png")
    with open(os.path.join(directory, "meta.json")) as handle:
        band = json.load(handle)["band"]
    top, bottom = band["top"], band["bottom"]
    left, right = band["left"], band["right"]

    during = ink_bbox(during_path, top, bottom, left, right)
    after = ink_bbox(after_path, top, bottom, left, right)

    print(f"mid-stroke ink bbox: {during}")
    print(f"released  ink bbox: {after}")

    if during is None:
        print("\nFAIL: no ink visible while drawing — the live stroke never painted")
        return 1
    if after is None:
        print("\nFAIL: no ink after release — the stroke was not committed")
        return 1

    # A few pixels of difference is expected: the wet stroke has an open tail
    # while it is still being drawn, and gains its end cap on release.
    drift = max(abs(a - b) for a, b in zip(during, after))
    print(f"largest edge difference: {drift}px")
    if drift > 12:
        print(
            "\nFAIL: the stroke moved when the pointer was released.\n"
            "The live and committed layers disagree — check the wet canvas transform."
        )
        return 1
    print("\nPASS: ink is drawn where the pointer is, and stays there on release")
    return 0


if __name__ == "__main__":
    sys.exit(main())
