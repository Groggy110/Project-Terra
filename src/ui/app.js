/**
 * The shell: wires the globe to the chrome, the filters to both, and keeps the
 * breadcrumb honest about where you are.
 */
import { Globe } from "../globe/globe.js";
import { clamp, smoothstep } from "../globe/geo.js";
import { Network, emptyQuery, queryIsEmpty } from "../data/network.js";
import { Board } from "./board.js";
import { Filters } from "./filters.js";
import { ModalLayer, aboutModal, meetingsModal, pickUpModal, scheduleModal } from "./modals.js";
import { dashboardModal } from "./dashboard.js";
import { applicationsModal } from "./applications.js";
import { AskPanel } from "./ask.js";
import { clearChats } from "./chats.js";
import { LocalPicker, placeLabel } from "./local.js";
import { add, clear, h, icons, plural, svg, viewH } from "./dom.js";
import { openPop, menuIcons } from "./pop.js";
import { store } from "./store.js";
import { REVISION } from "three";
import { AuthGate } from "./auth.js";
import { ministryModal, postNeedModal as postNeedForm } from "./ministry.js";
import * as api from "../lib/api.js";
import { areaName, findLocalOrgs, locateAddress } from "../lib/places.js";
import { placeAsked, primePlaces } from "../data/places.js";
import { applyStyle } from "../style/applyStyle.js";
import { STYLE } from "../style/styleConfig.js";
// The stage, the flight off it and the landing look are the style editor's
// to change as well, so they live with the style (see landing.js).
import { STAGE, STAGE_EXIT, enterLanding, leaveLanding, returnToLanding } from "../style/landing.js";

/** "Santa Barbara, United States of America"; a country by itself. */
const placeName = (p) => (p.country && p.kind !== "country" ? `${p.name}, ${p.country}` : p.name);

/** How long the headline takes to lift away (base.css, hero-out). */
const HERO_OUT_MS = 780;

/**
 * The opening (App #arrive). The words land this long after the planet
 * starts to rise: far enough behind that the world is plainly arriving first,
 * close enough that the two read as one move.
 */
const WORDS_AFTER_MS = 200;
/** The longest the words wait for the planet before landing without it. */
const OPEN_WAIT_MS = 4000;
/** How long the planet waits for the network, so its pins and count arrive with it. */
const NETWORK_WAIT_MS = 300;
/**
 * When the heavy downloads that only sharpen the planet (the 8K maps, the
 * photographic clouds) begin: once the entrance has finished moving, so they
 * neither share the line with the maps the opening waits on nor land a decode
 * in the middle of it.
 */
const DEFERRED_AFTER_MS = 3200;

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

/** How many needs the serve-locally guide reads at once (its own cap). */
const LOCAL_POOL = 160;

/** Great-circle distance between two { lat, lon }, in miles. */
function distanceMiles(a, b) {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

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
  const rim = `${stage.rim}px`;
  const x = `${stage.x}px`;
  // Moves the headline: its box has to be measured again (#trackStage).
  if (s.getPropertyValue("--stage-rim") !== rim || s.getPropertyValue("--stage-x") !== x) heroMoved = true;
  s.setProperty("--stage-rim", rim);
  s.setProperty("--stage-x", x);
}

/** The headline's box has changed since it was last measured. */
let heroMoved = true;

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

    this.el = {
      canvas: document.getElementById("globe"),
      overlay: document.getElementById("overlay"),
      hero: document.getElementById("hero"),
      hint: document.getElementById("hint"),
      tip: document.getElementById("tip"),
      credit: document.getElementById("credit"),
      crumbs: document.getElementById("crumbs"),
      nav: document.getElementById("nav"),
      filters: document.getElementById("filters"),
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
    // There is no side rail: a ministry opens in the conversation. The chrome
    // keeps the layout it had with the rail closed.
    document.body.classList.add("no-panel");
    this.ask = new AskPanel({
      net: this.net,
      ask: api.isConfigured ? (args) => api.askTerra(args) : null,
      // A pick stays in the conversation: the globe goes to the ministry and
      // lights its pin, but no panel or popup opens beside it.
      onGo: async (text) => {
        const place = await placeAsked(text, { bare: false });
        if (!place) return null;
        this.#travelTo(place, { chat: true });
        return `Here's ${placeName(place)}.`;
      },
      onFlyTo: (need) => {
        const m = this.net.ministryById.get(need.ministry);
        if (!m) return;
        this.selected = m;
        this.globe?.select(m.id);
        this.globe?.setSpin(false);
        this.globe?.focus(m, { zoom: 1 });
      },
      // A find from a local organisation's website: the globe goes to its
      // address and its marker is lit and named. null when its card is closed.
      onPlace: (w) => this.#showFound(w),
      // Applying, booking a call and signing in all happen in the
      // conversation, as cards in the thread rather than dialogs over it.
      onServe: (need) => {
        if (!need.taken) return this.openPickUp(need, { chat: true });
        this.net.toggleInterest(need.id);
        this.#afterDataChange();
        if (this.session) api.withdrawInterest(need.id).catch(() => {});
        this.toast("Interest withdrawn.");
      },
      onSchedule: api.isConfigured ? (need) => this.openSchedule(need, { chat: true }) : null,
      // Quiet, and no onboarding dialog over the conversation: it says
      // "You're signed in" itself, and the questions can wait for next time.
      onSignedIn: () => this.#afterAuth({ quiet: true, onboard: false }),
      onResults: (needs) => this.#askResults(needs),
      onMinistry: (need) => {
        const m = this.net.ministryById.get(need.ministry);
        if (m) this.openMinistry(m, { fly: true });
      },
      onEdit: (need) => (this.ministry && need.ministry === this.ministry.id ? () => this.editNeed(need) : null),
      // A ministry's card closed: its pin lets go too, if it is the one chosen.
      onLeave: (m) => {
        if (this.selected?.id === m.id) this.#deselect();
      },
      onPost: (text) => this.postNeed({ said: text }),
      // A new chat clears the radius card with everything else.
      onReset: () => this.#endLocal(),
      onToggle: (open) => {
        // Closing the conversation is the end of serving locally: the radius
        // and the guide's answer both live in it.
        if (!open && this.localOn) this.#endLocal();
        // A ministry lives in the conversation, so closing it lets go of the pin.
        if (!open && this.selected) this.#deselect();
        // A place gone to from the conversation was framed beside it.
        if (!open && !document.body.classList.contains("is-hero")) this.globe?.setShift(0);
        this.syncReserved();
        this.#syncLift();
        setTimeout(() => this.syncReserved(), 360);
      },
    });
    this.local = new LocalPicker({
      count: (miles) => this.#localCount(miles),
      onChange: (miles) => this.#drawLocal(miles),
      onFind: (miles) => this.#findLocal(miles),
      onWhere: (place) => this.#moveLocal(place),
      onClose: () => this.#endLocal(),
    });
    // "Search skills, needs or ministries" is 44 characters and a
    // phone shows about 28 of them, so the field advertises itself with a
    // truncated word. Swapped rather than shrunk: 16px is the floor below
    // which iOS zooms the whole page when the field takes focus.
    const narrow = window.matchMedia("(max-width: 720px)");
    const placeholder = () => {
      if (!this.el.search) return;
      this.el.search.placeholder = narrow.matches ? "Ask Terra anything" : "Ask Terra — “I have a free afternoon, what could I do?”";
    };
    narrow.addEventListener("change", placeholder);
    placeholder();

    this.board = new Board(this.el.sheet, { net: this.net, on: this.#boardHandlers() });
    this.filtersUi = this.el.filters && new Filters(this.el.filters, {
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
    // The entrance state: headline and a find bar standing under it.
    // Everything settles once the
    // globe has flown in.
    // A phone has no entrance: the headline over a small disc is a web page,
    // and on a phone the planet is the page from the first frame.
    const phone = PHONE.matches;
    if (!phone) document.body.classList.add("is-hero");
    // Nothing of the page shows until the planet can: the sky fades up on its
    // own (index.html, sky-in), then the planet rises and the words and the
    // furniture land just behind it, as one arrival (#arrive). The headline
    // used to land at once and the planet whenever its maps came in — on an
    // ordinary connection, seconds later, under words that were already
    // standing on nothing. A slow connection still gets the words after
    // OPEN_WAIT_MS, and the planet rises into them when it can.
    this.openTimer = setTimeout(() => this.#arrive(), OPEN_WAIT_MS);
    // The network is fetched alongside the maps rather than after them.
    const networkReady = api.isConfigured && !this.demo ? this.reloadNetwork() : Promise.resolve();
    const stage = phone ? undefined : stageFrame();
    if (stage) {
      stageCss(stage);
      enterLanding();
    }
    this.#bindChrome();
    this.#bindKeys();

    this.globe = new Globe(this.el.canvas, {
      overlay: this.el.overlay,
      hero: stage,
      onProgress: (p, label) => boot.progress(p, label),
      // The serve-locally circle, dragged to where the visitor means.
      onAreaMove: (centre, { done }) => this.#moveCircle(centre, done),
      onPinClick: (m) => {
        this.#leaveHero();
        this.openMinistry(m, { fly: true });
      },
      onGlobeClick: () => {
        if (document.body.classList.contains("is-hero")) return this.#leaveHero({ settle: true });
        this.#deselect();
      },
      onDoubleClick: (at) => this.#serveAt(at),
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
    // While the conversation is open, signing in happens in it. The linked-
    // account flows (an intent) keep their own sheet.
    this.gate.route = (mode, intent) => {
      if (!this.ask?.open || intent) return false;
      this.ask.signIn(mode);
      return true;
    };
    if (api.isConfigured && !this.demo) {
      // Not waited for: the pins and the count arrive when the network does.
      networkReady.then(() => this.#renderHeroCount());
      this.#afterAuth({ quiet: true });
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
    // The pins and the live count come up with the planet rather than popping
    // in over it a moment later — if the network is nearly there anyway.
    await Promise.race([networkReady.catch(() => {}), new Promise((r) => setTimeout(r, NETWORK_WAIT_MS))]);
    // Two frames for the page to take the work above, so the rise starts on
    // a quiet frame rather than on the one that did it.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    document.body.classList.add("globe-in");
    // The tip arrives once the planet has, not with it.
    setTimeout(() => this.#syncTip(), 1800);
    // The planet rises into place, already turning: from a little below
    // where the stage puts its rim, with the drift starting under it.
    if (document.body.classList.contains("is-hero")) this.#trackStage();
    if (document.body.classList.contains("is-hero")) {
      const home = this.globe.liftTarget;
      this.globe.setLift(home - STAGE.rise, { instant: true });
      this.globe.setLift(home, { ms: 1900 });
      this.globe.releaseSpin({ now: true });
    }
    // The words and the furniture land just behind it.
    setTimeout(() => this.#arrive(), WORDS_AFTER_MS);
    // Then, with the entrance over, what only sharpens the planet.
    setTimeout(() => this.globe.loadDeferred(), DEFERRED_AFTER_MS);

    // The world fades up where it stands and the headline lands just behind it,
    // so the two read as one arrival. Then it holds, and then the page settles
    // into the working view — the entrance's only camera move. Only the timer
    // brings the camera with it: someone who has already taken hold of the
    // globe has said where they want to be, and having it fly out from under
    // them is the rudest thing the page could do.
    // Someone who clicked through while it was still loading has already left.
    if (!document.body.classList.contains("is-hero") && phone && !this.globe.controls.gestured) {
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
      const note = "Drag the globe to look around.";
      if (document.body.classList.contains("is-hero")) this.pendingNote = note;
      else setTimeout(() => this.toast(note), 3400);
    }
    return this;
  }

  /**
   * The words and the page's furniture land: the top bar fades up (is-live)
   * and, still on the landing, the headline, the find bar and its chips play
   * their entrance (hero-in). Once, from whichever comes first: the planet
   * rising, or OPEN_WAIT_MS without it.
   */
  #arrive() {
    if (this.arrived) return;
    this.arrived = true;
    clearTimeout(this.openTimer);
    document.body.classList.add("is-live");
    // Someone who clicked through while it was loading has already left.
    if (document.body.classList.contains("is-hero")) document.body.classList.add("hero-in");
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
    // Twice: once to give the ground the headline was holding straight back
    // to the pins, and again once the find bar has landed.
    this.syncReserved();
    setTimeout(() => this.syncReserved(), Math.round((settle ? STAGE_EXIT.ms : 1100) * 0.55) + 760);
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
    this.#deselect();
    this.setView("globe");
    this.ask?.close();
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
    // The headline's box is measured only when it can have moved — its own
    // entrance or exit, a resize, the stage being reframed — and reused
    // otherwise. Measured every frame, after the globe had moved its labels,
    // it was a forced layout of the whole page on every frame of the landing.
    if (!this.heroWatch) {
      this.heroWatch = true;
      this.heroAnimating = 0;
      // Its own, not its words': those animate inside it, and some for ever.
      const start = (e) => {
        if (e.target === hero) this.heroAnimating += 1;
      };
      const end = (e) => {
        if (e.target !== hero) return;
        this.heroAnimating = Math.max(0, this.heroAnimating - 1);
        heroMoved = true;
      };
      hero.addEventListener("transitionrun", start);
      hero.addEventListener("transitionend", end);
      hero.addEventListener("transitioncancel", end);
      hero.addEventListener("animationstart", start);
      hero.addEventListener("animationend", end);
      hero.addEventListener("animationcancel", end);
      window.addEventListener("resize", () => (heroMoved = true));
    }
    const step = () => {
      const live = document.body.classList.contains("is-hero") || performance.now() < (this.stageTrackUntil ?? 0);
      if (!live || !this.globe) {
        this.stageTracking = false;
        return;
      }
      const d = this.globe.discOnScreen();
      // On the way out the words are fading over a planet that is leaving:
      // the box from before the exit is close enough, and measuring a page
      // mid-transition is the costliest layout there is.
      const leaving = !document.body.classList.contains("is-hero");
      if (!this.heroBox || (!leaving && (heroMoved || this.heroAnimating > 0))) {
        heroMoved = false;
        this.heroBox = hero.getBoundingClientRect();
      }
      const box = this.heroBox;
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
   * No loading screen: the page goes straight to the app, and the planet
   * appears as soon as its textures are in. The veil is only put up if the
   * globe cannot start at all, to say why.
   */
  #boot() {
    return {
      progress() {},
      done: () => Promise.resolve(),
      fail(err) {
        document.body.appendChild(
          h("div", { class: "boot" },
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
          ),
        );
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
      else if (action === "about") this.setView("about");
      else if (action === "menu") this.#menu(trigger);
      else if (action === "open-board") this.setView(this.board.open ? "globe" : "needs");
      else if (action === "join") this.#join();
      else if (action === "serve-local") this.serveLocally();
      else if (action === "near-me") this.#nearMe();
      else if (action === "toggle-filters") this.#toggleFilters();
    });

    this.el.nav.addEventListener("click", (e) => {
      const item = e.target.closest("[data-view]");
      if (item) this.setView(item.dataset.view);
    });

    this.el.grabber.addEventListener("click", () => this.setView(this.board.open ? "globe" : "needs"));

    const search = this.el.search;
    // The gazetteer, warmed on the first look at the bar, so a place typed
    // into it is found without a wait.
    search.addEventListener("focus", () => primePlaces(), { once: true });
    // Typing is just typing: nothing filters or drops down until Enter asks.
    search.addEventListener("input", () => {
      this.el.clearSearch.hidden = !search.value;
    });
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.#askFromBar();
      } else if (e.key === "Escape") search.blur();
    });
    document.getElementById("searchGo")?.addEventListener("click", () => this.#askFromBar());
    this.el.clearSearch.addEventListener("click", () => {
      search.value = "";
      this.el.clearSearch.hidden = true;
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
    // On a phone the ☰ beside the field is the whole navigation: what the
    // top bar holds on a desktop comes first, then the usual menu.
    const phone = PHONE.matches;
    const signedIn = !!this.session;
    openPop({
      anchor,
      parent: this.el.chrome,
      compact: phone,
      items: [
        ...(phone
          ? [
              { label: "Globe", icon: menuIcons.globe, run: () => { this.setView("globe"); this.globe?.reset(); } },
              { label: "Needs", note: "Every open need, as a list", icon: menuIcons.board, run: () => this.setView("needs") },
              { label: "Serve locally", note: "Choose how far, and Terra finds where to help", icon: menuIcons.locate, run: () => this.serveLocally() },
              { label: "Post a need", icon: menuIcons.plus, run: () => this.postNeed() },
              { label: signedIn ? "Your account" : "Sign in or join", icon: menuIcons.person, run: () => this.#join() },
              null,
            ]
          : []),
        ...(phone ? [] : [{ label: "Serve locally", note: "Choose how far, and Terra finds where to help", icon: menuIcons.locate, run: () => this.serveLocally() }]),
        { label: "About this map", note: "How the globe is drawn", icon: menuIcons.info, run: () => this.setView("about") },
        ...(phone ? [] : [{ label: "Open needs board", icon: menuIcons.board, kbd: "B", run: () => this.setView("needs") }]),
        // SANDBOX START — the temporary Style Sandbox's menu entry; present only
        // while src/sandbox/style/ exists (see main.js and REMOVAL.md there).
        ...(window.terraStyleEditor && !phone
          ? [
              {
                label: window.terraStyleEditor.open ? "Hide the style editor" : "Style editor",
                note: "Tune the globe and background live",
                icon: menuIcons.theme,
                run: () => window.terraStyleEditor.toggle(),
              },
              {
                label: window.terraQuickStyle?.open ? "Hide quick style" : "Quick style",
                note: "Lights, glow and colours, simply",
                icon: menuIcons.theme,
                run: () => window.terraQuickStyle?.toggle(),
              },
            ]
          : []),
        // SANDBOX END
        null,
        { label: "Show where I am", note: "A blue dot at your location", icon: menuIcons.locate, run: () => this.#nearMe() },
        // On a phone, Globe at the top of the menu already does this.
        ...(phone ? [] : [{ label: "Reset the view", icon: menuIcons.reset, kbd: "R", run: () => this.globe?.reset() }]),
        null,
        {
          label: "Clear what this browser saved",
          note: saved ? `${saved} interest${saved === 1 ? "" : "s"} and posted needs` : "Nothing saved yet",
          icon: menuIcons.trash,
          danger: true,
          run: () => {
            localStorage.removeItem("terra.v1");
            clearChats();
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
      { label: "Network", run: () => this.#deselect() },
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
      const text = `${plural(stats.needs, "open need", "open needs")} · ${plural(this.net.ministries.length, "ministry", "ministries")}`;
      if (el.textContent === text) return;
      el.textContent = text;
      // A count arriving after the pill has landed eases in, rather than the
      // words in it swapping under the visitor's eye.
      if (document.body.classList.contains("hero-in") && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        el.animate([{ opacity: 0, filter: "blur(3px)" }, { opacity: 1, filter: "blur(0px)" }], { duration: 520, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
      }
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
  async #afterAuth({ quiet = false, onboard = true } = {}) {
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
    if (!onboard) return;

    // Each account is onboarded once, after a beat — immediately on top of a
    // sign-in reads as a second gate. A volunteer goes straight into the
    // app, with no questions first; a ministry tells us who it is, which
    // fills in everything it posts.
    this.onboarded ??= new Set();
    const id = this.session.user.id;
    if (this.onboarded.has(id)) return;
    this.onboarded.add(id);
    if (this.profile?.role === "ministry" && !this.ministry) {
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
        if (n) this.openNeed(n);
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
      const label = !this.session ? "Join" : isMinistry ? "Yours" : "Needs";
      join.querySelector("span").textContent = label;
      join.setAttribute("aria-label", !this.session ? "Create an account" : isMinistry ? "Your needs" : "The needs board");
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
    if (!api.isConfigured) return this.toast("Accounts aren't available right now. Please try again later.");
    if (!this.session) return this.gate?.open("signup");
    if (this.profile?.role === "ministry") return this.ministry ? this.openDashboard() : this.openMinistrySetup();
    this.setView("needs");
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

  /* -------------------------------------------------------- serve locally */

  /** Where the visitor is, asking the browser once; resolves to null if it will not say. */
  #locate() {
    if (this.here) return Promise.resolve(this.here);
    if (!navigator.geolocation) {
      this.toast("This browser cannot share its location.");
      return Promise.resolve(null);
    }
    for (const b of document.querySelectorAll('[data-action="near-me"], [data-action="serve-local"]')) b.classList.add("is-busy");
    return new Promise((resolve) =>
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          this.#setHere(pos);
          this.#watchHere();
          for (const b of document.querySelectorAll('[data-action="serve-local"]')) b.classList.remove("is-busy");
          resolve(this.here);
        },
        (err) => {
          for (const b of document.querySelectorAll('[data-action="near-me"], [data-action="serve-local"]')) b.classList.remove("is-busy");
          this.toast(err.code === err.PERMISSION_DENIED ? "Location is off for this site. Allow it in your browser's settings." : "Could not find where you are just now.");
          resolve(null);
        },
        { enableHighAccuracy: true, maximumAge: 60000, timeout: 10000 },
      ),
    );
  }

  /**
   * Serve locally. The globe comes down to the visitor's blue dot with a
   * circle round it, and a slider sets how far the circle reaches; the
   * camera follows it in and out, and the pins outside it recede. The circle
   * can instead go round a city or country the visitor types, and does when
   * the browser will not say where they are. "Find ministry opportunities"
   * then asks the guide to choose from the needs inside — against the
   * visitor's questionnaire when they have one.
   *
   * `again` is "Change the radius" after an answer: the circle stays where it
   * was. A fresh "Serve locally" starts from the visitor.
   */
  async serveLocally({ again = false } = {}) {
    this.#leaveHero();
    if (!again) this.localPlace = null;
    const here = this.localPlace ? this.here : await this.#locate();
    // A second "Serve locally" replaces the card rather than stacking another.
    if (this.local.open) this.local.close({ quiet: true });
    this.localOn = true;
    this.localFramed = false;
    this.#syncTip();
    this.globe?.setSpin(false);
    // The radius is a card in the conversation; its ✕ ends serving locally.
    this.ask.layer(null, { onClose: () => this.local.close() }).show((close) => {
      this.local.unmount = close;
      return this.local.show({ place: this.localPlace ?? null, located: !!here });
    });
    this.syncReserved();
  }

  /**
   * A double-click on the ground: serve locally round that spot, ten miles
   * out, with the camera brought down until that circle fills a third of the
   * screen — close enough to read the town, not so close the circle runs
   * off it. The spot is the centre; the town it is in only names it, once a
   * lookup comes back.
   */
  #serveAt(at) {
    // Used once, the tip has done its job.
    if (!store.tipDone("dblclick")) {
      store.retireTip("dblclick");
      this.#syncTip();
    }
    const place = { name: "this spot", country: "", lat: at.lat, lon: at.lon, kind: "point" };
    this.localPlace = place;
    this.local.miles = 10;
    this.serveLocally({ again: true });
    areaName(at.lat, at.lon).then((named) => {
      if (!named || this.localPlace !== place) return;
      const [name, ...country] = named.split(", ");
      Object.assign(place, { name, country: country.join(", "), kind: "city" });
      this.local.rename(place);
    });
    return true;
  }

  /**
   * The double-click tip: shown in the lower right on a desktop, on the
   * landing as on the globe, until it is closed or double-click has been
   * used — and out of the way while a circle is already up, which is the
   * thing it explains.
   */
  #syncTip() {
    const tip = this.el.tip;
    if (!tip) return;
    if (!tip.wired) {
      tip.wired = true;
      tip.querySelector(".tip__x").addEventListener("click", () => {
        store.retireTip("dblclick");
        this.#syncTip();
      });
    }
    const show = !store.tipDone("dblclick") && !this.localOn;
    if (show) tip.hidden = false;
    requestAnimationFrame(() => {
      tip.classList.toggle("is-in", show);
      this.syncReserved();
    });
    if (!show) setTimeout(() => (tip.hidden = !tip.classList.contains("is-in")), 500);
  }

  /** Where the circle is round: a place the visitor chose, or the visitor. */
  #localCentre() {
    return this.localPlace ?? this.here ?? null;
  }

  /** The circle moves: to `place`, or back to the visitor for null. */
  async #moveLocal(place) {
    if (!this.localOn) return;
    this.localFramed = false;
    if (place) {
      this.localPlace = place;
      // The globe glides there rather than jumping, and the circle is drawn
      // round it with the slider's radius.
      return this.local.setPlace(place);
    }
    this.localPlace = null;
    const here = await this.#locate();
    if (!this.localOn || this.localPlace) return;
    this.local.setPlace(null, { located: !!here });
    if (!here) this.globe?.setArea(null);
  }

  /** The ministries with open needs within `miles` of the circle's centre, nearest first. */
  #localInside(miles) {
    const centre = this.#localCentre();
    if (!centre) return [];
    return this.net.ministries
      .filter((m) => m.openNeeds > 0)
      .map((m) => ({ m, d: distanceMiles(centre, m) }))
      .filter((x) => x.d <= miles)
      .sort((a, b) => a.d - b.d);
  }

  #localCount(miles) {
    const ids = new Set(this.#localInside(miles).map((x) => x.m.id));
    return { needs: this.net.needs.filter((n) => ids.has(n.ministry)).length };
  }

  /** The circle on the planet, the camera framing it, the pins outside it dimmed. */
  #drawLocal(miles, { frame = !this.localHold } = {}) {
    const centre = this.#localCentre();
    if (!centre || !this.localOn) return;
    // Movable while the radius card is up; once the guide has searched it,
    // the circle is what was searched.
    const area = { lat: centre.lat, lon: centre.lon, miles, movable: this.local.open };
    this.globe?.setArea(area);
    // On a desktop the conversation holds the left of the screen, and the
    // circle is framed in the map that is left beside it rather than under
    // the panel. A view offset, so picking and labels follow without knowing.
    if (!PHONE.matches && this.ask.open && !document.body.classList.contains("is-hero")) {
      const right = this.ask.root.getBoundingClientRect().right;
      this.globe?.setShift(clamp(-right / (2 * window.innerWidth), -0.3, 0));
    }
    const keep = new Set(this.#localInside(miles).map((x) => x.m.id));
    this.globe?.setDimmed(new Set(this.net.ministries.filter((m) => !keep.has(m.id)).map((m) => m.id)));
    if (!frame) return;
    this.globe?.frameArea(area, { fill: PHONE.matches ? 0.32 : 0.36, ms: this.localFramed ? 650 : undefined });
    this.localFramed = true;
  }

  /**
   * The circle dragged: it follows the hand, with the camera left where it
   * is. Let go, it becomes the place the card searches round — named after
   * the town under it once OpenStreetMap says which that is.
   */
  #moveCircle(centre, done) {
    if (!this.localOn || !this.local.open) return;
    const place = { name: "this spot", country: "", lat: centre.lat, lon: centre.lon, kind: "spot" };
    this.localPlace = place;
    if (!done) return this.#drawLocal(this.local.miles, { frame: false });
    this.localHold = true;
    this.local.setPlace(place);
    this.localHold = false;
    areaName(centre.lat, centre.lon).then((named) => {
      if (!named || this.localPlace !== place || !this.local.open) return;
      const [name, ...rest] = named.split(", ");
      Object.assign(place, { name, country: rest.join(", ") });
      this.localHold = true;
      this.local.setPlace(place);
      this.localHold = false;
    });
  }

  #endLocal() {
    if (!this.localOn) return;
    this.localOn = false;
    this.#syncTip();
    this.localPlace = null;
    if (this.local.open) this.local.close({ quiet: true });
    this.globe?.setArea(null);
    if (!document.body.classList.contains("is-hero")) this.globe?.setShift(0);
    this.localFound = null;
    this.globe?.setFound([]);
    this.applyQuery();
    this.syncReserved();
  }

  /**
   * Hands the circle to the guide. The page finds the churches and ministries
   * inside it (lib/places.js); the serve-local function reads their websites
   * and chooses, with any Terra needs inside the circle alongside. Answered
   * in the conversation, with what it is doing shown while it works.
   */
  #findLocal(miles) {
    const here = this.#localCentre();
    if (!here) return;
    // A double-clicked spot not yet named is no name to search the web by;
    // the guide works the area out from the point instead.
    const place = this.localPlace && this.localPlace.kind !== "point" ? placeLabel(this.localPlace) : null;
    const byMinistry = new Map(this.#localInside(miles).map((x) => [x.m.id, x.d]));
    const urgency = { urgent: 0, soon: 1, ongoing: 2 };
    const inside = this.net.needs
      .filter((n) => byMinistry.has(n.ministry))
      .map((need) => ({ need, miles: byMinistry.get(need.ministry) }))
      .sort((a, b) => a.miles - b.miles || (urgency[a.need.urgency] ?? 3) - (urgency[b.need.urgency] ?? 3))
      .slice(0, LOCAL_POOL);
    this.local.close({ quiet: true });
    // The circle searched stays where it is.
    this.#drawLocal(miles, { frame: false });
    this.syncReserved();

    this.ask.findLocal({
      miles,
      place,
      onAdjust: () => this.serveLocally({ again: true }),
      // Three steps, each with its share of the bar: the bar eases towards
      // the step's share while it runs, and fills when the answer arrives.
      run: async (status) => {
        // How far the web search reaches (serve-local's own cap).
        const reach = Math.min(miles, 100);
        let found = { orgs: [], places: [] };
        if (api.isConfigured) {
          status(`Finding churches and ministries ${place ? `around ${this.localPlace.name}` : "inside the circle"}…`, { step: 1, to: 0.3, tau: 6 });
          // The name of the area, for the agent's web search: the place
          // typed, or wherever the visitor is.
          const [orgs, near] = await Promise.all([
            findLocalOrgs(here.lat, here.lon, reach).catch(() => found),
            place ? Promise.resolve(place) : areaName(here.lat, here.lon),
          ]);
          found = orgs;
          const area = place || near || found.places.slice(0, 2).join(", ");
          status(`Searching the web and reading church and ministry websites${area ? ` in ${area.split(",")[0]}` : ""}…`, { step: 2, to: 0.75, tau: 16 });
          // The reading and choosing take a while; say what is happening.
          const later = setTimeout(() => status("Choosing the best ways for you to serve…", { step: 3, to: 0.95, tau: 14 }), 18000);
          try {
            const res = await api.serveLocal({ miles, lat: here.lat, lon: here.lon, area, needs: inside, orgs: found.orgs, places: found.places });
            const byId = new Map(inside.map((x) => [x.need.id, x.need]));
            const picks = res.items
              .map((it, i) =>
                it.kind === "need"
                  ? { need: byId.get(it.id), why: it.why }
                  : { web: { ...it, name: it.org }, why: it.why, key: `web:${i}:${it.org}` },
              )
              .filter((p) => p.need || p.web);
            // The same objects the cards hold, so the globe can light the one
            // opened — those with a place on the map (a web find may have none).
            this.localFound = picks.filter((p) => p.web && Number.isFinite(p.web.lat)).map((p) => p.web);
            this.globe?.setFound(this.localFound);
            return { reply: res.reply, picks };
          } catch {
            // Fall through to what the page can say on its own.
          } finally {
            clearTimeout(later);
          }
        }
        // The guide out of reach: Terra's own needs inside the circle, the
        // nearest ten, one per ministry before a second from any.
        const far = (d) => (d < 1 ? "Under a mile away" : d < 10 ? `${d.toFixed(1)} miles away` : `${Math.round(d).toLocaleString()} miles away`);
        const firsts = [];
        const rest = [];
        const seen = new Set();
        for (const x of inside) (seen.has(x.need.ministry) ? rest : (seen.add(x.need.ministry), firsts)).push(x);
        const picks = [...firsts, ...rest].slice(0, 10).map((x) => ({ need: x.need, why: `${far(x.miles)} · ${x.need.city}` }));
        return {
          reply: picks.length
            ? `I couldn't search local churches' websites just now, but here ${picks.length === 1 ? "is the one need" : `are ${picks.length} needs`} on Terra within ${miles} miles of ${place ?? "you"}.`
            : `I couldn't search the churches and ministries round ${place ?? "you"} just now. Please try again in a moment.`,
          picks,
        };
      },
    });
  }

  /**
   * "Show on map" for something the guide found: down onto the building.
   * The address is looked up the first time (the map's point for a church can
   * be the middle of its grounds, and a web find has none at all), checked
   * against where the find was said to be, and kept on the find.
   */
  async #showFound(w) {
    const ask = (this.foundAsk = (this.foundAsk ?? 0) + 1);
    if (!w) return this.globe?.setFound(this.localFound ?? [], null);
    if (!w.located) {
      w.located = true;
      const town = String(w.town ?? "");
      const address = String(w.address ?? "");
      // The address as it is, with the town only when it does not already
      // end in it; a web find with no address, by its name in the town.
      const query = address
        ? (town && !address.toLowerCase().includes(town.split(",")[0].toLowerCase()) ? `${address}, ${town}` : address)
        : [w.org || w.name, town].filter(Boolean).join(", ");
      const centre = this.#localCentre();
      const known = Number.isFinite(w.lat) && Number.isFinite(w.lon);
      const hit = await locateAddress(query, known ? w : centre);
      // Trusted only near where it should be: the map's own point when there
      // is one, otherwise inside (or just past) the circle.
      const reach = known ? 2 : (this.local?.miles ?? 25) * 1.5 + 5;
      const from = known ? w : centre;
      if (hit && (!from || distanceMiles(from, hit) <= reach)) Object.assign(w, hit);
    }
    if (ask !== this.foundAsk) return;
    if (!Number.isFinite(w.lat) || !Number.isFinite(w.lon)) {
      return this.toast(`Couldn't find ${w.org || "that place"} on the map.`);
    }
    if (!(this.localFound ?? []).includes(w)) this.localFound = [...(this.localFound ?? []), w];
    this.globe?.setFound(this.localFound, w);
    this.globe?.setSpin(false);
    this.globe?.flyToPlace(w);
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
   * On a phone, raises the globe into the room left above the conversation,
   * so the city a pin was tapped on stays in sight instead of going under
   * the card that describes it.
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
    const H = viewH();
    // The phone's conversation rises from the foot of the screen; the planet
    // moves up into the room left above it.
    if (PHONE.matches && this.ask?.open) {
      const covered = this.ask.root.getBoundingClientRect().top || H * 0.6;
      return this.globe.setLift(clamp(0.5 - covered / 2 / H, 0, 0.3));
    }
    this.globe.setLift(0);
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
    if (this.board.open) this.board.render(this.query);
    this.globe?.setDimmed(this.net.excluded(this.query));
    this.#renderCrumbs();
  }

  clearFilters() {
    this.query = emptyQuery();
    this.el.search.value = "";
    this.el.clearSearch.hidden = true;
    if (this.filtersUi) {
      this.filtersUi.query = this.query;
      this.filtersUi.render();
    }
    this.applyQuery();
  }

  /* ------------------------------------------------------------ ask terra */

  /**
   * Enter in the find bar: the question goes to Ask Terra (ask.js) rather than
   * filtering as you type. From the landing screen it first settles into the
   * working view, so the answer opens beside a globe that is ready to fly.
   */
  #askFromBar() {
    const search = this.el.search;
    const text = search.value.trim();
    if (!text) return search.focus();
    search.value = "";
    this.el.clearSearch.hidden = true;
    // Down goes the phone keyboard, which would otherwise cover the answer.
    if (PHONE.matches) search.blur();
    // A place ("Los Angeles", "show me Los Angeles") is somewhere to go, not
    // a question. The gazetteer answers at once; only a "show me" for a town
    // it does not know waits on a lookup, and a newer entry overrides it.
    const asked = (this.barAsk = (this.barAsk ?? 0) + 1);
    placeAsked(text)
      .catch(() => null)
      .then((place) => {
        if (asked !== this.barAsk) return;
        if (place) return this.#travelTo(place);
        this.#leaveHero({ settle: true });
        if (this.ask.wantsToPost(text)) return this.postNeed({ said: text });
        this.ask.submit(text);
      });
  }

  /**
   * Off to a place named in the find bar or the conversation: the planet
   * spins round to it and the camera comes down over it. From the find bar
   * the conversation steps out of the way — folded to its header on a phone,
   * closed on a desktop, where it would otherwise stand over the middle of
   * the map. Asked for in the conversation (`chat`), it stays open, and on a
   * desktop the place is framed in the map beside it.
   */
  #travelTo(place, { chat = false } = {}) {
    // Not the settle: its own flight would be replaced on the same frame.
    this.#leaveHero();
    if (this.ask.open && PHONE.matches) this.ask.root.classList.add("is-min");
    else if (this.ask.open && !chat) this.ask.close();
    if (this.ask.open && !PHONE.matches) {
      const right = this.ask.root.getBoundingClientRect().right;
      this.globe?.setShift(clamp(-right / (2 * window.innerWidth), -0.3, 0));
    }
    this.#deselect();
    this.globe?.setSpin(false);
    // A country is seen whole; a city is come down onto, by its size: a
    // metropolis from about a hundred kilometres up, a city from forty-five,
    // and a town — La Mirada, a place with no population on record — from
    // eighteen, where its streets fill the middle of the screen. Heights in
    // Earth radii; below the zoom ladder's close end, so given outright.
    if (place.kind === "country") this.globe?.travelTo(place, { zoom: 0.42 });
    else {
      const km = place.population > 3e6 ? 100 : place.population > 3e5 ? 45 : 18;
      this.globe?.travelTo(place, { dist: 1 + km / 6371 });
    }
    if (!chat) this.toast(placeName(place));
  }

  #hideSuggest() {
    this.el.suggest.hidden = true;
  }

  /**
   * The answer's needs on the globe: their pins stay lit and the rest of the
   * network dims, and when they are all in one part of the world the camera
   * goes there. `null` is the panel closing, which hands the globe back to
   * the filters.
   */
  #askResults(needs) {
    if (needs === null) return this.applyQuery();
    if (!needs.length) return this.globe?.setDimmed(new Set());
    const keep = new Set(needs.map((n) => n.ministry));
    this.globe?.setDimmed(new Set(this.net.ministries.filter((m) => !keep.has(m.id)).map((m) => m.id)));

    const places = [...keep].map((id) => this.net.ministryById.get(id)).filter(Boolean);
    if (!places.length) return;
    if (places.length === 1) return this.globe?.focus(places[0], { zoom: 0.5 });
    // The centre of the pins on the sphere, and how far the farthest is from
    // it: a cluster gets the camera, a scatter across continents does not.
    const v = places.map((m) => {
      const la = (m.lat * Math.PI) / 180;
      const lo = (m.lon * Math.PI) / 180;
      return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
    });
    const c = v.reduce((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], [0, 0, 0]);
    const len = Math.hypot(...c) || 1;
    const u = c.map((x) => x / len);
    const spread = Math.max(...v.map((p) => Math.acos(Math.min(1, p[0] * u[0] + p[1] * u[1] + p[2] * u[2])))) * (180 / Math.PI);
    if (spread > 32) return;
    const centre = {
      lat: (Math.asin(u[2]) * 180) / Math.PI,
      lon: (Math.atan2(u[1], u[0]) * 180) / Math.PI,
    };
    this.globe?.focus(centre, { zoom: spread < 6 ? 0.48 : spread < 15 ? 0.36 : 0.24 });
  }


  /* --------------------------------------------------------------- events */

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
        this.filtersUi?.render();
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

  openMinistry(ministry, { fly = false, need = null } = {}) {
    const full = this.net.ministryById.get(ministry.id) ?? ministry;
    this.selected = full;
    this.globe?.select(full.id);
    this.globe?.setSpin(false);
    // In the conversation, where its needs can be opened, served, booked and
    // asked about; `need` opens one of them straight away.
    this.ask.showMinistry(full, { need });
    // All the way in: choosing a ministry is choosing a city, not a region.
    if (fly) this.globe?.focus(full, { zoom: 1 });
    this.#renderCrumbs();
  }

  /**
   * A need, opened under its ministry in the conversation, with the globe
   * gone to it. From the board or a dialog, those step aside for the map.
   */
  openNeed(need) {
    const fresh = this.net.needById(need.id) ?? need;
    const m = this.net.ministryById.get(fresh.ministry);
    if (!m) return;
    this.#leaveHero();
    if (this.modals.isOpen) this.modals.close();
    if (this.board.open) this.setView("globe");
    this.openMinistry(m, { fly: true, need: fresh });
  }

  /**
   * The application behind "Serve". Written to the browser either way,
   * and to the database as well when there is somebody to attribute it to: a
   * signed-out visitor can still answer and share links, just not upload.
   */
  openPickUp(need, { chat = false } = {}) {
    const live = api.isConfigured && !this.demo;
    const layer = chat ? this.ask.layer(`I'd like to serve on “${need.title}”`) : this.modals;
    pickUpModal(layer, this.net.needById(need.id) ?? need, {
      canUpload: live && !!this.session,
      onSignIn: live
        ? () => (chat ? this.ask.signIn("signin", { then: () => this.openPickUp(need, { chat }) }) : this.gate.open("signin"))
        : null,
      onSubmit: async (answers) => {
        if (this.session) await api.expressInterest(need.id, answers);
        this.net.toggleInterest(need.id, { ...answers, files: answers.files.map((f) => f.name) });
        this.#afterDataChange();
        const done = this.session
          ? `Sent — ${need.ministryName} can see your answers.`
          : `Saved in this browser. Sign in so ${need.ministryName} can see it.`;
        if (chat) this.ask.say(`${done} I'll keep “${need.title}” on your list.`);
        else this.toast(done);
      },
    });
  }

  /** Book a first video call about a need; signing in comes first. */
  openSchedule(need, { chat = false } = {}) {
    if (!this.session) {
      if (chat) {
        this.ask.say("To book a call with the ministry, sign in first — it only takes a moment.");
        return this.ask.signIn("signin", { said: null, then: () => this.openSchedule(need, { chat }) });
      }
      this.toast("Sign in to book a call with the ministry.");
      return this.gate.open("signup");
    }
    const layer = chat ? this.ask.layer(`I'd like a call with ${need.ministryName}`) : this.modals;
    scheduleModal(layer, this.net.needById(need.id) ?? need, {
      onBook: (fields) => api.scheduleMeeting(fields),
    });
  }

  openMeetings() {
    if (!this.session) return this.gate.open("signin");
    meetingsModal(this.modals, {
      load: () => api.myMeetings(),
      onOpenNeed: (id) => {
        const n = this.net.needById(id);
        if (n) this.openNeed(n);
      },
    });
  }

  /**
   * The one entry point for posting, and it is a gate as much as a form: the
   * write path needs a signed-in owner of a ministry, so anything missing is
   * collected in order rather than failing at submit.
   */
  /**
   * Posting a need happens in the conversation (AskPanel startPost): the
   * ministry says what it needs, and the form fills itself in beside it.
   * Signing in happens there too; putting a ministry on the map first is a
   * dialog, and comes back here when it is done.
   */
  async postNeed({ said } = {}) {
    if (!api.isConfigured) return this.toast("No backend configured — posting is off.");
    // From a dialog (About): the conversation is where it goes on, not under it.
    this.modals.close();
    if (!this.session) {
      return this.ask.signIn("signup", { said: said ?? "I'd like to post a need", then: () => this.postNeed() });
    }
    if (this.profile?.role !== "ministry") {
      await api.setRole("ministry").catch(() => {});
      this.profile = await api.myProfile();
    }
    if (!this.ministry) this.ministry = await api.myMinistry();
    if (!this.ministry) return this.openMinistrySetup();

    const ministry = this.ministry;
    this.ask.startPost({
      ministry,
      said,
      draft: (args) => api.draftNeed({ ministryId: ministry.id, ...args }),
      post: (fields) => api.postNeed(fields),
      onPosted: async (res) => {
        await this.reloadNetwork();
        if (res.status === "live") {
          const m = this.net.ministryById.get(this.ministry.id);
          if (m) {
            // The pin lights and the globe goes to it; the receipt stays in
            // view in the conversation rather than under the ministry's card.
            this.globe?.select(m.id);
            this.globe?.focus(m, { zoom: Math.max(this.globe.zoom, 0.5) });
            this.selected = m;
          }
        }
      },
    });
  }

  #afterDataChange() {
    this.board.net = this.net;
    if (this.filtersUi) this.filtersUi.net = this.net;
    this.globe?.setMinistries(this.net.ministries);
    // The conversation shows whether you have taken a need up, and a
    // ministry's card its needs as they are now.
    if (this.ask?.open) this.ask.render({ keepScroll: true });
    if (this.selected) this.selected = this.net.ministryById.get(this.selected.id) ?? this.selected;
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
    if (this.el.tip?.classList.contains("is-in")) push(this.el.tip);
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
    // The conversation's window is frosted: a label under it would only
    // show as a smudge.
    if (this.ask?.open) push(this.ask.root);
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
   * The full-height board or a dialog on a phone leaves the renderer drawing a
   * planet — the heaviest thing on the page — underneath something opaque, at
   * sixty frames a second, while a finger is trying to scroll the thing on
   * top. That is most of why the list stuttered. On a desktop the board is a
   * card in the middle of a visible globe, so none of this applies.
   */
  #syncCovered() {
    const phone = window.matchMedia("(max-width: 720px)").matches;
    const covered =
      !!this.modals?.covers ||
      (phone && !!this.board?.open);
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

