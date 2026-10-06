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

  // A sharp core and a small glow, rather than one soft disc: seen close, a
  // city is a point of light, and a soft disc reads as a smudge. Bigger
  // places scatter a few suburbs round them, so a metropolis glitters
  // instead of glowing as one blob. The scatter is seeded by position, so
  // the same city always lights the same way.
  const dot = (x, y, r, a) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(0.25, `rgba(255,255,255,${a * 0.6})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };

  for (const p of places) {
    const lon = p[1];
    const lat = p[2];
    const pop = Math.max(p[4] || 0, 1000);
    const k = Math.log10(pop); // 3 .. 7.5
    const x = ((lon + 180) / 360) * W;
    const y = ((90 - lat) / 180) * H;
    const r = size * (0.8 + (k - 3) * 1.1);
    const a = Math.min(0.2 + (k - 3) * 0.2, 0.95);
    dot(x, y, r * 2.4, a * 0.22);
    dot(x, y, Math.max(r * 0.75, 0.9), a);

    const suburbs = Math.max(0, Math.floor((k - 4.8) * 5));
    let seed = Math.abs(Math.sin(lon * 12.9898 + lat * 78.233)) * 43758.5453;
    const rnd = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    for (let i = 0; i < suburbs; i++) {
      const ang = rnd() * Math.PI * 2;
      const dist = r * (1.2 + rnd() * 3.2);
      dot(x + Math.cos(ang) * dist, y + Math.sin(ang) * dist * 0.8, Math.max(r * 0.4, 0.8), a * (0.35 + rnd() * 0.4));
    }
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
