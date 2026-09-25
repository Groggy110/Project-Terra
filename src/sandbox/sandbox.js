/**
 * The sandbox shell.
 *
 * It mounts *alongside* the real app rather than replacing any of it: the same
 * App, the same Globe, the same stylesheets. Everything it does is additive
 * and reversible -
 *
 *   design    an override stylesheet appended after the production ones
 *   capture   body classes plus data attributes, all removed on exit
 *   animation inline styles the player owns and clears, and a wrapper around
 *             GlobeControls.update that is inert until a take is running
 *
 * so the production page is never edited to make the sandbox work, and
 * dropping the sandbox script leaves index.html behaving exactly as it did.
 */
import { clear, h } from "../ui/dom.js";
import * as W from "./widgets.js";
import { Player } from "./player.js";
import {
  DOM_TARGETS,
  ISOLATION_PRESETS,
  TARGETS,
  defaultConfig,
  globeDuration,
  normalise,
  timelineDuration,
} from "./config.js";
import {
  GROUP_LABELS,
  GROUP_ORDER,
  OVERRIDE_ID,
  RULES,
  SCOPES,
  buildCss,
  discoverTokens,
  readRule,
} from "./tokens.js";

const KEY = "terra.sandbox.v1";

const CHROMA_PRESETS = [
  ["Green", "#00b140"],
  ["Blue", "#0047bb"],
  ["Magenta", "#ff00ff"],
  ["Black", "#000000"],
  ["White", "#ffffff"],
];

const fmtTime = (ms) => {
  const s = Math.max(0, ms) / 1000;
  return `${s.toFixed(2)}s`;
};

export class Sandbox {
  constructor(app) {
    this.app = app;
    this.state = this.#load();
    this.player = new Player(app, { onTick: (s) => this.#onTick(s) });
    this.player.setConfig(this.state.config);
    this.binders = [];
    this.capture = false;
    this.clean = false;
    this.scope = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    this.tokenFilter = "";
    this.saveTimer = 0;
  }

  /* ------------------------------------------------------------- lifecycle */

  mount() {
    this.styleEl = h("style", { id: OVERRIDE_ID });
    document.head.appendChild(this.styleEl);

    this.screen = h("div", { class: "sbx-screen" });
    document.body.appendChild(this.screen);

    this.countdown = h("div", { class: "sbx-count", hidden: true });
    document.body.appendChild(this.countdown);

    this.cleanBtn = h(
      "button",
      { class: "sbx-clean-btn", type: "button", title: "Show or hide every sandbox control (C)" },
      h("span", { class: "sbx-clean-btn__dot" }),
      h("span", { class: "sbx-clean-btn__text", text: "Hide sandbox UI" }),
    );
    this.cleanBtn.addEventListener("click", () => this.setClean(!this.clean));
    document.body.appendChild(this.cleanBtn);

    this.flag = h("div", { class: "sbx-flag sbx-ui", text: "sandbox" });
    document.body.appendChild(this.flag);

    this.left = this.#panel("Design & styling", "left");
    this.right = this.#panel("Capture & animation", "right");
    this.#buildTransport();

    this.#buildDesign();
    this.#buildAnim();

    this.applyStyleOverrides();
    this.#bindKeys();
    this.#watchTheme();
    this.#restorePanels();
    this.applyStage();
    this.syncAll();
    this.#onTick({ time: 0, duration: this.player.duration, playing: false, preroll: 0 });
    document.body.classList.add("sbx-on");
    return this;
  }

  /* ---------------------------------------------------------------- state */

  #load() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(KEY) || "null");
    } catch {
      saved = null;
    }
    return {
      tokens: { light: { ...(saved?.tokens?.light || {}) }, dark: { ...(saved?.tokens?.dark || {}) } },
      rules: { ...(saved?.rules || {}) },
      config: normalise(saved?.config),
      ui: {
        leftFolded: !!saved?.ui?.leftFolded,
        rightFolded: !!saved?.ui?.rightFolded,
        leftPos: saved?.ui?.leftPos || null,
        rightPos: saved?.ui?.rightPos || null,
        sections: { ...(saved?.ui?.sections || {}) },
      },
    };
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(KEY, JSON.stringify(this.state));
      } catch {
        /* private windows; the sandbox works fine without persistence */
      }
    }, 220);
  }

  /** Re-reads every registered control from state. */
  syncAll() {
    for (const bind of this.binders) {
      try {
        bind();
      } catch {
        /* a control whose target went away with a rebuild */
      }
    }
    this.#refreshJson();
    this.#refreshReadouts();
  }

  #bind(widget, read) {
    this.binders.push(() => widget.set(read()));
    return widget;
  }

  /* ---------------------------------------------------------------- panels */

  #panel(title, side) {
    const body = h("div", { class: "sbx-panel__body" });
    const fold = h("button", { class: "sbx-iconbtn", type: "button", title: "Collapse", text: "–" });
    const head = h(
      "div",
      { class: "sbx-panel__head" },
      h("span", { class: "sbx-panel__title", text: title }),
      fold,
    );
    const el = h("div", { class: `sbx sbx-ui sbx-panel sbx-panel--${side}` }, head, body);
    document.body.appendChild(el);

    const key = side === "left" ? "leftFolded" : "rightFolded";
    const setFold = (folded) => {
      el.classList.toggle("is-folded", folded);
      fold.textContent = folded ? "+" : "–";
      this.state.ui[key] = folded;
      this.save();
    };
    fold.addEventListener("click", () => setFold(!el.classList.contains("is-folded")));
    setFold(this.state.ui[key]);

    this.#makeDraggable(el, head, side === "left" ? "leftPos" : "rightPos");
    return { el, body, head };
  }

  /**
   * Panels float, so they can be pushed off whatever you are trying to look
   * at. Position is written as left/top and the CSS `right` anchor dropped,
   * so a dragged panel stops following the viewport edge.
   */
  #makeDraggable(el, handle, stateKey) {
    let start = null;
    handle.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button") && e.target !== handle) return;
      const box = el.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: box.left, top: box.top };
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener("pointermove", (e) => {
      if (!start) return;
      const left = Math.max(4, Math.min(window.innerWidth - 80, start.left + (e.clientX - start.x)));
      const top = Math.max(4, Math.min(window.innerHeight - 40, start.top + (e.clientY - start.y)));
      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(top)}px`;
      el.style.right = "auto";
    });
    const end = () => {
      if (!start) return;
      start = null;
      this.state.ui[stateKey] = { left: el.style.left, top: el.style.top };
      this.save();
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  #restorePanels() {
    for (const [panel, key] of [
      [this.left, "leftPos"],
      [this.right, "rightPos"],
    ]) {
      const pos = this.state.ui[key];
      if (!pos) continue;
      panel.el.style.left = pos.left;
      panel.el.style.top = pos.top;
      panel.el.style.right = "auto";
    }
  }

  /** A section that remembers whether it was open. */
  #section(title, id, { open = true } = {}) {
    const remembered = this.state.ui.sections[id];
    const sec = W.section(title, { open: remembered ?? open, id });
    sec.el.addEventListener("sbx:toggle", (e) => {
      if (e.detail?.id !== id) return;
      this.state.ui.sections[id] = e.detail.open;
      this.save();
    });
    return sec;
  }

  /* =================================================================== */
  /*                          design & styling                           */
  /* =================================================================== */

  #buildDesign() {
    const body = this.left.body;

    const search = h("input", {
      class: "sbx-text",
      type: "search",
      placeholder: "Filter tokens…",
      spellcheck: "false",
    });
    search.addEventListener("input", () => {
      this.tokenFilter = search.value.trim().toLowerCase();
      this.#renderTokens();
    });

    const scopeSel = W.select({
      value: this.scope,
      options: SCOPES.map((s) => ({ value: s.key, label: `${s.label} theme` })),
      onChange: (v) => this.setScope(v),
    });
    this.scopeSel = scopeSel;

    body.appendChild(h("div", { class: "sbx-search" }, search, scopeSel));

    this.tokensHost = h("div");
    body.appendChild(this.tokensHost);

    body.appendChild(this.#buildRulesSection().el);
    body.appendChild(this.#buildExportSection().el);

    this.#renderTokens();
  }

  setScope(scope) {
    this.scope = scope === "dark" ? "dark" : "light";
    this.setTheme(this.scope);
    this.#renderTokens();
  }

  /**
   * Switches the page's theme the way the app's own button does, minus the
   * toast and the persistence - the sandbox should not rewrite the visitor's
   * saved preference just because you looked at the dark palette.
   */
  setTheme(name) {
    const theme = name === "dark" ? "dark" : "light";
    if (document.documentElement.dataset.theme === theme) return;
    document.documentElement.dataset.theme = theme;
    this.app.theme = theme;
    this.app.globe?.setTheme(theme);
    const label = document.getElementById("themeName");
    if (label) label.textContent = theme === "dark" ? "Deep night" : "Soft light";
  }

  /** Keeps the scope picker honest when the page's own theme button is used. */
  #watchTheme() {
    new MutationObserver(() => {
      const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
      if (theme === this.scope) return;
      this.scope = theme;
      this.scopeSel?.set(theme);
      this.#renderTokens();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }

  /**
   * The dark block in base.css only redeclares what it changes, so the dark
   * scope is shown as *its own* declarations plus every light token it
   * inherits - editing an inherited one simply adds a dark override, which is
   * exactly what you would type into base.css by hand.
   */
  #tokensForScope() {
    if (!this.discovered) this.discovered = discoverTokens();
    const light = this.discovered.find((s) => s.key === "light")?.tokens ?? [];
    const dark = this.discovered.find((s) => s.key === "dark")?.tokens ?? [];
    if (this.scope === "light") return light;

    const own = new Set(dark.map((t) => t.name));
    const inherited = light.filter((t) => !own.has(t.name)).map((t) => ({ ...t, inherited: true }));
    return [...dark, ...inherited];
  }

  /** The token list for the active scope. Public for tools/verify-sandbox.mjs. */
  probeTokens() {
    return this.#tokensForScope();
  }

  #renderTokens() {
    const host = clear(this.tokensHost);
    this.binders = this.binders.filter((b) => !b.__token);

    const tokens = this.#tokensForScope().filter((t) => {
      if (!this.tokenFilter) return true;
      return t.name.includes(this.tokenFilter) || t.label.toLowerCase().includes(this.tokenFilter);
    });

    if (!tokens.length) {
      host.appendChild(h("div", { class: "sbx-empty", text: "No token matches that." }));
      return;
    }

    for (const group of GROUP_ORDER) {
      const inGroup = tokens.filter((t) => t.group === group);
      if (!inGroup.length) continue;
      const sec = this.#section(GROUP_LABELS[group], `tok:${group}`, { open: !!this.tokenFilter || group === "ink" });
      if (this.tokenFilter) sec.el.classList.add("is-open");
      for (const token of inGroup) sec.body.appendChild(this.#tokenRow(token));
      host.appendChild(sec.el);
    }
  }

  #tokenRow(token) {
    const scope = this.scope;
    const edits = this.state.tokens[scope];
    const current = edits[token.name] ?? token.value;

    const onChange = (value) => {
      const clean = String(value).trim();
      if (!clean || clean === token.value) delete edits[token.name];
      else edits[token.name] = clean;
      row.classList.toggle("is-edited", token.name in edits);
      this.applyStyleOverrides();
      this.save();
    };

    let control;
    if (token.type === "color") control = W.colorField({ value: current, onChange });
    else if (token.type === "length") {
      const n = parseFloat(current) || 0;
      const max = Math.max(Math.abs(n) * 3, token.unit === "px" ? 64 : 4);
      control = W.slider({
        value: n,
        min: 0,
        max: Math.round(max),
        step: token.unit === "px" ? 1 : 0.05,
        unit: token.unit,
        onChange: (v) => onChange(`${v}${token.unit}`),
      });
    } else if (token.type === "number") {
      control = W.numberField({ value: parseFloat(current) || 0, step: 0.05, onChange: (v) => onChange(String(v)) });
    } else {
      control = W.textField({ value: current, onChange });
    }

    const row = W.row(token.label, control, { hint: `${token.name}${token.inherited ? "  (inherited from :root)" : ""}` });
    row.classList.add("sbx-token");
    if (token.name in edits) row.classList.add("is-edited");
    if (token.inherited) row.dataset.inherited = "";

    const binder = () => control.set(this.state.tokens[scope][token.name] ?? token.value);
    binder.__token = true;
    this.binders.push(binder);
    return row;
  }

  #buildRulesSection() {
    const sec = this.#section("Typography & layout", "rules", { open: false });
    sec.body.appendChild(
      W.note("Not tokens — plain rules written over the production stylesheet. Each one starts at its live value."),
    );

    for (const rule of RULES) {
      const live = readRule(rule);
      const saved = this.state.rules[rule.key];
      const value = saved ?? live ?? 0;
      const control = W.slider({
        value,
        min: rule.min,
        max: rule.max,
        step: rule.step,
        unit: rule.unit || "",
        onChange: (v) => {
          this.state.rules[rule.key] = v;
          this.applyStyleOverrides();
          this.save();
        },
      });
      this.#bind(control, () => this.state.rules[rule.key] ?? readRule(rule) ?? 0);
      sec.body.appendChild(W.row(rule.label, control, { hint: `${rule.selector} { ${rule.prop} }` }));
    }

    sec.body.appendChild(
      W.buttonRow(
        W.button("Reset these", () => {
          this.state.rules = {};
          this.applyStyleOverrides();
          this.syncAll();
          this.save();
        }, { kind: "is-ghost" }),
      ),
    );
    return sec;
  }

  #buildExportSection() {
    const sec = this.#section("Export", "export", { open: false });
    const out = h("textarea", { class: "sbx-code", readonly: true, spellcheck: "false" });
    this.cssOut = out;

    const file = h("input", { type: "file", accept: "application/json", hidden: true });
    file.addEventListener("change", async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        this.#importState(JSON.parse(await f.text()));
      } catch (err) {
        this.#flash(`Could not read that file: ${err.message}`);
      }
      file.value = "";
    });

    sec.body.appendChild(W.note("Only what you changed is written out — paste it straight into base.css."));
    sec.body.appendChild(out);
    sec.body.appendChild(
      W.buttonRow(
        W.button("Copy CSS", () => this.#copy(this.#css(), "CSS copied"), { kind: "is-primary" }),
        W.button("Download JSON", () => this.#download()),
        W.button("Import JSON", () => file.click()),
        W.button("Reset styling", () => {
          if (!confirm("Discard every token and rule change?")) return;
          this.state.tokens = { light: {}, dark: {} };
          this.state.rules = {};
          this.applyStyleOverrides();
          this.#renderTokens();
          this.syncAll();
          this.save();
        }, { kind: "is-ghost" }),
        file,
      ),
    );
    return sec;
  }

  #css() {
    return buildCss(this.state.tokens, this.state.rules) || "/* nothing changed yet */";
  }

  applyStyleOverrides() {
    if (!this.styleEl) return;
    const css = buildCss(this.state.tokens, this.state.rules);
    this.styleEl.textContent = css;
    if (this.cssOut) this.cssOut.value = css || "/* nothing changed yet */";
    // The globe's ink colours are baked from CSS-independent theme tables, so
    // it does not need telling; the label layer measures chrome, and that can
    // move when a radius or a width changes.
    requestAnimationFrame(() => this.app.syncReserved?.());
  }

  /* =================================================================== */
  /*                        capture & animation                          */
  /* =================================================================== */

  #buildAnim() {
    const body = this.right.body;
    body.appendChild(this.#buildCaptureSection().el);
    body.appendChild(this.#buildGlobeSection().el);
    body.appendChild(this.#buildElementsSection().el);
    body.appendChild(this.#buildTimingSection().el);
    body.appendChild(this.#buildJsonSection().el);
  }

  get cfg() {
    return this.state.config;
  }

  /** One place every config edit goes through, so nothing gets out of step. */
  touch({ resync = false } = {}) {
    this.player.setConfig(this.cfg);
    this.applyStage();
    this.#refreshReadouts();
    this.#refreshJson();
    if (resync) this.syncAll();
    this.save();
  }

  /* --------------------------------------------------------- capture mode */

  #buildCaptureSection() {
    const sec = this.#section("Capture mode", "capture", { open: true });
    // Read initial values from the live config, but write through `this.cfg`
    // everywhere below: a preset or an applied JSON replaces the config
    // object outright, and a closure holding the old one would edit a config
    // nothing is playing.
    const cfg = this.cfg;

    this.captureBtn = W.button("Capture mode is off", () => this.setCapture(!this.capture), { kind: "is-ghost" });
    sec.body.appendChild(W.buttonRow(this.captureBtn));
    sec.body.appendChild(
      W.note("Hides every interface element except the ones ticked below, so each one can be recorded on its own."),
    );

    sec.body.appendChild(h("div", { class: "sbx-sub", text: "Background" }));
    const chroma = W.toggle({
      value: cfg.stage.chroma,
      label: "Flat colour behind the globe",
      onChange: (v) => {
        this.cfg.stage.chroma = v;
        this.touch();
      },
    });
    this.#bind(chroma, () => this.cfg.stage.chroma);
    sec.body.appendChild(W.row("Chroma key", chroma));

    const color = W.colorField({
      value: cfg.stage.color,
      onChange: (v) => {
        this.cfg.stage.color = v;
        this.touch();
      },
    });
    this.#bind(color, () => this.cfg.stage.color);
    sec.body.appendChild(W.row("Colour", color));

    sec.body.appendChild(
      W.buttonRow(
        ...CHROMA_PRESETS.map(([label, value]) =>
          W.button(label, () => {
            this.cfg.stage.chroma = true;
            this.cfg.stage.color = value;
            this.touch({ resync: true });
          }),
        ),
      ),
    );

    const theme = W.select({
      value: cfg.stage.theme,
      options: [
        { value: "follow", label: "Follow the page" },
        { value: "light", label: "Force light" },
        { value: "dark", label: "Force dark" },
      ],
      onChange: (v) => {
        this.cfg.stage.theme = v;
        this.touch();
      },
    });
    this.#bind(theme, () => this.cfg.stage.theme);
    sec.body.appendChild(W.row("Theme", theme));

    for (const [key, label, hint] of [
      ["halo", "Atmosphere halo", "The soft glow at the limb — leaves a fringe of screen colour when keyed"],
      ["clouds", "Cloud sheet", "Semi-transparent white; keys as a haze over the background"],
    ]) {
      const box = W.toggle({
        value: cfg.stage[key],
        label: "Draw it",
        onChange: (v) => {
          this.cfg.stage[key] = v;
          this.touch();
        },
      });
      this.#bind(box, () => this.cfg.stage[key]);
      sec.body.appendChild(W.row(label, box, { hint }));
    }

    sec.body.appendChild(h("div", { class: "sbx-sub", text: "Isolate" }));
    sec.body.appendChild(
      W.buttonRow(
        ...Object.entries(ISOLATION_PRESETS).map(([label, keys]) =>
          W.button(label, () => {
            for (const t of TARGETS) this.cfg.visible[t.key] = keys.includes(t.key);
            this.applyVisibility();
            this.touch({ resync: true });
          }),
        ),
      ),
    );

    for (const target of TARGETS) {
      const box = W.toggle({
        value: cfg.visible[target.key],
        onChange: (v) => {
          this.cfg.visible[target.key] = v;
          this.applyVisibility();
          this.touch();
        },
      });
      this.#bind(box, () => this.cfg.visible[target.key]);
      sec.body.appendChild(W.row(target.label, box, { hint: target.hint || target.sel }));
    }

    return sec;
  }

  setCapture(on) {
    this.capture = !!on;
    document.body.classList.toggle("sbx-capture", this.capture);
    this.captureBtn.textContent = this.capture ? "Capture mode is on" : "Capture mode is off";
    this.captureBtn.classList.toggle("is-on", this.capture);
    this.captureBtn.classList.toggle("is-ghost", !this.capture);

    if (this.capture) {
      this.applyVisibility();
      this.applyStage();
      this.player.arm();
    } else {
      this.clearVisibility();
      document.body.classList.remove("sbx-chroma");
      this.player.release();
    }
    this.#refreshReadouts();
  }

  applyVisibility() {
    for (const target of TARGETS) {
      const el = document.querySelector(target.sel);
      if (!el) continue;
      if (this.cfg.visible[target.key]) el.removeAttribute("data-sbx-hide");
      else el.setAttribute("data-sbx-hide", "");
    }
  }

  clearVisibility() {
    for (const el of document.querySelectorAll("[data-sbx-hide]")) el.removeAttribute("data-sbx-hide");
  }

  applyStage() {
    const stage = this.cfg.stage;
    document.body.classList.toggle("sbx-chroma", this.capture && stage.chroma);
    this.screen.style.background = stage.color;
    if (stage.theme !== "follow") this.setTheme(stage.theme);

    // The atmosphere and the cloud sheet are meshes, not DOM, so they are
    // switched at the scene rather than hidden with CSS. `visible` is the only
    // thing touched, and the globe's own theme and resize paths never write
    // it, so putting it back is putting it back.
    const globe = this.app?.globe;
    if (globe) {
      if (globe.halo?.mesh) globe.halo.mesh.visible = stage.halo;
      if (globe.clouds?.mesh) globe.clouds.mesh.visible = stage.clouds;
      globe.dirty = true;
    }
  }

  /* ---------------------------------------------------------------- globe */

  #buildGlobeSection() {
    const sec = this.#section("Globe", "globe", { open: true });
    const g = this.cfg.globe;

    sec.body.appendChild(h("div", { class: "sbx-sub", text: "Starting view" }));
    const camRows = [
      ["Latitude", "lat", -87, 87, 0.5, "°"],
      ["Longitude", "lon", -180, 180, 0.5, "°"],
      ["Zoom", "zoom", 0, 1, 0.01, ""],
    ];
    for (const [label, key, min, max, step, unit] of camRows) {
      const ctl = W.slider({
        value: g.camera[key],
        min,
        max,
        step,
        unit,
        onChange: (v) => {
          this.cfg.globe.camera[key] = v;
          this.#previewGlobe();
        },
      });
      this.#bind(ctl, () => this.cfg.globe.camera[key]);
      sec.body.appendChild(W.row(label, ctl));
    }
    sec.body.appendChild(
      W.buttonRow(
        W.button("Use current view", () => {
          const cam = this.player.readCamera();
          if (!cam) return;
          Object.assign(this.cfg.globe.camera, cam);
          this.touch({ resync: true });
          this.#previewGlobe();
        }),
        W.button("Preview frame", () => this.#previewGlobe(), { kind: "is-ghost" }),
      ),
    );

    sec.body.appendChild(h("div", { class: "sbx-sub", text: "Rotation" }));
    const spinOn = W.toggle({
      value: g.spin.enabled,
      label: "Spin the globe",
      onChange: (v) => {
        this.cfg.globe.spin.enabled = v;
        this.touch();
      },
    });
    this.#bind(spinOn, () => this.cfg.globe.spin.enabled);
    sec.body.appendChild(W.row("Enabled", spinOn));

    const spinRows = [
      ["Start after", "delay", 0, 6000, 10, "ms"],
      ["Speed", "speed", 0, 360, 1, "°/s"],
      ["Spin for", "duration", 0, 20000, 50, "ms"],
    ];
    for (const [label, key, min, max, step, unit] of spinRows) {
      const ctl = W.slider({
        value: g.spin[key],
        min,
        max,
        step,
        unit,
        onChange: (v) => {
          this.cfg.globe.spin[key] = v;
          this.touch();
        },
      });
      this.#bind(ctl, () => this.cfg.globe.spin[key]);
      sec.body.appendChild(W.row(label, ctl));
    }

    const dir = W.select({
      value: String(g.spin.direction),
      options: [
        { value: "1", label: "Eastward (as the page drifts)" },
        { value: "-1", label: "Westward" },
      ],
      onChange: (v) => {
        this.cfg.globe.spin.direction = Number(v) < 0 ? -1 : 1;
        this.touch();
      },
    });
    this.#bind(dir, () => String(this.cfg.globe.spin.direction));
    sec.body.appendChild(W.row("Direction", dir));

    sec.body.appendChild(h("div", { class: "sbx-sub", text: "Slowdown" }));
    const stopMs = W.slider({
      value: g.stop.duration,
      min: 0,
      max: 12000,
      step: 50,
      unit: "ms",
      onChange: (v) => {
        this.cfg.globe.stop.duration = v;
        this.touch();
      },
    });
    this.#bind(stopMs, () => this.cfg.globe.stop.duration);
    sec.body.appendChild(W.row("Ease to stop over", stopMs));

    const stopEase = W.easingField({
      value: g.stop.easing,
      onChange: (v) => {
        this.cfg.globe.stop.easing = v;
        this.touch();
      },
    });
    this.#bind(stopEase, () => this.cfg.globe.stop.easing);
    sec.body.appendChild(W.row("Deceleration", stopEase, { hint: "How the rotation rate falls away, not the angle" }));

    this.sweepOut = W.note("");
    sec.body.appendChild(this.sweepOut);

    sec.body.appendChild(h("div", { class: "sbx-sub", text: "Zoom move" }));
    const zoomOn = W.toggle({
      value: g.zoom.enabled,
      label: "Fly the camera in or out",
      onChange: (v) => {
        this.cfg.globe.zoom.enabled = v;
        this.touch();
      },
    });
    this.#bind(zoomOn, () => this.cfg.globe.zoom.enabled);
    sec.body.appendChild(W.row("Enabled", zoomOn));

    const zoomRows = [
      ["End zoom", "to", 0, 1, 0.01, ""],
      ["Start after", "delay", 0, 8000, 10, "ms"],
      ["Over", "duration", 0, 12000, 50, "ms"],
    ];
    for (const [label, key, min, max, step, unit] of zoomRows) {
      const ctl = W.slider({
        value: g.zoom[key],
        min,
        max,
        step,
        unit,
        onChange: (v) => {
          this.cfg.globe.zoom[key] = v;
          this.touch();
        },
      });
      this.#bind(ctl, () => this.cfg.globe.zoom[key]);
      sec.body.appendChild(W.row(label, ctl));
    }
    const zoomEase = W.easingField({
      value: g.zoom.easing,
      onChange: (v) => {
        this.cfg.globe.zoom.easing = v;
        this.touch();
      },
    });
    this.#bind(zoomEase, () => this.cfg.globe.zoom.easing);
    sec.body.appendChild(W.row("Easing", zoomEase));

    sec.body.appendChild(h("div", { class: "sbx-sub", text: "Canvas fade" }));
    sec.body.appendChild(this.#trackRows(() => this.cfg.globe.fade, { move: false }));

    sec.body.appendChild(h("div", { class: "sbx-sub", text: "Rendering" }));
    const quality = W.select({
      value: g.quality,
      options: [
        { value: "smooth", label: "Smooth — coarse vectors while moving" },
        { value: "full", label: "Full — sharp vectors, heavier frames" },
      ],
      onChange: (v) => {
        this.cfg.globe.quality = v;
        this.touch();
      },
    });
    this.#bind(quality, () => this.cfg.globe.quality);
    sec.body.appendChild(W.row("Coastlines", quality));

    return sec;
  }

  /** Parks the camera on the take's first frame without starting the clock. */
  #previewGlobe() {
    this.player.arm();
    this.player.seek(this.player.time);
    this.touch();
  }

  /* ------------------------------------------------------------- elements */

  #buildElementsSection() {
    const sec = this.#section("Elements", "elements", { open: false });
    sec.body.appendChild(W.note("Each one fades and moves on its own clock, so they can be layered in After Effects."));

    for (const target of DOM_TARGETS) {
      const sub = this.#section(target.label, `el:${target.key}`, { open: false });
      sub.el.classList.add("sbx-sec--nested");
      sub.body.appendChild(this.#trackRows(() => this.cfg.tracks[target.key]));
      sec.body.appendChild(sub.el);
    }

    sec.body.appendChild(
      W.buttonRow(
        W.button("All off", () => {
          for (const t of DOM_TARGETS) this.cfg.tracks[t.key].enabled = false;
          this.touch({ resync: true });
        }, { kind: "is-ghost" }),
        W.button("Stagger visible", () => this.#stagger(), { kind: "is-ghost" }),
      ),
    );
    return sec;
  }

  /** A quick 120ms cascade over whatever is currently visible in capture. */
  #stagger(step = 120) {
    let i = 0;
    for (const t of DOM_TARGETS) {
      if (!this.cfg.visible[t.key]) continue;
      const track = this.cfg.tracks[t.key];
      track.enabled = true;
      track.delay = i * step;
      i++;
    }
    this.touch({ resync: true });
  }

  /**
   * The rows shared by every fade track. `get` is a thunk rather than the
   * object itself so a preset or an imported JSON can swap the config out
   * from under these controls without them going stale.
   */
  #trackRows(get, { move = true } = {}) {
    const host = h("div");
    const track = get();

    const on = W.toggle({
      value: track.enabled,
      label: "Animate",
      onChange: (v) => {
        get().enabled = v;
        this.touch();
      },
    });
    this.#bind(on, () => get().enabled);
    host.appendChild(W.row("Enabled", on));

    for (const [label, key, max] of [
      ["Delay", "delay", 8000],
      ["Duration", "duration", 8000],
    ]) {
      const ctl = W.slider({
        value: track[key],
        min: 0,
        max,
        step: 10,
        unit: "ms",
        onChange: (v) => {
          get()[key] = v;
          this.touch();
        },
      });
      this.#bind(ctl, () => get()[key]);
      host.appendChild(W.row(label, ctl));
    }

    const ease = W.easingField({
      value: track.easing,
      onChange: (v) => {
        get().easing = v;
        this.touch();
      },
    });
    this.#bind(ease, () => get().easing);
    host.appendChild(W.row("Easing", ease));

    const pairs = [
      ["Opacity", "opacity", 0, 1, 0.01, ""],
      ...(move
        ? [
            ["Offset Y", "y", -400, 400, 1, "px"],
            ["Offset X", "x", -400, 400, 1, "px"],
            ["Scale", "scale", 0.2, 2.5, 0.01, ""],
            ["Blur", "blur", 0, 40, 0.5, "px"],
          ]
        : []),
    ];

    for (const end of ["from", "to"]) {
      host.appendChild(h("div", { class: "sbx-sub", text: end === "from" ? "From" : "To" }));
      for (const [label, key, min, max, step, unit] of pairs) {
        const ctl = W.slider({
          value: track[end][key],
          min,
          max,
          step,
          unit,
          onChange: (v) => {
            get()[end][key] = v;
            this.touch();
          },
        });
        this.#bind(ctl, () => get()[end][key]);
        host.appendChild(W.row(label, ctl));
      }
    }

    return host;
  }

  /* --------------------------------------------------------------- timing */

  #buildTimingSection() {
    const sec = this.#section("Timeline", "timing", { open: true });
    const stage = this.cfg.stage;

    const mode = W.select({
      value: this.cfg.duration.mode,
      options: [
        { value: "auto", label: "Auto — as long as the longest track" },
        { value: "manual", label: "Manual" },
      ],
      onChange: (v) => {
        this.cfg.duration.mode = v;
        this.touch();
      },
    });
    this.#bind(mode, () => this.cfg.duration.mode);
    sec.body.appendChild(W.row("Length", mode));

    const ms = W.slider({
      value: this.cfg.duration.ms,
      min: 200,
      max: 30000,
      step: 100,
      unit: "ms",
      onChange: (v) => {
        this.cfg.duration.ms = v;
        this.touch();
      },
    });
    this.#bind(ms, () => this.cfg.duration.ms);
    sec.body.appendChild(W.row("Manual length", ms));

    const pre = W.slider({
      value: stage.preroll,
      min: 0,
      max: 10,
      step: 1,
      unit: "s",
      onChange: (v) => {
        this.cfg.stage.preroll = v;
        this.touch();
      },
    });
    this.#bind(pre, () => this.cfg.stage.preroll);
    sec.body.appendChild(W.row("Countdown", pre, { hint: "A mark for the screen recorder to trim to" }));

    const loop = W.toggle({
      value: stage.loop,
      label: "Loop the take",
      onChange: (v) => {
        this.cfg.stage.loop = v;
        this.touch();
      },
    });
    this.#bind(loop, () => this.cfg.stage.loop);
    sec.body.appendChild(W.row("Loop", loop));

    const hide = W.toggle({
      value: stage.hideUiOnPlay,
      label: "Hide sandbox UI while playing",
      onChange: (v) => {
        this.cfg.stage.hideUiOnPlay = v;
        this.touch();
      },
    });
    this.#bind(hide, () => this.cfg.stage.hideUiOnPlay);
    sec.body.appendChild(W.row("While playing", hide));

    this.lengthOut = W.note("");
    sec.body.appendChild(this.lengthOut);

    sec.body.appendChild(h("div", { class: "sbx-sub", text: "Presets" }));
    sec.body.appendChild(
      W.buttonRow(
        W.button("Globe spin & stop", () => this.#preset("globe")),
        W.button("Title fade", () => this.#preset("title")),
        W.button("Full hero", () => this.#preset("hero")),
        W.button("Clear", () => this.#preset("clear"), { kind: "is-ghost" }),
      ),
    );
    return sec;
  }

  #preset(name) {
    const base = defaultConfig();
    const cfg = this.cfg;

    if (name === "clear") {
      this.state.config = normalise({ stage: cfg.stage, visible: cfg.visible });
      for (const t of DOM_TARGETS) this.state.config.tracks[t.key].enabled = false;
      this.state.config.globe.spin.enabled = false;
    } else if (name === "globe") {
      this.state.config = normalise({
        ...base,
        stage: cfg.stage,
        visible: { ...Object.fromEntries(TARGETS.map((t) => [t.key, false])), globe: true },
        tracks: {},
        globe: { ...base.globe, camera: cfg.globe.camera },
      });
      for (const t of DOM_TARGETS) this.state.config.tracks[t.key].enabled = false;
    } else if (name === "title") {
      this.state.config = normalise({
        stage: cfg.stage,
        visible: { ...Object.fromEntries(TARGETS.map((t) => [t.key, false])), heroTitle: true, heroSub: true },
        globe: { spin: { enabled: false } },
        tracks: {
          heroTitle: { enabled: true, delay: 0, duration: 1100, easing: "terraEaseOut", from: { opacity: 0, y: 22 } },
          heroSub: { enabled: true, delay: 220, duration: 1100, easing: "terraEaseOut", from: { opacity: 0, y: 16 } },
        },
      });
    } else {
      this.state.config = normalise({ ...base, stage: cfg.stage });
      this.state.config.visible = {
        ...Object.fromEntries(TARGETS.map((t) => [t.key, false])),
        paper: true,
        globe: true,
        labels: true,
        heroTitle: true,
        heroSub: true,
      };
      this.state.config.globe.fade.enabled = true;
      this.state.config.tracks.labels.enabled = true;
    }

    this.player.setConfig(this.state.config);
    if (this.capture) this.applyVisibility();
    this.player.seek(0);
    this.touch({ resync: true });
  }

  /* ----------------------------------------------------------------- JSON */

  #buildJsonSection() {
    const sec = this.#section("Config (JSON)", "json", { open: false });
    const area = h("textarea", { class: "sbx-code", spellcheck: "false" });
    this.jsonArea = area;
    area.style.height = "260px";

    sec.body.appendChild(W.note("The same config the sliders write. Edit it, hit Apply, and every control follows."));
    sec.body.appendChild(area);
    sec.body.appendChild(
      W.buttonRow(
        W.button("Apply", () => this.#applyJson(), { kind: "is-primary" }),
        W.button("Copy", () => this.#copy(JSON.stringify(this.cfg, null, 2), "Config copied")),
        W.button("Revert", () => {
          area.classList.remove("is-bad");
          this.#refreshJson(true);
        }, { kind: "is-ghost" }),
        W.button("Defaults", () => {
          this.state.config = defaultConfig();
          this.player.setConfig(this.state.config);
          if (this.capture) this.applyVisibility();
          this.player.seek(0);
          this.touch({ resync: true });
        }, { kind: "is-ghost" }),
      ),
    );
    this.#refreshJson(true);
    return sec;
  }

  #applyJson() {
    try {
      this.state.config = normalise(JSON.parse(this.jsonArea.value));
      this.jsonArea.classList.remove("is-bad");
      this.player.setConfig(this.state.config);
      if (this.capture) {
        this.applyVisibility();
        this.applyStage();
      }
      this.player.seek(Math.min(this.player.time, this.player.duration));
      this.touch({ resync: true });
      this.#flash("Config applied");
    } catch (err) {
      this.jsonArea.classList.add("is-bad");
      this.#flash(`Not valid JSON: ${err.message}`);
    }
  }

  #refreshJson(force = false) {
    if (!this.jsonArea) return;
    if (!force && document.activeElement === this.jsonArea) return;
    this.jsonArea.value = JSON.stringify(this.cfg, null, 2);
  }

  #refreshReadouts() {
    if (this.sweepOut) {
      const sweep = this.player.totalSweep();
      const turns = Math.abs(sweep) / 360;
      this.sweepOut.textContent = `Sweeps ${Math.round(sweep)}° — ${turns.toFixed(2)} turns — over ${fmtTime(globeDuration(this.cfg))}.`;
    }
    if (this.lengthOut) {
      this.lengthOut.textContent = `Take runs ${fmtTime(timelineDuration(this.cfg))}.`;
    }
  }

  /* =================================================================== */
  /*                             transport                               */
  /* =================================================================== */

  #buildTransport() {
    const play = h("button", {
      class: "sbx-transport__play",
      type: "button",
      title: "Play or pause the take (space)",
      html: '<svg viewBox="0 0 16 16"><path d="M4 2.6 13 8l-9 5.4z"/></svg>',
    });
    play.addEventListener("click", () => this.player.toggle());
    this.playBtn = play;

    const scrub = h("input", { class: "sbx-range sbx-scrub", type: "range", min: 0, max: 1000, step: 1, value: 0 });
    scrub.addEventListener("input", () => {
      this.player.pause();
      this.player.seek((Number(scrub.value) / 1000) * this.player.duration);
    });
    this.scrub = scrub;

    this.timeOut = h("span", { class: "sbx-time", text: "0.00s / 0.00s" });

    const el = h(
      "div",
      { class: "sbx sbx-ui sbx-transport" },
      play,
      W.button("⟲", () => this.player.stop(), { title: "Back to the first frame" }),
      scrub,
      this.timeOut,
      W.button("Release", () => {
        this.player.release();
        this.#flash("Camera handed back to the page");
      }, { kind: "is-ghost", title: "Give the camera and the styles back to the app" }),
    );
    document.body.appendChild(el);
    this.transport = el;
  }

  #onTick({ time, duration, playing, preroll }) {
    if (this.scrub && document.activeElement !== this.scrub) {
      this.scrub.value = duration ? Math.round((time / duration) * 1000) : 0;
    }
    if (this.timeOut) this.timeOut.textContent = `${fmtTime(time)} / ${fmtTime(duration)}`;
    if (this.playBtn) {
      this.playBtn.innerHTML = playing
        ? '<svg viewBox="0 0 16 16"><path d="M4 2.8h3.1v10.4H4zM8.9 2.8H12v10.4H8.9z"/></svg>'
        : '<svg viewBox="0 0 16 16"><path d="M4 2.6 13 8l-9 5.4z"/></svg>';
    }

    document.body.classList.toggle("sbx-hide-ui", playing && this.cfg.stage.hideUiOnPlay);

    if (preroll > 0) {
      this.countdown.hidden = false;
      this.countdown.textContent = String(Math.ceil(preroll / 1000));
    } else if (!this.countdown.hidden) {
      this.countdown.hidden = true;
    }
  }

  /* =================================================================== */
  /*                          clean view & keys                          */
  /* =================================================================== */

  setClean(on) {
    this.clean = !!on;
    document.body.classList.toggle("sbx-clean", this.clean);
    this.cleanBtn.querySelector(".sbx-clean-btn__text").textContent = this.clean
      ? "Show sandbox UI"
      : "Hide sandbox UI";
    this.cleanBtn.title = this.clean ? "Bring the sandbox controls back (C)" : "Hide every sandbox control (C)";
  }

  #bindKeys() {
    window.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target;
      const typing =
        el?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName || "");
      if (typing) return;
      // A button inside the sandbox already answers space and enter itself.
      if (e.key === " " && el?.closest?.(".sbx")) return;

      const key = e.key.toLowerCase();
      if (key === "c") {
        e.preventDefault();
        this.setClean(!this.clean);
      } else if (key === "k") {
        e.preventDefault();
        this.setCapture(!this.capture);
      } else if (e.key === " ") {
        e.preventDefault();
        this.player.toggle();
      } else if (key === "0") {
        e.preventDefault();
        this.player.stop();
      }
    });
  }

  /* -------------------------------------------------------------- plumbing */

  async #copy(text, message) {
    try {
      await navigator.clipboard.writeText(text);
      this.#flash(message);
    } catch {
      // Clipboard is gated on some setups; fall back to a selection the
      // person can copy themselves rather than losing the text.
      const area = h("textarea", { class: "sbx-code" });
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand?.("copy");
      area.remove();
      this.#flash(message);
    }
  }

  #download() {
    const blob = new Blob([JSON.stringify(this.state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: `terra-sandbox-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  #importState(data) {
    if (data?.tokens) this.state.tokens = { light: { ...data.tokens.light }, dark: { ...data.tokens.dark } };
    if (data?.rules) this.state.rules = { ...data.rules };
    if (data?.config) this.state.config = normalise(data.config);
    this.player.setConfig(this.state.config);
    this.applyStyleOverrides();
    this.#renderTokens();
    if (this.capture) {
      this.applyVisibility();
      this.applyStage();
    }
    this.syncAll();
    this.save();
    this.#flash("Imported");
  }

  /** The app's own toast, when it is up; the console otherwise. */
  #flash(message) {
    if (typeof this.app?.toast === "function") this.app.toast(message);
    else console.info("[sandbox]", message);
  }
}
