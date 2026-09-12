/**
 * The shell: wires the globe to the chrome, the filters to both, and keeps the
 * breadcrumb honest about where you are.
 */
import { Globe } from "../globe/globe.js";
import { clamp, smoothstep } from "../globe/geo.js";
import { Network, emptyQuery, queryIsEmpty } from "../data/network.js";
import { Board } from "./board.js";
import { Filters } from "./filters.js";
import { ModalLayer, aboutModal, needModal } from "./modals.js";
import { Panel } from "./panel.js";
import { add, clear, h, icons, nf } from "./dom.js";
import { openPop, menuIcons } from "./pop.js";
import { store } from "./store.js";
import { REVISION } from "three";
import { AuthGate } from "./auth.js";
import { questionnaireModal } from "./questionnaire.js";
import { ministryModal, postNeedModal as postNeedForm } from "./ministry.js";
import { Recommendations } from "./recommend.js";
import * as api from "../lib/api.js";

const THEME_LABELS = { light: "Soft light", dark: "Deep night" };

/** How long after the loading screen lifts the headline lands. */
const HERO_IN_MS = 520;
/**
 * And how long it then holds before the page settles into the working view.
 * Measured from the headline's cue, not from its arrival: the words take
 * 1.1s to land, so this is about eight tenths of a second of stillness with
 * the sentence fully up. It is a headline over a globe, not a splash screen —
 * it has to be gone before anyone starts waiting for it.
 */
const HERO_HOLD_MS = 1900;

export class App {
  constructor() {
    // Empty until the backend answers. ?demo loads the fictional set instead,
    // which is the only way to see a populated globe before anyone has posted.
    this.demo = new URLSearchParams(location.search).has("demo");
    this.net = new Network(this.demo ? Network.demoData() : undefined);
    this.session = null;
    this.profile = null;
    this.ministry = null;
    this.query = emptyQuery();
    this.view = "globe";
    this.selected = null;
    this.suggestCursor = -1;

    this.el = {
      canvas: document.getElementById("globe"),
      overlay: document.getElementById("overlay"),
      hero: document.getElementById("hero"),
      hint: document.getElementById("hint"),
      crumbs: document.getElementById("crumbs"),
      nav: document.getElementById("nav"),
      filters: document.getElementById("filters"),
      panel: document.getElementById("panel"),
      sheet: document.getElementById("sheet"),
      grabber: document.getElementById("grabber"),
      modals: document.getElementById("modals"),
      toasts: document.getElementById("toasts"),
      search: document.getElementById("searchInput"),
      clearSearch: document.getElementById("searchClear"),
      suggest: document.getElementById("suggest"),
      themeName: document.getElementById("themeName"),
      chrome: document.querySelector(".chrome"),
    };

    this.modals = new ModalLayer(this.el.modals);
    this.panel = new Panel(this.el.panel, { net: this.net, on: this.#panelHandlers() });
    this.board = new Board(this.el.sheet, { net: this.net, on: this.#boardHandlers() });
    this.filtersUi = new Filters(this.el.filters, {
      net: this.net,
      query: this.query,
      onChange: () => {
        this.#leaveHero();
        this.applyQuery();
      },
    });

    this.rail = h("div", { class: "rail" });
    this.el.chrome.appendChild(this.rail);
  }

  /* ----------------------------------------------------------------- boot */

  async start() {
    const boot = this.#boot();
    // The entrance state: headline, a find bar standing under it, and the
    // network figures where the panel will be. Everything settles once the
    // globe has flown in.
    document.body.classList.add("is-hero");
    this.panel.setOpen(false);
    this.#theme(store.theme || "light", { quiet: true });
    this.#bindChrome();
    this.#bindKeys();

    this.globe = new Globe(this.el.canvas, {
      overlay: this.el.overlay,
      onProgress: (p, label) => boot.progress(p, label),
      onPinClick: (m) => this.openMinistry(m, { fly: true }),
      onGlobeClick: () => this.#deselect(),
      onFirstGesture: () => {
        this.#leaveHero();
        this.#hideHint();
      },
      onCamera: (z) => this.#onCamera(z),
    });

    try {
      this.globe.setMinistries(this.net.ministries);
      await this.globe.start();
      this.globe.setTheme(this.theme);
      this.globe.setMinistries(this.net.ministries);
    } catch (err) {
      boot.fail(err);
      throw err;
    }

    this.gate = new AuthGate({
      onSignedIn: () => this.#afterAuth(),
      onSkip: () => this.#renderAccount(),
    });
    this.recs = new Recommendations(h("div", { class: "recs" }), {
      onOpenNeed: (need) => this.openNeed(need),
      onNeedQuestionnaire: () => this.openQuestionnaire(),
      heading: false, // the dialog already says it
    });

    if (api.isConfigured && !this.demo) {
      await this.reloadNetwork();
      await this.#afterAuth({ quiet: true });
      api.onAuthChange((session) => {
        const was = this.session?.user?.id ?? null;
        this.session = session;
        if ((session?.user?.id ?? null) !== was) this.#afterAuth({ quiet: true });
      });
    } else if (!api.isConfigured) {
      this.toast("No backend configured — showing an empty globe. See .env.example.");
    }

    this.panel.render(this.query);
    this.#renderCrumbs();
    this.#renderRail();
    this.#renderAccount();
    this.syncReserved();
    // Coalesced: a window drag-resize delivers a stream of these, and each one
    // measures a dozen chrome boxes. One measurement per frame is plenty, and
    // it keeps the reads out of the middle of the resize itself.
    let resizePending = 0;
    window.addEventListener("resize", () => {
      if (resizePending) return;
      resizePending = requestAnimationFrame(() => {
        resizePending = 0;
        this.syncReserved();
      });
    });
    boot.done();
    document.body.classList.add("is-live");

    // The world fades up where it stands and the headline lands just behind it,
    // so the two read as one arrival. Then it holds, and then the page settles
    // into the working view — the entrance's only camera move. Only the timer
    // brings the camera with it: someone who has already taken hold of the
    // globe has said where they want to be, and having it fly out from under
    // them is the rudest thing the page could do.
    this.heroInTimer = setTimeout(() => document.body.classList.add("hero-in"), HERO_IN_MS);
    this.heroTimer = setTimeout(() => this.#leaveHero({ settle: true }), HERO_IN_MS + HERO_HOLD_MS);

    if (!store.seen) {
      store.markSeen();
      setTimeout(() => this.toast("Fictional sample data — drag the globe to look around."), 3400);
    }
    return this;
  }

  #leaveHero({ settle = false } = {}) {
    if (!document.body.classList.contains("is-hero")) return;
    clearTimeout(this.heroTimer);
    clearTimeout(this.heroInTimer);
    document.body.classList.remove("is-hero", "hero-in");
    // Whichever way the hero went, the opening frame is over and the globe is
    // free to turn again. On the timed exit the settle starts the turn itself;
    // on a gesture the drift picks it up once the hand comes off.
    this.globe?.releaseSpin();
    // Synchronously, in the same turn that drops the class the chrome
    // transitions on, so the bar starts rising and the globe starts growing
    // on the same frame.
    if (settle) this.globe?.settle();
    this.panel.setOpen(true);
    // Twice: once to give the ground the headline was holding straight back
    // to the pins, and again once the panel and the find bar have landed.
    this.syncReserved();
    setTimeout(() => this.syncReserved(), 760);
  }

  #boot() {
    const fill = h("div", { class: "boot__fill" });
    const label = h("div", { class: "boot__label", text: "gathering the network" });
    const veil = h(
      "div",
      { class: "boot" },
      h(
        "div",
        { class: "boot__inner" },
        h("span", {
          class: "boot__mark",
          html: '<svg viewBox="0 0 24 24" class="boot__mark"><circle cx="12" cy="12" r="9.4"/><ellipse cx="12" cy="12" rx="4" ry="9.4"/><path d="M2.9 8.7h18.2M2.9 15.3h18.2"/></svg>',
        }),
        label,
        h("div", { class: "boot__bar" }, fill),
      ),
    );
    document.body.appendChild(veil);
    return {
      progress(p) {
        fill.style.width = `${Math.round(clamp(p, 0, 1) * 100)}%`;
      },
      done() {
        // Let the bar be seen reaching the end before the screen leaves.
        fill.style.width = "100%";
        setTimeout(() => veil.classList.add("is-done"), 200);
        setTimeout(() => veil.remove(), 1200);
      },
      fail(err) {
        clear(veil);
        add(veil, [
          h(
            "div",
            { class: "boot__inner boot__fail" },
            h("div", { class: "boot__label", text: "could not start" }),
            h("p", {
              text:
                "The globe needs WebGL2 and the baked textures in public/textures. Run npm run assets, then reload.",
            }),
            h("p", { style: { fontFamily: "var(--mono)", fontSize: "12px" }, text: String(err?.message || err) }),
          ),
        ]);
      },
    };
  }

  /* -------------------------------------------------------------- chrome */

  #bindChrome() {
    document.body.addEventListener("click", (e) => {
      const trigger = e.target.closest("[data-action]");
      if (!trigger) return;
      const action = trigger.dataset.action;
      if (action === "reset-view") {
        e.preventDefault();
        this.globe?.reset();
        this.#deselect();
        this.setView("globe");
      } else if (action === "zoom-in") this.globe?.zoomBy(0.62);
      else if (action === "zoom-out") this.globe?.zoomBy(1.62);
      else if (action === "post-need") {
        this.#leaveHero();
        this.postNeed();
      } else if (action === "sign-in") this.gate?.open("signin");
      else if (action === "account") this.#accountMenu(trigger);
      else if (action === "suggested") this.openSuggestions();
      else if (action === "about") this.setView("about");
      else if (action === "cycle-theme") this.#theme(this.theme === "light" ? "dark" : "light");
      else if (action === "menu") this.#menu(trigger);
    });

    this.el.nav.addEventListener("click", (e) => {
      const item = e.target.closest("[data-view]");
      if (item) this.setView(item.dataset.view);
    });

    this.el.grabber.addEventListener("click", () => this.setView(this.board.open ? "globe" : "needs"));

    const search = this.el.search;
    search.addEventListener("input", () => {
      this.query.text = search.value;
      this.el.clearSearch.hidden = !search.value;
      this.#renderSuggest();
      this.applyQuery();
    });
    search.addEventListener("focus", () => {
      this.#leaveHero();
      this.#renderSuggest();
    });
    search.addEventListener("blur", () => setTimeout(() => this.#hideSuggest(), 140));
    search.addEventListener("keydown", (e) => this.#suggestKeys(e));
    this.el.clearSearch.addEventListener("click", () => {
      search.value = "";
      this.query.text = "";
      this.el.clearSearch.hidden = true;
      this.#hideSuggest();
      this.applyQuery();
      search.focus();
    });
  }

  #bindKeys() {
    window.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        this.el.search.focus();
        return;
      }
      if (e.key === "Escape") {
        if (this.modals.isOpen) return; // the layer handles its own close
        if (this.board.open) return this.setView("globe");
        if (this.selected) return this.#deselect();
        return;
      }
      if (typing) return;
      if (e.key === "+" || e.key === "=") this.globe?.zoomBy(0.7);
      else if (e.key === "-" || e.key === "_") this.globe?.zoomBy(1.42);
      else if (e.key.toLowerCase() === "r") {
        this.globe?.reset();
        this.#deselect();
      } else if (e.key.toLowerCase() === "b") this.setView(this.board.open ? "globe" : "needs");
      else if (e.key.toLowerCase() === "t") this.#theme(this.theme === "light" ? "dark" : "light");
    });
  }

  #menu(anchor) {
    const saved = store.interestCount + store.posted.length;
    const dark = this.theme === "light";
    openPop({
      anchor,
      parent: this.el.chrome,
      items: [
        { label: "About this map", note: "How the globe is drawn", icon: menuIcons.info, run: () => this.setView("about") },
        { label: "Open needs board", icon: menuIcons.board, kbd: "B", run: () => this.setView("needs") },
        {
          label: this.panel.open ? "Hide the side panel" : "Show the side panel",
          icon: menuIcons.panel,
          run: () => this.panel.setOpen(!this.panel.open),
        },
        null,
        {
          label: `Switch to ${dark ? "deep night" : "soft light"}`,
          icon: menuIcons.theme,
          kbd: "T",
          run: () => this.#theme(dark ? "dark" : "light"),
        },
        { label: "Reset the view", icon: menuIcons.reset, kbd: "R", run: () => this.globe?.reset() },
        null,
        {
          label: "Clear what this browser saved",
          note: saved ? `${saved} interest${saved === 1 ? "" : "s"} and posted needs` : "Nothing saved yet",
          icon: menuIcons.trash,
          danger: true,
          run: () => {
            localStorage.removeItem("terra.v1");
            location.reload();
          },
        },
      ],
    });
  }

  #theme(name, { quiet = false } = {}) {
    this.theme = name;
    document.documentElement.dataset.theme = name;
    this.el.themeName.textContent = THEME_LABELS[name] ?? name;
    store.setTheme(name);
    this.globe?.setTheme(name);
    if (!quiet) this.toast(`${THEME_LABELS[name]}`);
  }

  /* ---------------------------------------------------------------- views */

  setView(view) {
    this.#leaveHero();
    if (view === "about") {
      this.#openAbout();
      return;
    }
    this.view = view;
    for (const item of this.el.nav.querySelectorAll("[data-view]")) {
      item.classList.toggle("is-active", item.dataset.view === (view === "needs" ? "needs" : "globe"));
    }
    this.board.setOpen(view === "needs");
    this.#renderCrumbs();
  }

  #openAbout() {
    const stats = { ...(this.globe?.stats() ?? {}), ...this.net.stats(), three: REVISION };
    aboutModal(this.modals, {
      stats: {
        three: REVISION,
        renderer: stats.renderer ?? "WebGL2",
        size: stats.size ?? "—",
        features: stats.features ?? 0,
        lastMs: stats.lastMs ?? 0,
        needs: stats.needs,
        people: stats.people,
        ministries: stats.ministries,
      },
      onPostNeed: () => this.postNeed(),
    });
  }

  #renderCrumbs() {
    const trail = [
      { label: "About", run: () => this.setView("about") },
      { label: "Network", run: () => this.panel.showNetwork() },
      { label: this.#context() },
    ];
    clear(this.el.crumbs);
    trail.forEach((crumb, i) => {
      if (i) this.el.crumbs.appendChild(h("span", { class: "crumbs__sep", text: "›" }));
      this.el.crumbs.appendChild(
        h(
          "button",
          { class: "crumbs__item", onclick: crumb.run ?? null, text: crumb.label },
        ),
      );
    });
  }

  #context() {
    if (this.selected) return this.selected.city;
    if (this.board.open) return "Needs board";
    if (!queryIsEmpty(this.query)) return "Filtered needs";
    return "Open needs";
  }

  /**
   * Whole-network figures, not the filtered ones: it is captioned NETWORK and
   * stands where the panel would be, which is where the filtered count already
   * lives when the panel is up.
   */
  #renderRail() {
    const stats = this.net.stats();
    const countries = new Set(this.net.ministries.map((m) => m.country)).size;
    clear(this.rail);
    const key = (kind, label) =>
      h("span", {}, h("i", { class: `rail__dot rail__dot--${kind}` }), label);
    const row = (label, value) =>
      h(
        "div",
        { class: "rail__row" },
        h("span", { class: "rail__k", text: label }),
        h("span", { class: "rail__v", text: nf.format(value) }),
      );
    add(this.rail, [
      h("div", { class: "rail__legend" }, key("urgent", "Urgent"), key("open", "Open"), key("city", "City")),
      h("div", { class: "rail__head", text: "Network" }),
      row("Ministries", this.net.ministries.length),
      row("Open needs", stats.needs),
      row("People needed", stats.people),
      row("Countries", countries),
      h("div", { class: "rail__foot", text: "Fictional sample data" }),
    ]);
  }

  /* ------------------------------------------------------------- backend */

  /** Pulls the public network and rebuilds every derived view from it. */
  async reloadNetwork() {
    try {
      const data = await api.loadNetwork();
      this.net.setData(data);
      this.globe?.setMinistries(this.net.ministries);
      this.applyQuery();
      this.#renderRail();
    } catch (err) {
      console.error("[terra] could not load the network", err);
      this.toast("Could not reach the network just now.");
    }
  }

  /**
   * Re-reads who is signed in and what they are. Called on every auth change,
   * so it has to be safe to run repeatedly and safe to run signed out.
   */
  async #afterAuth({ quiet = false } = {}) {
    this.session = await api.currentSession();
    this.profile = this.session ? await api.myProfile() : null;
    this.ministry = this.profile?.role === "ministry" ? await api.myMinistry() : null;
    this.#renderAccount();

    if (!this.session) return;
    if (!quiet) this.toast(`Signed in as ${this.profile?.full_name || this.session.user.email}`);

    // A volunteer who has never answered the questions is asked once, after a
    // beat — immediately on top of a sign-in reads as a second gate.
    if (this.profile?.role === "volunteer" && !this.askedQuestions) {
      this.askedQuestions = true;
      const existing = await api.loadQuestionnaire();
      if (!existing) setTimeout(() => this.openQuestionnaire(), 900);
    }
  }

  /** The chip in the top bar: sign in, or who you are. */
  #renderAccount() {
    const slot = this.el.acct ?? (this.el.acct = h("span"));
    if (!slot.isConnected) {
      this.el.nav.parentElement.querySelector(".topbar__actions")?.prepend(slot);
    }
    clear(slot);
    if (!api.isConfigured) return;

    if (!this.session) {
      slot.appendChild(h("button", { class: "btn btn--ghost", "data-action": "sign-in" }, "Sign in"));
      return;
    }
    const name = this.profile?.full_name || this.session.user.email || "You";
    slot.appendChild(
      h("button", { class: "acct", "data-action": "account", title: this.session.user.email },
        h("span", { class: "acct__dot", text: name.trim().charAt(0).toUpperCase() }),
        h("span", { class: "acct__name", text: name.split(" ")[0] }),
      ),
    );
  }

  #accountMenu(anchor) {
    const isMinistry = this.profile?.role === "ministry";
    openPop({
      anchor,
      parent: this.el.chrome,
      items: [
        { label: this.profile?.full_name || this.session.user.email, note: isMinistry ? "Ministry account" : "Volunteer account", icon: menuIcons.info },
        null,
        !isMinistry && { label: "Suggested for you", note: "Matched to your answers", icon: menuIcons.board, run: () => this.openSuggestions() },
        !isMinistry && { label: "Answer the five questions", icon: menuIcons.panel, run: () => this.openQuestionnaire() },
        isMinistry && !this.ministry && { label: "Put your ministry on the map", icon: menuIcons.panel, run: () => this.openMinistrySetup() },
        isMinistry && this.ministry && { label: "Post a need", icon: menuIcons.board, run: () => this.postNeed() },
        null,
        { label: "Sign out", icon: menuIcons.trash, run: async () => { await api.signOut(); this.session = null; this.profile = null; this.ministry = null; this.#renderAccount(); this.toast("Signed out."); } },
      ].filter((x) => x !== false),
    });
  }

  openQuestionnaire() {
    if (!this.session) return this.gate.open("signup");
    questionnaireModal(this.modals, {
      onSaved: () => {
        this.toast("Saved. Finding needs that fit you…");
        this.openSuggestions({ force: true });
      },
    });
  }

  openSuggestions({ force = false } = {}) {
    if (!this.session) return this.gate.open("signin");
    this.modals.show(() => {
      const body = h("div", {},
        h("h2", { class: "modal__title", text: "Suggested for you" }),
        h("p", { class: "modal__lede", text: "Ranked against your answers by reading every open need." }),
        this.recs.root,
      );
      this.recs.show({ force });
      return body;
    }, { width: 560 });
  }

  openMinistrySetup() {
    if (!this.session) return this.gate.open("signup");
    ministryModal(this.modals, {
      onCreated: async (m) => {
        this.ministry = m;
        this.toast(`${m.name} is on the map.`);
        await this.reloadNetwork();
        this.postNeed();
      },
    });
  }

  /* --------------------------------------------------------------- query */

  applyQuery() {
    this.panel.render(this.query);
    if (this.board.open) this.board.render(this.query);
    this.globe?.setDimmed(this.net.excluded(this.query));
    this.#renderRail();
    this.#renderCrumbs();
  }

  clearFilters() {
    this.query = emptyQuery();
    this.el.search.value = "";
    this.el.clearSearch.hidden = true;
    this.filtersUi.query = this.query;
    this.filtersUi.render();
    this.applyQuery();
  }

  /* ----------------------------------------------------------- suggestions */

  #renderSuggest() {
    const rows = this.net.suggest(this.el.search.value);
    const box = this.el.suggest;
    clear(box);
    this.suggestRows = rows;
    this.suggestCursor = -1;
    if (!rows.length) {
      box.hidden = true;
      return;
    }
    for (const row of rows) {
      box.appendChild(
        h(
          "button",
          { class: "suggest__row", onclick: () => this.#takeSuggestion(row) },
          h("span", { class: "suggest__kind", text: row.kind }),
          h("b", { text: row.label }),
          h("span", { text: row.note }),
        ),
      );
    }
    box.hidden = false;
  }

  #hideSuggest() {
    this.el.suggest.hidden = true;
  }

  #suggestKeys(e) {
    const rows = this.suggestRows || [];
    if (e.key === "Escape") {
      this.#hideSuggest();
      return;
    }
    if (!rows.length || this.el.suggest.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      this.suggestCursor = (this.suggestCursor + dir + rows.length) % rows.length;
      const items = [...this.el.suggest.children];
      items.forEach((el, i) => el.classList.toggle("is-cursor", i === this.suggestCursor));
      items[this.suggestCursor]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.#takeSuggestion(rows[Math.max(this.suggestCursor, 0)]);
    }
  }

  #takeSuggestion(row) {
    if (!row) return;
    this.#hideSuggest();
    if (row.kind === "ministry") {
      this.el.search.value = "";
      this.query.text = "";
      this.el.clearSearch.hidden = true;
      this.applyQuery();
      this.openMinistry(row.ministry, { fly: true });
    } else if (row.kind === "need") {
      this.openNeed(row.need);
    } else if (row.kind === "skill") {
      this.el.search.value = row.skill;
      this.query.text = row.skill;
      this.el.clearSearch.hidden = false;
      this.applyQuery();
    } else if (row.kind === "filter") {
      // A matched vocabulary term goes straight into whichever chip owns it.
      const target = this.#chipKeyFor(row.item.id);
      if (target) {
        this.query[target].add(row.item.id);
        this.filtersUi.render();
      }
      this.el.search.value = "";
      this.query.text = "";
      this.el.clearSearch.hidden = true;
      this.applyQuery();
    }
  }

  #chipKeyFor(id) {
    for (const group of this.filtersUi.groups) {
      if (group.options.some((o) => o.id === id)) return group.key;
    }
    return null;
  }

  /* --------------------------------------------------------------- events */

  #panelHandlers() {
    return {
      postNeed: (ministryId) => this.postNeed(ministryId),
      openBoard: () => this.setView("needs"),
      openNeed: (need) => this.openNeed(need),
      clearFilters: () => this.clearFilters(),
      focusMinistry: (m) => this.globe?.focus(m, { zoom: 0.68 }),
      layoutChanged: () => setTimeout(() => this.syncReserved(), 480),
    };
  }

  #boardHandlers() {
    return {
      postNeed: (ministryId) => this.postNeed(ministryId),
      openNeed: (need) => this.openNeed(need),
      clearFilters: () => this.clearFilters(),
      boardToggled: (open) => {
        document.body.classList.toggle("board-open", open);
        setTimeout(() => this.syncReserved(), 560);
        this.el.hint.style.opacity = open ? 0 : this.hintOpacity ?? 1;
        this.#renderCrumbs();
      },
    };
  }

  openMinistry(ministry, { fly = false } = {}) {
    const full = this.net.ministryById.get(ministry.id) ?? ministry;
    this.selected = full;
    this.globe?.select(full.id);
    this.globe?.setSpin(false);
    this.panel.showMinistry(full);
    if (fly) this.globe?.focus(full, { zoom: Math.max(this.globe.zoom, 0.55) });
    this.#renderCrumbs();
  }

  openNeed(need) {
    const fresh = this.net.needById(need.id) ?? need;
    needModal(this.modals, fresh, {
      onPickUp: (n) => {
        // Written to the browser either way, and to the database as well when
        // there is somebody to attribute it to. A signed-out visitor still gets
        // to mark a need rather than being stopped to sign in first.
        this.net.toggleInterest(n.id);
        this.#afterDataChange();
        if (this.session) api.toggleInterest(n.id, true).catch(() => {});
        this.toast(
          this.session
            ? `Interest noted — ${n.ministryName} can see it.`
            : `Noted in this browser. Sign in so ${n.ministryName} can see it.`,
        );
      },
      onDrop: (n) => {
        this.net.toggleInterest(n.id);
        this.#afterDataChange();
        if (this.session) api.toggleInterest(n.id, false).catch(() => {});
        this.toast("Interest withdrawn.");
      },
      onMinistry: (n) => {
        const m = this.net.ministryById.get(n.ministry);
        if (m) this.openMinistry(m, { fly: true });
      },
    });
  }

  /**
   * The one entry point for posting, and it is a gate as much as a form: the
   * write path needs a signed-in owner of a ministry, so anything missing is
   * collected in order rather than failing at submit.
   */
  async postNeed() {
    if (!api.isConfigured) return this.toast("No backend configured — posting is off.");
    if (!this.session) return this.gate.open("signup");
    if (this.profile?.role !== "ministry") {
      await api.setRole("ministry").catch(() => {});
      this.profile = await api.myProfile();
    }
    if (!this.ministry) this.ministry = await api.myMinistry();
    if (!this.ministry) return this.openMinistrySetup();

    postNeedForm(this.modals, {
      ministry: this.ministry,
      onPosted: async (res) => {
        await this.reloadNetwork();
        if (res.status === "live") {
          const m = this.net.ministryById.get(this.ministry.id);
          if (m) {
            this.globe?.select(m.id);
            this.globe?.focus(m, { zoom: Math.max(this.globe.zoom, 0.5) });
            this.selected = m;
            this.panel.showMinistry(m);
          }
        }
      },
    });
  }

  #afterDataChange() {
    this.panel.net = this.net;
    this.board.net = this.net;
    this.filtersUi.net = this.net;
    this.globe?.setMinistries(this.net.ministries);
    if (this.selected) {
      const fresh = this.net.ministryById.get(this.selected.id);
      if (fresh) {
        this.selected = fresh;
        this.panel.showMinistry(fresh);
      }
    } else {
      this.panel.render(this.query);
    }
    if (this.board.open) this.board.render(this.query);
    this.#renderRail();
  }

  /**
   * Label layout treats the chrome as occupied ground. Measured only when the
   * layout actually changes, never per camera frame.
   */
  syncReserved() {
    const rects = [];
    // The pad is deliberately small. Every rectangle here is ground taken away
    // from the map, and the layer already keeps a 5px gap of its own around
    // whatever it places; a generous pad on top of that clears a pin that was
    // sitting perfectly legibly beside a chip.
    const push = (el, pad = 4) => {
      if (!el || el.hidden || !el.isConnected) return;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      rects.push([r.left - pad, r.top - pad, r.right + pad, r.bottom + pad]);
    };
    push(document.querySelector(".topbar"), 2);
    push(document.querySelector(".crumbs"), 4);
    push(document.querySelector(".search"));
    // The headline now stands in front of the disc, so the ground under it is
    // spoken for: a pin there would be half-hidden behind a letterform. Both
    // boxes hug their text — the container is wider than either line.
    if (document.body.classList.contains("is-hero")) {
      push(document.querySelector(".hero__title"), 0);
      push(document.querySelector(".hero__sub"), 0);
    }
    // The filter row is a full-width flex container with its chips centred,
    // so its bounding box reserves ground the chips never occupy — enough of
    // it, at the whole-globe view, to swallow the pins either side of them.
    for (const chip of document.querySelectorAll(".filters .chip")) push(chip, 3);
    push(document.querySelector(".dial"));
    push(document.querySelector(".hint"), 3);
    if (!this.panel.open) push(this.rail, 4);
    if (this.panel.open) push(this.el.panel);
    if (this.board.open) push(this.el.sheet);
    this.globe?.setReserved(rects);
  }

  #deselect() {
    if (!this.selected) return;
    this.selected = null;
    this.globe?.select(null);
    this.globe?.setSpin(true);
    this.panel.showNetwork();
    this.panel.render(this.query);
    this.#renderCrumbs();
  }

  #onCamera(z) {
    if (!this.hintHidden) {
      this.hintOpacity = 1 - smoothstep(0.05, 0.3, z);
      if (!this.board.open) this.el.hint.style.opacity = this.hintOpacity;
    }
  }

  #hideHint() {
    if (this.hintHidden) return;
    this.hintHidden = true;
    this.el.hint.style.opacity = 0;
  }

  toast(text) {
    const el = h("div", { class: "toast" }, icons.check(), text);
    this.el.toasts.appendChild(el);
    setTimeout(() => {
      el.classList.add("is-out");
      el.addEventListener("animationend", () => el.remove());
    }, 4200);
  }
}

