/**
 * The five filter chips. Option counts are computed with that chip's own
 * dimension removed, so a count answers "how many would I get if I picked
 * this", not "how many are showing now".
 *
 * The menu is a multi-select, so picking an option leaves it open — "Done"
 * closes it, and so do Escape, a click outside, or opening another chip.
 */
import { clear, h, icons, nf, svg } from "./dom.js";
import { FOCUS_AREAS, NEED_TYPES, REGIONS, URGENCIES } from "../data/taxonomy.js";
import { clampMenu, watchScrollEnd } from "./pop.js";

const CARET = () => svg("0 0 12 12", '<path d="M2.4 4.6 6 8.2l3.6-3.6"/>', "chip__caret");

export class Filters {
  constructor(root, { net, query, onChange }) {
    this.root = root;
    this.net = net;
    this.query = query;
    this.onChange = onChange;
    this.openChip = null;

    document.addEventListener("pointerdown", (e) => {
      if (this.openChip && !this.openChip.el.contains(e.target)) this.#closeMenus();
    });
    window.addEventListener("keydown", (e) => this.#keys(e));
    window.addEventListener("resize", () => this.#closeMenus());

    this.render();
  }

  /** Rebuilt whenever the option set changes — a posted need adds a location. */
  #buildGroups() {
    this.groups = [
      { key: "types", label: "Need type", options: NEED_TYPES, field: "type" },
      { key: "urgencies", label: "Urgency", options: URGENCIES, field: "urgency" },
      { key: "focus", label: "Focus area", options: FOCUS_AREAS, field: "focus" },
      { key: "regions", label: "Region", options: REGIONS, field: "region" },
      {
        key: "locations",
        label: "Location",
        field: "ministry",
        options: [...this.net.ministries]
          .sort((a, b) => a.city.localeCompare(b.city))
          .map((m) => ({ id: m.id, label: m.city, note: m.country })),
      },
    ];
  }

  render() {
    const reopen = this.openChip?.group.key ?? null;
    this.#closeMenus();
    this.#buildGroups();
    clear(this.root);
    this.chips = this.groups.map((g) => this.#chip(g));
    for (const c of this.chips) this.root.appendChild(c.el);
    if (reopen) {
      const chip = this.chips.find((c) => c.group.key === reopen);
      if (chip) this.#openMenu(chip);
    }
  }

  #closeMenus() {
    if (!this.openChip) return;
    this.openChip.el.classList.remove("is-open");
    this.openChip.menu?.remove();
    this.openChip.menu = null;
    this.openChip.rows = null;
    this.openChip = null;
    this.cursor = -1;
  }

  #chip(group) {
    const selected = this.query[group.key];
    const chip = { group, menu: null };
    const count = selected.size;

    const btn = h(
      "button",
      {
        class: "chip__btn",
        "aria-haspopup": "listbox",
        "aria-expanded": "false",
        onclick: (e) => {
          e.stopPropagation();
          const wasOpen = this.openChip?.group === group;
          this.#closeMenus();
          if (!wasOpen) this.#openMenu(chip);
        },
      },
      group.label,
      count ? h("span", { class: "chip__count", text: String(count) }) : null,
      CARET(),
    );

    chip.btn = btn;
    chip.el = h("div", { class: `chip${count ? " is-set" : ""}` }, btn);
    return chip;
  }

  /** Needs that would match if `id` were the only value chosen for this chip. */
  #countFor(group, id) {
    const probe = {
      types: new Set(this.query.types),
      urgencies: new Set(this.query.urgencies),
      focus: new Set(this.query.focus),
      regions: new Set(this.query.regions),
      locations: new Set(this.query.locations),
      text: this.query.text,
    };
    probe[group.key] = new Set([id]);
    return this.net.select(probe).length;
  }

  #openMenu(chip) {
    const { group } = chip;
    const selected = this.query[group.key];

    const list = h("div", { class: "pop__list scroll", role: "listbox", "aria-multiselectable": "true" });
    const rows = [];

    for (const option of group.options) {
      const count = this.#countFor(group, option.id);
      const row = h(
        "button",
        {
          class: "opt",
          role: "option",
          onclick: () => this.#toggle(chip, option, row),
        },
        h("span", { class: "opt__tick" }, icons.check()),
        h(
          "span",
          { class: "opt__label" },
          option.label,
          option.note ? h("span", { class: "opt__note", text: option.note }) : null,
        ),
        h("span", { class: "opt__n", text: nf.format(count) }),
      );
      row.dataset.id = option.id;
      row.dataset.count = String(count);
      rows.push(row);
      list.appendChild(row);
    }

    const clearBtn = h(
      "button",
      {
        class: "pop__link",
        onclick: () => {
          if (!selected.size) return;
          selected.clear();
          this.#sync(chip);
          this.onChange();
        },
      },
      "Clear",
    );

    const menu = h(
      "div",
      { class: "chip__menu pop", onpointerdown: (e) => e.stopPropagation() },
      h("div", { class: "pop__head" }, group.label, h("span", { class: "pop__count" })),
      list,
      h(
        "div",
        { class: "pop__foot" },
        clearBtn,
        h("span", { class: "spacer" }),
        h("button", { class: "pop__done", onclick: () => this.#closeMenus() }, "Done"),
      ),
    );

    chip.el.classList.add("is-open");
    chip.btn.setAttribute("aria-expanded", "true");
    chip.el.appendChild(menu);
    chip.menu = menu;
    chip.rows = rows;
    chip.clearBtn = clearBtn;
    chip.countEl = menu.querySelector(".pop__count");
    this.openChip = chip;
    this.cursor = -1;

    this.#sync(chip, { quiet: true });
    watchScrollEnd(list);
    clampMenu(menu, chip.el);
  }

  #toggle(chip, option, row) {
    const selected = this.query[chip.group.key];
    if (selected.has(option.id)) selected.delete(option.id);
    else selected.add(option.id);
    this.#sync(chip);
    this.onChange();
    row?.focus({ preventScroll: true });
  }

  /**
   * Repaints the open menu and its chip in place. Counts are re-derived
   * because choosing one option changes what every other one would return.
   */
  #sync(chip, { quiet = false } = {}) {
    const selected = this.query[chip.group.key];

    for (const row of chip.rows ?? []) {
      const on = selected.has(row.dataset.id);
      const count = quiet ? Number(row.dataset.count) : this.#countFor(chip.group, row.dataset.id);
      row.dataset.count = String(count);
      row.classList.toggle("is-on", on);
      row.classList.toggle("is-empty", count === 0);
      row.setAttribute("aria-selected", on ? "true" : "false");
      row.querySelector(".opt__n").textContent = nf.format(count);
    }

    if (chip.countEl) chip.countEl.textContent = selected.size ? `${selected.size} chosen` : "";
    if (chip.clearBtn) chip.clearBtn.disabled = !selected.size;

    chip.el.classList.toggle("is-set", selected.size > 0);
    const badge = chip.btn.querySelector(".chip__count");
    if (selected.size && badge) badge.textContent = String(selected.size);
    else if (selected.size) chip.btn.insertBefore(h("span", { class: "chip__count", text: String(selected.size) }), chip.btn.querySelector(".chip__caret"));
    else badge?.remove();
  }

  #keys(e) {
    const chip = this.openChip;
    if (!chip) return;
    const rows = chip.rows ?? [];
    if (e.key === "Escape") {
      e.stopPropagation();
      const btn = chip.btn;
      this.#closeMenus();
      btn.focus({ preventScroll: true });
      return;
    }
    if (!rows.length) return;

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      this.cursor = (this.cursor + dir + rows.length) % rows.length;
      rows.forEach((r, i) => r.classList.toggle("is-cursor", i === this.cursor));
      rows[this.cursor].scrollIntoView({ block: "nearest" });
      rows[this.cursor].focus({ preventScroll: true });
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      this.cursor = e.key === "Home" ? 0 : rows.length - 1;
      rows.forEach((r, i) => r.classList.toggle("is-cursor", i === this.cursor));
      rows[this.cursor].scrollIntoView({ block: "nearest" });
      rows[this.cursor].focus({ preventScroll: true });
    }
  }
}
