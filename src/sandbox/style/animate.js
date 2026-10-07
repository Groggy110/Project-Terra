/**
 * Animate: one timeline for screen recordings. Camera keyframes the globe
 * flies through, and effects played on the parts of the page that Capture
 * can isolate (the headline, the search bar and the rest), all on one clock.
 *
 * Between two keyframes the camera takes van Wijk & Nuij's smooth zoom and
 * pan ("Smooth and efficient zooming and panning", 2003). It pulls back to
 * travel and comes down to land, at a constant *perceived* speed: a dive
 * from the whole globe to a town is as even over the last kilometre as over
 * the first thousand. Easing the distance itself would cover the last
 * ninety kilometres in the last few frames. The ramp (the ease) is laid
 * over that even speed, so the move gathers itself, travels, and settles.
 *
 * It plays in real time, for a screen recorder or for Capture's video. It
 * can also be stepped frame by frame by Capture, which waits for each
 * frame's tiles, so a town-level dive comes out without a single soft or
 * dropped frame.
 *
 * The timeline lives in the sandbox's localStorage entry (`animation`).
 */
import { Vector3 } from "three";

import { STYLE } from "../../style/styleConfig.js";
import { DEG, clamp, latLonToVec3, vec3ToLatLon, wrapDelta } from "../../globe/geo.js";
import { TARGETS } from "./capture.js";
import { saveStore } from "./tools.js";

/* ---------------------------------------------------------------- easing */

/**
 * One table for both clocks: the camera evaluates the curve in JS, and the
 * element effects hand the same numbers to the browser as cubic-bezier().
 */
export const EASES = {
  smooth: { label: "Smooth (slow in & out)", bez: [0.65, 0, 0.35, 1] },
  gentle: { label: "Gentle in & out", bez: [0.37, 0, 0.63, 1] },
  dramatic: { label: "Dramatic in & out", bez: [0.87, 0, 0.13, 1] },
  out: { label: "Quick off, long settle", bez: [0.16, 1, 0.3, 1] },
  in: { label: "Slow start, fast finish", bez: [0.7, 0, 0.84, 0] },
  linear: { label: "Linear", bez: [0, 0, 1, 1] },
  overshoot: { label: "Overshoot (elements only)", bez: [0.34, 1.56, 0.64, 1], elementsOnly: true },
};

const easeOptions = (camera) =>
  Object.fromEntries(Object.entries(EASES).filter(([, e]) => !(camera && e.elementsOnly)).map(([k, e]) => [e.label, k]));

const cssEase = (key) => {
  const b = (EASES[key] ?? EASES.smooth).bez;
  return b.join() === "0,0,1,1" ? "linear" : `cubic-bezier(${b.join(", ")})`;
};

const curves = new Map();
/** The ease as a function of 0..1, cached per key. */
function ease(key) {
  if (!curves.has(key)) curves.set(key, bezier((EASES[key] ?? EASES.smooth).bez));
  return curves.get(key);
}

/** CSS's cubic-bezier(): solve x for the curve parameter, return y. */
function bezier([x1, y1, x2, y2]) {
  if (x1 === y1 && x2 === y2) return (x) => clamp(x, 0, 1);
  const poly = (t, a, b) => ((1 - 3 * b + 3 * a) * t + (3 * b - 6 * a)) * t * t + 3 * a * t;
  const slope = (t, a, b) => 3 * (1 - 3 * b + 3 * a) * t * t + 2 * (3 * b - 6 * a) * t + 3 * a;
  const solve = (x) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = poly(t, x1, x2) - x;
      if (Math.abs(err) < 1e-7) return t;
      const s = slope(t, x1, x2);
      if (Math.abs(s) < 1e-6) break;
      t -= err / s;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 50; i++) {
      const v = poly(t, x1, x2);
      if (Math.abs(v - x) < 1e-7) break;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };
  return (x) => (x <= 0 ? 0 : x >= 1 ? 1 : poly(solve(x), y1, y2));
}

/* ----------------------------------------------------------- camera path */

/** Ground, in radians, across the window per unit of altitude. */
const viewSpan = () => 2 * Math.tan((STYLE.camera.fov * DEG) / 2) * (window.innerWidth / Math.max(window.innerHeight, 1));

/**
 * The smooth zoom-and-pan from `a` to `b` (each { lat, lon, dist }), after
 * d3.interpolateZoom. `w` is the width of ground in view, in radians, and
 * the pan runs along the great circle. Returns the path's length S (in
 * "perceived" units, used to share time out evenly) and `at(t)` for t in 0..1.
 */
function zoomPath(a, b, rho) {
  const A = latLonToVec3(a.lat, a.lon, 1, new Vector3());
  const B = latLonToVec3(b.lat, b.lon, 1, new Vector3());
  const d = Math.acos(clamp(A.dot(B), -1, 1));
  const k = viewSpan();
  const w0 = Math.max(a.dist - 1, 1e-7) * k;
  const w1 = Math.max(b.dist - 1, 1e-7) * k;
  const sinD = Math.sin(d);
  const P = new Vector3();
  const along = (u) => {
    if (u <= 0 || d < 1e-9) return { lat: a.lat, lon: a.lon };
    if (u >= 1) return { lat: b.lat, lon: b.lon };
    // Antipodes: no single great circle, so straight across in lat/lon.
    if (sinD < 1e-6) return { lat: a.lat + (b.lat - a.lat) * u, lon: a.lon + wrapDelta(a.lon, b.lon) * u };
    P.copy(A).multiplyScalar(Math.sin((1 - u) * d) / sinD).addScaledVector(B, Math.sin(u * d) / sinD);
    return vec3ToLatLon(P);
  };
  const r2 = rho * rho;
  const r4 = r2 * r2;
  if (d < 1e-6) {
    const S = Math.abs(Math.log(w1 / w0)) / rho;
    return { S, at: (t) => ({ ...along(t), dist: 1 + (w0 * Math.exp(Math.log(w1 / w0) * t)) / k }) };
  }
  // asinh rather than the log form: the log loses everything to cancellation
  // when one end is street level and the other is the whole planet.
  const r0 = -Math.asinh((w1 * w1 - w0 * w0 + r4 * d * d) / (2 * w0 * r2 * d));
  const r1 = -Math.asinh((w1 * w1 - w0 * w0 - r4 * d * d) / (2 * w1 * r2 * d));
  const S = (r1 - r0) / rho;
  const c0 = Math.cosh(r0);
  const s0 = Math.sinh(r0);
  return {
    S,
    at: (t) => {
      if (t >= 1) return { lat: b.lat, lon: b.lon, dist: b.dist };
      const s = t * S;
      const u = (w0 / (r2 * d)) * (c0 * Math.tanh(rho * s + r0) - s0);
      const w = (w0 * c0) / Math.cosh(rho * s + r0);
      return { ...along(clamp(u, 0, 1)), dist: 1 + w / k };
    },
  };
}

/* --------------------------------------------------------------- effects */

/** `amount` is the slider: pixels for moves, a fortieth of it is 0.1 of scale or 16px of blur. */
const EFFECTS = {
  fade: { label: "Fade" },
  rise: { label: "Rise", move: (a) => `translateY(${a}px)` },
  drop: { label: "Drop", move: (a) => `translateY(${-a}px)` },
  left: { label: "Slide from the left", move: (a) => `translateX(${-a}px)` },
  right: { label: "Slide from the right", move: (a) => `translateX(${a}px)` },
  scale: { label: "Scale", move: (a) => `scale(${Math.max(1 - a / 200, 0.01)})` },
  pop: { label: "Pop (from large)", move: (a) => `scale(${1 + a / 200})` },
  blur: { label: "Blur", blur: true },
  focus: { label: "Rise & focus (as the headline does)", move: (a) => `translateY(${a}px) scale(0.965)`, blur: true },
  wipe: { label: "Wipe, left to right", wipe: true },
};

/** Built in: the page's own CSS animations, replayed on the timeline's clock. */
const CUES = {
  entrance: "Landing entrance (built in)",
  exit: "Headline lifts away (built in)",
};

const targetOptions = () => ({
  ...Object.fromEntries(Object.entries(CUES).map(([k, v]) => [v, k])),
  ...Object.fromEntries(TARGETS.filter((t) => t.sel).map((t) => [t.label, t.key])),
});

const targetLabel = (key) => CUES[key] ?? TARGETS.find((t) => t.key === key)?.label ?? key;

/* -------------------------------------------------------------- timeline */

const DEFAULTS = {
  lead: 1,
  loop: false,
  hidePanel: true,
  timing: "keys",
  ramp: "smooth",
  swoop: 1.4,
  keys: [],
  tracks: [],
};

const KEY = { dur: 4, ease: "smooth", hold: 0 };
const TRACK = { target: "title", effect: "focus", dir: "in", at: 0, dur: 1.2, ease: "out", amount: 40, stagger: false, step: 0.12 };

const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const fmt = (n, d = 1) => Number(n).toFixed(d).replace(/\.0+$/, "");

/** "1,240 km up", "380 m up". */
function altitude(dist) {
  const km = (dist - 1) * 6371;
  return km >= 10 ? `${Math.round(km).toLocaleString()} km up` : km >= 1 ? `${fmt(km)} km up` : `${Math.round(km * 1000)} m up`;
}

const place = (k) => `${fmt(Math.abs(k.lat), 2)}°${k.lat >= 0 ? "N" : "S"} ${fmt(Math.abs(k.lon), 2)}°${k.lon >= 0 ? "E" : "W"}`;

export class Animator {
  constructor(panel) {
    this.panel = panel;
    const saved = panel.store.animation ?? {};
    this.tl = {
      ...DEFAULTS,
      ...saved,
      keys: (saved.keys ?? []).map((k) => ({ ...KEY, ...k })),
      tracks: (saved.tracks ?? []).map((t) => ({ ...TRACK, ...t })),
    };
    /** Every animation the timeline has made on the page: { a, off, track }. */
    this.made = [];
    this.heroClasses = null;
    this.playing = null;
    this.keyFolders = [];
    this.trackFolders = [];
  }

  get app() {
    return this.panel.app;
  }

  get globe() {
    return this.app.globe;
  }

  get hasContent() {
    return this.tl.keys.length > 1 || this.tl.tracks.length > 0;
  }

  #save() {
    this.panel.store.animation = this.tl;
    saveStore(this.panel.store);
    if (this.lengthNote) this.lengthNote.textContent = this.#summary();
  }

  #summary() {
    const { keys, tracks } = this.tl;
    if (!keys.length && !tracks.length) return "Nothing on the timeline yet.";
    const parts = [];
    if (keys.length) parts.push(`${keys.length} keyframe${keys.length === 1 ? "" : "s"}`);
    if (tracks.length) parts.push(`${tracks.length} element animation${tracks.length === 1 ? "" : "s"}`);
    return `${parts.join(", ")}: about ${fmt(this.#estimate())} s in all.`;
  }

  /* ------------------------------------------------------------ folder */

  build(gui) {
    const f = gui.addFolder("Animate: keyframes & effects");
    this.folder = f;
    // A rebuilt panel took the old sub-folders down with it.
    this.keyFolders = [];
    this.trackFolders = [];
    const keep = (c) => ((c.keep = true), c);
    const btn = (parent, name, fn) => keep(parent.add({ run: fn }, "run").name(name));
    const save = () => this.#save();
    const tl = this.tl;

    btn(f, "▶ Play timeline", () => this.play());
    btn(f, "■ Stop (Esc)", () => this.stop());
    keep(f.add(tl, "lead", 0, 5, 0.1).name("Hold before it starts (s)")).onFinishChange(save);
    keep(f.add(tl, "loop").name("Loop")).onChange(save);
    keep(f.add(tl, "hidePanel").name("Hide this panel while playing (H brings it back)")).onChange(save);
    this.lengthNote = this.#note(f, this.#summary());

    const cam = f.addFolder("Camera keyframes");
    this.camFolder = cam;
    this.#note(
      cam,
      "Move the globe to a view (drag, scroll, or search for a town), then add a keyframe. Play flies " +
        "from the first keyframe to the last. Before recording a dive down to a town, preload the tiles " +
        "once so every frame is sharp.",
    );
    btn(cam, "＋ Add keyframe at this view", () => this.addKey());
    keep(cam.add(tl, "timing", { "Stop at each keyframe": "keys", "One continuous move": "continuous" }).name("Timing")).onChange(() => {
      save();
      this.#syncKeyControls();
    });
    this.rampCtrl = keep(cam.add(tl, "ramp", easeOptions(true)).name("Ramp")).onChange(save);
    keep(cam.add(tl, "swoop", 0.3, 2.5, 0.05).name("Swoop (pull back to travel)")).onFinishChange(save);
    btn(cam, "Preload tiles along the path", () => this.preload());
    btn(cam, "Remove all keyframes", () => {
      tl.keys = [];
      save();
      this.#renderKeys();
    });

    const fx = f.addFolder("Element animations");
    this.fxFolder = fx;
    this.#note(
      fx,
      "Animate part of the page on the same clock as the camera. To film one part on its own, " +
        "isolate it in Capture first. Elements hold their last frame until you reset them or play again.",
    );
    btn(fx, "＋ Add animation", () => this.addTrack());
    btn(fx, "Reset elements", () => this.reset());

    const rec = f.addFolder("Record");
    btn(rec, "Record video of the timeline", () => this.panel.capture.recordTimeline());
    btn(rec, "Render frame by frame (.zip)", () => this.panel.capture.renderTimeline());
    this.#note(
      rec,
      "Video records in real time. Frame by frame waits for every frame's tiles before taking it, so " +
        "nothing hitches or blurs: the smoothest result, but slower to make. Frame rate, area, background " +
        "and video format are set under Capture: isolate & export.",
    );

    this.#renderKeys();
    this.#renderTracks();
    return f;
  }

  #note(parent, text) {
    const el = document.createElement("div");
    el.className = "tsbx-hint";
    el.textContent = text;
    parent.$children.appendChild(el);
    return el;
  }

  /* --------------------------------------------------------- keyframes */

  addKey() {
    const c = this.globe?.controls;
    if (!c) return this.panel.toast("The globe has not started", true);
    const last = this.tl.keys.at(-1);
    this.tl.keys.push({ ...KEY, ...(last ? { dur: last.dur, ease: last.ease } : {}), ...this.#view() });
    this.#save();
    this.#renderKeys();
    this.panel.toast(`Keyframe ${this.tl.keys.length} added: ${altitude(this.tl.keys.at(-1).dist)}`);
  }

  #view() {
    const c = this.globe.controls;
    return { lat: c.lat, lon: ((((c.lon + 180) % 360) + 360) % 360) - 180, dist: c.dist };
  }

  #renderKeys() {
    for (const sub of this.keyFolders) sub.destroy();
    this.keyFolders = [];
    const keep = (c) => ((c.keep = true), c);
    const save = () => this.#save();
    this.tl.keys.forEach((k, i) => {
      const f = this.camFolder.addFolder(`Keyframe ${i + 1} · ${place(k)} · ${altitude(k.dist)}`);
      this.keyFolders.push(f);
      if (i > 0) {
        f.durCtrl = keep(f.add(k, "dur", 0.2, 30, 0.1).name("Seconds to get here")).onFinishChange(save);
        f.easeCtrl = keep(f.add(k, "ease", easeOptions(true)).name("Ease")).onChange(save);
        f.holdCtrl = keep(f.add(k, "hold", 0, 10, 0.1).name("Hold here (s)")).onFinishChange(save);
      }
      keep(f.add({ run: () => this.#goTo(k) }, "run").name("Go to this view"));
      keep(
        f.add(
          {
            run: () => {
              Object.assign(k, this.#view());
              save();
              this.#renderKeys();
            },
          },
          "run",
        ),
      ).name("Set to the current view");
      if (i > 0) {
        keep(
          f.add(
            {
              run: () => {
                [this.tl.keys[i - 1], this.tl.keys[i]] = [this.tl.keys[i], this.tl.keys[i - 1]];
                save();
                this.#renderKeys();
              },
            },
            "run",
          ),
        ).name("Move earlier");
      }
      keep(
        f.add(
          {
            run: () => {
              this.tl.keys.splice(i, 1);
              save();
              this.#renderKeys();
            },
          },
          "run",
        ),
      ).name("Delete");
      f.close();
    });
    this.#syncKeyControls();
    if (this.lengthNote) this.lengthNote.textContent = this.#summary();
  }

  /** Continuous timing has one ramp for the whole move and no holds. */
  #syncKeyControls() {
    const cont = this.tl.timing === "continuous";
    this.rampCtrl?.show(cont);
    for (const f of this.keyFolders) {
      f.easeCtrl?.show(!cont);
      f.holdCtrl?.show(!cont);
    }
  }

  #goTo(k) {
    if (this.playing) this.stop();
    this.globe?.controls.flyTo({ lat: k.lat, lon: k.lon, dist: k.dist, ms: 1100 });
  }

  /* ------------------------------------------------------------ tracks */

  addTrack() {
    const last = this.tl.tracks.at(-1);
    const at = last ? +(last.at + last.dur * 0.5).toFixed(2) : 0;
    this.tl.tracks.push({ ...TRACK, at });
    this.#save();
    this.#renderTracks();
  }

  #renderTracks() {
    for (const sub of this.trackFolders) sub.destroy();
    this.trackFolders = [];
    const keep = (c) => ((c.keep = true), c);
    this.tl.tracks.forEach((t, i) => {
      const f = this.fxFolder.addFolder("");
      this.trackFolders.push(f);
      const title = () => {
        const what = CUES[t.target] ? "" : ` · ${EFFECTS[t.effect]?.label ?? t.effect} ${t.dir}`;
        f.title(`${i + 1}. ${targetLabel(t.target)}${what} · at ${fmt(t.at, 2)} s`);
      };
      const sync = () => {
        const cue = !!CUES[t.target];
        for (const c of f.fxOnly) c.show(!cue);
        f.stepCtrl.show(!cue && t.stagger);
        f.amountCtrl.show(!cue && t.effect !== "fade" && t.effect !== "wipe");
        title();
      };
      const save = () => {
        this.#save();
        sync();
      };
      keep(f.add(t, "target", targetOptions()).name("Element")).onChange(save);
      keep(f.add(t, "at", 0, 30, 0.05).name("Starts at (s)")).onFinishChange(save);
      f.fxOnly = [
        keep(f.add(t, "effect", Object.fromEntries(Object.entries(EFFECTS).map(([k, e]) => [e.label, k]))).name("Effect")).onChange(save),
        keep(f.add(t, "dir", { In: "in", Out: "out" }).name("Direction")).onChange(save),
        keep(f.add(t, "dur", 0.1, 10, 0.05).name("Duration (s)")).onFinishChange(save),
        keep(f.add(t, "ease", easeOptions(false)).name("Ease")).onChange(save),
        keep(f.add(t, "stagger").name("One word / item at a time")).onChange(save),
      ];
      f.amountCtrl = keep(f.add(t, "amount", 0, 200, 1).name("Distance / strength")).onFinishChange(save);
      f.stepCtrl = keep(f.add(t, "step", 0.01, 1, 0.01).name("Gap between them (s)")).onFinishChange(save);
      keep(f.add({ run: () => this.play({ only: t }) }, "run").name("Preview this one"));
      keep(
        f.add(
          {
            run: () => {
              this.tl.tracks.splice(i, 1);
              this.#save();
              this.#renderTracks();
            },
          },
          "run",
        ),
      ).name("Delete");
      sync();
    });
    if (this.lengthNote) this.lengthNote.textContent = this.#summary();
  }

  /* ---------------------------------------------------------- the plan */

  /** The camera's segments, timed. Built when a play or render starts. */
  #plan() {
    const { keys, timing, swoop, lead } = this.tl;
    const segs = [];
    for (let i = 1; i < keys.length; i++) {
      segs.push({ to: keys[i], path: zoomPath(keys[i - 1], keys[i], swoop), dur: keys[i].dur, hold: keys[i].hold, ease: ease(keys[i].ease) });
    }
    const continuous = timing === "continuous";
    const moving = segs.reduce((s, g) => s + g.dur, 0);
    const span = segs.reduce((s, g) => s + g.dur + (continuous ? 0 : g.hold), 0);
    // One continuous move shares its time out by each leg's length, so the
    // perceived speed carries straight through the keyframes in between.
    const totalS = segs.reduce((s, g) => s + Math.abs(g.path.S), 0);
    return { segs, continuous, moving, totalS, end: keys.length > 1 ? lead + span : 0, ramp: ease(this.tl.ramp) };
  }

  /** Where the camera is at `t` seconds into the timeline. */
  cameraAt(t, plan = this.plan) {
    const keys = this.tl.keys;
    if (!keys.length) return null;
    let tt = t - this.tl.lead;
    if (keys.length === 1 || tt <= 0) return keys[0];
    const { segs } = plan;
    if (plan.continuous) {
      if (tt >= plan.moving) return keys.at(-1);
      const k = plan.ramp(tt / plan.moving);
      if (plan.totalS < 1e-9) {
        const at = k * segs.length;
        const i = Math.min(Math.floor(at), segs.length - 1);
        return segs[i].path.at(at - i);
      }
      let g = k * plan.totalS;
      for (const seg of segs) {
        const S = Math.abs(seg.path.S);
        if (g <= S || seg === segs.at(-1)) return seg.path.at(S ? clamp(g / S, 0, 1) : 1);
        g -= S;
      }
    }
    for (const seg of segs) {
      if (tt < seg.dur) return seg.path.at(seg.ease(tt / seg.dur));
      tt -= seg.dur;
      if (tt < seg.hold) return seg.to;
      tt -= seg.hold;
    }
    return keys.at(-1);
  }

  /** Length of the timeline, without building anything. */
  #estimate() {
    const { lead, tracks } = this.tl;
    let end = this.#plan().end;
    for (const t of tracks) end = Math.max(end, lead + t.at + (CUES[t.target] ? (t.target === "entrance" ? 3.6 : 0.8) : t.dur));
    return end;
  }

  /* ------------------------------------------------------ the elements */

  /** The units one track moves: the element, or its words / items when staggered. */
  #units(track) {
    const target = TARGETS.find((x) => x.key === track.target);
    if (!target?.sel) return [];
    const els = [...document.querySelectorAll(target.sel)];
    if (!track.stagger) return els;
    return els.flatMap((el) => {
      const parts = el.matches(".hero__title") ? [...el.querySelectorAll(".hero__word")] : [...el.children];
      return parts.length ? parts : [el];
    });
  }

  /**
   * Makes every animation on the timeline, paused, and returns how long the
   * timeline runs. Each one is listed with its offset — the second on the
   * timeline its own time starts — so a play and a frame-by-frame render
   * place it the same way.
   */
  #make({ only = null, lead = this.tl.lead } = {}) {
    this.reset();
    const body = document.body;
    this.heroClasses = { in: body.classList.contains("hero-in"), out: body.classList.contains("hero-out") };
    let end = 0;
    const missing = [];
    for (const track of only ? [only] : this.tl.tracks) {
      const off = lead + track.at;
      if (CUES[track.target]) {
        const before = new Set(document.getAnimations());
        if (track.target === "entrance") {
          if (!this.app.onLanding) {
            missing.push("the entrance is only on the landing page");
            continue;
          }
          body.classList.remove("hero-in", "hero-out");
          void body.offsetWidth;
          body.classList.add("hero-in");
        } else {
          if (!body.classList.contains("hero-in")) {
            missing.push("the headline is not on screen to lift away");
            continue;
          }
          body.classList.add("hero-out");
        }
        getComputedStyle(body).opacity;
        for (const a of document.getAnimations()) {
          if (before.has(a)) continue;
          a.pause();
          this.made.push({ a, off, track, cue: true });
          const e = a.effect?.getComputedTiming?.().endTime;
          if (Number.isFinite(e)) end = Math.max(end, off + e / 1000);
        }
        continue;
      }
      const units = this.#units(track);
      if (!units.length || !units.some((el) => el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) ?? true)) {
        missing.push(`${targetLabel(track.target).toLowerCase()} is not on screen`);
      }
      const fx = EFFECTS[track.effect] ?? EFFECTS.fade;
      const a = track.amount;
      const timing = { duration: track.dur * 1000, easing: cssEase(track.ease), fill: "both" };
      units.forEach((el, i) => {
        const o = off + (track.stagger ? i * track.step : 0);
        // Two animations: the look replaces (opacity, the wipe), the motion
        // adds (transform, blur) onto whatever the element already has —
        // the hero's centring translate, the headline's glow filter — so
        // neither is lost for the length of the effect.
        const look = [{}, {}];
        const move = [{}, {}];
        if (!fx.wipe) {
          look[0].opacity = 0;
          look[1].opacity = 1;
        } else {
          look[0].clipPath = "inset(-20% 100% -20% -20%)";
          look[1].clipPath = "inset(-20% -20% -20% -20%)";
        }
        if (fx.move) {
          move[0].transform = fx.move(a);
          move[1].transform = "none";
        }
        if (fx.blur) {
          move[0].filter = `blur(${a * 0.4}px)`;
          // Not blur(0): a word left holding any filter clips its glow at its own box.
          move[1].filter = "none";
        }
        if (track.dir === "out") {
          look.reverse();
          move.reverse();
        }
        const made = [el.animate(look, timing)];
        if (Object.keys(move[0]).length) made.push(el.animate(move, { ...timing, composite: "add" }));
        for (const anim of made) {
          anim.pause();
          this.made.push({ a: anim, off: o, track });
        }
        end = Math.max(end, o + track.dur);
      });
    }
    if (missing.length) this.panel.toast(`Skipped or hidden: ${[...new Set(missing)].join("; ")}`, true);
    return end;
  }

  /** Takes every effect off the page and puts the headline's classes back. */
  reset() {
    for (const { a, cue } of this.made) if (!cue) a.cancel();
    for (const { a, cue } of this.made) if (cue && a.playState === "paused") a.play();
    this.made = [];
    const h = this.heroClasses;
    if (h) {
      document.body.classList.toggle("hero-out", h.out);
      if (h.in && !document.body.classList.contains("hero-in")) document.body.classList.add("hero-in");
      this.heroClasses = null;
    }
  }

  /* --------------------------------------------------------- real time */

  /**
   * Plays the whole timeline (or one track, to preview it) on the
   * document's own clock: the element effects are scheduled on it, and the
   * camera reads it every frame (controls.path).
   */
  play({ only = null, hide = this.tl.hidePanel } = {}) {
    const globe = this.globe;
    if (!globe?.controls) return this.panel.toast("The globe has not started", true);
    if (!only && !this.hasContent) return this.panel.toast("Add two keyframes, or an element animation, first", true);
    this.stop({ quiet: true });
    const lead = only ? 0 : this.tl.lead;
    this.plan = this.#plan();
    const camera = !only && this.tl.keys.length > 1;
    const end = Math.max(this.#make({ only, lead }), camera ? this.plan.end : 0, lead);

    const t0 = document.timeline.currentTime;
    for (const { a, off } of this.made) a.startTime = t0 + off * 1000;
    const clock = () => (document.timeline.currentTime - t0) / 1000;
    if (camera) {
      globe.setFilming("live");
      globe.controls.path = () => this.cameraAt(clock());
    }
    if (hide && !only && this.panel.gui) this.panel.gui.domElement.style.display = "none";

    const run = { end, camera };
    this.playing = run;
    run.esc = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      this.stop();
    };
    window.addEventListener("keydown", run.esc, true);
    const watch = () => {
      if (this.playing !== run) return;
      if (clock() < end + 0.05) return requestAnimationFrame(watch);
      this.#release(run);
      if (this.tl.loop && !only) setTimeout(() => this.playing === null && this.play({ hide: false }), 400);
    };
    requestAnimationFrame(watch);
  }

  /** Stops a play: the camera stays where it is, the elements as they are. */
  stop({ quiet = false } = {}) {
    const run = this.playing;
    if (!run) return;
    this.#release(run);
    for (const { a } of this.made) if (a.playState === "running") a.pause();
    if (!quiet) this.panel.toast("Stopped");
  }

  #release(run) {
    if (this.playing === run) this.playing = null;
    window.removeEventListener("keydown", run.esc, true);
    const globe = this.globe;
    if (run.camera && globe) {
      globe.controls.path = null;
      globe.setFilming(null);
    }
  }

  /** Seconds the whole timeline runs, as played. */
  get duration() {
    return this.#estimate();
  }

  /* ------------------------------------------------------ frame by frame */

  /**
   * Holds the camera on a pinned view and waits until the globe has drawn it
   * completely: every tile landed and faded in, the vectors repainted.
   */
  async #settle(timeout) {
    const g = this.globe;
    g.dirty = true;
    await frame();
    await frame();
    const start = performance.now();
    // The globe's settle pass (vectors at full sharpness) comes 130ms after
    // the camera stops; this is past it.
    while (performance.now() - start < timeout) {
      if (g.filmSettled && performance.now() - start > 160) {
        await frame();
        return true;
      }
      await frame();
    }
    return false;
  }

  #pin(view) {
    this.pinned = view;
    this.globe.controls.path = () => this.pinned;
  }

  /**
   * The timeline as a driver for Capture's frame-by-frame export: Capture
   * owns the frame loop and the grabbing; this places everything at `t` and
   * waits for the globe to finish drawing it.
   */
  renderDriver() {
    const globe = this.globe;
    let camera = false;
    let drift0 = 0;
    return {
      name: "timeline",
      live: true,
      check: () => (!globe?.controls ? "The globe has not started" : !this.hasContent ? "Add two keyframes, or an element animation, first" : ""),
      setup: () => {
        this.stop({ quiet: true });
        this.plan = this.#plan();
        camera = this.tl.keys.length > 1;
        const end = Math.max(this.#make(), camera ? this.plan.end : 0, this.tl.lead);
        // Pinned even with no keyframes: the drift runs on the wall clock,
        // and frames taken half a second apart would show it racing.
        globe.setFilming("step");
        this.#pin(camera ? this.cameraAt(0) : { ...this.#view(), lon: globe.controls.lon });
        drift0 = globe.drift;
        return { seconds: end + 0.1, owns: new Set(this.made.map((m) => m.a)) };
      },
      seek: async (t) => {
        for (const { a, off } of this.made) a.currentTime = (t - off) * 1000;
        // The clouds keep the timeline's time, not the render's.
        globe.drift = (drift0 + t * STYLE.globe.clouds.drift) % 1;
        if (camera) this.pinned = this.cameraAt(t);
        await this.#settle(8000);
      },
      teardown: () => {
        globe.controls.path = null;
        globe.setFilming(null);
      },
    };
  }

  /**
   * Walks the camera path a few times a second, waiting at each stop for the
   * tiles, so a real-time play or recording finds them all in the cache.
   */
  async preload() {
    const globe = this.globe;
    if (!globe?.controls) return this.panel.toast("The globe has not started", true);
    if (this.tl.keys.length < 2) return this.panel.toast("Add at least two keyframes first", true);
    if (this.preloading) return this.panel.toast("Already preloading", true);
    this.stop({ quiet: true });
    this.preloading = true;
    this.plan = this.#plan();
    const { lead } = this.tl;
    const end = this.plan.end;
    const steps = Math.max(12, Math.ceil((end - lead) * 6));
    globe.setFilming("step");
    this.#pin(this.cameraAt(lead));
    let slow = 0;
    try {
      for (let i = 0; i <= steps; i++) {
        this.pinned = this.cameraAt(lead + ((end - lead) * i) / steps);
        if (!(await this.#settle(6000))) slow++;
        if (i % 4 === 0) this.panel.toast(`Preloading tiles: ${Math.round((i / steps) * 100)}%`);
      }
    } finally {
      globe.controls.path = null;
      globe.setFilming(null);
      this.preloading = false;
    }
    this.#goTo(this.tl.keys[0]);
    this.panel.toast(slow ? `Preloaded, but ${slow} stops timed out: preload again for those` : "Tiles preloaded: ready to record", !!slow);
  }
}
