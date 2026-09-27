/**
 * Real imagery, streamed in over the painted world.
 *
 * The base texture is a 5400x2700 Blue Marble — fifteen pixels to the degree,
 * which is a beautiful planet and a useless map. Past a region it is all the
 * globe has, so coming in on Bangkok gets you a green smear where a city is.
 *
 * This layer fixes that the way every slippy map does: a quadtree of 256 or
 * 512 pixel tiles, fetched for the ground actually on screen at the zoom
 * actually being used, composited into one canvas and handed to the shader as
 * a second base. What is different here is the projection. Tiles are in Web
 * Mercator; the globe's shader addresses everything by latitude. Rather than
 * resample every tile into equirectangular — which is a reprojection per
 * frame, with seams — the canvas *stays* Mercator and the shader computes the
 * one extra coordinate it needs:
 *
 *   m = 0.5 - ln(tan(pi/4 + lat/2)) / 2pi
 *
 * so each tile lands as an exact, axis-aligned rectangle under drawImage and
 * nothing is resampled at all. The window uniform is in that same normalised
 * Mercator space, and works like the vector window beside it: geographic, so a
 * stale canvas stays pinned to the right ground while the camera moves.
 *
 * Providers are a table, because they are not interchangeable legally. Google
 * Maps Platform forbids its tiles being drawn "with or near a non-Google map",
 * which is exactly what this globe is, so Google is not among them — see the
 * README. Esri's World Imagery is the keyless default so the layer works the
 * moment you load the page; Mapbox and MapTiler are a key away and sharper.
 */
import { CanvasTexture, ClampToEdgeWrapping, LinearFilter, Vector4 } from "three";

import { clamp, DEG } from "./geo.js";

/* --------------------------------------------------------------- providers */

/**
 * `tile` is the pixel size of the image that comes back, which is what sets
 * the zoom the ground is fetched at — not the nominal grid size. Mapbox's @2x
 * satellite is a 256 grid delivering 512 pixels, and that extra density is
 * real: it is one zoom level of sharpness, and the zoom picker has to see it.
 */
export const PROVIDERS = {
  esri: {
    label: "Esri World Imagery",
    url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Imagery: Esri · Maxar · Earthstar Geographics",
    tile: 256,
    maxZoom: 18,
    key: false,
  },
  mapbox: {
    label: "Mapbox Satellite",
    url: "https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90?access_token={key}",
    attribution: "Imagery: Mapbox · Maxar",
    tile: 512,
    maxZoom: 21,
    key: true,
  },
  maptiler: {
    label: "MapTiler Satellite",
    url: "https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key={key}",
    attribution: "Imagery: MapTiler · Airbus",
    tile: 512,
    maxZoom: 20,
    key: true,
  },
};

/* ------------------------------------------------------------------ limits */

/**
 * Tiles fetched for one window.
 *
 * The number to beat is a retina screen at the widest zoom the imagery shows
 * at, which is where the visible cap is largest relative to its resolution:
 * about 90 on a 1200x900 window at dpr 2, and half as many again on a large
 * display. Set too low this does not fail, it quietly drops a zoom level and
 * the ground goes soft — which is the bug it is easiest to ship by accident.
 */
const TILE_BUDGET = 256; // the whole 16x16 canvas MAX_SIDE allows
/** Hard ceiling on the composited canvas, in pixels a side. */
const MAX_SIDE = 4096;
/**
 * Decoded tiles kept in memory, as a byte budget rather than a count: a 512px
 * tile is four times a 256px one, and a count that suits Esri would hold 640MB
 * of Mapbox. 192MB is about three city windows at 256px, so a pull-back — or a
 * return to somewhere visited a minute ago — composites straight from memory.
 * Least recently *used* goes first, not least recently fetched: a place you
 * keep coming back to stays warm however long ago it first loaded.
 */
const DECODED_BUDGET = 192 * 1024 * 1024;
/**
 * The compressed tiles, kept on disk in Cache Storage across reloads and
 * visits. JPEG tiles run 15-40KB, so this is on the order of 150MB — every
 * city someone has looked at in the last good while, already on the device.
 * The HTTP cache would do some of this, but it is shared with the whole web,
 * evicted on its own schedule, and Esri only asks for a day.
 */
const STORE_MAX = 6000;
/** Bump to drop every stored tile, e.g. when a provider changes its imagery. */
const STORE_NAME = "terra-tiles-v1";
/** Requests in flight. Enough to fill a window in one round trip, not so many
 *  that a fast drag queues fifty dead fetches ahead of the ones that matter. */
const MAX_INFLIGHT = 16;
/** How far up the quadtree to look for something to draw while a tile loads. */
const ANCESTORS = 6;
/**
 * How long tile arrivals are gathered before the canvas is redrawn.
 *
 * A recomposite is the whole window — every tile redrawn and the entire canvas
 * re-uploaded to the GPU, which for a retina city view is 23MB a go. Telling
 * the renderer the instant each tile lands therefore costs one full upload per
 * tile: on a fast connection several arrive per frame and the frame loop hides
 * it, but on a slow one they arrive one at a time and eighty-eight tiles turn
 * into eighty-eight uploads — two gigabytes of traffic to draw one city, on
 * exactly the connections least able to afford it.
 *
 * A tenth of a second bounds it at ten redraws a second however the tiles
 * arrive, and is far below the point where the filling-in stops looking
 * continuous.
 */
const COALESCE_MS = 100;
/** Web Mercator stops here; so does this layer. */
const MERC_LIMIT = 85.0511;

const mercN = (lat) => {
  const p = clamp(lat, -MERC_LIMIT, MERC_LIMIT) * DEG;
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + p / 2)) / (2 * Math.PI);
};

/**
 * Opens the tile store, and clears out any older version of it. Resolves to
 * null wherever Cache Storage is missing or refused, and the layer then runs
 * exactly as it did before there was one.
 */
async function openStore() {
  try {
    if (!globalThis.caches) return null;
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith("terra-tiles-") && n !== STORE_NAME).map((n) => caches.delete(n)));
    return await caches.open(STORE_NAME);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------- layer */

export class ImageryLayer {
  /**
   * @param {object} opts
   * @param {string} opts.provider  key into PROVIDERS, or "custom"
   * @param {string} opts.key       API key, for the providers that need one
   * @param {string} opts.url       template, when provider is "custom"
   * @param {number} opts.tile      tile pixel size, when provider is "custom"
   * @param {number} opts.maxZoom   deepest tile zoom, when provider is "custom"
   * @param {Function} opts.onUpdate called when a tile lands and the canvas
   *                                 wants recompositing
   */
  constructor({ provider, key, url, tile, maxZoom, attribution, onUpdate } = {}) {
    const preset = PROVIDERS[provider];
    this.source = url
      ? {
          label: "Custom tiles",
          url,
          attribution: attribution || "",
          tile: tile || 256,
          maxZoom: maxZoom || 19,
          key: url.includes("{key}"),
        }
      : preset || null;

    this.key = key || "";
    this.onUpdate = onUpdate;

    // Off, and silently so: a missing key is a configuration the globe has
    // always run in, not a fault. Everything below no-ops, uMix stays at zero
    // and what draws is exactly the globe that drew before this file existed.
    this.enabled = !!(this.source && (!this.source.key || this.key));
    // Silence is right for "no provider asked for" and wrong for "provider
    // asked for, key forgotten": the globe looks identical in both cases and
    // the second one is a mistake someone is waiting on.
    if (this.source?.key && !this.key) {
      console.warn(
        `[terra] ${this.source.label} needs an API key — set VITE_TILES_KEY. Drawing the painted base only.`,
      );
    }
    this.attribution = this.enabled ? this.source.attribution : "";
    this.label = this.enabled ? this.source.label : "";

    this.canvas = document.createElement("canvas");
    this.canvas.width = this.canvas.height = 2;
    // Alpha, and it is load-bearing: a slot with no tile in it yet stays
    // transparent, the shader multiplies the blend by that alpha, and the
    // painted globe shows through the gap. Without it a half-filled window
    // has to be held back wholesale, and imagery either appears all at once
    // or shows a grid of holes in a colour nothing else on screen is.
    this.ctx = this.canvas.getContext("2d", { alpha: true, willReadFrequently: false });
    this.ctx.imageSmoothingQuality = "high";

    this.texture = new CanvasTexture(this.canvas);
    // Same reason as the vector window: the shader addresses this canvas
    // top-down, from latitude, so three must not flip it on upload.
    this.texture.flipY = false;
    this.texture.minFilter = LinearFilter;
    this.texture.magFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.wrapS = this.texture.wrapT = ClampToEdgeWrapping;
    this.texture.anisotropy = 1;

    /** window in normalised Mercator: (uMin, mMin, uSpan, mSpan) */
    this.window = new Vector4(0, 0, 1, 1);
    /** 0 while nothing has been drawn; the fade in globe.js multiplies it. */
    this.coverage = 0;

    this.cache = new Map();
    this.cacheMax = Math.max(64, Math.floor(DECODED_BUDGET / (this.source?.tile || 256) ** 2 / 4));
    /** Cache Storage, opened once; null where there is none (plain http, some private windows). */
    this.store = this.enabled ? openStore() : Promise.resolve(null);
    this.storeCount = -1;
    this.inflight = new Set();
    this.queue = [];
    this.notify = 0;
    this.rect = null;       // { z, x0, y0, nx, ny } currently composited
    this.dirty = false;
    /**
     * Set when a pass composited the window but was not allowed to ask for
     * what was missing. Without it the layer deadlocks: the rectangle is
     * already the right one, so every later pass returns at the first
     * comparison and the tiles nobody was allowed to request are never
     * requested. It is not `dirty` — that would redraw every tile on every
     * frame of a flight — only permission for one more pass.
     */
    this.pending = false;
    this.stats = { tiles: 0, z: 0, requests: 0, stored: 0, failed: 0, size: "0x0" };
  }

  dispose() {
    clearTimeout(this.notify);
    this.notify = 0;
    this.texture.dispose();
    for (const img of this.cache.values()) img?.close?.();
    this.cache.clear();
    this.queue.length = 0;
  }

  /**
   * Marks the canvas out of date and asks for a redraw — at most once per
   * COALESCE_MS, and always at least once more after the last tile, because
   * the timer is scheduled by the same call that sets the flag.
   */
  #touch() {
    this.dirty = true;
    if (this.notify) return;
    this.notify = setTimeout(() => {
      this.notify = 0;
      this.onUpdate?.();
    }, COALESCE_MS);
  }

  /* ---------------------------------------------------------------- fetch */

  #url(z, x, y) {
    return this.source.url
      .replace("{z}", z)
      .replace("{x}", x)
      .replace("{y}", y)
      .replace("{key}", this.key);
  }

  #request(z, x, y) {
    const id = `${z}/${x}/${y}`;
    if (this.cache.has(id) || this.inflight.has(id)) return;
    if (this.inflight.size >= MAX_INFLIGHT) {
      if (!this.queue.includes(id)) this.queue.push(id);
      return;
    }

    this.inflight.add(id);
    const done = (img) => {
      this.inflight.delete(id);
      // Null rather than absent: a 404 over the ocean is a permanent answer,
      // and re-asking for it on every recomposite is a request storm.
      this.#remember(id, img);
      if (!img) this.stats.failed++;
      this.#drain();
      this.#touch();
    };
    this.#load(z, x, y).then(done, () => done(null));
  }

  /**
   * One tile as a decoded bitmap: from the device if it has been here before,
   * otherwise from the network, keeping a copy on the way past. Decoded with
   * createImageBitmap, off the main thread, so a window of tiles landing does
   * not stall the frame that draws them.
   */
  async #load(z, x, y) {
    // Keyed by provider and tile, never by the URL: that carries the API key,
    // and a rotated key must not orphan every tile already on the device.
    const key = `/__terra-tiles/${this.label.replace(/\W+/g, "-")}/${z}/${x}/${y}`;
    const store = await this.store;
    let blob = null;
    if (store) {
      const hit = await store.match(key).catch(() => null);
      if (hit) {
        blob = await hit.blob();
        this.stats.stored++;
      }
    }
    if (!blob) {
      this.stats.requests++;
      const res = await fetch(this.#url(z, x, y), { mode: "cors", credentials: "omit" });
      if (!res.ok) return null;
      blob = await res.blob();
      if (store) this.#keep(store, key, blob);
    }
    return createImageBitmap(blob);
  }

  /** Writes a tile to the device and, now and then, trims the oldest off. */
  async #keep(store, key, blob) {
    try {
      await store.put(key, new Response(blob, { headers: { "Content-Type": blob.type || "image/jpeg" } }));
      if (this.storeCount < 0) this.storeCount = (await store.keys()).length;
      else this.storeCount++;
      // Trimmed in batches, not one delete per put: listing the keys is the
      // expensive part. Keys come back in insertion order, oldest first.
      if (this.storeCount > STORE_MAX + 200) {
        const keys = await store.keys();
        const drop = keys.slice(0, keys.length - STORE_MAX);
        await Promise.all(drop.map((k) => store.delete(k)));
        this.storeCount = keys.length - drop.length;
      }
    } catch {
      // Quota, or storage switched off mid-session: the tile is still drawn,
      // it just will not be remembered.
    }
  }

  #drain() {
    while (this.queue.length && this.inflight.size < MAX_INFLIGHT) {
      const [z, x, y] = this.queue.shift().split("/").map(Number);
      this.#request(z, x, y);
    }
  }

  #remember(id, img) {
    this.cache.set(id, img);
    if (this.cache.size <= this.cacheMax) return;
    // Map order is recency: #pick moves every tile it draws to the end, so
    // the front is the ground nobody has looked at for longest.
    const drop = this.cache.size - this.cacheMax;
    let n = 0;
    for (const [k, old] of this.cache) {
      if (n++ >= drop) break;
      this.cache.delete(k);
      // A bitmap holds its pixels until closed; drawImage has already copied
      // anything that needed them into the canvas.
      old?.close?.();
    }
  }

  /**
   * The best thing in the cache for one slot: the tile itself, or the part of
   * an ancestor that covers it. This is what makes a fly-in look continuous —
   * the level you are leaving is already decoded, so the new one sharpens over
   * it instead of appearing out of a hole.
   */
  #pick(z, x, y) {
    for (let d = 0; d <= ANCESTORS && z - d >= 0; d++) {
      const id = `${z - d}/${x >> d}/${y >> d}`;
      const img = this.cache.get(id);
      if (!img) continue;
      // Used, so most recent: to the back of the eviction line.
      this.cache.delete(id);
      this.cache.set(id, img);
      const s = 1 << d;
      const sub = (img.naturalWidth || img.width) / s;
      return { img, sx: (x % s) * sub, sy: (y % s) * sub, ss: sub, exact: d === 0 };
    }
    return null;
  }

  /* -------------------------------------------------------------- compose */

  /**
   * Picks the tile zoom that puts one texel on one device pixel.
   *
   * Mercator is conformal, so the scale factor is the same in both directions
   * and one number settles it: a tile row spans `tile * 2^z` pixels across a
   * 360-degree world, and the screen shows `pxPerDeg * cos(lat)` pixels per
   * degree of longitude at the view centre.
   */
  #zoomFor(pxPerDeg, lat) {
    const want = (pxPerDeg * Math.cos(clamp(lat, -MERC_LIMIT, MERC_LIMIT) * DEG) * 360) / this.source.tile;
    return clamp(Math.round(Math.log2(Math.max(want, 1))), 0, this.source.maxZoom);
  }

  /**
   * Fits `bounds` into a tile rectangle, dropping a zoom level at a time until
   * the rectangle is inside the budget. Dropping the level rather than
   * trimming the window is deliberate: softer imagery everywhere reads as
   * imagery still loading, where a window narrower than the screen reads as a
   * rectangle of map with the world missing round it.
   */
  #rectFor(bounds, pxPerDeg, centre) {
    const latMid = centre?.lat ?? bounds.latMin + bounds.latSpan * 0.5;
    const u0 = (bounds.lonMin + 180) / 360;
    const uSpan = Math.min(bounds.lonSpan / 360, 1);
    const mTop = mercN(Math.min(bounds.latMin + bounds.latSpan, MERC_LIMIT));
    const mBot = mercN(Math.max(bounds.latMin, -MERC_LIMIT));

    for (let z = this.#zoomFor(pxPerDeg, latMid); z >= 0; z--) {
      const n = 2 ** z;
      const x0 = Math.floor(u0 * n);
      const nx = Math.min(Math.ceil((u0 + uSpan) * n) - x0, n);
      const y0 = clamp(Math.floor(mTop * n), 0, n - 1);
      const y1 = clamp(Math.ceil(mBot * n) - 1, 0, n - 1);
      const ny = y1 - y0 + 1;
      const side = this.source.tile;
      if (nx * ny <= TILE_BUDGET && nx * side <= MAX_SIDE && ny * side <= MAX_SIDE) {
        return { z, x0, y0, nx, ny, n };
      }
    }
    return null;
  }

  static same(a, b) {
    return !!a && !!b && a.z === b.z && a.x0 === b.x0 && a.y0 === b.y0 && a.nx === b.nx && a.ny === b.ny;
  }

  /**
   * Brings the canvas up to date for the ground on screen. Returns true when
   * the texture changed, which is the caller's cue to redraw.
   */
  update({ bounds, pxPerDeg, centre, fetch = true, force = false } = {}) {
    if (!this.enabled) return false;
    const rect = this.#rectFor(bounds, pxPerDeg, centre);
    if (!rect) return false;

    const moved = !ImageryLayer.same(rect, this.rect);
    if (!moved && !this.dirty && !force && !(fetch && this.pending)) return false;
    // Whatever was queued was queued for ground that is no longer on screen.
    // Ten in flight will finish; the rest would arrive for a view nobody is
    // looking at any more, ahead of the tiles for the one they are.
    if (moved) this.queue.length = 0;

    const side = this.source.tile;
    const w = rect.nx * side;
    const h = rect.ny * side;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.ctx.imageSmoothingQuality = "high";
      // WebGL2 gives a texture immutable storage on first upload, so a resized
      // canvas can never change the allocation it already has — the GPU would
      // keep showing the first window's pixels. Drop it and let three make a
      // new one. (Same trap the vector painter documents.)
      this.texture.dispose();
    }

    // The canvas is addressed geographically, so once the window moves every
    // slot in it means different ground and none of the old pixels are worth
    // keeping. Cleared to transparent rather than to a colour: see above.
    if (moved) this.ctx.clearRect(0, 0, w, h);

    let drawn = 0;
    let exact = 0;
    for (let ty = 0; ty < rect.ny; ty++) {
      for (let tx = 0; tx < rect.nx; tx++) {
        const x = (((rect.x0 + tx) % rect.n) + rect.n) % rect.n;   // wraps at 180
        const y = rect.y0 + ty;
        const hit = this.#pick(rect.z, x, y);
        if (hit) {
          this.ctx.drawImage(hit.img, hit.sx, hit.sy, hit.ss, hit.ss, tx * side, ty * side, side, side);
          drawn++;
          if (hit.exact) exact++;
        }
        if (!hit?.exact && fetch) this.#request(rect.z, x, y);
      }
    }

    this.pending = !fetch && exact < rect.nx * rect.ny;

    const total = rect.nx * rect.ny;
    this.window.set(rect.x0 / rect.n, rect.y0 / rect.n, rect.nx / rect.n, rect.ny / rect.n);
    this.texture.needsUpdate = true;
    this.rect = rect;
    this.dirty = false;
    this.coverage = drawn / total;
    this.stats = {
      ...this.stats,
      tiles: total,
      z: rect.z,
      exact: `${exact}/${total}`,
      size: `${w}x${h}`,
    };
    return true;
  }
}

