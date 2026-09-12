/**
 * Functional pass: drives the real UI and asserts the app responds.
 * Run with the dev server up:  node tools/verify.mjs
 */
import { chromium } from "playwright";

const URL = process.env.TERRA_URL || "http://127.0.0.1:5173/";
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

await page.goto(URL, { waitUntil: "load" });
await page.waitForFunction(() => document.querySelector(".boot.is-done"), { timeout: 45000 });
await wait(1200);

// ---- data ----
const stats = await page.evaluate(() => window.terra.net.stats());
check("network totals", stats.needs === 65 && stats.urgent === 19 && stats.people === 295 && stats.ministries === 32, JSON.stringify(stats));

// ---- drag rotates ----
const before = await page.evaluate(() => ({ lat: window.terra.globe.controls.lat, lon: window.terra.globe.controls.lon }));
await page.mouse.move(700, 450);
await page.mouse.down();
for (let i = 0; i < 12; i++) await page.mouse.move(700 + i * 14, 450 + i * 3);
await page.mouse.up();
await wait(700);
const after = await page.evaluate(() => ({ lat: window.terra.globe.controls.lat, lon: window.terra.globe.controls.lon }));
check("drag rotates", Math.abs(after.lon - before.lon) > 3, `lon ${before.lon.toFixed(1)} -> ${after.lon.toFixed(1)}`);

// ---- wheel zooms ----
const z0 = await page.evaluate(() => window.terra.globe.zoom);
await page.mouse.move(700, 450);
await page.mouse.wheel(0, -600);
await wait(800);
const z1 = await page.evaluate(() => window.terra.globe.zoom);
check("wheel zooms in", z1 > z0 + 0.05, `${z0.toFixed(3)} -> ${z1.toFixed(3)}`);

// ---- zoom dial + reset ----
await page.click('[data-action="reset-view"]');
await wait(1600);
const z2 = await page.evaluate(() => window.terra.globe.zoom);
check("reset returns to the whole globe", z2 < 0.02, `zoom ${z2.toFixed(4)}`);

// ---- vector detail switches with zoom ----
await page.evaluate(() => window.terra.globe.flyTo({ lat: 48, lon: 8, dist: 1.5, ms: 10 }));
await wait(2200);
const painter = await page.evaluate(() => ({ scale: window.terra.globe.painter.scale, stats: window.terra.globe.painter.stats }));
check("1:10m vectors load on approach", painter.scale === "10m", `scale ${painter.scale}, ${painter.stats.size}`);

// ---- theme ----
await page.click('[data-action="cycle-theme"]');
await wait(700);
const theme = await page.evaluate(() => ({
  attr: document.documentElement.dataset.theme,
  gain: window.terra.globe.earth.uniforms.uLandGain.value,
  deep: window.terra.globe.earth.uniforms.uDeep.value.getHexString(),
}));
check("theme switches uniforms", theme.attr === "dark" && theme.gain < 0.8, JSON.stringify(theme));
await page.click('[data-action="cycle-theme"]');
await wait(500);

// ---- filters ----
await page.click(".chip:nth-child(2) .chip__btn");
await wait(300);
await page.click(".chip:nth-child(2) .opt");
await wait(500);
const filtered = await page.evaluate(() => ({
  count: window.terra.net.select(window.terra.query).length,
  dimmed: window.terra.globe.labels.dimmed.size,
  chip: !!document.querySelector(".chip.is-set"),
  // multi-select: picking a value must not dismiss the menu
  stillOpen: !!document.querySelector(".chip.is-open .chip__menu"),
  ticked: !!document.querySelector(".chip:nth-child(2) .opt.is-on"),
}));
check(
  "urgency filter narrows and dims",
  filtered.count === 19 && filtered.dimmed > 0 && filtered.chip,
  JSON.stringify(filtered),
);
check("filter menu stays open for a second pick", filtered.stillOpen && filtered.ticked, JSON.stringify(filtered));
await page.keyboard.press("Escape");
await wait(200);
await page.evaluate(() => window.terra.clearFilters());
await wait(400);

// ---- search + suggestions ----
await page.fill("#searchInput", "swahili");
await wait(500);
const sug = await page.evaluate(() => document.querySelectorAll(".suggest__row").length);
check("search suggests", sug > 0, `${sug} rows`);
await page.evaluate(() => window.terra.clearFilters());
await wait(300);

// ---- pin click opens the ministry ----
await page.evaluate(() => {
  const m = window.terra.net.ministryById.get("nairobi-mathare");
  window.terra.openMinistry(m, { fly: true });
});
await wait(2000);
const panel = await page.evaluate(() => ({
  name: document.querySelector(".ministry__name")?.textContent,
  needs: document.querySelectorAll(".panel .need").length,
  crumb: document.querySelector(".crumbs__item:last-child")?.textContent,
}));
check("ministry panel", panel.name === "Mathare Hope Collective" && panel.needs === 3 && panel.crumb === "Nairobi", JSON.stringify(panel));

// ---- pick up a need ----
await page.evaluate(() => window.terra.openNeed(window.terra.net.needById("n07")));
await wait(600);
await page.click(".modal__foot .btn--accent");
await wait(700);
const picked = await page.evaluate(() => ({
  taken: window.terra.net.needById("n07").taken,
  stored: JSON.parse(localStorage.getItem("terra.v1")).interests,
}));
check("picking up a need persists", picked.taken === true && Object.keys(picked.stored).length === 1, JSON.stringify(picked.taken));

// ---- post a need ----
await page.click('[data-action="post-need"]');
await wait(600);
await page.fill("#f-title", "Playwright test need");
await page.click(".modal__foot .btn--accent");
await wait(1400);
const posted = await page.evaluate(() => {
  const s = window.terra.net.stats();
  return { needs: s.needs, mine: window.terra.net.needs.filter((n) => n.mine).length };
});
check("posting a need updates the network", posted.needs === 66 && posted.mine === 1, JSON.stringify(posted));

// ---- board ----
await page.click('[data-view="needs"]');
await wait(1000);
const board = await page.evaluate(() => ({
  up: document.querySelector(".sheet").classList.contains("is-up"),
  cards: document.querySelectorAll(".board .need").length,
}));
check("needs board opens with every need", board.up && board.cards === 66, JSON.stringify(board));

// ---- about ----
await page.click('[data-view="about"]');
await wait(700);
const about = await page.evaluate(() => ({
  title: document.querySelector(".modal__title")?.textContent,
  spec: [...document.querySelectorAll(".spec__v")].map((n) => n.textContent),
}));
check("about lists the real pipeline", about.title === "A map of what's needed" && about.spec[0].includes("r169"), about.spec.slice(0, 3).join(" | "));

check("no console errors", errors.length === 0, errors.slice(0, 3).join(" / "));

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
