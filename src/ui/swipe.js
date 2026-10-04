/**
 * Pull a phone sheet down by its top edge to close it.
 *
 * Only a drag that *starts* in the top strip of the sheet — the handle and the
 * header — is the sheet's. Everywhere below it a finger scrolls the content
 * exactly as it always did, so a list can be flicked through without the
 * sheet ever twitching. Touch events rather than pointer events because the
 * page has to say no to the scroll the moment the drag is claimed, and only a
 * non-passive touchmove can do that on iOS; a pointer stream would be
 * cancelled by the browser's own pan first.
 *
 * Let go far enough down, or flick, and it slides off and `onClose` runs;
 * otherwise it springs back. A tap in the strip (the close button lives
 * there) is still a tap until it travels.
 */

const PHONE = window.matchMedia("(max-width: 720px)");
/** Height of the grab strip, from the sheet's top edge. */
const ZONE = 64;
const SLOP = 6;
const SPRING = "transform 0.32s cubic-bezier(0.32, 0.72, 0, 1)";

export function pullToClose(el, { onClose, scrim = null, zone = ZONE } = {}) {
  let startY = 0;
  let lastY = 0;
  let lastT = 0;
  let vel = 0;
  let armed = false;
  let dragging = false;

  const scrimOf = () => (typeof scrim === "function" ? scrim() : scrim);
  const at = (dy) => {
    el.style.transform = `translate3d(0, ${dy}px, 0)`;
    const s = scrimOf();
    if (s) s.style.opacity = String(Math.max(0, 1 - dy / Math.max(el.offsetHeight, 1)));
  };
  const reset = () => {
    el.style.transition = "";
    el.style.transform = "";
    const s = scrimOf();
    if (s) {
      s.style.transition = "";
      s.style.opacity = "";
    }
  };

  const start = (e) => {
    if (!PHONE.matches || e.touches.length !== 1) return;
    if (e.target.closest?.("input, textarea, select")) return;
    const top = el.getBoundingClientRect().top;
    const y = e.touches[0].clientY;
    if (y - top > zone) return;
    armed = true;
    dragging = false;
    startY = lastY = y;
    lastT = e.timeStamp;
    vel = 0;
  };

  const move = (e) => {
    if (!armed) return;
    const y = e.touches[0].clientY;
    const dy = y - startY;
    if (!dragging) {
      if (Math.abs(dy) < SLOP) return;
      // Upward from the strip is a scroll of whatever is under it.
      if (dy < 0) {
        armed = false;
        return;
      }
      dragging = true;
      el.classList.add("is-dragging");
      el.style.transition = "none";
      const s = scrimOf();
      if (s) s.style.transition = "none";
    }
    e.preventDefault();
    const dt = Math.max(e.timeStamp - lastT, 1);
    vel = (y - lastY) / dt;
    lastY = y;
    lastT = e.timeStamp;
    // A little give upward, none past it.
    at(dy > 0 ? dy : dy * 0.2);
  };

  const end = () => {
    if (!armed) return;
    armed = false;
    if (!dragging) return;
    dragging = false;
    el.classList.remove("is-dragging");
    // The tap the lifted finger would otherwise deliver to whatever is under it.
    const swallow = (e) => {
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 400);

    const dy = lastY - startY;
    const h = el.offsetHeight;
    if (dy > Math.min(140, h * 0.28) || (vel > 0.5 && dy > 24)) {
      el.style.transition = "transform 0.24s cubic-bezier(0.4, 0, 1, 1)";
      at(h + 40);
      const s = scrimOf();
      if (s) {
        s.style.transition = "opacity 0.24s ease";
        s.style.opacity = "0";
      }
      setTimeout(() => {
        onClose?.();
        // Whatever reopens this element starts from where its own CSS says.
        setTimeout(reset, 520);
      }, 230);
    } else {
      el.style.transition = SPRING;
      el.style.transform = "";
      const s = scrimOf();
      if (s) {
        s.style.transition = "opacity 0.3s ease";
        s.style.opacity = "";
      }
      setTimeout(() => {
        if (!dragging) el.style.transition = "";
      }, 340);
    }
  };

  el.addEventListener("touchstart", start, { passive: true });
  el.addEventListener("touchmove", move, { passive: false });
  el.addEventListener("touchend", end);
  el.addEventListener("touchcancel", end);
}
