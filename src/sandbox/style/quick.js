/**
 * Quick style: the Style Sandbox cut down to the handful of things you would
 * actually reach for — how bright the planet is, where the sun sits, the city
 * lights, the glow round the edge, the colours, clouds and stars — each a
 * plain slider with plain words, and nothing else.
 *
 * Like the full editor it writes straight into the live STYLE (and, on the
 * landing page, STAGE and HEADLINE), so the two never disagree about the
 * look; it only shows less of it. Undo and "Start over" work on STYLE the
 * same way.
 */
import { STYLE } from "../../style/styleConfig.js";
import { HEADLINE, STAGE, applyHeadline, currentScene, onScene, sceneDefaults } from "../../style/landing.js";
import { applyStyle, mergeInto } from "../../style/applyStyle.js";
import { History } from "./tools.js";

/** Groups whose restyle does real work, held to one every HEAVY_MS. */
const HEAVY = new Set(["globe"]);
const HEAVY_MS = 120;

const theme = () => STYLE.themes.dark;

/** "#rrggbb" scaled toward black by k (0–1). */
function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s) => Math.round(((n >> s) & 255) * k).toString(16).padStart(2, "0");
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

/**
 * The panel, section by section. Each control reads and writes through
 * get/set so one slider can move several values that belong together (the
 * glow's colour, say, is its hot colour, its edge and the haze inside it).
 */
function sections(app) {
  const t = theme;
  const g = STYLE.globe;
  return [
    {
      title: "Sunlight",
      controls: [
        { label: "Overall brightness", min: 0.5, max: 3, step: 0.01, group: "renderer", get: () => STYLE.renderer.exposure, set: (v) => (STYLE.renderer.exposure = v), ends: ["Dim", "Bright"] },
        { label: "Sun from the side", min: -180, max: 180, step: 1, group: "light", get: () => t().light.sunAzimuth, set: (v) => (t().light.sunAzimuth = v), ends: ["Left", "Right"] },
        { label: "Sun height", min: -60, max: 90, step: 1, group: "light", get: () => t().light.sunElevation, set: (v) => (t().light.sunElevation = v), ends: ["Low", "High"] },
        { label: "Night side", min: 0, max: 0.4, step: 0.005, group: "light", get: () => t().light.ambient, set: (v) => (t().light.ambient = v), ends: ["Black", "Visible"] },
      ],
    },
    {
      title: "City lights",
      controls: [
        { type: "toggle", label: "Show city lights", group: "globe", get: () => g.nightLights.enabled, set: (v) => (g.nightLights.enabled = v) },
        { type: "color", label: "Colour", group: "globe", get: () => g.nightLights.color, set: (v) => (g.nightLights.color = v) },
        { label: "Brightness", min: 0, max: 4, step: 0.05, group: "globe", get: () => g.nightLights.intensity, set: (v) => (g.nightLights.intensity = v), ends: ["Faint", "Bright"] },
        { label: "Glow", min: 0, max: 2, step: 0.05, group: "globe", get: () => g.nightLights.size, set: (v) => (g.nightLights.size = v), ends: ["Sharp", "Soft"] },
      ],
    },
    {
      title: "Glow round the planet",
      controls: [
        {
          type: "color",
          label: "Colour",
          group: "atmosphere",
          get: () => t().atmosphere.halo.inner,
          set: (v) => {
            const at = t().atmosphere;
            at.halo.inner = v;
            at.halo.outer = shade(v, 0.5);
            at.color = shade(v, 0.35);
          },
        },
        { label: "Brightness", min: 0, max: 3, step: 0.01, group: "atmosphere", get: () => t().atmosphere.halo.strength, set: (v) => (t().atmosphere.halo.strength = v), ends: ["None", "Strong"] },
        { label: "Thickness", min: 0, max: 0.4, step: 0.002, group: "atmosphere", get: () => t().atmosphere.halo.spread, set: (v) => (t().atmosphere.halo.spread = v), ends: ["Thin", "Wide"] },
        { label: "Haze over the edge", min: 0, max: 1.5, step: 0.01, group: "atmosphere", get: () => t().atmosphere.fresnel, set: (v) => (t().atmosphere.fresnel = v), ends: ["Clear", "Hazy"] },
      ],
    },
    {
      title: "Planet colours",
      controls: [
        { type: "color", label: "Ocean", group: "surface", get: () => t().surface.ocean.mid, set: (v) => (t().surface.ocean.mid = v) },
        { label: "Land colour", min: 0, max: 2.5, step: 0.01, group: "surface", get: () => t().surface.land.sat, set: (v) => (t().surface.land.sat = v), ends: ["Muted", "Vivid"] },
        { label: "Mountains", min: 0, max: 10, step: 0.1, group: "surface", get: () => t().surface.relief, set: (v) => (t().surface.relief = v), ends: ["Flat", "Deep"] },
      ],
    },
    {
      title: "Clouds",
      controls: [
        { type: "toggle", label: "Show clouds", group: "globe", get: () => g.clouds.enabled, set: (v) => (g.clouds.enabled = v) },
        {
          label: "Amount",
          min: 0,
          max: 1,
          step: 0.01,
          group: "clouds",
          get: () => t().clouds.opacity,
          set: (v) => {
            t().clouds.opacity = v;
            t().clouds.realOpacity = v;
          },
          ends: ["Few", "Many"],
        },
      ],
    },
    {
      title: "Sky & motion",
      controls: [
        { label: "Stars", min: 0, max: 1, step: 0.01, group: "background", get: () => t().background.stars.opacity, set: (v) => (t().background.stars.opacity = v), ends: ["None", "Bright"] },
        { type: "toggle", label: "Planet turns by itself", group: "motion", get: () => STYLE.motion.autoRotate, set: (v) => (STYLE.motion.autoRotate = v) },
      ],
    },
    {
      title: "Landing page",
      landing: true,
      controls: [
        { label: "Planet size", min: 0.4, max: 2.5, step: 0.01, stage: true, get: () => STAGE.scale, set: (v) => (STAGE.scale = v), apply: () => app.restage(), ends: ["Small", "Large"] },
        { label: "Headline size", min: 0.5, max: 1.6, step: 0.01, stage: true, get: () => HEADLINE.size, set: (v) => (HEADLINE.size = v), apply: () => applyHeadline(), ends: ["Small", "Large"] },
      ],
    },
  ];
}

export class QuickPanel {
  constructor(app) {
    this.app = app;
    this.history = new History();
    this.pending = new Set();
    this.raf = 0;
    this.lastHeavy = 0;
    this.inputs = [];
  }

  mount() {
    this.history.commit();
    this.el = this.#build();
    document.body.appendChild(this.el);
    onScene(() => {
      this.history = new History();
      this.history.commit();
      this.refresh();
    });
    return this;
  }

  get open() {
    return !this.el.hidden;
  }

  toggle() {
    this.el.hidden = !this.el.hidden;
    if (!this.el.hidden) this.refresh();
  }

  /* ------------------------------------------------------------ building */

  #build() {
    const root = document.createElement("aside");
    root.className = "tqs";
    root.setAttribute("aria-label", "Quick style");
    root.innerHTML = `
      <header class="tqs__head">
        <span class="tqs__title">Quick style</span>
        <button type="button" class="tqs__x" title="Close" aria-label="Close">×</button>
      </header>
      <div class="tqs__body"></div>
      <footer class="tqs__foot">
        <button type="button" data-act="undo">Undo</button>
        <button type="button" data-act="reset">Start over</button>
      </footer>`;
    root.querySelector(".tqs__x").addEventListener("click", () => this.toggle());
    root.querySelector('[data-act="undo"]').addEventListener("click", () => this.undo());
    root.querySelector('[data-act="reset"]').addEventListener("click", () => this.reset());

    const body = root.querySelector(".tqs__body");
    if (this.app.hasLanding) body.appendChild(this.#sceneSwitch());
    for (const s of sections(this.app)) {
      const sec = document.createElement("section");
      sec.className = "tqs__sec";
      if (s.landing) {
        sec.dataset.landing = "";
        if (!this.app.hasLanding) continue;
      }
      sec.innerHTML = `<h3>${s.title}</h3>`;
      for (const c of s.controls) sec.appendChild(this.#control(c));
      body.appendChild(sec);
    }
    this.root = root;
    this.#syncScene();
    return root;
  }

  #sceneSwitch() {
    const wrap = document.createElement("div");
    wrap.className = "tqs__scene";
    wrap.innerHTML = `
      <span>Editing</span>
      <div class="tqs__seg" role="group">
        <button type="button" data-scene="landing">Landing page</button>
        <button type="button" data-scene="main">Main page</button>
      </div>`;
    wrap.addEventListener("click", (e) => {
      const name = e.target.dataset?.scene;
      if (!name || name === currentScene()) return;
      if (name === "landing") this.app.showLanding();
      else this.app.showMain();
      this.#syncScene();
    });
    return wrap;
  }

  #syncScene() {
    const scene = currentScene();
    for (const b of this.root?.querySelectorAll("[data-scene]") ?? []) b.classList.toggle("is-on", b.dataset.scene === scene);
    const landing = this.root?.querySelector("[data-landing]");
    if (landing) landing.hidden = scene !== "landing";
  }

  #control(c) {
    const row = document.createElement("label");
    row.className = `tqs__row tqs__row--${c.type ?? "slider"}`;
    const name = document.createElement("span");
    name.className = "tqs__label";
    name.textContent = c.label;
    row.appendChild(name);

    const input = document.createElement("input");
    if (c.type === "toggle") {
      input.type = "checkbox";
      input.addEventListener("change", () => this.#set(c, input.checked, true));
      row.appendChild(input);
    } else if (c.type === "color") {
      input.type = "color";
      input.addEventListener("input", () => this.#set(c, input.value));
      input.addEventListener("change", () => this.#commit());
      row.appendChild(input);
    } else {
      input.type = "range";
      input.min = c.min;
      input.max = c.max;
      input.step = c.step;
      input.addEventListener("input", () => this.#set(c, Number(input.value)));
      input.addEventListener("change", () => this.#commit());
      const ends = document.createElement("span");
      ends.className = "tqs__ends";
      ends.innerHTML = `<span>${c.ends[0]}</span><span>${c.ends[1]}</span>`;
      row.append(input, ends);
    }
    this.inputs.push({ c, input });
    this.#show(c, input);
    return row;
  }

  #show(c, input) {
    const v = c.get();
    if (c.type === "toggle") input.checked = !!v;
    else input.value = v;
  }

  refresh() {
    for (const { c, input } of this.inputs) this.#show(c, input);
    this.#syncScene();
  }

  /* ---------------------------------------------------------- behaviour */

  #set(c, v, commit = false) {
    c.set(v);
    if (c.stage) c.apply();
    else this.#schedule(c.group);
    // The full editor, if it is open, shows the same STYLE: keep it honest.
    window.terraSandbox?.gui?.controllersRecursive().forEach((k) => k.updateDisplay());
    if (commit) this.#commit();
  }

  #schedule(group) {
    this.pending.add(group);
    if (!this.raf) this.raf = requestAnimationFrame(this.#flush);
  }

  #flush = (now) => {
    this.raf = 0;
    const groups = [...this.pending];
    const heavy = groups.filter((g) => HEAVY.has(g));
    if (heavy.length && now - this.lastHeavy < HEAVY_MS) {
      const light = groups.filter((g) => !HEAVY.has(g));
      if (light.length) applyStyle(STYLE, { groups: light });
      this.pending = new Set(heavy);
      this.raf = requestAnimationFrame(this.#flush);
      return;
    }
    if (heavy.length) this.lastHeavy = now;
    this.pending.clear();
    applyStyle(STYLE, { groups });
  };

  #commit() {
    this.history.commit();
  }

  #load(snap) {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.pending.clear();
    mergeInto(STYLE, snap);
    applyStyle();
    this.refresh();
  }

  undo() {
    const snap = this.history.undo();
    if (snap) this.#load(snap);
  }

  reset() {
    this.#load(sceneDefaults());
    this.#commit();
  }
}
