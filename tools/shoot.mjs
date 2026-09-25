/**
 * Screenshot harness. Drives the running dev server through a set of states so
 * the design can be checked against the reference frames.
 *
 *   node tools/shoot.mjs [state ...]
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const OUT = "tools/shots";
const URL = process.env.TERRA_URL || "http://127.0.0.1:5173/";
const W = Number(process.env.W || 1512);
const H = Number(process.env.H || 749);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const setTheme = (page, name) =>
  page.evaluate((n) => {
    if (document.documentElement.dataset.theme !== n) {
      document.querySelector('[data-action="cycle-theme"]').click();
    }
  }, name);

const STATES = {
  async default() {},

  /** The loading screen itself. Imagery is stalled so there is one to catch. */
  async loading(page) {
    await page.route("**/textures/blue-marble.jpg", async (route) => {
      await wait(2200);
      await route.continue();
    });
    await page.reload({ waitUntil: "commit" });
    await wait(1100);
  },

  /** The arrival: whole globe, headline landed with it. */
  async hero(page) {
    await wait(1300);
  },

  /** After the settle: down at the working view, panel up, still turning. */
  async settled(page) {
    await wait(9000);
  },

  async europe(page) {
    await page.evaluate(() => window.terra.globe.flyTo({ lat: 34, lon: 22, dist: 2.55, ms: 10 }));
    await wait(1600);
  },

  async africa(page) {
    await page.evaluate(() => window.terra.globe.flyTo({ lat: 6, lon: 22, dist: 3.9, ms: 10 }));
    await wait(1600);
  },

  async asia(page) {
    await page.evaluate(() => window.terra.globe.flyTo({ lat: 22, lon: 96, dist: 3.35, ms: 10 }));
    await wait(1600);
  },

  async city(page) {
    await page.evaluate(() => window.terra.globe.flyTo({ lat: 51.5, lon: -0.12, dist: 1.09, ms: 10 }));
    await wait(1900);
  },

  async about(page) {
    await page.click('[data-view="about"]');
    await wait(700);
  },

  async post(page) {
    await page.click('[data-action="post-need"]');
    await wait(700);
  },

  async board(page) {
    await page.click('[data-view="needs"]');
    await wait(900);
  },

  async ministry(page) {
    await page.evaluate(() => {
      const m = window.terra.net.ministryById.get("aleppo-neighbours");
      window.terra.openMinistry(m, { fly: true });
    });
    await wait(2100);
  },

  async need(page) {
    await page.evaluate(() => window.terra.openNeed(window.terra.net.needById("n03")));
    await wait(700);
  },

  async filters(page) {
    await page.click(".chip:nth-child(1) .chip__btn");
    await wait(500);
  },

  // Dark is the default now, so every other state above is already the night
  // sky. These two are the *other* theme — set rather than toggled, because a
  // toggle only says "the one you are not in".
  async light(page) {
    await setTheme(page, "light");
    await wait(1200);
  },

  async lightCity(page) {
    await setTheme(page, "light");
    await page.evaluate(() => window.terra.globe.flyTo({ lat: 41, lon: 29, dist: 1.6, ms: 10 }));
    await wait(1900);
  },

  async narrow(page) {
    await page.setViewportSize({ width: 1040, height: 720 });
    await page.waitForTimeout(900);
    await page.evaluate(() => window.terra.globe.flyTo({ lat: 20, lon: 30, dist: 3.6, ms: 10 }));
    await wait(1500);
  },

  async search(page) {
    await page.fill("#searchInput", "swahili");
    await wait(600);
  },
};

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(STATES);

await mkdir(OUT, { recursive: true });

// Uses the installed Google Chrome rather than a downloaded build, so the
// screenshots come off a real GPU stack instead of a software rasteriser.
const browser = await chromium.launch({
  channel: process.env.TERRA_CHANNEL || "chrome",
  args: [
    "--use-gl=angle",
    "--use-angle=metal",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization",
  ],
});

const errors = [];
for (const name of names) {
  const run = STATES[name];
  if (!run) {
    console.log(`? unknown state ${name}`);
    continue;
  }
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${name}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));

  await page.goto(URL, { waitUntil: "load" });
  await page.waitForFunction(() => !document.querySelector(".boot") || document.querySelector(".boot.is-done"), { timeout: 45000 });
  await wait(1400);
  await run(page);
  await wait(350);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  ${name}.png`);
  await context.close();
}

await browser.close();
if (errors.length) {
  console.log("\nconsole errors:");
  for (const e of [...new Set(errors)]) console.log("  !", e);
} else {
  console.log("\nno console errors");
}
