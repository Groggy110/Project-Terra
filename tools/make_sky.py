#!/usr/bin/env python3
"""Bakes public/textures/sky.jpg: the night sky behind the planet.

A Milky Way seen from a dark site — a band of blue and violet nebula running
corner to corner across the top of the frame, dust lanes through it, a dense
spray of faint stars thickening toward the band and a few hundred bright ones
with a soft bloom. The middle third above the planet is kept quieter, because
that is where the headline stands and its words need a dark ground.

Generated rather than sourced, so it carries no licence and can be tuned to the
page's own blues. Deterministic: the same seed bakes the same sky.

    python3 tools/make_sky.py
"""
from pathlib import Path

import numpy as np
from PIL import Image

from noiselib import normalise, smoothstep, spectral_noise

W, H = 2880, 1620
SEED = 7
OUT = Path(__file__).resolve().parent.parent / "public" / "textures" / "sky.jpg"

rng = np.random.default_rng(SEED)
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
u = xx / W
v = yy / H


def blur(a, radius):
    """Gaussian blur of a float field, through the frequency domain."""
    fy = np.fft.fftfreq(a.shape[0])[:, None]
    fx = np.fft.fftfreq(a.shape[1])[None, :]
    kernel = np.exp(-2 * (np.pi * radius) ** 2 * (fx**2 + fy**2))
    return np.real(np.fft.ifft2(np.fft.fft2(a) * kernel)).astype(np.float32)


# ---------------------------------------------------------------- the band
# A gently curving line from lower left to upper right, high in the frame.
centre = 0.34 - 0.30 * (u - 0.5) + 0.05 * np.sin(u * 3.1 + 0.6)
dist = (v - centre) / 0.19
band = np.exp(-dist**2)

cloud = spectral_noise(H, W, beta=2.7, rng=rng)
cloud_fine = spectral_noise(H, W, beta=1.9, rng=rng)
hue_field = spectral_noise(H, W, beta=3.2, rng=rng)
dust = spectral_noise(H, W, beta=2.2, rng=rng)

glow = band * (0.45 + 0.75 * cloud) * (0.75 + 0.35 * cloud_fine)
glow = np.clip(glow - 0.12, 0, None) ** 1.25
# Dust lanes: dark filaments where the dust field runs high, inside the band.
lanes = smoothstep(0.55, 0.78, dust) * band
glow *= 1.0 - 0.75 * lanes

# Loose nebulae off the band: two soft clouds in the upper corners.
def blob(cx, cy, rx, ry):
    return np.exp(-(((u - cx) / rx) ** 2 + ((v - cy) / ry) ** 2))

side = (blob(0.12, 0.22, 0.20, 0.26) + blob(0.88, 0.30, 0.22, 0.28)) * (0.4 + 0.8 * cloud)
glow += 0.35 * side

# The headline's ground: quieter in the middle third above the planet.
quiet = 1.0 - 0.55 * np.exp(-(((u - 0.5) / 0.2) ** 2)) * smoothstep(0.75, 0.25, v)
glow *= quiet
glow = normalise(glow) ** 1.15

# Colour: deep blue through cyan, with violet where the hue field runs high.
deep = np.array([0.10, 0.20, 0.55])
cyan = np.array([0.30, 0.62, 1.00])
violet = np.array([0.46, 0.32, 0.95])
t = smoothstep(0.35, 0.75, hue_field)[..., None]
tone = (1 - t) * (deep + (cyan - deep) * glow[..., None] ** 0.7) + t * violet
nebula = tone * glow[..., None] * 0.62

# ---------------------------------------------------------------- the stars
stars = np.zeros((H, W, 3), dtype=np.float32)

# Faint field: many single pixels, denser in the band.
density = 0.0016 + 0.010 * band
mask = rng.random((H, W)) < density
level = rng.random((H, W)) ** 3 * 0.75 + 0.08
tint_pick = rng.random((H, W))
warm = np.array([1.0, 0.86, 0.70])
cool = np.array([0.78, 0.88, 1.0])
white = np.array([1.0, 1.0, 1.0])
for lo, hi, c in [(0.0, 0.18, warm), (0.18, 0.55, cool), (0.55, 1.01, white)]:
    sel = mask & (tint_pick >= lo) & (tint_pick < hi)
    stars[sel] += level[sel][:, None] * c
# A touch of softness so they read as points of light, not dead pixels.
soft = np.stack([blur(stars[..., i], 0.6) for i in range(3)], -1)
stars = 0.55 * stars + 1.6 * soft

# Bright stars: a few hundred with a core and a bloom, some with a faint cross.
bright = np.zeros((H, W, 3), dtype=np.float32)
n_bright = 420
for _ in range(n_bright):
    x = int(rng.integers(0, W))
    y = int(rng.integers(0, H))
    m = rng.random() ** 2.4
    r = 1.2 + 4.5 * m
    c = [warm, cool, white, cool][int(rng.integers(0, 4))]
    x0, x1 = max(0, x - int(r * 6)), min(W, x + int(r * 6) + 1)
    y0, y1 = max(0, y - int(r * 6)), min(H, y + int(r * 6) + 1)
    gx, gy = np.meshgrid(np.arange(x0, x1) - x, np.arange(y0, y1) - y)
    d2 = gx**2 + gy**2
    core = np.exp(-d2 / (2 * (0.55 + 0.6 * m) ** 2))
    halo = np.exp(-d2 / (2 * (r * 1.6) ** 2)) * 0.18
    spot = (core * (0.55 + 0.45 * m) + halo * m)
    if m > 0.55:
        spikes = (np.exp(-gy**2 / 0.5) * np.exp(-np.abs(gx) / (r * 2.2)) + np.exp(-gx**2 / 0.5) * np.exp(-np.abs(gy) / (r * 2.2))) * 0.35 * m
        spot = spot + spikes
    bright[y0:y1, x0:x1] += spot[..., None] * c

# ---------------------------------------------------------------- compose
sky = nebula + stars + bright
# The faintest blue floor, so the black is a night sky rather than a void.
sky += np.array([0.004, 0.010, 0.026]) * (1.0 - v[..., None] * 0.6)
sky = 1.0 - np.exp(-sky * 1.15)  # soft shoulder, no clipped highlights
img = Image.fromarray(np.clip(sky * 255 + rng.random(sky.shape) * 1.2, 0, 255).astype(np.uint8), "RGB")
OUT.parent.mkdir(parents=True, exist_ok=True)
img.save(OUT, quality=86, optimize=True, progressive=True)
print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB)")
