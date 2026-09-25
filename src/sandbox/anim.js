/**
 * The animation maths behind capture mode: a library of easing curves, a
 * cubic-bezier solver so any curve can be typed in by hand, and the small
 * integral trick that turns "decelerate to a stop with this easing" into a
 * position you can address by time.
 *
 * Everything here is *time-addressable* rather than integrated frame by
 * frame. That is the whole reason the scrubber works: asking for the state at
 * 2.4s gives the same answer whether you played there or dragged there, and a
 * recording made at 30fps lands in exactly the same place as one made at 120.
 */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

const pow = Math.pow;

/** t in 0..1 -> eased 0..1. All of them satisfy f(0) = 0 and f(1) = 1. */
export const EASINGS = {
  linear: (t) => t,

  sineIn: (t) => 1 - Math.cos((t * Math.PI) / 2),
  sineOut: (t) => Math.sin((t * Math.PI) / 2),
  sineInOut: (t) => -(Math.cos(Math.PI * t) - 1) / 2,

  quadIn: (t) => t * t,
  quadOut: (t) => 1 - (1 - t) * (1 - t),
  quadInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2),

  cubicIn: (t) => t * t * t,
  cubicOut: (t) => 1 - pow(1 - t, 3),
  cubicInOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2),

  quartIn: (t) => t * t * t * t,
  quartOut: (t) => 1 - pow(1 - t, 4),
  quartInOut: (t) => (t < 0.5 ? 8 * t * t * t * t : 1 - pow(-2 * t + 2, 4) / 2),

  quintOut: (t) => 1 - pow(1 - t, 5),

  expoIn: (t) => (t <= 0 ? 0 : pow(2, 10 * t - 10)),
  expoOut: (t) => (t >= 1 ? 1 : 1 - pow(2, -10 * t)),
  expoInOut: (t) =>
    t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? pow(2, 20 * t - 10) / 2 : (2 - pow(2, -20 * t + 10)) / 2,

  circOut: (t) => Math.sqrt(1 - pow(t - 1, 2)),
  circInOut: (t) =>
    t < 0.5 ? (1 - Math.sqrt(1 - pow(2 * t, 2))) / 2 : (Math.sqrt(1 - pow(-2 * t + 2, 2)) + 1) / 2,

  backOut: (t) => 1 + 2.70158 * pow(t - 1, 3) + 1.70158 * pow(t - 1, 2),

  elasticOut: (t) =>
    t <= 0 ? 0 : t >= 1 ? 1 : pow(2, -10 * t) * Math.sin(((t * 10 - 0.75) * (2 * Math.PI)) / 3) + 1,

  /* The two the production page itself uses, so a sandbox animation can be
     matched to the real chrome's motion without guessing at the numbers. */
  terraEase: bezier(0.22, 0.61, 0.24, 1),
  terraEaseOut: bezier(0.16, 0.84, 0.28, 1),
  terraEaseMove: bezier(0.4, 0.02, 0.2, 1),
};

/** Grouped for the picker, in the order a person looks for them. */
export const EASING_GROUPS = [
  ["Linear", ["linear"]],
  ["Ease out", ["sineOut", "quadOut", "cubicOut", "quartOut", "quintOut", "expoOut", "circOut", "backOut", "elasticOut"]],
  ["Ease in", ["sineIn", "quadIn", "cubicIn", "quartIn", "expoIn"]],
  ["Ease in-out", ["sineInOut", "quadInOut", "cubicInOut", "quartInOut", "expoInOut", "circInOut"]],
  ["Terra", ["terraEase", "terraEaseOut", "terraEaseMove"]],
];

export const EASING_NAMES = EASING_GROUPS.flatMap(([, names]) => names);

/**
 * A CSS cubic-bezier(x1, y1, x2, y2), solved the way the browser solves it:
 * Newton-Raphson on x, falling back to bisection when the curve is too flat
 * for the derivative to help.
 */
export function bezier(x1, y1, x2, y2) {
  const A = (a, b) => 1 - 3 * b + 3 * a;
  const B = (a, b) => 3 * b - 6 * a;
  const C = (a) => 3 * a;
  const calc = (t, a, b) => ((A(a, b) * t + B(a, b)) * t + C(a)) * t;
  const slope = (t, a, b) => 3 * A(a, b) * t * t + 2 * B(a, b) * t + C(a);

  if (x1 === y1 && x2 === y2) return (t) => t;

  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let guess = t;
    for (let i = 0; i < 8; i++) {
      const slp = slope(guess, x1, x2);
      if (slp === 0) break;
      guess -= (calc(guess, x1, x2) - t) / slp;
    }
    // Newton can wander outside the unit interval on a near-vertical curve.
    if (!(guess >= 0 && guess <= 1)) {
      let lo = 0;
      let hi = 1;
      guess = t;
      for (let i = 0; i < 24; i++) {
        const x = calc(guess, x1, x2);
        if (Math.abs(x - t) < 1e-6) break;
        if (x > t) hi = guess;
        else lo = guess;
        guess = (lo + hi) / 2;
      }
    }
    return calc(guess, y1, y2);
  };
}

const BEZIER_RE = /^cubic-bezier\(\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*\)$/i;

/**
 * Takes either a name from EASINGS or a literal `cubic-bezier(a,b,c,d)`, so
 * the JSON config can carry a curve that has no name.
 */
export function resolveEasing(spec) {
  if (typeof spec === "function") return spec;
  const name = String(spec ?? "linear").trim();
  if (EASINGS[name]) return EASINGS[name];
  const m = BEZIER_RE.exec(name);
  if (m) {
    const p = m.slice(1, 5).map(Number);
    if (p.every(Number.isFinite)) return bezier(p[0], p[1], p[2], p[3]);
  }
  return EASINGS.linear;
}

export const isBezierSpec = (spec) => BEZIER_RE.test(String(spec ?? "").trim());

/* --------------------------------------------------------- deceleration */

const LUT = 600;

/**
 * The globe's slowdown is described as a *speed* curve: it leaves the spin at
 * full rate and the easing says how that rate falls away, so `speed(u) = v *
 * (1 - ease(u))`. What the camera needs is an angle, which is the integral of
 * that — and an integral that can be sampled at an arbitrary u, not one
 * accumulated a frame at a time.
 *
 * So integrate once, by trapezoid, into a table; reading it back is a lerp.
 * The returned function gives the *fraction of v * duration* travelled by u,
 * and its value at 1 is how far a full stop carries you (0.5 for a linear
 * ramp-down, 0.25 for cubicOut's long tail, and so on).
 */
export function decelIntegral(easeFn) {
  const table = new Float64Array(LUT + 1);
  let acc = 0;
  let prev = 1 - easeFn(0);
  for (let i = 1; i <= LUT; i++) {
    const cur = 1 - easeFn(i / LUT);
    acc += ((prev + cur) / 2) / LUT;
    table[i] = acc;
    prev = cur;
  }
  const total = table[LUT];
  const at = (u) => {
    if (u <= 0) return 0;
    if (u >= 1) return total;
    const x = u * LUT;
    const i = Math.floor(x);
    return lerp(table[i], table[i + 1], x - i);
  };
  at.total = total;
  return at;
}

/* --------------------------------------------------------------- sampling */

/**
 * Where a track is at time `t` (ms from the start of the timeline), as a 0..1
 * eased progress. Before its delay it sits at 0; after it, at 1.
 */
export function trackProgress(track, t, easeFn) {
  const local = t - (track.delay || 0);
  const ms = Math.max(track.duration || 0, 0);
  if (local <= 0) return 0;
  if (ms <= 0) return 1;
  return easeFn(clamp(local / ms, 0, 1));
}

/** Samples an easing into `n` points, for the little curve preview. */
export function sampleCurve(easeFn, n = 48) {
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push([i / n, easeFn(i / n)]);
  return pts;
}
