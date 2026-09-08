#!/usr/bin/env python3
"""Generate build/icon.png, the application icon.

Drawn rather than hand-authored so the shape stays reproducible and the repo
does not depend on a binary nobody can edit. Everything is rendered at 4x and
downsampled, which is what gives the diagonal edges of the nib clean antialiasing.
"""

import math
import os

from PIL import Image, ImageDraw, ImageFilter

SIZE = 512
SS = 4  # supersampling factor
S = SIZE * SS

ACCENT_TOP = (10, 132, 255)
ACCENT_BOTTOM = (88, 86, 214)


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def vertical_gradient(size, top, bottom):
    grad = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / (size - 1)
        # Ease the ramp slightly so the midtone sits higher, the way Apple's
        # icon gradients do rather than a flat linear blend.
        t = t * t * (3 - 2 * t)
        grad.putpixel(
            (0, y),
            tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)),
        )
    return grad.resize((size, size), Image.BILINEAR)


def pen_polygon(tip, tail, width, tip_len):
    """A pen body: a thick bar that tapers to a point at `tip`."""
    dx, dy = tail[0] - tip[0], tail[1] - tip[1]
    length = math.hypot(dx, dy)
    ux, uy = dx / length, dy / length
    px, py = -uy, ux
    half = width / 2
    shoulder = (tip[0] + ux * tip_len, tip[1] + uy * tip_len)
    return [
        tip,
        (shoulder[0] + px * half, shoulder[1] + py * half),
        (tail[0] + px * half, tail[1] + py * half),
        (tail[0] - px * half, tail[1] - py * half),
        (shoulder[0] - px * half, shoulder[1] - py * half),
    ]


def main():
    base = vertical_gradient(S, ACCENT_TOP, ACCENT_BOTTOM)
    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    icon.paste(base, (0, 0), rounded_mask(S, int(S * 0.223)))

    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    tip = (0.30 * S, 0.735 * S)
    tail = (0.735 * S, 0.275 * S)
    body = pen_polygon(tip, tail, width=0.128 * S, tip_len=0.105 * S)
    draw.polygon(body, fill=(255, 255, 255, 255))

    # The ferrule: a band across the pen, set back from the nib.
    dx, dy = tail[0] - tip[0], tail[1] - tip[1]
    length = math.hypot(dx, dy)
    ux, uy = dx / length, dy / length
    px, py = -uy, ux
    band_centre = (tip[0] + ux * 0.20 * S, tip[1] + uy * 0.20 * S)
    half_w = 0.064 * S
    half_t = 0.011 * S
    draw.polygon(
        [
            (band_centre[0] + px * half_w + ux * half_t, band_centre[1] + py * half_w + uy * half_t),
            (band_centre[0] - px * half_w + ux * half_t, band_centre[1] - py * half_w + uy * half_t),
            (band_centre[0] - px * half_w - ux * half_t, band_centre[1] - py * half_w - uy * half_t),
            (band_centre[0] + px * half_w - ux * half_t, band_centre[1] + py * half_w - uy * half_t),
        ],
        fill=ACCENT_TOP + (255,),
    )

    # A written flourish under the nib — the "ink" the pen just laid down.
    stroke = []
    for i in range(41):
        t = i / 40
        x = (0.235 + 0.30 * t) * S
        y = (0.815 + 0.055 * math.sin(t * math.pi * 1.6)) * S
        stroke.append((x, y))
    draw.line(stroke, fill=(255, 255, 255, 235), width=int(0.036 * S), joint="curve")

    # Soft drop shadow so the glyph reads against the lighter top of the
    # gradient: the glyph's own alpha, blurred, tinted black and knocked back.
    blurred_alpha = layer.split()[3].filter(ImageFilter.GaussianBlur(0.012 * S))
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    shadow.putalpha(blurred_alpha.point(lambda v: int(v * 0.28)))
    icon.alpha_composite(shadow, (0, int(0.008 * S)))
    icon.alpha_composite(layer)

    out_dir = os.path.join(os.path.dirname(__file__), "..", "build")
    os.makedirs(out_dir, exist_ok=True)
    final = icon.resize((SIZE, SIZE), Image.LANCZOS)
    out = os.path.join(out_dir, "icon.png")
    final.save(out)
    print(f"wrote {out} ({SIZE}x{SIZE})")


if __name__ == "__main__":
    main()
