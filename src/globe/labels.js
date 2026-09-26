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

const CITY_Z = 0.28;
const COUNTRY_Z = 0.12;
const COUNTRY_MAX = 3;

/**
 * Zoom at which pins start carrying their city plate. At the whole-globe view
 * thirty plates cover the disc they are meant to annotate, and every one of
 * them lands on the headline; a field of bare dots reads as pressure on the
 * map, which is what that view is for. Hovering one still names it.
 */
const PIN_CHIP_Z = 0.07;

/**
 * Rank ceiling for city labels as the camera comes in. Deliberately steep at
 * the start: the first names should arrive as soon as the view is regional,
 * then fill in gradually rather than all at once.
 */
function cityRankLimit(z) {
  if (z < CITY_Z) return -1;
  return Math.floor(-1 + 11 * Math.sqrt(clamp((z - CITY_Z) / 0.62, 0, 1)));
}

const estWidth = (text, per) => text.length * per + 14;

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
  constructor(root, { onPinClick, onPinHover } = {}) {
    this.root = root;
    this.onPinClick = onPinClick;
    this.onPinHover = onPinHover;
    this.forceLettering = false;

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
    for (const m of this.ministries) {
      const p = projectPoint(m.lat, m.lon, camera, width, height, this.projection);
      if (!p.visible || !inView(p)) continue;
      queue.push({ m, x: p.x, y: p.y, edge: p.edge });
    }
    let cursor = 0;
    for (let i = 0; i < queue.length; i++) {
      if (!held.has(queue[i].m.id)) continue;
      const q = queue[i];
      queue[i] = queue[cursor];
      queue[cursor++] = q;
    }
    // The entrance letters its pins too, though it sits just below the zoom
    // that would: the names are what make the opening globe read as a map.
    const lettering = z > PIN_CHIP_Z || this.forceLettering;

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
    const budget = Math.max(4, Math.round((width * height) / 58000));
    let spent = 0;

    for (const q of queue) {
      const active = this.selected === q.m.id;
      const wide = 24 + estWidth(q.m.city, 7.6);
      // A plate opens to the right of its dot, so one near the right edge runs
      // off the screen and gets clipped mid-word. On a desktop there is always
      // slack there; on a phone the globe reaches both edges and it happens to
      // two or three pins at once. Rather than flip the plate — which would
      // put the name on the wrong side of the dot it belongs to — the pin
      // falls back to a bare dot, which is what it does when a plate will not
      // fit for any other reason.
      const room = q.x - 8 + wide < width - 6;
      const affordable = active || spent < budget;
      const chip =
        (lettering || active) && room && affordable && this.#claim(q.x - 8, q.y - 23, wide, 26, active);
      if (chip) {
        chipped.add(q.m.id);
        spent++;
      }
      else if (!this.#claim(q.x - 8, q.y - 21, 16, 23)) continue;
      this.#pin(q.m, q, chip || active, active);
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
    if (z > COUNTRY_Z) {
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
        if (placed >= COUNTRY_MAX) break;
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
        node.el.style.opacity = "0";
        node.el.style.pointerEvents = "none";
      }
      if (++node.idle > 2) {
        node.el.remove();
        this.nodes.delete(key);
      }
    }
  }

  /** Greedy no-overlap test with a small breathing gap. */
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
      // A map pin rather than a dot: the tip stands on the city, the head
      // carries the colour. Inline so it inherits `color` from the theme.
      const dot = document.createElement("span");
      dot.className = "pin__dot";
      dot.innerHTML =
        '<svg viewBox="0 0 14 19" aria-hidden="true"><path d="M7 18.2C7 18.2 1.2 11.5 1.2 7.1a5.8 5.8 0 0 1 11.6 0C12.8 11.5 7 18.2 7 18.2Z"/><circle cx="7" cy="7" r="2.2"/></svg>';
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
    el.style.opacity = (this.dimmed.has(m.id) ? 0.28 : 1) * clamp(p.edge, 0, 1);
    // A hard stop at the right edge, over the top of the estimate that decided
    // this plate would fit. estWidth measures a string against an average
    // glyph and is occasionally optimistic by a dozen pixels — which on a
    // desktop is slack nobody notices, and on a phone is a ministry's name
    // hanging off the side of the screen. The plate ellipsises instead.
    el.style.setProperty("--chip-max", `${Math.max(56, Math.round(this.width - p.x - 26))}px`);
    el.classList.toggle("show-chip", chip);
    el.classList.toggle("is-urgent", m.urgentNeeds > 0);
    el.classList.toggle("is-active", active);
    el.style.zIndex = active ? 30 : 20;
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
    el.style.opacity = clamp(opacity, 0, 1);
    el.classList.add("is-in");
  }
}
