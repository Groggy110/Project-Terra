/**
 * Pushes STYLE into the running page: the CSS behind and over the canvas,
 * and — through whoever has subscribed with onStyle(), which is the Globe —
 * the renderer, the camera, the shader uniforms and the vector ink.
 *
 * Nothing reloads and nothing is rebuilt unless it has to be: a colour is a
 * uniform write, the ink is a repaint of the painted window, and only a change
 * of sphere detail replaces a geometry.
 */
import { STYLE } from "./styleConfig.js";
import { styleCss } from "./css.js";

const SHEET_ID = "terra-style";
const listeners = new Set();

/** Groups whose values end up in CSS rather than (only) in the scene. */
const CSS_GROUPS = new Set(["background", "markers", "labels"]);

/**
 * Subscribes to restyles. `fn(style, groups)` gets the live STYLE and the set
 * of group names that changed, or null for "everything". Returns an
 * unsubscribe.
 */
export function onStyle(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Applies a style to the page.
 *
 *   applyStyle()                        re-apply STYLE as it stands
 *   applyStyle(next)                    merge `next` into STYLE, then apply
 *   applyStyle(STYLE, { groups })       only what those groups touch
 *
 * Group names are the keys of STYLE ("camera", "post" …) or of a theme
 * ("background", "lines" …); a dotted path such as "themes.dark.lines" is
 * reduced to its group.
 */
export function applyStyle(next = STYLE, { groups } = {}) {
  if (next !== STYLE) mergeInto(STYLE, next);
  const set = groups ? new Set([...groups].map(groupOf)) : null;
  if (!set || [...set].some((g) => CSS_GROUPS.has(g))) writeCss();
  for (const fn of listeners) fn(STYLE, set);
  return STYLE;
}

/** "themes.dark.lines.coast" -> "lines", "camera.home" -> "camera". */
export function groupOf(path) {
  const parts = String(path).split(".");
  return parts[0] === "themes" ? (parts[2] ?? "themes") : parts[0];
}

function writeCss() {
  let el = document.getElementById(SHEET_ID);
  if (!el) {
    el = document.createElement("style");
    el.id = SHEET_ID;
    document.head.appendChild(el);
  }
  el.textContent = styleCss(STYLE);
}

const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);

/**
 * Copies `src` over `target` key by key, recursing into groups. Only keys the
 * target already has are taken, so a settings file from an older or newer
 * shape can neither delete a value nor smuggle in one nothing reads.
 */
export function mergeInto(target, src) {
  if (!isObject(src)) return target;
  for (const key of Object.keys(target)) {
    if (!(key in src)) continue;
    if (isObject(target[key])) mergeInto(target[key], src[key]);
    else if (typeof src[key] === typeof target[key]) target[key] = src[key];
  }
  return target;
}
