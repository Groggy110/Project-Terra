#!/usr/bin/env python3
"""Builds the two raster inputs the globe shader grades at runtime.

  public/textures/blue-marble.jpg   NASA Blue Marble (topography + bathymetry)
  public/textures/earth-aux.png     R = topography   (hillshade + snow line)
                                    G = land mask    (land / ocean split)
                                    B = coast proximity (shallow-water tint)

The colour image is never pre-graded: the shader lifts land through a tone
curve, separates snow from desert by chroma and recolours the ocean from depth,
so the same source stays usable under either theme.
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

Image.MAX_IMAGE_PIXELS = None

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "tools" / "cache"
OUT = ROOT / "public" / "textures"

AUX_W, AUX_H = 4096, 2048
SS = 2  # rasterise the mask at 2x, then box-down for antialiased coastlines


def log(msg):
    print(f"  {msg}", flush=True)


def rings(geom):
    """Yields (exterior, [holes]) for Polygon / MultiPolygon geometries."""
    if geom is None:
        return
    kind = geom.get("type")
    if kind == "Polygon":
        polys = [geom["coordinates"]]
    elif kind == "MultiPolygon":
        polys = geom["coordinates"]
    else:
        return
    for poly in polys:
        if poly:
            yield poly[0], poly[1:]


def to_pixels(ring, w, h):
    # Equirectangular: lon -180..180 -> 0..w, lat 90..-90 -> 0..h
    return [((lon + 180.0) / 360.0 * w, (90.0 - lat) / 180.0 * h) for lon, lat in ring]


def rasterise_land():
    """Land = Natural Earth 1:10m land polygons minus inland lakes."""
    w, h = AUX_W * SS, AUX_H * SS
    img = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(img)

    land = json.loads((CACHE / "ne" / "ne_10m_land.geojson").read_text())
    n = 0
    for feat in land["features"]:
        for outer, holes in rings(feat.get("geometry")):
            draw.polygon(to_pixels(outer, w, h), fill=255)
            for hole in holes:
                draw.polygon(to_pixels(hole, w, h), fill=0)
            n += 1
    log(f"land polygons: {n}")

    lakes_path = CACHE / "ne" / "ne_10m_lakes.geojson"
    if lakes_path.exists():
        lakes = json.loads(lakes_path.read_text())
        m = 0
        for feat in lakes["features"]:
            for outer, holes in rings(feat.get("geometry")):
                draw.polygon(to_pixels(outer, w, h), fill=0)
                for hole in holes:
                    draw.polygon(to_pixels(hole, w, h), fill=255)
                m += 1
        log(f"lakes subtracted: {m}")

    return img.resize((AUX_W, AUX_H), Image.BOX)


def topography():
    """GEBCO_08 revised elevation ramp, box-reduced to the aux resolution."""
    src = CACHE / "gebco-elev.png"
    if not src.exists():
        log("gebco-elev.png missing - topography channel will be flat")
        return Image.new("L", (AUX_W, AUX_H), 0)
    img = Image.open(src).convert("L")
    log(f"gebco source: {img.size[0]}x{img.size[1]}")
    while img.size[0] >= AUX_W * 2:
        img = img.reduce(2)
    return img.resize((AUX_W, AUX_H), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)

    bm = CACHE / "blue-marble-5400.jpg"
    if bm.exists():
        img = Image.open(bm).convert("RGB")
        log(f"blue marble: {img.size[0]}x{img.size[1]}")
        img.save(OUT / "blue-marble.jpg", quality=90, optimize=True, progressive=True)
    else:
        log("blue-marble-5400.jpg missing - run tools/fetch_sources.sh")
        return 1

    topo = topography()
    mask = rasterise_land()

    # Most land sits low: half of it below 0.10 on the GEBCO ramp. Expanding
    # with a gamma curve spreads that range over more code values, which keeps
    # the in-shader hillshade off the 8-bit quantisation steps.
    topo_a = (np.asarray(topo, dtype=np.float32) / 255.0) ** 0.65

    # Coastal proximity: a wide blur of the mask reads as "how far from shore",
    # on both sides of the line, which the shader uses for the shelf tint.
    prox = mask.filter(ImageFilter.GaussianBlur(radius=16))

    # Nudge the mask so the blur cannot bleed the split itself.
    m = np.asarray(mask, dtype=np.float32) / 255.0
    m = np.clip((m - 0.5) * 1.6 + 0.5, 0.0, 1.0)

    aux = np.stack(
        [
            topo_a,
            m,
            np.asarray(prox, dtype=np.float32) / 255.0,
        ],
        axis=-1,
    )
    Image.fromarray((aux * 255.0 + 0.5).astype(np.uint8), "RGB").save(
        OUT / "earth-aux.png", optimize=True
    )
    log(f"wrote earth-aux.png {AUX_W}x{AUX_H}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
