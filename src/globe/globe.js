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
  Texture,
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
import { clamp, DEG, latLonToVec3, lerp, smoothstep, vec3ToLatLon, viewBounds, visibleCapRadius, visibleExtent, wrapDelta } from "./geo.js";
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
  ["base", "/textures/blue-marble.webp"],
  ["aux", "/textures/earth-aux.webp"],
  ["clouds", "/textures/clouds.webp"],
];

/**
 * The same two maps at 8192 x 4096 (tools/make_earth_textures.py), from the
 * full-resolution Blue Marble and GEBCO rasters. The 4K pair is magnified
 * about two to one on a large screen close in — the landing stage frames a
 * quarter of the planet across the whole window — and that is what read as
 * soft. Taken only where they pay for themselves: a desktop-sized window, a
 * GPU that can hold an 8K texture, and nobody asking to save data. STYLE
 * keeps naming the 4K file; this is a resolution of it, not another map.
 */
const HD_TEXTURES = {
  "/textures/blue-marble.webp": "/textures/blue-marble-8k.webp",
  "/textures/earth-aux.webp": "/textures/earth-aux-8k.webp",
};

/**
 * Names an older STYLE may still carry for a map that has since changed
 * format (a preset saved in the style editor, an exported settings file).
 */
const RENAMED = {
  "/textures/blue-marble.jpg": "/textures/blue-marble.webp",
};

/**
 * A texture decoded off the main thread. An <img> handed to WebGL is decoded
 * on the main thread at the moment it is first uploaded — for an 8K map, a
 * few hundred milliseconds inside whichever frame first draws it, a visible
 * stop in the middle of the turn. createImageBitmap decodes on a worker, and
 * the upload is then made on a frame of our choosing (Globe #upload). Falls
 * back to the image loader where there is no ImageBitmap.
 */
async function loadDecoded(url) {
  if (typeof createImageBitmap !== "function") {
    return new Promise((resolve, reject) => new TextureLoader().load(url, resolve, undefined, () => reject(new Error(url))));
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  // Data as well as pictures: no premultiplying, no colour management.
  const bitmap = await createImageBitmap(await res.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const tex = new Texture(bitmap);
  tex.needsUpdate = true;
  return tex;
}

/**
 * The most the 4096 x 2048 cloud sheet's upload may take for the 8K maps to
 * follow it (Globe loadDeferred). Each map is four times the texels, so this
 * keeps either one to about one dropped frame.
 */
const HD_UPLOAD_BUDGET_MS = 20;

function wantsHd(renderer) {
  const big = Math.min(window.screen?.width || 0, window.innerWidth) >= 900;
  const saveData = !!navigator.connection?.saveData;
  return big && !saveData && (renderer.capabilities.maxTextureSize || 0) >= 8192;
}

/**
 * Below this height (in Earth radii, about 130 km) the shader locates every
 * pixel by its own ray against the true sphere (earth.frag.glsl, uPrec). Above
 * it the mesh and plain floats are fine, and the cheaper path is kept.
 */
const CLOSE_ALT = 0.02;

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
/** Where the camera looks when it turns off the landing stage. */
const STAGE_EXIT_LAT = 6;

const DETAIL_IN = [0.25, 0.44];
/** Tiles are fetched a beat before they are shown, so the fade has them. */
const DETAIL_ARM = 0.2;
/** Time constant of the fade. Long: imagery should arrive, not appear. */
const DETAIL_TAU = 0.28;
/** Latitude past which the tile window stops; see #screenBounds. */
const TILE_LAT = 75;
/** Cosine of the steepest view onto the ground the tile window covers (~63°). */
const TILE_FACING = 0.45;
/** Floor between tile windows while the camera is moving. */
const DETAIL_MOTION_MS = 260;
/**
 * The other way in: by magnification rather than by zoom. Blue Marble is about
 * seven kilometres a texel, so it only looks crisp while it is shrunk — once
 * a texel of it covers more than half a screen pixel the ground goes soft,
 * whatever the zoom reads. On a phone at dpr 2 that is well before DETAIL_IN,
 * which is the softness a regional view had. Measured in screen pixels per
 * base texel; armed a little before it shows. The whole disc stays painted.
 */
const DETAIL_MAG = [0.45, 0.85];
const DETAIL_MAG_ARM = 0.35;
/** Texels round the equator of the painted base, 4K and 8K. */
const BASE_TEXELS = { sd: 5400, hd: 8192 };
/**
 * How long after the last touch the globe is redrawn at full resolution.
 * The scaler's reduced resolution is for keeping a gesture smooth; once the
 * hand is off there is nothing to keep up with, and a still picture drawn
 * soft is just a soft picture.
 */
const REST_SHARP_MS = 220;


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

/**
 * The pixel ratio the globe is drawn at.
 *
 * A phone's third pixel is 2.25 times the fragments of a globe whose shader is
 * the heaviest thing on the page, for detail a 460ppi screen does not show at
 * arm's length — and a phone's GPU is the part that decides whether a pinch
 * keeps up with the fingers. The pins and every word are DOM, and stay at the
 * full density regardless.
 */
function drawDpr() {
  const handheld = matchMedia("(pointer: coarse) and (max-width: 1000px)").matches;
  return Math.min(window.devicePixelRatio || 1, STYLE.renderer.maxPixelRatio, handheld ? 2 : Infinity);
}

export class Globe {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.theme = "dark";
    this.dpr = drawDpr();
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
    /** Drawing at full resolution because nothing is moving; see REST_SHARP_MS. */
    this.atRest = false;
    this.busyAt = 0;
    this.frames = [];
    /** Until when one-off work is held back; see quiet(). */
    this.quietUntil = 0;
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
      onDoubleClick: (at) => opts.onDoubleClick?.(at) ?? false,
    });

    this.store = new VectorStore();
    // A phone. Its GPU, not its CPU, is what decides whether a pinch keeps
    // up, so it gets smaller windows and — mid-gesture — lazier ones.
    this.handheld = matchMedia("(pointer: coarse) and (max-width: 1000px)").matches;
    // A phone's screen at two texels a point, padded, is under three million;
    // the desktop's budget would have it paint and upload twice that.
    this.painter = new VectorPainter(this.store, this.handheld ? { budget: 3.2e6 } : undefined);
    // A worker paint has landed: it goes up on the next frame, and that frame
    // is slow for a reason resolution will not fix.
    this.painter.onPaint = () => {
      this.dirty = true;
      this.skipSample = true;
    };
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
    this.imagery.attach(this.renderer);
    this.detailMix = 0;
    // The entrance can frame the globe off-centre: `shift` is how far its
    // centre sits left of the canvas centre, as a fraction of the width,
    // done with a camera view offset so projection, picking and labels all
    // follow without knowing. It eases back to 0 as the hero retires.
    this.shift = opts.hero?.shift ?? 0;
    this.shiftTarget = this.shift;
    // The same thing vertically: how far the centre sits *above* the canvas
    // centre, as a fraction of the height. A phone raises the globe into the
    // room a bottom sheet leaves, rather than moving the canvas.
    this.lift = opts.hero?.lift ?? 0;
    this.liftTarget = this.lift;
    this.heroHome = opts.hero?.home;
    // The landing stage turns the planet at a set rate; see spinFloor.
    this.controls.spinFloor = opts.hero ? (opts.hero.spin ?? 0.7) : 0;
    // The landing stage shows the painted planet only: no tile imagery, so
    // nothing on screen needs a provider's credit. Released as the stage is
    // left, and the imagery fades up on its usual clock.
    this.detailHeld = !!opts.hero;
    this.heroDist = opts.hero?.dist ?? STYLE.camera.maxDist;
    this.lastTiles = 0;
    this.tileDist = 0;
    this.labels = new LabelLayer(opts.overlay, {
      // A drag that began on a pin ends with a click on it; that was a turn
      // of the globe, not a choice of ministry.
      onPinClick: (m) => {
        if (this.controls.moved) return;
        opts.onPinClick?.(m);
      },
      onPinHover: opts.onPinHover,
      onAreaGrab: (e) => this.#grabArea(e),
    });

    // Pins and plates sit in an overlay above the canvas and take the pointer
    // for their clicks, which also swallowed the wheel: zooming stopped dead
    // with the cursor over a city. The wheel is the globe's, whatever is under
    // it, so it is handed straight on.
    opts.overlay?.addEventListener("wheel", (e) => this.controls.wheel(e), { passive: false });
    // The same for a finger: a drag or a pinch that happens to start on a pin
    // turns the globe, as it would a hair to either side.
    opts.overlay?.addEventListener("pointerdown", (e) => this.controls.grab(e));

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
    const total = TEXTURES.length + 4;
    const step = (label) => report(++done / total, label);

    const loader = new TextureLoader();
    const load = (url) =>
      new Promise((resolve, reject) => loader.load(url, resolve, undefined, () => reject(new Error(url))));

    this.hd = wantsHd(this.renderer);
    // Everything the first frame needs, fetched at once rather than one after
    // another: the 4K maps, the photographic clouds, the coastlines and the
    // place names. The 8K maps are not even asked for until the entrance is
    // over (loadDeferred): the planet appears on the 4K pair and sharpens
    // when the larger files land.
    //
    // The clouds are here rather than deferred because they are the one
    // texture whose arrival *changes* the planet rather than sharpening it: a
    // different weather pattern at a different opacity over the synthetic
    // sheet. Faded in after the entrance, that landed in the middle of
    // whatever the camera was doing (a search's flight, most often) as a
    // shift in the whole globe's colour. Decoded off the main thread and
    // uploaded before the first frame, it is simply there from the start.
    const vectors = this.store.load("50m");
    const realClouds = loadDecoded("/textures/clouds-real.jpg").catch(() => null);
    const named = Promise.all([
      fetch("/vectors/places.json").then((r) => r.json()),
      fetch("/vectors/countries.json").then((r) => r.json()),
    ]);
    const textures = Object.fromEntries(
      await Promise.all(
        TEXTURES.map(([key, url]) =>
          load(url).then((tex) => {
            step(key === "base" ? "imagery" : key === "aux" ? "topography" : "cloud sheet");
            return [key, tex];
          }),
        ),
      ),
    );

    // The stage looks across the planet at a slant toward its rim, where 8x
    // anisotropy smears the sharper maps; take what the GPU offers, to 16.
    const aniso = Math.min(16, this.renderer.capabilities.getMaxAnisotropy?.() || 8);
    this.aniso = aniso;
    for (const key of ["base", "aux"]) textures[key].userData.anisotropy = aniso;

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
    // How long its upload took says whether the 8K maps can follow (loadDeferred).
    this.cloudUploadMs = 0;
    const real = await realClouds;
    if (real) {
      real.flipY = false;
      real.wrapS = RepeatWrapping; // it drifts with the sheet — see createClouds
      real.generateMipmaps = true;
      real.anisotropy = 8;
      const t0 = performance.now();
      this.renderer.initTexture(real);
      this.cloudUploadMs = performance.now() - t0;
      this.clouds.uniforms.uCloudsReal.value = real;
      this.clouds.realArrived = true;
      this.clouds.realReady = 1;
    }
    step("weather");
    this.halo = createHalo();
    this.post = createPost();
    this.scene.add(this.earth.mesh, this.clouds.mesh, this.halo.mesh, this.post.mesh);
    this.#applyPost();
    this.setTheme(this.theme);

    // The rest of the start is a third of a second of one-off work — the
    // vectors decoded and painted, the labels, the first full render — and in
    // a single task it held the page for all of it, the sky's fade included.
    // Handed back between the steps, it costs nothing and holds nothing.
    const breathe = () => new Promise((r) => setTimeout(r, 0));
    await vectors;
    await breathe();
    this.painter.repaintBase(this.theme);
    step("vectors");
    await breathe();

    const [places, countries] = await named;
    this.places = places;
    this.countries = countries;
    this.labels.setData({ places, countries, ministries: this.ministries || [] });
    this.#applySurfaceMaps();
    step("places");
    await breathe();

    this.#resize();
    this.observer = new ResizeObserver(() => this.#resize());
    this.observer.observe(this.canvas);
    window.addEventListener("orientationchange", () => this.#resize());

    // One full paint at HOME before anything is shown, so what fades up is the
    // finished globe rather than a bare sphere filling itself in. Held still
    // with it: the drift is the settle's to start, not the loading screen's.
    const home = this.heroHome ?? STYLE.camera.home;
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

  /**
   * What only sharpens the planet, fetched once the page's entrance is over
   * (App): where wantsHd allows, the 8K maps. Some ten megabytes, none of it
   * needed to draw; asked for at the start, it shared the line with the maps
   * the entrance waits on and landed its decodes in the middle of the entrance.
   */
  async loadDeferred() {
    if (this.deferred || !this.earth) return;
    this.deferred = true;
    // How long the cloud sheet took to go up (start) says whether the 8K maps
    // can: each is four times its texels, and an upload cannot be split
    // across frames. Where the sheet alone costs more than a frame, the maps
    // would stop the turning planet for a tenth of a second each, twice —
    // and the 4K pair is sharp enough not to be worth that.
    const struggling = this.cloudUploadMs > HD_UPLOAD_BUDGET_MS || this.res < 1;
    if (this.hd && !struggling) this.#upgradeMaps();
  }

  /**
   * Sends a texture to the GPU at the start of a frame, one texture a frame:
   * the upload of an 8K map is tens of milliseconds that cannot be split,
   * and two in the same frame would be a stop rather than a stutter.
   */
  #upload(tex) {
    this.uploads = (this.uploads ?? Promise.resolve()).then(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => {
            const t0 = performance.now();
            this.renderer.initTexture(tex);
            // A frame that uploaded is slow for a reason resolution will not fix.
            this.skipSample = true;
            resolve(performance.now() - t0);
          }),
        ),
    );
    return this.uploads;
  }

  /** Swaps the 4K surface maps for the 8K pair once they have downloaded. */
  #upgradeMaps() {
    const u = this.earth.uniforms;
    const aniso = this.aniso;
    const swap = (uniform, url) =>
      loadDecoded(HD_TEXTURES[url]).then(
        async (tex) => {
          prepare(tex);
          tex.userData.anisotropy = aniso;
          tex.anisotropy = aniso;
          await this.#upload(tex);
          // Never in the middle of a flight: the sharper map is a change of
          // texture in a single frame, and mid-move (a search's flight in
          // from orbit) it read as the planet shifting under the camera.
          // Swapped once the camera has arrived, it is only a sharpening.
          while (this.controls.flight) await new Promise((r) => requestAnimationFrame(r));
          // A base map chosen in the style editor while this was loading wins.
          if (uniform === "uBase" && this.baseUrl !== TEXTURES[0][1]) return tex.dispose();
          const old = u[uniform].value;
          u[uniform].value = tex;
          old?.dispose?.();
          if (uniform === "uAux" && tex.image) {
            u.uAuxTexel.value.set(1 / tex.image.width, 1 / tex.image.height);
            u.uAuxSize.value.set(tex.image.width, tex.image.height);
          }
          this.dirty = true;
        },
        () => {}, // the 4K map stays; nothing is lost
      );
    // Not over a base map someone has chosen in the style editor.
    if (this.baseUrl === TEXTURES[0][1]) swap("uBase", TEXTURES[0][1]);
    swap("uAux", TEXTURES[1][1]);
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
      const close = Math.min(cam.closeDist ?? cam.minDist, cam.minDist);
      c.dist = Math.max(c.dist, close);
      c.target.dist = Math.max(c.target.dist, close);
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
    const url = RENAMED[g.baseTexture] ?? (g.baseTexture || TEXTURES[0][1]);
    if (url !== this.baseUrl && url !== this.baseLoading) {
      this.baseLoading = url;
      new TextureLoader().load(
        (this.hd && HD_TEXTURES[url]) || url,
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
      const tex = paintNightLights(this.places, n.size, this.renderer.capabilities.maxTextureSize);
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
    this.#syncClose();
    if (this.chain.active) {
      // The aberration is centred on the planet rather than the screen, so it
      // gathers toward the limb wherever the disc is framed.
      this.chain.disc = this.discOnScreen();
      this.chain.view = this.size;
      this.chain.render(this.scene, this.camera);
    } else this.renderer.render(this.scene, this.camera);
  }

  /**
   * Close range, once per frame before drawing. The near plane follows the
   * camera down — fixed at 0.005, thirty kilometres, it would slice the
   * ground away long before street level — and the shader is handed what its
   * per-pixel ray needs, worked out here in doubles: the camera's rays, the
   * view centre as the exact float32 it will be read as, the camera's offset
   * from it, and where it sits in the imagery window. See uPrec.
   */
  #syncClose() {
    const alt = this.controls.camDist - 1;
    const near = clamp(alt * 0.35, 2e-6, STYLE.camera.near);
    if (Math.abs(this.camera.near - near) > near * 1e-3) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
    const u = this.earth.uniforms;
    u.uPrec.value = alt < CLOSE_ALT ? 1 : 0;
    if (alt >= CLOSE_ALT) return;

    const buf = this.renderer.getDrawingBufferSize(this.bufferSize);
    u.uViewport.value.set(buf.x, buf.y);
    this.camera.updateMatrixWorld();
    u.uInvProj.value.copy(this.camera.projectionMatrixInverse);
    u.uCamRot.value.setFromMatrix4(this.camera.matrixWorld);

    const r = latLonToVec3(this.controls.lat, this.controls.lon, 1, this.refScratch ??= new Vector3());
    r.set(Math.fround(r.x), Math.fround(r.y), Math.fround(r.z));
    u.uRef.value.copy(r);
    const p = this.camera.position;
    u.uRel.value.set(p.x - r.x, p.y - r.y, p.z - r.z);
    u.uRelC.value = p.lengthSq() - 1;

    const lat = Math.atan2(r.y, Math.hypot(r.x, r.z));
    const lon = Math.atan2(-r.z, r.x);
    const w = u.uDetailWindow.value;
    let du = lon / (2 * Math.PI) + 0.5 - w.x;
    du -= Math.floor(du);
    const merc = 0.5 - Math.log(Math.tan(Math.PI / 4 + clamp(lat, -1.4844, 1.4844) / 2)) / (2 * Math.PI);
    u.uRefMerc.value.set(1 / Math.cos(lat), Math.tan(lat), du, merc - w.y);
  }

  /** The sheet and the halo, which STYLE can switch off and debug() hides. */
  #applyVisibility() {
    const debug = this.earth.uniforms.uDebug.value;
    this.cloudsShown = !debug && STYLE.globe.clouds.enabled;
    this.clouds.mesh.visible = this.cloudsShown;
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
    const dpr = drawDpr();
    if (dpr !== this.dpr) {
      this.dpr = dpr;
      this.renderer.setPixelRatio(this.dpr * this.#drawRes());
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

  /** The viewer's own position, `{ lat, lon, accuracy }`, or null to hide the dot. */
  setUserLocation(here) {
    this.labels.setUser(here);
    this.dirty = true;
  }

  /** Places the serve-locally guide found on the web; `active` is the one opened. */
  setFound(list, active = null) {
    this.labels.setFound(list, active);
    this.dirty = true;
  }

  /** The serve-locally circle, `{ lat, lon, miles }`, or null to take it away. */
  setArea(area) {
    this.labels.setArea(area);
    this.dirty = true;
  }

  /**
   * Brings the camera down over a point until a circle of `miles` round it
   * fills about `fill` of the shorter side of the screen.
   */
  frameArea({ lat, lon, miles }, { fill = 0.36, ms } = {}) {
    const { w, h } = this.size;
    const half = Math.tan(this.camera.fov * DEG * 0.5);
    // The ground's px per degree at the centre is h / (2·depth·tan(fov/2))
    // per radian; solve it for the depth that puts the radius at `fill`.
    const rad = miles / 3958.8;
    const depth = (rad * h) / (2 * half * fill * Math.min(w, h));
    const hop = this.controls.angleTo(lat, lon);
    // That depth is the camera's real altitude; a portrait screen stretches
    // the semantic one (controls.fitted), so it is asked for un-stretched.
    const dist = this.controls.unfitted(1 + depth);
    const t = ms ?? clamp(800 + hop * 6, 800, 1800);
    this.controls.flyTo({ lat, lon, dist, ms: t });
    // The tiles wait for the landing, as the find bar's flight does: a tile
    // window re-sent mid-flight is up to sixty-four megabytes through the GPU
    // in one frame, the hitch in an otherwise even move. The ground they
    // were going to fetch comes in the moment the camera stops (#quiet).
    this.quiet(t);
  }

  /**
   * Moving the serve-locally circle: the ground grabbed stays under the
   * pointer, and the centre keeps its offset from it, so the circle slides
   * with the hand rather than jumping its middle to it. Each move goes to
   * `onAreaMove(centre, { done: false })`, and the release to
   * `onAreaMove(centre, { done: true })` — not called for a press that never
   * moved.
   */
  #grabArea(e) {
    const move = this.opts.onAreaMove;
    const a = this.labels.area;
    if (!move || !a) return false;
    if (e.pointerType === "mouse" && e.button !== 0) return false;
    const at = this.controls.pointAt(e);
    if (!at) return false;
    const off = { lat: a.lat - at.lat, lon: wrapDelta(at.lon, a.lon) };
    let last = null;
    document.body.classList.add("is-moving-area");
    const onMove = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      ev.preventDefault();
      const p = this.controls.pointAt(ev);
      if (!p) return;
      last = { lat: clamp(p.lat + off.lat, -84, 84), lon: ((p.lon + off.lon + 540) % 360) - 180 };
      move(last, { done: false });
    };
    const onUp = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("is-moving-area");
      if (last) move(last, { done: true });
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return true;
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
      // Never further out than now: below the ladder's end zoom reads 1, and
      // "at least this close" must not lift someone off the street.
      dist: Math.min(distForZoom(Math.max(zoom, from)), this.controls.target.dist),
      ms: ms ?? clamp(700 + hop * 6, 700, 1750),
    });
    // Tiles after the landing, not during it; see frameArea.
    this.quiet(ms ?? clamp(700 + hop * 6, 700, 1750));
  }

  flyTo(args) {
    this.controls.flyTo(args);
  }

  /**
   * Down onto one building, the way a maps app does it: up just far enough
   * that where the camera is and where it is going are both on screen,
   * across, and down to street level over the place — one unbroken move,
   * slower the further it has to go. Already there, it settles in place.
   */
  flyToPlace({ lat, lon }, { zoom = 0.97 } = {}) {
    const from = this.controls.dist - 1;
    const to = distForZoom(zoom) - 1;
    const span = this.controls.angleTo(lat, lon) * DEG;
    // The height at which the span fills about two thirds of the screen.
    const need = span / (2 * Math.tan(this.camera.fov * DEG * 0.5) * 0.66);
    const rise = Math.max(0, Math.log(Math.max(need, from, to)) - (Math.log(from) + Math.log(to)) / 2);
    this.controls.flyTo({
      lat,
      lon,
      dist: to + 1,
      rise,
      ms: clamp(1000 + rise * 380, 1000, 2400),
    });
  }

  /**
   * Off to a named place, as asked for in the find bar: out to the whole
   * Earth, round with it — the long way when the place is already near, so
   * the planet is always seen to turn — and down onto the place. One flight,
   * so it never stops at the top; a place already under the camera is simply
   * settled onto.
   */
  travelTo({ lat, lon }, { zoom = 0.94, dist } = {}) {
    const c = this.controls;
    // `dist` asks for a height outright — below the ladder's close end,
    // where every zoom reads 1 — and wins over `zoom` when given.
    const to = dist ?? distForZoom(zoom);
    if (c.angleTo(lat, lon) < 1.5 && c.dist < to * 1.6) {
      return c.flyTo({ lat, lon, dist: to, ms: 900 });
    }
    // Under a third of a turn away goes round the other way instead.
    let turn = wrapDelta(c.lon, lon);
    if (Math.abs(turn) < 120) turn -= Math.sign(turn || STYLE.motion.direction || 1) * 360;
    const from = c.dist - 1;
    const peak = STYLE.camera.maxDist - 1;
    const rise = Math.max(0, Math.log(peak) - (Math.log(from) + Math.log(to - 1)) / 2);
    this.quiet(3600);
    c.flyTo({ lat, lon, dist: to, turn, rise, ms: clamp(2200 + Math.abs(turn) * 3, 2400, 3400) });
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
    // Not on the landing stage. The planet there only drifts, a fraction of
    // a degree a second, with no hand on it: nothing the scaler buys with
    // resolution would be seen, and what it gives up — on a large Retina
    // window it would step the landing down to 70% or 55% — is exactly the
    // sharpness the stage is for. It starts measuring once the stage is left
    // (detailHeld is released with it).
    // Nor while the style editor films a camera path: a step down mid-take
    // is a visible softening in the recording.
    if (this.detailHeld || this.filming || this.#quiet(performance.now()) || this.atRest) {
      this.frames.length = 0;
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
    this.renderer.setPixelRatio(this.dpr * this.#drawRes());
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
  releaseSpin({ now = false } = {}) {
    this.controls.holdSpin(false);
    // `now` skips the pause the drift keeps after a hand has let go — there
    // has been no hand; the page is opening and the planet should be turning
    // as it arrives, eased up over the drift's own second.
    if (now) this.controls.quiet = Math.max(this.controls.quiet, STYLE.motion.spinResume);
  }

  /** Where the entrance frames the globe; see `shift` in the constructor. */
  setShift(fraction, { instant = false, tau = 0.42 } = {}) {
    this.shiftTarget = fraction;
    this.shiftTau = tau;
    if (instant) {
      this.shift = fraction;
      this.#applyShift();
    }
    this.dirty = true;
  }

  /**
   * Raises the globe's centre by `fraction` of the canvas height, gliding
   * there. Like the shift, it is a view offset, so picking and the labels
   * follow it without knowing.
   */
  setLift(fraction, { instant = false, tau = 0.14, ms = 0 } = {}) {
    this.liftTarget = fraction;
    this.liftTau = tau;
    // A timed glide instead of the chase: it leaves at rest and lands at
    // rest, on the clock rather than on frame times, so a slow first frame
    // while the imagery uploads cannot throw it forward.
    this.liftTween = ms > 0 && !instant ? { from: this.lift, to: fraction, t0: performance.now(), ms } : null;
    if (instant) {
      this.lift = fraction;
      this.#applyShift();
    }
    this.dirty = true;
  }

  /**
   * Off the landing stage by hand. A drag has the rotation, so there is no
   * flight to ride: the planet comes up to the centre and eases out to
   * `dist` on a short curve of its own instead, moving at once and slowing
   * into place, while the hand goes on turning it. A wheel part way through
   * has the distance from then on; a flight has all of it.
   */
  leaveStage({ ms = 1100, dist } = {}) {
    this.quiet(ms + 300);
    this.liftFollow = null;
    this.controls.spinFloor = 0;
    this.shiftTarget = 0;
    const from = this.controls.target.dist;
    this.stageOut = { t: 0, ms, lift: this.lift, from, to: dist ?? from, last: from };
    this.liftTarget = this.lift;
    this.dirty = true;
  }

  /**
   * Back onto the landing stage — the style editor's way of looking at it
   * again once the page has left it. The planet flies out to the stage's
   * framing and turns at the stage's rate, painted only, as it opened.
   */
  enterStage({ lift, shift = 0, dist, home, spin = 0.7 }, { ms = 1600 } = {}) {
    this.liftFollow = null;
    this.stageOut = null;
    this.controls.spinFloor = spin;
    this.detailHeld = true;
    // Back to full resolution for the stage; see #autoRes.
    this.#fullRes();
    this.heroHome = home;
    this.heroDist = dist;
    this.controls.flyTo({ lat: home.lat, lon: home.lon, ms, silent: true, arc: 0, ease: "cubic" });
    // flyTo keeps to the zoom ladder; the stage can stand outside it.
    this.#stageDist(dist);
    this.setLift(lift, { tau: ms / 3000 });
    this.setShift(shift, { tau: ms / 3000 });
    this.dirty = true;
  }

  /** Resizes the planet on the stage, gliding: the editor's size handle. */
  setStageDist(dist) {
    this.heroDist = dist;
    this.#stageDist(dist);
    this.dirty = true;
  }

  #stageDist(dist) {
    const c = this.controls;
    if (c.flight) c.flight.to.dist = dist;
    c.target.dist = dist;
  }

  /**
   * Keeps the next `ms` free of one-off work — tile windows, mid-motion
   * vector rasterising, resolution changes — so a camera move that has to
   * read as one continuous gesture (the flight off the landing stage) gets
   * every frame. What was deferred happens once, at rest.
   */
  quiet(ms) {
    this.quietUntil = Math.max(this.quietUntil || 0, performance.now() + ms);
    this.quietMove = true;
  }

  /**
   * Whether one-off work is being held. At least the time asked for, and on
   * past it for as long as the move itself is still running: the flight is
   * integrated a capped step a frame, so on a slow device it takes longer
   * than its nominal length, and the hold has to last as long as it does.
   */
  #quiet(now) {
    if (this.quietMove && now >= this.quietUntil && !this.controls.flight && !this.stageOut && !this.liftFollow) {
      this.quietMove = false;
      // Work held for the move has been waiting on a pass; passes stop once
      // the camera is still, so ask for one now or it waits for good.
      this.dirty = true;
    }
    return this.quietMove || now < this.quietUntil;
  }

  #fullRes() {
    if (this.res >= 1) return;
    this.res = 1;
    this.resAt = performance.now();
    this.frames.length = 0;
    this.skipSample = true;
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(this.size.w, this.size.h, false);
    this.painter.painted = null;
  }

  /**
   * The style editor's animation timeline films the globe: "live" while it
   * plays in real time, "step" while it renders frame by frame. Either way
   * the drawing buffer goes back to full resolution and stays there, and the
   * tile imagery is fetched sharp through the move. null hands back.
   */
  setFilming(mode) {
    this.filming = mode || null;
    if (this.filming) this.#fullRes();
    this.dirty = true;
  }

  /** Every tile the view asked for has landed and faded in. */
  get filmSettled() {
    return !this.imagery.enabled || this.detailHeld || this.imagery.idle;
  }

  /** Lets the tile imagery back in; see `detailHeld` in the constructor. */
  releaseDetail() {
    this.detailHeld = false;
    this.dirty = true;
  }

  /**
   * The disc as it stands on screen this frame, in CSS pixels: its centre and
   * radius. The page masks the landing headline with it, so the planet reads
   * as standing in front of the words.
   */
  discOnScreen() {
    const { w, h } = this.size;
    const limb = Math.asin(clamp(1 / this.controls.camDist, -1, 1));
    const half = Math.tan(this.camera.fov * DEG * 0.5);
    return { x: w * (0.5 - this.shift), y: h * (0.5 - this.lift), r: (h * 0.5 * Math.tan(limb)) / half };
  }

  #applyShift() {
    const { w, h } = this.size;
    if ((Math.abs(this.shift) < 1e-4 && Math.abs(this.lift) < 1e-4) || !w) this.camera.clearViewOffset();
    else this.camera.setViewOffset(w, h, this.shift * w, this.lift * h, w, h);
    this.camera.updateProjectionMatrix();
  }

  /**
   * The camera half of settling: down from the whole globe to the working
   * view. Silent, because the page decided to do it — counting it as a
   * gesture would retire the hint that has not been earned yet.
   */
  settle(ms = STYLE.camera.settleMs, { dist, turn } = {}) {
    // Off the stage (the only flight that turns onward): hold the one-off
    // work until the planet has landed.
    if (turn) this.quiet(ms + 300);
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
    // Off the landing stage the planet turns on into the working view rather
    // than swinging back to a fixed longitude: onward in the direction it is
    // already drifting, by `turn` degrees, and only a little north. A fixed
    // target could lie behind the drift, and then the globe spun backwards.
    const target = turn
      ? { lat: STAGE_EXIT_LAT, lon: this.controls.lon + (STYLE.motion.direction < 0 ? -turn : turn) }
      : STYLE.camera.work;
    this.controls.flyTo({ ...target, ...(dist ? { dist } : {}), ms, silent: true, arc: 0, spinInto: true, ease: turn ? "cubic" : "quad" });
    // A globe framed low on the landing stage comes back to centre *on the
    // flight's own curve*, frame for frame, rather than gliding there on a
    // clock of its own: two easings side by side read as the planet sliding
    // one way while the camera pulls another, where one curve reads as a
    // single camera move.
    this.liftFollow = Math.abs(this.lift) > 1e-4 ? { from: this.lift, flight: this.controls.flight } : null;
    if (this.liftFollow) this.liftTarget = this.lift;
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

  /** The resolution the buffer is drawn at: the scaler's, or full at rest. */
  #drawRes() {
    return this.atRest ? 1 : this.res;
  }

  /**
   * Full resolution when nothing is being moved by hand or by a flight, the
   * scaler's figure while something is. The idle drift counts as rest: it is
   * a fraction of a degree a second, and the scaler's softness is for a thumb.
   */
  #syncRest(rest) {
    if (rest === this.atRest) return;
    const before = this.#drawRes();
    this.atRest = rest;
    if (this.#drawRes() === before) return;
    this.skipSample = true;
    this.frames.length = 0;
    this.renderer.setPixelRatio(this.dpr * this.#drawRes());
    this.renderer.setSize(this.size.w, this.size.h, false);
    // Coming to rest, the vector window is repainted at the sharper buffer.
    // Going the other way it is not: a window with more texels than the
    // buffer is still correct, and a repaint there is the frame a pinch drops.
    if (rest) this.painter.painted = null;
    this.dirty = true;
  }

  /**
   * How much the tile imagery is wanted, 0 to 1: by zoom, as it always was,
   * or by how far the painted base is being magnified, whichever asks more.
   */
  #detailNeed(z, arm = false) {
    const texels = this.hd ? BASE_TEXELS.hd : BASE_TEXELS.sd;
    const mag = (this.controls.pxPerDeg * Math.min(this.dpr, 2) * 360) / texels;
    if (arm) return z >= DETAIL_ARM || mag >= DETAIL_MAG_ARM;
    return Math.max(smoothstep(DETAIL_IN[0], DETAIL_IN[1], z), smoothstep(DETAIL_MAG[0], DETAIL_MAG[1], mag));
  }

  #resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    if (w === this.size.w && h === this.size.h) return;
    this.size = { w, h };
    this.dpr = drawDpr();
    this.renderer.setPixelRatio(this.dpr * this.#drawRes());
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

  /**
   * The ground actually on screen, found by casting a grid of rays through
   * the frame onto the sphere — for the tile window, which pays for every
   * degree it is given.
   *
   * viewBounds models the view as an ellipse round the camera's centre, which
   * is right for the whole disc and wrong for a tall phone looking at
   * northern latitudes: the ellipse's top corners reach far enough north that
   * a degree of arc there is more than the cosine allows, it gives up and
   * returns the whole width of the world, and the tile budget is spent
   * on 360 degrees of longitude nobody can see — a whole level softer than
   * the screen. The lift and shift are in the projection, so the rays see
   * the planet exactly where it is drawn.
   *
   * So is the band along a visible limb (TILE_FACING). The polar caps are
   * left to the painted base too (TILE_LAT). A pole in frame
   * is every longitude at once, and one Mercator rectangle that has to hold
   * all of them is a level or two softer over everything else on screen —
   * for sea ice seen edge-on at the rim.
   */
  #screenBounds() {
    const cam = this.camera;
    cam.updateMatrixWorld();
    const o = cam.position;
    const oo = o.lengthSq();
    const dir = this.#ray ?? (this.#ray = new Vector3());
    const p = this.#rayHit ?? (this.#rayHit = new Vector3());
    const c = vec3ToLatLon(o);
    let latMin = 90;
    let latMax = -90;
    let dMin = 180;
    let dMax = -180;
    const N = 12;
    for (let i = 0; i <= N; i++) {
      for (let j = 0; j <= N; j++) {
        dir.set((i / N) * 2 - 1, (j / N) * 2 - 1, 0.5).unproject(cam).sub(o).normalize();
        const b = o.dot(dir);
        const disc = b * b - (oo - 1);
        // Sky, or ground seen nearly edge-on toward the rim: squeezed to a
        // sliver on screen, where the painted base is already as sharp as it
        // can look. Counting it is what dragged the window round the far side
        // of the planet whenever the limb was in frame.
        if (disc < 0) continue;
        p.copy(dir).multiplyScalar(-b - Math.sqrt(disc)).add(o);
        if (-dir.dot(p) < TILE_FACING) continue;
        const g = vec3ToLatLon(p);
        latMin = Math.min(latMin, Math.max(g.lat, -TILE_LAT));
        latMax = Math.max(latMax, Math.min(g.lat, TILE_LAT));
        if (Math.abs(g.lat) > TILE_LAT) continue;
        const d = wrapDelta(c.lon, g.lon);
        dMin = Math.min(dMin, d);
        dMax = Math.max(dMax, d);
      }
    }
    if (dMin > dMax || latMin > latMax) return viewBounds(c.lat, c.lon, visibleExtent(this.controls.camDist, cam.fov, cam.aspect), 1.02);
    if (dMax - dMin >= 359) return { lonMin: -180, lonSpan: 360, latMin, latSpan: latMax - latMin };
    return { lonMin: c.lon + dMin, lonSpan: dMax - dMin, latMin, latSpan: latMax - latMin };
  }

  #ray = null;
  #rayHit = null;

  #serviceVectors(immediate = false) {
    const { bounds } = this.#bounds();
    const ppd = this.controls.pxPerDeg * this.dpr * this.#drawRes();
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
      // The flight off the stage draws on the ink it already has — the
      // window painted for the stage and the whole-globe base under it — and
      // repaints once it lands, rather than rasterising mid-move.
      if (this.#quiet(now)) return;
      if (now - this.lastPaint < MOTION_PAINT_MS) return;
      const quality = this.handheld || this.painter.stats.lastMs > 26 ? 0.4 : 0.6;
      if (this.handheld && !this.painter.needsRepaint(bounds, ppd, centre, { loose: true, quality })) return;
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
    if (!this.imagery.enabled || !this.#detailNeed(z, true)) return;
    const now = performance.now();
    // Nothing on the landing stage, which shows the painted planet only, and
    // nothing during the flight off it (see quiet()): a tile window arriving
    // mid-flight is a canvas upload in the middle of the move, which is the
    // hitch. The tiles stream once the planet has landed and fade in on their
    // own long clock, so arriving a moment later costs nothing that shows.
    if (this.detailHeld || this.#quiet(now)) return;
    // Filming (setFilming) wants the ground sharp on every frame of the move,
    // not a level soft until it stops: the take is the move.
    if (this.filming) immediate = true;
    const moving = this.controls.dragging || this.idleFrames < 2;
    if (!immediate && moving && now - this.lastTiles < DETAIL_MOTION_MS) return;

    // Sharp tiles are fetched for ground you are looking at, not for ground
    // you are travelling through. A fly-in crosses six or seven zoom levels in
    // under two seconds and every one of them is a full window — five hundred
    // requests to arrive somewhere that needs eighty. So while the distance is
    // changing only the backstop streams (two levels up, a sixteenth of the
    // tiles): the ground keeps coming into focus under the zoom instead of
    // waiting for it to stop, and the sharp level resolves over it at rest.
    const dist = this.controls.camDist;
    const zooming = Math.abs(dist - this.tileDist) > dist * 0.004;
    this.tileDist = dist;

    const bounds = this.#screenBounds();
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
        // At most two texels a point. A phone's third is a zoom level more of
        // tiles — four times the requests, and a canvas four times the size
        // re-sent whenever the window moves — for a sharpness the eye does
        // not get back at arm's length.
        pxPerDeg: this.controls.pxPerDeg * Math.min(this.dpr, 2),
        centre: { lat: this.controls.lat, lon: this.controls.lon },
        coarse: !immediate && zooming,
        lazy: this.handheld && !immediate && moving,
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
    // y down, like the shader's own coordinates: a lift raises the centre,
    // which is a *smaller* y.
    u.uCentre.value.set(buffer.x * (0.5 - this.shift), buffer.y * (0.5 - this.lift));
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

    // Held on its last frame (the style editor's still captures): nothing
    // moves and nothing is drawn, and the clock comes back without a jump.
    if (this.frozen) {
      this.last = now;
      return;
    }

    // Covered, or in a background tab. The clock is kept honest so the first
    // frame back does not integrate a two-minute dt into the drift.
    if (this.covered || document.hidden) {
      this.last = now;
      // Nobody is watching the framing glide home, so it lands at once:
      // otherwise a hero left for a dialog comes back still off-centre.
      if (this.liftFollow || this.stageOut) {
        this.liftFollow = null;
        this.stageOut = null;
        this.liftTarget = 0;
      }
      if (this.shift !== this.shiftTarget || this.lift !== this.liftTarget) {
        this.shift = this.shiftTarget;
        this.lift = this.liftTarget;
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
      this.shift = Math.abs(d) < 5e-4 ? this.shiftTarget : this.shift + d * (1 - Math.exp(-dt / (this.shiftTau ?? 0.42)));
      this.#applyShift();
      this.dirty = true;
    }
    if (this.stageOut) {
      const o = this.stageOut;
      if (this.controls.flight) {
        // A flight took over — a pin, a search. The rest of the way to the
        // centre rides it, as a settle would.
        this.stageOut = null;
        this.liftFollow = { from: this.lift, flight: this.controls.flight };
      } else {
        o.t = Math.min(o.t + dt * 1000, o.ms);
        const k = 1 - Math.pow(1 - o.t / o.ms, 3);
        this.lift = this.liftTarget = o.lift * (1 - k);
        if (o.to !== null) {
          if (Math.abs(this.controls.target.dist - o.last) > 1e-6) o.to = null;
          else this.controls.target.dist = o.last = o.from + (o.to - o.from) * k;
        }
        if (o.t >= o.ms) this.stageOut = null;
        this.#applyShift();
        this.dirty = true;
      }
    }
    // Riding a settle: the lift is wherever the flight has got to. If the
    // flight is taken over part way — a hand on the globe — the rest of the
    // way is the ordinary glide.
    if (this.liftFollow) {
      const { from, flight } = this.liftFollow;
      if (this.controls.flight === flight || flight.t >= flight.ms) {
        const k = flight.ease(flight.t / flight.ms);
        this.lift = this.liftTarget = from * (1 - k);
        if (flight.t >= flight.ms) this.lift = this.liftTarget = 0;
      } else {
        this.liftTarget = 0;
      }
      if (this.controls.flight !== flight) this.liftFollow = null;
      this.#applyShift();
      this.dirty = true;
    } else if (this.liftTween?.to === this.liftTarget && this.lift !== this.liftTarget) {
      const { from, t0, ms } = this.liftTween;
      const k = Math.min((performance.now() - t0) / ms, 1);
      // Away at once and a long, quiet settle — the headline's own ease, so
      // the planet and the words arrive as one movement. (It starts while
      // the planet is still fading up, so the quick start is never a jolt.)
      const e = 1 - (1 - k) ** 3.6;
      this.lift = k >= 1 ? this.liftTarget : from + (this.liftTarget - from) * e;
      if (k >= 1) this.liftTween = null;
      this.#applyShift();
      this.dirty = true;
    } else if (this.lift !== this.liftTarget) {
      // The lift rides a sheet coming up, so it keeps a sheet's pace unless
      // told otherwise.
      const d = this.liftTarget - this.lift;
      this.lift = Math.abs(d) < 5e-4 ? this.liftTarget : this.lift + d * (1 - Math.exp(-dt / (this.liftTau ?? 0.14)));
      this.#applyShift();
      this.dirty = true;
    }

    const moved = this.controls.update(dt);
    // A hold on the tiles (quiet) is otherwise only looked at during a pass,
    // and passes stop once the camera is still: a flight that lands inside
    // its hold — the find bar's asks for a fixed 3.6 s — left the tiles held
    // for good and the ground a smear of the base texture. Looked at every
    // frame while it lasts, so its end asks for a pass (#quiet).
    if (this.quietMove) this.#quiet(now);
    if (moved) {
      this.idleFrames = 0;
      this.settleTimer = 0;
    } else {
      this.idleFrames++;
      this.settleTimer += dt * 1000;
    }
    const drifting = this.controls.spinning && !this.controls.dragging;
    const c0 = this.controls;
    const zoomEasing = Math.abs(c0.target.dist - c0.dist) > c0.dist * 1e-4;
    if (c0.dragging || c0.pointers?.size || c0.flight || zoomEasing || (moved && !drifting) || this.stageOut) this.busyAt = now;
    this.#syncRest(now - this.busyAt > REST_SHARP_MS);

    // The sheet is a fair-weather cloud layer: it thins as you come in so the
    // ground stays readable, and drifts slowly enough to notice only if you
    // stop and look.
    const gs = STYLE.globe;
    // A frame-by-frame render sets the drift itself, from the timeline's clock.
    if (this.filming !== "step") this.drift = (this.drift + dt * gs.clouds.drift) % 1;
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
    // The photographic sheet is in place before the first frame (start), or
    // never arrived and the synthetic one stays: either way it does not change.
    const real = (this.themeDef?.clouds.real ?? 0) * this.clouds.realReady;
    c.uRealMix.value = real;
    const cloudBase = lerp(this.cloudBase, this.themeDef?.clouds.realOpacity ?? this.cloudBase, real);
    c.uOpacity.value = lerp(cloudBase, 0, smoothstep(gs.clouds.fadeStart, gs.clouds.fadeEnd, z));
    // Faded out, the sheet is not drawn at all: below thirty-five kilometres
    // the camera is inside it, looking at its underside.
    this.clouds.mesh.visible = this.cloudsShown && (c.uOpacity.value > 0.002 || this.controls.camDist - 1 > 0.006);

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
    const wanted = this.imagery.enabled && !this.detailHeld
      // Coverage only gates the *start*: past a tile or two the canvas carries
      // its own presence in its alpha, so the fade does not have to wait for a
      // window to be complete before it will show any of it.
      ? this.#detailNeed(z) * smoothstep(0.0, 0.25, this.imagery.coverage)
      : 0;
    // A frame-by-frame render waits for every frame's tiles, so the fade is
    // landed rather than eased: otherwise it would depend on the wait.
    if (this.filming === "step") this.detailMix = wanted;
    else this.detailMix += (wanted - this.detailMix) * (1 - Math.exp(-dt / DETAIL_TAU));
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
    } else if (this.labels.busy) {
      // The camera is still but markers are still fading in or out: they
      // need passes until they land, or they would freeze half-faded.
      this.labels.update({
        camera: this.camera,
        controls: this.controls,
        width: this.size.w,
        height: this.size.h,
        capRadius: this.#bounds().cap,
      });
    } else if (this.settleTimer > SETTLE_MS && this.settleTimer < SETTLE_MS + 400) {
      this.settleTimer = SETTLE_MS + 500;
      this.#serviceVectors(true);
      this.#serviceImagery(this.controls.zoom, true);
    }

    // Tiles fading in are sent to the GPU a slot at a time, just before the
    // frame that shows them.
    this.imagery.frame(now);
    this.render();
  };
}

export { distForZoom, zoomLevel };
