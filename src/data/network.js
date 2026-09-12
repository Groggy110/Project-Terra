/**
 * The queryable model over ministries and needs.
 *
 * Derived counts (open needs, people wanted, urgent) are recomputed rather
 * than stored, so a need posted in the browser moves every number and every
 * pin label with it.
 */
import { MINISTRIES, MINISTRY_BY_ID } from "./ministries.js";
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

export class Network {
  constructor() {
    this.refresh();
  }

  refresh() {
    const posted = store.posted.map((n) => ({ ...n, mine: true }));
    this.needs = [...posted, ...NEEDS].map((n, order) => {
      const ministry = MINISTRY_BY_ID.get(n.ministry);
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

    this.ministries = MINISTRIES.map((m) => {
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

  /** Needs matching a query, most pressing first. */
  select(query = emptyQuery()) {
    const text = query.text.trim().toLowerCase();
    const words = text ? text.split(/\s+/) : [];
    const out = this.needs.filter((n) => {
      if (query.types.size && !query.types.has(n.type)) return false;
      if (query.urgencies.size && !query.urgencies.has(n.urgency)) return false;
      if (query.focus.size && !query.focus.has(n.focus)) return false;
      if (query.regions.size && !query.regions.has(n.region)) return false;
      if (query.locations.size && !query.locations.has(n.ministry)) return false;
      if (!words.length) return true;
      const hay = [
        n.title,
        n.ministryName,
        n.city,
        n.country,
        n.detail,
        n.commitment,
        (n.skills || []).join(" "),
        TYPE_BY_ID.get(n.type)?.label,
        FOCUS_BY_ID.get(n.focus)?.label,
        URGENCY_BY_ID.get(n.urgency)?.label,
        n.remote ? "remote" : "",
      ]
        .join(" ")
        .toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    return this.rank(out);
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
    const ordered = [...needs].sort(
      (a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency] || a.order - b.order,
    );
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
    return this.rank(needs);
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
      for (const s of n.skills || []) {
        if (!s.toLowerCase().includes(q)) continue;
        skills.set(s, (skills.get(s) || 0) + 1);
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
