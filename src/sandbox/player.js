/**
 * The transport: turns a config plus a time into a frame on screen.
 *
 * Two things are being driven, and they are driven very differently.
 *
 * The DOM tracks are easy - opacity and a transform, written inline, which
 * beats the stylesheet without touching it. `transform` rather than the
 * `translate` property, deliberately: the production CSS centres the hero and
 * the toasts with `translate:`, and writing that would shove them off-centre.
 *
 * The globe is not a DOM fade. It is driven by *wrapping* GlobeControls.update
 * for the life of the sandbox and, while a take is running, writing the camera
 * state straight into it before the original runs. That is the only honest way
 * to get frame-exact easing out of a controller whose whole design is
 * smoothed-toward-a-target: parking the camera and its target on the same
 * value each frame makes the smoothing a no-op, and the original still does
 * the lat/lon-to-position maths, so nothing is duplicated here.
 */
import { clamp, decelIntegral, lerp, resolveEasing, trackProgress } from "./anim.js";
import { DOM_TARGETS, globeDuration, timelineDuration } from "./config.js";
import { distForZoom } from "../globe/controls.js";

/** Inline properties the player owns; cleared wholesale on release. */
const OWNED = ["opacity", "transform", "filter", "transformOrigin"];

export class Player {
  constructor(app, { onTick } = {}) {
    this.app = app;
    this.onTick = onTick;
    this.cfg = null;
    this.time = 0;
    this.playing = false;
    this.armed = false; // has the player written anything to the page?
    this.raf = 0;
    this.last = 0;
    this.preroll = 0;
    this.touched = new Set();
    this.decel = { easing: null, fn: null };
    this.drive = { active: false, lat: 0, lon: 0, dist: 1, smooth: true };
    this.#patchControls();
  }

  /* --------------------------------------------------------------- wiring */

  /**
   * Installed once and left in place. Inert until `drive.active`, so the page
   * behaves exactly like production whenever a take is not running.
   */
  #patchControls() {
    const controls = this.app?.globe?.controls;
    if (!controls || controls.__sbxPatched) return;
    const original = controls.update.bind(controls);
    controls.__sbxPatched = true;

    controls.update = (dt) => {
      const drive = this.drive;
      if (!drive.active) return original(dt);

      // Take the camera off anything the page was doing with it, then park
      // both the camera and its target on our value so the easing in the
      // original has nothing left to do.
      controls.flight = null;
      controls.vel.lat = 0;
      controls.vel.lon = 0;
      controls.lat = drive.lat;
      controls.lon = drive.lon;
      controls.dist = drive.dist;
      controls.target.lat = drive.lat;
      controls.target.lon = drive.lon;
      controls.target.dist = drive.dist;

      original(dt);

      // `spinning` decides how the vector painter treats the frame: set, it
      // takes the idle-drift path and repaints at full resolution a few times
      // a second; clear, it takes the drag path and repaints coarse but often.
      // Neither is right for every take, so it is a setting.
      controls.spinning = drive.smooth ? false : true;
      // The original has nothing to report - we wrote the state ourselves -
      // but the renderer must treat the frame as moved or the labels freeze
      // over a turning globe.
      return true;
    };
  }

  /** True once the globe exists and the patch took. */
  get canDriveGlobe() {
    return !!this.app?.globe?.controls;
  }

  /* ---------------------------------------------------------------- state */

  setConfig(cfg) {
    this.cfg = cfg;
    if (this.decel.easing !== cfg.globe.stop.easing) {
      this.decel = { easing: cfg.globe.stop.easing, fn: decelIntegral(resolveEasing(cfg.globe.stop.easing)) };
    }
    this.drive.smooth = cfg.globe.quality === "smooth";
    if (this.armed) this.seek(Math.min(this.time, this.duration));
  }

  get duration() {
    return this.cfg ? timelineDuration(this.cfg) : 0;
  }

  /* -------------------------------------------------------------- control */

  play({ from = null } = {}) {
    if (!this.cfg) return;
    const start = from ?? (this.time >= this.duration - 1 ? 0 : this.time);
    this.arm();
    this.time = start;
    this.preroll = (this.cfg.stage.preroll || 0) * 1000;
    this.playing = true;
    this.last = performance.now();
    this.#loop();
    this.#report();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.preroll = 0;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.#report();
  }

  stop() {
    this.pause();
    this.seek(0);
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  seek(ms) {
    if (!this.cfg) return;
    this.arm();
    this.time = clamp(ms, 0, this.duration);
    this.applyAt(this.time);
    this.#report();
  }

  /** Puts the page under the player's control without starting the clock. */
  arm() {
    if (this.armed) return;
    this.armed = true;
    this.#patchControls(); // no-op if it already took, or if there is no globe
    const globe = this.app?.globe;
    if (globe) {
      // The page's own entrance would otherwise fight every take: its timers
      // strip the hero mid-shot and its settle flight steals the camera.
      clearTimeout(this.app.heroTimer);
      clearTimeout(this.app.heroInTimer);
      globe.controls.holdSpin(true);
      globe.controls.flight = null;
      this.drive.active = true;
    }
    this.applyAt(this.time);
  }

  /**
   * Hands the page back: the camera returns to the app, and every inline
   * property the player wrote is removed so the production stylesheet is once
   * again the only thing styling these elements.
   */
  release() {
    this.pause();
    this.armed = false;
    this.drive.active = false;
    for (const el of this.touched) {
      for (const prop of OWNED) el.style.removeProperty(prop);
      if (!el.getAttribute("style")) el.removeAttribute("style");
    }
    this.touched.clear();
    const globe = this.app?.globe;
    if (globe) {
      globe.controls.holdSpin(false);
      globe.dirty = true;
    }
    this.#report();
  }

  #loop = () => {
    if (!this.playing) return;
    this.raf = requestAnimationFrame(this.#loop);
    const now = performance.now();
    // Clamped, so a tab that was in the background does not jump the take
    // half a second forward on the frame it comes back.
    const dt = Math.min(now - this.last, 100);
    this.last = now;

    if (this.preroll > 0) {
      this.preroll -= dt;
      this.#report();
      return;
    }

    this.time += dt;
    const end = this.duration;
    if (this.time >= end) {
      if (this.cfg.stage.loop) {
        this.time = this.time % end;
      } else {
        this.time = end;
        this.playing = false;
        cancelAnimationFrame(this.raf);
        this.raf = 0;
      }
    }
    this.applyAt(this.time);
    this.#report();
  };

  #report() {
    this.onTick?.({
      time: this.time,
      duration: this.duration,
      playing: this.playing,
      preroll: Math.max(0, this.preroll),
      armed: this.armed,
    });
  }

  /* --------------------------------------------------------------- frames */

  /** The whole frame: every DOM track, then the camera. */
  applyAt(t) {
    const cfg = this.cfg;
    if (!cfg) return;

    for (const target of DOM_TARGETS) {
      const track = cfg.tracks[target.key];
      if (!track?.enabled) continue;
      const el = document.querySelector(target.sel);
      if (!el) continue;
      this.#applyTrack(el, track, t);
    }

    this.#applyGlobe(t);
  }

  #applyTrack(el, track, t) {
    const k = trackProgress(track, t, resolveEasing(track.easing));
    const { from, to } = track;
    const opacity = lerp(from.opacity, to.opacity, k);
    const x = lerp(from.x, to.x, k);
    const y = lerp(from.y, to.y, k);
    const scale = lerp(from.scale, to.scale, k);
    const blur = lerp(from.blur, to.blur, k);

    this.touched.add(el);
    el.style.setProperty("opacity", String(Math.round(opacity * 1000) / 1000), "important");
    const moved = x || y || scale !== 1;
    if (moved) el.style.setProperty("transform", `translate3d(${x}px, ${y}px, 0) scale(${scale})`, "important");
    else el.style.removeProperty("transform");
    if (blur > 0.01) el.style.setProperty("filter", `blur(${Math.round(blur * 100) / 100}px)`, "important");
    else el.style.removeProperty("filter");
  }

  /**
   * Rotation as a function of time rather than an accumulation, so scrubbing
   * to 2.4s lands exactly where playing to 2.4s does.
   *
   *   before the delay        nothing has happened
   *   during the spin         constant rate, so a straight line in angle
   *   during the slowdown     the integral of `rate * (1 - ease(u))`
   *   after it                the full swept angle, held
   */
  #applyGlobe(t) {
    const globe = this.app?.globe;
    if (!globe || !this.drive.active) return;
    const g = this.cfg.globe;

    const sweep = this.#sweep(t);
    this.drive.lat = g.camera.lat;
    this.drive.lon = g.camera.lon + sweep;
    this.drive.dist = distForZoom(this.#zoomAt(t));

    const canvas = globe.canvas;
    if (g.fade.enabled && canvas) this.#applyTrack(canvas, g.fade, t);
    globe.dirty = true;

    // Push it through the controller now rather than waiting for the globe's
    // own frame. A scrub should land on the frame you dragged to, not one
    // behind it, and it means anything reading controls.lat/lon straight after
    // a seek - the verify harness, the "use current view" button - sees the
    // state the player just computed rather than the previous frame's.
    globe.controls.update(0);
  }

  #sweep(t) {
    const { spin, stop } = this.cfg.globe;
    if (!spin.enabled || !spin.speed) return 0;
    const dir = spin.direction;
    const local = t - spin.delay;
    if (local <= 0) return 0;

    const cruise = Math.min(local, spin.duration) * spin.speed * dir / 1000;
    if (local <= spin.duration || stop.duration <= 0) return cruise;

    const u = clamp((local - spin.duration) / stop.duration, 0, 1);
    const fn = this.decel.fn || decelIntegral(resolveEasing(stop.easing));
    return cruise + (spin.speed * dir * stop.duration / 1000) * fn(u);
  }

  #zoomAt(t) {
    const { camera, zoom } = this.cfg.globe;
    if (!zoom.enabled) return camera.zoom;
    const k = trackProgress(zoom, t, resolveEasing(zoom.easing));
    return clamp(lerp(camera.zoom, zoom.to, k), 0, 1);
  }

  /* -------------------------------------------------------------- helpers */

  /** Total swept longitude of the current config, for the readout. */
  totalSweep() {
    return this.cfg ? this.#sweep(globeDuration(this.cfg) + 1) : 0;
  }

  /** Copies the live camera into the config's starting frame. */
  readCamera() {
    const c = this.app?.globe?.controls;
    if (!c) return null;
    // The live longitude runs away with the drift; fold it back into
    // -180..180 so the config reads like a place rather than a lap count.
    const lon = (((c.lon + 180) % 360) + 360) % 360 - 180;
    return {
      lat: Math.round(c.lat * 10) / 10,
      lon: Math.round(lon * 10) / 10,
      zoom: Math.round(c.zoom * 1000) / 1000,
    };
  }
}
