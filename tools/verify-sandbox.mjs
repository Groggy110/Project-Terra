/**
 * Functional pass over the sandbox: asserts that the design overrides land,
 * that capture mode isolates and restores, that the timeline is
 * time-addressable, and — the one that matters most — that none of it leaks
 * into the production page.
 *
 * Run with the dev server up:  node tools/verify-sandbox.mjs
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
const page = await browser.newPage({ viewport: { width: 1512, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(`${BASE}/sandbox.html`, { waitUntil: "load" });
await page.waitForFunction(() => window.sbx && window.terra?.globe, { timeout: 45000 });
await wait(1400);

/* ---------------------------------------------------------------- shell */

check("sandbox mounted", await page.evaluate(() => !!window.sbx && !!document.querySelector(".sbx-clean-btn")));
check(
  "two panels and a transport",
  (await page.locator(".sbx-panel").count()) === 2 && (await page.locator(".sbx-transport").count()) === 1,
);
check("demo data is loaded", (await page.evaluate(() => window.terra.net.stats().ministries)) > 0);

/* ------------------------------------------------------------- tokens */

const discovered = await page.evaluate(() => window.sbx.probeTokens().length);
check("tokens discovered from the live stylesheets", discovered >= 38, `${discovered} tokens`);

await page.evaluate(() => {
  window.sbx.state.tokens.light["--accent"] = "rgb(255, 0, 0)";
  window.sbx.applyStyleOverrides();
});
await wait(120);
const accent = await page.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
);
check("a token override reaches the page", accent === "rgb(255, 0, 0)", accent);

const css = await page.evaluate(() => document.getElementById("sbx-style-overrides").textContent);
check("export emits only the diff", css.includes("--accent") && !css.includes("--ink:"), css.split("\n").length + " lines");

await page.evaluate(() => {
  window.sbx.state.tokens = { light: {}, dark: {} };
  window.sbx.applyStyleOverrides();
});

/* ------------------------------------------------------------ clean view */

await page.click(".sbx-clean-btn");
await wait(120);
check(
  "clean view hides every sandbox surface",
  await page.evaluate(() =>
    [...document.querySelectorAll(".sbx-ui")].every((el) => getComputedStyle(el).display === "none"),
  ),
);
check("clean view keeps its own button", await page.locator(".sbx-clean-btn").isVisible());
await page.click(".sbx-clean-btn");
await wait(120);
check(
  "clean view restores them",
  await page.evaluate(() =>
    [...document.querySelectorAll(".sbx-ui")].every((el) => getComputedStyle(el).display !== "none"),
  ),
);

/* ---------------------------------------------------------- capture mode */

await page.evaluate(() => window.sbx.setCapture(true));
await wait(200);
check(
  "capture isolates the globe",
  await page.evaluate(() => {
    const vis = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).display !== "none" : false;
    };
    return vis("#globe") && !vis(".topbar") && !vis(".hero__title") && !vis(".panel");
  }),
);

await page.evaluate(() => {
  window.sbx.cfg.stage.chroma = true;
  window.sbx.cfg.stage.color = "#00b140";
  window.sbx.applyStage();
});
await wait(120);
check(
  "chroma screen paints and the paper goes",
  await page.evaluate(() => {
    const screen = document.querySelector(".sbx-screen");
    const paper = document.querySelector(".paper");
    return getComputedStyle(screen).display === "block" && getComputedStyle(paper).display === "none";
  }),
);

/* ------------------------------------------------------------- timeline */

const seekA = await page.evaluate(() => {
  window.sbx.player.seek(1500);
  return window.terra.globe.controls.lon;
});
const seekB = await page.evaluate(() => {
  window.sbx.player.seek(0);
  window.sbx.player.seek(1500);
  return window.terra.globe.controls.lon;
});
check("seeking is deterministic", Math.abs(seekA - seekB) < 1e-6, `${seekA.toFixed(4)} vs ${seekB.toFixed(4)}`);

const sweep = await page.evaluate(() => {
  const cfg = window.sbx.cfg;
  cfg.globe.spin.enabled = true;
  cfg.globe.spin.speed = 60;
  cfg.globe.spin.duration = 3000;
  cfg.globe.spin.delay = 0;
  cfg.globe.stop.duration = 1800;
  cfg.globe.stop.easing = "linear";
  window.sbx.player.setConfig(cfg);
  const start = cfg.globe.camera.lon;
  window.sbx.player.seek(3000);
  const atCruise = window.terra.globe.controls.lon - start;
  window.sbx.player.seek(9000);
  const atEnd = window.terra.globe.controls.lon - start;
  return { atCruise, atEnd };
});
// 60 deg/s for 3s = 180 deg, then a linear ramp-down over 1.8s adds half of
// 60 * 1.8 = 54 more.
check("cruise sweeps the stated angle", Math.abs(sweep.atCruise - 180) < 0.01, `${sweep.atCruise.toFixed(3)}°`);
check("linear slowdown adds half its rectangle", Math.abs(sweep.atEnd - 234) < 0.05, `${sweep.atEnd.toFixed(3)}°`);

const held = await page.evaluate(async () => {
  window.sbx.player.seek(9000);
  const a = window.terra.globe.controls.lon;
  await new Promise((r) => setTimeout(r, 600));
  return { a, b: window.terra.globe.controls.lon };
});
check("the globe holds still once stopped", Math.abs(held.a - held.b) < 1e-6, `${held.a.toFixed(4)} -> ${held.b.toFixed(4)}`);

const played = await page.evaluate(async () => {
  const cfg = window.sbx.cfg;
  cfg.tracks.heroTitle.enabled = true;
  cfg.visible.heroTitle = true;
  window.sbx.applyVisibility();
  window.sbx.player.setConfig(cfg);
  window.sbx.player.play({ from: 0 });
  await new Promise((r) => setTimeout(r, 450));
  const mid = getComputedStyle(document.querySelector(".hero__title")).opacity;
  await new Promise((r) => setTimeout(r, 2600));
  return { mid, end: getComputedStyle(document.querySelector(".hero__title")).opacity };
});
check("title fades over its own clock", Number(played.mid) < 0.9 && Number(played.end) > 0.95, JSON.stringify(played));

/* --------------------------------------------------------------- release */

await page.evaluate(() => window.sbx.setCapture(false));
await wait(300);
check(
  "leaving capture clears every inline style it wrote",
  await page.evaluate(() => {
    const title = document.querySelector(".hero__title");
    const globe = document.querySelector("#globe");
    return !title.style.opacity && !globe.style.opacity && !document.querySelector("[data-sbx-hide]");
  }),
);
check(
  "chrome comes back",
  await page.evaluate(() => getComputedStyle(document.querySelector(".topbar")).display !== "none"),
);

const drifts = await page.evaluate(async () => {
  const c = window.terra.globe.controls;
  c.setSpin(true);
  const a = c.lon;
  await new Promise((r) => setTimeout(r, 5200));
  return { a, b: c.lon };
});
check("the camera is back under the app's control", Math.abs(drifts.b - drifts.a) > 0.5, `lon moved ${(drifts.b - drifts.a).toFixed(2)}°`);

/* ------------------------------------------------- production is untouched */

const prod = await browser.newPage({ viewport: { width: 1512, height: 900 } });
const prodErrors = [];
prod.on("pageerror", (e) => prodErrors.push(e.message));
prod.on("console", (m) => m.type() === "error" && prodErrors.push(m.text()));
await prod.goto(`${BASE}/?demo`, { waitUntil: "load" });
await prod.waitForFunction(() => document.querySelector(".boot.is-done"), { timeout: 45000 });
await wait(1500);
check(
  "the production page carries no sandbox at all",
  await prod.evaluate(
    () =>
      !window.sbx &&
      !document.getElementById("sbx-style-overrides") &&
      !document.querySelector(".sbx-clean-btn, .sbx-panel, .sbx-screen") &&
      !document.body.className.includes("sbx"),
  ),
);
check(
  "production still drifts and still has its chrome",
  await prod.evaluate(() => !!document.querySelector(".topbar") && window.terra.globe.controls.spin === true),
);
check("no production console errors", prodErrors.length === 0, prodErrors.join(" | "));

/* ------------------------------------------------------------------ done */

check("no sandbox console errors", errors.length === 0, errors.join(" | "));

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
