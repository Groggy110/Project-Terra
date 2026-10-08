/**
 * The needs board: a sheet that rises from the bottom edge, draggable by its
 * grip, showing every need the current filters leave standing.
 *
 * Two columns. On the left, the categories — kind of help, urgency, focus
 * area, region — each with a count; on the right, the needs as one quiet row
 * apiece. The categories are the same query the filter chips and the globe
 * read, not a second filter of the board's own, so choosing "Advisory" here
 * also dims every pin with no advisory need, and the chips agree when the
 * board is put away.
 */
import { clear, h, nf, plural } from "./dom.js";
import { emptyState } from "./cards.js";
import { queryIsEmpty } from "../data/network.js";
import { FOCUS_AREAS, NEED_TYPES, REGIONS, TYPE_BY_ID, URGENCIES } from "../data/taxonomy.js";

const SORTS = [
  { id: "pressing", label: "Most pressing" },
  { id: "newest", label: "Newest" },
  { id: "people", label: "Most people" },
];

/** The sidebar's groups, in the order a volunteer narrows by. */
const GROUPS = [
  { key: "types", label: "Kind of help", options: NEED_TYPES, field: "type" },
  { key: "urgencies", label: "Urgency", options: URGENCIES, field: "urgency" },
  { key: "focus", label: "Focus area", options: FOCUS_AREAS, field: "focus" },
  { key: "regions", label: "Region", options: REGIONS, field: "region" },
];
const KEYS = GROUPS.map((g) => g.key);

export class Board {
  constructor(root, { net, on }) {
    this.root = root;
    this.net = net;
    this.on = on;
    this.sort = "pressing";
    this.open = false;
    this.query = null;
    this.#build();
  }

  #build() {
    this.grip = h("div", { class: "sheet__grip", "aria-hidden": "true" });
    this.title = h("div", { class: "sheet__title", text: "Open needs" });
    this.sub = h("div", { class: "sheet__sub" });
    this.side = h("nav", { class: "bd__side scroll", "aria-label": "Categories" });
    this.heading = h("div", { class: "bd__heading" });
    this.active = h("div", { class: "bd__active" });
    this.sortEl = h("div", { class: "sort" });
    this.list = h("div", { class: "bd__list" });
    this.main = h("div", { class: "bd__main scroll" },
      h("div", { class: "bd__bar" }, this.heading, this.sortEl),
      this.active,
      this.list,
    );

    this.root.append(
      this.grip,
      h(
        "div",
        { class: "sheet__head" },
        h("div", { class: "sheet__titles" }, this.title, this.sub),
        h(
          "div",
          { class: "sheet__tools" },
          // Duplicated by the "+" in the top bar on a phone. See board.css.
          h("button", { class: "btn btn--accent sheet__post", onclick: () => this.on.postNeed() }, "Post a need"),
        ),
        h(
          "button",
          { class: "btn btn--icon sheet__close", "aria-label": "Close the board", onclick: () => this.setOpen(false) },
          h("span", { html: '<svg viewBox="0 0 16 16" class="ico"><path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/></svg>' }),
        ),
      ),
      h("div", { class: "bd" }, this.side, this.main),
    );

    this.#renderSort();
    this.#dragging();
  }

  #renderSort() {
    clear(this.sortEl);
    for (const s of SORTS) {
      this.sortEl.appendChild(
        h(
          "button",
          {
            class: `sort__btn${this.sort === s.id ? " is-on" : ""}`,
            onclick: () => {
              this.sort = s.id;
              this.#renderSort();
              this.render(this.query);
            },
          },
          s.label,
        ),
      );
    }
  }

  /** The grip drags the sheet; a short flick either way settles it. */
  #dragging() {
    let startY = 0;
    let offset = 0;
    let active = false;

    const move = (e) => {
      if (!active) return;
      offset = Math.max(0, e.clientY - startY);
      this.root.style.translate = `-50% ${offset}px`;
    };
    const end = () => {
      if (!active) return;
      active = false;
      this.root.classList.remove("is-dragging");
      this.root.style.translate = "";
      if (offset > this.root.offsetHeight * 0.28) this.setOpen(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };

    this.grip.addEventListener("pointerdown", (e) => {
      active = true;
      startY = e.clientY;
      offset = 0;
      this.root.classList.add("is-dragging");
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
    });
  }

  setOpen(open) {
    this.open = open;
    cancelAnimationFrame(this.raising);
    if (!open) {
      this.root.classList.remove("is-up");
      this.on.boardToggled?.(false);
      return;
    }
    // The app's query, not the one last rendered: it is replaced whenever the
    // filters are cleared, and the board may have been shut at the time.
    this.render(this.on.query?.() ?? this.query);
    // The cards are laid out on a frame of their own, while the sheet is
    // still out of sight, and it starts to rise on the frame after. Raised
    // in the same task, the layout of every card landed in the slide's first
    // frame — fifty milliseconds, at the fastest part of an ease-out — and
    // the sheet jumped before it glided. The page's own moves (the planet's
    // lift, the chrome) go with the sheet, not ahead of it.
    this.raising = requestAnimationFrame(() => {
      this.raising = requestAnimationFrame(() => {
        if (!this.open) return;
        this.root.classList.add("is-up");
        this.on.boardToggled?.(true);
      });
    });
  }

  toggle() {
    this.setOpen(!this.open);
  }

  /* ------------------------------------------------------------ filtering */

  /**
   * One category per group: choosing one replaces what the group had, and
   * choosing the one already on clears it. The chips allow several, and a
   * query they built still shows here — every selected row is lit.
   */
  #pick(key, id) {
    const set = this.query[key];
    const only = set.size === 1 && set.has(id);
    set.clear();
    if (!only) set.add(id);
    this.on.queryChanged();
  }

  #clear(keys) {
    for (const k of keys) this.query[k].clear();
    if (keys.includes("text")) this.query.text = "";
    this.on.queryChanged();
  }

  /** How many needs a category would show: the query with its own group lifted. */
  #counts(key, field) {
    const q = { ...this.query, [key]: new Set() };
    const counts = new Map();
    for (const n of this.net.select(q)) counts.set(n[field], (counts.get(n[field]) ?? 0) + 1);
    return counts;
  }

  #renderSide() {
    const q = this.query;
    const none = KEYS.every((k) => !q[k].size);
    const row = ({ label, count, on, onClick, dot }) =>
      h("button", { class: `bd__cat${on ? " is-on" : ""}`, type: "button", "aria-pressed": on ? "true" : "false", onclick: onClick },
        dot ? h("span", { class: `dot dot--${dot}` }) : null,
        h("span", { class: "bd__cat-label", text: label }),
        h("span", { class: "bd__cat-n", text: nf.format(count) }),
      );

    const all = this.net.select({ ...q, ...Object.fromEntries(KEYS.map((k) => [k, new Set()])) }).length;
    const blocks = [
      h("div", { class: "bd__group" },
        row({ label: "All needs", count: all, on: none, onClick: () => this.#clear(KEYS) }),
      ),
    ];
    for (const g of GROUPS) {
      const counts = this.#counts(g.key, g.field);
      // A category with nothing in it is only a dead end; it stays listed
      // while selected, so it can still be switched off.
      const shown = g.options.filter((o) => counts.get(o.id) || q[g.key].has(o.id));
      if (!shown.length) continue;
      blocks.push(
        h("div", { class: "bd__group" },
          h("div", { class: "bd__group-label", text: g.label }),
          shown.map((o) =>
            row({
              label: o.label,
              count: counts.get(o.id) ?? 0,
              on: q[g.key].has(o.id),
              dot: g.key === "urgencies" ? o.id : null,
              onClick: () => this.#pick(g.key, o.id),
            }),
          ),
        ),
      );
    }
    this.side.replaceChildren(...blocks);
  }

  /**
   * What is narrowing the list that the sidebar does not show — a search, or
   * a city picked on the map — so nothing filters it invisibly.
   */
  #renderActive() {
    const q = this.query;
    const pills = [];
    if (q.text) pills.push({ label: `“${q.text}”`, clear: ["text"] });
    for (const id of q.locations) {
      const m = this.net.ministryById.get(id);
      pills.push({ label: m ? m.city : "A location", clear: null, id });
    }
    this.active.replaceChildren(
      ...pills.map((p) =>
        h("button", {
          class: "bd__pill",
          type: "button",
          onclick: () => {
            if (p.clear) return this.#clear(p.clear);
            q.locations.delete(p.id);
            this.on.queryChanged();
          },
        }, p.label, h("span", { class: "bd__pill-x", "aria-hidden": "true", text: "×" })),
      ),
    );
    this.active.hidden = !pills.length;
  }

  /* -------------------------------------------------------------- render */

  render(query) {
    this.query = query;
    const filtered = query && !queryIsEmpty(query);
    const needs = this.net.sortBy(filtered ? this.net.select(query) : this.net.needs, this.sort);
    const total = this.net.stats();

    this.sub.textContent = `${nf.format(total.needs)} across ${plural(total.ministries, "ministry", "ministries")} · ${nf.format(total.urgent)} urgent`;
    if (!query) return;

    this.#renderSide();
    this.#renderActive();

    const picked = GROUPS.flatMap((g) => g.options.filter((o) => query[g.key].has(o.id)).map((o) => o.label));
    this.heading.replaceChildren(
      h("b", { text: picked.length ? picked.join(" · ") : "All needs" }),
      h("span", { text: plural(needs.length, "need", "needs") }),
    );

    clear(this.list);
    if (!needs.length) {
      this.list.appendChild(
        emptyState("Nothing here yet", "No open needs match these categories. Try another, or see them all.", {
          label: "Show all needs",
          onClick: () => this.#clear([...KEYS, "text", "locations"]),
        }),
      );
      return;
    }
    for (const need of needs) this.list.appendChild(needRow(need, () => this.on.openNeed(need)));
  }
}

/**
 * One need, one row: what it is and who asks, then the kind of help and how
 * many people. Only "urgent" is marked at all, because it is the one that
 * should change what you do next; the sidebar sorts out the rest.
 */
function needRow(need, onOpen) {
  const kind = TYPE_BY_ID.get(need.type)?.label ?? need.type;
  return h(
    "button",
    { class: `bd__row${need.taken ? " is-taken" : ""}`, type: "button", dataset: { need: need.id }, onclick: onOpen },
    h("span", { class: "bd__row-main" },
      h("span", { class: "bd__row-title", text: need.title }),
      h("span", { class: "bd__row-meta", text: [need.ministryName, need.city].filter(Boolean).join(" · ") }),
    ),
    h("span", { class: "bd__row-side" },
      need.taken ? h("span", { class: "bd__tag is-taken", text: "Picked up" }) : null,
      need.urgency === "urgent" && !need.taken ? h("span", { class: "bd__tag is-urgent", text: "Urgent" }) : null,
      h("span", { class: "bd__kind", text: kind }),
      need.people ? h("span", { class: "bd__people", text: plural(need.people, "person", "people") }) : null,
    ),
    h("span", { class: "bd__chev", html: '<svg viewBox="0 0 16 16" class="ico"><path d="M6.4 3.6 10.8 8l-4.4 4.4"/></svg>' }),
  );
}
