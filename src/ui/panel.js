/**
 * The right-hand rail. Two faces: the network summary with the short list of
 * most pressing needs, and a single ministry with everything it is asking for.
 */
import { clear, h, icons, joinDot, nf, plural } from "./dom.js";
import { emptyState, needCard, sectionLabel, statTile } from "./cards.js";
import { FOCUS_BY_ID } from "../data/taxonomy.js";
import { queryIsEmpty } from "../data/network.js";

export class Panel {
  constructor(root, { net, on }) {
    this.root = root;
    this.net = net;
    this.on = on;
    this.mode = "network";
    this.ministry = null;
    this.open = true;
  }

  setOpen(open) {
    this.open = open;
    this.root.classList.toggle("is-out", !open);
    document.body.classList.toggle("no-panel", !open);
    this.on.layoutChanged?.();
  }

  showNetwork() {
    this.mode = "network";
    this.ministry = null;
    this.setOpen(true);
    this.render();
  }

  showMinistry(ministry) {
    this.ministry = this.net.ministryById.get(ministry.id) ?? ministry;
    this.mode = "ministry";
    this.setOpen(true);
    this.render();
  }

  render(query = this.query) {
    this.query = query;
    clear(this.root);
    if (this.mode === "ministry" && this.ministry) this.#renderMinistry();
    else this.#renderNetwork();
  }

  #head(title, { back = false } = {}) {
    return h(
      "div",
      { class: "panel__head" },
      back
        ? h(
            "button",
            { class: "panel__back", onclick: () => this.showNetwork() },
            icons.back(),
            "Network",
          )
        : h("span", { class: "panel__title", text: title }),
      h(
        "button",
        { class: "panel__x", "aria-label": "Close this panel", onclick: () => this.setOpen(false) },
        icons.close(),
      ),
    );
  }

  #foot() {
    return h(
      "div",
      { class: "panel__foot" },
      h("button", { class: "btn btn--accent", onclick: () => this.on.postNeed() }, "Post a need"),
      h("button", { class: "btn btn--soft", onclick: () => this.on.openBoard() }, "Open needs board"),
    );
  }

  #renderNetwork() {
    const query = this.query;
    const filtered = query && !queryIsEmpty(query);
    const needs = filtered ? this.net.select(query) : this.net.needs;
    const stats = this.net.stats(needs);

    const body = h("div", { class: "panel__body scroll" });

    body.appendChild(
      statTile({
        label: filtered ? "Matching your filters" : "Across the network",
        value: `${nf.format(stats.needs)} open need${stats.needs === 1 ? "" : "s"}`,
        sub: joinDot(
          `${nf.format(stats.urgent)} urgent`,
          `${nf.format(stats.people)} people wanted`,
          plural(stats.ministries, "ministry", "ministries"),
        ),
      }),
    );

    if (filtered) {
      body.appendChild(
        h(
          "button",
          { class: "btn btn--soft", style: { marginTop: "10px", width: "100%", justifyContent: "center" }, onclick: () => this.on.clearFilters() },
          "Clear filters",
        ),
      );
    }

    const pressing = this.net.pressing(6, needs);
    body.appendChild(sectionLabel(filtered ? "Top matches" : "Most pressing", pressing.length ? null : null));

    if (!pressing.length) {
      body.appendChild(
        emptyState("Nothing matches", "Loosen a filter or clear the search to see the whole network again.", {
          label: "Clear filters",
          onClick: () => this.on.clearFilters(),
        }),
      );
    } else {
      for (const need of pressing) {
        body.appendChild(needCard(need, { onOpen: (n) => this.on.openNeed(n) }));
      }
    }

    this.root.append(this.#head("Open needs"), body, this.#foot());
  }

  #renderMinistry() {
    const m = this.ministry;
    const body = h("div", { class: "panel__body scroll" });

    body.append(
      h("div", { class: "ministry__name", text: m.name }),
      h(
        "div",
        { class: "ministry__where" },
        icons.pin(),
        joinDot(`${m.city}, ${m.country}`, m.since ? `since ${m.since}` : null),
      ),
      h("p", { class: "ministry__blurb", text: m.blurb }),
      h(
        "div",
        { class: "tags" },
        m.focus.map((f) =>
          h("span", { class: "tag tag--focus", text: FOCUS_BY_ID.get(f)?.label ?? f }),
        ),
      ),
      sectionLabel("Open needs", `${m.openNeeds}`),
    );

    for (const need of this.net.rank(m.needs)) {
      body.appendChild(needCard(need, { onOpen: (n) => this.on.openNeed(n) }));
    }

    const kv = h("div", { class: "kv" });
    const row = (k, v) =>
      h("div", { class: "kv__row" }, h("span", { class: "kv__k", text: k }), v);
    // A row with nothing in it is worse than no row: it reads as data that
    // failed to load rather than a field the ministry chose not to fill in.
    // Ministries now write their own profiles, so most of these are optional.
    kv.append(
      ...[
        m.staff ? row("Team", h("span", { class: "kv__v", text: plural(m.staff, "person", "people") })) : null,
        m.languages?.length ? row("Languages", h("span", { class: "kv__v", text: m.languages.join(", ") })) : null,
        row("People wanted", h("span", { class: "kv__v", text: nf.format(m.peopleWanted) })),
        m.contact
          ? row("Contact", h("span", { class: "kv__v" }, h("a", { href: `mailto:${m.contact}`, text: m.contact })))
          : null,
      ].filter(Boolean),
    );
    body.appendChild(kv);

    // No footer: the globe has already flown here, and posting is the
    // ministry's own business, from its account menu.
    this.root.append(this.#head(m.name, { back: true }), body);
  }
}

