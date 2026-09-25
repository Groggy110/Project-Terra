/**
 * Globe camera: the view is a point on the sphere plus a distance, never a
 * free-floating orbit, so north stays up and every fly-to is a lat/lon/zoom
 * interpolation rather than a quaternion slerp.
 *
 * Drag rate is derived from pixels-per-degree at the near surface, which makes
 * the ground track the cursor at any zoom instead of feeling geared.
 */
import { Raycaster, Sphere, Vector2, Vector3 } from "three";

import { clamp, DEG, latLonToVec3, pixelsPerDegree, RAD, smoothstep, vec3ToLatLon, wrapDelta } from "./geo.js";

/**
 * The close stop, and it is a *height*, not a distance: 1.055 is fifty-five
 * thousandths of an earth radius above the surface, which frames about a
 * thousand kilometres — a country, never a city. That was the right stop while
 * the only imagery was a 5400-pixel Blue Marble, because there was nothing
 * further in to see; with streamed tiles under it there is, and stopping a
 * thousand kilometres up is stopping the map short of the thing it now knows.
 *
 * 1.014 frames about ninety kilometres: a city and the country it sits in,
 * which is as close as a *globe* has any business going — past that you are
 * looking at a plane and the product stops being a world.
 *
 * Cheap in the one place that would have been expensive. `zoom` is the log of
 * the distance normalised over NEAR..FAR, so moving this end rescales the
 * whole ladder — but in logs the move is 3%, because the distance barely
 * changes even as the height falls fourfold. Every threshold keyed off zoom()
 * lands within 0.02 of where it did, which is inside the smoothsteps they are
 * all written as.
 */
export const DIST_NEAR = 1.014;
export const DIST_FAR = 4.45;
const LAT_LIMIT = 87;

/**
 * Idle drift. A globe that holds perfectly still reads as a photograph of one;
 * turning it slowly eastward — the direction the camera travels to bring Asia
 * round after the Americas — says the whole world is on the other side.
 *
 * The rate is set in *pixels of ground per second*, not degrees: a degree is
 * worth twice as much screen at the working view as it is at the whole globe,
 * and a fixed angular rate that reads as a slow turn from far off reads as a
 * pan you cannot read over the top of once you have come in. Converting
 * through pixels-per-degree holds the apparent speed steady at every zoom.
 */
const SPIN_PX = 18;
/** Cap, in degrees a second — what the pixel rate asks for at the whole globe. */
const SPIN_MAX = 3.2;
/** Quiet time after a deliberate move before the drift picks up again. */
const SPIN_RESUME = 3.4;
/**
 * Where the quiet clock is set when a flight hands straight over to the drift.
 * The full resume wait is for *deliberate* moves — you put the camera
 * somewhere, and it stays put long enough to look at. A flight the page ran
 * itself has no such claim on stillness, and leaving the world dead for three
 * and a half seconds at the end of the entrance reads as the animation having
 * broken.
 *
 * Straight to full rate, with no ramp at all — because by the time a
 * spinInto flight clears, the drift is already turning at exactly this speed
 * underneath it (see the blend in update). Ramping here would subtract from a
 * turn that is already at rate, which is what the stall was.
 */
const SPIN_HANDOVER = SPIN_RESUME + 1;
/** Drift is a world gesture; by the time the view is a region it is off. */
const SPIN_FADE = [0.44, 0.72];
/**
 * Time constant of the rotation smoothing in update(). Named because the
 * entrance has to undo it: a target that starts advancing from rest takes
 * about this long to show its full speed at the camera.
 */
const ROT_TAU = 0.075;
/**
 * And of the zoom smoothing. It sat at 0.13 — three quarters again as slow as
 * the rotation beside it, so a wheel gesture visibly lagged the drag gesture
 * on the same surface. Brought in close to the rotation, with a shade more
 * softness left on it than a turn gets: a distance that snaps reads as the
 * ground jumping at you, where a turn that snaps just reads as quick.
 */
const ZOOM_TAU = 0.085;
/**
 * Distance multiplier per unit of wheel delta, applied in the exponent so a
 * notch is worth the same *proportion* of the remaining approach at every
 * zoom. About six notches now cross the whole range, where it used to be
 * nearly nine.
 */
const WHEEL_GAIN = 0.002;

/** 0 at the whole-globe view, 1 at the closest zoom. */
export function zoomLevel(dist) {
  const t = Math.log(dist / DIST_FAR) / Math.log(DIST_NEAR / DIST_FAR);
  return clamp(t, 0, 1);
}

export function distForZoom(z) {
  return DIST_FAR * Math.pow(DIST_NEAR / DIST_FAR, clamp(z, 0, 1));
}

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/**
 * The same S, one power gentler.
 *
 * The cubic is almost perfectly flat at the start — four tenths of one per
 * cent of the way after a fifth of a second — which is right for a hop
 * between two places, where the camera should look like it gathers itself
 * before it goes. It is wrong for the entrance, where the move has to look
 * like it began on the same beat as the chrome: for the first third of a
 * second nothing measurably happens, and that reads as the globe waiting its
 * turn. The quadratic peaks at the same speed in the middle, so it costs
 * nothing in violence, and is off the mark five times sooner.
 */
const easeInOutQuad = (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t));
const EASINGS = { cubic: easeInOut, quad: easeInOutQuad };

export class GlobeControls {
  #angleA;
  #angleB;
  #rect = null;

  constructor(dom, camera, { onFirstGesture } = {}) {
    this.dom = dom;
    this.camera = camera;
    this.onFirstGesture = onFirstGesture;

    this.lat = 14;
    this.lon = -52;
    this.dist = DIST_FAR;
    this.target = { lat: this.lat, lon: this.lon, dist: this.dist };

    this.vel = { lat: 0, lon: 0 };
    this.dragging = false;
    this.reduced = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    this.spinWanted = true;
    this.spin = !this.reduced;
    this.spinHeld = false;
    this.spinning = false;
    this.quiet = SPIN_RESUME;
    this.pointers = new Map();
    this.pinch = 0;
    this.flight = null;
    this.moved = false;
    this.gestured = false;
    this.viewport = { w: 1, h: 1 };
    /** Portrait withdrawal; 1 until setViewport says otherwise. */
    this.fit = 1;

    this.raycaster = new Raycaster();
    this.sphere = new Sphere(new Vector3(0, 0, 0), 1);
    this.#angleA = new Vector3();
    this.#angleB = new Vector3();
    this.ndc = new Vector2();
    this.hit = new Vector3();

    this.#bind();
  }

  get pxPerDeg() {
    return pixelsPerDegree(this.camDist, this.viewport.h, this.camera.fov);
  }

  get zoom() {
    return zoomLevel(this.dist);
  }

  setViewport(w, h) {
    this.viewport.w = w;
    this.viewport.h = h;
    this.#rect = null;

    // A vertical field of view sizes the globe against the window's *height*,
    // which is right until the window is taller than it is wide. On a phone
    // held upright that framing puts a 34-degree sphere inside a 17-degree
    // horizontal frustum: you get a close-up of the Atlantic and no planet.
    //
    // So on a portrait viewport the camera withdraws by the amount the aspect
    // falls short of square. Distance rather than a wider lens, because the
    // lens would have to open to ninety-odd degrees to cover it and the globe
    // would bulge like a fisheye. This is the framing only — `dist` remains
    // the semantic zoom, DIST_NEAR..DIST_FAR is untouched, and every threshold
    // keyed off zoom() keeps meaning what it meant.
    const portrait = Math.min(Math.max(1, 1.2 / Math.max(w / Math.max(h, 1), 0.01)), 3.4);
    // A short viewport is not a narrow one, and the aspect ratio cannot tell
    // them apart: a phone on its side is wide *and* has 400px of height, most
    // of which the bar, the find field and the filter row have already spent.
    // So anything under 560px tall gives the disc a little more room as well.
    this.fit = portrait * (h < 560 ? 1.24 : 1);
  }

  /**
   * Where the camera actually is. `dist` is the zoom the app reasons about;
   * this is that distance after the portrait fit above, and it is what every
   * projection — the camera, pixels-per-degree, the halo radius, the visible
   * cap — has to be built from, or they disagree with what is on screen.
   */
  get camDist() {
    return this.dist * this.fit;
  }

  /**
   * The canvas box, cached.
   *
   * pointAt needs it, and pointAt runs on every wheel event — which a
   * trackpad delivers far faster than frames. Reading it live meant a forced
   * layout per event, taken immediately after the label layer had written a
   * transform onto every marker in the same frame: the reader pays for the
   * writer, and a pinch-zoom turned into a synchronous relayout of the whole
   * overlay several times a frame. The canvas is fixed to the viewport, so
   * the box only moves when the viewport does.
   */
  get rect() {
    if (!this.#rect) this.#rect = this.dom.getBoundingClientRect();
    return this.#rect;
  }

  /**
   * Pauses or resumes the idle drift. The app holds it while a ministry is
   * selected: having asked to look at one place, the camera should not then
   * carry you away from it. Someone who has asked for less motion never gets
   * the drift back on.
   */
  setSpin(on) {
    this.spinWanted = !!on;
    this.spin = this.spinWanted && !this.reduced;
  }

  /**
   * Holds the drift off outright, over the top of whatever setSpin last asked
   * for. The entrance uses it: the page opens on a globe standing still, and
   * the turn is something the settle *starts*, so that arriving reads as one
   * move rather than as a world that was already going when you got there.
   */
  holdSpin(on) {
    this.spinHeld = !!on;
  }

  /* ------------------------------------------------------------- gestures */

  #bind() {
    const dom = this.dom;
    dom.addEventListener("pointerdown", this.#down, { passive: false });
    dom.addEventListener("pointermove", this.#move, { passive: false });
    dom.addEventListener("pointerup", this.#up);
    dom.addEventListener("pointercancel", this.#up);
    dom.addEventListener("wheel", this.#wheel, { passive: false });
    dom.addEventListener("dblclick", this.#dbl);
    dom.addEventListener("contextmenu", (e) => e.preventDefault());
    const drop = () => (this.#rect = null);
    window.addEventListener("resize", drop);
    window.addEventListener("scroll", drop, true);
  }

  /**
   * Takes the camera off whatever the page was doing with it and parks the
   * target where the camera actually is.
   *
   * Clearing the flight alone is not enough: flyTo also moves the target to
   * the destination, so a flight cancelled halfway left the target sitting at
   * the far end and the easing carried on travelling there — a grab during
   * the entrance dragged against a camera still on its way to the working
   * view. Parking the target is a no-op at rest, when it is already where the
   * camera is.
   */
  #takeOver() {
    this.flight = null;
    this.target.lat = this.lat;
    this.target.lon = this.lon;
    this.target.dist = this.dist;
  }

  /** Marks deliberate input: retires the drift for a beat, and the hero once. */
  #note() {
    this.quiet = 0;
    if (this.gestured) return;
    this.gestured = true;
    this.onFirstGesture?.();
  }

  #down = (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    this.quiet = 0;
    this.dom.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.#takeOver();
    this.moved = false;
    if (this.pointers.size === 1) {
      this.dragging = true;
      this.vel.lat = 0;
      this.vel.lon = 0;
      this.dom.classList.add("is-dragging");
    } else if (this.pointers.size === 2) {
      this.pinch = this.#spread();
    }
  };

  #move = (e) => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    prev.x = e.clientX;
    prev.y = e.clientY;

    if (this.pointers.size >= 2) {
      const spread = this.#spread();
      if (this.pinch > 0 && spread > 0) {
        this.#zoomTo(this.target.dist * (this.pinch / spread));
        this.pinch = spread;
      }
      return;
    }

    if (!this.dragging) return;
    if (Math.abs(dx) + Math.abs(dy) > 2) {
      this.moved = true;
      this.#note();
    }

    const ppd = Math.max(this.pxPerDeg, 0.4);
    const cosLat = Math.max(Math.cos(this.target.lat * DEG), 0.35);
    const dLon = -dx / (ppd * cosLat);
    const dLat = dy / ppd;

    this.target.lon += dLon;
    this.target.lat = clamp(this.target.lat + dLat, -LAT_LIMIT, LAT_LIMIT);
    // velocity in degrees per second, for the throw
    this.vel.lon = dLon * 58;
    this.vel.lat = dLat * 58;
  };

  #up = (e) => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = 0;
    if (this.pointers.size === 0) {
      this.dragging = false;
      this.dom.classList.remove("is-dragging");
    }
  };

  #spread() {
    const p = [...this.pointers.values()];
    return p.length < 2 ? 0 : Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
  }

  #wheel = (e) => {
    e.preventDefault();
    this.#note();
    this.#takeOver();
    const step = e.deltaMode === 1 ? e.deltaY * 18 : e.deltaY;
    const next = this.target.dist * Math.exp(clamp(step, -260, 260) * WHEEL_GAIN);
    this.#zoomTo(next, e);
  };

  #dbl = (e) => {
    const at = this.pointAt(e);
    this.flyTo({
      lat: at?.lat ?? this.target.lat,
      lon: at?.lon ?? this.target.lon,
      dist: Math.max(this.target.dist * 0.42, DIST_NEAR),
      ms: 900,
    });
  };

  /** Geographic point under a pointer event, or null past the limb. */
  pointAt(e) {
    const rect = this.rect;
    this.ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const point = this.raycaster.ray.intersectSphere(this.sphere, this.hit);
    return point ? vec3ToLatLon(point) : null;
  }

  /**
   * Zooming holds the ground under the cursor: the view centre is pulled
   * toward that point by the fraction of the span the zoom removed.
   */
  #zoomTo(next, event) {
    const from = this.target.dist;
    const to = clamp(next, DIST_NEAR, DIST_FAR);
    this.target.dist = to;
    if (!event || to === from) return;

    const at = this.pointAt(event);
    if (!at) return;
    const shrink = clamp(1 - (to - 1) / (from - 1), -0.6, 0.6);
    this.target.lat = clamp(this.target.lat + (at.lat - this.target.lat) * shrink, -LAT_LIMIT, LAT_LIMIT);
    this.target.lon += wrapDelta(this.target.lon, at.lon) * shrink;
  }

  /* ---------------------------------------------------------------- moves */

  zoomBy(factor) {
    this.#note();
    const from = this.target.dist;
    this.#takeOver();
    this.target.dist = clamp(from * factor, DIST_NEAR, DIST_FAR);
  }

  /**
   * `silent` is for the entrance flight, which the camera runs on its own:
   * counting it as a gesture would retire the hint and the hero before the
   * globe had finished arriving.
   */
  flyTo({ lat, lon, dist, ms = 1200, silent = false, arc = 1, spinInto = false, ease = "cubic" } = {}) {
    if (!silent) this.#note();
    else this.quiet = 0;
    const to = {
      lat: clamp(lat ?? this.target.lat, -LAT_LIMIT, LAT_LIMIT),
      lon: this.lon + wrapDelta(this.lon, lon ?? this.target.lon),
      dist: clamp(dist ?? this.target.dist, DIST_NEAR, DIST_FAR),
    };
    this.vel.lat = 0;
    this.vel.lon = 0;
    this.flight = {
      from: { lat: this.lat, lon: this.lon, dist: this.dist },
      to,
      t: 0,
      ms: Math.max(ms, 1),
      arc,
      spinInto,
      drift: 0,
      ease: EASINGS[ease] || easeInOut,
    };
    this.target = { ...to };
  }

  reset(ms = 1400) {
    this.flyTo({ lat: 14, lon: -52, dist: DIST_FAR, ms });
  }

  /**
   * Degrees of longitude the idle drift should add this frame, or 0 while
   * anything more deliberate has the camera.
   */
  #drift(dt) {
    // The hold parks the clock rather than merely gating the result: a hold
    // that let it run would have banked the whole resume wait by the time it
    // lifted, and the drift would come on at full rate the same frame — which
    // is the one thing the still opening frame exists to avoid.
    if (this.spinHeld) {
      this.quiet = 0;
      return 0;
    }
    this.quiet += dt;
    if (!this.spin || this.dragging || this.flight) return 0;
    if (this.quiet < SPIN_RESUME) return 0;
    // Not while a throw is still running out: the two would compound, and the
    // throw would never appear to settle.
    if (this.vel.lon || this.vel.lat) return 0;
    // Eased in over the first second so the drift starts rather than snaps.
    return this.#driftRate() * smoothstep(SPIN_RESUME, SPIN_RESUME + 1, this.quiet) * dt;
  }

  /**
   * Degrees a second the drift wants at this zoom, before any of the gates.
   * Separate from #drift because a spinInto flight needs the rate while the
   * gates are all still shut against it.
   */
  #driftRate() {
    const fade = 1 - smoothstep(SPIN_FADE[0], SPIN_FADE[1], this.zoom);
    if (fade <= 0) return 0;
    return Math.min(SPIN_PX / Math.max(this.pxPerDeg, 1e-3), SPIN_MAX) * fade;
  }

  /** Advances the easing; returns true when the camera actually moved. */
  update(dt) {
    const before = `${this.lat.toFixed(5)}|${this.lon.toFixed(5)}|${this.dist.toFixed(6)}`;
    const drift = this.#drift(dt);
    this.spinning = drift !== 0;

    if (this.flight) {
      const f = this.flight;
      f.t = Math.min(f.t + dt * 1000, f.ms);
      const k = f.ease(f.t / f.ms);
      // A long hop lifts away from the surface and settles back, so the
      // camera arcs over the globe instead of skimming it.
      const arc = Math.sin(Math.PI * (f.t / f.ms)) * this.#arcLift(f);
      // The drift is brought up *underneath* the flight, weighted by how far
      // along it is, so that the turn the page is left with is already at
      // full rate at the instant the flight lets go of the camera.
      //
      // Handing over at the end instead cannot avoid a stall, however short
      // the ramp: the flight decelerates to nothing as it lands, so the two
      // slowest parts of the two movements meet, and the globe visibly stops
      // and starts again. Blended, the flight's own contribution still falls
      // to zero and what is underneath it is exactly the idle drift.
      if (f.spinInto && this.spin) f.drift += this.#driftRate() * k * dt;
      this.lat = f.from.lat + (f.to.lat - f.from.lat) * k;
      this.lon = f.from.lon + (f.to.lon - f.from.lon) * k + f.drift;
      this.dist = clamp(f.from.dist + (f.to.dist - f.from.dist) * k + arc, DIST_NEAR, DIST_FAR + 1.4);
      if (f.t >= f.ms) {
        this.flight = null;
        this.lat = f.to.lat;
        this.lon = f.to.lon + f.drift;
        this.dist = f.to.dist;
        // Hand the smoothing filter its steady state rather than letting it
        // find it. The flight writes lon directly, so it arrives with the
        // target and the filter at rest; the drift then advances the target
        // and lon follows a time constant behind, which costs the first fifth
        // of a second of the turn. For a target moving at rate r the filter
        // settles exactly r * ROT_TAU behind it, so starting it there means
        // the very first frame after the flight already turns at full rate.
        if (f.spinInto && this.spin) {
          this.target.lon = this.lon + this.#driftRate() * ROT_TAU;
          this.quiet = SPIN_HANDOVER;
        } else {
          this.target.lon = this.lon;
        }
      }
    } else {
      this.target.lon += drift;
      if (!this.dragging) {
        const decay = Math.pow(0.0022, dt);
        this.target.lon += this.vel.lon * dt;
        this.target.lat = clamp(this.target.lat + this.vel.lat * dt, -LAT_LIMIT, LAT_LIMIT);
        this.vel.lon *= decay;
        this.vel.lat *= decay;
        if (Math.abs(this.vel.lon) < 0.02) this.vel.lon = 0;
        if (Math.abs(this.vel.lat) < 0.02) this.vel.lat = 0;
      }
      const kRot = 1 - Math.exp(-dt / ROT_TAU);
      const kZoom = 1 - Math.exp(-dt / ZOOM_TAU);
      this.lat += (this.target.lat - this.lat) * kRot;
      this.lon += wrapDelta(this.lon, this.target.lon) * kRot;
      this.dist += (this.target.dist - this.dist) * kZoom;
    }

    latLonToVec3(this.lat, this.lon, this.camDist, this.camera.position);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 0, 0);
    // The renderer would do this at draw time, which is after the labels have
    // already projected against it. One frame of stale view matrix is nothing
    // at a nudge and about ten degrees of longitude at the end of a throw:
    // every pin slides off its city, and stays there once the throw stops.
    this.camera.updateMatrixWorld();

    return `${this.lat.toFixed(5)}|${this.lon.toFixed(5)}|${this.dist.toFixed(6)}` !== before;
  }

  #arcLift(f) {
    if (!f.arc) return 0;
    const span = Math.hypot(
      wrapDelta(f.from.lon, f.to.lon) * Math.cos(((f.from.lat + f.to.lat) / 2) * DEG),
      f.to.lat - f.from.lat,
    );
    const closest = Math.min(f.from.dist, f.to.dist);
    return (
      f.arc *
      clamp((span / 180) * 2.6, 0, 1.5) *
      clamp((DIST_FAR - closest) / DIST_FAR, 0, 1)
    );
  }

  /**
   * Radians of arc between the view centre and a point, for label thinning.
   * The label layer calls this once per candidate place per frame, so the two
   * vectors are scratch rather than fresh — a pair of allocations here is a
   * few thousand a second and lands as collection pauses, not as time on any
   * one frame.
   */
  angleTo(lat, lon) {
    const a = latLonToVec3(this.lat, this.lon, 1, this.#angleA);
    const b = latLonToVec3(lat, lon, 1, this.#angleB);
    return Math.acos(clamp(a.dot(b), -1, 1)) * RAD;
  }
}
