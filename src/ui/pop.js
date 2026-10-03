/**
 * Shared behaviour for the floating sheets — chip menus, the app menu and the
 * search suggestions. They all use the `.pop` surface; this is the part that
 * keeps them on screen, tells them when they are scrolled out, and drives the
 * app menu's keyboard model.
 */
import { h, svg, viewH } from "./dom.js";

const MARGIN = 12;

/**
 * A phone held upright. There a menu anchored under its button has nowhere to
 * go — the buttons are at the foot of the screen — so every menu becomes an
 * action sheet instead: full width, up from the bottom, over a scrim.
 */
export const PHONE = window.matchMedia("(max-width: 720px)");

/**
 * Mounts `menu` as a bottom sheet on the page itself. It has to leave the
 * element it was built in: a chip menu lives inside the filter row, which
 * scrolls sideways and so clips anything that hangs out of it. The scrim
 * takes the tap that would otherwise land on the globe; the menus' own
 * click-outside handlers do the closing.
 */
export function asSheet(menu) {
  const scrim = h("div", { class: "pop-scrim" });
  menu.classList.add("is-sheet");
  document.body.append(scrim, menu);
  menu.scrim = scrim;
  return menu;
}

/**
 * A chip menu is centred under its chip, which puts the outer chips partly off
 * screen. When that happens it stops being centred and takes an explicit
 * offset instead, so it slides along the row rather than off the edge.
 */
export function clampMenu(menu, anchor) {
  menu.classList.remove("is-pinned");
  menu.style.removeProperty("--pin-x");

  const a = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const wanted = a.left + a.width / 2 - w / 2;
  const limit = window.innerWidth - w - MARGIN;
  const put = Math.max(MARGIN, Math.min(wanted, limit));

  if (Math.abs(put - wanted) > 0.5) {
    menu.style.setProperty("--pin-x", `${Math.round(put - a.left)}px`);
    menu.classList.add("is-pinned");
  }

  // Never let the sheet run past the bottom of the window — and never let it
  // grow past the height the stylesheet asks for either. A 32-city list that
  // filled the window would swallow the globe it is meant to be filtering.
  // And where the row sits low in the window — on the landing screen it is
  // on the planet, well down the page — it opens upward instead whenever the
  // list would not fit below and there is more room above.
  const list = menu.querySelector(".pop__list");
  if (list) {
    menu.classList.remove("is-above");
    list.style.removeProperty("max-height");
    const chrome = menu.offsetHeight - list.offsetHeight;
    const cap = Math.min(340, viewH() * 0.46);
    const need = Math.min(cap, list.scrollHeight);
    const below = viewH() - a.bottom - 9 - chrome - MARGIN;
    const above = a.top - 9 - chrome - MARGIN;
    const up = below < need && above > below;
    menu.classList.toggle("is-above", up);
    const room = up ? above : below;
    list.style.maxHeight = `${Math.max(140, Math.round(Math.min(cap, room)))}px`;
    atEnd(list);
  }
}

/** Drops the bottom fade once there is nothing more to scroll to. */
export function watchScrollEnd(list) {
  const update = () => atEnd(list);
  list.addEventListener("scroll", update, { passive: true });
  requestAnimationFrame(update);
}

function atEnd(list) {
  const done = list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
  list.classList.toggle("is-atEnd", done);
}

/**
 * The `...` menu. Anchored under its button, dismissed by a click outside,
 * Escape or a choice, and walkable with the arrow keys.
 *
 * `items` are `{ label, note, icon, kbd, badge, danger, run }`, with `null` for a rule.
 */
export function openPop({ anchor, items, parent = document.body, id = "appMenu" }) {
  const existing = document.getElementById(id);
  if (existing) {
    existing.dispose();
    return null;
  }

  const rows = [];
  const menu = h("div", { class: "appmenu pop", id, role: "menu" });

  for (const item of items) {
    if (!item) {
      menu.appendChild(h("div", { class: "pop__sep" }));
      continue;
    }
    const row = h(
      "button",
      {
        class: `opt${item.danger ? " opt--danger" : ""}`,
        role: "menuitem",
        onclick: () => {
          close();
          item.run();
        },
      },
      item.icon ? item.icon() : null,
      h(
        "span",
        { class: "opt__label" },
        item.label,
        item.note ? h("span", { class: "opt__note", text: item.note }) : null,
      ),
      item.badge ? h("span", { class: "opt__badge", text: item.badge }) : null,
      item.kbd ? h("span", { class: "opt__kbd", text: item.kbd }) : null,
    );
    rows.push(row);
    menu.appendChild(row);
  }

  if (PHONE.matches) {
    asSheet(menu);
  } else {
    parent.appendChild(menu);
    // Right-aligned to the button, then pulled back inside the window.
    const a = anchor.getBoundingClientRect();
    const w = menu.offsetWidth;
    const left = Math.max(MARGIN, Math.min(a.right - w, window.innerWidth - w - MARGIN));
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(a.bottom + 9)}px`;
  }

  let cursor = -1;
  const keys = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      anchor.focus?.({ preventScroll: true });
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      cursor = (cursor + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
      rows.forEach((r, i) => r.classList.toggle("is-cursor", i === cursor));
      rows[cursor].focus({ preventScroll: true });
    }
  };

  const away = (e) => {
    if (menu.contains(e.target) || anchor.contains(e.target)) return;
    close();
  };

  function close() {
    menu.remove();
    menu.scrim?.remove();
    document.removeEventListener("pointerdown", away);
    window.removeEventListener("keydown", keys, true);
    window.removeEventListener("resize", close);
  }

  menu.dispose = close;
  setTimeout(() => document.addEventListener("pointerdown", away), 0);
  window.addEventListener("keydown", keys, true);
  window.addEventListener("resize", close);
  return menu;
}

/** Icon set used only by the app menu. */
const opt = (inner) => svg("0 0 16 16", inner, "opt__ico");

export const menuIcons = {
  info: () => opt('<circle cx="8" cy="8" r="6.2"/><path d="M8 7.4v4"/><circle cx="8" cy="4.9" r=".85" class="ico__solid"/>'),
  board: () => opt('<rect x="2.2" y="3" width="11.6" height="10" rx="1.8"/><path d="M2.2 6.4h11.6M6.4 6.4V13"/>'),
  panel: () => opt('<rect x="2.2" y="3" width="11.6" height="10" rx="1.8"/><path d="M10 3v10"/>'),
  theme: () => opt('<circle cx="8" cy="8" r="5.6"/><path d="M8 2.4a5.6 5.6 0 0 0 0 11.2z" class="ico__fill"/>'),
  reset: () => opt('<path d="M13.2 6.9A4.9 4.9 0 1 0 13.6 10"/><path d="M13.6 3.8v3.2h-3.2"/>'),
  locate: () => opt('<path d="M13.4 2.6 2.6 7.1l4.5 1.8 1.8 4.5Z"/>'),
  inbox: () => opt('<path d="M2.4 9.2 4 3.6h8l1.6 5.6v3.2H2.4z"/><path d="M2.4 9.2h3.4l.8 1.4h2.8l.8-1.4h3.4"/>'),
  trash: () => opt('<path d="M3.4 4.6h9.2M6.4 4.6V3.4h3.2v1.2M4.6 4.6l.7 8h5.4l.7-8"/>'),
};
