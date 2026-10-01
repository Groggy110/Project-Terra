/**
 * Turns the panel into a bottom sheet with detents, on phones only.
 *
 * The rail on a desktop is a fixed box and wants to be: it sits beside the
 * globe and never moves. On a phone it sits *over* the globe, and a box that
 * covers 40% of the map and cannot be moved is the thing that makes a web page
 * feel like a web page. So here it gets the one interaction every iOS user
 * already knows: drag it, and it settles at one of three heights.
 *
 *   peek  — the summary line only. The map is the page.
 *   half  — summary plus the first two or three needs.
 *   full  — the list, with the body scrolling inside it.
 *
 * Two details do most of the work of making it feel right:
 *
 *   * Release velocity beats proximity. A short flick upward goes up even if
 *     you let go nearer the detent below, because that is what the gesture
 *     said. Snapping to whatever is closest makes a deliberate flick feel like
 *     it was ignored.
 *   * The body only scrolls at `full`, and a drag that starts inside it while
 *     it is already at the top pulls the sheet down instead. Otherwise the
 *     first downward swipe on a list scrolls nothing and the sheet ignores it,
 *     which reads as a dead gesture.
 */

/** Phone portrait. In landscape the panel is a rail again, so this stands down. */
const PHONE = "(max-width: 720px)";

/**
 * Peek is a px content height, not a fraction: it is "the summary card, whole",
 * and that is a fixed amount of type. The home-indicator inset is added in CSS,
 * because it is hardware rather than content and JS should not have to know how
 * tall the bottom of this particular phone is.
 */
const PEEK_PX = 220;
const HALF = 0.54;
const FULL = 0.88;

export class PanelSheet {
  constructor(root, { onDetent } = {}) {
    this.root = root;
    this.onDetent = onDetent;
    // Opens at a peek: the globe is the page, and a sheet that starts at half
    // height hands a map app's main view over to a list nobody asked for yet.
    this.detent = "peek";
    this.mq = window.matchMedia(PHONE);
    this.active = false;
    this.#bind();
    this.sync();
    this.mq.addEventListener("change", () => this.sync());
    window.addEventListener("resize", () => this.active && this.#apply(this.detent, false));
  }

  /** Heights in pixels for each detent, at the current viewport. */
  #heights() {
    const h = window.innerHeight;
    return { peek: PEEK_PX, half: Math.round(h * HALF), full: Math.round(h * FULL) };
  }

  sync() {
    const on = this.mq.matches;
    if (on === this.active) return;
    this.active = on;
    this.root.classList.toggle("is-sheet", on);
    if (on) this.#apply(this.detent, false);
    else {
      this.root.style.removeProperty("--sheet-h");
      this.root.classList.remove("is-full", "is-peek");
      document.documentElement.style.removeProperty("--sheet-lift");
      document.body.classList.remove("sheet-full");
    }
  }

  setDetent(name, animate = true) {
    if (!this.active) return;
    this.#apply(name, animate);
  }

  #apply(name, animate) {
    const px = this.#heights()[name];
    this.detent = name;
    this.root.classList.toggle("is-dragging", !animate);
    this.root.style.setProperty("--sheet-h", `${px}px`);
    // Only the tallest detent scrolls; below it the list is a preview and a
    // drag anywhere on it should move the sheet.
    this.root.classList.toggle("is-full", name === "full");
    this.root.classList.toggle("is-peek", name === "peek");
    this.#lift(px);
    document.body.classList.toggle("sheet-full", name === "full");
    if (!animate) requestAnimationFrame(() => this.root.classList.remove("is-dragging"));
    this.onDetent?.(name, px);
  }

  /**
   * How high the sheet's top edge is, published for anything that has to sit
   * on it. The filter row rides just above the sheet, and a row that only
   * caught up after the gesture ended would lag a finger by 400ms.
   */
  #lift(px) {
    document.documentElement.style.setProperty("--sheet-lift", `${Math.round(px)}px`);
  }

  #bind() {
    let startY = 0;
    let startH = 0;
    let lastY = 0;
    let lastT = 0;
    let vel = 0;
    let active = false;
    let fromBody = false;
    // A press that starts on a card or a button is a tap until it travels;
    // only then does it become the sheet's drag (and the tap is cancelled).
    let armed = false;
    let dragged = false;
    const SLOP = 7;

    const body = () => this.root.querySelector(".panel__body");

    const down = (e) => {
      if (!this.active || e.button > 0) return;
      const b = body();
      fromBody = !!b && b.contains(e.target);
      // A drag inside the list is the sheet's only when the list has nowhere
      // left to scroll up to.
      if (fromBody && !(this.detent !== "full" || b.scrollTop <= 0)) return;
      if (e.target.closest("input, select, textarea")) return;

      active = true;
      // Need cards are buttons, and they fill most of the list: refusing a
      // drag that starts on one left only the gaps between them to scroll by.
      armed = !!e.target.closest("button, a");
      dragged = false;
      startY = lastY = e.clientY;
      lastT = e.timeStamp;
      vel = 0;
      startH = parseFloat(getComputedStyle(this.root).getPropertyValue("--sheet-h")) || this.#heights()[this.detent];
      if (!armed) begin();
      window.addEventListener("pointermove", move, { passive: false });
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    };

    const begin = (y = startY) => {
      // Measured from where the drag took over, so the sheet does not jump
      // by the distance a tap is allowed to wander.
      startY = lastY = y;
      armed = false;
      dragged = true;
      this.root.classList.add("is-dragging");
      document.body.classList.add("sheet-dragging");
    };

    // The click that a drag ending on a card would otherwise deliver.
    const swallow = (e) => {
      e.stopPropagation();
      e.preventDefault();
    };

    /**
     * Ends the gesture and takes the window listeners back down.
     *
     * Both exits need this, and the handover exit used not to do it: bailing
     * out to let the list scroll left a live pointermove and pointerup bound
     * to the window, so the next gesture added a second pair and every event
     * ran twice. The doubled run recomputed velocity against a position it had
     * just written, so it always came out zero — and a sheet with no velocity
     * ignores a flick and settles on whatever detent happens to be nearest.
     */
    const release = () => {
      active = false;
      this.root.classList.remove("is-dragging");
      document.body.classList.remove("sheet-dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };

    const move = (e) => {
      if (!active) return;
      const dy = e.clientY - startY;
      if (armed) {
        if (Math.abs(dy) < SLOP) return;
        begin(e.clientY);
        return;
      }
      // Dragging down from inside the list only takes over once it is at the
      // top; past that the list would have scrolled, so let it.
      const b = body();
      if (fromBody && dy < 0 && this.detent === "full" && b) {
        release();
        return;
      }
      e.preventDefault();
      const dt = Math.max(e.timeStamp - lastT, 1);
      vel = (e.clientY - lastY) / dt; // px/ms, positive downward
      lastY = e.clientY;
      lastT = e.timeStamp;

      const max = this.#heights().full;
      let next = startH - dy;
      // Rubber band past the top rather than a hard stop.
      if (next > max) next = max + (next - max) * 0.22;
      const px = Math.max(64, next);
      this.root.style.setProperty("--sheet-h", `${px}px`);
      this.#lift(px);
    };

    const up = () => {
      if (!active) return;
      if (!dragged) return release();
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 400);
      const now = parseFloat(getComputedStyle(this.root).getPropertyValue("--sheet-h"));
      const hs = this.#heights();
      const order = ["peek", "half", "full"];
      let idx = order.indexOf(
        order.reduce((best, k) => (Math.abs(hs[k] - now) < Math.abs(hs[best] - now) ? k : best), "half"),
      );
      // A flick overrides proximity — see the note at the top of the file.
      if (vel < -0.45) idx = Math.min(idx + 1, 2);
      else if (vel > 0.45) idx = Math.max(idx - 1, 0);
      release();
      this.#apply(order[idx], true);
    };

    this.root.addEventListener("pointerdown", down);
  }
}
