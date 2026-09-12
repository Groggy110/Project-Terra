/**
 * Owns the WebGL side: renderer, camera, the three drawn objects, the vector
 * repaint schedule and the label layer.
 *
 * Repaint policy - the part worth knowing - is in #serviceVectors(): the
 * painted window is padded, so ordinary nudges reuse it; a coarse repaint runs
 * during motion, and a full-resolution one lands shortly after the camera
 * settles.
 */
import { PerspectiveCamera, Scene, TextureLoader, Vector2, Vector3, WebGLRenderer } from "three";

import { applyTheme, createClouds, createEarth, createHalo, THEMES } from "./earth.js";
import { clamp, DEG, lerp, smoothstep, viewBounds, visibleCapRadius, visibleExtent } from "./geo.js";
import { DIST_FAR, GlobeControls, distForZoom, zoomLevel } from "./controls.js";
import { LabelLayer } from "./labels.js";
import { VectorPainter, VectorStore } from "./vectors.js";

const TEXTURES = [
  ["base", "/textures/blue-marble.jpg"],
  ["aux", "/textures/earth-aux.png"],
  ["clouds", "/textures/clouds.jpg"],
];

const SETTLE_MS = 130;
const MOTION_PAINT_MS = 110;
/**
 * Floor between full-resolution repaints. needsRepaint already declines the
 * ones that would redraw the same ground, so this almost never binds; it is
 * here so that no sequence of camera states can put two heavy rasterisations
 * on consecutive frames.
 */
const SETTLED_PAINT_MS = 220;

/**
 * There is one camera move in the entrance, and it is the second one.
 *
 * The world does not fly in: it simply fades up at HOME, the whole globe, with
 * the headline over it. A flight in *and then* a flight down read as two
 * loading animations queued behind each other, and the first one is the one
 * doing no work — you cannot see the globe well enough during it to be told
 * anything.
 *
 * The move that is left is the settle: the words lift away, the find bar rides
 * up into the top bar, the panel comes in, and the camera goes down to WORK,
 * which frames Europe, Africa and the near East — the densest part of the
 * network, and close enough to letter every pin in it. All of it on one beat.
 * The chrome led the camera by a beat once, and what that actually bought was
 * a globe that sat still while the bar moved and only started once the bar
 * had stopped — two moves in sequence, and the second one looking like a
 * reaction to the first. They are one move.
 *
 * The idle drift is held off for all of that. A world already turning when the
 * page opens has nothing left to give the settle — the arrival has to be the
 * moment the globe *starts*, so the entrance is one gesture: it stands still,
 * the bar goes up, and then it turns eastward and comes in, decelerating into
 * the drift it keeps thereafter rather than stopping and starting again.
 */
const HOME = { lat: 14, lon: -52 };
export const WORK = { lat: 17, lon: 20, dist: 3.05 };
export const SETTLE_FLIGHT_MS = 1700;

export class Globe {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.theme = "light";
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.size = { w: 1, h: 1 };
    this.drift = 0;
    this.last = 0;
    this.idleFrames = 0;
    this.dirty = true;
    this.lastPaint = 0;
    this.settleTimer = 0;
    this.requesting = new Set();
    this.sunView = new Vector3(-0.3, 0.42, 0.86).normalize();
    this.sunWorld = new Vector3();
    this.bufferSize = new Vector2();
    this.running = false;

    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
      stencil: false,
    });
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new Scene();
    this.camera = new PerspectiveCamera(32, 1, 0.005, 60);

    this.controls = new GlobeControls(canvas, this.camera, {
      onFirstGesture: opts.onFirstGesture,
    });

    this.store = new VectorStore();
    this.painter = new VectorPainter(this.store);
    this.labels = new LabelLayer(opts.overlay, {
      onPinClick: opts.onPinClick,
      onPinHover: opts.onPinHover,
    });

    canvas.addEventListener("click", (e) => {
      if (this.controls.moved) return;
      this.opts.onGlobeClick?.(this.controls.pointAt(e));
    });
  }

  /* ----------------------------------------------------------------- boot */

  async start() {
    const report = this.opts.onProgress || (() => {});
    let done = 0;
    const total = TEXTURES.length + 3;
    const step = (label) => report(++done / total, label);

    const loader = new TextureLoader();
    const load = (url) =>
      new Promise((resolve, reject) => loader.load(url, resolve, undefined, () => reject(new Error(url))));

    const textures = {};
    for (const [key, url] of TEXTURES) {
      textures[key] = await load(url);
      step(key === "base" ? "imagery" : key === "aux" ? "topography" : "cloud sheet");
    }

    this.earth = createEarth({
      ...textures,
      lines: this.painter.lineTexture,
      mask: this.painter.maskTexture,
      baseInk: this.painter.baseTexture,
      window: this.painter.window,
    });
    this.clouds = createClouds(textures);
    this.halo = createHalo();
    this.scene.add(this.earth.mesh, this.clouds.mesh, this.halo.mesh);
    this.setTheme(this.theme);

    await this.store.load("50m");
    this.painter.repaintBase(this.theme);
    step("vectors");

    const [places, countries] = await Promise.all([
      fetch("/vectors/places.json").then((r) => r.json()),
      fetch("/vectors/countries.json").then((r) => r.json()),
    ]);
    this.places = places;
    this.countries = countries;
    this.labels.setData({ places, countries, ministries: this.ministries || [] });
    step("places");

    this.#resize();
    this.observer = new ResizeObserver(() => this.#resize());
    this.observer.observe(this.canvas);
    window.addEventListener("orientationchange", () => this.#resize());

    // One full paint at HOME before anything is shown, so what fades up is the
    // finished globe rather than a bare sphere filling itself in. Held still
    // with it: the drift is the settle's to start, not the loading screen's.
    this.controls.holdSpin(true);
    this.controls.lat = HOME.lat;
    this.controls.lon = HOME.lon;
    this.controls.dist = DIST_FAR;
    this.controls.target = { ...HOME, dist: DIST_FAR };
    this.controls.update(0.016);
    this.#serviceVectors(true);
    this.renderer.render(this.scene, this.camera);
    step("gathering the network");

    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this.#tick);
    return this;
  }

  /* ------------------------------------------------------------------ api */

  setTheme(name) {
    this.theme = THEMES[name] ? name : "light";
    const t = applyTheme(this.theme, this.earth, this.clouds, this.halo);
    this.cloudBase = t.clouds.opacity;
    this.sunView.set(...t.sunView).normalize();
    this.painter.painted = null; // line colours changed, so force a repaint
    this.painter.repaintBase(this.theme);
    this.dirty = true;
  }

  setMinistries(list) {
    this.ministries = list;
    this.labels.setData({
      ministries: list,
      places: this.places || [],
      countries: this.countries || [],
    });
    this.dirty = true;
  }

  /** Chrome rectangles that labels must avoid. */
  setReserved(rects) {
    this.labels.setReserved(rects);
    this.dirty = true;
  }

  setDimmed(ids) {
    this.labels.setDimmed(ids);
    this.dirty = true;
  }

  select(id) {
    this.labels.setSelected(id);
    this.dirty = true;
  }

  /** Frames a ministry: close enough to read its city, not so close it floats. */
  focus(target, { zoom = 0.62, ms } = {}) {
    if (!target) return;
    const from = this.controls.zoom;
    const hop = this.controls.angleTo(target.lat, target.lon);
    this.controls.flyTo({
      lat: target.lat,
      lon: target.lon,
      dist: distForZoom(Math.max(zoom, from)),
      ms: ms ?? clamp(700 + hop * 6, 700, 1750),
    });
  }

  flyTo(args) {
    this.controls.flyTo(args);
  }

  zoomBy(factor) {
    this.controls.zoomBy(factor);
  }

  reset() {
    this.controls.reset();
    this.labels.setSelected(null);
  }

  /** Pauses or resumes the idle drift. */
  setSpin(on) {
    this.controls.setSpin(on);
  }

  /**
   * Lifts the entrance's hold on the drift. The page calls it the moment the
   * hero retires, however it retires — the hold is there to keep the opening
   * frame still, and someone who has just grabbed the globe has ended that
   * frame as surely as the timer would have.
   */
  releaseSpin() {
    this.controls.holdSpin(false);
  }

  /**
   * The camera half of settling: down from the whole globe to the working
   * view. Silent, because the page decided to do it — counting it as a
   * gesture would retire the hint that has not been earned yet.
   */
  settle(ms = SETTLE_FLIGHT_MS) {
    // No arc. A long hop normally lifts away from the surface and settles
    // back, which reads well between two places at the same height; on a
    // descent it puts a small rise at the front, and a page that has just
    // finished arriving cannot afford anything that looks like a second move.
    //
    // HOME to WORK is seventy-odd degrees eastward, which is the same
    // direction the drift turns: spinInto hands the tail of that straight to
    // the drift, so the world comes in turning and simply keeps turning.
    this.controls.holdSpin(false);
    this.controls.flyTo({ ...WORK, ms, silent: true, arc: 0, spinInto: true, ease: "quad" });
  }

  get zoom() {
    return this.controls.zoom;
  }

  /**
   * Renders one shader channel instead of the graded surface. Handy when the
   * question is "is this the mask or the grade?".
   * 1 mask · 2 window · 3 ink · 4 land · 5 sea · 6 hillshade · 7 topo · 8 lum/chroma/snow
   */
  debug(channel = 0) {
    this.earth.uniforms.uDebug.value = channel;
    // The sheet and the halo sit over the surface; they would only obscure
    // whatever channel is being inspected.
    this.clouds.mesh.visible = !channel;
    this.halo.mesh.visible = !channel;
    this.dirty = true;
    return channel;
  }

  stats() {
    return {
      ...this.painter.stats,
      renderer: this.renderer.capabilities.isWebGL2 ? "WebGL2" : "WebGL",
      dpr: this.dpr,
      triangles: this.renderer.info.render.triangles,
    };
  }

  /* --------------------------------------------------------------- render */

  #resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    if (w === this.size.w && h === this.size.h) return;
    this.size = { w, h };
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
    this.controls.setViewport(w, h);
    this.painter.painted = null;
    this.dirty = true;
  }

  #bounds() {
    const dist = this.controls.dist;
    const cap = visibleCapRadius(dist, this.camera.fov, this.camera.aspect);
    const extent = visibleExtent(dist, this.camera.fov, this.camera.aspect);
    return { cap, bounds: viewBounds(this.controls.lat, this.controls.lon, extent, 1.02) };
  }

  #serviceVectors(immediate = false) {
    const { bounds } = this.#bounds();
    const ppd = this.controls.pxPerDeg * this.dpr;
    const centre = { lat: this.controls.lat, lon: this.controls.lon };

    // Pull the finer set in as soon as it would show, then keep drawing with
    // whatever is already in memory until it lands.
    const want = VectorPainter.scaleFor(ppd);
    if (!this.store.get(want) && !this.requesting.has(want)) {
      this.requesting.add(want);
      this.store.load(want).then(
        () => {
          this.painter.painted = null;
          this.dirty = true;
        },
        () => this.requesting.delete(want),
      );
    }

    if (!this.painter.needsRepaint(bounds, ppd, centre)) return;

    const now = performance.now();
    // The idle drift moves the camera every frame, so idleFrames never rises
    // and the coarse motion paint would become permanent — the coastline would
    // simply be blunt for as long as nobody touched the globe. Drift is slow
    // enough to paint at full resolution instead, and a wider pad buys enough
    // longitude ahead of the turn that a repaint lands every few seconds.
    const drifting = this.controls.spinning && !this.controls.dragging;
    const moving = !immediate && !drifting && (this.controls.dragging || this.idleFrames < 2);
    if (moving) {
      if (now - this.lastPaint < MOTION_PAINT_MS) return;
      const quality = this.painter.stats.lastMs > 26 ? 0.4 : 0.6;
      if (this.painter.repaint(bounds, ppd, { theme: this.theme, quality, pad: 1.34, centre })) {
        this.lastPaint = now;
        this.earth.uniforms.uHasWindow.value = 1;
      }
      return;
    }

    if (!immediate && now - this.lastPaint < SETTLED_PAINT_MS) return;

    if (
      this.painter.repaint(bounds, ppd, {
        theme: this.theme,
        quality: 1,
        pad: drifting ? 1.5 : 1.18,
        centre,
      })
    ) {
      this.lastPaint = now;
      this.earth.uniforms.uHasWindow.value = 1;
    }
  }

  #updateHalo() {
    const u = this.halo.uniforms;
    const buffer = this.renderer.getDrawingBufferSize(this.bufferSize);
    u.uResolution.value.set(buffer.x, buffer.y);
    u.uCentre.value.set(buffer.x * 0.5, buffer.y * 0.5);
    const limb = Math.asin(clamp(1 / this.controls.dist, -1, 1));
    const half = Math.tan(this.camera.fov * DEG * 0.5);
    u.uRadius.value = (buffer.y * 0.5) * (Math.tan(limb) / half);
  }

  #tick = (now) => {
    if (!this.running) return;
    requestAnimationFrame(this.#tick);

    const dt = Math.min((now - this.last) / 1000, 0.05);
    this.last = now;

    const moved = this.controls.update(dt);
    if (moved) {
      this.idleFrames = 0;
      this.settleTimer = 0;
    } else {
      this.idleFrames++;
      this.settleTimer += dt * 1000;
    }

    // The sheet is a fair-weather cloud layer: it thins as you come in so the
    // ground stays readable, and drifts slowly enough to notice only if you
    // stop and look.
    this.drift = (this.drift + dt * 0.00042) % 1;
    const z = this.controls.zoom;
    const c = this.clouds.uniforms;
    c.uDrift.value = this.drift;
    c.uOpacity.value = lerp(this.cloudBase, this.cloudBase * 0.2, smoothstep(0.12, 0.86, z));
    this.sunWorld.copy(this.sunView).applyQuaternion(this.camera.quaternion);
    this.earth.uniforms.uSun.value.copy(this.sunWorld);
    c.uSun.value.copy(this.sunWorld);

    if (moved || this.dirty || this.idleFrames < 3) {
      const { cap } = this.#bounds();
      this.#updateHalo();
      this.labels.update({
        camera: this.camera,
        controls: this.controls,
        width: this.size.w,
        height: this.size.h,
        capRadius: cap,
      });
      this.#serviceVectors();
      this.opts.onCamera?.(z, this.controls);
      this.dirty = false;
    } else if (this.settleTimer > SETTLE_MS && this.settleTimer < SETTLE_MS + 400) {
      this.settleTimer = SETTLE_MS + 500;
      this.#serviceVectors(true);
    }

    this.renderer.render(this.scene, this.camera);
  };
}

export { distForZoom, zoomLevel };
