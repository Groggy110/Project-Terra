/**
 * Capture: isolate parts of the page for screen recordings and grabs, put a
 * flat ground behind them, replay the landing entrance on cue, and export
 * straight from the page — a transparent PNG, a frame sequence of the
 * entrance or of the animation timeline (animate.js), or a video over the
 * flat ground.
 *
 * Isolation hides with `visibility`, never `display`, so nothing moves: the
 * search bar on its own sits exactly where it sits on the page.
 *
 * The exports read the tab itself (getDisplayMedia, "this tab"), because the
 * page is DOM and CSS — glass, masks, glows — that no canvas re-render can
 * reproduce faithfully. Transparency is recovered by difference matting: the
 * same frame over black and over white; how far a pixel moves between the two
 * is how see-through it is. Glows, the frosted bar and soft edges all come out
 * with true alpha, with no key colour to fringe.
 */
import { STAGE } from "../../style/landing.js";
import { download } from "./tools.js";

/** What can be isolated. `sel` is looked up live: the app rebuilds parts of its DOM. */
export const TARGETS = [
  { key: "sky", label: "Sky & stars", sel: ".paper" },
  { key: "globe", label: "Globe", sel: "#globe" },
  { key: "pins", label: "Pins & place labels", sel: "#overlay" },
  { key: "shade", label: "Landing floor shade" },
  { key: "topbar", label: "Top bar", sel: ".topbar" },
  { key: "eyebrow", label: "Live count pill", sel: ".hero__eyebrow" },
  { key: "title", label: "Headline", sel: ".hero__title" },
  { key: "search", label: "Search bar", sel: ".search" },
  { key: "filters", label: "Filter chips", sel: ".filters" },
  { key: "crumbs", label: "Breadcrumb", sel: ".crumbs" },
  { key: "dial", label: "Zoom dial", sel: ".dial" },
  { key: "hint", label: "Drag hint", sel: ".hint" },
  { key: "panel", label: "Side panel", sel: ".panel" },
  { key: "sheet", label: "Needs board", sel: ".sheet, .grabber" },
  { key: "toasts", label: "Toasts", sel: ".toasts" },
];

export const PRESETS = {
  "Search bar": ["search"],
  "Search bar + chips": ["search", "filters"],
  Headline: ["title"],
  "Headline + pill": ["title", "eyebrow"],
  "Landing interface": ["topbar", "eyebrow", "title", "search", "filters"],
  "Globe only": ["globe"],
  "Globe + pins": ["globe", "pins"],
  Everything: TARGETS.map((t) => t.key),
};

export const GROUNDS = {
  "As designed": "page",
  Black: "#000000",
  "Green screen": "#00b140",
  "Blue screen": "#0047bb",
  White: "#ffffff",
  Custom: "custom",
};

/** Containers whose children are hidden in isolation unless chosen. */
const UNIVERSE = "body > *, .chrome > *, .hero > *, .findbar > *";
/** Never hidden: the editor itself. */
const OURS = ".tsbx, .tsbx-toast, .tsbx-modal, .tcap-stage, .tcap-crop";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

export class Capture {
  constructor(panel) {
    this.panel = panel;
    this.ui = {
      isolate: false,
      preset: "",
      ground: "page",
      custom: "#ff00ff",
      riseToo: true,
      hidePanel: true,
      delay: 0,
      area: "elements",
      fps: 30,
      length: 0,
      format: window.MediaRecorder?.isTypeSupported?.("video/mp4;codecs=avc1") ? "mp4" : "webm",
      startWith: "entrance",
      alpha: true,
    };
    this.show = Object.fromEntries(TARGETS.map((t) => [t.key, true]));
    this.stream = null;
    this.busy = false;
  }

  get app() {
    return this.panel.app;
  }

  get globe() {
    return this.app.globe;
  }

  /* ------------------------------------------------------------- folder */

  build(gui) {
    const f = gui.addFolder("Capture: isolate & export");
    this.folder = f;
    const keep = (c) => ((c.keep = true), c);
    const btn = (parent, name, fn) => keep(parent.add({ run: fn }, "run").name(name));
    const note = (parent, text) => {
      const el = document.createElement("div");
      el.className = "tsbx-hint";
      el.textContent = text;
      parent.$children.appendChild(el);
    };

    keep(f.add(this.ui, "isolate").name("Isolate elements")).onChange(() => this.apply());
    const presets = { "Pick a preset…": "", ...Object.fromEntries(Object.keys(PRESETS).map((k) => [k, k])) };
    keep(f.add(this.ui, "preset", presets).name("Preset")).onChange((name) => {
      if (!name) return;
      for (const t of TARGETS) this.show[t.key] = PRESETS[name].includes(t.key);
      this.ui.isolate = true;
      this.ui.preset = "";
      this.panel.gui.controllersRecursive().forEach((c) => c.updateDisplay());
      this.apply();
    });
    const el = f.addFolder("Elements shown");
    for (const t of TARGETS) keep(el.add(this.show, t.key).name(t.label)).onChange(() => this.apply());
    el.close();

    keep(f.add(this.ui, "ground", GROUNDS).name("Background")).onChange(() => this.apply());
    keep(f.addColor(this.ui, "custom").name("Custom colour")).onChange(() => this.apply());

    const re = f.addFolder("Replay");
    btn(re, "Replay landing entrance", () => this.replay());
    keep(re.add(this.ui, "riseToo").name("Planet rises too"));
    keep(re.add(this.ui, "hidePanel").name("Hide this panel (H brings it back)"));
    keep(re.add(this.ui, "delay", 0, 10, 0.5).name("Countdown (s)"));

    const ex = f.addFolder("Export");
    keep(ex.add(this.ui, "area", { "Isolated elements": "elements", "Whole window": "window" }).name("Area"));
    btn(ex, "Save transparent PNG", () => this.#run(() => this.png()));
    keep(ex.add(this.ui, "fps", { 24: 24, 30: 30, 60: 60 }).name("Frames per second"));
    keep(ex.add(this.ui, "length", 0, 60, 0.5).name("Length (s, 0 = auto)"));
    keep(ex.add(this.ui, "alpha").name("Transparent frames (slower)"));
    btn(ex, "Save entrance as a frame sequence (.zip)", () => this.#run(() => this.sequence()));
    keep(ex.add(this.ui, "format", { "MP4 (H.264)": "mp4", "WebM (VP9)": "webm" }).name("Video format"));
    keep(
      ex.add(this.ui, "startWith", { Nothing: "none", "The landing entrance": "entrance", "The animation timeline": "timeline" }).name(
        "Start the video with",
      ),
    );
    btn(ex, "Record video over the background", () => this.#run(() => this.record()));
    note(
      ex,
      "Exports read this tab: Chrome asks once — choose “This tab”. Transparent frames are PNGs with real " +
        "alpha (glows and glass included), taken twice each over black and white; untick it for faster, " +
        "opaque JPEGs. Video can’t carry alpha, so it records over the background above; pick green or " +
        "black there. Esc stops a recording early.",
    );
    return f;
  }

  async #run(fn) {
    if (this.busy) return this.panel.toast("Still working on the last export", true);
    this.busy = true;
    try {
      await fn();
    } catch (err) {
      if (err?.name === "NotAllowedError") this.panel.toast("Sharing this tab was cancelled", true);
      else this.panel.toast(`Export failed: ${err?.message ?? err}`, true);
      console.error("[capture]", err);
    } finally {
      this.busy = false;
      this.#panelVisible(true);
    }
  }

  /* ------------------------------------------------- isolation & ground */

  /** Writes the isolation and the ground into the page. */
  apply(ground = this.#groundColour()) {
    const body = document.body;
    for (const el of document.querySelectorAll("[data-tcap]")) el.removeAttribute("data-tcap");
    body.classList.toggle("tcap-iso", this.ui.isolate);
    body.classList.toggle("tcap-noshade", this.ui.isolate && !this.show.shade);
    if (this.ui.isolate) {
      for (const el of document.querySelectorAll(UNIVERSE)) if (!el.matches(OURS)) el.dataset.tcap = "hide";
      for (const t of TARGETS) {
        if (!t.sel) continue;
        for (const el of document.querySelectorAll(t.sel)) el.dataset.tcap = this.show[t.key] ? "show" : "hide";
      }
      // Whatever holds nothing chosen goes outright (opacity, which nothing
      // inside can undo: the pins set their own visibility). Only a
      // container round something chosen is hidden by visibility, so the
      // chosen part inside can show again on its own.
      for (const el of document.querySelectorAll('[data-tcap="hide"]')) {
        if (!el.querySelector('[data-tcap="show"]')) el.dataset.tcap = "gone";
      }
    }
    let stage = document.querySelector(".tcap-stage");
    if (ground) {
      if (!stage) {
        stage = document.createElement("div");
        stage.className = "tcap-stage";
        // Over the sky, under the globe and everything else.
        document.querySelector(".paper")?.after(stage) ?? body.prepend(stage);
      }
      stage.style.background = ground;
    } else {
      stage?.remove();
    }
  }

  #groundColour() {
    const g = this.ui.ground;
    return g === "page" ? null : g === "custom" ? this.ui.custom : g;
  }

  /** The box round everything isolated, in CSS px, with room for glows. */
  #elementsRect(pad = 48) {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    const shown = this.ui.isolate ? TARGETS.filter((x) => x.sel && this.show[x.key]) : [];
    for (const x of shown) {
      for (const el of document.querySelectorAll(x.sel)) {
        const box = el.getBoundingClientRect();
        if (!box.width || !box.height) continue;
        l = Math.min(l, box.left);
        t = Math.min(t, box.top);
        r = Math.max(r, box.right);
        b = Math.max(b, box.bottom);
      }
    }
    const W = window.innerWidth;
    const H = window.innerHeight;
    if (this.ui.area === "window" || !Number.isFinite(l)) return { x: 0, y: 0, w: W, h: H };
    const x = Math.max(0, Math.floor(l - pad));
    const y = Math.max(0, Math.floor(t - pad));
    return { x, y, w: Math.min(W, Math.ceil(r + pad)) - x, h: Math.min(H, Math.ceil(b + pad)) - y };
  }

  #panelVisible(on) {
    const gui = this.panel.gui?.domElement;
    if (gui) gui.style.visibility = on ? "" : "hidden";
    document.body.classList.toggle("tcap-quiet", !on);
  }

  /* -------------------------------------------------------------- replay */

  /** Lands the headline, the bar and the chips again, and (optionally) the planet. */
  async replay({ countdown = true } = {}) {
    if (!this.app.onLanding) return this.panel.toast("Switch to the landing page first", true);
    // The way H hides it, so H is what brings it back.
    if (this.ui.hidePanel && this.panel.gui) this.panel.gui.domElement.style.display = "none";
    if (countdown && this.ui.delay > 0) await wait(this.ui.delay * 1000);
    this.restartEntrance();
  }

  restartEntrance() {
    const body = document.body;
    body.classList.remove("hero-in", "hero-out");
    void body.offsetWidth;
    body.classList.add("hero-in");
    if (this.ui.riseToo && this.globe) {
      const home = this.globe.liftTarget;
      this.globe.setLift(home - STAGE.rise, { instant: true });
      this.globe.setLift(home, { ms: 1900 });
    }
  }

  /* ------------------------------------------------------- tab capture */

  async #ensureStream() {
    if (this.stream?.active) return;
    const dpr = window.devicePixelRatio || 1;
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: "browser",
        cursor: "never",
        frameRate: { ideal: 60 },
        width: { ideal: Math.round(window.innerWidth * dpr), max: 7680 },
        height: { ideal: Math.round(window.innerHeight * dpr), max: 4320 },
      },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: "include",
      surfaceSwitching: "exclude",
    });
    const track = stream.getVideoTracks()[0];
    track.addEventListener("ended", () => {
      if (this.stream === stream) this.stream = null;
    });
    // Only this tab can be cropped to its own element: a cheap check that
    // the right surface was shared.
    if (track.cropTo && window.CropTarget) {
      try {
        await track.cropTo(null);
      } catch {
        track.stop();
        throw new Error("That was not this tab — choose “This tab” when Chrome asks");
      }
    }
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    this.stream = stream;
    this.track = track;
    this.video = video;
    // The share bar Chrome opens can resize the page; let it settle.
    await wait(400);
  }

  /** Resolves once the captured stream has caught up with the page. */
  async #fresh() {
    await frame();
    await frame();
    const v = this.video;
    const next = (ms) =>
      new Promise((r) => {
        const t = setTimeout(r, ms);
        v.requestVideoFrameCallback?.(() => {
          clearTimeout(t);
          r();
        });
      });
    await next(400);
    await next(90);
  }

  /** The tab's pixels in `rect` (CSS px) as ImageData. */
  #grab(rect) {
    const v = this.video;
    const k = v.videoWidth / window.innerWidth;
    const sx = Math.round(rect.x * k);
    const sy = Math.round(rect.y * k);
    const w = Math.min(Math.round(rect.w * k), v.videoWidth - sx);
    const h = Math.min(Math.round(rect.h * k), v.videoHeight - sy);
    const c = (this.grabCanvas ??= document.createElement("canvas"));
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(v, sx, sy, w, h, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  /** The current frame, matted: over black, then over white. */
  async #mattedFrame(rect) {
    this.apply("#000000");
    await this.#fresh();
    const black = this.#grab(rect);
    this.apply("#ffffff");
    await this.#fresh();
    const white = this.#grab(rect);
    return matte(black, white);
  }

  /** Holds everything still for a matted pair, then lets it go. */
  async #still(fn) {
    const anims = document.getAnimations();
    const running = anims.filter((a) => a.playState === "running");
    running.forEach((a) => a.pause());
    if (this.globe) this.globe.frozen = true;
    try {
      return await fn();
    } finally {
      running.forEach((a) => a.play());
      if (this.globe) {
        this.globe.frozen = false;
        this.globe.dirty = true;
      }
      this.apply();
    }
  }

  /* ------------------------------------------------------------- exports */

  async png() {
    await this.#ensureStream();
    this.#panelVisible(false);
    const rect = this.#elementsRect();
    const img = await this.#still(() => this.#mattedFrame(rect));
    const trimmed = this.ui.area === "window" ? img : trim(img);
    download(await toPng(trimmed), `terra-capture-${stamp()}.png`);
    this.#panelVisible(true);
    this.panel.toast(`Saved a transparent PNG, ${trimmed.width}×${trimmed.height}`);
  }

  /** The landing entrance as a frame-by-frame driver (see sequence). */
  #entranceDriver() {
    return {
      name: "entrance",
      check: () => (this.app.onLanding ? "" : "The sequence is the landing entrance: switch to the landing page first"),
      setup: () => {
        const rise = this.ui.riseToo;
        this.ui.riseToo = false;
        this.restartEntrance();
        this.ui.riseToo = rise;
        return {};
      },
    };
  }

  /** Video of the animation timeline, whatever "Start the video with" says. */
  recordTimeline() {
    const anim = this.panel.animator;
    if (!anim?.hasContent) return this.panel.toast("Add two keyframes, or an element animation, first", true);
    const was = this.ui.startWith;
    this.ui.startWith = "timeline";
    return this.#run(() => this.record()).finally(() => (this.ui.startWith = was));
  }

  /** The animation timeline, frame by frame. */
  renderTimeline() {
    return this.#run(() => this.sequence(this.panel.animator.renderDriver()));
  }

  /**
   * A frame sequence, every frame set by hand so a slow capture cannot drop
   * or smear one. The driver starts the animation (setup) and, for anything
   * the document's own animations do not cover, places frame `t` (seek):
   * the timeline pins the camera there and waits for the globe to draw it.
   * Every other running animation on the page is stepped here, on the same
   * clock. `live` keeps the globe drawing; otherwise it is held still.
   */
  async sequence(driver = this.#entranceDriver()) {
    const problem = driver.check?.();
    if (problem) return this.panel.toast(problem, true);
    await this.#ensureStream();
    this.#panelVisible(false);
    const rect = this.#elementsRect(80);
    const fps = Number(this.ui.fps) || 30;
    const alpha = this.ui.alpha;

    const before = new Set(document.getAnimations());
    const own = driver.setup() ?? {};
    getComputedStyle(document.body).opacity;
    const anims = document.getAnimations().filter((a) => !own.owns?.has(a));
    const base = new Map(anims.map((a) => [a, before.has(a) ? Number(a.currentTime) || 0 : 0]));
    anims.forEach((a) => a.pause());
    if (this.globe && !driver.live) this.globe.frozen = true;

    const auto = Math.max(
      1,
      ...anims
        .filter((a) => !before.has(a))
        .map((a) => {
          const t = a.effect?.getComputedTiming?.();
          return t && Number.isFinite(t.endTime) ? t.endTime / 1000 : 0;
        }),
    );
    const seconds = this.ui.length > 0 ? this.ui.length : own.seconds ?? Math.min(auto + 0.2, 10);
    const count = Math.ceil(seconds * fps);
    const zip = new Zip();
    const title = document.title;
    const ext = alpha ? "png" : "jpg";
    const started = performance.now();
    try {
      for (let i = 0; i < count; i++) {
        const t = i / fps;
        for (const a of anims) a.currentTime = base.get(a) + t * 1000;
        await driver.seek?.(t);
        let blob;
        if (alpha) {
          blob = await toPng(await this.#mattedFrame(rect));
        } else {
          await this.#fresh();
          blob = await toJpeg(this.#grab(rect));
        }
        zip.add(`frame_${String(i).padStart(4, "0")}.${ext}`, new Uint8Array(await blob.arrayBuffer()));
        // In the tab's title: anything drawn on the page would be in the frames.
        const left = ((performance.now() - started) / (i + 1)) * (count - i - 1);
        document.title = `Frame ${i + 1} / ${count} · ${Math.ceil(left / 1000)} s left — Terra`;
      }
    } finally {
      document.title = title;
      for (const a of anims) {
        a.currentTime = base.get(a) + seconds * 1000;
        a.play();
      }
      driver.teardown?.();
      if (this.globe) {
        this.globe.frozen = false;
        this.globe.dirty = true;
      }
      this.apply();
    }
    download(zip.blob(), `terra-${driver.name}-${fps}fps-${stamp()}.zip`);
    this.#panelVisible(true);
    this.panel.toast(`Saved ${count} ${alpha ? "transparent " : ""}frames at ${fps} fps`);
  }

  async record() {
    await this.#ensureStream();
    const track = this.track;
    const rect = this.#elementsRect();
    let crop = null;
    if (this.ui.area === "elements" && track.cropTo && window.CropTarget) {
      crop = document.createElement("div");
      crop.className = "tcap-crop";
      Object.assign(crop.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
      document.body.appendChild(crop);
      await track.cropTo(await CropTarget.fromElement(crop));
    }
    const mp4 = this.ui.format === "mp4" && MediaRecorder.isTypeSupported("video/mp4;codecs=avc1");
    const mimeType = mp4
      ? "video/mp4;codecs=avc1"
      : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(this.stream, { mimeType, videoBitsPerSecond: 40_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));

    this.#panelVisible(false);
    if (this.ui.delay > 0) await wait(this.ui.delay * 1000);
    await this.#fresh();
    rec.start(250);
    const title = document.title;
    document.title = "● Recording — Terra";
    const esc = (e) => e.key === "Escape" && rec.state === "recording" && rec.stop();
    window.addEventListener("keydown", esc, true);
    const replay = this.ui.startWith === "entrance" && this.app.onLanding;
    const anim = this.panel.animator;
    const timeline = this.ui.startWith === "timeline" && anim?.hasContent;
    if (replay) {
      await wait(250);
      this.restartEntrance();
    } else if (timeline) {
      await wait(250);
      anim.play({ hide: false });
    }
    const seconds = this.ui.length > 0 ? this.ui.length : replay ? 4.5 : timeline ? anim.duration + 0.4 : 6;
    const timer = setTimeout(() => rec.state === "recording" && rec.stop(), seconds * 1000 + (replay || timeline ? 250 : 0));
    await stopped;
    clearTimeout(timer);
    window.removeEventListener("keydown", esc, true);
    document.title = title;
    if (crop) {
      await track.cropTo(null).catch(() => {});
      crop.remove();
    }
    download(new Blob(chunks, { type: mimeType }), `terra-recording-${stamp()}.${mp4 ? "mp4" : "webm"}`);
    this.#panelVisible(true);
    this.panel.toast("Saved the recording");
  }
}

/* ---------------------------------------------------------------- pixels */

/** Difference matting: alpha from how far white and black apart, colour from the black. */
function matte(black, white) {
  const out = new ImageData(black.width, black.height);
  const b = black.data;
  const w = white.data;
  const o = out.data;
  for (let i = 0; i < b.length; i += 4) {
    const d = (w[i] - b[i] + (w[i + 1] - b[i + 1]) + (w[i + 2] - b[i + 2])) / 765;
    const a = Math.min(Math.max(1 - d, 0), 1);
    if (a < 1 / 255) continue;
    o[i] = Math.min(255, b[i] / a);
    o[i + 1] = Math.min(255, b[i + 1] / a);
    o[i + 2] = Math.min(255, b[i + 2] / a);
    o[i + 3] = Math.round(a * 255);
  }
  return out;
}

/** Cuts away the fully transparent margin, leaving two pixels. */
function trim(img) {
  const { width: W, height: H, data } = img;
  let l = W, t = H, r = -1, b = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] > 1) {
        if (x < l) l = x;
        if (x > r) r = x;
        if (y < t) t = y;
        if (y > b) b = y;
      }
    }
  }
  if (r < 0) return img;
  l = Math.max(0, l - 2);
  t = Math.max(0, t - 2);
  r = Math.min(W - 1, r + 2);
  b = Math.min(H - 1, b + 2);
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  c.getContext("2d").putImageData(img, 0, 0);
  return c.getContext("2d").getImageData(l, t, r - l + 1, b - t + 1);
}

function toPng(img) {
  return encode(img, "image/png");
}

function toJpeg(img) {
  return encode(img, "image/jpeg", 0.94);
}

function encode(img, type, quality) {
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  c.getContext("2d").putImageData(img, 0, 0);
  return new Promise((r) => c.toBlob(r, type, quality));
}

/* ------------------------------------------------------------------ zip */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A store-only zip: PNGs are compressed already. */
class Zip {
  constructor() {
    this.parts = [];
    this.central = [];
    this.offset = 0;
  }

  add(name, bytes) {
    const nm = new TextEncoder().encode(name);
    const crc = crc32(bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, bytes.length, true);
    local.setUint32(22, bytes.length, true);
    local.setUint16(26, nm.length, true);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, bytes.length, true);
    cen.setUint32(24, bytes.length, true);
    cen.setUint16(28, nm.length, true);
    cen.setUint32(42, this.offset, true);
    this.parts.push(local, nm, bytes);
    this.central.push(cen, nm);
    this.offset += 30 + nm.length + bytes.length;
  }

  blob() {
    const size = this.central.reduce((s, p) => s + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.central.length / 2, true);
    end.setUint16(10, this.central.length / 2, true);
    end.setUint32(12, size, true);
    end.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.central, end], { type: "application/zip" });
  }
}
