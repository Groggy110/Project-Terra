/** Shared vocabulary. Filter chips, forms and badges all read from here. */

export const NEED_TYPES = [
  { id: "volunteers", label: "Volunteers", short: "Volunteers" },
  { id: "expertise", label: "Expertise", short: "Expertise" },
  { id: "supplies", label: "Supplies", short: "Supplies" },
  { id: "funding", label: "Funding", short: "Funding" },
  { id: "partners", label: "Partners", short: "Partners" },
];

export const URGENCIES = [
  { id: "urgent", label: "Urgent", note: "needed within weeks" },
  { id: "soon", label: "Soon", note: "needed this season" },
  { id: "ongoing", label: "Ongoing", note: "a standing need" },
];

export const FOCUS_AREAS = [
  { id: "children", label: "Children & youth" },
  { id: "refugees", label: "Refugees & displacement" },
  { id: "health", label: "Health & clinics" },
  { id: "education", label: "Education & literacy" },
  { id: "shelter", label: "Shelter & rebuild" },
  { id: "food", label: "Food security" },
  { id: "water", label: "Water & sanitation" },
  { id: "trauma", label: "Trauma & counselling" },
  { id: "translation", label: "Bible translation" },
  { id: "discipleship", label: "Discipleship" },
  { id: "work", label: "Livelihoods & work" },
  { id: "prison", label: "Prison & aftercare" },
];

export const REGIONS = [
  { id: "africa", label: "Africa" },
  { id: "asia", label: "Asia" },
  { id: "europe", label: "Europe" },
  { id: "latam", label: "Latin America" },
  { id: "mena", label: "Middle East & North Africa" },
  { id: "northam", label: "North America" },
];

const index = (list) => new Map(list.map((x) => [x.id, x]));

export const TYPE_BY_ID = index(NEED_TYPES);
export const URGENCY_BY_ID = index(URGENCIES);
export const FOCUS_BY_ID = index(FOCUS_AREAS);
export const REGION_BY_ID = index(REGIONS);

export const labelOf = (map, id, fallback = "—") => map.get(id)?.label ?? fallback;
