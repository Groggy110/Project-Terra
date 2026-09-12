import { chromium } from "playwright";
const browser = await chromium.launch({ channel: "chrome", args: ["--use-gl=angle", "--use-angle=metal"] });
const ctx = await browser.newContext({ viewport: { width: 1512, height: 749 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("!", e.message));
await page.goto("http://127.0.0.1:5173/", { waitUntil: "load" });
await page.waitForFunction(() => document.querySelector(".boot.is-done"), { timeout: 40000 });
await page.waitForTimeout(1200);
await page.evaluate(() => {
  window.terra.globe.flyTo({ lat: 34, lon: 22, dist: 2.55, ms: 10 });
  document.querySelector(".chrome").style.display = "none";
  document.querySelector(".overlay").style.display = "none";
  document.querySelector(".toasts").style.display = "none";
});
await page.waitForTimeout(2000);
const names = ["off", "mask", "window", "ink", "land", "sea", "hillshade", "topo", "lum-chroma-snow"];
await page.evaluate(() => { window.terra.globe.running = true; });
for (let i = 0; i < names.length; i++) {
  await page.evaluate((n) => window.terra.globe.debug(n), i);
  await page.waitForTimeout(320);
  await page.screenshot({ path: `tools/shots/dbg-${i}-${names[i]}.png` });
}
console.log("stats:", JSON.stringify(await page.evaluate(() => window.terra.globe.painter.stats)));
console.log("window:", JSON.stringify(await page.evaluate(() => window.terra.globe.painter.window.toArray())));
await browser.close();
