/**
 * The design half of the sandbox: find every custom property the production
 * stylesheets declare, work out what kind of control each one wants, and turn
 * a set of edits back into CSS you can paste into base.css.
 *
 * Discovery is done by *reading the live stylesheets* rather than by keeping a
 * list here. A list would go stale the first time base.css grew a token, and a
 * design sandbox that silently omits a token is worse than no sandbox.
 */

/** The two rules in base.css that declare the palette. */
export const SCOPES = [
  { key: "light", selector: ":root", label: "Light" },
  { key: "dark", selector: ':root[data-theme="dark"]', label: "Dark" },
];

const NORM = (sel) => sel.replace(/\s+/g, "").replace(/"/g, "'").toLowerCase();

const SCOPE_MATCH = {
  light: [NORM(":root"), NORM("html")],
  dark: [NORM(':root[data-theme="dark"]'), NORM('html[data-theme="dark"]')],
};

/**
 * Walks document.styleSheets for `:root` declarations. Same-origin only, which
 * everything Vite serves is; a cross-origin sheet throws on .cssRules and is
 * skipped rather than blowing up discovery for the rest.
 */
export function discoverTokens() {
  const found = { light: new Map(), dark: new Map() };

  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    if (!rules) continue;
    // Skip our own override sheet, or every token would read back as edited.
    if (sheet.ownerNode?.id === OVERRIDE_ID) continue;
    walk(rules, found);
  }

  return SCOPES.map(({ key, selector, label }) => ({
    key,
    selector,
    label,
    tokens: [...found[key]].map(([name, value]) => describe(name, value)),
  }));
}

function walk(rules, found) {
  for (const rule of rules) {
    if (rule.cssRules && !rule.selectorText) {
      walk(rule.cssRules, found); // @media, @supports, @layer
      continue;
    }
    if (!rule.selectorText || !rule.style) continue;
    const sel = NORM(rule.selectorText);
    for (const [key, matches] of Object.entries(SCOPE_MATCH)) {
      if (!matches.includes(sel)) continue;
      for (const prop of rule.style) {
        if (!prop.startsWith("--")) continue;
        found[key].set(prop, rule.style.getPropertyValue(prop).trim());
      }
    }
  }
}

/* ------------------------------------------------------------- grouping */

const GROUPS = [
  { key: "type", label: "Typeface", test: (n) => n === "--sans" || n === "--mono" },
  { key: "ink", label: "Ink & text", test: (n) => /^--(ink|ink-2|body|muted|faint)$/.test(n) },
  { key: "line", label: "Lines", test: (n) => n.startsWith("--line") },
  { key: "surface", label: "Surfaces", test: (n) => n.startsWith("--surface") || n === "--paper" },
  { key: "accent", label: "Accent", test: (n) => n.startsWith("--accent") },
  { key: "status", label: "Status & amber", test: (n) => /^--(urgent|soon|ongoing|amber)/.test(n) },
  { key: "shadow", label: "Shadows", test: (n) => n.startsWith("--shadow") },
  { key: "radius", label: "Corner radii", test: (n) => n.startsWith("--r-") },
  { key: "layout", label: "Layout", test: (n) => n === "--panel-w" || n === "--edge" },
  { key: "motion", label: "Motion", test: (n) => n.startsWith("--ease") },
];

const groupFor = (name) => GROUPS.find((g) => g.test(name))?.key ?? "other";

export const GROUP_LABELS = Object.fromEntries([
  ...GROUPS.map((g) => [g.key, g.label]),
  ["other", "Other"],
]);

export const GROUP_ORDER = [...GROUPS.map((g) => g.key), "other"];

/* ------------------------------------------------------- value sniffing */

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNC_COLOR = /^(rgba?|hsla?|color-mix)\(/i;
const LENGTH = /^(-?[\d.]+)(px|rem|em|vh|vw|%)$/;

/** What kind of control a raw declaration wants. */
export function describe(name, value) {
  const v = String(value).trim();
  let type = "text";
  let unit = "";

  if (HEX.test(v) || /^(rgba?|hsla?)\(/i.test(v)) type = "color";
  else if (FUNC_COLOR.test(v)) type = "text";
  else if (LENGTH.test(v)) {
    type = "length";
    unit = LENGTH.exec(v)[2];
  } else if (/^-?[\d.]+$/.test(v)) type = "number";

  return { name, value: v, type, unit, group: groupFor(name), label: prettyName(name) };
}

function prettyName(name) {
  return name
    .replace(/^--/, "")
    .replace(/-/g, " ")
    .replace(/\bw\b/, "width")
    .replace(/^r /, "radius ");
}

/* ----------------------------------------------------------------- colour */

/** Parses hex / rgb() / rgba() into {r,g,b,a}, or null for anything else. */
export function parseColor(input) {
  const v = String(input).trim();

  if (HEX.test(v)) {
    let hex = v.slice(1);
    if (hex.length <= 4) hex = [...hex].map((c) => c + c).join("");
    const int = parseInt(hex.slice(0, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255, a };
  }

  const m = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (m) {
    const parts = m[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
      return {
        r: Math.round(parts[0]),
        g: Math.round(parts[1]),
        b: Math.round(parts[2]),
        a: Number.isFinite(parts[3]) ? parts[3] : 1,
      };
    }
  }
  return null;
}

const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

export const toHex = ({ r, g, b }) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

/** Back to the most idiomatic form: hex when opaque, rgba() when not. */
export function formatColor({ r, g, b, a }) {
  if (a >= 0.999) return toHex({ r, g, b });
  const alpha = Math.round(a * 1000) / 1000;
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`;
}

/* ---------------------------------------------------- non-token knobs */

/**
 * A handful of things that are not custom properties but are the first things
 * anyone wants to move: the body size, and the headline's own type. Each one
 * writes a plain rule into the override sheet.
 *
 * `read` pulls the live computed value so a knob starts where the production
 * stylesheet left it rather than at some number invented here.
 */
export const RULES = [
  { key: "bodySize", label: "Base font size", selector: "body", prop: "font-size", type: "length", unit: "px", min: 11, max: 22, step: 0.5, sel: "body" },
  { key: "heroSize", label: "Hero title size", selector: ".hero__title", prop: "font-size", type: "length", unit: "px", min: 20, max: 140, step: 1, sel: ".hero__title" },
  { key: "heroWeight", label: "Hero title weight", selector: ".hero__title", prop: "font-weight", type: "number", min: 200, max: 900, step: 10, sel: ".hero__title" },
  { key: "heroTracking", label: "Hero title tracking", selector: ".hero__title", prop: "letter-spacing", type: "length", unit: "em", min: -0.08, max: 0.1, step: 0.002, sel: ".hero__title" },
  { key: "heroLeading", label: "Hero title leading", selector: ".hero__title", prop: "line-height", type: "number", ratio: true, min: 0.8, max: 2, step: 0.01, sel: ".hero__title" },
  { key: "heroTop", label: "Hero vertical position", selector: ".hero", prop: "top", type: "length", unit: "%", min: 0, max: 70, step: 0.5, sel: ".hero" },
  { key: "heroWidth", label: "Hero max width", selector: ".hero", prop: "width", type: "length", unit: "px", min: 280, max: 1600, step: 10, sel: ".hero" },
  { key: "subSize", label: "Hero subtitle size", selector: ".hero__sub", prop: "font-size", type: "length", unit: "px", min: 11, max: 34, step: 0.5, sel: ".hero__sub" },
  { key: "subWidth", label: "Hero subtitle width", selector: ".hero__sub", prop: "max-width", type: "length", unit: "px", min: 240, max: 1100, step: 10, sel: ".hero__sub" },
  { key: "topbarH", label: "Top bar height", selector: ".topbar", prop: "height", type: "length", unit: "px", min: 44, max: 140, step: 1, sel: ".topbar" },
  { key: "btnH", label: "Button height", selector: ".btn", prop: "height", type: "length", unit: "px", min: 24, max: 60, step: 1, sel: ".btn" },
  { key: "btnRadius", label: "Button radius", selector: ".btn", prop: "border-radius", type: "length", unit: "px", min: 0, max: 999, step: 1, sel: ".btn" },
];

/** The live value of a rule knob, as a number in its own unit. */
export function readRule(rule) {
  const el = document.querySelector(rule.sel);
  if (!el) return null;
  const raw = getComputedStyle(el).getPropertyValue(rule.prop).trim();
  // line-height computes to px whatever you wrote, and a knob that reads back
  // "71.9" for a leading of 1.03 is worse than no knob.
  if (rule.ratio) {
    const px = parseFloat(raw);
    const size = parseFloat(getComputedStyle(el).fontSize) || 16;
    return Number.isFinite(px) ? Math.round((px / size) * 100) / 100 : null;
  }
  if (rule.unit === "em") {
    // letter-spacing computes to px; convert back through the font size.
    const px = parseFloat(raw);
    const size = parseFloat(getComputedStyle(el).fontSize) || 16;
    return Number.isFinite(px) ? Math.round((px / size) * 1000) / 1000 : 0;
  }
  if (rule.unit === "%") {
    const px = parseFloat(raw);
    const host = el.offsetParent || document.documentElement;
    const base = rule.prop === "top" ? host.clientHeight || window.innerHeight : host.clientWidth || window.innerWidth;
    return Number.isFinite(px) ? Math.round((px / base) * 1000) / 10 : 0;
  }
  const n = parseFloat(raw);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export const OVERRIDE_ID = "sbx-style-overrides";

/**
 * Builds the override stylesheet. Only *changed* values are emitted, so the
 * text you copy out is a diff against base.css rather than a dump of it.
 */
export function buildCss(edits, ruleEdits) {
  const out = [];

  for (const { key, selector } of SCOPES) {
    const entries = Object.entries(edits?.[key] ?? {});
    if (!entries.length) continue;
    out.push(`${selector} {`);
    for (const [name, value] of entries) out.push(`  ${name}: ${value};`);
    out.push("}", "");
  }

  const bySelector = new Map();
  for (const [key, value] of Object.entries(ruleEdits ?? {})) {
    const rule = RULES.find((r) => r.key === key);
    if (!rule || value == null || value === "") continue;
    const text = rule.unit ? `${value}${rule.unit}` : String(value);
    if (!bySelector.has(rule.selector)) bySelector.set(rule.selector, []);
    bySelector.get(rule.selector).push(`  ${rule.prop}: ${text};`);
  }
  for (const [selector, decls] of bySelector) {
    out.push(`${selector} {`, ...decls, "}", "");
  }

  return out.join("\n").trim();
}
