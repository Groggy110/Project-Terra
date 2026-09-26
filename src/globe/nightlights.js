/**
 * City lights for the night side, painted from places.json rather than
 * shipped as a texture: every place is a soft additive dot, sized and
 * brightened by the log of its population, on an equirectangular canvas the
 * surface shader samples by the same uv as the day imagery.
 *
 * Built only when STYLE.globe.nightLights is first switched on, and again
 * when its size changes; it costs a few tens of milliseconds.
 */
import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter } from "three";

const W = 4096;
const H = 2048;

export function paintNightLights(places, size = 1.5) {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = "lighter";

  for (const p of places) {
    const lon = p[1];
    const lat = p[2];
    const pop = Math.max(p[4] || 0, 1000);
    const k = Math.log10(pop); // 3 .. 7.5
    const x = ((lon + 180) / 360) * W;
    const y = ((90 - lat) / 180) * H;
    const r = size * (0.8 + (k - 3) * 1.1);
    const a = Math.min(0.12 + (k - 3) * 0.16, 0.85);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 2.2);
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(0.35, `rgba(255,255,255,${a * 0.45})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r * 2.2, y - r * 2.2, r * 4.4, r * 4.4);
  }

  const tex = new CanvasTexture(canvas);
  // v = 0 is the north pole, as for the other equirectangular maps.
  tex.flipY = false;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  return tex;
}
