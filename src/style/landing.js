/**
 * The landing screen's look, and the page's two scenes.
 *
 * STYLE is always the look on screen. Behind it this module keeps a whole
 * copy for each scene — the landing screen and the working view — so that
 * whatever is edited while one is showing belongs to that one, and stepping
 * between them blends every value that differs over the planet's flight.
 *
 * The landing scene starts as STYLE with LANDING laid over it: only what
 * differs is named there — a wide, soft bloom and a gentler aberration, and a
 * faint blue halo that spreads off the limb rather than the working view's
 * tight grey rim.
 *
 * The stage (where the planet stands and how big), the flight off it and the
 * headline are not STYLE, but live here too so the style editor can reach
 * them; app.js reads them.
 */
import { STYLE, STYLE_DEFAULTS } from "./styleConfig.js";
import { applyStyle, groupOf, mergeInto } from "./applyStyle.js";

export const LANDING = {
  post: {
    bloom: { strength: 0.42, radius: 1.8, threshold: 0.42 },
    chromatic: { amount: 0.0021 },
    // The landing frames a quarter of the planet across the whole window, so
    // the imagery is magnified most there; it takes a little more crisping.
    sharpen: { amount: 0.38 },
  },
  themes: {
    dark: {
      atmosphere: {
        halo: {
          inner: "#798fe6",
          strength: 0.06,
          spread: 0.262,
          falloff: 0.7,
          bloom: 0.08,
          bloomSpread: 0.69,
          rimPower: 8.9,
          spillPower: 1.9,
        },
      },
    },
  },
};

/**
 * The landing stage: the planet rising from the foot of the window like a
 * horizon, the headline standing on its rim and the find bar low on the disc.
 * `rim` is where the top of the disc sits, as a fraction of the height — just
 * above the middle — but never so high that the headline has no sky
 * (`minRim`, px); the headline hangs from it through --stage-rim (base.css).
 * At `scale` 1 the disc's size is whatever puts its edge through both bottom
 * corners of the window, so the planet's shoulders meet the frame exactly at
 * any shape of window (held to `maxSize` heights on a very wide one); `scale`
 * grows or shrinks it from there, the top staying on the rim. `x` slides it
 * sideways, as a fraction of the width. `spin` is how fast it turns there,
 * in degrees a second — slow, so the page reads as calm rather than busy.
 * `rise` is how far below its place it starts as the page opens. `home` tips the view south so the cap that shows
 * is Asia rather than the Arctic: Southeast Asia and the Philippines, a
 * little west of centre so the drift carries them across.
 */
export const STAGE = { rim: 0.47, minRim: 300, maxSize: 3, scale: 0.94, x: 0, spin: 1.4, rise: 0.1, home: { lat: -22, lon: 106 } };

/**
 * Stepping off the stage: the planet comes up to the centre on the camera's
 * own curve (Globe.settle), turning `turn` degrees onward in the direction it
 * is already spinning, and lands a touch closer than the ordinary working
 * view, so it arrives large rather than seeming to back away. The look blends
 * over the same `ms`.
 */
export const STAGE_EXIT = { ms: 2600, dist: 3.05, turn: 14 };

/**
 * The headline over the stage, as base.css custom properties: `size` scales
 * the type, `raise` (px) lifts it off the rim, `fade` is the opacity its foot
 * dims to, `glow` the strength of the light round the letters. `stroke` is
 * the width of the white outline round "anywhere." and `aura` the strength
 * of the moving colour behind it (both ×; 0 turns them off). `fill` is how
 * much of the blue inside "anywhere." is kept, the rest going to the sky's
 * colour: under 1 lets the outline stand out.
 */
export const HEADLINE = { size: 0.98, raise: 10, fade: 0.78, glow: 0.34, stroke: 0.73, aura: 0.26, fill: 0.21 };

/** The shipped values of the three above, for the editor's resets. */
export const LANDING_DEFAULTS = structuredClone({ stage: STAGE, exit: STAGE_EXIT, headline: HEADLINE });

/** Writes HEADLINE into the page. */
export function applyHeadline() {
  const s = document.documentElement.style;
  s.setProperty("--title-scale", String(HEADLINE.size));
  s.setProperty("--title-nudge", `${HEADLINE.raise}px`);
  s.setProperty("--title-fade", String(HEADLINE.fade));
  s.setProperty("--title-glow", String(HEADLINE.glow));
  s.setProperty("--title-stroke", String(HEADLINE.stroke));
  s.setProperty("--title-aura", String(HEADLINE.aura));
  s.setProperty("--title-fill-pc", `${Math.round(HEADLINE.fill * 100)}%`);
}

/* ----------------------------------------------------------------- scenes */

const clone = (v) => structuredClone(v);
const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);

/** Each scene's whole look. The one on screen is STYLE itself; see sync(). */
const profiles = { landing: null, main: null };
let scene = "main";
/** The blend under way, if any: { to, raf }. */
let blending = null;
const listeners = new Set();

/** The scene on screen ("landing" | "main"), or the one being blended to. */
export const currentScene = () => blending?.to ?? scene;

/** Whether this visit has a landing scene at all (phones do not). */
export const hasLanding = () => !!profiles.landing;

/** Called with the scene's name whenever one has fully arrived. */
export function onScene(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The shipped look of a scene: what the editor's resets and A/B go back to. */
export function sceneDefaults(name = currentScene()) {
  const base = clone(STYLE_DEFAULTS);
  return name === "landing" ? mergeInto(base, LANDING) : base;
}

/** A scene's whole look as it stands, whether or not it is on screen. */
export function sceneStyle(name) {
  return clone(!blending && name === scene ? STYLE : profiles[name]);
}

/**
 * Replaces a scene's look — an import, say. If it is the scene on screen,
 * STYLE takes it too (and the caller applies).
 */
export function setSceneStyle(name, style) {
  if (!profiles[name]) return;
  profiles[name] = mergeInto(clone(profiles[name]), style);
  if (name === currentScene() && !blending) mergeInto(STYLE, style);
}

/** Everything the landing screen is, for an export. */
export function landingPayload() {
  return {
    style: profiles.landing ? sceneStyle("landing") : null,
    stage: clone(STAGE),
    exit: clone(STAGE_EXIT),
    headline: clone(HEADLINE),
  };
}

/** Reads a landingPayload() back. */
export function loadLanding(data) {
  if (!isObject(data)) return;
  // From the shipped landing look, so the file decides every value it has.
  if (isObject(data.style)) setSceneStyle("landing", mergeInto(sceneDefaults("landing"), data.style));
  if (isObject(data.stage)) mergeInto(STAGE, data.stage);
  if (isObject(data.exit)) mergeInto(STAGE_EXIT, data.exit);
  if (isObject(data.headline)) mergeInto(HEADLINE, data.headline);
  applyHeadline();
}

/** Opens the visit on the landing scene: its look on at once. */
export function enterLanding() {
  applyHeadline();
  profiles.main ??= clone(STYLE);
  profiles.landing ??= mergeInto(clone(STYLE), LANDING);
  go("landing", 0);
}

/** Eases from the landing look into the working one over `ms`. */
export function leaveLanding(ms = STAGE_EXIT.ms) {
  if (profiles.landing) go("main", ms);
}

/** Back from the working view to the landing look, over `ms`. */
export function returnToLanding(ms = STAGE_EXIT.ms) {
  if (profiles.landing) go("landing", ms);
}

function go(to, ms) {
  // What was on screen belongs to the scene it was — unless it was still on
  // its way somewhere, in which case it is a mixture and belongs to nobody.
  if (!blending) profiles[scene] = clone(STYLE);
  else cancelAnimationFrame(blending.raf);
  const leaves = collect(STYLE, profiles[to], [], []);
  const groups = [...new Set(leaves.map((l) => l.group))];
  const done = () => {
    blending = null;
    scene = to;
    for (const fn of listeners) fn(to);
  };
  if (!leaves.length) return done();
  blending = { to, raf: 0 };
  const t0 = performance.now();
  const step = (now) => {
    const k = ms > 0 ? Math.min((now - t0) / ms, 1) : 1;
    const t = k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;
    for (const l of leaves) l.obj[l.key] = t >= 1 ? l.to : mix(l.from, l.to, t);
    applyStyle(STYLE, { groups });
    if (k < 1) blending.raf = requestAnimationFrame(step);
    else done();
  };
  if (ms > 0) blending.raf = requestAnimationFrame(step);
  else step(performance.now());
}

/** Every leaf where `target` differs from `live`: { obj, key, from, to, group }. */
function collect(live, target, path, out) {
  for (const key of Object.keys(live)) {
    if (!(key in target)) continue;
    const a = live[key];
    const b = target[key];
    if (isObject(a)) collect(a, b, [...path, key], out);
    else if (a !== b && typeof a === typeof b) out.push({ obj: live, key, from: a, to: b, group: groupOf([...path, key].join(".")) });
  }
  return out;
}

const HEX = /^#[0-9a-f]{6}$/i;
const rgb = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

/** Numbers and #rrggbb colours ease; anything else changes half way. */
function mix(a, b, t) {
  if (typeof a === "number") return a + (b - a) * t;
  if (HEX.test(a) && HEX.test(b)) {
    const [x, y] = [rgb(a), rgb(b)];
    return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("");
  }
  return t < 0.5 ? a : b;
}
