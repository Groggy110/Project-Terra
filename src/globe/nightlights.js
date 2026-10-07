/**
 * City lights for the night side, painted from places.json rather than
 * shipped as a texture, on an equirectangular map the surface shader samples
 * by the same uv as the day imagery.
 *
 * Each place is a sprinkle of single-texel lights rather than one soft dot,
 * the way a city looks from a plane: a dense, bright core thinning out into
 * suburbs, a few streets of light running out of it, mostly dim points with
 * a bright one here and there, and dark between them. How far it spreads
 * and how many points it has both grow with its population. `size` lays a
 * faint glow under the larger cities — 0 leaves only the points.
 *
 * Painted straight into a one-channel byte array (no canvas, so no canvas
 * size limit), seeded per place so it is the same city every time. Built
 * only when STYLE.globe.nightLights is first switched on, and again when its
 * size changes.
 */
import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RedFormat, UnsignedByteType } from "three";

/** Kilometres a texel at the equator, for a map `w` texels round. */
const kmPerTexel = (w) => 40075 / w;

/** Small, fast, seedable: the same city scatters the same way every build. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export function paintNightLights(places, size = 0.5, maxTexture = 8192) {
  const W = Math.min(8192, maxTexture);
  const H = W / 2;
  const km = kmPerTexel(W);
  const acc = new Uint16Array(W * H);

  const add = (x, y, v) => {
    if (y < 0 || y >= H) return;
    x = ((x % W) + W) % W;
    const i = y * W + x;
    acc[i] = Math.min(acc[i] + v, 65535);
  };

  places.forEach((p, n) => {
    const lon = p[1];
    const lat = p[2];
    const pop = Math.max(p[4] || 0, 1000);
    const k = Math.log10(pop); // 3 .. 7.5
    const cx = ((lon + 180) / 360) * W;
    const cy = ((90 - lat) / 180) * H;
    // East-west texels are narrower on the ground away from the equator.
    const sx = 1 / (km * Math.max(Math.cos((lat * Math.PI) / 180), 0.15));
    const sy = 1 / km;
    // Radius of the built-up area, km: a village a few, a megacity ~50.
    const R = 0.35 * Math.pow(pop, 0.3);
    const count = Math.round(Math.pow(pop, 0.45) / 3);
    const rand = rng(n * 2654435761 + 7);

    // A few roads out of town, the bigger the city the more.
    const roads = [];
    for (let r = 0, nr = k > 4.5 ? 1 + Math.floor((k - 4.5) * 1.5) : 0; r < nr; r++) roads.push(rand() * Math.PI * 2);

    for (let i = 0; i < count; i++) {
      let dx;
      let dy;
      if (roads.length && rand() < 0.3) {
        // Along a road, with a little scatter either side.
        const a = roads[Math.floor(rand() * roads.length)] + (rand() - 0.5) * 0.15;
        const t = R * (0.3 + 1.7 * Math.pow(rand(), 0.8));
        const off = (rand() - 0.5) * R * 0.12;
        dx = Math.cos(a) * t - Math.sin(a) * off;
        dy = Math.sin(a) * t + Math.cos(a) * off;
      } else {
        // The town itself: dense at the centre, thinning outward.
        const a = rand() * Math.PI * 2;
        const t = R * 0.55 * -Math.log(1 - rand() * 0.98);
        dx = Math.cos(a) * t;
        dy = Math.sin(a) * t;
      }
      const d = Math.hypot(dx, dy) / R;
      // Mostly dim with the odd bright light, brighter toward downtown.
      const b = (25 + 230 * Math.pow(rand(), 3)) * (0.35 + 0.65 * Math.exp(-d * 1.5));
      add(Math.round(cx + dx * sx), Math.round(cy + dy * sy), Math.round(b));
    }

    // The faint sky-glow over a big city, under its points.
    if (size > 0 && k > 5) {
      const gr = R * (0.6 + size);
      const rx = Math.ceil(gr * 2 * sx);
      const ry = Math.ceil(gr * 2 * sy);
      const peak = size * 18 * (k - 5);
      for (let y = -ry; y <= ry; y++) {
        for (let x = -rx; x <= rx; x++) {
          const q = (x / sx) ** 2 + (y / sy) ** 2;
          const v = peak * Math.exp(-q / (gr * gr));
          if (v >= 1) add(Math.round(cx) + x, Math.round(cy) + y, Math.round(v));
        }
      }
    }
  });

  // Overlapping points saturate softly rather than clip.
  const data = new Uint8Array(W * H);
  for (let i = 0; i < acc.length; i++) {
    const v = acc[i];
    if (v) data[i] = Math.round(255 * (1 - Math.exp(-v / 160)));
  }

  // v = 0 is the north pole, as for the other equirectangular maps.
  const tex = new DataTexture(data, W, H, RedFormat, UnsignedByteType);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}
