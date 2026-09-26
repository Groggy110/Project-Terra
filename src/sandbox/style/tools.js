/**
 * The Style Sandbox's plumbing: presets in localStorage, undo history,
 * export / import, and the high-resolution screenshot. Nothing here draws a
 * control; panel.js does that.
 */
import { STYLE, STYLE_VERSION } from "../../style/styleConfig.js";

/* ---------------------------------------------------------------- storage */

/** The one localStorage key the sandbox uses. See REMOVAL.md. */
export const STORAGE_KEY = "terraSandbox";

export function loadStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return { presets: {}, note: "", panel: null, ...raw };
  } catch {
    return { presets: {}, note: "", panel: null };
  }
}

export function saveStore(store) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- history */

/** Snapshots of the whole STYLE, as JSON, one per finished change. */
export class History {
  constructor(limit = 200) {
    this.limit = limit;
    this.stack = [];
    this.at = -1;
  }

  commit() {
    const snap = JSON.stringify(STYLE);
    if (this.stack[this.at] === snap) return false;
    this.stack.splice(this.at + 1);
    this.stack.push(snap);
    if (this.stack.length > this.limit) this.stack.shift();
    this.at = this.stack.length - 1;
    return true;
  }

  undo() {
    return this.at > 0 ? JSON.parse(this.stack[--this.at]) : null;
  }

  redo() {
    return this.at < this.stack.length - 1 ? JSON.parse(this.stack[++this.at]) : null;
  }
}

/* ------------------------------------------------------- export / import */

/** The complete snapshot: every value, not just the changed ones. */
export function exportPayload(note = "", theme = "dark") {
  return {
    app: "terra",
    kind: "style-settings",
    version: STYLE_VERSION,
    timestamp: new Date().toISOString(),
    note,
    theme,
    style: structuredClone(STYLE),
  };
}

export function exportJson(note, theme) {
  return JSON.stringify(exportPayload(note, theme), null, 2);
}

export function download(text, name = "terra-style-settings.json", type = "application/json") {
  const blob = text instanceof Blob ? text : new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Reads an exported file (or a bare STYLE object) back. Returns the style,
 * the note and a warning when the file is from another config version.
 */
export function parseImport(text) {
  const data = JSON.parse(text);
  const style = data && typeof data.style === "object" ? data.style : data;
  if (!style || typeof style !== "object" || !style.themes) {
    throw new Error("That JSON has no Terra style in it.");
  }
  const version = data.version ?? style.version;
  const warning =
    version !== STYLE_VERSION ? `Settings are version ${version}; this app is version ${STYLE_VERSION}. Matching keys were applied.` : "";
  return { style, note: typeof data.note === "string" ? data.note : "", warning };
}

/* ------------------------------------------------------------- screenshot */

let starSheet = null;
const loadStars = () =>
  (starSheet ??= new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = "/textures/stars.png";
  }));

/** Paints the theme's CSS ground into a 2D context, as base.css would. */
async function paintGround(ctx, w, h, k, b) {
  if (b.mode === "solid") {
    ctx.fillStyle = b.solid;
    ctx.fillRect(0, 0, w, h);
  } else if (b.mode === "linear") {
    // CSS angles: 0deg points up, clockwise; the line spans the box's corners.
    const a = (b.linear.angle * Math.PI) / 180;
    const len = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
    const dx = (Math.sin(a) * len) / 2;
    const dy = (-Math.cos(a) * len) / 2;
    const g = ctx.createLinearGradient(w / 2 - dx, h / 2 - dy, w / 2 + dx, h / 2 + dy);
    g.addColorStop(0, b.linear.top);
    g.addColorStop(1, b.linear.bottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  } else if (b.mode === "radial") {
    const r = b.radial;
    const rx = Math.max((w * r.width) / 100, 1);
    const ry = Math.max((h * r.height) / 100, 1);
    const cx = (w * r.x) / 100;
    const cy = (h * r.y) / 100;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(rx, ry);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, r.center);
    g.addColorStop(Math.min(Math.max(r.midStop / 100, 0), 1), r.mid);
    g.addColorStop(1, r.edge);
    ctx.fillStyle = g;
    // The whole canvas, expressed in the ellipse's unit space.
    ctx.fillRect(-cx / rx, -cy / ry, w / rx, h / ry);
    ctx.restore();
  }

  if (b.pattern === "stars") {
    const img = await loadStars();
    if (img) {
      const pat = ctx.createPattern(img, "repeat");
      const s = (b.stars.size * k) / img.width;
      pat.setTransform(new DOMMatrix().scale(s, s));
      ctx.globalAlpha = b.stars.opacity;
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    }
  } else if (b.pattern === "dots") {
    const d = b.dots;
    const layer = document.createElement("canvas");
    layer.width = w;
    layer.height = h;
    const l = layer.getContext("2d");
    const n = parseInt(d.color.slice(1), 16);
    l.fillStyle = `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${d.alpha})`;
    const step = d.spacing * k;
    const ox = (w / 2) % step;
    const oy = (h / 2) % step;
    for (let y = oy - step / 2; y < h + step; y += step) {
      for (let x = ox - step / 2; x < w + step; x += step) {
        l.beginPath();
        l.arc(x, y, d.size * k, 0, Math.PI * 2);
        l.fill();
      }
    }
    // The same elliptical fade as the CSS mask: clear at the middle.
    l.globalCompositeOperation = "destination-in";
    l.save();
    l.translate(w * 0.5, h * 0.48);
    l.scale(w * 0.75, h * 0.85);
    const g = l.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(Math.min(d.fadeInner / 100, 1), "rgba(0,0,0,0)");
    g.addColorStop(Math.min(Math.max(d.fadeOuter, d.fadeInner) / 100, 1), "rgba(0,0,0,1)");
    l.fillStyle = g;
    l.fillRect(-2, -2, 4, 4);
    l.restore();
    ctx.globalAlpha = d.opacity;
    ctx.drawImage(layer, 0, 0);
    ctx.globalAlpha = 1;
  }
}

/**
 * Renders the globe at `scale` times its on-screen resolution and returns a
 * PNG blob of it over the theme's ground. The canvas is re-rendered rather
 * than read back, so nothing on top of it — this panel, the chrome, the DOM
 * pins and labels — is in the picture.
 */
export async function screenshot(globe, theme, scale = 2) {
  const r = globe.renderer;
  const { w, h } = globe.size;
  const before = r.getPixelRatio();
  const max = r.capabilities.maxTextureSize || 8192;
  // Relative to the display's full resolution, not to whatever the adaptive
  // scaler has the canvas drawing at this moment.
  const ratio = Math.min(globe.dpr * scale, max / Math.max(w, h));
  const k = ratio / before;

  // The halo and the post pass are sized in drawing-buffer pixels.
  const hu = globe.halo.uniforms;
  const pu = globe.post.uniforms;
  const saved = {
    res: hu.uResolution.value.clone(),
    centre: hu.uCentre.value.clone(),
    radius: hu.uRadius.value,
    post: pu.uResolution.value.clone(),
    grain: pu.uGrainSize.value,
  };

  const W = Math.round(w * ratio);
  const H = Math.round(h * ratio);
  const out = document.createElement("canvas");
  out.width = W;
  out.height = H;
  const ctx = out.getContext("2d");
  await paintGround(ctx, W, H, ratio, STYLE.themes[theme].background);

  try {
    r.setPixelRatio(ratio);
    r.setSize(w, h, false);
    hu.uResolution.value.multiplyScalar(k);
    hu.uCentre.value.multiplyScalar(k);
    hu.uRadius.value *= k;
    pu.uResolution.value.multiplyScalar(k);
    pu.uGrainSize.value *= k;
    globe.syncSun();
    globe.render();
    // Same task as the render, so the drawing buffer has not been cleared.
    ctx.drawImage(r.domElement, 0, 0, W, H);
  } finally {
    r.setPixelRatio(before);
    r.setSize(w, h, false);
    hu.uResolution.value.copy(saved.res);
    hu.uCentre.value.copy(saved.centre);
    hu.uRadius.value = saved.radius;
    pu.uResolution.value.copy(saved.post);
    pu.uGrainSize.value = saved.grain;
    globe.dirty = true;
  }
  return new Promise((resolve) => out.toBlob(resolve, "image/png"));
}
