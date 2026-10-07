/**
 * A geocoder made out of data the page already ships.
 *
 * The ministry form used to ask for latitude and longitude, which is a
 * reasonable thing to need and an unreasonable thing to ask: nobody running a
 * clinic in Mathare knows their coordinates, and the instruction to go and
 * right-click a different website is an admission that the form cannot do its
 * job. But the globe cannot draw a pin without them.
 *
 * So they are looked up here instead. `public/vectors/places.json` is the same
 * 5,596-place gazetteer the label layer letters cities from, and
 * `countries.json` the same 242 country label points — both already fetched
 * for the globe, both cached by the browser by the time anyone opens a form.
 * No network call, no API key, no third party told who is signing up.
 *
 * Rows are positional to keep the files small:
 *   places     [name, lon, lat, rank, population, country, isCapital]
 *   countries  [name, lon, lat, rank, area, continent]
 */

let placesPromise = null;
let countriesPromise = null;

const loadPlaces = () =>
  (placesPromise ??= fetch("/vectors/places.json")
    .then((r) => r.json())
    .then((rows) =>
      rows.map(([name, lon, lat, , population, country]) => ({
        name,
        country,
        lat,
        lon,
        population: population || 0,
        key: fold(name),
        countryKey: fold(country),
      })),
    )
    .catch(() => []));

const loadCountries = () =>
  (countriesPromise ??= fetch("/vectors/countries.json")
    .then((r) => r.json())
    .then((rows) =>
      rows.map(([name, lon, lat, , , continent]) => ({
        name,
        lat,
        lon,
        continent,
        key: fold(name),
      })),
    )
    .catch(() => []));

/** Warms both files so the first keystroke in a form is not the fetch. */
export function primePlaces() {
  loadPlaces();
  loadCountries();
}

/**
 * Case, accent and punctuation folded away, so "Sao Paulo", "SÃO PAULO" and
 * "São Paulo" are one key. Without this a third of the gazetteer is
 * unreachable by anyone typing on an English keyboard.
 */
function fold(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Common names for countries the gazetteer spells formally. */
const COUNTRY_ALIASES = new Map(
  Object.entries({
    usa: "united states of america",
    us: "united states of america",
    "united states": "united states of america",
    uk: "united kingdom",
    "great britain": "united kingdom",
    england: "united kingdom",
    scotland: "united kingdom",
    wales: "united kingdom",
    drc: "democratic republic of the congo",
    "dr congo": "democratic republic of the congo",
    "south korea": "republic of korea",
    "north korea": "dem rep korea",
    uae: "united arab emirates",
    "ivory coast": "cote d ivoire",
    czechia: "czech republic",
    burma: "myanmar",
  }),
);

const countryKey = (s) => {
  const k = fold(s);
  return COUNTRY_ALIASES.get(k) ?? k;
};

/**
 * Ranked city matches for a typed fragment.
 *
 * Ranking is exact name, then starts-with, then contains, and population
 * breaks every tie — so "san" offers São Paulo and San Antonio before San
 * Cristóbal, which is what someone typing three letters means.
 */
export async function searchPlaces(query, { limit = 7, country = "" } = {}) {
  const q = fold(query);
  if (q.length < 2) return [];
  const rows = await loadPlaces();
  const wantCountry = country ? countryKey(country) : "";

  const scored = [];
  for (const p of rows) {
    let score;
    if (p.key === q) score = 0;
    else if (p.key.startsWith(q)) score = 1;
    else if (p.key.includes(q)) score = 2;
    else continue;
    // A country already typed is a filter, not a hint: someone who wrote
    // "Kenya" does not want Nairobi, Namibia offered above Nairobi, Kenya.
    if (wantCountry && p.countryKey !== wantCountry) score += 4;
    scored.push({ place: p, score });
  }

  scored.sort((a, b) => a.score - b.score || b.place.population - a.place.population);
  return scored.slice(0, limit).map((s) => s.place);
}

/**
 * The pin for a typed city and country.
 *
 * Returns what it found *and how*, because the form says so out loud: an
 * exact city is a pin on the city, a country-only match is a pin at the
 * middle of the country, and the difference matters enough that the person
 * posting should be told which one they are getting.
 */
export async function resolvePlace(city, country) {
  const cityKey = fold(city);
  const ckey = countryKey(country);

  if (cityKey) {
    const rows = await loadPlaces();
    const exact = rows.filter((p) => p.key === cityKey);
    const inCountry = ckey ? exact.filter((p) => p.countryKey === ckey) : [];
    const pool = inCountry.length ? inCountry : ckey ? [] : exact;
    if (pool.length) {
      const best = pool.reduce((a, b) => (b.population > a.population ? b : a));
      return { kind: "city", lat: best.lat, lon: best.lon, city: best.name, country: best.country };
    }
  }

  if (ckey) {
    const countries = await loadCountries();
    const hit = countries.find((c) => c.key === ckey);
    if (hit) {
      return { kind: "country", lat: hit.lat, lon: hit.lon, city: city.trim(), country: hit.name, continent: hit.continent };
    }
  }

  return null;
}

/**
 * Places for the serve-locally search, best first: the countries and cities
 * the gazetteer knows that match a typed fragment. Each is
 * `{ name, country, lat, lon, kind }`, `country` empty for a country.
 */
export async function suggestPlaces(query, { limit = 6 } = {}) {
  const q = fold(query);
  if (q.length < 2) return [];
  const [cities, countries] = await Promise.all([searchPlaces(query, { limit }), loadCountries()]);
  const ck = countryKey(query);
  const lands = countries
    .filter((c) => c.key === ck || (q.length > 2 && c.key.startsWith(q)))
    .slice(0, 2)
    .map((c) => ({ name: c.name, country: "", lat: c.lat, lon: c.lon, kind: "country" }));
  const towns = cities.map((p) => ({ name: p.name, country: p.country, lat: p.lat, lon: p.lon, kind: "city" }));
  // A country typed in full comes first; otherwise the cities lead.
  const exactLand = lands.length && lands[0].name && countryKey(lands[0].name) === ck;
  return (exactLand ? [...lands, ...towns] : [...towns, ...lands]).slice(0, limit);
}

/**
 * The one place a typed name means: the gazetteer's best match, or — for a
 * town too small for it — OpenStreetMap's search, asked from the browser.
 * null when neither knows it.
 */
export async function findPlace(query) {
  const [best] = await suggestPlaces(query, { limit: 1 });
  if (best && (fold(best.name) === fold(query) || countryKey(best.name) === countryKey(query))) return best;
  try {
    const params = new URLSearchParams({ q: query, format: "jsonv2", limit: "1", addressdetails: "1" });
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
    const [hit] = res.ok ? await res.json() : [];
    if (hit) {
      const a = hit.address ?? {};
      const kind = hit.addresstype === "country" ? "country" : "city";
      return {
        name: a.city || a.town || a.village || a.municipality || a.county || a.state || a.country || hit.name || query.trim(),
        country: kind === "country" ? "" : a.country || "",
        lat: Number(hit.lat),
        lon: Number(hit.lon),
        kind,
      };
    }
  } catch {
    // Offline or turned away: the gazetteer's nearest guess, if it had one.
  }
  return best ?? null;
}

/**
 * "Show me Los Angeles", "take me to Paris, France", or just "Kenya": the
 * find bar's way of being asked to go somewhere rather than asked a
 * question. Words like these at the front say it is a place being asked for.
 */
const GO_TO =
  /^(?:(?:please|hey terra|terra)[, ]+)?(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:show(?: me)?(?: where)?|take me(?: to| over to)?|bring me(?: to)?|fly(?: me)?(?: over)?(?: to)?|go(?: over)?(?: to)?|zoom(?: in| out)?(?: on| to| into| in on)?|head(?: over)?(?: to)?|travel(?: to)?|navigate(?: to)?|jump(?: to)?|move(?: to)?|spin(?: to)?|visit|find|locate|where(?:'s| is)|cent(?:er|re)(?: on)?|focus(?: on)?|let'?s go(?: to)?|i want to (?:see|go to|visit))\s+/i;

/** Words that mean a question about the map's needs, not a place on it. */
const NOT_A_PLACE =
  /\b(?:needs?|ministr(?:y|ies)|opportunit(?:y|ies)|churche?s?|volunteer\w*|serve|serving|help|ways?|things?|something|anything|what|how|who|why|when|i|me|my|near|nearby|around|close|jobs?|work|projects?|kids|children|families|people)\b/i;

/**
 * The place a find-bar entry asks to go to, as `{ name, country, lat, lon,
 * kind, population }`, or null when it is a question for Ask Terra instead.
 *
 * A bare entry has to be a place the gazetteer knows by exactly that name,
 * so a question that happens to contain a city still goes to Ask Terra. One
 * that says "show me" or "take me to" may also be looked up on
 * OpenStreetMap, for a town too small for the gazetteer. `bare: false`
 * takes only the second kind.
 */
export async function placeAsked(text, { ms = 4000, bare = true } = {}) {
  let rest = String(text ?? "").trim().replace(/[?.!]+$/, "");
  const go = rest.match(GO_TO);
  // In the conversation a bare "Kenya" is a follow-up, not a destination.
  if (!go && !bare) return null;
  if (go) rest = rest.slice(go[0].length);
  rest = rest
    .replace(/\s+(?:on|in) the (?:map|globe)$/i, "")
    .replace(/[, ]+(?:please|for me)$/i, "")
    .replace(/^(?:the city of|the town of|the)\s+/i, "")
    .trim();
  if (fold(rest).length < 2 || rest.split(/\s+/).length > 6 || NOT_A_PLACE.test(rest)) return null;

  const withPeople = async (p) => {
    if (!p || p.kind !== "city") return p;
    const rows = await loadPlaces();
    const row = rows.find((r) => r.key === fold(p.name) && (!p.country || r.country === p.country));
    return { ...p, population: row?.population ?? 0 };
  };

  // Exactly a city or a country the gazetteer knows.
  const [best] = await suggestPlaces(rest, { limit: 1 });
  if (best && (fold(best.name) === fold(rest) || countryKey(best.name) === countryKey(rest))) return withPeople(best);

  // "Paris, France", "Springfield, Illinois", "Los Angeles, CA".
  const comma = rest.indexOf(",");
  if (comma > 0) {
    const city = rest.slice(0, comma).trim();
    const where = rest.slice(comma + 1).trim();
    const hit = await resolvePlace(city, where);
    if (hit?.kind === "city") return withPeople({ name: hit.city, country: hit.country, lat: hit.lat, lon: hit.lon, kind: "city" });
    if (!go) {
      const [first] = await suggestPlaces(city, { limit: 1 });
      if (first && first.kind === "city" && fold(first.name) === fold(city)) return withPeople(first);
    }
  }
  // A bare town the gazetteer is too small to hold — "La Mirada" — is
  // still somewhere to go, if OpenStreetMap knows a settlement of exactly
  // that name and ranks it as a real place. Only for a few words: anything
  // longer is a question, and the guide answers it.
  if (!go) {
    if (!bare || rest.split(/\s+/).length > 3 || /[\d?]/.test(rest)) return null;
    const timeout = new Promise((done) => setTimeout(() => done(null), Math.min(ms, 2500)));
    return Promise.race([settlementNamed(rest).catch(() => null), timeout]).then(withPeople);
  }

  // Asked for by name: worth a look further afield, but not worth a wait.
  const timeout = new Promise((done) => setTimeout(() => done(null), ms));
  return Promise.race([findPlace(rest).catch(() => null), timeout]).then(withPeople);
}

/**
 * A town or city called exactly `name`, from OpenStreetMap, or null. The
 * name must match what was typed and the place must rank as somewhere
 * people would mean by it (importance ≥ 0.45: La Mirada is 0.53, while
 * "nurse" finds a Swedish town at 0.37 by a near spelling) — so a word that
 * happens to be a hamlet somewhere is not taken for a destination.
 */
async function settlementNamed(name) {
  const params = new URLSearchParams({ q: name, format: "jsonv2", limit: "1", addressdetails: "1", featureType: "settlement" });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
  const [hit] = res.ok ? await res.json() : [];
  if (!hit || hit.importance < 0.45) return null;
  const a = hit.address ?? {};
  const town = a.city || a.town || a.village || a.municipality || hit.name;
  if (fold(town) !== fold(name) && fold(hit.name ?? "") !== fold(name)) return null;
  return { name: town, country: a.country || "", lat: Number(hit.lat), lon: Number(hit.lon), kind: "city" };
}

/* ------------------------------------------------------------------ region */

/**
 * The filter rail's regions are not continents: "Middle East & North Africa"
 * cuts across two of them, and Latin America is South America plus most of
 * what Natural Earth files under North. So the continent is a fallback and
 * these two lists are the actual answer.
 */
const MENA = new Set(
  [
    "Algeria", "Bahrain", "Egypt", "Iran", "Iraq", "Israel", "Jordan", "Kuwait", "Lebanon",
    "Libya", "Morocco", "Oman", "Palestine", "Qatar", "Saudi Arabia", "Syria", "Tunisia",
    "Turkey", "United Arab Emirates", "Yemen", "Western Sahara",
  ].map(fold),
);

const LATAM = new Set(
  [
    "Mexico", "Guatemala", "Belize", "Honduras", "El Salvador", "Nicaragua", "Costa Rica",
    "Panama", "Cuba", "Haiti", "Dominican Republic", "Jamaica", "Puerto Rico",
    "Trinidad and Tobago", "Bahamas",
  ].map(fold),
);

const BY_CONTINENT = {
  Africa: "africa",
  Asia: "asia",
  Europe: "europe",
  "South America": "latam",
  "North America": "northam",
};

/** The filter region for a country, or null when it does not map cleanly. */
export async function regionFor(country) {
  const key = countryKey(country);
  if (!key) return null;
  if (MENA.has(key)) return "mena";
  if (LATAM.has(key)) return "latam";
  const countries = await loadCountries();
  const hit = countries.find((c) => c.key === key);
  return hit ? BY_CONTINENT[hit.continent] ?? null : null;
}
