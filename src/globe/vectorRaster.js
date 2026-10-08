/**
 * The vector layer's rasteriser: the binary sets, and drawing them into a 2D
 * context. Nothing here touches the DOM, three or STYLE, so the same code runs
 * on the page (the first paint, and anywhere without OffscreenCanvas) and in
 * vectorWorker.js, which does every paint after that off the main thread.
 */

export const LINE_LAYERS = ["coast", "borders", "rivers"];
export const POLY_LAYERS = ["land", "lakes"];

/* ------------------------------------------------------------------ sets */

function parseLines(buffer) {
  const head = new DataView(buffer);
  const magic = String.fromCharCode(head.getUint8(0), head.getUint8(1), head.getUint8(2), head.getUint8(3));
  if (magic !== "TVEC") throw new Error(`bad line magic ${magic}`);
  const count = head.getUint32(8, true);
  const total = head.getUint32(12, true);
  let at = 16;
  const offsets = new Uint32Array(buffer, at, count + 1);
  at += 4 * (count + 1);
  const boxes = new Float32Array(buffer, at, count * 4);
  at += 16 * count;
  const coords = new Float32Array(buffer, at, total * 2);
  return { kind: "lines", count, offsets, boxes, coords };
}

function parsePolys(buffer) {
  const head = new DataView(buffer);
  const magic = String.fromCharCode(head.getUint8(0), head.getUint8(1), head.getUint8(2), head.getUint8(3));
  if (magic !== "TPOL") throw new Error(`bad poly magic ${magic}`);
  const polyCount = head.getUint32(8, true);
  const ringCount = head.getUint32(12, true);
  const total = head.getUint32(16, true);
  let at = 20;
  const polyOffsets = new Uint32Array(buffer, at, polyCount + 1);
  at += 4 * (polyCount + 1);
  const ringOffsets = new Uint32Array(buffer, at, ringCount + 1);
  at += 4 * (ringCount + 1);
  const boxes = new Float32Array(buffer, at, polyCount * 4);
  at += 16 * polyCount;
  const coords = new Float32Array(buffer, at, total * 2);
  return { kind: "polys", count: polyCount, polyOffsets, ringOffsets, boxes, coords };
}

/** Fetches and parses one scale's five layers. */
export async function loadSet(base, scale) {
  const names = [...LINE_LAYERS, ...POLY_LAYERS];
  const buffers = await Promise.all(
    names.map(async (layer) => {
      const res = await fetch(`${base}/${scale}-${layer}.bin`);
      if (!res.ok) throw new Error(`${scale}-${layer}.bin -> ${res.status}`);
      return res.arrayBuffer();
    }),
  );
  const set = {};
  names.forEach((layer, i) => {
    set[layer] = LINE_LAYERS.includes(layer) ? parseLines(buffers[i]) : parsePolys(buffers[i]);
  });
  return set;
}

/* ----------------------------------------------------------------- paint */

const smoothstep = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * How much of each line layer shows at a density. Detail arrives with zoom:
 * at a whole-globe view the raster already carries the coast, and hairline
 * borders and rivers would only add fizz.
 */
export function fadeFor(pxPerDeg) {
  return {
    coast: 0.34 + 0.66 * smoothstep(4, 13, pxPerDeg),
    borders: smoothstep(5, 13, pxPerDeg),
    rivers: smoothstep(7, 20, pxPerDeg),
    lakeEdge: smoothstep(5, 14, pxPerDeg),
  };
}

/** White land, black water - the crisp replacement for the raster mask. */
export function paintMask(ctx, set, view) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, view.w, view.h);
  ctx.fillStyle = "#fff";
  let n = fillPolys(ctx, set.land, view);
  ctx.fillStyle = "#000";
  n += fillPolys(ctx, set.lakes, view);
  return n;
}

/** The stroked ink: `style` from inkFor, `fade` from fadeFor (or fixed). */
export function paintLines(ctx, set, view, style, fade, texelPerPx) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, view.w, view.h);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  let n = 0;
  const draw = (data, s, weight, isPoly) => {
    if (weight <= 0.01 || !data) return;
    ctx.strokeStyle = `rgba(${s.color},${(s.alpha * weight).toFixed(3)})`;
    ctx.lineWidth = Math.max(s.width * texelPerPx, 0.6);
    n += isPoly ? strokePolys(ctx, data, view) : strokeLines(ctx, data, view);
  };
  draw(set.rivers, style.rivers, fade.rivers, false);
  draw(set.lakes, style.lakeEdge, fade.lakeEdge, true);
  draw(set.borders, style.borders, fade.borders, false);
  draw(set.coast, style.coast, fade.coast, false);
  return n;
}

/* ------------------------------------------------------------ rasterising */

/** Longitude shifts that could bring a feature into the window. */
const OFFSETS = [0, -360, 360];

function overlaps(boxes, i, view, lonMax, latMin) {
  const b = i * 4;
  const minLat = boxes[b + 1];
  const maxLat = boxes[b + 3];
  if (maxLat < latMin || minLat > view.latMax) return null;
  const minLon = boxes[b];
  const maxLon = boxes[b + 2];
  for (let k = 0; k < 3; k++) {
    const off = OFFSETS[k];
    if (maxLon + off >= view.lonMin && minLon + off <= lonMax) return off;
  }
  return null;
}

function strokeLines(ctx, data, view) {
  const { count, offsets, boxes, coords } = data;
  const lonMax = view.lonMin + view.w / view.kx;
  const latMin = view.latMax - view.h / view.ky;
  let drawn = 0;
  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const off = overlaps(boxes, i, view, lonMax, latMin);
    if (off === null) continue;
    const start = offsets[i];
    const end = offsets[i + 1];
    if (end - start < 2) continue;
    for (let p = start; p < end; p++) {
      const x = (coords[p * 2] + off - view.lonMin) * view.kx;
      const y = (view.latMax - coords[p * 2 + 1]) * view.ky;
      if (p === start) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    drawn++;
  }
  ctx.stroke();
  return drawn;
}

function ringPath(ctx, data, i, off, view) {
  const { polyOffsets, ringOffsets, coords } = data;
  const rStart = polyOffsets[i];
  const rEnd = polyOffsets[i + 1];
  for (let r = rStart; r < rEnd; r++) {
    const start = ringOffsets[r];
    const end = ringOffsets[r + 1];
    if (end - start < 3) continue;
    for (let p = start; p < end; p++) {
      const x = (coords[p * 2] + off - view.lonMin) * view.kx;
      const y = (view.latMax - coords[p * 2 + 1]) * view.ky;
      if (p === start) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }
}

function fillPolys(ctx, data, view) {
  if (!data) return 0;
  const lonMax = view.lonMin + view.w / view.kx;
  const latMin = view.latMax - view.h / view.ky;
  let drawn = 0;
  for (let i = 0; i < data.count; i++) {
    const off = overlaps(data.boxes, i, view, lonMax, latMin);
    if (off === null) continue;
    // One path per polygon, filled even-odd, so islands keep their lakes
    // without depending on ring winding being consistent upstream.
    ctx.beginPath();
    ringPath(ctx, data, i, off, view);
    ctx.fill("evenodd");
    drawn++;
  }
  return drawn;
}

function strokePolys(ctx, data, view) {
  if (!data) return 0;
  const lonMax = view.lonMin + view.w / view.kx;
  const latMin = view.latMax - view.h / view.ky;
  let drawn = 0;
  ctx.beginPath();
  for (let i = 0; i < data.count; i++) {
    const off = overlaps(data.boxes, i, view, lonMax, latMin);
    if (off === null) continue;
    ringPath(ctx, data, i, off, view);
    drawn++;
  }
  ctx.stroke();
  return drawn;
}
