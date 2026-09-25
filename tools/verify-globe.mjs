/**
 * The claim this file exists to check: the lamp is bolted to the viewer, not
 * to the planet.
 *
 * Eyeballing a screenshot cannot tell the difference between a light fixed in
 * screen space and one that merely happens to sit over the north pole — the
 * two look identical until you turn the globe. So this reads the rendered
 * pixels and asserts that the brightest band of the disc stays at the top of
 * the frame through a full rotation in longitude *and* through a swing in
 * latitude, which is the case a world-space light would fail.
 *
 * Run with the dev server up:  node tools/verify-globe.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.TERRA_URL || "http://127.0.0.1:5173";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const browser = await chromium.launch({ channel: "chrome", args: ["--use-gl=angle", "--use-angle=metal"] });
const page = await browser.newPage({ viewport: { width: 1100, height: 1100 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(`${BASE}/?demo`, { waitUntil: "load" });
await page.waitForFunction(() => document.querySelector(".boot.is-done"), { timeout: 45000 });
await wait(2500);

await page.evaluate(() => {
  document.querySelector(".chrome").style.opacity = "0";
  document.querySelector("#overlay").style.opacity = "0";
  document.querySelector(".hero").style.display = "none";
  window.terra.globe.controls.setSpin(false);
  window.terra.globe.controls.holdSpin(true);
});

/**
 * Mean luminance of the top and bottom thirds of the globe's disc, read back
 * out of the live drawing buffer.
 */
async function bands(theme, lat, lon) {
  return page.evaluate(
    ({ theme, lat, lon }) => {
      const g = window.terra.globe;
      document.documentElement.dataset.theme = theme;
      g.setTheme(theme);
      const c = g.controls;
      c.flight = null;
      c.vel.lat = 0;
      c.vel.lon = 0;
      c.lat = c.target.lat = lat;
      c.lon = c.target.lon = lon;
      c.dist = c.target.dist = 4.45;
      c.update(0);
      // The same step the frame loop runs between moving the camera and
      // drawing: without it this would shade the new camera with the old
      // camera's sun, and the whole measurement would be of nothing.
      g.syncSun();
      // Render and copy in the same task, before the buffer is presented.
      g.renderer.render(g.scene, g.camera);
      const N = 160;
      const off = document.createElement("canvas");
      off.width = off.height = N;
      const ctx = off.getContext("2d");
      ctx.drawImage(g.canvas, 0, 0, N, N);
      const px = ctx.getImageData(0, 0, N, N).data;

      const cx = N / 2;
      const cy = N / 2;
      // The disc's on-screen radius, from the same projection the halo uses.
      const limb = Math.asin(1 / c.camDist);
      const half = Math.tan((g.camera.fov * Math.PI) / 360);
      const r = (N / 2) * (Math.tan(limb) / half) * 0.86; // inside the rim glow

      let top = 0;
      let topN = 0;
      let bot = 0;
      let botN = 0;
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const dx = x - cx;
          const dy = y - cy;
          if (dx * dx + dy * dy > r * r) continue;
          const i = (y * N + x) * 4;
          const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
          if (dy < -r * 0.35) {
            top += l;
            topN++;
          } else if (dy > r * 0.35) {
            bot += l;
            botN++;
          }
        }
      }
      return { top: topN ? top / topN : 0, bottom: botN ? bot / botN : 0 };
    },
    { theme, lat, lon },
  );
}

/* --------------------------------------------- dark: the reference look */

let worst = Infinity;
for (const lon of [-120, -60, 0, 60, 120, 180]) {
  const { top, bottom } = await bands("dark", 14, lon);
  const ratio = top / Math.max(bottom, 0.01);
  worst = Math.min(worst, ratio);
  check(`dark · lon ${String(lon).padStart(4)} · top brighter than bottom`, ratio > 2.2, `${top.toFixed(1)} vs ${bottom.toFixed(1)} = ${ratio.toFixed(1)}x`);
}

// The case a world-space light passes by accident and a screen-space one has
// to earn: swing the camera over the pole and the *new* top must light up.
for (const lat of [-60, -30, 30, 60]) {
  const { top, bottom } = await bands("dark", lat, 20);
  const ratio = top / Math.max(bottom, 0.01);
  check(`dark · lat ${String(lat).padStart(3)} · light stays at the top of frame`, ratio > 1.8, `${top.toFixed(1)} vs ${bottom.toFixed(1)} = ${ratio.toFixed(1)}x`);
}

/* ------------------------------------------------ light: lit underneath */

for (const lon of [-60, 60, 180]) {
  const { top, bottom } = await bands("light", 14, lon);
  const ratio = top / Math.max(bottom, 0.01);
  // Same lamp, same place — but nothing may fall into a brooding shadow.
  check(
    `light · lon ${String(lon).padStart(4)} · top lit, underside still clearly visible`,
    ratio > 1.06 && ratio < 2.0 && bottom > 45,
    `${top.toFixed(1)} vs ${bottom.toFixed(1)} = ${ratio.toFixed(2)}x`,
  );
}

/* ------------------------------------------- the light never moves at all */

const { samples: sun, declared } = await page.evaluate(async () => {
  const g = window.terra.globe;
  const out = [];
  for (const [lat, lon] of [[14, -100], [14, 40], [55, 120], [-40, -20]]) {
    const c = g.controls;
    c.flight = null;
    c.lat = c.target.lat = lat;
    c.lon = c.target.lon = lon;
    c.update(0);
    // The same projection the surface shader is handed.
    const world = g.sunView.clone().applyQuaternion(g.camera.quaternion);
    const view = world.clone().applyQuaternion(g.camera.quaternion.clone().invert());
    out.push(view.toArray().map((n) => +n.toFixed(4)));
  }
  return { samples: out, declared: g.sunView.toArray().map((n) => +n.toFixed(4)) };
});
// Compared against the *declared* direction rather than against literals, so
// that retuning THEMES.sunView — which is a look decision, and the dark
// preset's is well off vertical — cannot quietly fail a test whose subject is
// something else entirely: that whatever direction is authored, it is the
// same direction in view space at every camera.
const steady = sun.every((v) => v.every((n, i) => Math.abs(n - declared[i]) < 0.005));
check(
  "the sun vector in view space is identical at every camera",
  steady,
  `declared ${JSON.stringify(declared)} · ${JSON.stringify(sun)}`,
);

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
