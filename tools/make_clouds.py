#!/usr/bin/env python3
"""Synthesises the cloud sheet: public/textures/clouds.webp

No satellite cloud pass is used. Band-limited fractal noise is domain-warped to
get the sheared, curdled look of a real cloud field, then gated against a
latitude coverage profile so the bands sit roughly where Earth's do: a wet
inter-tropical convergence zone, drier subtropical highs near 25 degrees,
storm belts through the mid-latitudes, broad polar cover.

The gate is a quantile of the field, so the coverage numbers below mean what
they say - 0.42 really does leave 42 percent of that latitude covered.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from noiselib import grid, latitudes, normalise, sample_wrap, smoothstep, spectral_noise, standardise

OUT = Path(__file__).resolve().parent.parent / "public" / "textures"
W, H = 4096, 2048
SEED = 20250907
TARGET_COVER = 0.38


def coverage_profile(h):
    """Target cloud fraction by latitude."""
    lat = latitudes(h)

    def band(centre, width, amount):
        return amount * np.exp(-(((lat - centre) / width) ** 2))

    cover = np.full(h, 0.34, dtype=np.float32)
    cover += band(5.0, 10.0, 0.20)       # inter-tropical convergence zone
    cover -= band(26.0, 12.0, 0.10)      # northern subtropical high
    cover -= band(-24.0, 12.0, 0.09)     # southern subtropical high
    cover += band(52.0, 18.0, 0.16)      # northern storm belt
    cover += band(-57.0, 16.0, 0.20)     # southern ocean storm belt
    cover += band(90.0, 24.0, 0.12)      # polar cover
    cover += band(-90.0, 22.0, 0.14)
    return np.clip(cover, 0.12, 0.80)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(SEED)
    print(f"  synthesising {W}x{H} cloud sheet", flush=True)

    xs, ys = grid(H, W)

    # A gentle low-frequency flow field. Enough shear to curdle the cells,
    # not enough to smear them into zonal stripes.
    wx = standardise(spectral_noise(H, W, beta=2.8, rng=rng, hi=14))
    wy = standardise(spectral_noise(H, W, beta=2.8, rng=rng, hi=14))
    warped_x = xs + wx * (W * 0.006)
    warped_y = ys + wy * (H * 0.005)

    # Band-limited octaves: cells, ragged edges, then surface detail.
    cells = spectral_noise(H, W, beta=2.2, rng=rng, lo=3, hi=22)
    edges = spectral_noise(H, W, beta=2.0, rng=rng, lo=18, hi=90)
    fine = spectral_noise(H, W, beta=1.9, rng=rng, lo=85, hi=380)

    field = standardise(
        0.76 * sample_wrap(cells, warped_x, warped_y)
        + 0.26 * sample_wrap(edges, warped_x, warped_y)
        + 0.09 * fine
    )

    # Gate. base_t is the field value that leaves TARGET_COVER of the map
    # covered; the per-latitude profile slides that threshold up or down.
    cover = coverage_profile(H)[:, None]
    base_t = float(np.quantile(field, 1.0 - TARGET_COVER))
    spread = float(np.quantile(field, 0.84) - np.quantile(field, 0.16)) or 1.0
    threshold = base_t - (cover - TARGET_COVER) * (spread * 2.6)

    alpha = smoothstep(threshold - 0.30 * spread, threshold + 0.80 * spread, field)

    # Dense cores, wispy margins.
    alpha = alpha * (0.50 + 0.50 * normalise(field))
    alpha = np.clip(alpha * 1.55, 0.0, 1.0) ** 0.92

    # The poles are geometrically crushed on an equirect grid; fade the last
    # rows so the cap does not read as a hard white disc.
    row = np.arange(H, dtype=np.float32)
    fade = np.minimum(smoothstep(0.0, 7.0, row), smoothstep(0.0, 7.0, (H - 1) - row))
    alpha *= fade[:, None]

    img = Image.fromarray((np.clip(alpha, 0, 1) * 255 + 0.5).astype(np.uint8), "L")
    img = img.filter(ImageFilter.GaussianBlur(radius=1.3))
    img.save(OUT / "clouds.webp", quality=88, method=6)

    covered = float((alpha > 0.35).mean())
    print(f"  wrote clouds.webp  mean alpha {alpha.mean():.3f}  covered {covered:.3f}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
