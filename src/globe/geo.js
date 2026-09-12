/**
 * Spherical bookkeeping shared by the renderer, the vector painter and the
 * label layer.
 *
 * One convention, used everywhere including inside the shaders:
 *
 *   x = cos(lat) * cos(lon)
 *   y = sin(lat)
 *   z = -cos(lat) * sin(lon)
 *
 * which inverts to `lon = atan2(-z, x)`, `lat = asin(y)`. The branch cut of
 * that atan2 falls on the antimeridian, so the one seam in the texture lookup
 * sits in the middle of the Pacific rather than through Greenwich.
 */
import { Vector3 } from "three";

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Shortest signed distance from a to b in degrees, in (-180, 180]. */
export function wrapDelta(a, b) {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

export function normaliseLon(lon) {
  let l = ((lon + 180) % 360 + 360) % 360 - 180;
  return l === -180 ? 180 : l;
}

export function latLonToVec3(lat, lon, radius = 1, out = new Vector3()) {
  const la = lat * DEG;
  const lo = lon * DEG;
  const c = Math.cos(la);
  return out.set(radius * c * Math.cos(lo), radius * Math.sin(la), -radius * c * Math.sin(lo));
}

export function vec3ToLatLon(v) {
  const r = Math.hypot(v.x, v.y, v.z) || 1;
  return {
    lat: Math.asin(clamp(v.y / r, -1, 1)) * RAD,
    lon: Math.atan2(-v.z / r, v.x / r) * RAD,
  };
}

/** Great-circle distance in kilometres. */
export function haversine(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * DEG;
  const dLon = (bLon - aLon) * DEG;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * DEG) * Math.cos(bLat * DEG) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Screen pixels per degree of arc on the near surface, which is the number the
 * vector painter sizes its canvas from and the label layer thins against.
 */
export function pixelsPerDegree(distance, viewportHeight, fovDeg) {
  const depth = Math.max(distance - 1, 1e-4);
  const perUnit = viewportHeight / (2 * depth * Math.tan(fovDeg * DEG * 0.5));
  return perUnit * DEG;
}

/** Angular half-extent of the sphere that a screen half-angle reaches. */
function reachFor(distance, halfAngle) {
  const horizon = Math.acos(clamp(1 / distance, -1, 1));
  const reach = distance * Math.sin(halfAngle);
  if (reach >= 1) return horizon;
  return Math.min(horizon, Math.max(Math.asin(reach) - halfAngle, 1e-4));
}

/**
 * Separate horizontal and vertical half-extents, in degrees of arc.
 *
 * A single circular cap is the wrong shape for a wide viewport: on a 2:1
 * screen it over-covers latitude by more than twice, and the vector painter
 * pays for that in texels it never shows.
 */
export function visibleExtent(distance, fovDeg, aspect) {
  const halfV = fovDeg * DEG * 0.5;
  const halfH = Math.atan(Math.tan(halfV) * aspect);
  return {
    v: reachFor(distance, halfV) * RAD,
    h: reachFor(distance, halfH) * RAD,
  };
}

/** Angular radius of the sphere cap that is actually on screen, in degrees. */
export function visibleCapRadius(distance, fovDeg, aspect) {
  const horizon = Math.acos(clamp(1 / distance, -1, 1));
  const halfFov = fovDeg * DEG * 0.5;
  // widest screen direction: the corner
  const corner = Math.atan(Math.tan(halfFov) * Math.hypot(1, aspect));
  const reach = distance * Math.sin(corner);
  const capped = reach >= 1 ? horizon : Math.asin(reach) - corner;
  return Math.min(horizon, Math.max(capped, 0.05 * DEG)) * RAD;
}

/**
 * Lat/lon box covering what the screen shows.
 *
 * The visible patch is treated as an ellipse in arc space with semi-axes
 * (extent.h, extent.v) and sampled around its rim, because the longitude a
 * given arc offset spans depends on the latitude it lands at - a closed-form
 * bound either wastes texels or, near the poles, blows up to a full wrap.
 */
export function viewBounds(lat, lon, extent, pad = 1) {
  const ev = Math.min(extent.v * pad, 180);
  const eh = Math.min(extent.h * pad, 180);

  const latMin = lat - ev;
  const latMax = lat + ev;
  if (latMax >= 89.5 || latMin <= -89.5) {
    return {
      lonMin: -180,
      lonSpan: 360,
      latMin: clamp(latMin, -90, 90),
      latSpan: clamp(latMax, -90, 90) - clamp(latMin, -90, 90),
    };
  }

  let dLon = 0;
  for (let i = 0; i <= 16; i++) {
    const t = (i / 16) * Math.PI - Math.PI / 2; // -90..90, the eastern rim
    const dy = Math.sin(t) * ev;
    const dx = Math.cos(t) * eh;
    const cosAt = Math.cos(clamp(lat + dy, -89.9, 89.9) * DEG);
    const ratio = Math.sin(dx * DEG) / Math.max(cosAt, 1e-4);
    if (ratio >= 1) return { lonMin: -180, lonSpan: 360, latMin, latSpan: latMax - latMin };
    dLon = Math.max(dLon, Math.asin(ratio) * RAD);
  }
  if (dLon >= 180) return { lonMin: -180, lonSpan: 360, latMin, latSpan: latMax - latMin };
  return { lonMin: lon - dLon, lonSpan: dLon * 2, latMin, latSpan: latMax - latMin };
}

/** True when `inner` is fully inside `outer` (both from capBounds). */
export function boundsContain(outer, inner) {
  if (outer.lonSpan >= 359.99) {
    // fully wrapped in longitude, so only latitude can fail
  } else {
    const lo = wrapDelta(outer.lonMin, inner.lonMin);
    const hi = wrapDelta(outer.lonMin, inner.lonMin + inner.lonSpan);
    if (lo < -0.001 || hi > outer.lonSpan + 0.001 || hi < lo) return false;
  }
  return (
    inner.latMin >= outer.latMin - 0.001 &&
    inner.latMin + inner.latSpan <= outer.latMin + outer.latSpan + 0.001
  );
}

const scratch = new Vector3();

/**
 * Projects a surface point to viewport pixels.
 * `visible` is the near-side test, `edge` fades markers into the limb.
 */
export function projectPoint(lat, lon, camera, width, height, out = {}) {
  latLonToVec3(lat, lon, 1, scratch);
  const nx = scratch.x;
  const ny = scratch.y;
  const nz = scratch.z;

  const cam = camera.position;
  const toCam = 1 / (Math.hypot(cam.x, cam.y, cam.z) || 1);
  // dot(surface normal, direction to camera): positive on the near side
  const facing = nx * cam.x * toCam + ny * cam.y * toCam + nz * cam.z * toCam;

  scratch.project(camera);
  out.x = (scratch.x * 0.5 + 0.5) * width;
  out.y = (-scratch.y * 0.5 + 0.5) * height;
  out.facing = facing;
  out.visible = facing > 0 && scratch.z < 1;
  out.edge = smoothstep(0, 0.24, facing);
  return out;
}
