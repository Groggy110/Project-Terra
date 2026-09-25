/**
 * The claim this file exists to check: coming in on a city shows the city.
 *
 * Three things have to hold, and none of them is visible in a screenshot on
 * its own. The tile window has to sit over the ground the camera is looking at
 * — a Mercator/equirectangular mix-up puts imagery a long way north of where
 * it belongs and still looks like a map. The handover has to be a handover:
 * nothing at the whole globe, everything at a city. And the imagery has to
 * actually be resolving detail, which is measured here as pixel variance in
 * the middle of the frame — a smeared texel has almost none, a street grid has
 * a lot.
 *
 * Run with the dev server up:  node tools/verify-imagery.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.TERRA_URL || "http://127.0.0.1:5173";
const SHOTS = process.env.TERRA_SHOTS || "";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const browser = await chromium.launch({ channel: "chrome", args: ["--use-gl=angle", "--use-angle=metal"] });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(`${BASE}/?demo`, { waitUntil: "load" });
await page.waitForFunction(() => document.querySelector(".boot.is-done"), { timeout: 45000 });
await wait(2200);

await page.evaluate(() => {
  document.querySelector(".hero").style.display = "none";
  window.terra.globe.controls.setSpin(false);
  window.terra.globe.controls.holdSpin(true);
});

const enabled = await page.evaluate(() => window.terra.globe.imagery.enabled);
check("a tile source is configured", enabled, enabled ? "" : "no provider or key — the rest is skipped");

/** Parks the camera and lets the layer stream until it stops changing. */
async function settle(lat, lon, zoom, ms = 9000) {
  await page.evaluate(
    ({ lat, lon, zoom }) => {
      const g = window.terra.globe;
      const c = g.controls;
      c.flight = null;
      c.vel.lat = c.vel.lon = 0;
      c.lat = c.target.lat = lat;
      c.lon = c.target.lon = lon;
      c.dist = c.target.dist = g.distForZoom(zoom);
      c.update(0);
      // Writing the camera behind the controls' back means the frame loop
      // never sees a move, and the whole service pass — vectors, tiles,
      // labels — is skipped. A real gesture sets this; this harness has to.
      g.dirty = true;
    },
    { lat, lon, zoom },
  );
  const until = Date.now() + ms;
  let last = -1;
  while (Date.now() < until) {
    await wait(350);
    const s = await page.evaluate(() => {
      const g = window.terra.globe;
      return g.imagery.coverage + g.detailMix;
    });
    if (Math.abs(s - last) < 0.001 && s > 0) break;
    last = s;
  }
  return page.evaluate(() => {
    const g = window.terra.globe;
    return {
      mix: g.detailMix,
      coverage: g.imagery.coverage,
      z: g.imagery.stats.z,
      exact: g.imagery.stats.exact,
      failed: g.imagery.stats.failed,
      lat: g.controls.lat,
      lon: g.controls.lon,
    };
  });
}

/**
 * Mean absolute difference between neighbouring pixels in the middle of the
 * frame. Independent of brightness, so it measures structure rather than
 * exposure: this is what "a smear" versus "a city" comes down to numerically.
 */
async function detail() {
  return page.evaluate(() => {
    const g = window.terra.globe;
    g.syncSun();
    g.renderer.render(g.scene, g.camera);
    const N = 220;
    const off = document.createElement("canvas");
    off.width = off.height = N;
    const ctx = off.getContext("2d");
    const s = Math.min(g.canvas.width, g.canvas.height) * 0.42;
    ctx.drawImage(g.canvas, (g.canvas.width - s) / 2, (g.canvas.height - s) / 2, s, s, 0, 0, N, N);
    const px = ctx.getImageData(0, 0, N, N).data;
    let sum = 0;
    let n = 0;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N - 1; x++) {
        const i = (y * N + x) * 4;
        sum += Math.abs(px[i] - px[i + 4]) + Math.abs(px[i + 1] - px[i + 5]) + Math.abs(px[i + 2] - px[i + 6]);
        n += 3;
      }
    }
    return sum / n;
  });
}

/** Runs `fn` with the imagery forced off, then puts the mix back. */
async function withoutImagery(fn) {
  const was = await page.evaluate(() => {
    const g = window.terra.globe;
    const m = g.detailMix;
    g.detailMix = 0;
    g.earth.uniforms.uDetailMix.value = 0;
    g.earth.uniforms.uLineMix.value = 1;
    return m;
  });
  const out = await fn();
  await page.evaluate((m) => {
    const g = window.terra.globe;
    g.detailMix = m;
    g.earth.uniforms.uDetailMix.value = m;
    g.earth.uniforms.uLineMix.value = 1 - 0.5 * m;
  }, was);
  return out;
}

if (enabled) {
  // --- the whole globe: painted, and only painted -------------------------
  const world = await settle(14, -52, 0);
  check("no imagery at the whole globe", world.mix < 0.02, `mix ${world.mix.toFixed(3)}`);

  // --- Bangkok, the case that started this --------------------------------
  const city = await settle(13.7563, 100.5018, 1, 16000);
  const sharp = await detail();
  // The honest comparison is the same camera with the layer switched off —
  // the painted globe at the same place, at the same exposure. Anything else
  // measures the difference between two views rather than two maps.
  const flat = await withoutImagery(detail);

  check("imagery takes over at a city", city.mix > 0.85, `mix ${city.mix.toFixed(3)}`);
  check("the window is fully covered", city.coverage > 0.999, `coverage ${city.coverage.toFixed(3)}`);
  check("every tile is at its own zoom", city.exact?.split("/")[0] === city.exact?.split("/")[1], `${city.exact}`);
  check("tiles are asked for at the zoom the camera is at", city.z >= 11, `z${city.z}`);
  check("no tile requests failed", city.failed === 0, `${city.failed} failed`);
  check("the ground resolves detail", sharp > flat * 2.4, `${flat.toFixed(2)} -> ${sharp.toFixed(2)} per channel`);

  // --- the window is over the right ground --------------------------------
  // Reads the Mercator window back and converts it to latitude, which is the
  // step a projection mix-up gets wrong.
  const box = await page.evaluate(() => {
    const w = window.terra.globe.imagery.window;
    const lat = (m) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * m))) * 180) / Math.PI;
    return {
      lonMin: w.x * 360 - 180,
      lonMax: (w.x + w.z) * 360 - 180,
      latMax: lat(w.y),
      latMin: lat(w.y + w.w),
    };
  });
  const holds =
    box.latMin < 13.7563 && box.latMax > 13.7563 && box.lonMin < 100.5018 && box.lonMax > 100.5018;
  check(
    "the tile window contains the point the camera is over",
    holds,
    `lat ${box.latMin.toFixed(2)}..${box.latMax.toFixed(2)}, lon ${box.lonMin.toFixed(2)}..${box.lonMax.toFixed(2)}`,
  );

  if (SHOTS) {
    await page.screenshot({ path: `${SHOTS}/city-dark.png` });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
      window.terra.globe.setTheme("light");
    });
    await wait(900);
    await page.screenshot({ path: `${SHOTS}/city-light.png` });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
      window.terra.globe.setTheme("dark");
    });
  }
}

check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
