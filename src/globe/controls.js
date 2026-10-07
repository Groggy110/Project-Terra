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
 * The zoom ladder runs from maxDist, the whole globe, to minDist, 1.014 —
 * about ninety kilometres up, a city and the country it sits in. `zoom` is
 * the log of the distance normalised over that span, so moving either end
 * rescales the whole ladder; in logs the moves are small, and every threshold
 * keyed off zoom() is written as a smoothstep wide enough to absorb them.
 * The camera itself goes on past the ladder's end, down to camera.closeDist —
 * street level — with zoom() reading 1 the whole way (closest()).
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
/** The camera's true close stop: closeDist, never further out than minDist. */
const closest = () => Math.min(cam().closeDist ?? cam().minDist, cam().minDist);
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

/**
 * What is left of a finger's throw after one second. A mouse drag wants to
 * stop close to where it let go; a flick on glass is expected to glide, and
 * at the mouse's friction the planet stopped in a sixth of a second, as if
 * the flick had been caught. This is a glide of about a quarter-second
 * longer.
 */
const TOUCH_THROW_DECAY = 0.03;

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

  constructor(dom, camera, { onFirstGesture, onDoubleClick } = {}) {
    this.dom = dom;
    this.camera = camera;
    this.onFirstGesture = onFirstGesture;
    /** Offered a double-click's ground point first; true means it was taken. */
    this.onDoubleClick = onDoubleClick;

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
    return this.fitted(this.dist);
  }

  /**
   * A semantic distance after the portrait fit. The withdrawal scales the
   * *altitude*, not the distance from the centre: from orbit the two are
   * nearly the same thing, but at the close stop the old product put a phone
   * a whole Earth radius up — the fit doubled 1.014 into 2.04 — so a phone
   * could never come down to a city at all. Scaling the height above the
   * ground keeps the whole-globe framing and gives the close stop back.
   */
  /** The semantic distance whose fitted() is `real`. */
  unfitted(real) {
    let lo = 1;
    let hi = Math.max(real, 1 + 1e-9);
    for (let i = 0; i < 48; i++) {
      const mid = (lo + hi) / 2;
      if (this.fitted(mid) < real) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  fitted(dist) {
    // The portrait withdrawal is about framing the whole planet; near the
    // ground there is no planet to frame, and kept on it would hold a phone
    // two and a half times higher than a desktop at the same zoom. It eases
    // off below the city stop, and is gone by street level.
    const alt = dist - 1;
    const city = cam().minDist - 1;
    const keep = smoothstep(city * 0.02, city, alt);
    return 1 + alt * (1 + (this.fit - 1) * keep);
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
    // Moves and releases are heard on the window, not the canvas: a touch
    // that began on a pin is implicitly captured by the pin, so the canvas
    // never hears the rest of it. Only pointers this took hold of count.
    window.addEventListener("pointermove", this.#move, { passive: false });
    window.addEventListener("pointerup", this.#up);
    window.addEventListener("pointercancel", this.#up);
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

  /**
   * A gesture that began on something laid over the globe — a pin, a city
   * plate — and belongs to it all the same. Not captured to the canvas: the
   * pin keeps the pointer, so a tap still arrives at the pin as a click.
   */
  grab(e) {
    this.#down(e, false);
  }

  #down = (e, capture = true) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if (this.pointers.has(e.pointerId)) return;
    this.quiet = 0;
    if (capture) this.dom.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp });
    this.downX = e.clientX;
    this.downY = e.clientY;
    if (this.pointers.size === 1) this.downT = e.timeStamp;
    this.#takeOver();
    this.moved = false;
    if (this.pointers.size === 1) {
      this.dragging = true;
      this.vel.lat = 0;
      this.vel.lon = 0;
      this.dom.classList.add("is-dragging");
      this.#doubleTap(e);
      if (e.pointerType === "touch" && !this.anchor) this.#dragAnchor(e.clientX, e.clientY);
    } else if (this.pointers.size === 2) {
      // A second finger turns the drag into a pinch, and whatever the first
      // finger was throwing is not what the hand means any more.
      this.pinch = this.#spread();
      this.vel.lat = 0;
      this.vel.lon = 0;
      this.#pinchAnchor();
    }
  };

  /**
   * Two quick taps in the same place zoom in on it, halfway, the way every
   * map on a phone does. A browser only turns taps into dblclick when it is
   * allowed to own the gesture, and this canvas is touch-action: none.
   */
  #doubleTap(e) {
    if (e.pointerType !== "touch") return;
    // The first half has to have been a *tap* — short, and still. Counting
    // any touch-down made two quick flicks in a row a double-tap, and the
    // second flick zoomed in instead of turning the globe.
    const last = this.lastTap;
    this.lastTap = null;
    if (!last || e.timeStamp - last.t > 300 || Math.hypot(e.clientX - last.x, e.clientY - last.y) > 32) return;
    this.#note();
    const at = this.pointAt(e);
    if (at && this.onDoubleClick?.(at)) {
      // The second tap's finger is still down: it must not turn into a drag.
      this.anchor = null;
      return;
    }
    this.#zoomTo(this.#scaled(this.target.dist, 0.5), e);
    // The second tap's finger is still down, which counts as a drag; the
    // zoom must hold its point through it all the same.
    if (this.anchor) this.anchor.tap = true;
  }

  /**
   * A finger on the globe takes hold of the ground under it, and for the rest
   * of the drag that point is solved to stay under the finger — exactly, at
   * the limb as well as the centre. Turning by a fixed degrees-per-pixel only
   * holds at the middle of the disc; toward the edge the sphere foreshortens
   * and the ground slid out from under the thumb. Off the disc, in space,
   * there is nothing to hold and the drag falls back to that rate.
   */
  #dragAnchor(clientX, clientY) {
    const hit = this.#firmGround(clientX, clientY, 0.3);
    this.anchor = hit ? { ...hit, drag: true } : null;
    this.dragPrev = null;
  }

  /**
   * The ground under a screen point, if it faces the camera by at least
   * `facing` (the cosine between the ground's normal and the view). Near the
   * limb the sphere is foreshortened to nothing, and holding ground there
   * means a pixel of finger swings the planet by degrees; past `facing` the
   * drag lets go of it and turns at the plain rate instead.
   */
  #firmGround(clientX, clientY, facing) {
    const rect = this.rect;
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.ndc.set(x, y);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hit = this.raycaster.ray.intersectSphere(this.sphere, this.hit);
    if (!hit) return null;
    const toCam = this.#probe.copy(this.camera.position).sub(hit).normalize();
    if (hit.dot(toCam) < facing) return null;
    return { p: hit.clone(), x, y, sx: x, sy: y };
  }

  /**
   * Picks the ground point between the two fingers. For the rest of the
   * pinch that point is held under their midpoint: spreading zooms on it,
   * and moving both fingers together carries it, which is a two-finger pan.
   */
  #pinchAnchor() {
    const [a, b] = [...this.pointers.values()];
    const rect = this.rect;
    const x = (((a.x + b.x) / 2 - rect.left) / rect.width) * 2 - 1;
    const y = -(((a.y + b.y) / 2 - rect.top) / rect.height) * 2 + 1;
    this.ndc.set(x, y);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hit = this.raycaster.ray.intersectSphere(this.sphere, this.hit);
    this.anchor = hit ? { p: hit.clone(), x, y, pinch: true } : null;
  }

  #move = (e) => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    let dx = e.clientX - prev.x;
    let dy = e.clientY - prev.y;
    const since = Math.max((e.timeStamp - prev.t) / 1000, 1 / 240);
    prev.x = e.clientX;
    prev.y = e.clientY;
    prev.t = e.timeStamp;

    if (this.pointers.size >= 2) {
      const spread = this.#spread();
      if (this.pinch > 0 && spread > 0) {
        const [a, b] = [...this.pointers.values()];
        this.#note();
        this.moved = true;
        const from = this.target.dist;
        this.target.dist = this.#scaled(from, this.pinch / spread);
        this.pinch = spread;
        // How fast the height is changing, in e-folds a second, for the
        // glide after the fingers come off.
        const rate = Math.log((this.target.dist - 1) / Math.max(from - 1, 1e-6)) / since;
        this.zoomVel = (this.zoomVel ?? 0) * 0.5 + rate * 0.5;
        this.lastPinch = e.timeStamp;
        const rect = this.rect;
        if (this.anchor?.pinch) {
          this.anchor.x = (((a.x + b.x) / 2 - rect.left) / rect.width) * 2 - 1;
          this.anchor.y = -(((a.y + b.y) / 2 - rect.top) / rect.height) * 2 + 1;
        } else {
          // Began off the limb, in space: pick the ground up as soon as the
          // fingers are over some.
          this.#pinchAnchor();
        }
      }
      return;
    }

    if (!this.dragging) return;
    if (e.pointerType === "touch" && !this.anchor?.tap) {
      if (this.anchor?.drag) {
        // Still over firm ground? Near the limb, let go and turn at the rate.
        const rect = this.rect;
        const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        if (this.#firmGround(e.clientX, e.clientY, 0.18)) {
          if (Math.abs(e.clientX - this.downX) + Math.abs(e.clientY - this.downY) > 3) {
            this.moved = true;
            this.#note();
          }
          this.anchor.x = x;
          this.anchor.y = y;
          this.lastMove = e.timeStamp;
          return;
        }
        this.anchor = null;
        this.target.lat = this.lat;
        this.target.lon = this.lon;
      } else if (!this.anchor && this.#firmGround(e.clientX, e.clientY, 0.3)) {
        // Back over the disc from space, or in from the limb: take hold again.
        this.#dragAnchor(e.clientX, e.clientY);
        this.lastMove = e.timeStamp;
        return;
      }
    }
    // With the view rolled, a screen drag is rotated back into the unrolled
    // frame, so the ground still follows the cursor.
    const roll = camRoll();
    if (roll) {
      const c = Math.cos(roll);
      const s = Math.sin(roll);
      [dx, dy] = [dx * c + dy * s, -dx * s + dy * c];
    }
    // Click slop, measured from where the button went down: a click that
    // wobbles a few pixels is still a click. Counted per event, one uneven
    // 3px move turned it into a drag, and a click on the landing planet
    // then left the stage without its camera move.
    if (Math.hypot(e.clientX - this.downX, e.clientY - this.downY) > 5) {
      this.moved = true;
      this.#note();
    }

    const ppd = Math.max(this.pxPerDeg, 0.4) / mo().rotateSpeed;
    const cosLat = Math.max(Math.cos(this.target.lat * DEG), 0.35);
    const dLon = -dx / (ppd * cosLat);
    const dLat = dy / ppd;

    this.target.lon += dLon;
    this.target.lat = clamp(this.target.lat + dLat, -cam().latLimit, cam().latLimit);
    // Velocity in degrees per second, for the throw — from the events' own
    // clock, since a 120Hz screen delivers twice the events a 60Hz one does
    // and a fixed per-event factor threw half as far on it. Lightly smoothed:
    // one uneven event should not decide where the globe is flung.
    const k = 0.6;
    this.vel.lon = this.vel.lon * (1 - k) + (dLon / since) * k;
    this.vel.lat = this.vel.lat * (1 - k) + (dLat / since) * k;
    this.lastMove = e.timeStamp;
  };

  #up = (e) => {
    if (!this.pointers.has(e.pointerId)) return;
    const wasPinch = this.pointers.size >= 2;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = 0;
    if (wasPinch && this.pointers.size < 2) {
      // The pinch is over. What is left of the zoom lands on the camera now
      // rather than easing off-centre, and the finger still down — if one is
      // — carries on as a drag from exactly here.
      this.dist = this.target.dist;
      if (this.anchor) {
        this.anchor.sx = this.anchor.x;
        this.anchor.sy = this.anchor.y;
        this.#holdAnchor(this.dist);
      }
      this.vel.lat = 0;
      this.vel.lon = 0;
      this.lastMove = 0;
      // Unless the fingers were still spreading as they lifted: then the zoom
      // carries on a little, round the same point, and eases to a stop — the
      // way a flick carries a drag. A pinch that had come to rest does not.
      const v = this.zoomVel ?? 0;
      this.zoomVel = 0;
      if (this.anchor && e.timeStamp - (this.lastPinch ?? 0) < 80 && Math.abs(v) > 0.4) {
        this.target.dist = this.#scaled(this.dist, Math.exp(clamp(v, -6, 6) * 0.16));
        this.anchor.pinch = false;
        this.anchor.tap = true;
        this.gliding = true;
        return this.#release(e);
      }
      this.anchor = null;
      // The finger still down takes hold of the ground where it is.
      const rest = [...this.pointers.values()][0];
      if (rest && e.pointerType === "touch") {
        this.downX = rest.x;
        this.downY = rest.y;
        this.#dragAnchor(rest.x, rest.y);
      }
    }
    this.#release(e);
  };

  #release(e) {
    if (this.pointers.size === 0 && e.pointerType === "touch") {
      const still = Math.hypot(e.clientX - this.downX, e.clientY - this.downY) < 10;
      this.lastTap = still && e.timeStamp - this.downT < 250 && !this.gliding
        ? { x: e.clientX, y: e.clientY, t: e.timeStamp }
        : null;
    }
    this.gliding = false;
    if (this.pointers.size === 0) {
      this.dragging = false;
      this.dom.classList.remove("is-dragging");
      this.throwTouch = e.pointerType === "touch";
      // Let go of the ground; what the hand was doing carries on as a throw.
      if (this.anchor?.drag) this.anchor = null;
      // A finger that stopped and then lifted meant "here", not "throw".
      if (e.timeStamp - (this.lastMove ?? 0) > 90) {
        this.vel.lat = 0;
        this.vel.lon = 0;
      }
    }
  }

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
    const next = this.#scaled(this.target.dist, Math.exp(clamp(step, -260, 260) * mo().zoomSpeed));
    this.#zoomTo(next, e);
  };

  /** The wheel handler, for layers stacked over the canvas to forward to. */
  wheel(e) {
    this.#wheel(e);
  }

  /**
   * In onto the point that was double-clicked: to the city stop from further
   * out, and from there two map levels at a time, as a slippy map steps.
   */
  #dbl = (e) => {
    const at = this.pointAt(e);
    if (at && this.onDoubleClick?.(at)) return;
    const alt = this.target.dist - 1;
    const city = cam().minDist - 1;
    this.flyTo({
      lat: at?.lat ?? this.target.lat,
      lon: at?.lon ?? this.target.lon,
      dist: 1 + (alt > city * 1.05 ? city : alt / 4),
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
    const to = clamp(next, closest(), cam().maxDist);
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
    const ppd = Math.max(pixelsPerDegree(this.fitted(dist), h, camera.fov), 0.4);
    for (let i = 0; i < 6; i++) {
      latLonToVec3(this.lat, this.lon, this.fitted(dist), camera.position);
      camera.up.set(0, 1, 0);
      camera.lookAt(0, 0, 0);
      if (camRoll()) camera.rotateZ(camRoll());
      camera.updateMatrixWorld();
      // Round the back of the globe from here: head straight for it instead.
      // Visible means p·camera > 1, and the margin over 1 has to shrink with
      // the height: a fixed 1.001 is the horizon from six kilometres up, so
      // below that *every* point read as round the back, and each zoom notch
      // swung the view half way to the cursor — the lurch sideways when
      // zooming out from street level.
      if (a.p.dot(camera.position) < 1 + Math.min(0.001, (this.fitted(dist) - 1) * 0.02)) {
        const at = vec3ToLatLon(a.p);
        this.lat = clamp(this.lat + (at.lat - this.lat) * 0.5, -cam().latLimit, cam().latLimit);
        this.lon += wrapDelta(this.lon, at.lon) * 0.5;
        continue;
      }
      const q = this.#probe.copy(a.p).project(camera);
      const ex = (((a.sx ?? a.x) - q.x) * w) / 2;
      const ey = (-((a.sy ?? a.y) - q.y) * h) / 2;
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
    this.target.dist = this.#scaled(from, factor);
  }

  /**
   * `dist` zoomed by `factor` — every zoom goes through here: pinch, wheel,
   * double-tap, the buttons and the glide after a pinch.
   *
   * The factor scales the height above the ground, not the distance from the
   * centre of the Earth. From orbit the two are the same thing; near the
   * surface they are not remotely: at the close stop the distance is 1.014,
   * so a pinch that took one percent off it took seventy percent off the
   * altitude, and the last stretch of every zoom shot in. Scaled on the
   * height, the ground grows exactly with the fingers at every altitude.
   *
   * On top of that, a curve: a touch quicker far out, where there is a lot
   * of empty distance to cover, and a gentle brake over the final approach,
   * so the stop is arrived at rather than hit.
   */
  #scaled(dist, factor) {
    const floor = closest() - 1;
    const alt = Math.max(dist - 1, floor);
    let e = 1 + 0.25 * smoothstep(1.2, 3, alt);
    if (factor < 1) e *= 1 - 0.45 * (1 - smoothstep(floor, floor * 7, alt));
    return clamp(1 + alt * Math.pow(factor, e), closest(), cam().maxDist);
  }

  /**
   * `silent` is for the entrance flight, which the camera runs on its own:
   * counting it as a gesture would retire the hint and the hero before the
   * globe had finished arriving.
   */
  /**
   * `rise`, when given, replaces the arc: the camera's height is lifted by
   * that many e-folds at the middle of the flight (in logs, so it reads the
   * same at street level as from orbit) — up far enough to keep both ends in
   * view, across, and back down.
   *
   * `turn`, when given, is the degrees of longitude to travel instead of the
   * shortest way round, so a flight can go the long way and be seen to spin
   * the planet on its way to somewhere already near.
   */
  flyTo({ lat, lon, dist, ms = 1200, silent = false, arc = 1, rise = 0, turn, spinInto = false, ease = "cubic" } = {}) {
    if (!silent) this.#note();
    else this.quiet = 0;
    const to = {
      lat: clamp(lat ?? this.target.lat, -cam().latLimit, cam().latLimit),
      lon: this.lon + (Number.isFinite(turn) ? turn : wrapDelta(this.lon, lon ?? this.target.lon)),
      dist: clamp(dist ?? this.target.dist, closest(), cam().maxDist),
    };
    this.vel.lat = 0;
    this.vel.lon = 0;
    this.flight = {
      from: { lat: this.lat, lon: this.lon, dist: this.dist },
      to,
      t: 0,
      ms: Math.max(ms, 1),
      arc: rise ? 0 : arc,
      rise,
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
    // The floor is past the zoom fade as well: the stage's camera sits close
    // enough that the fade had all but stopped it.
    const floor = this.spinFloor ?? 0;
    const fade = 1 - smoothstep(m.spinFadeStart, m.spinFadeEnd, this.zoom);
    if (fade <= 0 && !floor) return 0;
    // spinFloor, degrees a second: the landing stage frames the disc so large
    // that the pixel-based rate comes out at a fraction of a degree, and the
    // planet looked parked. There it turns at least this fast.
    const rate = Math.max(Math.min(m.spinPx / Math.max(this.pxPerDeg, 1e-3), m.spinMax) * fade, floor);
    return rate * (m.direction < 0 ? -1 : 1);
  }

  /** Advances the easing; returns true when the camera actually moved. */
  update(dt) {
    const before = `${this.lat.toFixed(5)}|${this.lon.toFixed(5)}|${this.dist.toFixed(6)}`;
    const drift = this.path ? 0 : this.#drift(dt);
    this.spinning = drift !== 0;

    if (this.path) {
      // A camera path — the style editor's animation timeline — owns the view
      // outright while it plays: no flight, drift, throw or held anchor. It
      // is sampled here, on the globe's own frame, so the view and everything
      // projected from it agree on every frame.
      const p = this.path();
      this.flight = null;
      this.anchor = null;
      this.vel.lat = this.vel.lon = 0;
      this.quiet = 0;
      this.lat = clamp(p.lat, -cam().latLimit, cam().latLimit);
      this.lon += wrapDelta(this.lon, p.lon);
      this.dist = clamp(p.dist, closest(), cam().maxDist + 1.4);
      this.target = { lat: this.lat, lon: this.lon, dist: this.dist };
    } else if (this.flight) {
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
      // At full rate from the first frame, not weighted up with the flight:
      // the planet is already turning when the flight begins (the landing
      // stage turns it), and a weight starting at zero stopped it dead and
      // started it again — the jolt at the start of the move.
      // The landing stage's faster turn (spinFloor) hands over across the
      // flight too, easing down to the working view's own rate by the end,
      // so the speed never steps.
      if (f.spinInto && this.spin) {
        if (f.floor === undefined) f.floor = this.spinFloor ?? 0;
        this.spinFloor = f.floor * (1 - k);
        f.drift += this.#driftRate() * dt;
      }
      this.lat = f.from.lat + (f.to.lat - f.from.lat) * k;
      this.lon = f.from.lon + (f.to.lon - f.from.lon) * k + f.drift;
      // Below the ladder's close end the height is eased in logs: from ninety
      // kilometres to four hundred metres is a factor of two hundred, and a
      // straight line would cover all of it in the last few frames.
      const lo = Math.min(f.from.dist, f.to.dist) - 1;
      const deep = lo < cam().minDist - 1;
      // The height eases on its own, smoother curve when the flight rises:
      // up and down without a pause at the top.
      const kd = f.rise ? f.ease(f.t / f.ms) : k;
      let d = deep || f.rise
        ? 1 + Math.exp(Math.log(f.from.dist - 1) + (Math.log(f.to.dist - 1) - Math.log(f.from.dist - 1)) * kd)
        : f.from.dist + (f.to.dist - f.from.dist) * k;
      if (f.rise) d = 1 + (d - 1) * Math.exp(f.rise * Math.sin(Math.PI * (f.t / f.ms)));
      this.dist = clamp(d + arc, closest(), cam().maxDist + 1.4);
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
        const decay = Math.pow(this.throwTouch ? TOUCH_THROW_DECAY : mo().throwDecay, dt);
        this.target.lon += this.vel.lon * dt;
        this.target.lat = clamp(this.target.lat + this.vel.lat * dt, -cam().latLimit, cam().latLimit);
        this.vel.lon *= decay;
        this.vel.lat *= decay;
        if (Math.abs(this.vel.lon) < 0.02) this.vel.lon = 0;
        if (Math.abs(this.vel.lat) < 0.02) this.vel.lat = 0;
      }
      const kRot = 1 - Math.exp(-dt / mo().rotateDamping);
      const kZoom = 1 - Math.exp(-dt / mo().zoomDamping);
      // A pinch is followed exactly: the fingers are the smoothing, and a
      // camera trailing them by a time constant feels like pulling on rubber.
      const pinching = this.pointers.size >= 2;
      // Fingers are followed within a frame, not snapped to. Touches arrive
      // on their own clock, not the display's, so a frame sometimes gets two
      // moves and the next none; snapped, that is a judder in every drag. A
      // time constant of 18ms irons it out for about a frame of lag.
      const kTouch = 1 - Math.exp(-dt / 0.018);
      this.dist = pinching ? this.dist + (this.target.dist - this.dist) * kTouch : this.dist + (this.target.dist - this.dist) * kZoom;
      const a = this.anchor;
      if (a && (a.drag || a.pinch)) {
        a.sx = (a.sx ?? a.x) + (a.x - (a.sx ?? a.x)) * kTouch;
        a.sy = (a.sy ?? a.y) + (a.y - (a.sy ?? a.y)) * kTouch;
      } else if (a) {
        a.sx = a.x;
        a.sy = a.y;
      }
      if (this.anchor && (!this.dragging || pinching || this.anchor.tap || this.anchor.drag)) {
        // While a zoom holds a point, the centre is not eased toward a target
        // but solved from the distance, so the point stays on its pixel on
        // every frame of the zoom rather than only once it settles.
        this.#holdAnchor(this.dist);
        if (this.anchor.drag) {
          // The throw's velocity, from how the camera actually moved while
          // the ground was held — degrees a second, lightly smoothed.
          const prev = this.dragPrev;
          if (prev && dt > 0) {
            const k = 0.5;
            this.vel.lon = this.vel.lon * (1 - k) + (wrapDelta(prev.lon, this.lon) / dt) * k;
            this.vel.lat = this.vel.lat * (1 - k) + ((this.lat - prev.lat) / dt) * k;
          }
          this.dragPrev = { lat: this.lat, lon: this.lon };
        } else if (!pinching && Math.abs(this.target.dist - this.dist) < 1e-6) this.anchor = null;
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
