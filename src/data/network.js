/**
 * The queryable model over ministries and needs.
 *
 * Derived counts (open needs, people wanted, urgent) are recomputed rather
 * than stored, so a need posted in the browser moves every number and every
 * pin label with it.
 */
import { MINISTRIES } from "./ministries.js";
import { NEEDS } from "./needs.js";
import { FOCUS_BY_ID, REGION_BY_ID, TYPE_BY_ID, URGENCY_BY_ID } from "./taxonomy.js";
import { store } from "../ui/store.js";

const URGENCY_ORDER = { urgent: 0, soon: 1, ongoing: 2 };

export const emptyQuery = () => ({
  types: new Set(),
  urgencies: new Set(),
  focus: new Set(),
  regions: new Set(),
  locations: new Set(),
  text: "",
});

export const queryIsEmpty = (q) =>
  !q.text &&
  !q.types.size &&
  !q.urgencies.size &&
  !q.focus.size &&
  !q.regions.size &&
  !q.locations.size;

/* ------------------------------------------------------------- relevance */

const STOP = new Set(["a", "an", "and", "the", "of", "for", "to", "in", "on", "with", "or", "need", "needs", "help"]);

const normalise = (t) =>
  String(t ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const tokens = (t) => normalise(t).split(" ").filter(Boolean);

/** True when some word in `words` starts with `w` ("design" finds "designer"). */
const hasWord = (words, w) => words.some((x) => x.startsWith(w));

/**
 * How well a need answers a search, 0 for not at all.
 *
 * The AI tags carry most of it. They are ordered most specific first, so a
 * tag that *is* the search ("logo design") on a need scores far above the
 * same search merely containing a broad tag ("design"), and an early tag
 * beats a late one. Title and typed skills count next; place and ministry
 * names let "Nairobi" work; the description only ever tips a tie.
 */
function relevance(n, q) {
  const words = tokens(q).filter((w) => !STOP.has(w));
  if (!words.length) return 0;
  const tags = (n.tags || []).map(normalise);
  const title = normalise(n.title);
  const skills = (n.skills || []).map(normalise);
  let score = 0;

  // Whole-phrase matches.
  tags.forEach((t, i) => {
    const w = 1 - Math.min(i, 9) * 0.06;
    if (t === q) score += 100 * w;
    else if (t.includes(q)) score += 70 * w;
    else if (q.includes(t) && t.includes(" ")) score += 55 * w;
  });
  if (title.includes(q)) score += 80;
  if (skills.some((s) => s === q || s.includes(q))) score += 60;

  // Word by word, so "logo design" still finds every design job.
  const titleWords = tokens(n.title);
  const tagWords = tags.map((t) => t.split(" "));
  const skillWords = skills.flatMap((s) => s.split(" "));
  const placeWords = tokens(`${n.city} ${n.country} ${n.ministryName}`);
  const labelWords = tokens(
    `${TYPE_BY_ID.get(n.type)?.label ?? ""} ${FOCUS_BY_ID.get(n.focus)?.label ?? ""} ${n.remote ? "remote" : ""}`,
  );
  const detailWords = tokens(`${n.detail} ${n.commitment}`);
  let matched = 0;
  for (const w of words) {
    let best = 0;
    tagWords.forEach((tw, i) => {
      if (hasWord(tw, w)) best = Math.max(best, 14 - Math.min(i, 9));
    });
    if (hasWord(titleWords, w)) best = Math.max(best, 12);
    if (hasWord(skillWords, w)) best = Math.max(best, 9);
    if (hasWord(placeWords, w)) best = Math.max(best, 16);
    if (hasWord(labelWords, w)) best = Math.max(best, 6);
    if (best) matched++;
    else if (hasWord(detailWords, w)) score += 2;
    score += best;
  }
  // Nothing but a passing mention in the description is not a match.
  if (!matched && score < 50) return 0;
  return score + matched * 5;
}

export class Network {
  /**
   * Starts empty. The globe used to be a view over two files that were always
   * there; it is now a view over whatever the backend hands it, and at the
   * beginning that is nothing. An empty network is a legitimate state — a map
   * with no pins yet, not an error — so every derived figure below has to cope
   * with zero rather than assume at least one ministry exists.
   */
  constructor(data) {
    this.setData(data ?? { ministries: [], needs: [] });
  }

  /** Replaces the whole source set; call refresh() to rebuild the derived view. */
  setData({ ministries = [], needs = [] } = {}) {
    this.sourceMinistries = ministries;
    this.sourceNeeds = needs;
    return this.refresh();
  }

  /** The fictional set, for developing against before anyone has posted. */
  static demoData() {
    return { ministries: MINISTRIES, needs: NEEDS };
  }

  refresh() {
    const byId = new Map(this.sourceMinistries.map((m) => [m.id, m]));
    const posted = store.posted.map((n) => ({ ...n, mine: true }));
    this.needs = [...posted, ...this.sourceNeeds].map((n, order) => {
      const ministry = byId.get(n.ministry);
      return {
        ...n,
        order,
        ministryName: ministry?.name ?? "Unknown ministry",
        city: ministry?.city ?? "",
        country: ministry?.country ?? "",
        region: ministry?.region ?? "",
        lat: ministry?.lat ?? 0,
        lon: ministry?.lon ?? 0,
        taken: store.interestIn(n.id),
      };
    });

    this.byMinistry = new Map();
    for (const need of this.needs) {
      if (!this.byMinistry.has(need.ministry)) this.byMinistry.set(need.ministry, []);
      this.byMinistry.get(need.ministry).push(need);
    }

    this.ministries = this.sourceMinistries.map((m) => {
      const needs = this.byMinistry.get(m.id) ?? [];
      return {
        ...m,
        needs,
        openNeeds: needs.length,
        urgentNeeds: needs.filter((n) => n.urgency === "urgent").length,
        peopleWanted: needs.reduce((s, n) => s + (n.people || 0), 0),
      };
    });
    this.ministryById = new Map(this.ministries.map((m) => [m.id, m]));
    return this;
  }

  stats(needs = this.needs) {
    return {
      needs: needs.length,
      urgent: needs.filter((n) => n.urgency === "urgent").length,
      people: needs.reduce((s, n) => s + (n.people || 0), 0),
      ministries: new Set(needs.map((n) => n.ministry)).size,
      taken: needs.filter((n) => n.taken).length,
    };
  }

  /**
   * Needs matching a query. With no text, most pressing first. With text, by
   * relevance: each need is scored against the search, and the list comes back
   * best match first and flagged `relevance` so the panel and the board keep
   * that order instead of re-sorting by urgency.
   */
  select(query = emptyQuery()) {
    const text = normalise(query.text);
    const out = this.needs.filter((n) => {
      if (query.types.size && !query.types.has(n.type)) return false;
      if (query.urgencies.size && !query.urgencies.has(n.urgency)) return false;
      if (query.focus.size && !query.focus.has(n.focus)) return false;
      if (query.regions.size && !query.regions.has(n.region)) return false;
      if (query.locations.size && !query.locations.has(n.ministry)) return false;
      return true;
    });
    if (!text) return this.rank(out);

    // Direct matches first...
    const direct = new Map(out.map((n) => [n, relevance(n, text)]));

    // ...then what the AI tags say is *related*. The needs that match the
    // search as a whole phrase ("logo design") lend their other tags —
    // "brand identity", "graphic design" — and every need sharing them is
    // pulled up, even one whose own words never mention the search. The
    // specific family tags count for more than a bare "design".
    // Only the strongest few lend: a need that merely mentions the phrase in
    // passing must not drag its whole neighbourhood up with it.
    const seeds = [...direct]
      .filter(([n, score]) => score >= 55 && (n.tags || []).some((t) => normalise(t).includes(text)))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .filter(([, score], i, all) => score >= all[0][1] * 0.6);
    // With one strong match its tags are the family; with several, only the
    // tags they have in common are — what the matches are *about*, not what
    // any one of them happens to be about as well.
    const counts = new Map();
    for (const [n] of seeds) {
      for (const tag of new Set((n.tags || []).map(normalise))) {
        if (!tag.includes(text)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    const family = new Map();
    for (const [tag, count] of counts) {
      if (seeds.length > 1 && count < 2) continue;
      family.set(tag, tag.includes(" ") ? 18 : 8);
    }

    const scored = [];
    for (const [n, base] of direct) {
      let related = 0;
      if (family.size) for (const t of n.tags || []) related += family.get(normalise(t)) ?? 0;
      const score = base + Math.min(related, 60);
      if (base > 0 || related >= 16) scored.push({ n, score, direct: base > 0 });
    }
    const pressing = new Map(this.rank(scored.map((s) => s.n)).map((n, i) => [n, i]));
    scored.sort((a, b) => b.score - a.score || pressing.get(a.n) - pressing.get(b.n));
    // Anything that answers the search directly stays. What is only related
    // has to be meaningfully so: a faint tail of those reads as noise.
    const floor = (scored[0]?.score ?? 0) * 0.2;
    const ranked = scored.filter((s) => s.direct || s.score >= floor).map((s) => s.n);
    ranked.relevance = true;
    return ranked;
  }

  rank(needs) {
    return [...needs].sort(
      (a, b) =>
        URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency] ||
        (b.people || 0) - (a.people || 0) ||
        String(b.posted).localeCompare(String(a.posted)),
    );
  }

  /**
   * The panel's short list. One need per ministry, so a single well-organised
   * ministry with six urgent asks cannot crowd out thirty others; within that,
   * urgency decides and then the order the ministry itself listed them in.
   */
  pressing(limit = 6, needs = this.needs) {
    const ordered = needs.relevance
      ? needs
      : [...needs].sort((a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency] || a.order - b.order);
    const seen = new Set();
    const out = [];
    for (const need of ordered) {
      if (seen.has(need.ministry)) continue;
      seen.add(need.ministry);
      out.push(need);
      if (out.length >= limit) break;
    }
    return out;
  }

  sortBy(needs, mode) {
    if (mode === "newest") {
      return [...needs].sort((a, b) => String(b.posted).localeCompare(String(a.posted)));
    }
    if (mode === "people") {
      return [...needs].sort((a, b) => (b.people || 0) - (a.people || 0));
    }
    return needs.relevance ? needs : this.rank(needs);
  }

  /** Ministry ids that a query leaves out, for dimming their pins. */
  excluded(query) {
    if (queryIsEmpty(query)) return new Set();
    const kept = new Set(this.select(query).map((n) => n.ministry));
    return new Set(this.ministries.filter((m) => !kept.has(m.id)).map((m) => m.id));
  }

  needById(id) {
    return this.needs.find((n) => n.id === id) ?? null;
  }

  /** Search suggestions across needs, ministries, places and skills. */
  suggest(text, limit = 9) {
    const q = text.trim().toLowerCase();
    if (q.length < 2) return [];
    const rows = [];
    const seen = new Set();

    for (const m of this.ministries) {
      if (rows.length >= 40) break;
      if (`${m.name} ${m.city} ${m.country}`.toLowerCase().includes(q)) {
        rows.push({
          kind: "ministry",
          label: m.name,
          note: `${m.city} · ${m.openNeeds} open`,
          ministry: m,
          weight: m.name.toLowerCase().startsWith(q) ? 0 : 1,
        });
      }
    }

    for (const n of this.needs) {
      if (rows.length >= 60) break;
      if (n.title.toLowerCase().includes(q)) {
        rows.push({
          kind: "need",
          label: n.title,
          note: `${n.city} · ${TYPE_BY_ID.get(n.type)?.label ?? n.type}`,
          need: n,
          weight: n.title.toLowerCase().startsWith(q) ? 0 : 1,
        });
      }
    }

    const skills = new Map();
    for (const n of this.needs) {
      // Skills the ministry typed, and the AI tags — deduplicated by case.
      const seenHere = new Set();
      for (const s of [...(n.skills || []), ...(n.tags || [])]) {
        const key = s.toLowerCase();
        if (!key.includes(q) || seenHere.has(key)) continue;
        seenHere.add(key);
        skills.set(key, (skills.get(key) || 0) + 1);
      }
    }
    for (const [skill, count] of skills) {
      rows.push({
        kind: "skill",
        label: skill,
        note: `${count} need${count === 1 ? "" : "s"}`,
        skill,
        weight: 2,
      });
    }

    for (const group of [FOCUS_BY_ID, REGION_BY_ID, TYPE_BY_ID]) {
      for (const item of group.values()) {
        if (!item.label.toLowerCase().includes(q)) continue;
        rows.push({ kind: "filter", label: item.label, note: "filter", item, group, weight: 3 });
      }
    }

    return rows
      .filter((r) => {
        const key = `${r.kind}:${r.label}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.weight - b.weight || a.label.length - b.label.length)
      .slice(0, limit);
  }

  addNeed(data) {
    const id = `u${Date.now().toString(36)}`;
    store.addPosted({ ...data, id, posted: new Date().toISOString().slice(0, 10) });
    this.refresh();
    return id;
  }

  toggleInterest(id) {
    const on = store.toggleInterest(id);
    this.refresh();
    return on;
  }
}
