/** Shared vocabulary. Filter chips, forms and badges all read from here. */

export const NEED_TYPES = [
  // The two kinds of help a person gives online. The ids predate the labels
  // (and the database checks them), so only the words changed: hands-on is
  // doing the work yourself, advisory is guiding the ministry's own people.
  { id: "volunteers", label: "Hands-on", short: "Hands-on", note: "You do the work" },
  { id: "expertise", label: "Advisory", short: "Advisory", note: "You advise their team" },
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
  { id: "technology", label: "Technology & IT" },
  { id: "media", label: "Media & communications" },
  { id: "design", label: "Design & creative" },
  { id: "admin", label: "Finance & administration" },
  { id: "legal", label: "Legal & HR" },
  { id: "fundraising", label: "Fundraising & development" },
  { id: "leadership", label: "Leadership & strategy" },
  { id: "worship", label: "Worship & music" },
];

export const REGIONS = [
  { id: "africa", label: "Africa" },
  { id: "asia", label: "Asia" },
  { id: "europe", label: "Europe" },
  { id: "latam", label: "Latin America" },
  { id: "mena", label: "Middle East & North Africa" },
  { id: "northam", label: "North America" },
  { id: "oceania", label: "Oceania" },
];

const index = (list) => new Map(list.map((x) => [x.id, x]));

export const TYPE_BY_ID = index(NEED_TYPES);
export const URGENCY_BY_ID = index(URGENCIES);
export const FOCUS_BY_ID = index(FOCUS_AREAS);
export const REGION_BY_ID = index(REGIONS);

export const labelOf = (map, id, fallback = "—") => map.get(id)?.label ?? fallback;
