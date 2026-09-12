/**
 * The needs board: a sheet that rises from the bottom edge, draggable by its
 * grip, showing every need the current filters leave standing.
 */
import { clear, h, nf, plural } from "./dom.js";
import { emptyState, needCard } from "./cards.js";
import { queryIsEmpty } from "../data/network.js";

const SORTS = [
  { id: "pressing", label: "Most pressing" },
  { id: "newest", label: "Newest" },
  { id: "people", label: "Most people" },
];

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
    this.title = h("div", { class: "sheet__title", text: "Open needs board" });
    this.sub = h("div", { class: "sheet__sub" });
    this.sortEl = h("div", { class: "sort" });
    this.body = h("div", { class: "sheet__body scroll" });
    this.grid = h("div", { class: "board" });
    this.body.appendChild(this.grid);

    this.root.append(
      this.grip,
      h(
        "div",
        { class: "sheet__head" },
        h("div", {}, this.title, this.sub),
        h(
          "div",
          { class: "sheet__tools" },
          this.sortEl,
          h("button", { class: "btn btn--accent", onclick: () => this.on.postNeed() }, "Post a need"),
          h(
            "button",
            { class: "btn btn--icon", "aria-label": "Close the board", onclick: () => this.setOpen(false) },
            h("span", { html: '<svg viewBox="0 0 16 16" class="ico"><path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/></svg>' }),
          ),
        ),
      ),
      this.body,
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
    this.root.classList.toggle("is-up", open);
    if (open) this.render(this.query);
    this.on.boardToggled?.(open);
  }

  toggle() {
    this.setOpen(!this.open);
  }

  render(query) {
    this.query = query;
    const filtered = query && !queryIsEmpty(query);
    const needs = this.net.sortBy(filtered ? this.net.select(query) : this.net.needs, this.sort);
    const stats = this.net.stats(needs);

    this.sub.textContent = [
      `${nf.format(stats.needs)} need${stats.needs === 1 ? "" : "s"}`,
      `${nf.format(stats.urgent)} urgent`,
      `${nf.format(stats.people)} people wanted`,
      plural(stats.ministries, "ministry", "ministries"),
      filtered ? "filtered" : null,
    ]
      .filter(Boolean)
      .join(" · ");

    clear(this.grid);
    if (!needs.length) {
      this.grid.appendChild(
        emptyState(
          "No needs match",
          "Every filter is still applied. Clear them to see all 65 open needs across the network.",
          { label: "Clear filters", onClick: () => this.on.clearFilters() },
        ),
      );
      return;
    }
    for (const need of needs) {
      this.grid.appendChild(needCard(need, { onOpen: (n) => this.on.openNeed(n), full: true }));
    }
  }
}
