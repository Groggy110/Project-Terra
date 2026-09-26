/**
 * What the sandbox can animate, and the shape of the config that describes it.
 *
 * The config is the single source of truth: the sliders write it, the JSON
 * editor writes it, and the player only ever reads it. That is what lets the
 * two editors sit side by side without one of them being a second-class copy.
 */

/**
 * Every part of the page capture mode can isolate. `sel` is resolved against
 * the live document each time rather than cached, because the panel, the
 * board and the rail are all rebuilt by the app as you use it.
 *
 * `kind: "globe"` is the one that is not a DOM fade: it drives the camera.
 */
export const TARGETS = [
  { key: "paper", label: "Paper ground", sel: ".paper", hint: "The watercolour wash behind everything" },
  { key: "globe", label: "Globe", sel: "#globe", kind: "globe", hint: "The WebGL canvas" },
  { key: "labels", label: "Pins & map labels", sel: "#overlay" },
  { key: "heroTitle", label: "Hero title", sel: ".hero__title" },
  { key: "heroSub", label: "Hero subtitle", sel: ".hero__sub" },
  { key: "topbar", label: "Top bar", sel: ".topbar" },
  { key: "crumbs", label: "Breadcrumb", sel: ".crumbs" },
  { key: "findbar", label: "Search & filters", sel: ".findbar" },
  { key: "dial", label: "Zoom dial", sel: ".dial" },
  { key: "hint", label: "Drag hint", sel: ".hint" },
  { key: "panel", label: "Side panel", sel: ".panel" },
  { key: "sheet", label: "Needs board", sel: ".sheet" },
  { key: "grabber", label: "Board grabber", sel: ".grabber" },
  { key: "toasts", label: "Toasts", sel: ".toasts" },
];

export const TARGET_BY_KEY = new Map(TARGETS.map((t) => [t.key, t]));

/** The DOM ones, in panel order. */
export const DOM_TARGETS = TARGETS.filter((t) => t.kind !== "globe");

/** Handy starting points for the isolation checkboxes. */
export const ISOLATION_PRESETS = {
  "Globe only": ["globe"],
  "Globe + pins": ["globe", "labels"],
  "Title only": ["heroTitle", "heroSub"],
  "Hero scene": ["paper", "globe", "labels", "heroTitle", "heroSub"],
  Everything: TARGETS.map((t) => t.key),
};

const FROM = { opacity: 0, x: 0, y: 18, scale: 1, blur: 0 };
const TO = { opacity: 1, x: 0, y: 0, scale: 1, blur: 0 };

/** One fade/move track, with only the fields you care about spelled out. */
const track = ({ from, to, ...over } = {}) => ({
  enabled: false,
  delay: 0,
  duration: 900,
  easing: "cubicOut",
  ...over,
  from: { ...FROM, ...from },
  to: { ...TO, ...to },
});

export function defaultConfig() {
  const tracks = {};
  for (const t of DOM_TARGETS) tracks[t.key] = track();

  // The sequence the brief describes, ready to play on first open: the world
  // fades up and turns for three seconds, easing to a stop, and the headline
  // arrives a beat behind it.
  tracks.heroTitle = track({ enabled: true, delay: 600, duration: 1100, easing: "terraEaseOut", from: { y: 22 } });
  tracks.heroSub = track({ enabled: true, delay: 820, duration: 1100, easing: "terraEaseOut", from: { y: 16 } });
  tracks.labels = track({ enabled: false, delay: 400, duration: 900, from: { y: 0 } });

  return {
    version: 1,
    duration: { mode: "auto", ms: 6000 },
    stage: {
      chroma: false,
      color: "#00b140",
      hideUiOnPlay: true,
      // Both are lovely on the page and both key badly: the halo is a soft
      // additive glow that leaves a fringe of screen colour around the limb,
      // and the cloud sheet is semi-transparent white over it.
      halo: true,
      clouds: true,
      preroll: 0,
      loop: false,
      theme: "follow",
    },
    globe: {
      // Where the camera starts every take. "Use current view" in the panel
      // copies whatever is on screen into these three numbers.
      camera: { lat: 14, lon: -52, zoom: 0 },
      fade: track({ enabled: false, duration: 1200, easing: "quadOut", from: { y: 0, scale: 1 }, to: { y: 0, scale: 1 } }),
      spin: { enabled: true, delay: 0, speed: 60, duration: 3000, direction: 1 },
      stop: { duration: 1800, easing: "cubicOut" },
      zoom: { enabled: false, delay: 0, duration: 2000, easing: "cubicInOut", to: 0.45 },
      quality: "smooth",
    },
    visible: Object.fromEntries(TARGETS.map((t) => [t.key, t.key === "globe"])),
    tracks,
  };
}

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const bool = (v, fallback) => (typeof v === "boolean" ? v : fallback);
const str = (v, fallback) => (typeof v === "string" && v ? v : fallback);

const mergeVec = (base, over = {}) => ({
  opacity: num(over.opacity, base.opacity),
  x: num(over.x, base.x),
  y: num(over.y, base.y),
  scale: num(over.scale, base.scale),
  blur: num(over.blur, base.blur),
});

function mergeTrack(base, over = {}) {
  return {
    enabled: bool(over.enabled, base.enabled),
    delay: Math.max(0, num(over.delay, base.delay)),
    duration: Math.max(0, num(over.duration, base.duration)),
    easing: str(over.easing, base.easing),
    from: mergeVec(base.from, over.from),
    to: mergeVec(base.to, over.to),
  };
}

/**
 * Folds anything - a saved blob, a hand-typed JSON, half a config - onto the
 * defaults. The JSON editor leans on this hard: you can delete whole branches
 * and still get a playable timeline back.
 */
export function normalise(input) {
  const d = defaultConfig();
  const c = input && typeof input === "object" ? input : {};
  const stage = c.stage || {};
  const globe = c.globe || {};
  const cam = globe.camera || {};
  const spin = globe.spin || {};
  const stop = globe.stop || {};
  const zoom = globe.zoom || {};

  const out = {
    version: 1,
    duration: {
      mode: c.duration?.mode === "manual" ? "manual" : "auto",
      ms: Math.max(100, num(c.duration?.ms, d.duration.ms)),
    },
    stage: {
      chroma: bool(stage.chroma, d.stage.chroma),
      color: str(stage.color, d.stage.color),
      hideUiOnPlay: bool(stage.hideUiOnPlay, d.stage.hideUiOnPlay),
      halo: bool(stage.halo, d.stage.halo),
      clouds: bool(stage.clouds, d.stage.clouds),
      preroll: Math.max(0, Math.min(10, num(stage.preroll, d.stage.preroll))),
      loop: bool(stage.loop, d.stage.loop),
      theme: ["follow", "light", "dark"].includes(stage.theme) ? stage.theme : "follow",
    },
    globe: {
      camera: {
        lat: Math.max(-87, Math.min(87, num(cam.lat, d.globe.camera.lat))),
        lon: num(cam.lon, d.globe.camera.lon),
        zoom: Math.max(0, Math.min(1, num(cam.zoom, d.globe.camera.zoom))),
      },
      fade: mergeTrack(d.globe.fade, globe.fade),
      spin: {
        enabled: bool(spin.enabled, d.globe.spin.enabled),
        delay: Math.max(0, num(spin.delay, d.globe.spin.delay)),
        speed: num(spin.speed, d.globe.spin.speed),
        duration: Math.max(0, num(spin.duration, d.globe.spin.duration)),
        direction: num(spin.direction, d.globe.spin.direction) < 0 ? -1 : 1,
      },
      stop: {
        duration: Math.max(0, num(stop.duration, d.globe.stop.duration)),
        easing: str(stop.easing, d.globe.stop.easing),
      },
      zoom: {
        enabled: bool(zoom.enabled, d.globe.zoom.enabled),
        delay: Math.max(0, num(zoom.delay, d.globe.zoom.delay)),
        duration: Math.max(0, num(zoom.duration, d.globe.zoom.duration)),
        easing: str(zoom.easing, d.globe.zoom.easing),
        to: Math.max(0, Math.min(1, num(zoom.to, d.globe.zoom.to))),
      },
      quality: globe.quality === "full" ? "full" : "smooth",
    },
    visible: { ...d.visible },
    tracks: {},
  };

  for (const t of TARGETS) {
    if (typeof c.visible?.[t.key] === "boolean") out.visible[t.key] = c.visible[t.key];
  }
  for (const t of DOM_TARGETS) out.tracks[t.key] = mergeTrack(d.tracks[t.key], c.tracks?.[t.key]);

  return out;
}

/** How long the globe's own sequence runs, delay included. */
export function globeDuration(cfg) {
  const g = cfg.globe;
  let end = 0;
  if (g.spin.enabled) end = Math.max(end, g.spin.delay + g.spin.duration + g.stop.duration);
  if (g.zoom.enabled) end = Math.max(end, g.zoom.delay + g.zoom.duration);
  if (g.fade.enabled) end = Math.max(end, g.fade.delay + g.fade.duration);
  return end;
}

/** The length of the whole take: the last thing to finish, or the manual value. */
export function timelineDuration(cfg) {
  if (cfg.duration.mode === "manual") return Math.max(100, cfg.duration.ms);
  let end = globeDuration(cfg);
  for (const t of DOM_TARGETS) {
    const tr = cfg.tracks[t.key];
    if (tr?.enabled) end = Math.max(end, tr.delay + tr.duration);
  }
  // A short tail, so a take does not cut on the very frame it lands.
  return Math.max(500, Math.round(end + 400));
}
