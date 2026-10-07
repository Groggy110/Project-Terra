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
const MAX_INFLIGHT = 20;
/**
 * How many levels above the window the backstop sits. Before a single sharp
 * tile is asked for, every slot with nothing this close above it gets the
 * tile two levels up — a sixteenth as many requests — so the whole view is
 * covered, soft, within one round trip, and the sharp tiles then resolve over
 * imagery instead of over holes. It is also all that is fetched while the
 * distance is changing: cheap enough to stream through a fly-in, and it is
 * what makes the zoom read as the ground coming into focus rather than as a
 * grid of squares filling in after the camera stops.
 */
const BACKSTOP = 2;
/**
 * A tile fades over what it replaces instead of appearing. Long enough that
 * a slot sharpening reads as focus, short enough that a window resolving from
 * the centre out is done by the time the eye gets to its edge.
 */
const FADE_MS = 240;
/** Slots re-uploaded per frame while fading; the rest wait a frame. */
const FADE_UPLOADS = 24;
/**
 * A phone fades in steps rather than continuously. Continuous is a slot
 * re-sent on every frame of its fade — fifteen uploads per tile, a hundred
 * megabytes for a city window — and a phone's upload bandwidth is the frame
 * budget a pinch is spent from. Three steps read as the same soft arrival.
 */
const HANDHELD_STEPS = [0.4, 0.75, 1];
const HANDHELD_UPLOADS = 8;
/** Slots of the window whose four children are fetched ahead; see #prefetch. */
const PREFETCH_SLOTS = 9;
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

    /**
     * The mosaic's largest side, the same on a phone. A portrait phone at two
     * texels a point is about 2000 pixels tall before the pad and the snap to
     * whole tiles, so a 2048 cap there dropped every regional window a level —
     * the ground drawn at half the sharpness the screen could show. The tall
     * side is the only one that grows; the canvas stays narrow.
     */
    this.handheld = matchMedia("(pointer: coarse) and (max-width: 1000px)").matches;
    this.maxSide = MAX_SIDE;
    /** Pixels the mosaic may hold: 3072 x 4096 on a phone (48MB), unbounded otherwise. */
    this.maxArea = this.handheld ? 3072 * 4096 : Infinity;
    /** Next-level tiles fetched ahead for the current window; see #prefetch. */
    this.ahead = null;
    this.cache = new Map();
    // A phone gets a third of it. Decoded tiles, the mosaic and the vector
    // canvases all come out of the same few hundred megabytes iOS allows a
    // page, and when it runs short it is the land mask that comes back blank.
    const decoded = this.handheld ? DECODED_BUDGET / 3 : DECODED_BUDGET;
    this.cacheMax = Math.max(64, Math.floor(decoded / (this.source?.tile || 256) ** 2 / 4));
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
    /** Whether the last pass that could fetch was a backstop-only one. */
    this.pendingCoarse = false;
    this.stats = { tiles: 0, z: 0, requests: 0, stored: 0, failed: 0, size: "0x0" };
    /**
     * Per slot of the current rectangle, how many levels up the quadtree the
     * ground drawn in it came from: 0 exact, ANCESTORS + 1 nothing yet. A tile
     * landing only touches the slots it improves on.
     */
    this.slots = new Uint8Array(0);
    /** slot index -> { t0, from }: slots mid-fade, redrawn every frame. */
    this.fades = new Map();
    /** Set by attach(); without it every change is a whole-canvas upload. */
    this.renderer = null;
    /** One slot's worth of canvas, for uploading a slot on its own. */
    this.scratch = document.createElement("canvas");
    this.scratch.width = this.scratch.height = this.source?.tile || 256;
    this.sctx = this.scratch.getContext("2d", { alpha: true });
  }

  /**
   * Hands the layer the renderer, so a tile landing can go to the GPU as that
   * one tile rather than as the whole mosaic. A city window on a phone is an
   * 18MB canvas; re-sending all of it for each 256KB tile is what made the
   * imagery arrive in visible, stuttering steps.
   */
  attach(renderer) {
    this.renderer = renderer;
  }

  dispose() {
    this.fades.clear();
    clearTimeout(this.notify);
    this.notify = 0;
    this.texture.dispose();
    for (const img of this.cache.values()) img?.close?.();
    this.cache.clear();
    this.queue.length = 0;
  }

  /**
   * Asks the globe for a pass — at most once per COALESCE_MS, and always at
   * least once more after the last tile. It no longer marks the canvas dirty:
   * a landing tile is drawn into its own slots by #arrived and fades in from
   * frame(), so nothing here recomposites the window.
   */
  #touch() {
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
      else this.#arrived(z, x, y);
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
    if (!this.inflight.size && !this.queue.length) this.#prefetch();
  }

  /**
   * Once the window is whole and the network is idle, the level below it for
   * the middle of the view — where a pinch goes in. Into memory only: those
   * tiles are not drawn until the window steps down to them, and then they
   * are there on the first frame instead of a round trip later.
   */
  #prefetch() {
    const r = this.rect;
    if (!r || this.ahead === r || r.z >= this.source.maxZoom || !this.slots.every((v) => v === 0)) return;
    this.ahead = r;
    const cx = (r.nx - 1) / 2;
    const cy = (r.ny - 1) / 2;
    const reach = Math.max(1, Math.min(r.nx, r.ny) / 3);
    const order = [];
    for (let i = 0; i < this.slots.length; i++) {
      const t = this.#slotTile(i);
      const dist = Math.hypot(t.tx - cx, t.ty - cy);
      if (dist <= reach) order.push({ t, dist });
    }
    order.sort((a, b) => a.dist - b.dist);
    for (const { t } of order.slice(0, PREFETCH_SLOTS)) {
      for (let k = 0; k < 4; k++) this.#request(r.z + 1, t.x * 2 + (k & 1), t.y * 2 + (k >> 1));
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

  /** The ancestor `d` levels up, cropped to one slot, if it is in memory. */
  #pickAt(z, x, y, d) {
    if (d > ANCESTORS || z - d < 0) return null;
    const img = this.cache.get(`${z - d}/${x >> d}/${y >> d}`);
    if (!img) return null;
    const s = 1 << d;
    const sub = (img.naturalWidth || img.width) / s;
    return { img, sx: (x % s) * sub, sy: (y % s) * sub, ss: sub };
  }

  /** Slot index to tile coordinates in the current rectangle. */
  #slotTile(i) {
    const r = this.rect;
    const tx = i % r.nx;
    const ty = (i - tx) / r.nx;
    return { tx, ty, x: (((r.x0 + tx) % r.n) + r.n) % r.n, y: r.y0 + ty };
  }

  /**
   * A tile has landed. Every slot of the window it improves on starts a fade
   * from whatever that slot was showing; frame() does the drawing. A slot
   * already fading keeps the ground it started from, so a coarse tile and
   * then a sharp one over the same slot read as one continuous sharpening.
   */
  #arrived(z, x, y) {
    const r = this.rect;
    if (!r) return;
    const d = r.z - z;
    if (d < 0 || d > ANCESTORS) return;
    const now = performance.now();
    let changed = false;
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i] <= d) continue;
      const t = this.#slotTile(i);
      if (t.x >> d !== x || t.y >> d !== y) continue;
      const running = this.fades.get(i);
      this.fades.set(i, { t0: now, from: running ? running.from : this.slots[i] });
      this.slots[i] = d;
      changed = true;
    }
    if (!changed) return;
    this.#count();
  }

  /** Coverage and the exact-tile tally, from the slot table. */
  #count() {
    let drawn = 0;
    let exact = 0;
    for (const v of this.slots) {
      if (v <= ANCESTORS) drawn++;
      if (v === 0) exact++;
    }
    this.coverage = drawn / this.slots.length;
    this.stats.exact = `${exact}/${this.slots.length}`;
    return exact;
  }

  /** Paints one slot: the ground it had, and the ground it is getting at `a`. */
  #paintSlot(i, from, a) {
    const side = this.source.tile;
    const t = this.#slotTile(i);
    const dx = t.tx * side;
    const dy = t.ty * side;
    const ctx = this.ctx;
    ctx.clearRect(dx, dy, side, side);
    const z = this.rect.z;
    const under = from <= ANCESTORS ? this.#pickAt(z, t.x, t.y, from) : null;
    const over = this.#pickAt(z, t.x, t.y, this.slots[i]);
    if (under && a < 1) ctx.drawImage(under.img, under.sx, under.sy, under.ss, under.ss, dx, dy, side, side);
    if (over) {
      ctx.globalAlpha = a;
      ctx.drawImage(over.img, over.sx, over.sy, over.ss, over.ss, dx, dy, side, side);
      ctx.globalAlpha = 1;
    }
    return { dx, dy };
  }

  /** The texture's GL handle, once three has uploaded the current canvas. */
  #gpu() {
    const r = this.renderer;
    if (!r) return null;
    const p = r.properties.get(this.texture);
    if (!p.__webglTexture || p.__version !== this.texture.version) return null;
    return p.__webglTexture;
  }

  /** Sends one slot of the canvas to the texture that already holds the rest. */
  #uploadSlot(tex, dx, dy) {
    const side = this.source.tile;
    const gl = this.renderer.getContext();
    this.sctx.clearRect(0, 0, side, side);
    this.sctx.drawImage(this.canvas, dx, dy, side, side, 0, 0, side, side);
    // Through three's state tracker, so its idea of what is bound stays true.
    this.renderer.state.bindTexture(gl.TEXTURE_2D, tex);
    // The same unpack state three uploads this texture with (see the
    // constructor): no flip, straight alpha, no colour conversion.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    if (gl.UNPACK_ROW_LENGTH) {
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, dx, dy, gl.RGBA, gl.UNSIGNED_BYTE, this.scratch);
  }

  /**
   * Advances the fades, once per frame before the draw. Each fading slot is
   * repainted into the canvas and sent up on its own; if the canvas has not
   * been uploaded yet (a window that moved this frame) the slots are painted
   * and ride along with that whole upload instead. Returns true while
   * anything is still fading.
   */
  /** Nothing queued, in flight or still fading in: the window is as sharp as it will get. */
  get idle() {
    return !this.queue.length && !this.inflight.size && !this.fades.size;
  }

  frame(now = performance.now()) {
    if (!this.fades.size || !this.rect) return false;
    const tex = this.#gpu();
    const steps = this.handheld ? HANDHELD_STEPS : null;
    const cap = this.handheld ? HANDHELD_UPLOADS : FADE_UPLOADS;
    let sent = 0;
    for (const [i, f] of this.fades) {
      if (tex && sent >= cap) break;
      const k = Math.min((now - f.t0) / FADE_MS, 1);
      let a = k * k * (3 - 2 * k);
      if (steps) {
        // The highest step reached; nothing to send until the next one.
        let stage = -1;
        while (stage + 1 < steps.length && a >= steps[stage + 1] - 1e-6) stage++;
        if (stage < 0 || stage === f.stage) continue;
        f.stage = stage;
        a = steps[stage];
      }
      const { dx, dy } = this.#paintSlot(i, f.from, a);
      if (tex) this.#uploadSlot(tex, dx, dy);
      sent++;
      if (a >= 1) this.fades.delete(i);
    }
    if (!tex) this.texture.needsUpdate = true;
    return this.fades.size > 0;
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
    // Rounded with a lean toward the sharper level: plain rounding lets a
    // texel cover up to 1.4 pixels, which reads as soft on a retina screen.
    return clamp(Math.round(Math.log2(Math.max(want, 1)) + 0.2), 0, this.source.maxZoom);
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
      if (nx * ny <= TILE_BUDGET && nx * side <= this.maxSide && ny * side <= this.maxSide && nx * ny * side * side <= this.maxArea) {
        return { z, x0, y0, nx, ny, n };
      }
    }
    return null;
  }

  /** Whether the current window is within a level of `rect` and covers it. */
  #serves(rect) {
    const cur = this.rect;
    if (Math.abs(cur.z - rect.z) > 1) return false;
    const span = (r) => [r.x0 / r.n, (r.x0 + r.nx) / r.n, r.y0 / r.n, (r.y0 + r.ny) / r.n];
    const [a0, a1, b0, b1] = span(cur);
    const [c0, c1, d0, d1] = span(rect);
    // The ask is padded (globe.js asks for 1.18 of the view), so a window a
    // little short of it still covers everything on screen.
    const sx = (c1 - c0) * 0.08;
    const sy = (d1 - d0) * 0.08;
    const whole = cur.nx >= cur.n;
    let u0 = c0;
    // Longitude wraps: bring the ask into the window's turn of the world.
    while (u0 < a0 - 0.5) u0 += 1;
    while (u0 > a0 + 0.5) u0 -= 1;
    const u1 = u0 + (c1 - c0);
    const inX = whole || (u0 >= a0 - sx && u1 <= a1 + sx);
    const inY = d0 >= b0 - sy && d1 <= b1 + sy;
    return inX && inY;
  }

  static same(a, b) {
    return !!a && !!b && a.z === b.z && a.x0 === b.x0 && a.y0 === b.y0 && a.nx === b.nx && a.ny === b.ny;
  }

  /**
   * Brings the canvas up to date for the ground on screen. Returns true when
   * the texture changed, which is the caller's cue to redraw.
   *
   * `fetch: false` asks for nothing; `coarse` asks only for the backstop
   * level, which is what the globe does while the distance is changing.
   */
  update({ bounds, pxPerDeg, centre, fetch = true, coarse = false, force = false, lazy = false } = {}) {
    if (!this.enabled) return false;
    let rect = this.#rectFor(bounds, pxPerDeg, centre);
    if (!rect) return false;

    // Mid-gesture, the window only moves once the one on the GPU has plainly
    // stopped serving: a level out, or no longer over the ground asked for.
    // Moving it is a whole-canvas upload, which is the frame a pinch drops.
    // Otherwise it stays, the view is a little soft or a little sharp for a
    // moment, and the move happens once the hand comes off.
    if (lazy && this.rect && !this.dirty && !force && this.#serves(rect)) return false;
    // And when it has to move mid-gesture, it moves further than asked: half
    // again the ground, a level softer, so the same canvas keeps serving
    // through the rest of the pinch instead of being re-sent at every level.
    // The sharp window comes once the camera stops (the settle pass).
    if (lazy) {
      const k = 1.5;
      const wide = {
        lonMin: bounds.lonMin - (bounds.lonSpan * (k - 1)) / 2,
        lonSpan: Math.min(bounds.lonSpan * k, 360),
        latMin: Math.max(bounds.latMin - (bounds.latSpan * (k - 1)) / 2, -90),
        latSpan: Math.min(bounds.latSpan * k, 180),
      };
      rect = this.#rectFor(wide, pxPerDeg * 0.5, centre) ?? rect;
    }

    const moved = !ImageryLayer.same(rect, this.rect);
    const wantsFetch = fetch && (this.pending || this.pendingCoarse !== coarse);
    if (!moved && !this.dirty && !force && !wantsFetch) return false;
    // Whatever was queued was queued for ground that is no longer on screen.
    // Ten in flight will finish; the rest would arrive for a view nobody is
    // looking at any more, ahead of the tiles for the one they are.
    if (moved) this.queue.length = 0;

    const side = this.source.tile;
    const w = rect.nx * side;
    const h = rect.ny * side;
    const total = rect.nx * rect.ny;
    let changed = false;

    if (moved || this.dirty || force) {
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
        this.ctx.imageSmoothingQuality = "high";
        // WebGL2 gives a texture immutable storage on first upload, so a
        // resized canvas can never change the allocation it already has — the
        // GPU would keep showing the first window's pixels. Drop it and let
        // three make a new one. (Same trap the vector painter documents.)
        this.texture.dispose();
      }
      // The canvas is addressed geographically, so once the window moves
      // every slot in it means different ground and none of the old pixels
      // are worth keeping. Cleared to transparent rather than to a colour:
      // see the constructor.
      this.ctx.clearRect(0, 0, w, h);
      this.rect = rect;
      this.slots = new Uint8Array(total).fill(ANCESTORS + 1);
      this.fades.clear();
      for (let i = 0; i < total; i++) {
        const t = this.#slotTile(i);
        const hit = this.#pick(rect.z, t.x, t.y);
        if (!hit) continue;
        this.ctx.drawImage(hit.img, hit.sx, hit.sy, hit.ss, hit.ss, t.tx * side, t.ty * side, side, side);
        this.slots[i] = Math.round(Math.log2((hit.img.naturalWidth || hit.img.width) / hit.ss));
      }
      this.window.set(rect.x0 / rect.n, rect.y0 / rect.n, rect.nx / rect.n, rect.ny / rect.n);
      this.texture.needsUpdate = true;
      this.dirty = false;
      changed = true;
    }

    const exact = this.#count();

    if (fetch) this.#requestWindow(rect, centre, coarse);
    this.pending = (!fetch || coarse) && exact < total;
    this.pendingCoarse = fetch ? coarse : this.pendingCoarse;

    this.stats = {
      ...this.stats,
      tiles: total,
      z: rect.z,
      size: `${w}x${h}`,
    };
    return changed;
  }

  /**
   * Asks for what the window is missing, in the order it should arrive: the
   * backstop first, so every slot has *something* within one round trip, then
   * the sharp tiles from the centre of the view outward — the place being
   * looked at resolves first, and the filling-in spreads from it instead of
   * sweeping down the screen in rows.
   */
  #requestWindow(rect, centre, coarse) {
    const cu = ((((centre?.lon ?? 0) + 180) / 360) * rect.n - rect.x0 + rect.n) % rect.n;
    const cm = mercN(centre?.lat ?? 0) * rect.n - rect.y0;
    const order = [];
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i] === 0) continue;
      const t = this.#slotTile(i);
      order.push({ i, t, dist: Math.hypot(t.tx + 0.5 - cu, t.ty + 0.5 - cm) });
    }
    order.sort((a, b) => a.dist - b.dist);
    const up = Math.min(BACKSTOP, rect.z);
    if (up > 0) {
      for (const { i, t } of order) {
        if (this.slots[i] > up) this.#request(rect.z - up, t.x >> up, t.y >> up);
      }
    }
    if (coarse) return;
    for (const { t } of order) this.#request(rect.z, t.x, t.y);
  }
}
