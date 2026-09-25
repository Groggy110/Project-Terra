/**
 * The claim this file exists to check: the resolution scaler reads a real
 * device correctly.
 *
 * It exists because the judgement cannot be observed where it was written. A
 * desktop GPU draws this globe in two milliseconds, so no amount of poking at
 * a browser on this machine will ever produce the condition the scaler is for
 * — and the first version of it, which looked entirely reasonable, turned out
 * to be incapable of firing at all: it waited for eight consecutive slow
 * frames, and vsync means a struggling phone never produces two in a row. It
 * produces 17, 33, 17, 33.
 *
 * So the decision is a pure function and these are traces: what a frame log
 * actually looks like on a 60Hz phone that is coping, a 60Hz phone that is
 * not, a 120Hz phone at both, and the awkward ones in between.
 *
 *   node tools/verify-scaler.mjs
 */
import { pickResolution } from "../src/globe/resolution.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const N = 48;
/** A frame log: `pattern` repeated, with a little jitter, N frames long. */
const trace = (pattern, jitter = 0.4) =>
  Array.from({ length: N }, (_, i) => pattern[i % pattern.length] + (Math.random() - 0.5) * 2 * jitter);

/** Runs the scaler to a fixed point, the way the frame loop would. */
function settle(samples, from = 1) {
  let res = from;
  for (let i = 0; i < 8; i++) {
    const next = pickResolution(samples, res);
    if (next === res) return res;
    res = next;
  }
  return res;
}

/* ---------------------------------------------------------- healthy kit */

check(
  "60Hz keeping up — stays at full resolution",
  pickResolution(trace([16.7]), 1) === 1,
  "16.7ms flat",
);

check(
  "120Hz keeping up — stays at full resolution",
  pickResolution(trace([8.3]), 1) === 1,
  "8.3ms flat",
);

/* ------------------------------------------------- the case that failed */

check(
  "60Hz dropping every other frame — steps down",
  pickResolution(trace([16.7, 33.3]), 1) < 1,
  "17/33 alternating, mean 25",
);

check(
  "120Hz dropping to 60 — steps down",
  pickResolution(trace([8.3, 16.7]), 1) < 1,
  "8/17 alternating",
);

check(
  "a device with no vsync to drop against — steps down on the absolute test",
  pickResolution(trace([27]), 1) < 1,
  "27ms flat, ratio reads as 1.0",
);

/* ------------------------------------------------------------ hysteresis */

check(
  "a phone at a third of its cadence lands on the floor, not below it",
  settle(trace([16.7, 33.3, 50])) === 0.55,
  "worst case clamps at 0.55",
);

check(
  "60Hz keeping up climbs back to full from the floor",
  settle(trace([16.7]), 0.55) === 1,
  "recovers",
);

check(
  "the two thresholds cannot meet — a healthy 60Hz trace is stable at every step",
  [0.55, 0.7, 0.85, 1].every((r) => {
    const next = pickResolution(trace([16.7]), r);
    return next === r || next > r;
  }),
  "no step both raises and lowers",
);

check(
  "a borderline trace does not oscillate",
  (() => {
    // 19ms on a 16.7 cadence: not comfortable, not dropping. Must sit still.
    let res = 0.85;
    const seen = new Set();
    for (let i = 0; i < 12; i++) {
      res = pickResolution(trace([19]), res);
      seen.add(res);
    }
    return seen.size <= 2;
  })(),
  "19ms flat",
);

/* --------------------------------------------------------------- safety */

check(
  "a short window is never acted on",
  pickResolution([40, 40, 40], 1) === 1,
  "3 samples",
);

check(
  "an unknown current step is left alone",
  pickResolution(trace([33]), 0.9) === 0.9,
  "0.9 is not a step",
);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
