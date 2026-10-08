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

import { boundsContain, clamp, DEG, wrapDelta } from "./geo.js";
import { STYLE } from "../style/styleConfig.js";
import { fadeFor, loadSet, paintLines, paintMask } from "./vectorRaster.js";

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
      const set = await loadSet(this.base, scale);
      this.scales.set(scale, set);
      this.pending.delete(scale);
      return set;
    })();

    this.pending.set(scale, job);
    return job;
  }
}

/* ----------------------------------------------------------------- styles */

/**
 * The ink for a theme: STYLE.themes[theme].lines, with each colour turned into
 * the "r,g,b" the stroke styles are assembled from. Against the night sky the
 * coast is drawn as shallow water rather than as an outline, which is why the
 * dark theme's ink is a faint turquoise.
 */
function inkFor(theme) {
  const lines = (STYLE.themes[theme] || STYLE.themes.dark).lines;
  const out = {};
  for (const [key, s] of Object.entries(lines)) {
    const n = parseInt(s.color.slice(1), 16);
    out[key] = { color: `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`, width: s.width, alpha: s.alpha };
  }
  return out;
}

/* ---------------------------------------------------------------- painter */

export class VectorPainter {
  constructor(store, { budget = TEXEL_BUDGET } = {}) {
    this.store = store;
    /** Texels a window may hold; a phone asks for fewer (see Globe). */
    this.budget = budget;
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
    // Premultiplied, from the page's canvas and the worker's bitmaps alike
    // (earth.frag divides it back out), so both paths upload the same texels.
    this.lineTexture.premultiplyAlpha = true;
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
    this.theme = "dark";
    this.stats = { paints: 0, lastMs: 0, size: "0x0", features: 0 };

    // Every paint after the first is made in a worker (vectorWorker.js) where
    // the browser can draw into a canvas off the page; the first is made here,
    // so the planet's first frame has its land and coast already in place.
    this.gen = 0;
    this.everPainted = false;
    this.inFlight = null;
    this.jobs = 0;
    /** Called once a worker paint has been swapped in. */
    this.onPaint = null;
    try {
      if (typeof OffscreenCanvas === "function" && typeof createImageBitmap === "function") {
        this.worker = new Worker(new URL("./vectorWorker.js", import.meta.url), { type: "module" });
        this.worker.onmessage = (e) => this.#landed(e.data);
        this.worker.onerror = () => {
          // Painted here again from now on: slower, but never blank.
          this.worker = null;
          this.inFlight = null;
        };
      }
    } catch {
      this.worker = null;
    }
  }

  /**
   * The window painted, or null when it must be painted again. Setting it to
   * null (a theme, a resolution, a finer set) also voids any worker paint
   * already under way, which was planned for what is now out of date.
   */
  get painted() {
    return this._painted ?? null;
  }

  set painted(v) {
    if (v === null) this.gen++;
    this._painted = v;
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

  /**
   * `loose` is the test for the middle of a gesture on a phone: repaint only
   * once the window is plainly wrong — magnified past twice its density, or
   * the centre a fifth of the way to its edge. Each repaint there is a
   * rasterisation and two full-canvas uploads, which is exactly the frame a
   * pinch drops; a line a little soft for half a second is not.
   */
  needsRepaint(bounds, pxPerDeg, centre, { loose = false, quality = 1 } = {}) {
    if (!this.painted) return true;
    // paintedDensity is the density actually rasterised, so a coarse paint
    // taken during motion still reads as out of date once the camera settles.
    // Mid-gesture it is measured against the coarse density a motion paint
    // would use — against full density every motion paint read as 2.5 times
    // too soft the moment it landed, and repainted itself every 110ms.
    const ratio = (pxPerDeg * quality) / (this.paintedDensity || 1e-6);
    if (loose ? ratio > 2.2 || ratio < 0.4 : ratio > 1.4 || ratio < 0.45) return true;
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
    const at = loose ? RECENTRE_AT * 2.5 : RECENTRE_AT;
    return dLon > this.painted.lonSpan * at || dLat > this.painted.latSpan * at;
  }

  /**
   * Paints the coarse world tier. Always 1:50m: it exists to fill the
   * foreshortened edge, so finer data there would cost time for pixels no one
   * can resolve. Repainted only when the theme changes.
   */
  repaintBase(theme = "dark") {
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
    paintLines(this.baseCtx, set, view, inkFor(theme), BASE_FADE, 1);
    this.baseTexture.needsUpdate = true;
    this.baseTheme = theme;
    return true;
  }

  /**
   * Rasterises `bounds` at one texel per device pixel of `pxPerDeg`. If that
   * exceeds the budget the window narrows - longitude first, since longitude
   * is what the limb crushes - rather than dropping resolution.
   *
   * Once there is a window on the globe, the paint goes to the worker and this
   * returns at once: true when it was sent, false while one is still being
   * painted (the caller simply asks again next pass). The new window replaces
   * the old one when it lands (#landed), ink, mask and window in one step.
   */
  repaint(bounds, pxPerDeg, { theme = "dark", quality = 1, pad = 1.28, centre } = {}) {
    const scale = VectorPainter.scaleFor(pxPerDeg);
    const set = this.store.get(scale) || this.store.get("50m");
    if (!set) return false;
    const plan = this.#plan(bounds, pxPerDeg, { quality, pad, centre });
    plan.scale = this.store.get(scale) ? scale : "50m";
    plan.theme = theme;
    const style = inkFor(theme);
    const fade = fadeFor(pxPerDeg);

    if (this.worker && this.everPainted) {
      if (this.inFlight) return false;
      const id = ++this.jobs;
      this.inFlight = { id, gen: this.gen, plan, t0: performance.now() };
      this.worker.postMessage({
        id,
        base: this.store.base,
        scale: plan.scale,
        view: plan.view,
        style,
        fade,
        texelPerPx: plan.texelPerPx,
      });
      return true;
    }

    const t0 = performance.now();
    const { w, h } = plan.view;
    if (this.lines.width !== w || this.lines.height !== h) {
      this.lines.width = this.mask.width = w;
      this.lines.height = this.mask.height = h;
    }
    let features = paintMask(this.maskCtx, set, plan.view);
    features += paintLines(this.lineCtx, set, plan.view, style, fade, plan.texelPerPx);
    this.#swap(this.lineTexture, this.lines);
    this.#swap(this.maskTexture, this.mask);
    this.#commit(plan, features, performance.now() - t0);
    return true;
  }

  /** The window, canvas size and texel scale for a paint. */
  #plan(bounds, pxPerDeg, { quality, pad, centre }) {
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
    if (w * h > this.budget) {
      const fitW = this.budget / h;
      if (fitW >= MIN_SIDE) {
        w = fitW;
      } else {
        w = MIN_SIDE;
        h = this.budget / MIN_SIDE;
      }
      win = recentre(win, w / (density * cosLat), h / density, lonMid, latMid);
    }

    // Quantise the sides, then re-derive the window so the canvas is filled
    // exactly at 1:1. Rounding the window to the canvas rather than the canvas
    // to the window is what keeps reallocations rare.
    w = clamp(Math.min(Math.ceil(w / QUANT) * QUANT, MAX_SIDE), MIN_SIDE, MAX_SIDE);
    h = clamp(Math.min(Math.ceil(h / QUANT) * QUANT, MAX_SIDE), MIN_SIDE / 2, MAX_SIDE);
    win = recentre(win, w / (density * cosLat), h / density, lonMid, latMid);

    const view = {
      lonMin: win.lonMin,
      latMax: win.latMin + win.latSpan,
      kx: w / win.lonSpan,
      ky: h / win.latSpan,
      w,
      h,
    };
    const texelPerPx = (w / (win.lonSpan * density * cosLat) + h / (win.latSpan * density)) * 0.5;
    return { win, view, texelPerPx, density, quality, centre: { lat: latMid, lon: lonMid } };
  }

  /** A worker paint arriving: swapped in, unless it was voided on the way. */
  #landed(msg) {
    const job = this.inFlight;
    if (!job || job.id !== msg.id) {
      msg.lines?.close();
      msg.mask?.close();
      return;
    }
    this.inFlight = null;
    if (msg.error || job.gen !== this.gen) {
      msg.lines?.close();
      msg.mask?.close();
      if (msg.error) console.warn(`[terra] vector paint failed: ${msg.error}`);
      return;
    }
    this.#swap(this.lineTexture, msg.lines);
    this.#swap(this.maskTexture, msg.mask);
    // Its own drawing time, not the round trip: the page reads it to judge
    // how coarse a paint mid-gesture should be.
    this.#commit(job.plan, msg.features, msg.ms);
    this.onPaint?.();
  }

  /**
   * Points a texture at a new picture. In WebGL2 three allocates immutable
   * storage for a texture on its first upload (texStorage2D) and thereafter
   * only writes into it with texSubImage2D, so a picture of another size
   * needs the GPU texture dropped and allocated afresh — otherwise later
   * paints would keep uploading into the first window's allocation.
   */
  #swap(tex, image) {
    const old = tex.image;
    if (!old || old.width !== image.width || old.height !== image.height) tex.dispose();
    tex.image = image;
    tex.needsUpdate = true;
    // A bitmap that has been replaced is never drawn again; its memory goes now.
    if (old !== image && typeof ImageBitmap !== "undefined" && old instanceof ImageBitmap) old.close();
  }

  #commit(plan, features, ms) {
    const { win } = plan;
    this.window.set(
      (win.lonMin + 180) / 360,
      0.5 - (win.latMin + win.latSpan) / 180,
      win.lonSpan / 360,
      win.latSpan / 180,
    );
    this._painted = win;
    this.everPainted = true;
    this.paintedCentre = plan.centre;
    this.paintedDensity = plan.density;
    this.scale = plan.scale;
    this.theme = plan.theme;
    this.paintedQuality = plan.quality;
    this.stats = {
      paints: this.stats.paints + 1,
      lastMs: Math.round(ms * 10) / 10,
      size: `${plan.view.w}x${plan.view.h}`,
      features,
      scale: plan.scale,
    };
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

