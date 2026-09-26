/**
 * A procedural star sheet for the sky: `count` stars of about `radius` px in
 * `color`, scattered by a seeded hash over a tile that wraps, returned as a
 * data URL for the pattern layer. The alternative to the baked
 * /textures/stars.png, for when the count or colour is what needs tuning.
 * Cached by its parameters, so re-applying an unchanged style costs nothing.
 */
const cache = new Map();

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export function starSheet({ count, radius, color, seed, size }) {
  const px = Math.round(Math.min(Math.max(size, 64), 2048));
  const key = `${count}|${radius}|${color}|${seed}|${px}`;
  if (cache.has(key)) return cache.get(key);

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = px;
  const ctx = canvas.getContext("2d");
  const rand = rng(seed * 2654435761);
  const n = parseInt(color.slice(1), 16);
  const rgb = `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
  const stars = Math.round(Math.min(Math.max(count, 0), 20000));
  for (let i = 0; i < stars; i++) {
    const x = rand() * px;
    const y = rand() * px;
    // Mostly faint, a few bright: brightness on a steep curve.
    const b = Math.pow(rand(), 3);
    const r = radius * (0.5 + b * 1.6);
    const a = 0.25 + b * 0.75;
    // Drawn at each wrap offset near an edge, so the tile repeats seamlessly.
    for (const ox of x < r * 2 ? [0, px] : x > px - r * 2 ? [0, -px] : [0]) {
      for (const oy of y < r * 2 ? [0, px] : y > px - r * 2 ? [0, -px] : [0]) {
        const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r * 2);
        g.addColorStop(0, `rgba(${rgb},${a})`);
        g.addColorStop(0.4, `rgba(${rgb},${a * 0.5})`);
        g.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(x + ox - r * 2, y + oy - r * 2, r * 4, r * 4);
      }
    }
  }
  const url = canvas.toDataURL("image/png");
  if (cache.size > 8) cache.delete(cache.keys().next().value);
  cache.set(key, url);
  return url;
}
