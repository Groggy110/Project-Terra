/**
 * The label layer is DOM, not texture: text stays crisp at any zoom and picks
 * up the theme for free. Every frame the visible candidates are projected,
 * ranked and laid out greedily against a rectangle list, so a dense region
 * drops its least important names instead of overprinting them.
 *
 * Widths are estimated from the string rather than measured, because reading
 * offsetWidth here would force a layout on every camera frame.
 */
import { clamp, DEG, projectPoint } from "./geo.js";
import { STYLE } from "../style/styleConfig.js";

// When names arrive, how many countries may show, and how dim a filtered-out
// pin goes are all STYLE.labels / STYLE.markers, read each pass.


/**
 * Rank ceiling for city labels as the camera comes in. Deliberately steep at
 * the start: the first names should arrive as soon as the view is regional,
 * then fill in gradually rather than all at once.
 */
function cityRankLimit(z) {
  const from = STYLE.labels.cityZoom;
  if (z < from) return -1;
  return Math.floor(-1 + 11 * Math.sqrt(clamp((z - from) / 0.62, 0, 1)));
}

const estWidth = (text, per) => text.length * per + 14;

/**
 * The smallest city whose ministries get a pin at zoom `z`. Out at the whole
 * planet only the great cities carry one, so a network of hundreds reads as
 * a map rather than a rash; each step in brings the next size of city in,
 * and close to the ground every ministry shows.
 */
function pinMinPop(z) {
  if (z < 0.3) return 5_000_000;
  if (z < 0.45) return 2_000_000;
  if (z < 0.6) return 1_000_000;
  if (z < 0.75) return 300_000;
  return 0;
}

const fold = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/**
 * Tags a place with its unit vector, so the per-frame cull is one dot product.
 * Same convention as geo.js: x = cos(lat)cos(lon), y = sin(lat),
 * z = -cos(lat)sin(lon).
 */
function withVec(p) {
  const la = p.lat * DEG;
  const lo = p.lon * DEG;
  const c = Math.cos(la);
  p.vx = c * Math.cos(lo);
  p.vy = Math.sin(la);
  p.vz = -c * Math.sin(lo);
  return p;
}

export class LabelLayer {
  constructor(root, { onPinClick, onPinHover, onAreaGrab } = {}) {
    this.root = root;
    this.onPinClick = onPinClick;
    this.onPinHover = onPinHover;
    // A press inside the serve-locally circle: true when it was taken as the
    // start of moving the circle, so the globe does not turn under it.
    this.onAreaGrab = onAreaGrab;

    this.ministries = [];
    this.places = [];
    this.countries = [];

    this.nodes = new Map();
    this.live = new Set();
    this.chipped = new Set();
    this.rects = [];
    this.projection = { x: 0, y: 0 };
    this.selected = null;
    this.dimmed = new Set();
    this.reserved = [];
    this.user = null;
    this.area = null;
    this.areaEl = null;
    this.found = [];
    this.foundActive = null;
  }

  /** Where the viewer is, drawn as a blue dot; null removes it. */
  setUser(here) {
    this.user = here;
  }

  /**
   * Places the serve-locally guide found on the web, `[{ lat, lon, name }]`,
   * drawn as small markers of their own; `active` is the one opened.
   */
  setFound(list, active = null) {
    this.found = list || [];
    this.foundActive = active;
  }

  /** A circle on the ground, `{ lat, lon, miles }`; null removes it. */
  setArea(area) {
    this.area = area;
  }

  setData({ ministries = [], places = [], countries = [] }) {
    // Ranked once, so a collision between two pins is settled by which
    // ministry is asking for more help rather than by array order.
    this.ministries = [...ministries].sort(
      (a, b) => b.urgentNeeds - a.urgentNeeds || b.openNeeds - a.openNeeds,
    );
    // Sorted by rank and carrying a precomputed unit vector.
    //
    // The cull that decides whether a place is anywhere near the view used to
    // be an angleTo() per candidate per frame — four trig calls and an acos,
    // five and a half thousand times a frame. It is a dot product against the
    // view centre instead, compared to the cosine of the limit rather than
    // taking the arc back out of it. Sorting means the scan also stops at the
    // first place ranked out of the current zoom rather than walking the
    // whole list to reject the tail of it.
    this.places = places
      .map((p) => withVec({
        name: p[0],
        lon: p[1],
        lat: p[2],
        rank: p[3],
        pop: p[4],
        country: p[5],
        capital: !!p[6],
      }))
      .sort((a, b) => a.rank - b.rank);
    this.countries = countries
      .map((c) => withVec({ name: c[0], lon: c[1], lat: c[2], rank: c[3], extent: c[4] }))
      .sort((a, b) => a.rank - b.rank);

    // Each ministry's city size, from the same places list the city names
    // come from: by name and country, then by name alone (a country spelled
    // differently), and a mid-sized city if it is not there at all.
    const byPlace = new Map();
    const byName = new Map();
    for (const p of this.places) {
      byPlace.set(`${fold(p.name)}|${fold(p.country)}`, p.pop);
      if (!byName.has(fold(p.name)) || byName.get(fold(p.name)) < p.pop) byName.set(fold(p.name), p.pop);
    }
    this.cityPop = new Map(
      this.ministries.map((m) => [
        m.id,
        byPlace.get(`${fold(m.city)}|${fold(m.country)}`) ?? byName.get(fold(m.city)) ?? 1_000_000,
      ]),
    );
  }

  setSelected(id) {
    this.selected = id;
  }

  /** Ministry ids that the active filters exclude; they stay but recede. */
  setDimmed(ids) {
    this.dimmed = ids instanceof Set ? ids : new Set(ids);
  }

  clear() {
    for (const node of this.nodes.values()) node.el.remove();
    this.nodes.clear();
    this.chipped.clear();
  }

  /* --------------------------------------------------------------- layout */

  /** Rectangles the chrome occupies; labels will not be placed under them. */
  setReserved(rects) {
    this.reserved = rects || [];
  }

  update(ctx) {
    const { camera, controls, width, height } = ctx;
    this.width = width;
    const z = controls.zoom;
    const cap = ctx.capRadius;
    const ppd = controls.pxPerDeg;

    this.rects.length = 0;
    this.live.clear();
    for (const r of this.reserved) this.rects.push(r[0], r[1], r[2], r[3]);

    const margin = 26;
    const inView = (p) => p.x > -margin && p.x < width + margin && p.y > 4 && p.y < height - 4;

    // The view centre as a unit vector, and the two cull limits as cosines.
    const cLa = controls.lat * DEG;
    const cLo = controls.lon * DEG;
    const cc = Math.cos(cLa);
    const cx = cc * Math.cos(cLo);
    const cy = Math.sin(cLa);
    const cz = -cc * Math.sin(cLo);
    const cosCity = Math.cos(cap * 0.9 * DEG);
    const cosCountry = Math.cos(cap * 0.8 * DEG);

    this.#area(camera, width, height);

    // ---- you are here ----
    // Drawn whatever else is crowding the spot, and claimed first so a city
    // name never sits on top of it.
    if (this.user) {
      const p = projectPoint(this.user.lat, this.user.lon, camera, width, height, this.projection);
      if (p.visible && inView(p)) {
        this.#claim(p.x - 9, p.y - 9, 18, 18, true);
        this.#me(p, ppd);
      }
    }

    // ---- what the serve-locally guide found on the web ----
    for (let i = 0; i < this.found.length; i++) {
      const f = this.found[i];
      const p = projectPoint(f.lat, f.lon, camera, width, height, this.projection);
      if (!p.visible || !inView(p)) continue;
      this.#claim(p.x - 8, p.y - 8, 16, 16, true);
      this.#foundMark(i, f, p);
    }

    // ---- ministries first: they are the point of the map ----
    // Every pin asks for its city plate; one that will not fit falls back to
    // a bare dot rather than dropping out, which is what keeps a crowded
    // limb legible without losing the ministry.
    //
    // Two passes, and the first is whatever was lettered last frame. Ranking
    // by urgency alone reshuffles as pins slide past each other, and the
    // names blink on and off through the whole turn; holding the incumbent
    // means a plate only leaves when something genuinely displaces it.
    const held = this.chipped;
    const chipped = new Set();
    const queue = [];
    // Smaller cities wait for the zoom (pinMinPop). The chosen ministry
    // shows at any zoom, and so do the ones a filter or an answer has picked
    // out — while they are few enough to be a handful rather than the map.
    // The landing planet is drawn close, but it is a view of the world, not
    // a zoom into it: it gets the whole-globe set, the great cities only.
    const minPop = document.body.classList.contains("is-hero") ? pinMinPop(0) : pinMinPop(z);
    const picked = this.dimmed.size > 0 && this.ministries.length - this.dimmed.size <= 40;
    for (const m of this.ministries) {
      const shown =
        minPop === 0 ||
        m.id === this.selected ||
        (picked && !this.dimmed.has(m.id)) ||
        (this.cityPop?.get(m.id) ?? 1_000_000) >= minPop;
      if (!shown) continue;
      const p = projectPoint(m.lat, m.lon, camera, width, height, this.projection);
      if (!p.visible || !inView(p)) continue;
      queue.push({ m, x: p.x, y: p.y, edge: p.edge });
    }
    // Dots that would sit on top of one another: the bigger city keeps its
    // dot and the smaller waits for the zoom. Decided in a fixed order (city
    // size, then id) so the same one always wins, with a little give for a
    // dot already showing, so two near the limit do not take turns.
    const dotted = this.dotted ?? new Set();
    const kept = [];
    const nextDotted = new Set();
    const order = [...queue].sort(
      (a, b) => (this.cityPop.get(b.m.id) ?? 0) - (this.cityPop.get(a.m.id) ?? 0) || (a.m.id < b.m.id ? -1 : 1),
    );
    const drop = new Set();
    for (const q of order) {
      const must = q.m.id === this.selected || (picked && !this.dimmed.has(q.m.id));
      // Generous: a dot every couple of finger-widths reads as a calm map,
      // and anything closer is there one step of zoom in.
      const room = dotted.has(q.m.id) ? 26 : 32;
      if (!must && kept.some((k) => Math.hypot(k.x - q.x, k.y - q.y) < room)) {
        drop.add(q.m.id);
        continue;
      }
      kept.push(q);
      nextDotted.add(q.m.id);
    }
    this.dotted = nextDotted;
    for (let i = queue.length - 1; i >= 0; i--) if (drop.has(queue[i].m.id)) queue.splice(i, 1);

    let cursor = 0;
    for (let i = 0; i < queue.length; i++) {
      if (!held.has(queue[i].m.id)) continue;
      const q = queue[i];
      queue[i] = queue[cursor];
      queue[cursor++] = q;
    }
    // Pins carry their city at every zoom. They used to go bare at the
    // whole-globe view so thirty plates would not land on the centred
    // headline, but the headline has its own column now and is gone once you
    // engage, and a globe of unnamed dots after scrolling off the landing
    // page just looked broken. The budget and the collision pass below still
    // decide how many fit.
    const lettering = true;

    // How many pins may carry their city at once.
    //
    // On a desktop the answer is "as many as fit", and the greedy layout below
    // settles it — there is enough room that the ones which fail to place are
    // genuinely crowded. A phone is a tenth of the area, and "as many as fit"
    // there is a dozen plates stacked over a disc 300px across: the map stops
    // being a map and becomes a list with a picture behind it. So the budget
    // scales with the area actually available, and the pins spend it in the
    // order the queue is already in — the ones lettered last frame first, so
    // the set stays stable while the globe turns.
    const budget = Math.max(4, Math.round((width * height) / STYLE.labels.pinDensity));
    let spent = 0;

    // Every dot that is due at this zoom is drawn, every frame. Dots used to
    // compete for room as well, and as the globe turned two that drifted
    // close would take turns dropping out — the map flickered. Now only the
    // name plates compete, and only with each other (and the chrome): a dot
    // drifting under a plate leaves it be, since the plate is drawn over it.
    // The dots claim their spots afterwards, so city names keep off them.
    const marks = [];
    for (const q of queue) {
      const active = this.selected === q.m.id;
      const wide = 24 + estWidth(q.m.city, 7.6);
      // A plate opens to the right of its dot, so one near the right edge runs
      // off the screen and gets clipped mid-word. Rather than flip the plate —
      // which would put the name on the wrong side of the dot it belongs to —
      // the pin keeps a bare dot, as it does when a plate will not fit for
      // any other reason.
      const room = q.x - 8 + wide < width - 6;
      const affordable = active || spent < budget;
      // The plate's box starts clear of its own dot, so it is only ever
      // refused by something else.
      // Hysteresis: a plate already up keeps its place while it fits; a new
      // one needs a margin of clear ground round it first. Without that, two
      // plates at the edge of fitting swap back and forth as the globe turns.
      const fresh = !held.has(q.m.id) && !active;
      const clear = !fresh || this.#fits(q.x + 6, q.y - 19, wide - 6, 38);
      const chip = (lettering || active) && room && affordable && clear && this.#claim(q.x + 14, q.y - 11, wide - 22, 22, active);
      if (chip) {
        chipped.add(q.m.id);
        spent++;
      }
      marks.push([q, chip || active, active]);
    }
    for (const [q, chip, active] of marks) {
      this.#claim(q.x - 4, q.y - 4, 8, 8, true);
      this.#pin(q.m, q, chip, active);
    }
    this.chipped = chipped;

    // ---- cities ----
    const rankMax = cityRankLimit(z);
    if (rankMax >= 0) {
      for (const c of this.places) {
        if (c.rank > rankMax) break; // sorted by rank, so nothing further qualifies
        if (c.vx * cx + c.vy * cy + c.vz * cz < cosCity) continue;
        const p = projectPoint(c.lat, c.lon, camera, width, height, this.projection);
        if (!p.visible || p.edge < 0.5 || !inView(p)) continue;
        const w = estWidth(c.name, 7.1);
        if (!this.#claim(p.x - 3, p.y - 9, w, 19)) continue;
        const cls = c.capital ? "place place--capital" : "place";
        this.#place(`p:${c.name}:${c.lon}`, c.name, p, cls, p.edge, true);
      }
    }

    // ---- country plates ----
    // Kept deliberately scarce: a few large countries, and only where the
    // city pass has left room. Sorted by how much ground they cover, so the
    // plate that appears is the one with space around it.
    if (z > STYLE.labels.countryZoom) {
      const candidates = [];
      for (const c of this.countries) {
        if (c.rank > 3) break;
        const px = c.extent * ppd;
        if (px < 260 || px > 1500) continue;
        if (c.vx * cx + c.vy * cy + c.vz * cz < cosCountry) continue;
        const p = projectPoint(c.lat, c.lon, camera, width, height, this.projection);
        if (!p.visible || p.edge < 0.55 || !inView(p)) continue;
        candidates.push({ c, x: p.x, y: p.y, edge: p.edge, px });
      }
      candidates.sort((a, b) => b.px - a.px);
      let placed = 0;
      for (const hit of candidates) {
        if (placed >= STYLE.labels.countryMax) break;
        const w = estWidth(hit.c.name, 7.4);
        if (!this.#claim(hit.x - w / 2, hit.y - 13, w, 26)) continue;
        this.#place(`c:${hit.c.name}`, hit.c.name, hit, "place place--country", 0.92 * hit.edge);
        placed++;
      }
    }

    // Retire anything that missed this pass. Hiding has to happen on the
    // first miss, not after a few frames: label passes stop as soon as the
    // camera settles, so a node left visible would freeze there for good.
    for (const [key, node] of this.nodes) {
      if (this.live.has(key)) continue;
      if (node.idle === 0) {
        node.el.classList.remove("is-in", "show-chip");
        write(node, "opacity", "0");
        node.el.style.pointerEvents = "none";
      }
      if (++node.idle > 2) {
        node.el.remove();
        this.nodes.delete(key);
      }
    }
  }

  /** Greedy no-overlap test with a small breathing gap. */
  /** Whether a box is clear of everything claimed so far, without claiming it. */
  #fits(x, y, w, h) {
    const r = this.rects;
    for (let i = 0; i < r.length; i += 4) {
      if (x < r[i + 2] && x + w > r[i] && y < r[i + 3] && y + h > r[i + 1]) return false;
    }
    return true;
  }

  #claim(x, y, w, h, force = false) {
    const gap = 5;
    const x0 = x - gap;
    const y0 = y - gap;
    const x1 = x + w + gap;
    const y1 = y + h + gap;
    const r = this.rects;
    if (!force) {
      for (let i = 0; i < r.length; i += 4) {
        if (x0 < r[i + 2] && x1 > r[i] && y0 < r[i + 3] && y1 > r[i + 1]) return false;
      }
    }
    r.push(x0, y0, x1, y1);
    return true;
  }

  #node(key, build) {
    let node = this.nodes.get(key);
    if (!node) {
      node = { el: build(), idle: 0 };
      this.nodes.set(key, node);
      this.root.appendChild(node.el);
    }
    if (node.idle) node.el.style.pointerEvents = "";
    node.idle = 0;
    this.live.add(key);
    return node;
  }

  #pin(m, p, chip, active) {
    const key = `m:${m.id}`;
    const node = this.#node(key, () => {
      const el = document.createElement("button");
      el.className = "mark pin";
      el.type = "button";
      el.dataset.ministry = m.id;
      el.setAttribute("aria-label", `${m.name}, ${m.city} — ${m.openNeeds} open needs`);
      el.title = `${m.name} — ${m.openNeeds} open, ${m.peopleWanted} people wanted`;
      const dot = document.createElement("span");
      dot.className = "dot pin__dot";
      const label = document.createElement("span");
      label.className = "pin__chip";
      label.textContent = m.city;
      el.append(dot, label);
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        this.onPinClick?.(m);
      });
      el.addEventListener("pointerenter", () => this.onPinHover?.(m));
      el.addEventListener("pointerleave", () => this.onPinHover?.(null));
      return el;
    });
    const el = node.el;
    el.style.transform = `translate3d(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px,0)`;
    write(node, "opacity", (STYLE.markers.opacity * (this.dimmed.has(m.id) ? STYLE.markers.dimOpacity : 1) * clamp(p.edge, 0, 1)).toFixed(2));
    // A hard stop at the right edge, over the top of the estimate that decided
    // this plate would fit. estWidth measures a string against an average
    // glyph and is occasionally optimistic by a dozen pixels — which on a
    // desktop is slack nobody notices, and on a phone is a ministry's name
    // hanging off the side of the screen. The plate ellipsises instead.
    //
    // In steps, and only when the step changes: this is a width, so every
    // write is a relayout of the plate, and written at a pixel's precision it
    // changed on every frame of every drag for every pin on screen.
    write(node, "--chip-max", `${Math.max(56, Math.floor((this.width - p.x - 26) / 16) * 16)}px`);
    el.classList.toggle("show-chip", chip);
    el.classList.toggle("is-urgent", m.urgentNeeds > 0);
    el.classList.toggle("is-active", active);
    write(node, "zIndex", active ? "30" : "20");
  }

  #foundMark(i, f, p) {
    const node = this.#node(`f:${i}:${f.name}`, () => {
      const el = document.createElement("div");
      el.className = "mark found";
      el.title = f.name;
      const dot = document.createElement("span");
      dot.className = "found__dot";
      // The name, shown while it is the one opened, so the building the
      // camera came down onto says which church it is.
      const name = document.createElement("span");
      name.className = "found__name";
      name.textContent = f.org || f.name;
      el.append(dot, name);
      return el;
    });
    node.el.style.transform = `translate3d(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px,0)`;
    write(node, "opacity", clamp(p.edge, 0, 1).toFixed(2));
    node.el.classList.toggle("is-active", this.foundActive === f);
    write(node, "zIndex", this.foundActive === f ? "35" : "25");
  }

  #me(p, ppd) {
    const node = this.#node("me", () => {
      const el = document.createElement("div");
      el.className = "mark me";
      el.setAttribute("role", "img");
      el.setAttribute("aria-label", "Your location");
      const ring = document.createElement("span");
      ring.className = "me__accuracy";
      const dot = document.createElement("span");
      dot.className = "me__dot";
      el.append(ring, dot);
      return el;
    });
    node.el.style.transform = `translate3d(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px,0)`;
    write(node, "opacity", clamp(p.edge, 0, 1).toFixed(2));
    // The accuracy circle, at its true size on the ground: a degree of
    // latitude is 111 km. Hidden until it is bigger than the dot, and capped
    // so a city-wide guess does not paint the region blue.
    const r = ((this.user.accuracy ?? 0) / 111320) * ppd;
    write(node, "--acc", `${Math.min(r, 160).toFixed(0)}px`);
    node.el.classList.toggle("has-accuracy", r > 12);
    write(node, "zIndex", "40");
  }

  /**
   * The serve-locally radius: a true circle on the sphere, every point the
   * same distance along the ground from its centre, projected afresh each
   * pass — so it stays round where it faces the camera and bends with the
   * planet toward the limb. Where part of it goes round the back the edge
   * breaks there and the fill is left off, since an open outline has no
   * inside to fill. Its own SVG rather than a marker node: it is one shape,
   * always present while set, and the node pool retires what a pass misses.
   */
  #area(camera, width, height) {
    const a = this.area;
    if (!a) {
      if (this.areaEl) {
        this.areaEl.svg.style.display = "none";
        this.areaEl.tag.style.display = "none";
        this.areaEl.ring.style.display = "none";
      }
      return;
    }
    if (!this.areaEl) {
      const NS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("class", "radius");
      const fill = document.createElementNS(NS, "path");
      fill.setAttribute("class", "radius__fill");
      const edge = document.createElementNS(NS, "path");
      edge.setAttribute("class", "radius__edge");
      const tag = document.createElement("span");
      tag.className = "radius__tag";
      svg.append(fill, edge);
      // The circle's inside is a handle while it can be moved (`movable`).
      fill.addEventListener("pointerdown", (e) => {
        if (!this.area?.movable || !this.onAreaGrab?.(e)) return;
        e.stopPropagation();
        e.preventDefault();
      });
      this.root.prepend(svg, tag);
      const ring = cometRing(NS);
      svg.after(ring);
      this.areaEl = { svg, fill, edge, ring, tag, w: 0, h: 0 };
    }
    const el = this.areaEl;
    el.svg.style.display = "";
    el.svg.classList.toggle("is-movable", !!a.movable);
    if (el.w !== width || el.h !== height) {
      el.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      el.w = width;
      el.h = height;
    }

    // Points round the circle by the destination formula: from the centre,
    // `ang` radians along the ground at each bearing.
    const N = 120;
    const ang = a.miles / 3958.8;
    const la = a.lat * DEG;
    const lo = a.lon * DEG;
    const sinLa = Math.sin(la);
    const cosLa = Math.cos(la);
    const sinA = Math.sin(ang);
    const cosA = Math.cos(ang);
    const p = this.projection;
    let d = "";
    let pen = false;
    let whole = true;
    let top = null;
    let foot = null;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let i = 0; i <= N; i++) {
      const b = (i / N) * 2 * Math.PI;
      const lat2 = Math.asin(sinLa * cosA + cosLa * sinA * Math.cos(b));
      const lon2 = lo + Math.atan2(Math.sin(b) * sinA * cosLa, cosA - sinLa * Math.sin(lat2));
      projectPoint(lat2 / DEG, lon2 / DEG, camera, width, height, p);
      if (!p.visible) {
        whole = false;
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
      pen = true;
      if (i === 0) top = { x: p.x, y: p.y };
      else if (i === N / 2) foot = { x: p.x, y: p.y };
    }
    el.fill.setAttribute("d", whole ? `${d}Z` : "");
    el.edge.setAttribute("d", whole ? `${d}Z` : d);
    // Over the rim as drawn: a square on the circle's centre, as wide as its
    // mean diameter — a circle facing the camera projects round to well
    // under a pixel, and a broken rim (round the limb) hides it anyway. Square
    // because the light turns as one composited layer (globe.css), and a
    // turning layer has to be round to stay on the rim. Its size is only
    // written when it changes by a whole pixel: a new size is a new raster.
    if (whole) {
      const size = Math.round((x1 - x0 + y1 - y0) / 2);
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      el.ring.style.display = "";
      if (el.ringSize !== size) {
        el.ringSize = size;
        el.ring.style.width = el.ring.style.height = `${size}px`;
      }
      el.ring.style.transform = `translate3d(${(cx - size / 2).toFixed(1)}px,${(cy - size / 2).toFixed(1)}px,0)`;
    } else {
      el.ring.style.display = "none";
    }

    // The distance, written on the circle's northern edge — or its southern
    // one when the north runs up under the top of the screen, where the
    // brand and the bar are.
    const label = `${a.miles < 10 && a.miles % 1 ? a.miles.toFixed(1) : Math.round(a.miles)} mi`;
    if (el.tag.textContent !== label) el.tag.textContent = label;
    const at = top && top.y > 110 ? top : foot && foot.y < height - 24 ? foot : top;
    if (at) {
      el.tag.style.display = "";
      el.tag.style.transform = `translate3d(${at.x.toFixed(1)}px,${at.y.toFixed(1)}px,0)`;
      this.#claim(at.x - 22, at.y - 11, 44, 22, true);
    } else {
      el.tag.style.display = "none";
    }
  }

  #place(key, name, p, cls, opacity, tick = false) {
    const node = this.#node(key, () => {
      const el = document.createElement("div");
      el.className = `mark ${cls}`;
      if (tick) {
        const t = document.createElement("span");
        t.className = "place__tick";
        el.appendChild(t);
      }
      el.appendChild(document.createTextNode(name));
      return el;
    });
    const el = node.el;
    el.style.transform = `translate3d(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px,0)`;
    write(node, "opacity", clamp(opacity, 0, 1).toFixed(2));
    el.classList.add("is-in");
  }
}

/**
 * The light that runs round the serve-locally rim: a bright white head and a
 * trail behind it nearly the whole way round, growing fainter and thinner
 * and bluer until it is gone just before the head comes round again — so the
 * rim is drawn and fades and is drawn again. Built once, as short arcs on a
 * unit circle, each with its own width and opacity (a gradient along a path
 * is not something SVG or CSS can do); the widths are in screen pixels
 * (non-scaling-stroke), so stretching the box to the rim as projected keeps
 * the band the same thickness on a one-mile circle and a five-hundred-mile
 * one. The group turns (globe.css, .radius__comet), and the box is placed
 * over the rim each pass.
 */
function cometRing(NS) {
  const box = document.createElement("span");
  box.className = "radius__comet";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "-1 -1 2 2");
  svg.setAttribute("preserveAspectRatio", "none");
  const g = document.createElementNS(NS, "g");
  g.setAttribute("class", "radius__comet-spin");
  const N = 140;
  const SPAN = (340 * Math.PI) / 180;
  const head = -Math.PI / 2;
  const pt = (a) => `${Math.cos(a).toFixed(5)} ${Math.sin(a).toFixed(5)}`;
  const mix = (a, b, t) => Math.round(a + (b - a) * t);
  // Drawn tail first, so each piece nearer the head lies over the one behind.
  for (let i = N - 1; i >= 0; i--) {
    const f0 = i / N;
    const f1 = (i + 1) / N;
    const k = 1 - (f0 + f1) / 2; // 1 at the head, 0 at the end of the trail
    // A hair of overlap at each end, so the joins never show as seams.
    const a0 = head - f0 * SPAN + 0.002;
    const a1 = head - f1 * SPAN - 0.002;
    const c = document.createElementNS(NS, "path");
    c.setAttribute("d", `M${pt(a0)}A1 1 0 0 0 ${pt(a1)}`);
    c.setAttribute("vector-effect", "non-scaling-stroke");
    c.setAttribute("stroke-width", (0.4 + 3.4 * Math.pow(k, 1.5)).toFixed(2));
    c.setAttribute("stroke-opacity", Math.pow(k, 1.35).toFixed(3));
    // White at the head, into the rim's blue within the first sixth.
    const t = Math.min(1, (1 - k) / 0.16);
    c.setAttribute("stroke", `rgb(${mix(255, 74, t)} ${mix(255, 157, t)} ${mix(255, 255, t)})`);
    g.append(c);
  }
  // The head: a round dot of light the same few pixels on any circle.
  const glow = document.createElementNS(NS, "path");
  glow.setAttribute("class", "radius__comet-head");
  glow.setAttribute("d", "M0 -1L0.0001 -1");
  glow.setAttribute("vector-effect", "non-scaling-stroke");
  g.append(glow);
  svg.append(g);
  box.append(svg);
  return box;
}

/**
 * Sets one style on a marker only if it differs from what was last set.
 * The label layer runs every frame of every gesture; an unchanged value
 * written back is still a style invalidation, and with forty markers that is
 * forty recalcs a frame spent on nothing.
 */
function write(node, prop, value) {
  const last = (node.written ??= {});
  if (last[prop] === value) return;
  last[prop] = value;
  if (prop.startsWith("--")) node.el.style.setProperty(prop, value);
  else node.el.style[prop] = value;
}
