/**
 * The shell: wires the globe to the chrome, the filters to both, and keeps the
 * breadcrumb honest about where you are.
 */
import { Globe } from "../globe/globe.js";
import { clamp, smoothstep } from "../globe/geo.js";
import { Network, emptyQuery, queryIsEmpty } from "../data/network.js";
import { Board } from "./board.js";
import { Filters } from "./filters.js";
import { ModalLayer, aboutModal, meetingsModal, needModal, pickUpModal, scheduleModal } from "./modals.js";
import { dashboardModal } from "./dashboard.js";
import { applicationsModal } from "./applications.js";
import { Panel } from "./panel.js";
import { PanelSheet } from "./sheet.js";
import { add, clear, h, icons, plural, svg, viewH } from "./dom.js";
import { openPop, menuIcons } from "./pop.js";
import { store } from "./store.js";
import { REVISION } from "three";
import { AuthGate } from "./auth.js";
import { questionnaireModal } from "./questionnaire.js";
import { ministryModal, postNeedModal as postNeedForm } from "./ministry.js";
import { Recommendations } from "./recommend.js";
import * as api from "../lib/api.js";
import { applyStyle } from "../style/applyStyle.js";
import { STYLE } from "../style/styleConfig.js";
// The stage, the flight off it and the landing look are the style editor's
// to change as well, so they live with the style (see landing.js).
import { STAGE, STAGE_EXIT, enterLanding, leaveLanding, returnToLanding } from "../style/landing.js";
import { pickVerse, verseText } from "../lib/verses.js";


/** How long after the loading screen lifts the headline lands. */
const HERO_IN_MS = 520;
/** How long the headline takes to lift away (base.css, hero-out). */
const HERO_OUT_MS = 780;

/**
 * A phone held upright. Here the page is the globe: no headline, a search
 * field across the top, a dock along the bottom and the sheet only when a pin
 * asks for it (chrome.css, "phone").
 */
const PHONE = window.matchMedia("(max-width: 720px)");

/** A count for a badge: past 99 it is just "lots". */
const badge = (n) => (n > 99 ? "99+" : String(n));
/**
 * The phone's whole-planet view: the disc filling the width the way a map
 * app's globe does, with a margin of space round it. (Semantic distance; the
 * portrait fit is applied on top.) Kept above the zoom where imagery is armed,
 * so the overview is the painted planet and fetches nothing.
 */
const PHONE_DIST = 3.35;

/** The camera for the stage at this window size. */
function stageFrame() {
  const W = window.innerWidth;
  const H = viewH();
  const rim = Math.max(STAGE.rim, STAGE.minRim / H);
  // A circle centred on the window's middle line, touching `rim` at the top
  // and passing through (0, H) and (W, H): with a = H - rim, the radius is
  // ((W/2)^2 + a^2) / 2a.
  const a = (1 - rim) * H;
  const R = ((W / 2) ** 2 + a ** 2) / (2 * a);
  const d = Math.min((2 * R) / H, STAGE.maxSize) * STAGE.scale;
  // The fov is vertical, so the disc's height on screen is tan(asin(1/dist))
  // over tan(fov/2), as a share of the window's.
  const tan = d * Math.tan((STYLE.camera.fov * Math.PI) / 360);
  return {
    // STAGE.x is to the right; the view offset's shift runs the other way.
    shift: -STAGE.x,
    // A view offset: negative lowers the centre, here to below the window.
    lift: 0.5 - (rim + d / 2),
    dist: 1 / Math.sin(Math.atan(tan)),
    home: STAGE.home,
    spin: STAGE.spin,
    rim: rim * H,
    x: STAGE.x * W,
  };
}

/** Where the headline hangs from: the rim, and the disc's centre line. */
function stageCss(stage) {
  const s = document.documentElement.style;
  s.setProperty("--stage-rim", `${stage.rim}px`);
  s.setProperty("--stage-x", `${stage.x}px`);
}

export class App {
  constructor() {
    // The look — sky, pins, labels — is STYLE, written into the page before
    // anything is drawn over it. The globe picks up its half when it starts.
    applyStyle();
    // Empty until the backend answers. ?demo loads the fictional set instead,
    // which is the only way to see a populated globe before anyone has posted.
    this.demo = new URLSearchParams(location.search).has("demo");
    this.net = new Network(this.demo ? Network.demoData() : undefined);
    this.session = null;
    this.profile = null;
    this.ministry = null;
    // Applications to this ministry's needs it has not opened yet.
    this.unseen = 0;
    this.query = emptyQuery();
    this.view = "globe";
    this.selected = null;
    this.suggestCursor = -1;

    this.el = {
      canvas: document.getElementById("globe"),
      overlay: document.getElementById("overlay"),
      hero: document.getElementById("hero"),
      hint: document.getElementById("hint"),
      credit: document.getElementById("credit"),
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
      chrome: document.querySelector(".chrome"),
    };

    this.modals = new ModalLayer(this.el.modals, { onToggle: () => this.#syncCovered() });
    this.panel = new Panel(this.el.panel, { net: this.net, on: this.#panelHandlers() });
    // "Search skills, needs or ministries" is 44 characters and a
    // phone shows about 28 of them, so the field advertises itself with a
    // truncated word. Swapped rather than shrunk: 16px is the floor below
    // which iOS zooms the whole page when the field takes focus.
    const narrow = window.matchMedia("(max-width: 720px)");
    const placeholder = () => {
      if (!this.el.search) return;
      this.el.search.placeholder = narrow.matches ? "Search skills or needs" : "Search skills, needs or ministries";
    };
    narrow.addEventListener("change", placeholder);
    placeholder();

    this.board = new Board(this.el.sheet, { net: this.net, on: this.#boardHandlers() });
    // After the board, because it reports its first detent immediately and
    // syncReserved reads every piece of chrome including the board's sheet.
    // Phones only; above the breakpoint it stands itself down.
    this.sheet = new PanelSheet(this.el.panel, {
      // The sheet is one of the rectangles the label layer has to keep clear
      // of, and its height changes on every drag, so the reserved list is
      // recomputed whenever it settles.
      onDetent: (_, px) => {
        this.sheetPx = px;
        this.#syncLift();
        this.syncReserved();
        this.#syncCovered();
      },
      // Dragged off the bottom of the screen: the same as its close button.
      onDismiss: () => this.panel.setOpen(false),
    });
    this.filtersUi = new Filters(this.el.filters, {
      net: this.net,
      query: this.query,
      onChange: () => {
        this.#leaveHero();
        this.applyQuery();
      },
    });
  }

  /* ----------------------------------------------------------------- boot */

  async start() {
    const boot = this.#boot();
    // The entrance state: headline, a find bar standing under it, and the
    // network figures where the panel will be. Everything settles once the
    // globe has flown in.
    // A phone has no entrance: the headline over a small disc is a web page,
    // and on a phone the planet is the page from the first frame.
    const phone = PHONE.matches;
    if (!phone) document.body.classList.add("is-hero");
    const stage = phone ? undefined : stageFrame();
    if (stage) {
      stageCss(stage);
      enterLanding();
    }
    this.panel.setOpen(false);
    this.#bindChrome();
    this.#bindKeys();

    this.globe = new Globe(this.el.canvas, {
      overlay: this.el.overlay,
      hero: stage,
      onProgress: (p, label) => boot.progress(p, label),
      onPinClick: (m) => {
        this.#leaveHero();
        this.openMinistry(m, { fly: true });
      },
      onGlobeClick: () => {
        if (document.body.classList.contains("is-hero")) return this.#leaveHero({ settle: true });
        this.#deselect();
      },
      onFirstGesture: () => {
        this.#leaveHero();
        this.#hideHint();
      },
      onCamera: (z) => this.#onCamera(z),
    });

    try {
      this.globe.setMinistries(this.net.ministries);
      await this.globe.start();
      this.#resumeLocation();
      this.globe.setMinistries(this.net.ministries);
      this.#renderHeroCount();
      this.#initCredit();
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
        // Every refresh rotates the token; keep the latest so switching back
        // to this account later works without a password.
        if (session && session.user.id === was) api.rememberAccount(session, this.profile);
        this.session = session;
        if ((session?.user?.id ?? null) !== was) this.#afterAuth({ quiet: true });
      });
    } else if (!api.isConfigured) {
      this.toast("No backend configured — showing an empty globe. See .env.example.");
    }

    this.panel.render(this.query);
    this.#renderCrumbs();
    this.#renderAccount();
    this.syncReserved();
    // Coalesced: a window drag-resize delivers a stream of these, and each one
    // measures a dozen chrome boxes. One measurement per frame is plenty, and
    // it keeps the reads out of the middle of the resize itself.
    // The find bar glides up out of the entrance for longer than the timed
    // re-measure waits, and a side card is placed from where it comes to rest.
    document.querySelector(".findbar")?.addEventListener("transitionend", (e) => {
      if (e.target === e.currentTarget && e.propertyName === "top") this.syncReserved();
    });
    let resizePending = 0;
    window.addEventListener("resize", () => {
      if (resizePending) return;
      resizePending = requestAnimationFrame(() => {
        resizePending = 0;
        this.syncReserved();
        this.#syncLift();
      });
    });
    await boot.done();
    document.body.classList.add("is-live");
    // The planet rises into place as the loading screen lifts, already
    // turning: from a little below where the stage puts its rim, with the
    // drift starting under it.
    if (document.body.classList.contains("is-hero")) this.#trackStage();
    if (document.body.classList.contains("is-hero")) {
      const home = this.globe.liftTarget;
      this.globe.setLift(home - STAGE.rise, { instant: true });
      this.globe.setLift(home, { ms: 2600 });
      this.globe.releaseSpin({ now: true });
    }

    // The world fades up where it stands and the headline lands just behind it,
    // so the two read as one arrival. Then it holds, and then the page settles
    // into the working view — the entrance's only camera move. Only the timer
    // brings the camera with it: someone who has already taken hold of the
    // globe has said where they want to be, and having it fly out from under
    // them is the rudest thing the page could do.
    // Someone who clicked through while it was still loading has already left.
    if (document.body.classList.contains("is-hero")) {
      this.heroInTimer = setTimeout(() => document.body.classList.add("hero-in"), HERO_IN_MS);
    } else if (phone && !this.globe.controls.gestured) {
      // The one camera move, straight away: the whole planet coming in to
      // fill the screen, already turning.
      this.globe.releaseSpin();
      this.globe.settle(undefined, { dist: PHONE_DIST });
    }
    // No timed exit: the landing screen holds until someone engages — a
    // click or drag on the globe, or a search submitted with Enter.

    if (!store.seen) {
      store.markSeen();
      // Not over the landing screen, where it would sit on the find bar's
      // suggestions: it waits for the working view, where it is about the map
      // in front of you.
      const note = "Fictional sample data — drag the globe to look around.";
      if (document.body.classList.contains("is-hero")) this.pendingNote = note;
      else setTimeout(() => this.toast(note), 3400);
    }
    return this;
  }

  #leaveHero({ settle = false } = {}) {
    if (!document.body.classList.contains("is-hero")) return;
    clearTimeout(this.heroTimer);
    clearTimeout(this.heroInTimer);
    document.body.classList.remove("is-hero");
    // The headline lifts away and fades (base.css, hero-out) rather than
    // going with the class: hero-in holds the words' resting state until it
    // is over. Words that never arrived have nothing to leave.
    clearTimeout(this.heroOutTimer);
    if (document.body.classList.contains("hero-in")) {
      document.body.classList.add("hero-out");
      this.heroOutTimer = setTimeout(() => document.body.classList.remove("hero-in", "hero-out"), HERO_OUT_MS);
    }
    // The landing look eases into the working one over the planet's flight.
    leaveLanding(STAGE_EXIT.ms);
    // The mask follows the disc until the words are gone.
    this.stageTrackUntil = performance.now() + HERO_OUT_MS;
    if (this.pendingNote) {
      const note = this.pendingNote;
      this.pendingNote = null;
      setTimeout(() => this.toast(note), 1600);
    }
    this.globe?.releaseDetail();
    // Whichever way the hero went, the opening frame is over and the globe is
    // free to turn again. On the timed exit the settle starts the turn itself;
    // on a gesture the drift picks it up once the hand comes off.
    this.globe?.releaseSpin();
    // Synchronously, in the same turn that drops the class the chrome
    // transitions on, so the bar starts rising and the globe starts moving
    // on the same frame. Either way the planet comes up to the centre and
    // lands at the same size: on the settle's flight, or — when a hand has
    // the globe — on a short ease of its own under the drag.
    if (settle) this.globe?.settle(STAGE_EXIT.ms, { dist: STAGE_EXIT.dist, turn: STAGE_EXIT.turn });
    else this.globe?.leaveStage({ dist: STAGE_EXIT.dist });
    // The panel is frosted glass over a live render, the most expensive thing
    // the page can slide across it; it comes in as the planet slows into
    // place rather than on the flight's opening frames, which are the ones
    // that decide whether the move reads as smooth.
    const panelIn = Math.round((settle ? STAGE_EXIT.ms : 1100) * 0.55);
    clearTimeout(this.panelInTimer);
    this.panelInTimer = setTimeout(() => {
      if (this.onLanding) return;
      this.panel.setOpen(true);
      this.syncReserved();
    }, panelIn);
    // Twice: once to give the ground the headline was holding straight back
    // to the pins, and again once the panel and the find bar have landed.
    this.syncReserved();
    setTimeout(() => this.syncReserved(), panelIn + 760);
  }

  /* ------------------------------------------------ the style editor's */

  /** Whether the landing screen is up. */
  get onLanding() {
    return document.body.classList.contains("is-hero");
  }

  /** Whether this window has a landing screen at all (a phone does not). */
  get hasLanding() {
    return !PHONE.matches;
  }

  /** Off the landing screen, exactly as a click on the globe takes you. */
  showMain() {
    this.#leaveHero({ settle: true });
  }

  /**
   * Back onto the landing screen from the working view, so its look can be
   * edited again: whatever is open closes, the planet flies back down to the
   * stage and the look blends back to the landing one.
   */
  showLanding() {
    if (this.onLanding || !this.hasLanding || !this.globe) return;
    clearTimeout(this.panelInTimer);
    this.#deselect();
    this.setView("globe");
    this.panel.setOpen(false);
    this.#hideSuggest();
    clearTimeout(this.heroOutTimer);
    document.body.classList.remove("hero-in", "hero-out");
    document.body.classList.add("is-hero");
    const stage = stageFrame();
    stageCss(stage);
    this.globe.enterStage(stage, { ms: STAGE_EXIT.ms * 0.7 });
    returnToLanding(STAGE_EXIT.ms * 0.7);
    this.#trackStage();
    this.heroInTimer = setTimeout(() => document.body.classList.add("hero-in"), STAGE_EXIT.ms * 0.35);
    this.syncReserved();
  }

  /**
   * Re-frames the landing planet after the stage has been edited. `fly`
   * also turns it back to the stage's own view, for a change of where it
   * faces.
   */
  restage({ fly = false } = {}) {
    if (!this.onLanding || !this.globe) return;
    const stage = stageFrame();
    stageCss(stage);
    if (fly) return this.globe.enterStage(stage, { ms: 1200 });
    this.globe.setShift(stage.shift, { instant: true });
    this.globe.setLift(stage.lift, { instant: true });
    this.globe.setStageDist(stage.dist);
    this.globe.controls.spinFloor = stage.spin;
  }

  /**
   * Keeps the landing headline masked by the planet, frame by frame, so the
   * disc stands in front of the words — as it rises in, on a resize, and as
   * it rises through them on the way out. The mask is a radial gradient in
   * the headline's own box (base.css), so the centre is measured from the box
   * as it is drawn, translate and all.
   */
  #trackStage() {
    const hero = this.el.hero;
    if (!hero || this.stageTracking) return;
    this.stageTracking = true;
    const step = () => {
      const live = document.body.classList.contains("is-hero") || performance.now() < (this.stageTrackUntil ?? 0);
      if (!live || !this.globe) {
        this.stageTracking = false;
        return;
      }
      const d = this.globe.discOnScreen();
      const box = hero.getBoundingClientRect();
      const x = Math.round(d.x - box.left);
      const y = Math.round(d.y - box.top);
      const r = Math.round(d.r);
      const key = `${x}|${y}|${r}`;
      if (key !== this.stageKey) {
        this.stageKey = key;
        hero.style.setProperty("--disc-x", `${x}px`);
        hero.style.setProperty("--disc-y", `${y}px`);
        hero.style.setProperty("--disc-r", `${r}px`);
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /**
   * The loading screen: the mark, a verse about serving, and the bar.
   *
   * The bar is paced rather than raw. The textures can land in well under a
   * second on a warm cache, and a bar that fills in three jumps and a screen
   * that is gone before the verse on it has been read make the one quiet
   * moment on the page feel like a flicker. So what is drawn is the real
   * progress, but never ahead of a steady clock that takes BOOT_MIN_MS to
   * run, eased as it goes; and done() waits for the drawn bar, not the load.
   */
  #boot() {
    const BOOT_MIN_MS = 4200;
    const fill = h("div", { class: "boot__fill" });
    const verse = pickVerse();
    const words = h("p", { class: "boot__verse" });
    const ref = h("div", { class: "boot__ref" });
    const quote = h("figure", { class: "boot__quote" }, words, ref);
    const veil = h(
      "div",
      { class: "boot" },
      h(
        "div",
        { class: "boot__inner" },
        h("img", { class: "boot__mark", src: "/brand/terra-logo-480.png", alt: "Terra", width: 480, height: 248 }),
        quote,
        h("div", { class: "boot__bar" }, fill),
      ),
    );
    document.body.appendChild(veil);
    // The words arrive when their text does — YouVersion's if it answers
    // quickly, the bundled KJV if not — never as a swap mid-read.
    verseText(verse).then(({ text, version }) => {
      words.textContent = text;
      ref.textContent = `${verse.ref} · ${version}`;
      quote.classList.add("is-in");
    });

    const t0 = performance.now();
    let real = 0;
    let shown = 0;
    let raf = 0;
    let finish = null;
    const tick = (now) => {
      const clock = Math.min((now - t0) / BOOT_MIN_MS, 1);
      // Ease-out on the clock: it moves off briskly and settles into the end.
      const paced = 1 - Math.pow(1 - clock, 2.2);
      const goal = Math.min(real, paced);
      shown += (goal - shown) * 0.12;
      if (goal - shown < 0.002) shown = goal;
      fill.style.width = `${(shown * 100).toFixed(2)}%`;
      if (finish && shown >= 0.999) {
        const done = finish;
        finish = null;
        // A beat on the full bar, then the screen goes.
        setTimeout(() => {
          veil.classList.add("is-done");
          done();
          setTimeout(() => veil.remove(), 1200);
        }, 320);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return {
      progress(p) {
        real = Math.max(real, clamp(p, 0, 1) * 0.94);
      },
      /** Resolves as the screen starts to leave. */
      done() {
        real = 1;
        return new Promise((resolve) => (finish = resolve));
      },
      fail(err) {
        cancelAnimationFrame(raf);
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
        if (PHONE.matches && this.globe) {
          // Out to the whole planet over wherever you are, rather than back
          // to the page's opening longitude: the Earth button in a map app.
          const c = this.globe.controls;
          this.globe.flyTo({ lat: clamp(c.lat, -30, 40), lon: c.lon, dist: PHONE_DIST, ms: 1100 });
        } else this.globe?.reset();
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
      else if (action === "menu") this.#menu(trigger);
      else if (action === "open-board") this.setView(this.board.open ? "globe" : "needs");
      else if (action === "join") this.#join();
      else if (action === "near-me") this.#nearMe();
      else if (action === "toggle-filters") this.#toggleFilters();
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
    search.addEventListener("focus", () => this.#renderSuggest());
    search.addEventListener("blur", () => setTimeout(() => this.#hideSuggest(), 140));
    search.addEventListener("keydown", (e) => this.#suggestKeys(e));
    document.getElementById("searchGo")?.addEventListener("click", () => {
      if (search.value.trim()) this.#submitSearch();
      else search.focus();
    });
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
    });
  }

  #menu(anchor) {
    const saved = store.interestCount + store.posted.length;
    openPop({
      anchor,
      parent: this.el.chrome,
      items: [
        { label: "About this map", note: "How the globe is drawn", icon: menuIcons.info, run: () => this.setView("about") },
        { label: "Open needs board", icon: menuIcons.board, kbd: "B", run: () => this.setView("needs") },
        // On a phone there is no side panel, only the sheet a pin brings up;
        // what stands in for the rail's summary is the network in that sheet.
        PHONE.matches
          ? { label: "Network summary", note: "Every open need, in figures", icon: menuIcons.panel, run: () => { this.panel.showNetwork(); this.panel.render(this.query); this.sheet.setDetent("half"); } }
          : {
              label: this.panel.open ? "Hide the side panel" : "Show the side panel",
              icon: menuIcons.panel,
              run: () => this.panel.setOpen(!this.panel.open),
            },
        // SANDBOX START — the temporary Style Sandbox's menu entry; present only
        // while src/sandbox/style/ exists (see main.js and REMOVAL.md there).
        ...(window.terraStyleEditor
          ? [
              {
                label: window.terraStyleEditor.open ? "Hide the style editor" : "Style editor",
                note: "Tune the globe and background live",
                icon: menuIcons.theme,
                run: () => window.terraStyleEditor.toggle(),
              },
            ]
          : []),
        // SANDBOX END
        null,
        { label: "Show where I am", note: "A blue dot at your location", icon: menuIcons.locate, run: () => this.#nearMe() },
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
        imagery: stats.imagery,
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

  /** The landing headline's pill: whole-network figures, in a sentence. */
  #renderHeroCount() {
    const el = document.getElementById("heroCount");
    const stats = this.net.stats();
    if (el && stats.needs) {
      el.textContent = `${plural(stats.needs, "open need", "open needs")} · ${plural(this.net.ministries.length, "ministry", "ministries")}`;
    }
  }

  /* ------------------------------------------------------------- backend */

  /** Pulls the public network and rebuilds every derived view from it. */
  async reloadNetwork() {
    try {
      const data = await api.loadNetwork();
      this.net.setData(data);
      this.globe?.setMinistries(this.net.ministries);
      this.applyQuery();
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
    if (this.session) api.rememberAccount(this.session, this.profile);

    // Finishing a link started from the other account: this is the new
    // (or newly signed-in) account arriving, so the two are joined now.
    if (this.session && api.pendingLink()) {
      try {
        if (await api.completeLink()) this.toast("Accounts linked. Switch between them from your account menu.");
      } catch (e) {
        this.toast(e.message);
      }
    }
    this.linked = this.session ? await api.linkedAccounts().catch(() => []) : [];
    this.unseen = 0;
    this.#renderAccount();
    this.#watchApplications();

    if (!this.session) return;
    if (!quiet) this.toast(`Signed in as ${this.profile?.full_name || this.session.user.email}`);

    // Each account is onboarded once, after a beat — immediately on top of a
    // sign-in reads as a second gate. A volunteer answers the questions; a
    // ministry tells us who it is, which fills in everything it posts.
    this.onboarded ??= new Set();
    const id = this.session.user.id;
    if (this.onboarded.has(id)) return;
    this.onboarded.add(id);
    if (this.profile?.role === "volunteer") {
      const existing = await api.loadQuestionnaire();
      if (!existing) setTimeout(() => this.openQuestionnaire(), 900);
    } else if (this.profile?.role === "ministry" && !this.ministry) {
      setTimeout(() => this.openMinistrySetup(), 900);
    }
  }

  /** Links a second account to this one: a personal account, or a ministry. */
  startLink(role) {
    if (!this.session) return;
    api.beginLink(this.session.user.id, role);
    const from = this.ministry?.name || this.profile?.full_name || "this account";
    this.gate.open("signup", {
      role,
      title: role === "ministry" ? "Create your ministry account" : "Create your personal account",
      sub: `It stays linked to ${from}, so you can switch in one click. Use a different email address, or sign in if you already have one.`,
      onCancel: () => api.cancelLink(),
    });
  }

  async switchTo(other) {
    try {
      await api.switchAccount(other.id);
      // onAuthChange notices the new user and runs #afterAuth.
      this.toast(other.role === "ministry" ? "Switched to your ministry account." : "Switched to your personal account.");
    } catch (e) {
      if (!e.needsSignIn) return this.toast(e.message);
      this.gate.open("signin", {
        role: other.role,
        email: e.email ?? "",
        title: other.role === "ministry" ? "Sign in to your ministry account" : "Sign in to your personal account",
        sub: "You only need to do this once on this device. After that, switching is one click.",
      });
    }
  }

  openDashboard() {
    if (!this.session) return this.gate.open("signin");
    dashboardModal(this.modals, {
      load: () => api.ministryDashboard(),
      onSetStatus: async (id, status) => {
        await api.setNeedStatus(id, status);
        await this.reloadNetwork();
      },
      onPost: () => this.postNeed(),
      onShowNeed: (id) => {
        const n = this.net.needById(id);
        if (n) this.openNeed(n, { fly: true });
      },
      // Back to the list once saved, so the new state — live, or held for
      // review — is the first thing seen.
      onEdit: (n) => this.editNeed(n, { after: () => this.openDashboard() }),
    });
  }

  /** Who applied to which need, and what they sent; see applications.js. */
  openApplications() {
    if (!this.session) return this.gate.open("signin");
    applicationsModal(this.modals, {
      load: () => api.ministryDashboard(),
      onSeen: (needId, userId) => {
        this.unseen = Math.max(0, this.unseen - 1);
        this.#renderAccount();
        api.markApplicationSeen(needId, userId).catch((e) => console.warn("[terra] could not mark seen", e));
      },
    });
  }

  /**
   * Keeps the count on the account chip current while a ministry is signed
   * in: on sign-in, every minute the tab is in view, and whenever it comes
   * back into view. A rise after the first look gets a toast as well.
   */
  #watchApplications() {
    clearInterval(this.unseenTimer);
    this.unseenTimer = null;
    if (!this.session || this.profile?.role !== "ministry" || !this.ministry) return;
    let first = true;
    const check = async () => {
      if (document.hidden || this.profile?.role !== "ministry") return;
      const n = await api.unseenApplications().catch(() => null);
      if (n == null || n === this.unseen) return (first = false);
      if (!first && n > this.unseen) this.toast(n - this.unseen === 1 ? "Someone just applied to one of your needs." : `${n - this.unseen} new applications.`);
      first = false;
      this.unseen = n;
      this.#renderAccount();
    };
    check();
    this.unseenTimer = setInterval(check, 60000);
    if (!this.unseenWake) {
      this.unseenWake = () => this.unseenTimer && !document.hidden && check();
      document.addEventListener("visibilitychange", this.unseenWake);
    }
  }

  /**
   * Edits one of the signed-in ministry's own needs: the post form, filled in,
   * saved through the same check a new post goes through.
   */
  async editNeed(need, { after } = {}) {
    if (!api.isConfigured || !this.session) return this.gate?.open("signin");
    if (!this.ministry) this.ministry = await api.myMinistry();
    if (!this.ministry) return;
    postNeedForm(this.modals, {
      ministry: this.ministry,
      need,
      onPosted: async () => {
        await this.reloadNetwork();
        after?.();
      },
    });
  }

  /** The chip in the top bar: sign in, or who you are. */
  #renderAccount() {
    this.#renderPhoneAccount();
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
    const isMinistry = this.profile?.role === "ministry";
    const name = isMinistry && this.ministry ? this.ministry.name : this.profile?.full_name || this.session.user.email || "You";
    // Their own logo or photo if they have added one; otherwise just the name.
    const picture = isMinistry ? this.ministry?.logo : this.profile?.avatar_url;
    slot.appendChild(
      h("button", { class: `acct${isMinistry ? " acct--ministry" : ""}${picture ? "" : " acct--bare"}`, "data-action": "account", title: this.session.user.email },
        picture ? h("img", { class: "acct__pic", src: picture, alt: "" }) : null,
        h("span", { class: "acct__name", text: isMinistry ? name : name.split(" ")[0] }),
        this.linked?.length ? h("span", { class: "acct__role", text: isMinistry ? "Ministry" : "Personal" }) : null,
        isMinistry && this.unseen ? h("span", { class: "acct__badge", "aria-label": `${this.unseen} new applications`, text: badge(this.unseen) }) : null,
      ),
    );
  }

  /**
   * The phone's two account affordances: a round picture inside the search
   * field (or a person, to sign in), and the dock's third button, which is
   * Join until there is someone to join and then goes to what is theirs.
   */
  #renderPhoneAccount() {
    const me = document.getElementById("searchMe");
    const join = document.getElementById("dockJoin");
    const isMinistry = this.profile?.role === "ministry";
    if (join) {
      const label = !this.session ? "Join" : isMinistry ? "Yours" : "For you";
      join.querySelector("span").textContent = label;
      join.setAttribute("aria-label", !this.session ? "Create an account" : isMinistry ? "Your needs" : "Suggested for you");
    }
    if (!me) return;
    clear(me);
    if (!api.isConfigured) return;
    if (!this.session) {
      me.appendChild(
        h("button", { class: "search__me-btn", "data-action": "sign-in", "aria-label": "Sign in" },
          svg("0 0 20 20", '<circle cx="10" cy="7.2" r="3.2"/><path d="M3.8 16.6c.8-3.2 3.2-4.9 6.2-4.9s5.4 1.7 6.2 4.9"/>'),
        ),
      );
      return;
    }
    const name = (isMinistry && this.ministry?.name) || this.profile?.full_name || this.session.user.email || "You";
    const picture = isMinistry ? this.ministry?.logo : this.profile?.avatar_url;
    me.appendChild(
      h("button", { class: "search__me-btn is-signed", "data-action": "account", "aria-label": `Account: ${name}` },
        picture ? h("img", { src: picture, alt: "" }) : h("span", { text: name.trim().charAt(0).toUpperCase() }),
      ),
    );
    if (isMinistry && this.unseen) me.appendChild(h("span", { class: "acct__badge acct__badge--float", text: badge(this.unseen) }));
  }

  /** The dock's Join: an account if there is none, otherwise what is theirs. */
  #join() {
    if (!api.isConfigured) return this.toast("Accounts need the live site — this is the demo.");
    if (!this.session) return this.gate?.open("signup");
    if (this.profile?.role === "ministry") return this.ministry ? this.openDashboard() : this.openMinistrySetup();
    this.openSuggestions();
  }

  /**
   * Flies to where you are, at region height, and puts a blue dot there that
   * follows you for the rest of the visit. The first press asks the browser;
   * after that the dot is kept current by watchPosition.
   */
  #nearMe() {
    if (!navigator.geolocation) return this.toast("This browser cannot share its location.");
    this.#leaveHero();
    if (this.here) return this.#flyHere();
    for (const b of document.querySelectorAll('[data-action="near-me"]')) b.classList.add("is-busy");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        this.#setHere(pos);
        this.#flyHere();
        this.#watchHere();
      },
      (err) => {
        for (const b of document.querySelectorAll('[data-action="near-me"]')) b.classList.remove("is-busy");
        this.toast(err.code === err.PERMISSION_DENIED ? "Location is off for this site. Allow it in your browser's settings." : "Could not find where you are just now.");
      },
      { enableHighAccuracy: true, maximumAge: 60000, timeout: 10000 },
    );
  }

  #flyHere() {
    this.globe?.focus({ lat: this.here.lat, lon: this.here.lon }, { zoom: 0.5 });
  }

  #setHere(pos) {
    this.here = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy };
    this.globe?.setUserLocation(this.here);
    for (const b of document.querySelectorAll('[data-action="near-me"]')) {
      b.classList.remove("is-busy");
      b.classList.add("is-on");
    }
  }

  #watchHere() {
    if (this.hereWatch != null) return;
    this.hereWatch = navigator.geolocation.watchPosition(
      (pos) => this.#setHere(pos),
      () => {},
      { enableHighAccuracy: true, maximumAge: 30000 },
    );
  }

  /**
   * Someone who has already let the site see their location gets the dot back
   * on the next visit without pressing anything — but no flight: where the
   * globe opens is still the landing's to decide.
   */
  async #resumeLocation() {
    try {
      const state = await navigator.permissions?.query({ name: "geolocation" });
      if (state?.state !== "granted") return;
      navigator.geolocation.getCurrentPosition((pos) => {
        this.#setHere(pos);
        this.#watchHere();
      }, () => {}, { maximumAge: 300000, timeout: 10000 });
    } catch {
      // Safari before 16 has no permissions API; the button still works.
    }
  }

  /** The filter chips are a row you call up on a phone, not a fixture. */
  #toggleFilters(open = !document.body.classList.contains("filters-open")) {
    document.body.classList.toggle("filters-open", open);
    document.getElementById("filtersBtn")?.setAttribute("aria-pressed", String(open));
    this.syncReserved();
  }

  /**
   * On a phone, raises the globe into the room left above the sheet, so the
   * city a pin was tapped on stays in sight instead of going under the card
   * that describes it. Centred in the gap between the search field and the
   * sheet's top edge.
   */
  #syncLift() {
    if (!this.globe) return;
    // The stage holds the planet low while the landing screen is up, and
    // follows the window: the rim is a share of its height.
    if (document.body.classList.contains("is-hero") && !PHONE.matches) {
      const stage = stageFrame();
      stageCss(stage);
      this.globe.setShift(stage.shift, { instant: true });
      return this.globe.setLift(stage.lift, { instant: true });
    }
    const open = PHONE.matches && this.panel.open && !this.board.open;
    if (!open) return this.globe.setLift(0);
    const H = viewH();
    const top = document.querySelector(".findbar")?.getBoundingClientRect().bottom ?? 0;
    const sheet = Math.min(this.sheetPx ?? H * 0.5, H * 0.6);
    const mid = (top + H - sheet) / 2;
    this.globe.setLift(clamp(0.5 - mid / H, 0, 0.3));
  }

  #accountMenu(anchor) {
    const isMinistry = this.profile?.role === "ministry";
    openPop({
      anchor,
      parent: this.el.chrome,
      items: [
        { label: (isMinistry && this.ministry?.name) || this.profile?.full_name || this.session.user.email, note: isMinistry ? "Ministry account" : "Personal account", icon: menuIcons.info },
        ...(this.linked ?? []).map((other) => ({
          label: other.role === "ministry" ? "Switch to ministry account" : "Switch to personal account",
          note: other.name || other.email || "Linked account",
          icon: menuIcons.panel,
          run: () => this.switchTo(other),
        })),
        !this.linked?.length && isMinistry && { label: "Create your personal account", note: "Serve as yourself, linked to this ministry", icon: menuIcons.panel, run: () => this.startLink("volunteer") },
        !this.linked?.length && !isMinistry && { label: "Set up a ministry account", note: "Linked to this one", icon: menuIcons.panel, run: () => this.startLink("ministry") },
        null,
        isMinistry && this.ministry && {
          label: "Applications",
          note: this.unseen ? `${plural(this.unseen, "new application")}` : "Who applied, and what they sent",
          icon: menuIcons.inbox,
          badge: this.unseen ? badge(this.unseen) : null,
          run: () => this.openApplications(),
        },
        isMinistry && this.ministry && { label: "Your needs", note: "Posts and who responded", icon: menuIcons.board, run: () => this.openDashboard() },
        { label: "Your calls", note: "Upcoming video calls", icon: menuIcons.board, run: () => this.openMeetings() },
        !isMinistry && { label: "Suggested for you", note: "Matched to your answers", icon: menuIcons.board, run: () => this.openSuggestions() },
        !isMinistry && { label: "Answer the five questions", icon: menuIcons.panel, run: () => this.openQuestionnaire() },
        isMinistry && !this.ministry && { label: "Put your ministry on the map", icon: menuIcons.panel, run: () => this.openMinistrySetup() },
        isMinistry && this.ministry && { label: "Post a need", icon: menuIcons.board, run: () => this.postNeed() },
        null,
        (!isMinistry || this.ministry) && {
          label: isMinistry ? (this.ministry.logo ? "Change logo" : "Upload a logo") : this.profile?.avatar_url ? "Change photo" : "Upload a photo",
          note: "Shown beside your name",
          icon: menuIcons.panel,
          run: () => this.pickAvatar(),
        },
        (isMinistry ? this.ministry?.logo : this.profile?.avatar_url) && {
          label: isMinistry ? "Remove logo" : "Remove photo",
          icon: menuIcons.trash,
          run: () => this.saveAvatar(null),
        },
        null,
        { label: "Sign out", icon: menuIcons.trash, run: async () => { await api.signOut(); this.session = null; this.profile = null; this.ministry = null; this.unseen = 0; this.#watchApplications(); this.#renderAccount(); this.toast("Signed out."); } },
      ].filter((x) => x !== false),
    });
  }

  /** Chooses an image for the account chip; see api.setAvatar. */
  pickAvatar() {
    const input = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif,image/svg+xml" });
    input.addEventListener("change", () => input.files[0] && this.saveAvatar(input.files[0]));
    input.click();
  }

  async saveAvatar(file) {
    const isMinistry = this.profile?.role === "ministry";
    const opts = { ministryId: isMinistry ? this.ministry?.id : null };
    try {
      const url = file ? await api.setAvatar(file, opts) : await api.removeAvatar(opts);
      if (isMinistry) this.ministry = { ...this.ministry, logo: url };
      else this.profile = { ...this.profile, avatar_url: url };
      this.#renderAccount();
      this.toast(file ? (isMinistry ? "Logo updated." : "Photo updated.") : isMinistry ? "Logo removed." : "Photo removed.");
    } catch (e) {
      this.toast(e.message || "Could not update the picture.");
    }
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
        this.#renderAccount();
        this.toast(`${m.name} is on the map.`);
        await this.reloadNetwork();
        this.postNeed();
      },
    });
  }

  /* --------------------------------------------------------------- query */

  applyQuery() {
    this.#renderHeroCount();
    this.panel.render(this.query);
    if (this.board.open) this.board.render(this.query);
    this.globe?.setDimmed(this.net.excluded(this.query));
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

  /**
   * The list under the search bar: the needs that match, best first, as you
   * type — then a few other things the text could mean (a skill, a
   * ministry, a filter). Enter with nothing highlighted submits the search:
   * the page settles into the working view and the list stays open.
   */
  #renderSuggest() {
    const text = this.el.search.value.trim();
    const box = this.el.suggest;
    clear(box);
    this.suggestRows = [];
    this.suggestCursor = -1;
    if (text.length < 2) {
      box.hidden = true;
      return;
    }

    const results = this.net.select(this.query);
    const needRows = results.slice(0, 6).map((n) => ({ kind: "need", need: n }));
    const others = this.net.suggest(text, 6).filter((r) => r.kind !== "need").slice(0, 4);
    this.suggestRows = [...needRows, ...others];

    const row = (r) => {
      if (r.kind === "need") {
        const n = r.need;
        return h(
          "button",
          { class: "suggest__row result", onclick: () => this.#takeSuggestion(r) },
          h("span", { class: `dot dot--${n.urgency}` }),
          h("span", { class: "result__text" },
            h("b", { text: n.title }),
            h("small", { text: `${n.ministryName} · ${n.city}` }),
          ),
          h("span", { class: "result__meta", text: n.commitment || "" }),
        );
      }
      return h(
        "button",
        { class: "suggest__row", onclick: () => this.#takeSuggestion(r) },
        h("span", { class: "suggest__kind", text: r.kind }),
        h("b", { text: r.label }),
        h("span", { text: r.note }),
      );
    };

    box.appendChild(
      h("div", { class: "suggest__group ml" },
        results.length ? `${results.length} open need${results.length === 1 ? "" : "s"}` : "No open needs match",
      ),
    );
    needRows.forEach((r) => box.appendChild(row(r)));
    if (results.length > needRows.length) {
      box.appendChild(
        h("button", { class: "suggest__more", onclick: () => { this.#hideSuggest(); this.setView("needs"); } },
          `See all ${results.length} on the needs board →`),
      );
    }
    if (others.length) {
      box.appendChild(h("div", { class: "suggest__group ml", text: "Also try" }));
      others.forEach((r) => box.appendChild(row(r)));
    }
    box.hidden = false;
  }

  /** Enter: take the search into the working view, results still showing. */
  #submitSearch() {
    this.#leaveHero({ settle: true });
    this.applyQuery();
    this.#renderSuggest();
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
    if (e.key === "Enter") {
      e.preventDefault();
      if (this.suggestCursor >= 0 && rows[this.suggestCursor]) this.#takeSuggestion(rows[this.suggestCursor]);
      else if (this.el.search.value.trim()) this.#submitSearch();
      return;
    }
    if (!rows.length || this.el.suggest.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      this.suggestCursor = (this.suggestCursor + dir + rows.length) % rows.length;
      const items = [...this.el.suggest.querySelectorAll(".suggest__row")];
      items.forEach((el, i) => el.classList.toggle("is-cursor", i === this.suggestCursor));
      items[this.suggestCursor]?.scrollIntoView({ block: "nearest" });
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
      this.openNeed(row.need, { fly: true });
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
      openNeed: (need) => this.openNeed(need, { fly: true }),
      clearFilters: () => this.clearFilters(),
      layoutChanged: () => {
        // On a phone the sheet's close button means "done with this place".
        if (PHONE.matches && !this.panel.open && this.selected) this.#deselect();
        this.#syncLift();
        setTimeout(() => this.syncReserved(), 480);
      },
    };
  }

  #boardHandlers() {
    return {
      postNeed: (ministryId) => this.postNeed(ministryId),
      openNeed: (need) => this.openNeed(need),
      clearFilters: () => this.clearFilters(),
      query: () => this.query,
      // The board's categories edit the shared query in place; the chips, the
      // search field and the globe are brought into line with it here.
      queryChanged: () => {
        this.el.search.value = this.query.text;
        this.el.clearSearch.hidden = !this.query.text;
        this.filtersUi.render();
        this.applyQuery();
      },
      boardToggled: (open) => {
        document.body.classList.toggle("board-open", open);
        this.#syncLift();
        this.#syncCovered();
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
    if (PHONE.matches) this.sheet.setDetent("half");
    // All the way in: choosing a ministry is choosing a city, not a region.
    if (fly) this.globe?.focus(full, { zoom: 1 });
    this.#renderCrumbs();
  }

  /**
   * `fly` takes the globe to the ministry first and stands the need beside
   * its pin, rather than over a blurred world — for picks made from the
   * panel and the search, where the map is the context.
   */
  openNeed(need, { fly = false } = {}) {
    const fresh = this.net.needById(need.id) ?? need;
    const m = fly ? this.net.ministryById.get(fresh.ministry) : null;
    if (m) {
      this.#leaveHero();
      this.openMinistry(m, { fly: true });
    }
    needModal(this.modals, fresh, {
      onPickUp: (n) => this.openPickUp(n),
      onDrop: (n) => {
        this.net.toggleInterest(n.id);
        this.#afterDataChange();
        if (this.session) api.withdrawInterest(n.id).catch(() => {});
        this.toast("Interest withdrawn.");
      },
      onMinistry: (n) => {
        const m = this.net.ministryById.get(n.ministry);
        if (m) this.openMinistry(m, { fly: true });
      },
      onSchedule: api.isConfigured ? (n) => this.openSchedule(n) : null,
      // Only on the ministry's own needs.
      onEdit: this.ministry && fresh.ministry === this.ministry.id ? (n) => this.editNeed(n) : null,
    }, { side: !!m });
  }

  /**
   * The application behind "Serve". Written to the browser either way,
   * and to the database as well when there is somebody to attribute it to: a
   * signed-out visitor can still answer and share links, just not upload.
   */
  openPickUp(need) {
    const live = api.isConfigured && !this.demo;
    pickUpModal(this.modals, this.net.needById(need.id) ?? need, {
      canUpload: live && !!this.session,
      onSignIn: live ? () => this.gate.open("signin") : null,
      onSubmit: async (answers) => {
        if (this.session) await api.expressInterest(need.id, answers);
        this.net.toggleInterest(need.id, { ...answers, files: answers.files.map((f) => f.name) });
        this.#afterDataChange();
        this.toast(
          this.session
            ? `Sent — ${need.ministryName} can see your answers.`
            : `Saved in this browser. Sign in so ${need.ministryName} can see it.`,
        );
      },
    });
  }

  /** Book a first video call about a need; signing in comes first. */
  openSchedule(need) {
    if (!this.session) {
      this.toast("Sign in to book a call with the ministry.");
      return this.gate.open("signup");
    }
    scheduleModal(this.modals, this.net.needById(need.id) ?? need, {
      onBook: (fields) => api.scheduleMeeting(fields),
    });
  }

  openMeetings() {
    if (!this.session) return this.gate.open("signin");
    meetingsModal(this.modals, {
      load: () => api.myMeetings(),
      onOpenNeed: (id) => {
        const n = this.net.needById(id);
        if (n) this.openNeed(n, { fly: true });
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
    // The headline's ground is spoken for: a pin there would be half-hidden
    // behind a letterform. Both boxes hug their text — the container is
    // wider than either line.
    if (document.body.classList.contains("is-hero")) push(document.querySelector(".hero__title"), 0);
    // The filter row is a full-width flex container with its chips centred,
    // so its bounding box reserves ground the chips never occupy — enough of
    // it, at the whole-globe view, to swallow the pins either side of them.
    for (const chip of document.querySelectorAll(".filters .chip")) push(chip, 3);
    push(document.querySelector(".dial"));
    push(document.querySelector(".hint"), 3);
    push(this.el.grabber, 4);
    push(document.querySelector(".dock"), 4);
    for (const fab of document.querySelectorAll(".fabs .fab")) push(fab, 4);
    if (this.panel.open) push(this.el.panel);
    if (this.board.open) push(this.el.sheet);
    this.globe?.setReserved(rects);
    // A side card starts below the find bar, so it never covers the search or
    // a chip. The bar's height follows its chips, which wrap, so it is
    // measured rather than assumed.
    const find = document.querySelector(".findbar")?.getBoundingClientRect();
    if (find?.height) document.documentElement.style.setProperty("--find-bottom", `${Math.round(find.bottom)}px`);
  }

  #deselect() {
    if (!this.selected) return;
    this.selected = null;
    this.globe?.select(null);
    this.globe?.setSpin(true);
    if (PHONE.matches) {
      // The sheet goes away with the place; the network summary is one tap
      // away on the dock, and on a phone the map is the summary.
      this.panel.mode = "network";
      this.panel.ministry = null;
      if (this.panel.open) this.panel.setOpen(false);
    } else {
      this.panel.showNetwork();
    }
    this.panel.render(this.query);
    this.#renderCrumbs();
  }

  /**
   * The imagery credit. Every provider requires attribution while their tiles
   * are on screen, and none of them requires it while they are not — so it
   * rides the same fade the imagery does rather than standing there over a
   * globe that is still entirely painted.
   */
  /**
   * Tells the globe when nothing of it is on screen.
   *
   * A full-height sheet or a dialog on a phone leaves the renderer drawing a
   * planet — the heaviest thing on the page — underneath something opaque, at
   * sixty frames a second, while a finger is trying to scroll the thing on
   * top. That is most of why the list stuttered. On a desktop the board is a
   * card in the middle of a visible globe, so none of this applies.
   */
  #syncCovered() {
    const phone = window.matchMedia("(max-width: 720px)").matches;
    const covered =
      !!this.modals?.covers ||
      (phone && (!!this.board?.open || document.body.classList.contains("sheet-full")));
    this.globe?.setCovered(covered);
  }

  #initCredit() {
    const text = this.globe?.imagery?.attribution;
    if (!text || !this.el.credit) return;
    this.el.credit.textContent = text;
    this.el.credit.hidden = false;
  }

  #onCamera(z) {
    if (!this.hintHidden) {
      this.hintOpacity = 1 - smoothstep(0.05, 0.3, z);
      if (!this.board.open) this.el.hint.style.opacity = this.hintOpacity;
    }
    if (this.el.credit && !this.el.credit.hidden) {
      // Rounded, because this runs on every camera frame and writing an
      // unchanged string is still a style invalidation.
      const on = Math.round(clamp(this.globe.detailMix * 1.6, 0, 1) * 20) / 20;
      if (on !== this.creditOn) {
        this.creditOn = on;
        this.el.credit.style.setProperty("--credit-on", on);
      }
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

