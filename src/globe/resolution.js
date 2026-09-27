/**
 * Resolution scaling.
 *
 * The earth's fragment shader is not cheap and is not meant to be: a 27-cell
 * Voronoi, five gradient taps for the hillshade, the grade, the terminator and
 * the rim, on every pixel of a full-screen sphere — and then the cloud shell
 * and the halo over it. On a desktop GPU that is nothing. On a phone holding a
 * megapixel drawing buffer it is the entire frame budget, and the globe drags
 * behind the finger.
 *
 * Rather than guess which devices are which, the renderer measures itself and
 * gives resolution back until the frames fit. Steps, not a continuous ramp,
 * because changing the pixel ratio reallocates the drawing buffer; hysteresis,
 * because a scaler that can oscillate will, and a globe visibly breathing
 * between two sharpnesses is worse than one that is simply a little soft.
 */

const RES_STEPS = [0.55, 0.7, 0.85, 1];
/** The slowest cadence counted as keeping up: 60Hz, with a little slack. */
const CADENCE_FLOOR_MS = 16;
/** Frames considered per decision. About three quarters of a second. */
const RES_WINDOW = 48;
/** Floor between changes, either way. */
const RES_HOLD_MS = 900;

/**
 * Decides the next resolution step from a window of frame durations.
 *
 * Pulled out as a function, and a pure one, because the interesting part is a
 * judgement that cannot be observed on the machine this was written on — and
 * an adaptive scaler that is never seen to adapt is just a comment. See
 * tools/verify-scaler.mjs, which runs real traces through it.
 *
 * The measure is a *ratio*, not a millisecond budget, and that is the whole
 * design. A frame budget has to be either 16.7ms or 8.3ms and cannot be both,
 * so it is wrong on half of all phones — and worse, vsync means a struggling
 * device does not produce slow frames at all. It produces *dropped* ones: the
 * cadence goes 17, 33, 17, 33, never settling anywhere a "consecutive slow
 * frames" test can see it, which is exactly how the first version of this
 * managed to never once fire. Comparing the mean against the shortest frames
 * in the same window reads that pattern for what it is — a device presenting
 * two frames' worth of time for every frame it finishes — and works the same
 * whether the panel runs at 60Hz or 120.
 */
export function pickResolution(samples, current) {
  const i = RES_STEPS.indexOf(current);
  if (i < 0 || samples.length < RES_WINDOW) return current;

  const sorted = [...samples].sort((a, b) => a - b);
  // The display's own cadence: the quickest frames it managed, which is what
  // it does when nothing is in the way — but never quicker than 60Hz. A
  // steady sixty is smooth, and on a 120Hz panel the scaler used to buy the
  // other sixty with sharpness: the look drawn at 70% and softened, for
  // frames nobody asked for. Below sixty it still gives resolution back.
  const base = Math.max(sorted[Math.floor(sorted.length * 0.2)], CADENCE_FLOOR_MS);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const ratio = mean / base;

  // Dropping frames against its own cadence, or simply slower than ~45fps in
  // absolute terms — the second catches a device with no vsync to drop
  // against, where the ratio alone reads as perfectly healthy.
  if ((ratio > 1.35 || mean > 22) && i > 0) return RES_STEPS[i - 1];
  // Earned back only when it is comfortably keeping up on both measures.
  if (ratio < 1.12 && mean < 19 && i < RES_STEPS.length - 1) return RES_STEPS[i + 1];
  return current;
}

export { RES_STEPS, RES_WINDOW, RES_HOLD_MS };
