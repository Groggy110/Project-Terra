/**
 * The churches and ministries inside a circle, from OpenStreetMap — looked up
 * from the page rather than the server, because Nominatim turns away cloud
 * servers outright and Overpass answers a browser more readily than a data
 * centre. The serve-local function reads their websites; this only says who
 * is there.
 *
 * Two sources at once. Nominatim, OpenStreetMap's search, is quick and
 * steady but gives fifty results a query and searches a box, not a circle —
 * so a few queries inside the circle's bounding box, a second apart as its
 * usage policy asks. Overpass can ask exactly "inside this circle, with a
 * website", but its public servers are volunteer-run and often busy, so the
 * query goes to several mirrors and the first answer wins — and it is given
 * a deadline rather than waited on. Both are merged; the function sorts out
 * duplicates, distance and which websites are worth reading.
 */

const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const NOMINATIM = "https://nominatim.openstreetmap.org/search";

/** What Nominatim is asked for, in order; "church" twice, for a second page. */
const SEARCHES = ["church", "church", "food bank", "ministry", "mission"];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function within(url, ms, init = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

const address = (t) => [t["addr:housenumber"], t["addr:street"], t["addr:city"]].filter(Boolean).join(" ");

async function fromNominatim(lat, lon, miles) {
  const dLat = miles / 69.05;
  const dLon = miles / (69.17 * Math.max(Math.cos((lat * Math.PI) / 180), 0.05));
  const viewbox = [lon - dLon, lat + dLat, lon + dLon, lat - dLat].map((v) => v.toFixed(4)).join(",");
  const out = [];
  const seen = [];
  for (const [i, q] of SEARCHES.entries()) {
    if (i) await wait(1100);
    const params = { q, format: "jsonv2", extratags: "1", addressdetails: "1", limit: "50", bounded: "1", viewbox };
    if (q === "church" && seen.length) params.exclude_place_ids = seen.join(",");
    try {
      const res = await within(`${NOMINATIM}?${new URLSearchParams(params)}`, 6000);
      if (!res.ok) continue;
      for (const r of await res.json()) {
        if (q === "church") seen.push(r.place_id);
        const t = r.extratags ?? {};
        const a = r.address ?? {};
        out.push({
          name: r.name,
          lat: Number(r.lat),
          lon: Number(r.lon),
          website: t.website || t["contact:website"],
          kind: q === "church" ? "church" : (t.social_facility?.replace(/_/g, " ") ?? q),
          town: a.city ?? a.town ?? a.village ?? a.suburb ?? "",
          address: [a.house_number, a.road, a.city ?? a.town ?? a.village].filter(Boolean).join(" "),
          denomination: t.denomination?.replace(/_/g, " "),
          email: t.email || t["contact:email"],
          phone: t.phone || t["contact:phone"],
        });
      }
    } catch {
      // One search missing is a shorter list, not a failure.
    }
  }
  return out;
}

async function fromOverpass(lat, lon, miles, ms) {
  const at = `(around:${Math.round(miles * 1609.34)},${lat.toFixed(4)},${lon.toFixed(4)})`;
  const head = `[out:json][timeout:${Math.round(ms / 1000)}];`;
  // Two requests, so a busy server failing the towns cannot cost the
  // churches, and the churches with a website under either tag.
  const orgsQuery = `${head}(nwr["amenity"="place_of_worship"]["religion"="christian"]["website"]${at};nwr["amenity"="place_of_worship"]["religion"="christian"]["contact:website"]${at};nwr["social_facility"]["website"]${at};);out center tags 300;`;
  const townsQuery = `${head}(node[place=city]${at};node[place=town]${at};);out tags 40;`;
  const ask = (query) => (url) =>
    within(url, ms, { method: "POST", body: new URLSearchParams({ data: query }) }).then(async (res) => {
      if (!res.ok) throw new Error(`overpass ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body?.elements)) throw new Error("overpass");
      return body.elements;
    });
  const [found, places] = await Promise.allSettled([Promise.any(OVERPASS.map(ask(orgsQuery))), Promise.any(OVERPASS.map(ask(townsQuery)))]);
  if (found.status !== "fulfilled" && places.status !== "fulfilled") throw new Error("overpass");
  const elements = [...(found.status === "fulfilled" ? found.value : []), ...(places.status === "fulfilled" ? places.value : [])];
  const towns = elements
    .filter((e) => e.tags?.place)
    .sort((a, b) => (Number(b.tags.population) || 0) - (Number(a.tags.population) || 0))
    .map((e) => e.tags.name)
    .filter(Boolean);
  const orgs = elements
    .filter((e) => !e.tags?.place)
    .map((e) => {
      const t = e.tags ?? {};
      return {
        name: t.name,
        lat: e.lat ?? e.center?.lat,
        lon: e.lon ?? e.center?.lon,
        website: t.website || t["contact:website"],
        kind: t.social_facility ? t.social_facility.replace(/_/g, " ") : "church",
        town: t["addr:city"] ?? "",
        address: address(t),
        denomination: t.denomination?.replace(/_/g, " "),
        email: t.email || t["contact:email"],
        phone: t.phone || t["contact:phone"],
      };
    });
  return { orgs, towns };
}

/**
 * The name of the place at a point — "Quezon City, Philippines" — for the
 * agent's web search when the circle is round the visitor rather than a
 * place they typed. Empty when OpenStreetMap will not say.
 */
export async function areaName(lat, lon) {
  try {
    const params = new URLSearchParams({ lat: lat.toFixed(4), lon: lon.toFixed(4), format: "jsonv2", zoom: "10", addressdetails: "1" });
    const res = await within(`https://nominatim.openstreetmap.org/reverse?${params}`, 5000);
    if (!res.ok) return "";
    const a = (await res.json())?.address ?? {};
    const town = a.city || a.town || a.municipality || a.village || a.county || a.state || "";
    return [town, a.country].filter(Boolean).join(", ");
  } catch {
    return "";
  }
}

/**
 * `{ orgs, places }`: the organisations with a website inside the circle
 * (unsorted, possibly repeated across sources) and the towns in it, biggest
 * first. Resolves within about `ms`, with whatever was found by then.
 */
export async function findLocalOrgs(lat, lon, miles, { ms = 16000 } = {}) {
  const [nomi, over] = await Promise.allSettled([fromNominatim(lat, lon, miles), fromOverpass(lat, lon, miles, ms)]);
  const orgs = [
    ...(over.status === "fulfilled" ? over.value.orgs : []),
    ...(nomi.status === "fulfilled" ? nomi.value : []),
  ].filter((o) => o.name && o.website && Number.isFinite(o.lat) && Number.isFinite(o.lon));

  let places = over.status === "fulfilled" ? over.value.towns : [];
  if (!places.length && nomi.status === "fulfilled") {
    // No towns from Overpass: the ones the search results are in, by how
    // many of them each has.
    const count = new Map();
    for (const o of nomi.value) if (o.town) count.set(o.town, (count.get(o.town) ?? 0) + 1);
    places = [...count].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  }
  return { orgs: orgs.slice(0, 120), places: places.slice(0, 12) };
}
