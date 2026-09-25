/**
 * The vector layer.
 *
 * Coast, borders, rivers, lakes and the land fill are all geometry, never
 * pixels. On every settle the visible lat/lon window is rasterised into two
 * canvases at roughly one texel per device pixel:
 *
 *   lines - stroked ink, composited over the graded imagery
 *   mask  - the land/ocean split, which replaces the low-res raster mask
 *
 * Because the shader addresses those canvases geographically (through a window
 * uniform) rather than by screen position, a stale canvas stays pinned to the
 * right ground while the camera moves; only its sharpness lags, and the window
 * is padded so a repaint is not needed for every nudge.
 *
 * Two tiers. The fine window always paints at one texel per device pixel and
 * shrinks its coverage - never its resolution - to stay inside the texel
 * budget. Under it sits a coarse world canvas, which is what shows in the
 * foreshortened sliver near the limb where a degree of arc is worth almost no
 * pixels anyway. That split is why mid-zoom stays sharp: a single equirect
 * window over a whole visible hemisphere would need 17 million texels.
 */
import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, Vector4 } from "three";

import { boundsContain, clamp, DEG, smoothstep, wrapDelta } from "./geo.js";

const LINE_LAYERS = ["coast", "borders", "rivers"];
const POLY_LAYERS = ["land", "lakes"];
const TEXEL_BUDGET = 7.2e6;
const MIN_SIDE = 256;
const MAX_SIDE = 4096;
// Canvas sides are quantised so the GPU texture is reallocated rarely.
const QUANT = 256;
const BASE_W = 2048;
const BASE_H = 1024;
/**
 * How far the view centre may drift, as a fraction of the painted span,
 * before a window that cannot grow any wider is worth re-centring. Small
 * enough that the fine tier stays under the middle of the disc, large enough
 * that a slow drift asks for a repaint every few seconds rather than every
 * frame.
 */
const RECENTRE_AT = 0.08;

/** Line weights for the coarse world tier, which has no screen scale. */
const BASE_FADE = { coast: 1, borders: 0.5, rivers: 0.22, lakeEdge: 0.5 };

/* ------------------------------------------------------------------ store */

function parseLines(buffer) {
  const head = new DataView(buffer);
  const magic = String.fromCharCode(head.getUint8(0), head.getUint8(1), head.getUint8(2), head.getUint8(3));
  if (magic !== "TVEC") throw new Error(`bad line magic ${magic}`);
  const count = head.getUint32(8, true);
  const total = head.getUint32(12, true);
  let at = 16;
  const offsets = new Uint32Array(buffer, at, count + 1);
  at += 4 * (count + 1);
  const boxes = new Float32Array(buffer, at, count * 4);
  at += 16 * count;
  const coords = new Float32Array(buffer, at, total * 2);
  return { kind: "lines", count, offsets, boxes, coords };
}

function parsePolys(buffer) {
  const head = new DataView(buffer);
  const magic = String.fromCharCode(head.getUint8(0), head.getUint8(1), head.getUint8(2), head.getUint8(3));
  if (magic !== "TPOL") throw new Error(`bad poly magic ${magic}`);
  const polyCount = head.getUint32(8, true);
  const ringCount = head.getUint32(12, true);
  const total = head.getUint32(16, true);
  let at = 20;
  const polyOffsets = new Uint32Array(buffer, at, polyCount + 1);
  at += 4 * (polyCount + 1);
  const ringOffsets = new Uint32Array(buffer, at, ringCount + 1);
  at += 4 * (ringCount + 1);
  const boxes = new Float32Array(buffer, at, polyCount * 4);
  at += 16 * polyCount;
  const coords = new Float32Array(buffer, at, total * 2);
  return { kind: "polys", count: polyCount, polyOffsets, ringOffsets, boxes, coords };
}

export class VectorStore {
  constructor(base = "/vectors") {
    this.base = base;
    this.scales = new Map();
    this.pending = new Map();
  }

  get(scale) {
    return this.scales.get(scale) || null;
  }

  /** Loads one scale set; concurrent callers share the same promise. */
  load(scale) {
    if (this.scales.has(scale)) return Promise.resolve(this.scales.get(scale));
    if (this.pending.has(scale)) return this.pending.get(scale);

    const job = (async () => {
      const names = [...LINE_LAYERS, ...POLY_LAYERS];
      const buffers = await Promise.all(
        names.map(async (layer) => {
          const res = await fetch(`${this.base}/${scale}-${layer}.bin`);
          if (!res.ok) throw new Error(`${scale}-${layer}.bin -> ${res.status}`);
          return res.arrayBuffer();
        }),
      );
      const set = {};
      names.forEach((layer, i) => {
        set[layer] = LINE_LAYERS.includes(layer) ? parseLines(buffers[i]) : parsePolys(buffers[i]);
      });
      this.scales.set(scale, set);
      this.pending.delete(scale);
      return set;
    })();

    this.pending.set(scale, job);
    return job;
  }
}

/* ----------------------------------------------------------------- styles */

const STYLE = {
  light: {
    coast: { color: "255,255,255", width: 1.05, alpha: 0.82 },
    borders: { color: "56,78,104", width: 0.85, alpha: 0.4 },
    rivers: { color: "108,158,201", width: 0.8, alpha: 0.6 },
    lakeEdge: { color: "255,255,255", width: 0.8, alpha: 0.6 },
  },
  // Against the night sky the coast is drawn as shallow water rather than as
  // an outline: the reference has no line round its continents, it has a band
  // of lit turquoise where the shelf comes up. So the ink is turquoise and
  // faint enough to read as the sea getting shallower.
  dark: {
    coast: { color: "108,196,226", width: 1.05, alpha: 0.3 },
    borders: { color: "186,214,242", width: 0.85, alpha: 0.2 },
    rivers: { color: "86,140,192", width: 0.8, alpha: 0.5 },
    lakeEdge: { color: "108,196,226", width: 0.8, alpha: 0.24 },
  },
};

/* ---------------------------------------------------------------- painter */

export class VectorPainter {
  constructor(store) {
    this.store = store;
    this.lines = document.createElement("canvas");
    this.mask = document.createElement("canvas");
    this.lines.width = this.mask.width = MIN_SIDE;
    this.lines.height = this.mask.height = MIN_SIDE / 2;
    this.lineCtx = this.lines.getContext("2d", { alpha: true, willReadFrequently: false });
    this.maskCtx = this.mask.getContext("2d", { alpha: false, willReadFrequently: false });

    this.base = document.createElement("canvas");
    this.base.width = BASE_W;
    this.base.height = BASE_H;
    this.baseCtx = this.base.getContext("2d", { alpha: true });

    this.lineTexture = new CanvasTexture(this.lines);
    this.maskTexture = new CanvasTexture(this.mask);
    this.baseTexture = new CanvasTexture(this.base);
    for (const t of [this.lineTexture, this.maskTexture, this.baseTexture]) {
      // The shader addresses these canvases top-down, the same way the window
      // is derived from latitude; three would otherwise upload them flipped.
      t.flipY = false;
    }
    for (const t of [this.lineTexture, this.maskTexture]) {
      t.minFilter = LinearFilter;
      t.magFilter = LinearFilter;
      t.generateMipmaps = false;
      t.anisotropy = 1;
    }
    this.baseTexture.minFilter = LinearMipmapLinearFilter;
    this.baseTexture.magFilter = LinearFilter;
    this.baseTexture.generateMipmaps = true;
    this.baseTexture.anisotropy = 4;
    this.baseTheme = null;

    /** window in uv space: (uMin, vMin, uSpan, vSpan) */
    this.window = new Vector4(0, 0, 1, 1);
    this.painted = null;
    this.paintedCentre = null;
    this.paintedDensity = 0;
    this.paintedQuality = 0;
    this.scale = "50m";
    this.theme = "light";
    this.stats = { paints: 0, lastMs: 0, size: "0x0", features: 0 };
  }

  /**
   * 1:50m carries the world; 1:10m takes over once lines would show it.
   *
   * The threshold is in *device* pixels per degree, and that is the whole
   * subtlety: at 12, a retina screen crossed it at the whole-globe view, so
   * the entire world was rasterised from the full-detail set on every paint —
   * thirteen thousand features for a disc fifteen hundred pixels across. Side
   * by side with 1:50m at that zoom the two are pixel-for-pixel identical, and
   * the fine set costs twenty times more to draw.
   *
   * 34 is where the difference starts to be visible rather than merely
   * present: 1:50m still holds the Aegean together at 27, and has begun to
   * swallow the islands by 55.
   *
   * 24 was measured as the alternative, and it does keep a few more river
   * hairlines at the working view — at a full paint of 9.9ms against 3ms.
   * That fits a 60Hz frame and misses a 120Hz one, and every recent Mac this
   * runs on has a 120Hz panel, so the hairlines lose.
   */
  static scaleFor(pxPerDeg) {
    return pxPerDeg > 34 ? "10m" : "50m";
  }

  needsRepaint(bounds, pxPerDeg, centre) {
    if (!this.painted) return true;
    // paintedDensity is the density actually rasterised, so a coarse paint
    // taken during motion still reads as out of date once the camera settles.
    const ratio = pxPerDeg / (this.paintedDensity || 1e-6);
    if (ratio > 1.4 || ratio < 0.45) return true;
    if (boundsContain(this.painted, bounds)) return false;

    /*
     * The request reaches past the window that was painted — which, on its
     * own, is not a reason to paint again.
     *
     * The window is clamped to a texel budget and to MAX_SIDE, so a request
     * for more ground than the budget covers can never be satisfied however
     * many times it is run. That is not a corner case: viewBounds reports a
     * full 360 degrees of longitude the moment the visible cap touches a
     * pole, which it does at every view wider than regional. Containment
     * therefore failed permanently at the whole globe, at the working view
     * and at regional zoom alike, and the painter re-rasterised the world on
     * every single frame of every drift and drag — thirty-six milliseconds a
     * frame at the whole globe, which is where the page opens.
     *
     * What actually decides it is whether painting again would put the window
     * over different ground, and that is a question about the centre, not the
     * span. The limb it can no longer reach is the foreshortened sliver the
     * coarse base tier exists to cover.
     */
    if (!centre || !this.paintedCentre) return true;
    const dLon = Math.abs(wrapDelta(this.paintedCentre.lon, centre.lon));
    const dLat = Math.abs(centre.lat - this.paintedCentre.lat);
    return dLon > this.painted.lonSpan * RECENTRE_AT || dLat > this.painted.latSpan * RECENTRE_AT;
  }

  /**
   * Paints the coarse world tier. Always 1:50m: it exists to fill the
   * foreshortened edge, so finer data there would cost time for pixels no one
   * can resolve. Repainted only when the theme changes.
   */
  repaintBase(theme = "light") {
    const set = this.store.get("50m");
    if (!set || this.baseTheme === theme) return false;
    const view = {
      lonMin: -180,
      latMax: 90,
      kx: BASE_W / 360,
      ky: BASE_H / 180,
      w: BASE_W,
      h: BASE_H,
    };
    this.#paintLines(set, view, STYLE[theme] || STYLE.light, 0, 1, BASE_FADE, this.baseCtx);
    this.baseTexture.needsUpdate = true;
    this.baseTheme = theme;
    return true;
  }

  /**
   * Rasterises `bounds` at one texel per device pixel of `pxPerDeg`. If that
   * exceeds the budget the window narrows - longitude first, since longitude
   * is what the limb crushes - rather than dropping resolution.
   */
  repaint(bounds, pxPerDeg, { theme = "light", quality = 1, pad = 1.28, centre } = {}) {
    const scale = VectorPainter.scaleFor(pxPerDeg);
    const set = this.store.get(scale) || this.store.get("50m");
    if (!set) return false;

    const t0 = performance.now();
    let win = padBounds(bounds, pad);
    const lonMid = centre ? centre.lon : win.lonMin + win.lonSpan * 0.5;
    const latMid = centre ? centre.lat : win.latMin + win.latSpan * 0.5;
    const cosLat = Math.max(Math.cos(latMid * DEG), 0.16);
    const density = pxPerDeg * quality;

    let w = win.lonSpan * density * cosLat;
    let h = win.latSpan * density;

    if (h > MAX_SIDE) {
      h = MAX_SIDE;
      win = recentre(win, win.lonSpan, h / density, lonMid, latMid);
    }
    if (w > MAX_SIDE) {
      w = MAX_SIDE;
      win = recentre(win, w / (density * cosLat), win.latSpan, lonMid, latMid);
    }
    if (w * h > TEXEL_BUDGET) {
      const fitW = TEXEL_BUDGET / h;
      if (fitW >= MIN_SIDE) {
        w = fitW;
      } else {
        w = MIN_SIDE;
        h = TEXEL_BUDGET / MIN_SIDE;
      }
      win = recentre(win, w / (density * cosLat), h / density, lonMid, latMid);
    }

    // Quantise the sides, then re-derive the window so the canvas is filled
    // exactly at 1:1. Rounding the window to the canvas rather than the canvas
    // to the window is what keeps reallocations rare.
    w = clamp(Math.min(Math.ceil(w / QUANT) * QUANT, MAX_SIDE), MIN_SIDE, MAX_SIDE);
    h = clamp(Math.min(Math.ceil(h / QUANT) * QUANT, MAX_SIDE), MIN_SIDE / 2, MAX_SIDE);
    win = recentre(win, w / (density * cosLat), h / density, lonMid, latMid);

    if (this.lines.width !== w || this.lines.height !== h) {
      this.lines.width = this.mask.width = w;
      this.lines.height = this.mask.height = h;
      // In WebGL2 three allocates immutable storage for a texture on its first
      // upload (texStorage2D) and thereafter only writes into it with
      // texSubImage2D. A resized canvas can therefore never change the
      // texture's dimensions - later repaints would keep uploading into the
      // original allocation, so the GPU would still be holding the very first
      // window's pixels. Dropping the GPU texture forces a fresh allocation.
      this.lineTexture.dispose();
      this.maskTexture.dispose();
    }

    const style = STYLE[theme] || STYLE.light;
    const view = {
      lonMin: win.lonMin,
      latMax: win.latMin + win.latSpan,
      kx: w / win.lonSpan,
      ky: h / win.latSpan,
      w,
      h,
    };
    const texelPerPx =
      (w / (win.lonSpan * density * cosLat) + h / (win.latSpan * density)) * 0.5;

    let features = 0;
    features += this.#paintMask(set, view);
    features += this.#paintLines(set, view, style, pxPerDeg, texelPerPx);

    this.lineTexture.needsUpdate = true;
    this.maskTexture.needsUpdate = true;
    this.window.set(
      (win.lonMin + 180) / 360,
      0.5 - (win.latMin + win.latSpan) / 180,
      win.lonSpan / 360,
      win.latSpan / 180,
    );
    this.painted = win;
    this.paintedCentre = { lat: latMid, lon: lonMid };
    this.paintedDensity = density;
    this.scale = scale;
    this.theme = theme;
    this.paintedQuality = quality;
    this.stats = {
      paints: this.stats.paints + 1,
      lastMs: Math.round((performance.now() - t0) * 10) / 10,
      size: `${w}x${h}`,
      features,
      scale,
    };
    return true;
  }

  /** White land, black water - the crisp replacement for the raster mask. */
  #paintMask(set, view) {
    const ctx = this.maskCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, view.w, view.h);
    ctx.fillStyle = "#fff";
    let n = fillPolys(ctx, set.land, view);
    ctx.fillStyle = "#000";
    n += fillPolys(ctx, set.lakes, view);
    return n;
  }

  #paintLines(set, view, style, pxPerDeg, texelPerPx, fadeOverride, target) {
    const ctx = target || this.lineCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, view.w, view.h);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    // Detail arrives with zoom: at a whole-globe view the raster already
    // carries the coast, and hairline borders and rivers would only add fizz.
    const fade = fadeOverride || {
      coast: 0.34 + 0.66 * smoothstep(4, 13, pxPerDeg),
      borders: smoothstep(5, 13, pxPerDeg),
      rivers: smoothstep(7, 20, pxPerDeg),
      lakeEdge: smoothstep(5, 14, pxPerDeg),
    };

    let n = 0;
    const draw = (data, s, weight, isPoly) => {
      if (weight <= 0.01 || !data) return;
      ctx.strokeStyle = `rgba(${s.color},${(s.alpha * weight).toFixed(3)})`;
      ctx.lineWidth = Math.max(s.width * texelPerPx, 0.6);
      n += isPoly ? strokePolys(ctx, data, view) : strokeLines(ctx, data, view);
    };

    draw(set.rivers, style.rivers, fade.rivers, false);
    draw(set.lakes, style.lakeEdge, fade.lakeEdge, true);
    draw(set.borders, style.borders, fade.borders, false);
    draw(set.coast, style.coast, fade.coast, false);
    return n;
  }
}

/* ------------------------------------------------------------ rasterising */

/** Re-centres a window on the view while changing its spans. */
function recentre(win, lonSpan, latSpan, lonMid, latMid) {
  const ls = Math.min(lonSpan, 360);
  const bs = Math.min(latSpan, 180);
  let latMin = latMid - bs / 2;
  if (latMin < -90) latMin = -90;
  if (latMin + bs > 90) latMin = 90 - bs;
  return {
    lonMin: ls >= 360 ? -180 : lonMid - ls / 2,
    lonSpan: ls,
    latMin,
    latSpan: bs,
  };
}

export function padBounds(b, pad) {
  if (b.lonSpan >= 359.99) {
    const latPad = Math.min(b.latSpan * (pad - 1) * 0.5, 20);
    const latMin = clamp(b.latMin - latPad, -90, 90);
    const latMax = clamp(b.latMin + b.latSpan + latPad, -90, 90);
    return { lonMin: -180, lonSpan: 360, latMin, latSpan: latMax - latMin };
  }
  const lonPad = b.lonSpan * (pad - 1) * 0.5;
  const latPad = b.latSpan * (pad - 1) * 0.5;
  const lonSpan = Math.min(b.lonSpan + lonPad * 2, 360);
  const latMin = clamp(b.latMin - latPad, -90, 90);
  const latMax = clamp(b.latMin + b.latSpan + latPad, -90, 90);
  return {
    lonMin: lonSpan >= 360 ? -180 : b.lonMin - lonPad,
    lonSpan,
    latMin,
    latSpan: latMax - latMin,
  };
}

/** Longitude shifts that could bring a feature into the window. */
const OFFSETS = [0, -360, 360];

function overlaps(boxes, i, view, lonMax, latMin) {
  const b = i * 4;
  const minLat = boxes[b + 1];
  const maxLat = boxes[b + 3];
  if (maxLat < latMin || minLat > view.latMax) return null;
  const minLon = boxes[b];
  const maxLon = boxes[b + 2];
  for (let k = 0; k < 3; k++) {
    const off = OFFSETS[k];
    if (maxLon + off >= view.lonMin && minLon + off <= lonMax) return off;
  }
  return null;
}

function strokeLines(ctx, data, view) {
  const { count, offsets, boxes, coords } = data;
  const lonMax = view.lonMin + view.w / view.kx;
  const latMin = view.latMax - view.h / view.ky;
  let drawn = 0;
  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const off = overlaps(boxes, i, view, lonMax, latMin);
    if (off === null) continue;
    const start = offsets[i];
    const end = offsets[i + 1];
    if (end - start < 2) continue;
    for (let p = start; p < end; p++) {
      const x = (coords[p * 2] + off - view.lonMin) * view.kx;
      const y = (view.latMax - coords[p * 2 + 1]) * view.ky;
      if (p === start) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    drawn++;
  }
  ctx.stroke();
  return drawn;
}

function ringPath(ctx, data, i, off, view) {
  const { polyOffsets, ringOffsets, coords } = data;
  const rStart = polyOffsets[i];
  const rEnd = polyOffsets[i + 1];
  for (let r = rStart; r < rEnd; r++) {
    const start = ringOffsets[r];
    const end = ringOffsets[r + 1];
    if (end - start < 3) continue;
    for (let p = start; p < end; p++) {
      const x = (coords[p * 2] + off - view.lonMin) * view.kx;
      const y = (view.latMax - coords[p * 2 + 1]) * view.ky;
      if (p === start) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }
}

function fillPolys(ctx, data, view) {
  if (!data) return 0;
  const lonMax = view.lonMin + view.w / view.kx;
  const latMin = view.latMax - view.h / view.ky;
  let drawn = 0;
  for (let i = 0; i < data.count; i++) {
    const off = overlaps(data.boxes, i, view, lonMax, latMin);
    if (off === null) continue;
    // One path per polygon, filled even-odd, so islands keep their lakes
    // without depending on ring winding being consistent upstream.
    ctx.beginPath();
    ringPath(ctx, data, i, off, view);
    ctx.fill("evenodd");
    drawn++;
  }
  return drawn;
}

function strokePolys(ctx, data, view) {
  if (!data) return 0;
  const lonMax = view.lonMin + view.w / view.kx;
  const latMin = view.latMax - view.h / view.ky;
  let drawn = 0;
  ctx.beginPath();
  for (let i = 0; i < data.count; i++) {
    const off = overlaps(data.boxes, i, view, lonMax, latMin);
    if (off === null) continue;
    ringPath(ctx, data, i, off, view);
    drawn++;
  }
  ctx.stroke();
  return drawn;
}
