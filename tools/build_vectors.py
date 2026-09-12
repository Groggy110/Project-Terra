#!/usr/bin/env python3
"""Converts Natural Earth GeoJSON into the compact binaries the globe streams.

Two scale sets are produced. 1:50m carries the whole world at low zoom; 1:10m
is fetched only once the camera is close enough to want it. Both are
Douglas-Peucker simplified in degree space, which is the space the vector
canvas is rasterised in, so the tolerance is a direct statement about how far
a line may stray from truth on screen.

Line layers  -> TVEC: stroked (coast, borders, rivers)
Polygon sets -> TPOL: filled and stroked (land, lakes)
"""
import json
import struct
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "tools" / "cache" / "ne"
OUT = ROOT / "public" / "vectors"

# tolerance (deg), minimum bbox diagonal (deg) below which a feature is dropped
LINE_LAYERS = {
    "50m": {
        "coast": ("ne_50m_coastline", 0.030, 0.22),
        "borders": ("ne_50m_admin_0_boundary_lines_land", 0.035, 0.10),
        "rivers": ("ne_50m_rivers_lake_centerlines", 0.040, 0.60),
    },
    "10m": {
        "coast": ("ne_10m_coastline", 0.0040, 0.020),
        "borders": ("ne_10m_admin_0_boundary_lines_land", 0.0050, 0.015),
        "rivers": ("ne_10m_rivers_lake_centerlines", 0.0060, 0.060),
    },
}
POLY_LAYERS = {
    "50m": {
        "land": ("ne_50m_land", 0.030, 0.22),
        "lakes": ("ne_50m_lakes", 0.030, 0.30),
    },
    "10m": {
        "land": ("ne_10m_land", 0.0040, 0.020),
        "lakes": ("ne_10m_lakes", 0.0040, 0.055),
    },
}


def log(msg):
    print(f"  {msg}", flush=True)


def dp_simplify(pts, tol):
    """Douglas-Peucker, iterative so long coastlines cannot blow the stack."""
    n = len(pts)
    if n < 3:
        return pts
    keep = np.zeros(n, dtype=bool)
    keep[0] = keep[n - 1] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        seg = pts[i + 1 : j]
        ax, ay = pts[i]
        bx, by = pts[j]
        dx, dy = bx - ax, by - ay
        span = dx * dx + dy * dy
        if span == 0.0:
            dist = np.hypot(seg[:, 0] - ax, seg[:, 1] - ay)
        else:
            t = np.clip(((seg[:, 0] - ax) * dx + (seg[:, 1] - ay) * dy) / span, 0.0, 1.0)
            dist = np.hypot(seg[:, 0] - (ax + t * dx), seg[:, 1] - (ay + t * dy))
        k = int(np.argmax(dist))
        if dist[k] > tol:
            m = i + 1 + k
            keep[m] = True
            stack.append((i, m))
            stack.append((m, j))
    return pts[keep]


def diagonal(pts):
    lo, hi = pts.min(axis=0), pts.max(axis=0)
    return float(np.hypot(*(hi - lo)))


def read(name):
    path = CACHE / f"{name}.geojson"
    if not path.exists():
        log(f"missing {path.name}")
        return None
    return json.loads(path.read_text())


def line_strings(geom):
    if geom is None:
        return
    if geom["type"] == "LineString":
        yield geom["coordinates"]
    elif geom["type"] == "MultiLineString":
        yield from geom["coordinates"]


def polygons(geom):
    if geom is None:
        return
    if geom["type"] == "Polygon":
        yield geom["coordinates"]
    elif geom["type"] == "MultiPolygon":
        yield from geom["coordinates"]


def write_lines(path, lines):
    count = len(lines)
    offsets = np.zeros(count + 1, dtype=np.uint32)
    boxes = np.zeros((count, 4), dtype=np.float32)
    total = 0
    for i, pts in enumerate(lines):
        offsets[i] = total
        total += len(pts)
        lo, hi = pts.min(axis=0), pts.max(axis=0)
        boxes[i] = (lo[0], lo[1], hi[0], hi[1])
    offsets[count] = total
    coords = (
        np.concatenate(lines).astype(np.float32)
        if lines
        else np.zeros((0, 2), dtype=np.float32)
    )
    with open(path, "wb") as fh:
        fh.write(b"TVEC")
        fh.write(struct.pack("<III", 1, count, total))
        fh.write(offsets.tobytes())
        fh.write(boxes.tobytes())
        fh.write(coords.tobytes())
    return count, total


def write_polys(path, polys):
    """polys: list of polygons, each a list of rings (exterior first)."""
    poly_count = len(polys)
    ring_count = sum(len(p) for p in polys)
    poly_off = np.zeros(poly_count + 1, dtype=np.uint32)
    ring_off = np.zeros(ring_count + 1, dtype=np.uint32)
    boxes = np.zeros((poly_count, 4), dtype=np.float32)

    rings, r, total = [], 0, 0
    for i, poly in enumerate(polys):
        poly_off[i] = r
        stacked = np.concatenate(poly)
        lo, hi = stacked.min(axis=0), stacked.max(axis=0)
        boxes[i] = (lo[0], lo[1], hi[0], hi[1])
        for ring in poly:
            ring_off[r] = total
            total += len(ring)
            rings.append(ring)
            r += 1
    poly_off[poly_count] = r
    ring_off[ring_count] = total
    coords = (
        np.concatenate(rings).astype(np.float32)
        if rings
        else np.zeros((0, 2), dtype=np.float32)
    )
    with open(path, "wb") as fh:
        fh.write(b"TPOL")
        fh.write(struct.pack("<IIII", 1, poly_count, ring_count, total))
        fh.write(poly_off.tobytes())
        fh.write(ring_off.tobytes())
        fh.write(boxes.tobytes())
        fh.write(coords.tobytes())
    return poly_count, total


def build_lines(scale, layer, source, tol, min_diag, manifest):
    data = read(source)
    if data is None:
        return
    kept, raw = [], 0
    for feat in data["features"]:
        for coords in line_strings(feat.get("geometry")):
            pts = np.asarray(coords, dtype=np.float64)[:, :2]
            raw += len(pts)
            if len(pts) < 2 or diagonal(pts) < min_diag:
                continue
            pts = dp_simplify(pts, tol)
            if len(pts) >= 2:
                kept.append(pts)
    name = f"{scale}-{layer}.bin"
    count, total = write_lines(OUT / name, kept)
    size = (OUT / name).stat().st_size
    manifest[f"{scale}/{layer}"] = {"file": name, "kind": "lines", "features": count, "points": total}
    log(f"{name:18s} {count:6d} lines  {raw:8d} -> {total:8d} pts  {size/1e6:5.2f} MB")


def build_polys(scale, layer, source, tol, min_diag, manifest):
    data = read(source)
    if data is None:
        return
    kept, raw = [], 0
    for feat in data["features"]:
        for poly in polygons(feat.get("geometry")):
            rings = []
            for ri, ring in enumerate(poly):
                pts = np.asarray(ring, dtype=np.float64)[:, :2]
                raw += len(pts)
                if ri == 0 and diagonal(pts) < min_diag:
                    rings = []
                    break
                simp = dp_simplify(pts, tol)
                if len(simp) >= 4:
                    rings.append(simp)
                elif ri == 0:
                    rings = []
                    break
            if rings:
                kept.append(rings)
    name = f"{scale}-{layer}.bin"
    count, total = write_polys(OUT / name, kept)
    size = (OUT / name).stat().st_size
    manifest[f"{scale}/{layer}"] = {"file": name, "kind": "polys", "features": count, "points": total}
    log(f"{name:18s} {count:6d} polys  {raw:8d} -> {total:8d} pts  {size/1e6:5.2f} MB")


def build_places(manifest):
    """Cities for the label layer: [name, lon, lat, rank, pop, country]."""
    data = read("ne_10m_populated_places_simple")
    if data is None:
        return
    rows = []
    for feat in data["features"]:
        p = feat["properties"]
        pop = int(p.get("pop_max") or 0)
        rank = int(p.get("scalerank") if p.get("scalerank") is not None else 10)
        if rank > 7 and pop < 500000:
            continue
        lon, lat = feat["geometry"]["coordinates"][:2]
        rows.append(
            [
                p.get("name") or "",
                round(float(lon), 4),
                round(float(lat), 4),
                rank,
                pop,
                p.get("adm0name") or "",
                1 if p.get("adm0cap") else 0,
            ]
        )
    rows.sort(key=lambda r: (r[3], -r[4]))
    (OUT / "places.json").write_text(json.dumps(rows, separators=(",", ":")))
    manifest["places"] = {"file": "places.json", "count": len(rows)}
    log(f"places.json        {len(rows):6d} cities  {(OUT/'places.json').stat().st_size/1e3:5.1f} kB")


def build_countries(manifest):
    """Country labels use Natural Earth's own cartographer-placed label points."""
    data = read("ne_50m_admin_0_countries")
    if data is None:
        return
    rows = []
    for feat in data["features"]:
        p = feat["properties"]
        lon, lat = p.get("LABEL_X"), p.get("LABEL_Y")
        if lon is None or lat is None:
            continue
        extent = 0.0
        for poly in polygons(feat.get("geometry")):
            pts = np.asarray(poly[0], dtype=np.float64)[:, :2]
            extent = max(extent, diagonal(pts))
        rows.append(
            [
                p.get("NAME") or "",
                round(float(lon), 4),
                round(float(lat), 4),
                int(p.get("LABELRANK") or 9),
                round(extent, 2),
                p.get("CONTINENT") or "",
            ]
        )
    rows.sort(key=lambda r: (r[3], -r[4]))
    (OUT / "countries.json").write_text(json.dumps(rows, separators=(",", ":")))
    manifest["countries"] = {"file": "countries.json", "count": len(rows)}
    log(f"countries.json     {len(rows):6d} labels  {(OUT/'countries.json').stat().st_size/1e3:5.1f} kB")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for scale in ("50m", "10m"):
        log(f"--- {scale} ---")
        for layer, (source, tol, diag) in LINE_LAYERS[scale].items():
            build_lines(scale, layer, source, tol, diag, manifest)
        for layer, (source, tol, diag) in POLY_LAYERS[scale].items():
            build_polys(scale, layer, source, tol, diag, manifest)
    log("--- labels ---")
    build_places(manifest)
    build_countries(manifest)
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
