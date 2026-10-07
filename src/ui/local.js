/**
 * Serve locally — the radius.
 *
 * A card in the Ask Terra conversation: where to look — round the visitor, or
 * round a city or country they type — and how far, as a slider, with a
 * running count of what is inside. The circle itself is drawn on the planet
 * (globe.setArea), and every move of the slider redraws it and brings the
 * camera in or out to keep it framed. "Find ministry opportunities" hands the
 * circle on to the guide, which looks up the churches and ministries inside
 * it and reads their websites (app.js, #findLocal).
 */
import { h, icons, nf, plural, svg } from "./dom.js";
import { findPlace, primePlaces, suggestPlaces } from "../data/places.js";

/** The slider's stops, in miles: fine steps close in, coarse ones far out. */
export const RADII = [1, 2, 3, 5, 10, 15, 25, 50, 75, 100, 150, 250, 500];
export const DEFAULT_MILES = 10;

const spark = () =>
  svg("0 0 16 16", '<path d="M8 1.8c.4 2.9 1.4 4.6 4.8 6.2-3.4 1.6-4.4 3.3-4.8 6.2-.4-2.9-1.4-4.6-4.8-6.2C6.6 6.4 7.6 4.7 8 1.8z" class="ico__fill"/>');
const glass = () => svg("0 0 16 16", '<circle cx="7" cy="7" r="4.6"/><path d="m10.4 10.4 3.2 3.2"/>');
const arrow = () => svg("0 0 16 16", '<path d="M8.6 2.4 13.6 8l-5 5.6M13.4 8H2.4"/>');

/** "Nairobi, Kenya", or a country on its own. */
export const placeLabel = (p) => (p ? [p.name, p.country].filter(Boolean).join(", ") : "");

export class LocalPicker {
  /**
   * `count(miles)` → `{ needs }`: how many Terra needs are inside.
   * `onWhere(place)` moves the circle: a place from the search, or null for
   * the visitor's own location.
   */
  constructor({ count, onChange, onFind, onWhere, onClose }) {
    this.count = count;
    this.onChange = onChange;
    this.onFind = onFind;
    this.onWhere = onWhere;
    this.onClose = onClose;
    // Takes the card back out of the conversation; set by whoever mounts it.
    this.unmount = null;
    this.open = false;
    this.miles = DEFAULT_MILES;
    // null: round the visitor. Otherwise the place the circle is round.
    this.place = null;
    // Whether the visitor's own location is known (the "Near me" side works).
    this.located = false;
    this.mode = "here";
    this.rows = [];
    this.cursor = -1;
    this.token = 0;

    this.value = h("b", { class: "local__value" });
    this.label = h("span", { class: "local__label" });
    this.range = h("input", {
      class: "local__range",
      type: "range",
      min: "0",
      max: String(RADII.length - 1),
      step: "1",
      "aria-label": "Radius in miles",
    });
    this.range.addEventListener("input", () => this.#set(RADII[Number(this.range.value)]));
    this.inside = h("p", { class: "local__inside", "aria-live": "polite" });
    this.find = h("button", { class: "btn btn--accent local__find", type: "button" }, spark(), "Find ministry opportunities");
    this.find.addEventListener("click", () => this.onFind?.(this.miles));

    // Where: round the visitor, or somewhere they name.
    this.hereBtn = h("button", { type: "button", role: "tab", onclick: () => this.#mode("here") }, icons.pin(), "Near me");
    this.awayBtn = h("button", { type: "button", role: "tab", onclick: () => this.#mode("away") }, glass(), "Another place");
    this.input = h("input", {
      class: "local__input",
      type: "text",
      placeholder: "A city or country",
      "aria-label": "City or country",
      autocomplete: "off",
      enterkeyhint: "search",
    });
    this.go = h("button", { class: "local__go", type: "submit", "aria-label": "Go there" }, arrow());
    this.list = h("div", { class: "local__list", role: "listbox", hidden: true });
    this.note = h("p", { class: "local__note", "aria-live": "polite", hidden: true });
    this.form = h("form", { class: "local__search" }, glass(), this.input, this.go);
    this.away = h("div", { class: "local__away", hidden: true }, this.form, this.list, this.note);
    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (this.cursor >= 0 && this.rows[this.cursor]) return this.#choose(this.rows[this.cursor]);
      this.#lookup();
    });
    this.input.addEventListener("input", () => this.#suggest());
    this.input.addEventListener("keydown", (e) => {
      if (this.list.hidden || !this.rows.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        this.cursor = (this.cursor + (e.key === "ArrowDown" ? 1 : this.rows.length - 1)) % this.rows.length;
        this.#paint();
      } else if (e.key === "Escape") {
        e.stopPropagation();
        this.#hideList();
      }
    });

    this.body = h("div", { class: "local__body" },
      h("div", { class: "local__row" }, this.label, this.value),
      this.range,
      h("div", { class: "local__scale", "aria-hidden": "true" },
        h("span", { text: `${RADII[0]} mi` }),
        h("span", { text: `${RADII[RADII.length - 1]} mi` }),
      ),
      this.inside,
      this.find,
    );

    this.root = h(
      "section",
      { class: "local", "aria-label": "Serve locally", hidden: true },
      h("div", { class: "local__head" },
        h("span", { class: "local__title" }, icons.pin(), "Serve locally"),
      ),
      h("div", { class: "local__where", role: "tablist", "aria-label": "Where to look" }, this.hereBtn, this.awayBtn),
      this.away,
      this.body,
    );
  }

  /**
   * Sets the radius and draws its circle; the card is the caller's to mount.
   * `place` is where the circle is round (null for the visitor), and
   * `located` whether the visitor's own location is known.
   */
  show({ miles = this.miles, place = this.place, located = this.located } = {}) {
    primePlaces();
    this.open = true;
    this.root.hidden = false;
    this.located = located;
    this.place = place;
    this.input.value = placeLabel(place);
    this.note.hidden = true;
    this.#hideList();
    this.#paintMode(place || !located ? "away" : "here");
    if (this.#ready()) this.#set(miles, { force: true });
    requestAnimationFrame(() => (this.mode === "away" && !place ? this.input : this.range).focus({ preventScroll: true }));
    return this.root;
  }

  /** The circle has moved to `place` (null: round the visitor, now `located`). */
  setPlace(place, { located = this.located } = {}) {
    this.place = place;
    this.located = located;
    this.input.value = placeLabel(place);
    // Without the visitor's location there is only somewhere they name.
    this.#paintMode(place || !located ? "away" : "here");
    if (this.#ready()) this.#set(this.miles, { force: true });
  }

  /** `quiet` takes the card away without ending serve-locally (the guide takes over). */
  close({ quiet = false } = {}) {
    if (!this.open) return;
    this.open = false;
    const unmount = this.unmount;
    this.unmount = null;
    unmount?.();
    if (!quiet) this.onClose?.();
  }

  /** There is a centre to draw a circle round. */
  #ready() {
    return this.mode === "here" ? this.located : !!this.place;
  }

  #mode(mode) {
    if (mode === this.mode) return;
    if (mode === "here") {
      this.place = null;
      this.input.value = "";
      this.note.hidden = true;
      this.#hideList();
      this.#paintMode("here");
      this.onWhere?.(null);
      return;
    }
    this.#paintMode("away");
    requestAnimationFrame(() => this.input.focus({ preventScroll: true }));
  }

  #paintMode(mode) {
    this.mode = mode;
    this.hereBtn.classList.toggle("is-on", mode === "here");
    this.awayBtn.classList.toggle("is-on", mode === "away");
    this.hereBtn.setAttribute("aria-selected", String(mode === "here"));
    this.awayBtn.setAttribute("aria-selected", String(mode === "away"));
    this.away.hidden = mode !== "away";
    // Nothing to set a radius round until a place is chosen.
    const ready = this.#ready();
    this.body.hidden = !ready;
    if (ready) this.#words();
  }

  async #suggest() {
    const mine = ++this.token;
    this.note.hidden = true;
    const found = await suggestPlaces(this.input.value);
    if (mine !== this.token) return;
    this.rows = found;
    this.cursor = -1;
    this.#paint();
  }

  #paint() {
    this.list.replaceChildren(
      ...this.rows.map((p, i) =>
        h(
          "button",
          {
            class: `local__opt${i === this.cursor ? " is-on" : ""}`,
            type: "button",
            role: "option",
            "aria-selected": String(i === this.cursor),
            onmousedown: (e) => e.preventDefault(),
            onclick: () => this.#choose(p),
          },
          h("b", { text: p.name }),
          h("span", { text: p.kind === "country" ? "Country" : p.country }),
        ),
      ),
    );
    this.list.hidden = !this.rows.length;
  }

  #hideList() {
    this.token++;
    this.rows = [];
    this.cursor = -1;
    this.list.hidden = true;
  }

  #choose(place) {
    this.#hideList();
    this.input.value = placeLabel(place);
    this.input.blur();
    this.onWhere?.(place);
  }

  /** Enter without a suggestion picked: the best the gazetteer or the map's search can do. */
  async #lookup() {
    const text = this.input.value.trim();
    if (!text) return;
    this.#hideList();
    this.go.classList.add("is-busy");
    const place = await findPlace(text).catch(() => null);
    this.go.classList.remove("is-busy");
    if (place) return this.#choose(place);
    this.note.textContent = `Couldn't find “${text}”. Try a nearby city, or add the country.`;
    this.note.hidden = false;
  }

  #set(miles, { force = false } = {}) {
    const i = nearestStop(miles);
    const next = RADII[i];
    if (!force && next === this.miles) return;
    this.miles = next;
    this.range.value = String(i);
    this.root.style.setProperty("--fill", `${(i / (RADII.length - 1)) * 100}%`);
    this.value.textContent = `${nf.format(next)} mile${next === 1 ? "" : "s"}`;
    this.#words();
    this.onChange?.(next);
  }

  #words() {
    this.label.textContent = this.place ? `How far around ${this.place.name}?` : "How far can you go?";
    const { needs } = this.count(this.miles);
    this.inside.replaceChildren(
      "Terra's guide will look up the churches and ministries inside the circle and read their websites for ways to help",
      needs ? h("span", {}, ", along with ", h("b", { text: plural(needs, "open need") }), " posted on Terra.") : ".",
    );
  }
}

function nearestStop(miles) {
  let best = 0;
  for (let i = 1; i < RADII.length; i++) {
    if (Math.abs(RADII[i] - miles) < Math.abs(RADII[best] - miles)) best = i;
  }
  return best;
}
