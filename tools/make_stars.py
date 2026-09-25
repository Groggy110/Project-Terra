#!/usr/bin/env python3
"""Builds the starfield the dark theme uses for its sky.

  public/textures/stars.png   2048 square, tileable, transparent

Deliberately faint and sparse. The reference is a near-black sky with a
scattering of small stars in it, not a galaxy: anything brighter competes with
the globe's own rim light, which is the thing the picture is actually about.

Tileable because the sky is drawn as a repeating CSS background — every star is
stamped with wrap-around, so no seam falls across the page at any window size.
"""
import numpy as np
from PIL import Image
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "textures" / "stars.png"

SIZE = 2048
COUNT = 1100
rng = np.random.default_rng(7)

# RGBA, premultiplied by nothing - the browser composites it over near-black.
canvas = np.zeros((SIZE, SIZE, 4), dtype=np.float32)


def stamp(cx, cy, radius, brightness, tint):
    """Draws one soft star, wrapping at every edge so the sheet tiles."""
    r = int(np.ceil(radius * 3)) + 1
    ys, xs = np.mgrid[-r : r + 1, -r : r + 1]
    d2 = xs * xs + ys * ys
    # A gaussian core. Real point sources land between pixels, so the falloff
    # is what stops every star being a hard square of one pixel.
    falloff = np.exp(-d2 / (2.0 * radius * radius)) * brightness
    keep = falloff > 0.002
    yy = (ys[keep] + int(cy)) % SIZE
    xx = (xs[keep] + int(cx)) % SIZE
    val = falloff[keep]
    for ch in range(3):
        np.maximum.at(canvas[:, :, ch], (yy, xx), val * tint[ch])
    np.maximum.at(canvas[:, :, 3], (yy, xx), val)


for _ in range(COUNT):
    cx, cy = rng.uniform(0, SIZE, 2)
    # Mostly pinpricks; a handful with a little more presence.
    roll = rng.random()
    if roll < 0.80:
        radius, bright = rng.uniform(0.42, 0.66), rng.uniform(0.18, 0.45)
    elif roll < 0.97:
        radius, bright = rng.uniform(0.7, 1.05), rng.uniform(0.45, 0.72)
    else:
        radius, bright = rng.uniform(1.2, 1.9), rng.uniform(0.72, 1.0)
    # Starlight is not white: a cool majority with a few warm ones in it.
    t = rng.random()
    tint = (0.80, 0.88, 1.0) if t < 0.62 else (1.0, 0.97, 0.92) if t < 0.9 else (1.0, 0.90, 0.80)
    stamp(cx, cy, radius, bright, tint)

img = np.clip(canvas, 0.0, 1.0)
# Alpha carries the star; colour is what it is tinted. Flattening the colour
# where alpha is nothing keeps the PNG small.
img[:, :, :3] = np.where(img[:, :, 3:4] > 0.004, img[:, :, :3], 0.0)
out = Image.fromarray((img * 255.0 + 0.5).astype(np.uint8), "RGBA")
OUT.parent.mkdir(parents=True, exist_ok=True)
out.save(OUT, optimize=True)
print(f"  stars.png  {SIZE}x{SIZE}  {OUT.stat().st_size / 1024:.0f} kB")
