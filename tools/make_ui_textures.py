#!/usr/bin/env python3
"""Bakes the non-map artwork.

  public/textures/paper-light.jpg   watercolour wash behind the light theme
  public/textures/paper-dark.jpg    the same wash, inked for the dark theme
  public/textures/grain.png         512px tileable grain, overlaid on the UI
  public/textures/glow.png          radial sprite for the atmosphere and pins
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from noiselib import grid, normalise, smoothstep, spectral_noise, standardise

OUT = Path(__file__).resolve().parent.parent / "public" / "textures"
SEED = 4127


def watercolour(w, h, paper, pigment, strength, seed):
    """Layered washes that dry the way real ones do.

    A pool of watercolour dries with pigment pushed to its boundary, so each
    layer is a hard-edged pool plus a rim taken from the gradient of its own
    coverage. The pool has to stay *hard* for that to work: blur it first and
    the gradient spreads into a soft halo, which is a plain airbrush blob and
    reads as one. Everything below is arranged to keep the boundary crisp and
    let the granulation - the rim, and the flecks that settle in the tooth of
    the paper - carry the texture.
    """
    rng = np.random.default_rng(seed)
    xs, ys = grid(h, w)
    nx, ny = xs / w, ys / h

    # Keep the middle clear so UI text over it stays legible; let the washes
    # gather along the edges and corners.
    cx, cy = nx - 0.5, ny - 0.42
    centre = np.exp(-((cx * 1.5) ** 2 + (cy * 1.9) ** 2) * 3.1)
    edge = np.clip(1.0 - centre, 0.0, 1.0) ** 1.25

    total = np.zeros((h, w), dtype=np.float32)
    rims = np.zeros((h, w), dtype=np.float32)
    # Broad pools first, then progressively smaller ones dropped into them.
    # The weights are deliberately flat rather than falling away: the page
    # scales this down to fit, and a texture carried by its largest features
    # alone arrives as three grey clouds. The finer tiers are what still read
    # as brushwork at a third of the size.
    for lo, hi, thresh, weight in [
        (0.55, 1.9, 0.575, 0.78),
        (1.6, 4.8, 0.615, 0.72),
        (4.0, 11.0, 0.665, 0.44),
        (9.0, 22.0, 0.700, 0.20),
    ]:
        field = normalise(spectral_noise(h, w, beta=2.35, rng=rng, lo=lo, hi=hi))
        # A narrow band, so the pool has an edge rather than a gradient. The
        # wobble breaks the contour line up the way a brush edge is broken.
        wobble = standardise(spectral_noise(h, w, beta=1.6, rng=rng, lo=hi, hi=hi * 7)) * 0.014
        pool = smoothstep(thresh - 0.03, thresh + 0.075, field + wobble)
        gy, gx = np.gradient(pool)
        rim = normalise(np.sqrt(gx * gx + gy * gy))
        # A flat pool is a sticker. Carrying the field through the interior
        # keeps the middle of a wash lighter than the ground it settled into.
        total += weight * pool * (0.52 + 0.88 * field)
        rims += weight * rim

    # The rim is a separate layer: it has to survive the normalise that the
    # pools go through, or the thin line it draws is averaged away.
    wash = normalise(total) * 0.86 + np.clip(rims * 1.35, 0.0, 1.0) * 0.26
    wash = np.clip(wash * edge * strength, 0.0, 1.0)
    # Just enough to take the aliasing off a threshold edge - not enough to
    # turn it back into a gradient.
    wash = np.asarray(
        Image.fromarray((wash * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.0)),
        dtype=np.float32,
    ) / 255.0

    paper = np.array(paper, dtype=np.float32) / 255.0
    pigment = np.array(pigment, dtype=np.float32) / 255.0
    img = paper[None, None, :] * (1 - wash[..., None]) + pigment[None, None, :] * wash[..., None]

    # Granulation: the heavy fraction of the pigment settles into the tooth of
    # cold-press paper and dries as visible flecks. They belong where the
    # water went, so they are gated on the wash rather than scattered evenly.
    spots = (rng.random((h, w)) > 0.9974).astype(np.float32)
    spots = np.asarray(
        Image.fromarray((spots * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.55)),
        dtype=np.float32,
    ) / 255.0
    spots = np.clip(spots * 2.2, 0.0, 1.0) * (0.14 + 0.86 * wash)
    img -= spots[..., None] * 0.50 * np.array([0.60, 0.48, 0.34])

    # Paper tooth.
    tooth = standardise(spectral_noise(h, w, beta=0.5, rng=rng, lo=w / 12))
    img += tooth[..., None] * 0.006
    return Image.fromarray((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB")


def grain(size=512):
    rng = np.random.default_rng(SEED + 7)
    n = normalise(spectral_noise(size, size, beta=0.6, rng=rng, lo=2))
    n = 0.5 + (n - n.mean()) * 1.35
    return Image.fromarray((np.clip(n, 0, 1) * 255).astype(np.uint8), "L")


def glow(size=1024):
    """White core, cool rim, soft falloff - with a slightly irregular edge so
    it does not read as a hard geometric circle when scaled up."""
    rng = np.random.default_rng(SEED + 19)
    xs, ys = grid(size, size)
    nx, ny = (xs / size - 0.5) * 2.0, (ys / size - 0.5) * 2.0
    r = np.sqrt(nx * nx + ny * ny)

    ripple = standardise(spectral_noise(size, size, beta=2.6, rng=rng, lo=3, hi=13))
    r = r * (1.0 + ripple * 0.012)

    core = 1.0 - smoothstep(0.30, 0.395, r)
    halo = (1.0 - smoothstep(0.33, 0.92, r)) ** 2.1
    alpha = np.clip(core + halo * 0.85, 0.0, 1.0)

    rim = np.exp(-(((r - 0.372) / 0.026) ** 2))
    rgb = np.stack(
        [
            np.clip(1.0 - rim * 0.42, 0, 1),
            np.clip(1.0 - rim * 0.22, 0, 1),
            np.ones_like(r),
        ],
        axis=-1,
    )
    out = np.concatenate([rgb, alpha[..., None]], axis=-1)
    return Image.fromarray((np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8), "RGBA")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    w, h = 2400, 1350

    print("  watercolour: light", flush=True)
    watercolour(w, h, (247, 250, 253), (146, 173, 199), 1.02, SEED).save(
        OUT / "paper-light.jpg", quality=92, optimize=True, progressive=True
    )
    print("  watercolour: dark", flush=True)
    watercolour(w, h, (13, 18, 27), (46, 66, 96), 1.05, SEED).save(
        OUT / "paper-dark.jpg", quality=92, optimize=True, progressive=True
    )

    grain().save(OUT / "grain.png", optimize=True)
    glow().save(OUT / "glow.png", optimize=True)
    print("  wrote grain.png, glow.png", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
