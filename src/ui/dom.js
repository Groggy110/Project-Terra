/** Small DOM helpers. Everything in the UI is built with h(). */

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === "class") el.className = value;
      else if (key === "text") el.textContent = value;
      else if (key === "html") el.innerHTML = value;
      else if (key === "style") Object.assign(el.style, value);
      else if (key === "dataset") Object.assign(el.dataset, value);
      else if (key.startsWith("on")) el.addEventListener(key.slice(2).toLowerCase(), value);
      else el.setAttribute(key, value === true ? "" : value);
    }
  }
  add(el, kids);
  return el;
}

export function add(parent, kids) {
  for (const kid of kids.flat(4)) {
    if (kid == null || kid === false) continue;
    parent.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return parent;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function svg(viewBox, inner, cls = "ico") {
  const el = document.createElementNS(SVG_NS, "svg");
  el.setAttribute("viewBox", viewBox);
  el.setAttribute("aria-hidden", "true");
  el.setAttribute("class", cls);
  el.innerHTML = inner;
  return el;
}

export const icons = {
  close: () => svg("0 0 16 16", '<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>'),
  plus: () => svg("0 0 16 16", '<path d="M8 3.2v9.6M3.2 8h9.6"/>'),
  check: () => svg("0 0 16 16", '<path d="M3.4 8.6l3 3 6.2-7"/>'),
  back: () => svg("0 0 16 16", '<path d="M9.4 3.6 5 8l4.4 4.4"/>'),
  arrow: () => svg("0 0 16 16", '<path d="M3.4 8h9.2M9 4.4 12.6 8 9 11.6"/>'),
  edit: () => svg("0 0 16 16", '<path d="M10.6 3.2l2.2 2.2-7.3 7.3-2.8.6.6-2.8z"/>'),
  pin: () =>
    svg(
      "0 0 16 16",
      '<path d="M8 14.2s4.6-4.3 4.6-7.6a4.6 4.6 0 1 0-9.2 0C3.4 9.9 8 14.2 8 14.2Z"/><circle cx="8" cy="6.5" r="1.7"/>',
    ),
  hand: () => svg("0 0 16 16", '<path d="M5 8.6V4.2a1.2 1.2 0 0 1 2.4 0v3.2m0 0V3a1.2 1.2 0 0 1 2.4 0v4.6m0 0V4.6a1.2 1.2 0 0 1 2.4 0v5.2c0 2.4-1.7 4.2-4.2 4.2S5 12.2 5 9.8L3.6 8.4"/>'),
};

/* ------------------------------------------------------------ formatting */

export const nf = new Intl.NumberFormat("en-GB");

export const plural = (n, one, many = `${one}s`) => `${nf.format(n)} ${n === 1 ? one : many}`;

const DAY = 86400000;

/** "3 days ago" / "last week" - deliberately vague past a fortnight. */
export function since(dateStr, now = Date.now()) {
  const then = Date.parse(dateStr);
  if (Number.isNaN(then)) return "";
  const days = Math.max(0, Math.round((now - then) / DAY));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 9) return `${weeks} weeks ago`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}

export const joinDot = (...parts) => parts.filter(Boolean).join(" · ");

/**
 * The app's height. Normally the window's; in an installed iOS app that
 * reports a short window, the stretched body's (see index.html, base.css).
 */
export const viewH = () => document.body?.clientHeight || window.innerHeight;
