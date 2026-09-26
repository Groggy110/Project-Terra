/**
 * STYLE's CSS half, as custom properties: the ground behind the canvas, the
 * pins and the place names over it. base.css and globe.css only ever say
 * var(--…); the values are written here, one rule per theme, so switching
 * theme is the stylesheet's job and needs no JavaScript.
 */

import { starSheet } from "./stars.js";

const hexRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** "#rrggbb" + alpha -> rgba(), spelled the way the stylesheets used to. */
export const rgba = (hex, a) => `rgba(${hexRgb(hex).join(", ")}, ${+a.toFixed(3)})`;

const px = (n) => `${+n.toFixed(3)}px`;

function backgroundFill(b) {
  switch (b.mode) {
    case "linear":
      return `linear-gradient(${b.linear.angle}deg, ${b.linear.top}, ${b.linear.bottom})`;
    case "radial": {
      const r = b.radial;
      return `radial-gradient(ellipse ${r.width}% ${r.height}% at ${r.x}% ${r.y}%, ${r.center} 0%, ${r.mid} ${r.midStop}%, ${r.edge} 100%)`;
    }
    case "transparent":
      return "transparent";
    default:
      return b.solid;
  }
}

/** The ::before layer: a tiled star sheet, a masked dot grid, or nothing. */
function pattern(b) {
  if (b.pattern === "stars") {
    const s = b.stars;
    const anim = [];
    if (s.drift > 0) anim.push(`terra-paper-drift ${+(s.size / s.drift).toFixed(2)}s linear infinite`);
    if (s.twinkle > 0) anim.push(`terra-paper-twinkle ${s.twinkleSpeed}s ease-in-out infinite alternate`);
    const image =
      s.source === "generated"
        ? `url("${starSheet({ count: s.count, radius: s.radius, color: s.color, seed: s.seed, size: s.size })}")`
        : 'url("/textures/stars.png")';
    return {
      "--bg-pattern-image": image,
      "--bg-pattern-size": `${px(s.size)} ${px(s.size)}`,
      "--bg-pattern-position": "0 0",
      "--bg-pattern-mask": "none",
      "--bg-pattern-opacity": s.opacity,
      "--bg-pattern-dim": +(s.opacity * (1 - s.twinkle)).toFixed(3),
      "--bg-pattern-travel": px(s.size),
      "--bg-pattern-anim": anim.length ? anim.join(", ") : "none",
    };
  }
  if (b.pattern === "dots") {
    const d = b.dots;
    return {
      "--bg-pattern-image": `radial-gradient(circle, ${rgba(d.color, d.alpha)} ${px(d.size)}, transparent ${px(d.size + 0.4)})`,
      "--bg-pattern-size": `${px(d.spacing)} ${px(d.spacing)}`,
      "--bg-pattern-position": "center",
      "--bg-pattern-mask": `radial-gradient(ellipse 75% 85% at 50% 48%, transparent ${d.fadeInner}%, #000 ${d.fadeOuter}%)`,
      "--bg-pattern-opacity": d.opacity,
      "--bg-pattern-dim": d.opacity,
      "--bg-pattern-travel": "0px",
      "--bg-pattern-anim": "none",
    };
  }
  return {
    "--bg-pattern-image": "none",
    "--bg-pattern-size": "auto",
    "--bg-pattern-position": "0 0",
    "--bg-pattern-mask": "none",
    "--bg-pattern-opacity": 0,
    "--bg-pattern-dim": 0,
    "--bg-pattern-travel": "0px",
    "--bg-pattern-anim": "none",
  };
}

function themeVars(t, shared) {
  const b = t.background;
  const m = t.markers;
  const sm = shared.markers;
  const l = t.labels;
  const glow = sm.glow > 0 ? `, 0 0 ${px(sm.glow)} ${m.glowColor}` : "";
  return {
    "--paper": b.page,
    "--bg-fill": backgroundFill(b),
    ...pattern(b),
    "--bg-grain-content": b.grain.enabled ? '""' : "none",
    "--bg-grain-opacity": b.grain.opacity,
    "--bg-grain-size": px(b.grain.size),

    "--pin-urgent": m.urgent,
    "--pin-normal": m.normal,
    "--pin-shadow": `0 0 0 ${px(sm.rim)} ${rgba(m.rimColor, m.rimAlpha)}, 0 1px ${px(m.shadowBlur)} ${rgba(m.shadowColor, m.shadowAlpha)}${glow}`,
    "--pin-active-shadow": `0 0 0 ${px(sm.activeRim)} ${m.activeRimColor}, 0 1px 5px ${rgba(m.activeShadowColor, m.activeShadowAlpha)}${glow}`,

    "--chip-bg": rgba(l.chipBg, l.chipBgAlpha),
    "--chip-hover-bg": l.chipHoverBg,
    "--chip-color": l.chipColor,
    "--place-color": l.placeColor,
    "--place-halo": rgba(l.placeHalo, l.placeHaloAlpha),
    "--country-bg": rgba(l.countryBg, l.countryBgAlpha),
    "--country-color": l.countryColor,
  };
}

function sharedVars(S) {
  const m = S.markers;
  const l = S.labels;
  return {
    "--pin-size": px(m.size),
    "--pin-hover-scale": m.hoverScale,
    "--pin-radius": m.shape === "circle" ? "999px" : "1.5px",
    "--pin-rotate": m.shape === "diamond" ? "45deg" : "0deg",
    "--pin-active-scale": m.activeScale,
    "--label-font": l.font || "var(--sans)",
    "--chip-size": px(l.chipSize),
    "--place-size": px(l.placeSize),
    "--country-size": px(l.countrySize),
  };
}

const block = (selector, vars) =>
  `${selector} {\n${Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n")}\n}`;

/**
 * Rules that exist only while a feature is on — a hover or selected colour,
 * the ripple — so that with them off the stylesheets behave exactly as
 * written, rather than through a variable set to "the same as before".
 */
function optionalRules(S) {
  const m = S.markers;
  const out = [];
  for (const [scope, t] of [[":root", S.themes.light], [':root[data-theme="dark"]', S.themes.dark]]) {
    const tm = t.markers;
    if (m.hoverColorOn) out.push(`${scope} .pin:hover .pin__dot { background: ${tm.hoverColor}; }`);
    if (m.activeColorOn) out.push(`${scope} .pin.is-active .pin__dot { background: ${tm.activeColor}; }`);
    if (m.pulse.mode !== "off") {
      const sel = m.pulse.mode === "urgent" ? ".pin.is-urgent .pin__dot::after" : ".pin .pin__dot::after";
      out.push(
        `${scope} ${sel} { content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; ` +
          `box-shadow: 0 0 0 1.5px ${tm.pulseColor}; animation: terra-pin-pulse ${m.pulse.speed}s ease-out infinite; }`,
      );
    }
  }
  if (m.pulse.mode !== "off") {
    out.push(`@keyframes terra-pin-pulse { from { scale: 1; opacity: 0.9; } to { scale: ${m.pulse.size}; opacity: 0; } }`);
  }
  return out;
}

/** The whole generated stylesheet for a STYLE. */
export function styleCss(S) {
  return [
    block(":root", { ...sharedVars(S), ...themeVars(S.themes.light, S) }),
    block(':root[data-theme="dark"]', themeVars(S.themes.dark, S)),
    ...optionalRules(S),
  ].join("\n\n");
}
