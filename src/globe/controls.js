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
import { STYLE } from "../style/styleConfig.js";

/*
 * Every number that shapes the camera — the zoom ladder's two ends, the idle
 * drift, the smoothing and the wheel — lives in STYLE.camera and STYLE.motion
 * and is read live, so a restyle takes effect on the next frame.
 *
 * The close stop, camera.minDist, is a *height*, not a distance: 1.014 frames
 * about ninety kilometres — a city and the country it sits in, which is as
 * close as a *globe* has any business going. `zoom` is the log of the distance
 * normalised over minDist..maxDist, so moving either end rescales the whole
 * ladder; in logs the moves are small, and every threshold keyed off zoom() is
 * written as a smoothstep wide enough to absorb them.
 *
 * The drift rate is set in *pixels of ground per second*, not degrees: a
 * degree is worth twice as much screen at the working view as it is at the
 * whole globe, and a fixed angular rate that reads as a slow turn from far off
 * reads as a pan you cannot read over the top of once you have come in.
 *
 * The zoom smoothing sits a shade softer than the rotation's: a distance that
 * snaps reads as the ground jumping at you, where a turn that snaps just reads
 * as quick. The wheel's gain is applied in the exponent, so a notch is worth
 * the same *proportion* of the remaining approach at every zoom.
 */
const cam = () => STYLE.camera;
const mo = () => STYLE.motion;

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
const spinHandover = () => mo().spinResume + 1;
/** The view's roll, in radians. */
const camRoll = () => (cam().roll || 0) * DEG;

/** 0 at the whole-globe view, 1 at the closest zoom. */
export function zoomLevel(dist) {
  const { minDist, maxDist } = cam();
  const t = Math.log(dist / maxDist) / Math.log(minDist / maxDist);
  return clamp(t, 0, 1);
}

export function distForZoom(z) {
  const { minDist, maxDist } = cam();
  return maxDist * Math.pow(minDist / maxDist, clamp(z, 0, 1));
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
  #probe;
  #rect = null;

  constructor(dom, camera, { onFirstGesture } = {}) {
    this.dom = dom;
    this.camera = camera;
    this.onFirstGesture = onFirstGesture;

    this.lat = cam().home.lat;
    this.lon = cam().home.lon;
    this.dist = cam().maxDist;
    this.target = { lat: this.lat, lon: this.lon, dist: this.dist };

    this.vel = { lat: 0, lon: 0 };
    this.dragging = false;
    this.reduced = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    this.spinWanted = true;
    this.spinHeld = false;
    this.spinning = false;
    this.quiet = mo().spinResume;
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
    this.#probe = new Vector3();
    /**
     * The ground point a zoom is holding under the cursor, and the screen
     * position (NDC) it is held at. Set by the wheel and the pinch, cleared by
     * anything else that takes the camera; see #holdAnchor.
     */
    this.anchor = null;

    this.#bind();
  }

  get pxPerDeg() {
    return pixelsPerDegree(this.camDist, this.viewport.h, this.camera.fov);
  }

  get zoom() {
    return zoomLevel(this.dist);
  }

  /** Whether the drift may run at all: wanted, allowed, and switched on in STYLE. */
  get spin() {
    return this.spinWanted && !this.reduced && mo().autoRotate;
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
    // the semantic zoom, minDist..maxDist is untouched, and every threshold
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
    this.anchor = null;
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
    let dx = e.clientX - prev.x;
    let dy = e.clientY - prev.y;
    prev.x = e.clientX;
    prev.y = e.clientY;

    if (this.pointers.size >= 2) {
      const spread = this.#spread();
      if (this.pinch > 0 && spread > 0) {
        const [a, b] = [...this.pointers.values()];
        this.#zoomTo(this.target.dist * (this.pinch / spread), { clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
        this.pinch = spread;
      }
      return;
    }

    if (!this.dragging) return;
    // With the view rolled, a screen drag is rotated back into the unrolled
    // frame, so the ground still follows the cursor.
    const roll = camRoll();
    if (roll) {
      const c = Math.cos(roll);
      const s = Math.sin(roll);
      [dx, dy] = [dx * c + dy * s, -dx * s + dy * c];
    }
    if (Math.abs(dx) + Math.abs(dy) > 2) {
      this.moved = true;
      this.#note();
    }

    const ppd = Math.max(this.pxPerDeg, 0.4) / mo().rotateSpeed;
    const cosLat = Math.max(Math.cos(this.target.lat * DEG), 0.35);
    const dLon = -dx / (ppd * cosLat);
    const dLat = dy / ppd;

    this.target.lon += dLon;
    this.target.lat = clamp(this.target.lat + dLat, -cam().latLimit, cam().latLimit);
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
    // Not #takeOver: that would drop the anchor a scroll is still holding,
    // and each notch of one gesture has to keep the same ground point.
    this.flight = null;
    this.vel.lat = 0;
    this.vel.lon = 0;
    const step = e.deltaMode === 1 ? e.deltaY * 18 : e.deltaY;
    const next = this.target.dist * Math.exp(clamp(step, -260, 260) * mo().zoomSpeed);
    this.#zoomTo(next, e);
  };

  /** The wheel handler, for layers stacked over the canvas to forward to. */
  wheel(e) {
    this.#wheel(e);
  }

  /** All the way in, onto the point that was double-clicked. */
  #dbl = (e) => {
    const at = this.pointAt(e);
    this.flyTo({
      lat: at?.lat ?? this.target.lat,
      lon: at?.lon ?? this.target.lon,
      dist: cam().minDist,
      ms: 1100,
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
   * Zooming holds the ground under the cursor, exactly: the point the cursor
   * is over is pinned to that pixel, and every frame of the zoom solves for
   * the view centre that keeps it there (#holdAnchor).
   *
   * It used to pull the centre toward the point by the fraction of the
   * height the zoom removed. That is right only at the middle of the screen
   * and at small steps; off-centre, and on a sphere that foreshortens toward
   * the limb, the ground slid out from under the cursor — you aimed at a city
   * and arrived beside it.
   *
   * The point is taken from the camera as it is drawn, not from the target,
   * because what is under the cursor on screen is what was aimed at.
   */
  #zoomTo(next, event) {
    const from = this.target.dist;
    const to = clamp(next, cam().minDist, cam().maxDist);
    this.target.dist = to;
    if (!event || to === from) return;

    const rect = this.rect;
    const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    // Same cursor, same gesture: keep the ground point already held, or it
    // would be re-picked every notch from a camera still easing and creep.
    const a = this.anchor;
    if (a && Math.abs(a.x - x) < 1e-3 && Math.abs(a.y - y) < 1e-3) return;

    this.ndc.set(x, y);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hit = this.raycaster.ray.intersectSphere(this.sphere, this.hit);
    this.anchor = hit ? { p: hit.clone(), x, y } : null;
  }

  /**
   * Moves lat/lon so the anchor projects to its pixel with the camera at
   * `dist`. A few rounds of: project, measure the miss in pixels, and turn
   * the globe by that many pixels the way a drag would. The drag's scale is
   * exact at the centre and too generous toward the limb, so it converges
   * from one side and never overshoots.
   */
  #holdAnchor(dist) {
    const a = this.anchor;
    // Not `cam`: that is the module's STYLE.camera reader, which the latitude
    // clamp below still needs.
    const camera = this.camera;
    const { w, h } = this.viewport;
    const ppd = Math.max(pixelsPerDegree(dist * this.fit, h, camera.fov), 0.4);
    for (let i = 0; i < 6; i++) {
      latLonToVec3(this.lat, this.lon, dist * this.fit, camera.position);
      camera.up.set(0, 1, 0);
      camera.lookAt(0, 0, 0);
      if (camRoll()) camera.rotateZ(camRoll());
      camera.updateMatrixWorld();
      // Round the back of the globe from here: head straight for it instead.
      // (Visible means p·camera > 1: the cap shrinks to ~10° at the closest zoom.)
      if (a.p.dot(camera.position) < 1.001) {
        const at = vec3ToLatLon(a.p);
        this.lat = clamp(this.lat + (at.lat - this.lat) * 0.5, -cam().latLimit, cam().latLimit);
        this.lon += wrapDelta(this.lon, at.lon) * 0.5;
        continue;
      }
      const q = this.#probe.copy(a.p).project(camera);
      const ex = ((a.x - q.x) * w) / 2;
      const ey = (-(a.y - q.y) * h) / 2;
      if (Math.abs(ex) + Math.abs(ey) < 0.05) break;
      this.lon -= ex / (ppd * Math.max(Math.cos(this.lat * DEG), 0.35));
      this.lat = clamp(this.lat + ey / ppd, -cam().latLimit, cam().latLimit);
    }
    this.target.lat = this.lat;
    this.target.lon = this.lon;
  }

  /* ---------------------------------------------------------------- moves */

  zoomBy(factor) {
    this.#note();
    const from = this.target.dist;
    this.#takeOver();
    this.target.dist = clamp(from * factor, cam().minDist, cam().maxDist);
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
      lat: clamp(lat ?? this.target.lat, -cam().latLimit, cam().latLimit),
      lon: this.lon + wrapDelta(this.lon, lon ?? this.target.lon),
      dist: clamp(dist ?? this.target.dist, cam().minDist, cam().maxDist),
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
    const { home, maxDist } = cam();
    this.flyTo({ lat: home.lat, lon: home.lon, dist: maxDist, ms });
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
    const resume = mo().spinResume;
    if (this.quiet < resume) return 0;
    // Not while a throw is still running out: the two would compound, and the
    // throw would never appear to settle.
    if (this.vel.lon || this.vel.lat) return 0;
    // Eased in over the first second so the drift starts rather than snaps.
    return this.#driftRate() * smoothstep(resume, resume + 1, this.quiet) * dt;
  }

  /**
   * Degrees a second the drift wants at this zoom, before any of the gates.
   * Separate from #drift because a spinInto flight needs the rate while the
   * gates are all still shut against it.
   */
  #driftRate() {
    const m = mo();
    const fade = 1 - smoothstep(m.spinFadeStart, m.spinFadeEnd, this.zoom);
    if (fade <= 0) return 0;
    return Math.min(m.spinPx / Math.max(this.pxPerDeg, 1e-3), m.spinMax) * fade * (m.direction < 0 ? -1 : 1);
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
      this.dist = clamp(f.from.dist + (f.to.dist - f.from.dist) * k + arc, cam().minDist, cam().maxDist + 1.4);
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
        // settles exactly r * rotateDamping behind it, so starting it there means
        // the very first frame after the flight already turns at full rate.
        if (f.spinInto && this.spin) {
          this.target.lon = this.lon + this.#driftRate() * mo().rotateDamping;
          this.quiet = spinHandover();
        } else {
          this.target.lon = this.lon;
        }
      }
    } else {
      this.target.lon += drift;
      if (!this.dragging) {
        const decay = Math.pow(mo().throwDecay, dt);
        this.target.lon += this.vel.lon * dt;
        this.target.lat = clamp(this.target.lat + this.vel.lat * dt, -cam().latLimit, cam().latLimit);
        this.vel.lon *= decay;
        this.vel.lat *= decay;
        if (Math.abs(this.vel.lon) < 0.02) this.vel.lon = 0;
        if (Math.abs(this.vel.lat) < 0.02) this.vel.lat = 0;
      }
      const kRot = 1 - Math.exp(-dt / mo().rotateDamping);
      const kZoom = 1 - Math.exp(-dt / mo().zoomDamping);
      this.dist += (this.target.dist - this.dist) * kZoom;
      if (this.anchor && !this.dragging) {
        // While a zoom holds a point, the centre is not eased toward a target
        // but solved from the distance, so the point stays on its pixel on
        // every frame of the zoom rather than only once it settles.
        this.#holdAnchor(this.dist);
        if (Math.abs(this.target.dist - this.dist) < 1e-6) this.anchor = null;
      } else {
        this.lat += (this.target.lat - this.lat) * kRot;
        this.lon += wrapDelta(this.lon, this.target.lon) * kRot;
      }
    }

    latLonToVec3(this.lat, this.lon, this.camDist, this.camera.position);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 0, 0);
    // Roll about the view axis, after north-up is established, so every
    // projection built from the camera — picking, labels, the halo — agrees.
    if (camRoll()) this.camera.rotateZ(camRoll());
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
      clamp((cam().maxDist - closest) / cam().maxDist, 0, 1)
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
