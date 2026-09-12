#!/usr/bin/env python3
"""Shared spectral-noise helpers for the texture bakes.

Noise is synthesised in the frequency domain, which makes every field exactly
periodic on both axes - important for equirectangular maps, where a seam at
lon 180 would cut straight down the Pacific.
"""
import numpy as np


def spectral_noise(h, w, beta=2.4, rng=None, lo=1.0, hi=None):
    """Periodic fractal noise: white noise shaped by a 1/f**beta falloff."""
    rng = rng or np.random.default_rng(0)
    white = rng.standard_normal((h, w))
    spec = np.fft.fft2(white)

    fy = np.fft.fftfreq(h) * h
    fx = np.fft.fftfreq(w) * w
    # Scale y so features stay round rather than stretched on an equirect grid.
    radius = np.sqrt((fy[:, None] * (w / h)) ** 2 + fx[None, :] ** 2)
    radius[0, 0] = 1.0

    gain = radius ** (-beta / 2.0)
    gain[radius < lo] = 0.0
    if hi is not None:
        gain[radius > hi] = 0.0
    gain[0, 0] = 0.0

    field = np.real(np.fft.ifft2(spec * gain))
    return normalise(field)


def normalise(a):
    lo, hi = float(a.min()), float(a.max())
    return (a - lo) / (hi - lo) if hi > lo else np.zeros_like(a)


def standardise(a):
    """Zero mean, unit deviation - keeps thresholds meaningful across seeds."""
    return (a - a.mean()) / (a.std() + 1e-8)


def sample_wrap(field, x, y):
    """Bilinear sample with wrap in x and clamp in y (for domain warping)."""
    h, w = field.shape
    x0 = np.floor(x).astype(np.int32)
    y0 = np.floor(y).astype(np.int32)
    fx = x - x0
    fy = y - y0
    x0m, x1m = np.mod(x0, w), np.mod(x0 + 1, w)
    y0m = np.clip(y0, 0, h - 1)
    y1m = np.clip(y0 + 1, 0, h - 1)
    a = field[y0m, x0m] * (1 - fx) + field[y0m, x1m] * fx
    b = field[y1m, x0m] * (1 - fx) + field[y1m, x1m] * fx
    return a * (1 - fy) + b * fy


def smoothstep(edge0, edge1, x):
    t = np.clip((x - edge0) / (edge1 - edge0 + 1e-9), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def grid(h, w):
    """Pixel-centre coordinate grids."""
    return np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))


def latitudes(h):
    return np.linspace(90.0, -90.0, h, dtype=np.float32)
