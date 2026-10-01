/**
 * The Style Sandbox panel: a lil-gui over STYLE.
 *
 * Every control is bound straight to the live STYLE object, so the panel has
 * no state of its own to keep in step — a control writes STYLE, and a batched
 * applyStyle() (at most once a frame; the vector repaint and sphere rebuilds
 * at most every HEAVY_MS) pushes it into the page. Undo, presets, A/B and
 * import all work the same way: overwrite STYLE in place, refresh the
 * displays, apply.
 *
 * Theme-specific folders are bound to STYLE.themes[theme] for whichever theme
 * the page is showing, and the whole panel is rebuilt when that changes.
 *
 * STYLE is the look of the scene on screen — the landing screen or the
 * working view (style/landing.js) — so every folder edits that scene, and
 * "original" means that scene's shipped look. The Scene control moves the
 * page between the two; the landing folder holds what only the landing
 * screen has: where its planet stands, how big, and the headline over it.
 */
import GUI from "lil-gui";

import { STYLE } from "../../style/styleConfig.js";
import {
  HEADLINE,
  LANDING_DEFAULTS,
  STAGE,
  STAGE_EXIT,
  applyHeadline,
  currentScene,
  landingPayload,
  loadLanding,
  onScene,
  sceneDefaults,
  sceneStyle,
  setSceneStyle,
} from "../../style/landing.js";
import { applyStyle, mergeInto } from "../../style/applyStyle.js";
import { History, download, exportJson, loadStore, parseImport, saveStore, screenshot } from "./tools.js";
import { Capture } from "./capture.js";

/** Groups whose restyle does real work (a vector repaint, a new sphere). */
const HEAVY = new Set(["lines", "globe"]);
const HEAVY_MS = 120;

const get = (obj, path) => path.reduce((o, k) => o[k], obj);

export class StylePanel {
  constructor(app) {
    this.app = app;
    this.store = loadStore();
    this.history = new History();
    this.pending = new Set();
    this.raf = 0;
    this.lastHeavy = 0;
    this.sliders = new WeakMap();
    this.closedState = new Map();
    this.ab = false;
    this.abStash = null;
    this.capture = new Capture(this);
    this.ui = {
      scene: currentScene(),
      theme: this.theme,
      ab: false,
      presetName: "",
      preset: "",
      note: this.store.note || "",
      shotScale: 2,
      cleanChrome: false,
    };
  }

  get theme() {
    return "dark";
  }

  get globe() {
    return this.app.globe;
  }

  mount() {
    this.history.commit();
    this.#build();
    this.#bindKeys();
    this.#bindFineDrag();
    // A scene arriving is a whole new STYLE under the same controls: show
    // it, and start the undo history over, since undoing into the other
    // scene's look would make no sense.
    onScene((name) => {
      this.ui.scene = name;
      this.history = new History();
      this.history.commit();
      this.#refresh();
      this.#lockScene(false);
    });
    return this;
  }

  /* ------------------------------------------------------------ building */

  #build() {
    const gui = new GUI({ title: "Style Sandbox", width: 340, container: document.body });
    gui.domElement.classList.add("tsbx");
    this.gui = gui;
    this.ui.theme = this.builtFor = this.theme;
    this.bg = {};

    this.#toolbar(gui);
    this.capture.build(gui);
    this.#landing(gui);
    this.#background(gui);
    this.#camera(gui);
    this.#lighting(gui);
    this.#surface(gui);
    this.#clouds(gui);
    this.#atmosphere(gui);
    this.#grade(gui);
    this.#markers(gui);
    this.#post(gui);

    this.#placePanel();
    this.#makeDraggable();
    this.#restoreFolders();
    this.#syncVisibility();
    if (this.ab) this.#lockForAB(true);
  }

  #rebuild() {
    this.#saveFolders();
    const scroll = this.gui.$children.scrollTop;
    const hidden = this.gui.domElement.style.display === "none";
    this.gui.destroy();
    this.#build();
    this.gui.$children.scrollTop = scroll;
    if (hidden) this.gui.domElement.style.display = "none";
  }

  /** A folder that knows which parts of STYLE it covers, with a ↺ reset in its title. */
  #folder(parent, title, paths = []) {
    const f = parent.addFolder(title);
    f.paths = paths;
    if (paths.length) {
      const b = document.createElement("span");
      b.className = "tsbx-reset";
      b.title = `Reset "${title}" to the original`;
      b.textContent = "↺";
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.#resetFolder(f);
      });
      f.$title.appendChild(b);
    }
    return f;
  }

  /** Control factories bound to one restyle group. */
  #ctl(group) {
    const wire = (c, after) => {
      c.onChange(() => {
        this.#schedule(group);
        after?.();
      });
      c.onFinishChange(() => this.#commit());
      if (c.$slider) this.sliders.set(c.$slider, c);
      return c;
    };
    return {
      num: (f, obj, key, min, max, step, name, after) => wire(f.add(obj, key, min, max, step).name(name ?? key), after),
      color: (f, obj, key, name, after) => wire(f.addColor(obj, key).name(name ?? key), after),
      bool: (f, obj, key, name, after) => wire(f.add(obj, key).name(name ?? key), after),
      pick: (f, obj, key, options, name, after) => wire(f.add(obj, key, options).name(name ?? key), after),
      // Text applies when it is committed (Enter or blur), not per keystroke.
      text: (f, obj, key, name, after) =>
        f
          .add(obj, key)
          .name(name ?? key)
          .onFinishChange(() => {
            this.#schedule(group);
            after?.();
            this.#commit();
          }),
    };
  }

  #button(f, name, fn, keep = false) {
    const c = f.add({ run: fn }, "run").name(name);
    c.keep = keep;
    return c;
  }

  /* ------------------------------------------------------------- toolbar */

  #toolbar(gui) {
    const t = gui.addFolder("Sandbox");
    t.domElement.classList.add("tsbx-toolbar");

    if (this.app.hasLanding) {
      this.sceneCtrl = t.add(this.ui, "scene", { "Landing page": "landing", "Main page": "main" }).name("Editing scene");
      this.sceneCtrl.keep = true;
      this.sceneCtrl.onChange((v) => this.#goScene(v));
    }

    this.abCtrl = t.add(this.ui, "ab").name("A/B: show original");
    this.abCtrl.keep = true;
    this.abCtrl.onChange((v) => this.#setAB(v));

    this.#button(t, "Undo  (⌘Z)", () => this.undo());
    this.#button(t, "Redo  (⇧⌘Z)", () => this.redo());
    this.#button(t, "Reset all to original", () => this.resetAll());

    const p = t.addFolder("Presets");
    p.add(this.ui, "presetName").name("New preset name");
    this.#button(p, "Save current as preset", () => this.#savePreset());
    this.presetCtrl = p.add(this.ui, "preset", this.#presetOptions()).name("Preset");
    this.#button(p, "Load preset", () => this.#loadPreset());
    this.#button(p, "Delete preset", () => this.#deletePreset());

    const x = t.addFolder("Export / import");
    const note = x.add(this.ui, "note").name("Note");
    note.onChange((v) => {
      this.store.note = v;
      saveStore(this.store);
    });
    this.#button(x, "Export JSON file", () => {
      download(exportJson(this.ui.note, this.theme));
      this.toast("Downloaded terra-style-settings.json");
    });
    this.#button(x, "Copy JSON to clipboard", async () => {
      try {
        await navigator.clipboard.writeText(exportJson(this.ui.note, this.theme));
        this.toast("Copied the full settings JSON");
      } catch {
        this.toast("The clipboard is not available here", true);
      }
    });
    this.#button(x, "Import JSON file…", () => this.#importFile());
    this.#button(x, "Paste JSON…", () => this.#pasteDialog());

    const s = t.addFolder("Screenshot");
    s.add(this.ui, "shotScale", { "1×": 1, "2×": 2, "4×": 4 }).name("Resolution").keep = true;
    this.#button(s, "Save PNG", () => this.#shoot(), true);

    const clean = t.add(this.ui, "cleanChrome").name("Hide app chrome");
    clean.keep = true;
    clean.onChange((v) => document.body.classList.toggle("tsbx-clean", v));

    const hint = document.createElement("div");
    hint.className = "tsbx-hint";
    hint.textContent =
      "Every folder edits the scene on screen · H hides this panel · Shift-drag a slider for fine steps · drag the title to move";
    t.$children.appendChild(hint);
  }

  /* ------------------------------------------------------------- landing */

  #landing(gui) {
    if (!this.app.hasLanding) return;
    const f = this.gui.addFolder("Landing planet & headline");
    this.landingFolder = f;
    const b = document.createElement("span");
    b.className = "tsbx-reset";
    b.title = "Reset the landing planet and headline to the original";
    b.textContent = "↺";
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      loadLanding(structuredClone(LANDING_DEFAULTS));
      this.app.restage({ fly: true });
      this.#refresh();
    });
    f.$title.appendChild(b);

    const note = document.createElement("div");
    note.className = "tsbx-hint";
    note.textContent = "Shows on the landing page — switch the scene above to see it.";
    f.$children.appendChild(note);

    // Not STYLE: these go straight to the page, with no undo.
    const stage = (c) => c.onChange(() => this.app.restage());
    const fly = (c) => c.onFinishChange(() => this.app.restage({ fly: true }));
    const head = (c) => c.onChange(() => applyHeadline());

    const pl = f.addFolder("Planet size & position");
    stage(pl.add(STAGE, "scale", 0.4, 2.5, 0.01).name("Size (× fit to corners)"));
    stage(pl.add(STAGE, "rim", 0.1, 0.9, 0.005).name("Top of planet (× height)"));
    stage(pl.add(STAGE, "x", -0.5, 0.5, 0.005).name("Offset right (× width)"));
    stage(pl.add(STAGE, "maxSize", 1, 6, 0.05).name("Largest fit (× height)"));
    stage(pl.add(STAGE, "minRim", 0, 600, 1).name("Sky above, at least (px)"));
    stage(pl.add(STAGE, "spin", 0, 6, 0.05).name("Spin speed (deg/s)"));
    fly(pl.add(STAGE.home, "lat", -87, 87, 0.5).name("Facing latitude"));
    fly(pl.add(STAGE.home, "lon", -180, 180, 0.5).name("Facing longitude"));
    pl.add(STAGE, "rise", 0, 0.5, 0.005).name("Rises in from (× height)");
    this.#button(pl, "Fly back to the landing view", () => this.app.restage({ fly: true }), true);

    const hd = f.addFolder("Headline");
    head(hd.add(HEADLINE, "size", 0.5, 1.6, 0.01).name("Size (×)"));
    head(hd.add(HEADLINE, "raise", -200, 300, 1).name("Move up (px)"));
    head(hd.add(HEADLINE, "fade", 0, 1, 0.01).name("Opacity at the planet"));
    head(hd.add(HEADLINE, "glow", 0, 4, 0.01).name("Glow strength"));
    head(hd.add(HEADLINE, "stroke", 0, 3, 0.01).name("“anywhere.” outline (×)"));
    head(hd.add(HEADLINE, "aura", 0, 3, 0.01).name("“anywhere.” colour glow (×)"));
    head(hd.add(HEADLINE, "fill", 0, 1, 0.01).name("“anywhere.” fill strength"));

    const ex = f.addFolder("Transition to the main page");
    ex.add(STAGE_EXIT, "ms", 200, 8000, 50).name("Duration (ms)");
    ex.add(STAGE_EXIT, "dist", 1.2, 4.45, 0.01).name("Lands at distance");
    ex.add(STAGE_EXIT, "turn", -180, 180, 1).name("Turns on by (deg)");
  }

  #goScene(name) {
    if (name === currentScene()) return;
    if (this.ab) this.#setAB(false);
    // Controls held still while the look blends, so an edit is not lost
    // under it; the scene arriving lets go (mount, onScene).
    this.#lockScene(true);
    if (name === "landing") this.app.showLanding();
    else this.app.showMain();
    if (currentScene() !== name) {
      // Nothing moved (the page was not in a state to): say so, and let go.
      this.#lockScene(false);
      this.ui.scene = currentScene();
      this.sceneCtrl?.updateDisplay();
      return this.toast("That scene is not available right now", true);
    }
    this.toast(name === "landing" ? "Editing the landing page" : "Editing the main page");
  }

  #lockScene(on) {
    for (const c of this.gui.controllersRecursive()) if (!c.keep) c.enable(!on);
  }

  /* ---------------------------------------------------------- background */

  #background(gui) {
    const T = ["themes", this.theme, "background"];
    const b = get(STYLE, T);
    const c = this.#ctl("background");
    const f = this.#folder(gui, "Background & scene", [T]);
    const sync = () => this.#syncVisibility();

    c.pick(f, b, "mode", { Solid: "solid", "Linear gradient": "linear", "Radial gradient": "radial", Transparent: "transparent" }, "Background mode", sync);
    c.color(f, b, "page", "Page colour (--paper)");
    this.bg.solid = c.color(f, b, "solid", "Solid colour");

    const lin = (this.bg.linear = this.#folder(f, "Linear gradient", [[...T, "linear"]]));
    c.color(lin, b.linear, "top", "Top");
    c.color(lin, b.linear, "bottom", "Bottom");
    c.num(lin, b.linear, "angle", 0, 360, 1, "Angle (deg)");

    const rad = (this.bg.radial = this.#folder(f, "Radial gradient", [[...T, "radial"]]));
    c.color(rad, b.radial, "center", "Centre");
    c.color(rad, b.radial, "mid", "Middle");
    c.color(rad, b.radial, "edge", "Edge");
    c.num(rad, b.radial, "midStop", 0, 100, 1, "Middle stop (%)");
    c.num(rad, b.radial, "width", 10, 200, 1, "Width (%)");
    c.num(rad, b.radial, "height", 10, 200, 1, "Height (%)");
    c.num(rad, b.radial, "x", 0, 100, 0.5, "Centre x (%)");
    c.num(rad, b.radial, "y", 0, 100, 0.5, "Centre y (%)");

    c.pick(f, b, "pattern", { Stars: "stars", "Dot grid": "dots", None: "none" }, "Pattern layer", sync);

    const st = (this.bg.stars = this.#folder(f, "Starfield", [[...T, "stars"]]));
    c.pick(st, b.stars, "source", { "Baked texture": "texture", Generated: "generated" }, "Source", sync);
    this.bg.gen = [
      c.num(st, b.stars, "count", 0, 8000, 10, "Count (generated)"),
      c.num(st, b.stars, "radius", 0.2, 4, 0.05, "Star size (generated)"),
      c.color(st, b.stars, "color", "Colour (generated)"),
      c.num(st, b.stars, "seed", 1, 999, 1, "Seed (generated)"),
    ];
    c.num(st, b.stars, "opacity", 0, 1, 0.01, "Opacity");
    c.num(st, b.stars, "size", 128, 2048, 1, "Tile size (px)");
    c.num(st, b.stars, "drift", 0, 200, 0.5, "Drift speed (px/s)");
    c.num(st, b.stars, "twinkle", 0, 1, 0.01, "Twinkle depth");
    c.num(st, b.stars, "twinkleSpeed", 0.5, 20, 0.1, "Twinkle period (s)");

    const dt = (this.bg.dots = this.#folder(f, "Dot grid", [[...T, "dots"]]));
    c.color(dt, b.dots, "color", "Colour");
    c.num(dt, b.dots, "alpha", 0, 1, 0.01, "Dot alpha");
    c.num(dt, b.dots, "size", 0.2, 6, 0.1, "Dot radius (px)");
    c.num(dt, b.dots, "spacing", 4, 96, 1, "Spacing (px)");
    c.num(dt, b.dots, "opacity", 0, 1, 0.01, "Layer opacity");
    c.num(dt, b.dots, "fadeInner", 0, 100, 1, "Clear to (%)");
    c.num(dt, b.dots, "fadeOuter", 0, 100, 1, "Full from (%)");

    const gr = this.#folder(f, "Paper grain", [[...T, "grain"]]);
    c.bool(gr, b.grain, "enabled", "On");
    c.num(gr, b.grain, "opacity", 0, 0.3, 0.001, "Opacity");
    c.num(gr, b.grain, "size", 50, 1200, 1, "Tile size (px)");

    const fog = STYLE.fog;
    const fc = this.#ctl("fog");
    const ff = this.#folder(f, "Fog (over the globe)", [["fog"]]);
    fc.bool(ff, fog, "enabled", "On");
    fc.pick(ff, fog, "mode", { Linear: "linear", "Exponential²": "exp2" }, "Mode");
    fc.color(ff, fog, "color", "Colour");
    fc.num(ff, fog, "amount", 0, 1, 0.01, "Amount");
    fc.num(ff, fog, "near", 0, 8, 0.01, "Near (earth radii)");
    fc.num(ff, fog, "far", 0, 10, 0.01, "Far (earth radii)");
    fc.num(ff, fog, "density", 0, 1.5, 0.005, "Density (exp²)");
  }

  /* -------------------------------------------------------------- camera */

  #camera(gui) {
    const cam = STYLE.camera;
    const mo = STYLE.motion;
    const f = this.#folder(gui, "Camera & motion", [["camera"], ["motion"]]);
    const c = this.#ctl("camera");
    const m = this.#ctl("motion");

    c.num(f, cam, "fov", 15, 75, 0.1, "Field of view (deg)");
    c.num(f, cam, "minDist", 1.001, 2, 0.001, "Min distance (closest zoom)");
    c.num(f, cam, "maxDist", 2, 10, 0.01, "Max distance (whole globe)");
    c.num(f, cam, "near", 0.001, 0.1, 0.001, "Near plane");
    c.num(f, cam, "far", 10, 200, 1, "Far plane");
    c.num(f, cam, "latLimit", 45, 89.9, 0.1, "Latitude limit (deg)");
    c.num(f, cam, "roll", -45, 45, 0.1, "Tilt / roll (deg)");

    const home = this.#folder(f, "Start view (home)", [["camera", "home"]]);
    c.num(home, cam.home, "lat", -87, 87, 0.1, "Latitude");
    c.num(home, cam.home, "lon", -180, 180, 0.1, "Longitude");
    this.#button(home, "Fly to home", () =>
      this.globe?.flyTo({ lat: cam.home.lat, lon: cam.home.lon, dist: cam.maxDist, ms: 1200 }),
    );

    const work = this.#folder(f, "Settled view (work)", [["camera", "work"]]);
    c.num(work, cam.work, "lat", -87, 87, 0.1, "Latitude");
    c.num(work, cam.work, "lon", -180, 180, 0.1, "Longitude");
    c.num(work, cam.work, "dist", 1.01, 10, 0.01, "Distance");
    c.num(f, cam, "settleMs", 0, 6000, 10, "Settle flight (ms)");
    this.#button(work, "Fly to work view", () => this.globe?.flyTo({ ...cam.work, ms: cam.settleMs }));

    const mf = this.#folder(f, "Auto-rotate & orbit", [["motion"]]);
    m.bool(mf, mo, "autoRotate", "Auto-rotate");
    m.pick(mf, mo, "direction", { Eastward: 1, Westward: -1 }, "Direction");
    m.num(mf, mo, "spinPx", 0, 120, 0.5, "Speed (px of ground/s)");
    m.num(mf, mo, "spinMax", 0, 20, 0.1, "Speed cap (deg/s)");
    m.num(mf, mo, "spinResume", 0, 15, 0.1, "Resume after (s)");
    m.num(mf, mo, "spinFadeStart", 0, 1, 0.01, "Fade out from zoom");
    m.num(mf, mo, "spinFadeEnd", 0, 1, 0.01, "Gone by zoom");
    m.num(mf, mo, "rotateDamping", 0.005, 0.5, 0.001, "Rotate damping (s)");
    m.num(mf, mo, "zoomDamping", 0.005, 0.5, 0.001, "Zoom damping (s)");
    m.num(mf, mo, "rotateSpeed", 0.1, 4, 0.01, "Drag speed");
    m.num(mf, mo, "zoomSpeed", 0.0002, 0.01, 0.0001, "Wheel zoom speed");
    m.num(mf, mo, "throwDecay", 0.0001, 0.2, 0.0001, "Throw decay (left after 1s)");
  }

  /* ------------------------------------------------------------ lighting */

  #lighting(gui) {
    const TL = ["themes", this.theme, "light"];
    const l = get(STYLE, TL);
    const lt = STYLE.lighting;
    const r = STYLE.renderer;
    const f = this.#folder(gui, "Lighting", [TL, ["lighting"], ["renderer"]]);
    const c = this.#ctl("light");
    const s = this.#ctl("lighting");
    const rc = this.#ctl("renderer");

    const sun = this.#folder(f, "Key light (sun)", [TL]);
    c.num(sun, l, "sunAzimuth", -180, 180, 0.1, "Azimuth (0 = toward you)");
    c.num(sun, l, "sunElevation", -90, 90, 0.1, "Elevation (deg)");
    s.bool(sun, lt, "followCamera", "Follow camera");
    c.num(sun, l, "sunMix", 0, 1, 0.01, "Day/night strength");
    c.num(sun, l, "ambient", 0, 1, 0.005, "Ambient floor");
    c.color(sun, l, "night", "Night side colour");
    c.num(sun, l, "termWidth", 0.01, 1.5, 0.01, "Terminator width");
    c.num(sun, l, "termGamma", 0.2, 4, 0.01, "Terminator gamma");

    const spec = this.#folder(f, "Ocean specular", [TL, ["lighting"]]);
    c.num(spec, l, "spec", 0, 2, 0.01, "Intensity");
    s.num(spec, lt, "specPower", 1, 256, 1, "Shininess (power)");
    s.color(spec, lt, "specColor", "Colour");

    const am = this.#folder(f, "Ambient light", [["lighting", "ambient"]]);
    s.color(am, lt.ambient, "color", "Colour");
    s.num(am, lt.ambient, "intensity", 0, 2, 0.01, "Intensity");

    const he = this.#folder(f, "Hemisphere light", [["lighting", "hemisphere"]]);
    s.color(he, lt.hemisphere, "sky", "Sky colour");
    s.color(he, lt.hemisphere, "ground", "Ground colour");
    s.num(he, lt.hemisphere, "intensity", 0, 2, 0.01, "Intensity");

    const fi = this.#folder(f, "Fill light", [["lighting", "fill"]]);
    s.color(fi, lt.fill, "color", "Colour");
    s.num(fi, lt.fill, "intensity", 0, 3, 0.01, "Intensity");
    s.num(fi, lt.fill, "azimuth", -180, 180, 0.5, "Azimuth (0 = toward you)");
    s.num(fi, lt.fill, "elevation", -90, 90, 0.5, "Elevation (deg)");

    const ri = this.#folder(f, "Rim light", [["lighting", "rim"]]);
    s.color(ri, lt.rim, "color", "Colour");
    s.num(ri, lt.rim, "intensity", 0, 5, 0.01, "Intensity");
    s.num(ri, lt.rim, "azimuth", -180, 180, 0.5, "Azimuth (0 = toward you)");
    s.num(ri, lt.rim, "elevation", -90, 90, 0.5, "Elevation (deg)");
    s.num(ri, lt.rim, "power", 0.5, 12, 0.05, "Falloff (power)");

    const hs = this.#folder(f, "Hillshade light", [["lighting", "hillshade"]]);
    s.num(hs, lt.hillshade, "azimuth", 0, 360, 0.5, "Azimuth (from north)");
    s.num(hs, lt.hillshade, "elevation", 5, 90, 0.1, "Elevation (deg)");
    s.num(hs, lt.hillshade, "min", 0, 1, 0.01, "Darkest shade");
    s.num(hs, lt.hillshade, "max", 1, 3, 0.01, "Brightest shade");

    const rf = this.#folder(f, "Renderer", [["renderer"]]);
    rc.pick(
      rf,
      r,
      "toneMapping",
      { None: "None", Linear: "Linear", Reinhard: "Reinhard", Cineon: "Cineon", "ACES Filmic": "ACESFilmic", AgX: "AgX", Neutral: "Neutral" },
      "Tone mapping",
    );
    rc.num(rf, r, "exposure", 0, 4, 0.01, "Exposure (with tone mapping)");
    rc.pick(rf, r, "outputColorSpace", { "Linear (as authored)": "Linear", sRGB: "sRGB" }, "Output colour space");
    rc.num(rf, r, "maxPixelRatio", 0.5, 3, 0.25, "Max pixel ratio");
  }

  /* ------------------------------------------------------------- surface */

  #surface(gui) {
    const T = ["themes", this.theme];
    const sf = get(STYLE, [...T, "surface"]);
    const ln = get(STYLE, [...T, "lines"]);
    const g = STYLE.globe;
    const f = this.#folder(gui, "Globe surface", [[...T, "surface"], [...T, "lines"]]);
    const c = this.#ctl("surface");
    const gc = this.#ctl("globe");
    const lc = this.#ctl("lines");

    const refresh = () => this.#refresh();
    gc.pick(f, g, "baseTexture", { "Blue Marble (NASA)": "/textures/blue-marble.jpg" }, "Base map", refresh);
    gc.text(f, g, "baseTexture", "Base map URL (custom)", refresh);

    const oc = this.#folder(f, "Ocean", [[...T, "surface", "ocean"]]);
    c.color(oc, sf.ocean, "deep", "Deep water");
    c.color(oc, sf.ocean, "mid", "Mid water");
    c.color(oc, sf.ocean, "shelf", "Shelf / shallows");

    const land = this.#folder(f, "Land grade", [[...T, "surface", "land"]]);
    c.num(land, sf.land, "gamma", 0.1, 2, 0.01, "Gamma");
    c.num(land, sf.land, "sat", 0, 3, 0.01, "Saturation");
    c.num(land, sf.land, "gain", 0, 3, 0.01, "Gain");
    c.num(land, sf.land, "lift", -0.2, 0.3, 0.001, "Lift");
    c.color(land, sf, "landTint", "Land colour tint");
    c.num(land, sf, "landTintAmt", 0, 1, 0.01, "Tint amount");
    c.num(f, sf, "relief", 0, 20, 0.1, "Relief (bump strength)");
    c.color(f, sf, "snow", "Snow & ice colour");
    c.num(f, sf, "snowAmt", 0, 1, 0.01, "Snow amount");

    const fa = this.#folder(f, "Facets", [[...T, "surface", "facet"]]);
    c.num(fa, sf.facet, "amount", 0, 1, 0.01, "Amount");
    c.num(fa, sf.facet, "scale", 2, 200, 1, "Cells across the globe");
    c.num(fa, sf.facet, "tilt", 0, 1, 0.01, "Tilt");
    c.num(fa, sf.facet, "flat", 0, 1, 0.01, "Flat colour");
    c.num(fa, sf.facet, "edge", 0, 0.3, 0.001, "Seam width");
    c.num(fa, sf.facet, "edgeInk", -1, 1, 0.01, "Seam ink (− pale, + dark)");
    gc.num(fa, g, "facetFadeStart", 0, 1, 0.01, "Retire from zoom");
    gc.num(fa, g, "facetFadeEnd", 0, 1, 0.01, "Gone by zoom");

    const em = this.#folder(f, "Emissive", [[...T, "surface"]]);
    c.color(em, sf, "emissive", "Colour");
    c.num(em, sf, "emissiveIntensity", 0, 1, 0.005, "Intensity");
    c.bool(em, sf, "emissiveNightOnly", "Night side only");

    const nl = this.#folder(f, "Night lights (cities)", [["globe", "nightLights"]]);
    gc.bool(nl, g.nightLights, "enabled", "On");
    gc.color(nl, g.nightLights, "color", "Colour");
    gc.num(nl, g.nightLights, "intensity", 0, 4, 0.01, "Intensity");
    gc.num(nl, g.nightLights, "size", 0.5, 6, 0.1, "Glow size");

    const gr = this.#folder(f, "Graticule (grid)", [["globe", "graticule"]]);
    gc.bool(gr, g.graticule, "enabled", "On");
    gc.color(gr, g.graticule, "color", "Colour");
    gc.num(gr, g.graticule, "opacity", 0, 1, 0.01, "Opacity");
    gc.num(gr, g.graticule, "spacing", 1, 45, 0.5, "Spacing (deg)");
    gc.num(gr, g.graticule, "width", 0.2, 4, 0.05, "Line width (px)");

    const de = this.#folder(f, "Streamed imagery grade", [[...T, "surface", "detail"]]);
    c.num(de, sf.detail, "gamma", 0.2, 3, 0.01, "Gamma");
    c.num(de, sf.detail, "shadowGamma", 0.2, 3, 0.01, "Gamma in the shadows (land)");
    c.num(de, sf.detail, "sat", 0, 2, 0.01, "Saturation");
    c.num(de, sf.detail, "gain", 0, 2, 0.01, "Gain");
    c.num(de, sf.detail, "lift", -0.2, 0.3, 0.001, "Lift");
    c.num(de, sf.detail, "sea", 0, 2, 0.01, "Sea modulation");

    const ink = this.#folder(f, "Coast, borders & rivers", [[...T, "lines"]]);
    const names = { coast: "Coastline", borders: "Country borders", rivers: "Rivers", lakeEdge: "Lake edges" };
    for (const [key, label] of Object.entries(names)) {
      const lf = this.#folder(ink, label, [[...T, "lines", key]]);
      lc.color(lf, ln[key], "color", "Colour");
      lc.num(lf, ln[key], "width", 0.1, 5, 0.05, "Width (px)");
      lc.num(lf, ln[key], "alpha", 0, 1, 0.01, "Opacity");
    }

    const geo = this.#folder(f, "Geometry & zoom ramps", [["globe"]]);
    gc.num(geo, g, "segments", 16, 512, 1, "Sphere segments");
    gc.num(geo, g, "sunFlattenStart", 0, 1, 0.01, "Daylight flattens from zoom");
    gc.num(geo, g, "sunFlattenEnd", 0, 1, 0.01, "Flat by zoom");
    gc.num(geo, g, "sunFlatten", 0, 1, 0.01, "Flatten amount");
  }

  /* -------------------------------------------------------------- clouds */

  #clouds(gui) {
    const T = ["themes", this.theme, "clouds"];
    const cl = get(STYLE, T);
    const gcl = STYLE.globe.clouds;
    const f = this.#folder(gui, "Clouds", [T, ["globe", "clouds"]]);
    const c = this.#ctl("clouds");
    const gc = this.#ctl("globe");

    gc.bool(f, gcl, "enabled", "On");
    c.color(f, cl, "tint", "Lit colour");
    c.color(f, cl, "shadow", "Shadow colour");
    c.num(f, cl, "opacity", 0, 1, 0.01, "Opacity");
    c.num(f, cl, "sunMix", 0, 1, 0.01, "Lighting strength");
    c.num(f, cl, "fade", 0, 1, 0.01, "Fade with night");
    gc.num(f, gcl, "drift", -0.01, 0.01, 0.00001, "Rotation speed (turns/s)");
    gc.num(f, gcl, "altitude", 0, 0.1, 0.0005, "Altitude (earth radii)");

    const sh = this.#folder(f, "Synthetic sheet shape", [T]);
    c.num(sh, cl, "lo", 0, 1, 0.005, "Cloud from");
    c.num(sh, cl, "hi", 0, 1, 0.005, "Solid at");
    c.num(sh, cl, "gamma", 0.2, 5, 0.01, "Puffiness (gamma)");

    const re = this.#folder(f, "Photographic sheet", [T]);
    c.num(re, cl, "real", 0, 1, 0.01, "Photo mix");
    c.num(re, cl, "realOpacity", 0, 1, 0.01, "Photo opacity");
    c.num(re, cl, "realLo", 0, 1, 0.005, "Cloud from");
    c.num(re, cl, "realHi", 0, 1, 0.005, "Solid at");

    const adv = this.#folder(f, "Detail & zoom fade", [["globe", "clouds"]]);
    gc.num(adv, gcl, "segments", 16, 256, 1, "Shell segments");
    gc.num(adv, gcl, "fadeStart", 0, 1, 0.01, "Thin from zoom");
    gc.num(adv, gcl, "fadeEnd", 0, 1, 0.01, "Gone by zoom");
  }

  /* ---------------------------------------------------------- atmosphere */

  #atmosphere(gui) {
    const T = ["themes", this.theme, "atmosphere"];
    const at = get(STYLE, T);
    const f = this.#folder(gui, "Atmosphere & glow", [T]);
    const c = this.#ctl("atmosphere");

    c.bool(f, at, "enabled", "On");
    const rim = this.#folder(f, "Inner glow (limb haze)", [T]);
    c.color(rim, at, "color", "Colour");
    c.num(rim, at, "fresnel", 0, 1.5, 0.01, "Intensity");
    c.num(rim, at, "fresnelPow", 0.2, 10, 0.05, "Falloff (power)");
    c.num(rim, at, "rimBase", 0, 1, 0.01, "Away from the light");

    const h = at.halo;
    const halo = this.#folder(f, "Outer glow (halo)", [[...T, "halo"]]);
    c.color(halo, h, "inner", "Hot colour");
    c.color(halo, h, "outer", "Edge colour");
    c.num(halo, h, "strength", 0, 5, 0.01, "Rim intensity");
    c.num(halo, h, "spread", 0, 0.5, 0.001, "Rim thickness");
    c.num(halo, h, "rimPower", 0.2, 10, 0.05, "Rim falloff (power)");
    c.num(halo, h, "topBias", 0, 1, 0.001, "Away from the light");
    c.num(halo, h, "falloff", 0.1, 10, 0.01, "Angular falloff");
    c.num(halo, h, "bloom", 0, 4, 0.01, "Bloom intensity");
    c.num(halo, h, "bloomSpread", 0, 3, 0.01, "Bloom reach");
    c.num(halo, h, "spillPower", 0.2, 10, 0.05, "Bloom falloff (power)");
  }

  /* --------------------------------------------------------------- grade */

  #grade(gui) {
    const g = STYLE.grade;
    const f = this.#folder(gui, "Shader grading", [["grade"]]);
    const c = this.#ctl("grade");

    c.bool(f, g, "enabled", "On");
    c.num(f, g, "mix", 0, 1, 0.01, "Graded ↔ ungraded mix");
    c.num(f, g, "brightness", -0.5, 0.5, 0.005, "Brightness");
    c.num(f, g, "contrast", 0, 3, 0.01, "Contrast");
    c.num(f, g, "saturation", 0, 3, 0.01, "Saturation");
    c.num(f, g, "vibrance", -1, 2, 0.01, "Vibrance");
    c.num(f, g, "hue", -180, 180, 0.5, "Hue shift (deg)");
    c.num(f, g, "temperature", -1, 1, 0.01, "Temperature");
    c.num(f, g, "tint", -1, 1, 0.01, "Tint");
    for (const [key, label] of [["lift", "Lift (shadows)"], ["gamma", "Gamma (midtones)"], ["gain", "Gain (highlights)"]]) {
      const w = this.#folder(f, label, [["grade", key]]);
      c.color(w, g[key], "color", "Colour");
      c.num(w, g[key], "strength", -1, 1, 0.005, "Strength");
    }
  }

  /* ------------------------------------------------------------- markers */

  #markers(gui) {
    const T = ["themes", this.theme];
    const m = STYLE.markers;
    const tm = get(STYLE, [...T, "markers"]);
    const lb = STYLE.labels;
    const tl = get(STYLE, [...T, "labels"]);
    const f = this.#folder(gui, "Ministry pins & labels", [["markers"], [...T, "markers"], ["labels"], [...T, "labels"]]);
    const c = this.#ctl("markers");
    const l = this.#ctl("labels");

    const pins = this.#folder(f, "Pins", [["markers"], [...T, "markers"]]);
    c.color(pins, tm, "urgent", "Urgent needs");
    c.color(pins, tm, "normal", "Default");
    c.num(pins, m, "size", 2, 30, 0.5, "Size (px)");
    c.pick(pins, m, "shape", { Circle: "circle", Square: "square", Diamond: "diamond" }, "Shape");
    c.num(pins, m, "opacity", 0, 1, 0.01, "Opacity");
    c.num(pins, m, "dimOpacity", 0, 1, 0.01, "Filtered-out opacity");
    c.num(pins, m, "rim", 0, 6, 0.1, "Rim width (px)");
    c.color(pins, tm, "rimColor", "Rim colour");
    c.num(pins, tm, "rimAlpha", 0, 1, 0.01, "Rim opacity");
    c.color(pins, tm, "shadowColor", "Shadow colour");
    c.num(pins, tm, "shadowAlpha", 0, 1, 0.01, "Shadow opacity");
    c.num(pins, tm, "shadowBlur", 0, 20, 0.5, "Shadow blur (px)");
    c.num(pins, m, "glow", 0, 30, 0.5, "Glow size (px)");
    c.color(pins, tm, "glowColor", "Glow colour");

    const st = this.#folder(pins, "Hover & selected", [["markers"], [...T, "markers"]]);
    c.num(st, m, "hoverScale", 1, 3, 0.01, "Scale on hover");
    c.bool(st, m, "hoverColorOn", "Hover colour on");
    c.color(st, tm, "hoverColor", "Hover colour");
    c.bool(st, m, "activeColorOn", "Selected colour on");
    c.color(st, tm, "activeColor", "Selected colour");
    c.num(st, m, "activeScale", 1, 3, 0.01, "Scale when selected");
    c.num(st, m, "activeRim", 0, 6, 0.1, "Selected rim (px)");
    c.color(st, tm, "activeRimColor", "Selected rim colour");
    c.color(st, tm, "activeShadowColor", "Selected shadow colour");
    c.num(st, tm, "activeShadowAlpha", 0, 1, 0.01, "Selected shadow opacity");

    const pu = this.#folder(pins, "Pulse / ripple", [["markers", "pulse"]]);
    c.pick(pu, m.pulse, "mode", { Off: "off", "Urgent pins": "urgent", "All pins": "all" }, "Pulse");
    c.num(pu, m.pulse, "speed", 0.3, 6, 0.05, "Period (s)");
    c.num(pu, m.pulse, "size", 1.2, 6, 0.05, "Ripple size (× dot)");
    c.color(pu, tm, "pulseColor", "Colour");

    const lf = this.#folder(f, "Labels", [["labels"], [...T, "labels"]]);
    l.pick(
      lf,
      lb,
      "font",
      {
        "Page sans (default)": "",
        "System UI": "system-ui, sans-serif",
        Serif: 'ui-serif, "New York", Georgia, serif',
        Rounded: "ui-rounded, system-ui, sans-serif",
        Mono: "var(--mono)",
      },
      "Font",
    );
    l.num(lf, lb, "chipSize", 8, 24, 0.5, "Pin label size (px)");
    l.color(lf, tl, "chipColor", "Pin label text");
    l.color(lf, tl, "chipBg", "Pin label background");
    l.num(lf, tl, "chipBgAlpha", 0, 1, 0.01, "Pin label bg opacity");
    l.color(lf, tl, "chipHoverBg", "Pin label hover bg");
    l.num(lf, lb, "placeSize", 8, 24, 0.5, "City name size (px)");
    l.color(lf, tl, "placeColor", "City name colour");
    l.color(lf, tl, "placeHalo", "City name halo");
    l.num(lf, tl, "placeHaloAlpha", 0, 1, 0.01, "City halo opacity");
    l.num(lf, lb, "countrySize", 8, 28, 0.5, "Country plate size (px)");
    l.color(lf, tl, "countryColor", "Country plate text");
    l.color(lf, tl, "countryBg", "Country plate bg");
    l.num(lf, tl, "countryBgAlpha", 0, 1, 0.01, "Country plate bg opacity");

    const vis = this.#folder(lf, "Visibility", [["labels"]]);
    l.num(vis, lb, "cityZoom", 0, 1, 0.01, "City names from zoom");
    l.num(vis, lb, "countryZoom", 0, 1, 0.01, "Country plates from zoom");
    l.num(vis, lb, "countryMax", 0, 10, 1, "Max country plates");
    l.num(vis, lb, "pinDensity", 5000, 200000, 500, "Screen area per lettered pin (px²)");
  }

  /* ---------------------------------------------------------------- post */

  #post(gui) {
    const p = STYLE.post;
    const f = this.#folder(gui, "Post processing", [["post"]]);
    const c = this.#ctl("post");

    const bl = this.#folder(f, "Bloom", [["post", "bloom"]]);
    c.bool(bl, p.bloom, "enabled", "On");
    c.num(bl, p.bloom, "strength", 0, 3, 0.01, "Strength");
    c.num(bl, p.bloom, "radius", 0.2, 4, 0.05, "Radius");
    c.num(bl, p.bloom, "threshold", 0, 1.5, 0.01, "Threshold");

    const ca = this.#folder(f, "Chromatic aberration", [["post", "chromatic"]]);
    c.bool(ca, p.chromatic, "enabled", "On");
    c.num(ca, p.chromatic, "amount", 0, 0.03, 0.0001, "Amount");

    const sh = this.#folder(f, "Sharpen (planet face)", [["post", "sharpen"]]);
    c.bool(sh, p.sharpen, "enabled", "On");
    c.num(sh, p.sharpen, "amount", 0, 1.5, 0.01, "Amount");

    c.pick(f, p, "aa", { "MSAA (default)": "msaa", FXAA: "fxaa", None: "none" }, "Anti-aliasing");

    const v = this.#folder(f, "Vignette", [["post", "vignette"]]);
    c.bool(v, p.vignette, "enabled", "On");
    c.num(v, p.vignette, "strength", 0, 1, 0.01, "Strength");
    c.num(v, p.vignette, "radius", 0, 2, 0.01, "Radius");
    c.num(v, p.vignette, "softness", 0.01, 1, 0.01, "Softness");
    c.color(v, p.vignette, "color", "Colour");

    const g = this.#folder(f, "Film grain", [["post", "grain"]]);
    c.bool(g, p.grain, "enabled", "On");
    c.num(g, p.grain, "amount", 0, 0.4, 0.005, "Amount");
    c.num(g, p.grain, "size", 1, 6, 0.1, "Size (px)");
    c.bool(g, p.grain, "animated", "Animated");
  }

  /* ---------------------------------------------------------- behaviour */

  #syncVisibility() {
    const b = STYLE.themes[this.theme].background;
    this.bg.solid?.show(b.mode === "solid");
    this.bg.linear?.show(b.mode === "linear");
    this.bg.radial?.show(b.mode === "radial");
    this.bg.stars?.show(b.pattern === "stars");
    this.bg.dots?.show(b.pattern === "dots");
    for (const c of this.bg.gen || []) c.show(b.stars.source === "generated");
  }

  #refresh() {
    for (const c of this.gui.controllersRecursive()) c.updateDisplay();
    this.#syncVisibility();
  }

  /** Batches changes into one applyStyle per frame; heavy groups at most every HEAVY_MS. */
  #schedule(group) {
    this.pending.add(group);
    if (!this.raf) this.raf = requestAnimationFrame(this.#flush);
  }

  #flush = (now) => {
    this.raf = 0;
    const groups = [...this.pending];
    const heavy = groups.filter((g) => HEAVY.has(g));
    if (heavy.length && now - this.lastHeavy < HEAVY_MS) {
      const light = groups.filter((g) => !HEAVY.has(g));
      if (light.length) applyStyle(STYLE, { groups: light });
      this.pending = new Set(heavy);
      this.raf = requestAnimationFrame(this.#flush);
      return;
    }
    if (heavy.length) this.lastHeavy = now;
    this.pending.clear();
    applyStyle(STYLE, { groups });
  };

  #applyAll() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.pending.clear();
    applyStyle();
  }

  #commit() {
    if (!this.ab) this.history.commit();
  }

  /** Overwrites STYLE in place with `snap`, so every bound control stays bound. */
  #load(snap) {
    mergeInto(STYLE, snap);
    this.#applyAll();
    this.#refresh();
  }

  undo() {
    if (this.ab) return this.toast("Turn A/B off to undo", true);
    const snap = this.history.undo();
    if (snap) this.#load(snap);
  }

  redo() {
    if (this.ab) return this.toast("Turn A/B off to redo", true);
    const snap = this.history.redo();
    if (snap) this.#load(snap);
  }

  resetAll() {
    if (this.ab) return this.toast("Turn A/B off first", true);
    this.#load(sceneDefaults());
    this.#commit();
    this.toast(`Back to the ${currentScene() === "landing" ? "landing page's" : "main page's"} original look`);
  }

  #resetFolder(f) {
    if (this.ab) return this.toast("Turn A/B off first", true);
    const defaults = sceneDefaults();
    for (const p of f.paths) mergeInto(get(STYLE, p), get(defaults, p));
    this.#applyAll();
    this.#refresh();
    this.#commit();
  }

  #setAB(on) {
    if (on === this.ab) return;
    this.ab = on;
    if (on) {
      this.abStash = structuredClone(STYLE);
      mergeInto(STYLE, sceneDefaults());
    } else if (this.abStash) {
      mergeInto(STYLE, this.abStash);
      this.abStash = null;
    }
    this.#applyAll();
    this.#refresh();
    this.#lockForAB(on);
    this.toast(on ? "B: the original look" : "A: your settings");
  }

  #lockForAB(on) {
    for (const c of this.gui.controllersRecursive()) if (!c.keep) c.enable(!on);
    this.gui.domElement.classList.toggle("is-ab", on);
  }

  /* ------------------------------------------------------------- presets */

  #presetOptions() {
    const names = Object.keys(this.store.presets).sort((a, b) => a.localeCompare(b));
    if (!names.includes(this.ui.preset)) this.ui.preset = names[0] ?? "";
    return names.length ? names : { "(no presets yet)": "" };
  }

  #refreshPresets() {
    this.presetCtrl = this.presetCtrl.options(this.#presetOptions());
  }

  #savePreset() {
    const name = this.ui.presetName.trim() || `Preset ${Object.keys(this.store.presets).length + 1}`;
    const { stage, exit, headline } = landingPayload();
    this.store.presets[name] = { savedAt: new Date().toISOString(), scene: currentScene(), style: structuredClone(STYLE), landing: { stage, exit, headline } };
    if (!saveStore(this.store)) return this.toast("Could not write to localStorage", true);
    this.ui.preset = name;
    this.ui.presetName = "";
    this.#refreshPresets();
    this.#refresh();
    this.toast(`Saved preset “${name}”`);
  }

  #loadPreset() {
    const p = this.store.presets[this.ui.preset];
    if (!p) return this.toast("Pick a preset first", true);
    this.#load(structuredClone(p.style));
    if (p.landing) {
      loadLanding(structuredClone(p.landing));
      this.app.restage();
      this.#refresh();
    }
    this.#commit();
    this.toast(`Loaded “${this.ui.preset}”`);
  }

  #deletePreset() {
    const name = this.ui.preset;
    if (!this.store.presets[name]) return this.toast("Pick a preset first", true);
    delete this.store.presets[name];
    saveStore(this.store);
    this.#refreshPresets();
    this.toast(`Deleted “${name}”`);
  }

  /* -------------------------------------------------------------- import */

  #applyImport(text) {
    try {
      const { style, note, warning, landing } = parseImport(text);
      // Start from the original so the file decides every value it has, and
      // anything it lacks comes back as shipped rather than as last edited.
      if (landing && this.app.hasLanding) {
        // A file with both scenes: each goes to its own, and the one on
        // screen shows.
        setSceneStyle("main", mergeInto(sceneDefaults("main"), style));
        loadLanding(landing);
        this.#load(sceneStyle(currentScene()));
        this.app.restage({ fly: true });
      } else {
        // A single look goes to the scene on screen.
        mergeInto(STYLE, sceneDefaults());
        this.#load(style);
      }
      if (note) {
        this.ui.note = note;
        this.store.note = note;
        saveStore(this.store);
        this.#refresh();
      }
      this.#commit();
      this.toast(warning || "Imported settings", !!warning);
      return true;
    } catch (err) {
      this.toast(`Import failed: ${err.message}`, true);
      return false;
    }
  }

  #importFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (file) this.#applyImport(await file.text());
    });
    input.click();
  }

  #pasteDialog() {
    const wrap = document.createElement("div");
    wrap.className = "tsbx-modal";
    wrap.innerHTML = `
      <div class="tsbx-modal__box" role="dialog" aria-label="Paste settings JSON">
        <div class="tsbx-modal__title">Paste settings JSON</div>
        <textarea spellcheck="false" placeholder="{ &quot;version&quot;: 1, &quot;style&quot;: { … } }"></textarea>
        <div class="tsbx-modal__row">
          <button type="button" data-act="cancel">Cancel</button>
          <button type="button" data-act="apply" class="is-primary">Apply</button>
        </div>
      </div>`;
    const close = () => wrap.remove();
    wrap.addEventListener("click", (e) => {
      const act = e.target.dataset?.act;
      if (e.target === wrap || act === "cancel") close();
      if (act === "apply" && this.#applyImport(wrap.querySelector("textarea").value)) close();
    });
    wrap.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
      e.stopPropagation();
    });
    document.body.appendChild(wrap);
    wrap.querySelector("textarea").focus();
    this.modal = wrap;
  }

  /* ---------------------------------------------------------- screenshot */

  async #shoot() {
    if (!this.globe?.earth) return this.toast("The globe has not started", true);
    const scale = Number(this.ui.shotScale) || 1;
    try {
      const blob = await screenshot(this.globe, this.theme, scale);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      download(blob, `terra-globe-${scale}x-${stamp}.png`);
      this.toast(`Saved a ${scale}× PNG`);
    } catch (err) {
      this.toast(`Screenshot failed: ${err.message}`, true);
    }
  }

  /* --------------------------------------------------------------- chrome */

  toast(text, warn = false) {
    let el = document.querySelector(".tsbx-toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "tsbx-toast";
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.toggle("is-warn", warn);
    el.classList.add("is-in");
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove("is-in"), 2600);
  }

  #placePanel() {
    const el = this.gui.domElement;
    const pos = this.store.panel;
    if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
      el.style.left = `${Math.min(Math.max(pos.left, 0), window.innerWidth - 80)}px`;
      el.style.top = `${Math.min(Math.max(pos.top, 0), window.innerHeight - 40)}px`;
      el.style.right = "auto";
    }
  }

  /** Drag by the title bar; a click that did not move still collapses. */
  #makeDraggable() {
    const el = this.gui.domElement;
    const title = this.gui.$title;
    let start = null;
    let dragged = false;

    title.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest(".tsbx-reset")) return;
      const r = el.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      dragged = false;
      title.setPointerCapture(e.pointerId);
    });
    title.addEventListener("pointermove", (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!dragged && Math.hypot(dx, dy) < 4) return;
      dragged = true;
      const left = Math.min(Math.max(start.left + dx, 0), window.innerWidth - 80);
      const top = Math.min(Math.max(start.top + dy, 0), window.innerHeight - 32);
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.right = "auto";
    });
    title.addEventListener("pointerup", () => {
      if (!start) return;
      start = null;
      if (dragged) {
        const r = el.getBoundingClientRect();
        this.store.panel = { left: r.left, top: r.top };
        saveStore(this.store);
      }
    });
    // A drag must not also count as a click on the title, which collapses.
    title.addEventListener(
      "click",
      (e) => {
        if (!dragged) return;
        dragged = false;
        e.stopImmediatePropagation();
        e.preventDefault();
      },
      true,
    );
  }

  #folderKey(f) {
    const parts = [];
    for (let g = f; g && g.parent; g = g.parent) parts.unshift(g._title);
    return parts.join(" / ");
  }

  #saveFolders() {
    for (const f of this.gui.foldersRecursive()) this.closedState.set(this.#folderKey(f), f._closed);
  }

  /** Everything starts collapsed except the toolbar; after that, as you left it. */
  #restoreFolders() {
    for (const f of this.gui.foldersRecursive()) {
      const key = this.#folderKey(f);
      const open = key === "Sandbox" || key === "Landing planet & headline";
      const closed = this.closedState.has(key) ? this.closedState.get(key) : !open;
      f.open(!closed);
    }
  }

  /* ------------------------------------------------------------ keyboard */

  #bindKeys() {
    window.addEventListener(
      "keydown",
      (e) => {
        const t = e.target;
        const inPanel = !!t.closest?.(".tsbx, .tsbx-modal");
        const numberField = inPanel && !!t.closest?.(".lil-number");
        const editingText = t.tagName === "TEXTAREA" || t.isContentEditable || (t.tagName === "INPUT" && !numberField);
        const mod = e.metaKey || e.ctrlKey;

        if (mod && e.key.toLowerCase() === "z" && !editingText) {
          e.preventDefault();
          e.stopPropagation();
          if (e.shiftKey) this.redo();
          else this.undo();
          return;
        }
        if (mod && e.key.toLowerCase() === "y" && !editingText) {
          e.preventDefault();
          this.redo();
          return;
        }
        if (!mod && !e.altKey && e.key.toLowerCase() === "h" && !editingText && !numberField) {
          e.preventDefault();
          e.stopPropagation();
          const el = this.gui.domElement;
          el.style.display = el.style.display === "none" ? "" : "none";
        }
      },
      true,
    );
  }

  /**
   * Slider drags, taken over from lil-gui so that holding Shift makes them
   * fine: the value moves a tenth as far per pixel and snaps to a tenth of
   * the step. Without Shift it tracks the pointer as lil-gui's own does.
   * Pressing or releasing Shift mid-drag re-anchors rather than jumping.
   */
  #bindFineDrag() {
    document.addEventListener(
      "mousedown",
      (e) => {
        const slider = e.target.closest?.(".tsbx .lil-slider");
        const c = slider && this.sliders.get(slider);
        if (!c || c._disabled || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();

        const range = c._max - c._min;
        const width = slider.getBoundingClientRect().width || 1;
        const setClamped = (v, step) => {
          const snapped = Math.round((v - c._min) / step) * step + c._min;
          c.setValue(Math.min(Math.max(parseFloat(snapped.toPrecision(12)), c._min), c._max));
        };
        let fine = e.shiftKey;
        let anchorX = e.clientX;
        let anchorV = c.getValue();
        if (!fine) {
          const r = slider.getBoundingClientRect();
          anchorV = c._min + ((e.clientX - r.left) / width) * range;
          setClamped(anchorV, c._step);
          anchorV = c.getValue();
        }
        c._setDraggingStyle?.(true);

        const move = (ev) => {
          if (ev.shiftKey !== fine) {
            fine = ev.shiftKey;
            anchorX = ev.clientX;
            anchorV = c.getValue();
          }
          const k = fine ? 0.1 : 1;
          setClamped(anchorV + ((ev.clientX - anchorX) / width) * range * k, fine ? c._step / 10 : c._step);
        };
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          c._setDraggingStyle?.(false);
          c._callOnFinishChange();
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      },
      true,
    );
  }
}
