/**
 * Owns the WebGL side: renderer, camera, the three drawn objects, the vector
 * repaint schedule and the label layer.
 *
 * Repaint policy - the part worth knowing - is in #serviceVectors(): the
 * painted window is padded, so ordinary nudges reuse it; a coarse repaint runs
 * during motion, and a full-resolution one lands shortly after the camera
 * settles.
 */
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  CineonToneMapping,
  LinearSRGBColorSpace,
  LinearToneMapping,
  Matrix4,
  NeutralToneMapping,
  NoToneMapping,
  PerspectiveCamera,
  Quaternion,
  ReinhardToneMapping,
  RepeatWrapping,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";

import {
  angleVector,
  applyTheme,
  BLACK,
  createClouds,
  createEarth,
  createEffectUniforms,
  createGradeUniforms,
  createHalo,
  createPost,
  prepare,
  sphere,
} from "./earth.js";
import { paintNightLights } from "./nightlights.js";
import { PostChain } from "./postchain.js";
import { clamp, DEG, latLonToVec3, lerp, smoothstep, viewBounds, visibleCapRadius, visibleExtent } from "./geo.js";
import { GlobeControls, distForZoom, zoomLevel } from "./controls.js";
import { ImageryLayer } from "./imagery.js";
import { pickResolution, RES_STEPS, RES_WINDOW, RES_HOLD_MS } from "./resolution.js";
import { LabelLayer } from "./labels.js";
import { padBounds, VectorPainter, VectorStore } from "./vectors.js";
import { STYLE } from "../style/styleConfig.js";
import { onStyle } from "../style/applyStyle.js";

const TONE_MAPPING = {
  None: NoToneMapping,
  Linear: LinearToneMapping,
  Reinhard: ReinhardToneMapping,
  Cineon: CineonToneMapping,
  ACESFilmic: ACESFilmicToneMapping,
  AgX: AgXToneMapping,
  Neutral: NeutralToneMapping,
};

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
 * Where streamed imagery takes over from the painted planet.
 *
 * Blue Marble is 5400 pixels round, which is fifteen to the degree. The
 * working view already shows twenty-two, and a ministry opened at zoom 0.62
 * shows thirty-three — so from about a third of the way in, every extra step
 * of zoom is magnifying a texel rather than revealing anything, and that is
 * exactly what the green smear over Bangkok was.
 *
 * It starts a little before the crossing and finishes well after it, because
 * this is a handover and not a switch: the painted globe is the *identity* of
 * the map at any distance where you can see it is a globe, and it should still
 * be doing most of the work at the point where the tiles first help.
 */
const DETAIL_IN = [0.25, 0.44];
/** Tiles are fetched a beat before they are shown, so the fade has them. */
const DETAIL_ARM = 0.2;
/** Time constant of the fade. Long: imagery should arrive, not appear. */
const DETAIL_TAU = 0.28;
/** Floor between tile windows while the camera is moving. */
const DETAIL_MOTION_MS = 260;


/**
 * There is one camera move in the entrance, and it is the second one.
 * (HOME and WORK are STYLE.camera.home and STYLE.camera.work.)
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
 *
 * The descent is what makes the map a map. HOME is the whole disc against
 * black, which is the picture; WORK is near enough that the pins carry their
 * cities, which is the product. A settle that stayed at HOME looked better in
 * a screenshot and told you nothing — the dots were too small to read as
 * anything but grain. Lettering starts just above zoom 0.07 (labels.js), and
 * WORK sits at about 0.13.
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

export class Globe {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.theme = "dark";
    this.dpr = Math.min(window.devicePixelRatio || 1, STYLE.renderer.maxPixelRatio);
    /**
     * Fraction of `dpr` actually being drawn; see resolution.js.
     *
     * Touch devices start one step down rather than at full. The scaler needs
     * about a second of frames before it will act on anything, and the second
     * it needs is the worst one there is — the page has just opened on the
     * whole globe, which is the view where the faceting is at full strength,
     * and the first thing anyone does is drag it. Starting conservatively
     * makes that first second cheap; a phone that can afford more has earned
     * it back before anyone has finished looking at Africa.
     */
    const coarse = window.matchMedia?.("(hover: none) and (pointer: coarse)").matches;
    this.res = coarse && this.dpr > 1 ? 0.85 : 1;
    this.resAt = 0;
    this.frames = [];
    /**
     * Set by any frame that did one-off work — rasterising the vector window,
     * compositing a tile window, reallocating the drawing buffer. Those frames
     * are slow for a reason resolution cannot fix, so the scaler does not get
     * to see them.
     */
    this.skipSample = false;
    /**
     * True while something opaque covers the whole globe — a full-height
     * sheet, a modal, a backgrounded tab. Drawing a planet nobody can see is
     * the most expensive thing the page can do while a list is scrolled over
     * the top of it, and on a phone it is exactly why the list stutters.
     */
    this.covered = false;
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
    /** The lamp in view space as it actually is this frame; see syncSun. */
    this.sunNow = new Vector3();
    this.sunFixed = new Vector3();
    this.fillView = new Vector3();
    this.rimView = new Vector3();
    this.camInverse = new Quaternion();
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
    this.#applyRenderer();
    this.chain = new PostChain(this.renderer);

    this.scene = new Scene();
    const cam = STYLE.camera;
    this.camera = new PerspectiveCamera(cam.fov, 1, cam.near, cam.far);

    this.controls = new GlobeControls(canvas, this.camera, {
      onFirstGesture: opts.onFirstGesture,
    });

    this.store = new VectorStore();
    this.painter = new VectorPainter(this.store);
    const env = import.meta.env ?? {};
    this.imagery = new ImageryLayer({
      provider: opts.tiles?.provider ?? env.VITE_TILES_PROVIDER ?? "esri",
      key: opts.tiles?.key ?? env.VITE_TILES_KEY ?? "",
      url: opts.tiles?.url ?? env.VITE_TILES_URL ?? "",
      attribution: opts.tiles?.attribution ?? env.VITE_TILES_ATTRIBUTION ?? "",
      tile: Number(opts.tiles?.tile ?? env.VITE_TILES_SIZE) || undefined,
      maxZoom: Number(opts.tiles?.maxZoom ?? env.VITE_TILES_MAX_ZOOM) || undefined,
      // A tile landing is the one thing here that happens off the camera's
      // clock, so it has to be able to ask for a frame of its own.
      onUpdate: () => {
        this.dirty = true;
      },
    });
    this.detailMix = 0;
    // The entrance can frame the globe off-centre: `shift` is how far its
    // centre sits left of the canvas centre, as a fraction of the width,
    // done with a camera view offset so projection, picking and labels all
    // follow without knowing. It eases back to 0 as the hero retires.
    this.shift = opts.hero?.shift ?? 0;
    this.shiftTarget = this.shift;
    this.heroDist = opts.hero?.dist ?? STYLE.camera.maxDist;
    this.lastTiles = 0;
    this.tileDist = 0;
    this.labels = new LabelLayer(opts.overlay, {
      onPinClick: opts.onPinClick,
      onPinHover: opts.onPinHover,
    });

    // Pins and plates sit in an overlay above the canvas and take the pointer
    // for their clicks, which also swallowed the wheel: zooming stopped dead
    // with the cursor over a city. The wheel is the globe's, whatever is under
    // it, so it is handed straight on.
    opts.overlay?.addEventListener("wheel", (e) => this.controls.wheel(e), { passive: false });

    canvas.addEventListener("click", (e) => {
      if (this.controls.moved) return;
      this.opts.onGlobeClick?.(this.controls.pointAt(e));
    });

    // The land mask, the ink and the tile mosaic are 2D canvases, and a
    // browser may drop a canvas's backing store — a GPU reset, memory
    // pressure, a tab put to sleep — and hand it back blank. Nothing here
    // would notice: the painter still believes its window is current, so it
    // never paints again, and a blank mask reads as "all water" — the land
    // goes the colour of the sea, lit only by the imagery's brightness. So
    // whenever a canvas comes back, or the tab does, everything is redrawn
    // from memory (tiles are cached; nothing is fetched again).
    for (const c of [this.painter.lines, this.painter.mask, this.painter.base, this.imagery.canvas]) {
      c.addEventListener("contextrestored", this.#recover);
    }
    canvas.addEventListener("webglcontextrestored", this.#recover);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) this.#recover();
    });

    onStyle((_, groups) => this.restyle(groups));
  }

  #recover = () => {
    if (!this.earth) return;
    this.painter.painted = null;
    this.painter.baseTheme = null;
    this.painter.repaintBase(this.theme);
    this.imagery.dirty = true;
    this.dirty = true;
  };

  /* ----------------------------------------------------------------- boot */

  async start() {
    const report = this.opts.onProgress || (() => {});
    let done = 0;
    const total = TEXTURES.length + 3;
    const step = (label) => report(++done / total, label);

    const loader = new TextureLoader();
    const load = (url) =>
      new Promise((resolve, reject) => loader.load(url, resolve, undefined, () => reject(new Error(url))));

    // The photographic cloud sheet (STYLE.themes.light.clouds.real). Nearly two
    // megabytes, and nothing needs it to draw, so it is not on the loading
    // bar: it streams alongside and fades in when it lands (see #tick).
    const realClouds = load("/textures/clouds-real.jpg").catch(() => null);

    const textures = {};
    for (const [key, url] of TEXTURES) {
      textures[key] = await load(url);
      step(key === "base" ? "imagery" : key === "aux" ? "topography" : "cloud sheet");
    }

    const grade = createGradeUniforms();
    const effects = createEffectUniforms();
    this.earth = createEarth(
      {
        ...textures,
        lines: this.painter.lineTexture,
        mask: this.painter.maskTexture,
        baseInk: this.painter.baseTexture,
        window: this.painter.window,
        detail: this.imagery.texture,
        detailWindow: this.imagery.window,
      },
      { segments: STYLE.globe.segments, grade, effects },
    );
    this.baseUrl = TEXTURES[0][1];
    this.clouds = createClouds(textures, { segments: STYLE.globe.clouds.segments, grade, effects });
    this.clouds.mesh.scale.setScalar(1 + STYLE.globe.clouds.altitude);
    this.clouds.realReady = 0;
    realClouds.then((tex) => {
      if (!tex) return;
      tex.flipY = false;
      tex.wrapS = RepeatWrapping; // it drifts with the sheet — see createClouds
      tex.generateMipmaps = true;
      tex.anisotropy = 8;
      this.clouds.uniforms.uCloudsReal.value = tex;
      this.clouds.realArrived = true;
    });
    this.halo = createHalo();
    this.post = createPost();
    this.scene.add(this.earth.mesh, this.clouds.mesh, this.halo.mesh, this.post.mesh);
    this.#applyPost();
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
    this.#applySurfaceMaps();
    step("places");

    this.#resize();
    this.observer = new ResizeObserver(() => this.#resize());
    this.observer.observe(this.canvas);
    window.addEventListener("orientationchange", () => this.#resize());

    // One full paint at HOME before anything is shown, so what fades up is the
    // finished globe rather than a bare sphere filling itself in. Held still
    // with it: the drift is the settle's to start, not the loading screen's.
    const home = STYLE.camera.home;
    this.controls.holdSpin(true);
    this.controls.lat = home.lat;
    this.controls.lon = home.lon;
    this.controls.dist = this.heroDist;
    this.controls.target = { lat: home.lat, lon: home.lon, dist: this.heroDist };
    this.controls.update(0.016);
    this.#serviceVectors(true);
    this.render();
    step("gathering the network");

    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this.#tick);
    return this;
  }

  /* ------------------------------------------------------------------ api */

  setTheme(name) {
    this.theme = STYLE.themes[name] ? name : "dark";
    this.#applyThemeStyle();
    this.painter.painted = null; // line colours changed, so force a repaint
    this.painter.repaintBase(this.theme);
    this.dirty = true;
  }

  /**
   * Pushes STYLE into the running scene. `groups` names what changed (a set
   * of top-level or per-theme group names — "camera", "lines", "post" …) so
   * that a colour tweak does not also rasterise the vectors or rebuild a
   * sphere; without it, everything is re-applied.
   */
  restyle(groups) {
    if (!this.earth) return;
    const has = (g) => !groups || groups.has(g);

    if (has("renderer")) this.#applyRenderer();

    if (has("camera")) {
      const cam = STYLE.camera;
      this.camera.fov = cam.fov;
      this.camera.near = cam.near;
      this.camera.far = cam.far;
      this.#applyShift();
      // Only the near stop is enforced here. The entrance frames the globe
      // from beyond maxDist on purpose, and the next zoom clamps the far end.
      const c = this.controls;
      c.dist = Math.max(c.dist, cam.minDist);
      c.target.dist = Math.max(c.target.dist, cam.minDist);
      this.#invalidateVectors();
    }

    if (has("globe")) {
      const g = STYLE.globe;
      if (Math.round(g.segments) !== this.earth.segments) {
        this.earth.mesh.geometry.dispose();
        this.earth.mesh.geometry = sphere(1, g.segments);
        this.earth.segments = Math.round(g.segments);
      }
      if (Math.round(g.clouds.segments) !== this.clouds.segments) {
        this.clouds.mesh.geometry.dispose();
        this.clouds.mesh.geometry = sphere(1, g.clouds.segments);
        this.clouds.segments = Math.round(g.clouds.segments);
      }
      this.clouds.mesh.scale.setScalar(1 + g.clouds.altitude);
      this.#applySurfaceMaps();
    }

    if (has("post")) {
      this.#applyPost();
      if (!this.chain.active) this.chain.release();
    }

    // Uniform writes only, so cheap enough to do on every restyle.
    this.#applyThemeStyle();

    if (has("lines")) {
      this.painter.baseTheme = null;
      this.painter.repaintBase(this.theme);
      this.#invalidateVectors();
    }
    this.dirty = true;
  }

  /**
   * Asks for a fresh vector window on the next frame. The repaint floor
   * (SETTLED_PAINT_MS) is lifted as well: it exists to keep camera motion from
   * rasterising on consecutive frames, and with the camera still, a request
   * it turned away would not be retried until something moved.
   */
  #invalidateVectors() {
    this.painter.painted = null;
    this.lastPaint = 0;
  }

  #applyThemeStyle() {
    const t = applyTheme(STYLE.themes[this.theme], STYLE, this.earth, this.clouds, this.halo);
    this.themeDef = t;
    this.cloudBase = t.clouds.opacity;
    this.facetBase = t.surface.facet.amount;
    this.sunMixBase = t.light.sunMix;
    this.cloudSunMixBase = t.clouds.sunMix;
    angleVector(t.light.sunAzimuth, t.light.sunElevation, this.sunView);
    // Where the lamp sits when it does not follow the camera: the same angles,
    // as seen from HOME.
    const home = STYLE.camera.home;
    const eye = latLonToVec3(home.lat, home.lon, 1, new Vector3());
    const q = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(eye, new Vector3(), new Vector3(0, 1, 0)));
    this.sunFixed.copy(this.sunView).applyQuaternion(q);
    const L = STYLE.lighting;
    angleVector(L.fill.azimuth, L.fill.elevation, this.fillView);
    angleVector(L.rim.azimuth, L.rim.elevation, this.rimView);
    this.#applyVisibility();
  }

  /**
   * The textures STYLE can swap: the day imagery (loaded on demand, the old
   * one kept until the new one has arrived) and the night lights (painted
   * from the places on first use, and again when their size changes).
   */
  #applySurfaceMaps() {
    const g = STYLE.globe;
    const url = g.baseTexture || TEXTURES[0][1];
    if (url !== this.baseUrl && url !== this.baseLoading) {
      this.baseLoading = url;
      new TextureLoader().load(
        url,
        (tex) => {
          if (this.baseLoading !== url) return tex.dispose();
          prepare(tex);
          const old = this.earth.uniforms.uBase.value;
          this.earth.uniforms.uBase.value = tex;
          if (old !== tex) old.dispose();
          this.baseUrl = url;
          this.baseLoading = null;
          this.dirty = true;
        },
        undefined,
        () => {
          console.warn(`[terra] could not load base texture ${url}`);
          this.baseLoading = null;
        },
      );
    }

    const n = g.nightLights;
    if (n.enabled && this.places && this.nightSize !== n.size) {
      const tex = paintNightLights(this.places, n.size);
      const old = this.earth.uniforms.uNightTex.value;
      this.earth.uniforms.uNightTex.value = tex;
      if (old !== BLACK) old.dispose();
      this.nightSize = n.size;
      this.skipSample = true;
    }
  }

  /**
   * Draws one frame: straight to the canvas, or through the post chain when
   * bloom, chromatic aberration or a non-default AA mode is on. Public for
   * anything that renders by hand (screenshots, capture) and wants the frame
   * the page would show.
   */
  render() {
    if (this.chain.active) this.chain.render(this.scene, this.camera);
    else this.renderer.render(this.scene, this.camera);
  }

  /** The sheet and the halo, which STYLE can switch off and debug() hides. */
  #applyVisibility() {
    const debug = this.earth.uniforms.uDebug.value;
    this.clouds.mesh.visible = !debug && STYLE.globe.clouds.enabled;
    this.halo.mesh.visible = !debug && STYLE.themes[this.theme].atmosphere.enabled;
  }

  #applyRenderer() {
    const r = STYLE.renderer;
    this.renderer.toneMapping = TONE_MAPPING[r.toneMapping] ?? NoToneMapping;
    this.renderer.toneMappingExposure = r.exposure;
    // The grade is authored in gamma space and nothing is decoded on the way
    // in, so the honest output is no conversion at all. sRGB encodes it a
    // second time — brighter and flatter — and is there to compare against.
    this.renderer.outputColorSpace = r.outputColorSpace === "sRGB" ? SRGBColorSpace : LinearSRGBColorSpace;
    const dpr = Math.min(window.devicePixelRatio || 1, r.maxPixelRatio);
    if (dpr !== this.dpr) {
      this.dpr = dpr;
      this.renderer.setPixelRatio(this.dpr * this.res);
      this.renderer.setSize(this.size.w, this.size.h, false);
      if (this.painter) this.painter.painted = null;
    }
  }

  #applyPost() {
    const { vignette: v, grain: g } = STYLE.post;
    const u = this.post.uniforms;
    u.uVignette.value = v.enabled ? v.strength : 0;
    u.uVigRadius.value = v.radius;
    u.uVigSoft.value = v.softness;
    u.uVigColor.value.set(v.color);
    u.uGrain.value = g.enabled ? g.amount : 0;
    u.uGrainSize.value = g.size;
    this.post.mesh.visible = v.enabled || g.enabled;
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

  /**
   * Carries the lamp round with the camera.
   *
   * `sunView` is a *view* space direction — straight up the screen — and this
   * is the one line that turns it into the world space vector the shaders are
   * lit by. Because it is recomputed from the camera every frame, the light
   * never moves relative to the viewer: turn the globe and each continent is
   * carried up into the light and back down out of it, which is the whole
   * behaviour. Parent the light to the globe instead and the opposite happens.
   *
   * Public because the frame loop is not the only thing that needs it: anything
   * that moves the camera and then renders by hand — the capture player, the
   * verify harness — has to run this in between, or it shades the new camera
   * with the old camera's sun.
   */
  syncSun() {
    if (STYLE.lighting.followCamera) {
      this.sunWorld.copy(this.sunView).applyQuaternion(this.camera.quaternion);
      this.sunNow.copy(this.sunView);
    } else {
      // (fill and rim below always follow the camera; only the sun can be pinned)
      this.sunWorld.copy(this.sunFixed);
      this.sunNow.copy(this.sunFixed).applyQuaternion(this.camInverse.copy(this.camera.quaternion).invert());
    }
    this.earth.uniforms.uSun.value.copy(this.sunWorld);
    this.clouds.uniforms.uSun.value.copy(this.sunWorld);
    const e = this.earth.effects;
    e.uFillDir.value.copy(this.fillView).applyQuaternion(this.camera.quaternion);
    e.uRimDir.value.copy(this.rimView).applyQuaternion(this.camera.quaternion);
  }

  /** Pauses or resumes the idle drift. */
  setSpin(on) {
    this.controls.setSpin(on);
  }

  /**
   * Tells the globe it is not on screen. The frame loop keeps running — it is
   * what notices the camera again — but it does no work, so a sheet scrolling
   * over the top of a hidden planet is not competing with it for the GPU.
   */
  setCovered(on) {
    const next = !!on;
    if (next === this.covered) return;
    this.covered = next;
    if (!next) {
      // Nothing has been drawn for a while and the camera may have moved
      // underneath: come back with a full service rather than a stale frame.
      this.dirty = true;
      this.last = performance.now();
    }
  }

  /**
   * One step of the resolution scaler, called once a frame with the frame's
   * own duration. Returns true when the drawing buffer changed.
   */
  #autoRes(ms, now) {
    // Frames that did one-off work are slow for a reason resolution will not
    // fix, and counting them would scale the globe down over a single repaint.
    //
    // This used to be a duration cap — ignore anything over 120ms — which was
    // wrong in the one case that matters: on a device slow enough that *every*
    // frame is over 120ms, the cap threw away every sample and the scaler,
    // whose entire purpose is that device, never moved off full resolution.
    // Knowing which frames did the work is the honest test.
    if (this.skipSample) {
      this.skipSample = false;
      return false;
    }
    this.frames.push(ms);
    if (this.frames.length > RES_WINDOW) this.frames.shift();
    if (now - this.resAt < RES_HOLD_MS) return false;

    const next = pickResolution(this.frames, this.res);
    if (next === this.res) return false;

    this.res = next;
    this.resAt = now;
    this.frames.length = 0;
    // Reallocating the drawing buffer costs a frame of its own.
    this.skipSample = true;
    this.renderer.setPixelRatio(this.dpr * this.res);
    this.renderer.setSize(this.size.w, this.size.h, false);
    // The vector window is painted at one texel per drawing-buffer pixel, so
    // it has to be told. The tile layer deliberately is not: its zoom is a
    // network decision, and re-fetching a city every time the scaler twitches
    // would cost far more than the texels it would save.
    this.painter.painted = null;
    this.dirty = true;
    return true;
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

  /** Where the entrance frames the globe; see `shift` in the constructor. */
  setShift(fraction, { instant = false } = {}) {
    this.shiftTarget = fraction;
    if (instant) {
      this.shift = fraction;
      this.#applyShift();
    }
    this.dirty = true;
  }

  #applyShift() {
    const { w, h } = this.size;
    if (Math.abs(this.shift) < 1e-4 || !w) this.camera.clearViewOffset();
    else this.camera.setViewOffset(w, h, this.shift * w, 0, w, h);
    this.camera.updateProjectionMatrix();
  }

  /**
   * The camera half of settling: down from the whole globe to the working
   * view. Silent, because the page decided to do it — counting it as a
   * gesture would retire the hint that has not been earned yet.
   */
  settle(ms = STYLE.camera.settleMs) {
    this.shiftTarget = 0;
    // No arc. A long hop normally lifts away from the surface and settles
    // back, which reads well between two places at the same height; on a
    // descent it puts a small rise at the front, and a page that has just
    // finished arriving cannot afford anything that looks like a second move.
    //
    // HOME to WORK is seventy-odd degrees eastward, which is the same
    // direction the drift turns: spinInto hands the tail of that straight to
    // the drift, so the world comes in turning and simply keeps turning.
    this.controls.holdSpin(false);
    this.controls.flyTo({ ...STYLE.camera.work, ms, silent: true, arc: 0, spinInto: true, ease: "quad" });
  }

  get zoom() {
    return this.controls.zoom;
  }

  /**
   * The zoom ladder, on the instance. The module exports it too, but the
   * console and the verify harnesses only ever have a Globe — and a harness
   * that hardcodes the ladder's ends instead silently tests a camera the app
   * no longer has.
   */
  distForZoom(z) {
    return distForZoom(z);
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
    this.#applyVisibility();
    this.dirty = true;
    return channel;
  }

  stats() {
    return {
      ...this.painter.stats,
      imagery: !this.imagery.enabled
        ? "not configured — painted base only"
        : this.imagery.stats.tiles
          ? `${this.imagery.label} · z${this.imagery.stats.z} · ${this.imagery.stats.tiles} tiles · ${this.imagery.stats.size}`
          : `${this.imagery.label} · nothing streamed yet`,
      renderer: this.renderer.capabilities.isWebGL2 ? "WebGL2" : "WebGL",
      dpr: this.res < 1 ? `${this.dpr} × ${this.res}` : this.dpr,
      triangles: this.renderer.info.render.triangles,
    };
  }

  /* --------------------------------------------------------------- render */

  #resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    if (w === this.size.w && h === this.size.h) return;
    this.size = { w, h };
    this.dpr = Math.min(window.devicePixelRatio || 1, STYLE.renderer.maxPixelRatio);
    this.renderer.setPixelRatio(this.dpr * this.res);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(h, 1);
    this.#applyShift();
    this.controls.setViewport(w, h);
    this.painter.painted = null;
    this.dirty = true;
  }

  #bounds() {
    const dist = this.controls.camDist;
    const cap = visibleCapRadius(dist, this.camera.fov, this.camera.aspect);
    const extent = visibleExtent(dist, this.camera.fov, this.camera.aspect);
    return { cap, bounds: viewBounds(this.controls.lat, this.controls.lon, extent, 1.02) };
  }

  #serviceVectors(immediate = false) {
    const { bounds } = this.#bounds();
    const ppd = this.controls.pxPerDeg * this.dpr * this.res;
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
        this.skipSample = true;
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
      this.skipSample = true;
      this.earth.uniforms.uHasWindow.value = 1;
    }
  }

  /**
   * Keeps the tile canvas over the ground on screen.
   *
   * Cheaper than it looks: the window is a whole number of tiles, so an
   * ordinary nudge asks for the same rectangle and returns at the first
   * comparison, and a tile once decoded is redrawn from memory. What costs
   * anything is the fetch, which is why this is armed below the zoom that
   * shows it — by the time the fade begins the first window is already there.
   */
  #serviceImagery(z, immediate = false) {
    if (!this.imagery.enabled || z < DETAIL_ARM) return;
    const now = performance.now();
    const moving = this.controls.dragging || this.idleFrames < 2;
    if (!immediate && moving && now - this.lastTiles < DETAIL_MOTION_MS) return;

    // Tiles are fetched for ground you are looking at, not for ground you are
    // travelling through. A fly-in crosses six or seven zoom levels in under
    // two seconds and every one of them is a full window — five hundred
    // requests to arrive somewhere that needs eighty. Panning still streams,
    // because the distance is not changing; changing distance waits for the
    // camera to stop, and the painted globe covers the gap, which is what it
    // is for.
    const dist = this.controls.camDist;
    const zooming = Math.abs(dist - this.tileDist) > dist * 0.004;
    this.tileDist = dist;

    const { bounds } = this.#bounds();
    // One pad, whether the camera is moving or not. The vector painter can
    // afford a wider window during motion because it rasterises what it
    // already has in memory; here a wider window means a different tile
    // rectangle, which means fetching the whole view again at the other pad
    // every time the camera starts or stops. A single figure — enough margin
    // that an ordinary nudge lands inside the tiles already held — costs a
    // few tiles at the edge and halves the traffic.
    const win = padBounds(bounds, 1.18);
    if (
      this.imagery.update({
        bounds: win,
        pxPerDeg: this.controls.pxPerDeg * this.dpr,
        centre: { lat: this.controls.lat, lon: this.controls.lon },
        fetch: immediate || !zooming,
      })
    ) {
      this.lastTiles = now;
      this.skipSample = true;
      this.dirty = true;
    }
  }

  #updateHalo() {
    const u = this.halo.uniforms;
    const buffer = this.renderer.getDrawingBufferSize(this.bufferSize);
    u.uResolution.value.set(buffer.x, buffer.y);
    u.uCentre.value.set(buffer.x * (0.5 - this.shift), buffer.y * 0.5);
    // Screen space, y down, pointing at the lamp. Taken from the same view
    // space vector the surface is lit by, so the bloom cannot drift off the
    // lit hemisphere however the globe is turned.
    u.uLightDir.value.set(this.sunNow.x, -this.sunNow.y).normalize();
    const limb = Math.asin(clamp(1 / this.controls.camDist, -1, 1));
    const half = Math.tan(this.camera.fov * DEG * 0.5);
    u.uRadius.value = (buffer.y * 0.5) * (Math.tan(limb) / half);
    this.post.uniforms.uResolution.value.set(buffer.x, buffer.y);
  }

  #tick = (now) => {
    if (!this.running) return;
    requestAnimationFrame(this.#tick);

    // Covered, or in a background tab. The clock is kept honest so the first
    // frame back does not integrate a two-minute dt into the drift.
    if (this.covered || document.hidden) {
      this.last = now;
      // Nobody is watching the framing glide home, so it lands at once:
      // otherwise a hero left for a dialog comes back still off-centre.
      if (this.shift !== this.shiftTarget) {
        this.shift = this.shiftTarget;
        this.#applyShift();
        this.dirty = true;
      }
      return;
    }

    const frame = now - this.last;
    const dt = Math.min(frame / 1000, 0.05);
    this.last = now;
    this.#autoRes(frame, now);

    // The entrance framing glides home on roughly the settle's own clock.
    if (this.shift !== this.shiftTarget) {
      const d = this.shiftTarget - this.shift;
      this.shift = Math.abs(d) < 5e-4 ? this.shiftTarget : this.shift + d * (1 - Math.exp(-dt / 0.42));
      this.#applyShift();
      this.dirty = true;
    }

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
    const gs = STYLE.globe;
    this.drift = (this.drift + dt * gs.clouds.drift) % 1;
    const z = this.controls.zoom;
    const c = this.clouds.uniforms;
    c.uDrift.value = this.drift;
    // ...and it goes out altogether rather than thinning to a fifth.
    //
    // The sheet is a shell 35km above the ground, which is nothing from orbit
    // and everything from ninety kilometres up: at the close stop the camera
    // is barely twice its height above it, so what used to be a haze over the
    // world becomes a *ceiling* — its own limb cuts a band across the top of
    // the frame and the fifth that was left reads as fog over the city.
    // The photographic sheet fades in over the synthetic one as it lands,
    // and takes its own opacity with it.
    if (this.clouds.realArrived && this.clouds.realReady < 1) {
      this.clouds.realReady = Math.min(1, this.clouds.realReady + dt / 0.6);
    }
    const real = (this.themeDef?.clouds.real ?? 0) * this.clouds.realReady;
    c.uRealMix.value = real;
    const cloudBase = lerp(this.cloudBase, this.themeDef?.clouds.realOpacity ?? this.cloudBase, real);
    c.uOpacity.value = lerp(cloudBase, 0, smoothstep(gs.clouds.fadeStart, gs.clouds.fadeEnd, z));

    // The cells are a fixed angular size, so coming in makes each one bigger
    // on screen until a single facet fills the window. The faceted shell is a
    // whole-globe reading of the world; past a region the vectors are what
    // carry the detail, and the facets retire rather than becoming scenery.
    this.earth.uniforms.uFacet.value = (this.facetBase ?? 1) * (1 - smoothstep(gs.facetFadeStart, gs.facetFadeEnd, z));

    // So does the terminator, and for the same reason.
    //
    // A shadow thrown across the planet is a picture of a *planet*: it needs
    // the whole disc to be a shadow at all. Two hundred kilometres of England
    // does not straddle a terminator — it is either day there or it is not —
    // so holding the whole-globe modelling on the way in just renders the
    // ground you came to read at a third of its brightness, in a dusk that
    // never resolves however far you go. Past a region the lamp flattens
    // toward plain overhead daylight, on the same schedule the facets retire
    // on. It is not a brightness cheat: uSunMix is literally "how much of the
    // day/night modelling to apply", and at a city there is no night in frame
    // to model.
    // The handover. Two gates multiplied: how far in the camera is, and how
    // much of the window has actually arrived — so a cold cache fades up as it
    // fills instead of snapping on over a half-drawn mosaic. Smoothed in time
    // as well, because coverage steps as each tile lands and an unsmoothed mix
    // would flicker with the network.
    const wanted = this.imagery.enabled
      // Coverage only gates the *start*: past a tile or two the canvas carries
      // its own presence in its alpha, so the fade does not have to wait for a
      // window to be complete before it will show any of it.
      ? smoothstep(DETAIL_IN[0], DETAIL_IN[1], z) * smoothstep(0.0, 0.25, this.imagery.coverage)
      : 0;
    this.detailMix += (wanted - this.detailMix) * (1 - Math.exp(-dt / DETAIL_TAU));
    if (Math.abs(wanted - this.detailMix) > 0.002) this.dirty = true;
    this.earth.uniforms.uDetailMix.value = this.detailMix;
    // Where the imagery draws the water too, the coastline the ink is tracing
    // is already there in the picture. Driven off zoom rather than off the
    // mix, which saturates long before the camera stops.
    // Late, and later than the imagery itself. A styled ocean beside real land
    // is the look; it only becomes a *lie* at the scale where you can see the
    // coastline it is drawn from is a kilometre out, and a sediment plume or a
    // turquoise shoal is worth more than the ramp only once it is the size of
    // the frame. Regional zoom keeps the theme's water.
    const water = smoothstep(0.74, 0.94, z) * this.detailMix;
    this.earth.uniforms.uDetailWater.value = water;
    // The ink was drawn to carry a world with no detail under it. Where there
    // is detail it steps back to a hint — enough that the coast still reads as
    // a drawn edge, not so much that it fences off the ground it is tracing —
    // and where the imagery has the water as well it very nearly lets go.
    this.earth.uniforms.uLineMix.value = 1 - 0.5 * this.detailMix - 0.34 * water;

    const local = smoothstep(gs.sunFlattenStart, gs.sunFlattenEnd, z) * gs.sunFlatten;
    this.earth.uniforms.uSunMix.value = (this.sunMixBase ?? 1) * (1 - local);
    c.uSunMix.value = (this.cloudSunMixBase ?? 0.55) * (1 - local);
    this.syncSun();
    if (this.post.mesh.visible && STYLE.post.grain.animated) this.post.uniforms.uTime.value = now / 1000;

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
      this.#serviceImagery(z);
      this.opts.onCamera?.(z, this.controls);
      this.dirty = false;
    } else if (this.settleTimer > SETTLE_MS && this.settleTimer < SETTLE_MS + 400) {
      this.settleTimer = SETTLE_MS + 500;
      this.#serviceVectors(true);
      this.#serviceImagery(this.controls.zoom, true);
    }

    this.render();
  };
}

export { distForZoom, zoomLevel };
