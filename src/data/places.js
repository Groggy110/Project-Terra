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
