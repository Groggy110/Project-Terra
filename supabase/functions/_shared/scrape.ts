/**
 * Finding the churches and ministries round a point, and reading their
 * websites for ways to help.
 *
 * Who is there comes from OpenStreetMap: Christian places of worship and
 * social facilities — food banks, shelters, care homes — that list a website.
 * The page looks them up itself (src/lib/places.js), because Nominatim turns
 * away cloud servers and Overpass answers a browser more readily than it does
 * a data centre; pickOrgs() checks what it sends. When it sends nothing,
 * findOrgs() asks Overpass from here, raced across its mirrors.
 *
 * Each website is then read the way a person would look for a way in: the
 * home page, and the one or two pages it links to that sound like serving —
 * volunteer, outreach, get involved, missions — plus a contact page when the
 * home page shows no address. robots.txt is honoured, every fetch has a short
 * deadline and a size cap, and the bot says who it is. What comes back is
 * plain text for the model to read, with the email addresses and phone
 * numbers found on those pages kept separately, so a contact shown to the
 * visitor is always one that was actually published, never one the model
 * wrote.
 */

export interface Org {
  key: string;
  name: string;
  kind: string;
  /** NaN for a find from the web search, which has no position of its own. */
  lat: number;
  lon: number;
  miles: number;
  /** "map": OpenStreetMap, inside the circle. "web": a web search for the area. */
  found?: "map" | "web";
  /** For a web find: what the search was for, and the snippet it returned. */
  query?: string;
  snippet?: string;
  website: string;
  town?: string;
  address?: string;
  denomination?: string;
  email?: string;
  phone?: string;
}

export interface Page {
  url: string;
  text: string;
}

export interface Site {
  pages: Page[];
  emails: string[];
  phones: string[];
}

const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const UA = "TerraBot/1.0 (finds volunteer opportunities at local churches and ministries for Terra; contact via website)";

/** Hosts that are a denomination's or a platform's, not one congregation's. */
const SHARED_HOSTS = /(^|\.)(facebook|instagram|twitter|x|youtube|linktr|google|sites\.google|churchofjesuschrist|jw|lds|wix|squarespace|weebly|wordpress)\.(com|org|ee)$/i;

export function distanceMiles(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = Math.PI / 180;
  const dLat = (bLat - aLat) * r;
  const dLon = (bLon - aLon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Resolves with the first of `tasks` to succeed; rejects only when all fail. */
function firstOk<T>(tasks: Promise<T>[]): Promise<T> {
  return new Promise((resolve, reject) => {
    let left = tasks.length;
    for (const t of tasks) t.then(resolve, () => --left === 0 && reject(new Error("all failed")));
  });
}

async function fetchWithin(url: string, ms: number, init: RequestInit = {}): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal, headers: { "User-Agent": UA, ...(init.headers ?? {}) } });
  } finally {
    clearTimeout(timer);
  }
}

type Element = { lat?: number | string; lon?: number | string; center?: { lat: number; lon: number }; tags?: Record<string, string> };

/** Overpass, raced across its mirrors: the organisations, and the towns. */
async function fromOverpass(lat: number, lon: number, miles: number, ms: number) {
  const at = `(around:${Math.round(miles * 1609.34)},${lat.toFixed(4)},${lon.toFixed(4)})`;
  const run = (query: string) =>
    firstOk(
      OVERPASS.map((url) =>
        fetchWithin(url, ms, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ data: `[out:json][timeout:${Math.round(ms / 1000) - 1}];${query}` }),
        }).then(async (res) => {
          if (!res.ok) throw new Error(`overpass ${res.status}`);
          const body = await res.json();
          if (!Array.isArray(body?.elements)) throw new Error("overpass: no elements");
          return body.elements as Element[];
        }),
      ),
    );
  const [orgs, towns] = await Promise.allSettled([
    run(`(nwr["amenity"="place_of_worship"]["religion"="christian"]["website"]${at};nwr["social_facility"]["website"]${at};);out center tags 400;`),
    run(`node["place"~"^(city|town)$"]${at};out tags 60;`),
  ]);
  return {
    orgs: orgs.status === "fulfilled" ? orgs.value : null,
    places:
      towns.status === "fulfilled"
        ? towns.value
            .sort((a, b) => (Number(b.tags?.population) || 0) - (Number(a.tags?.population) || 0))
            .map((e) => e.tags?.name)
            .filter((n): n is string => !!n)
        : [],
  };
}

/** A place as the page found it (src/lib/places.js) or Overpass returned it. */
export interface RawOrg {
  name?: unknown;
  lat?: unknown;
  lon?: unknown;
  website?: unknown;
  kind?: unknown;
  town?: unknown;
  address?: unknown;
  denomination?: unknown;
  email?: unknown;
  phone?: unknown;
}

const str = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");

/**
 * The organisations worth reading: inside the circle, with a website that is
 * their own — not a denomination's or a platform's, which would say nothing
 * about the congregation down the road — one per website, nearest first.
 */
export function pickOrgs(raw: RawOrg[], lat: number, lon: number, miles: number, limit: number): Org[] {
  const all: Org[] = [];
  for (const r of raw) {
    const la = Number(r.lat);
    const lo = Number(r.lon);
    const name = str(r.name, 120);
    const site = str(r.website, 300);
    if (!Number.isFinite(la) || !Number.isFinite(lo) || !name || !site) continue;
    const d = distanceMiles(lat, lon, la, lo);
    if (d > miles * 1.02) continue;
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`);
    } catch {
      continue;
    }
    if (!publicHost(url)) continue;
    all.push({
      key: "",
      name,
      kind: str(r.kind, 40) || "church",
      lat: la,
      lon: lo,
      miles: d,
      website: url.href,
      town: str(r.town, 60) || undefined,
      address: str(r.address, 160) || undefined,
      denomination: str(r.denomination, 40) || undefined,
      email: str(r.email, 120) || undefined,
      phone: str(r.phone, 40) || undefined,
    });
  }
  const hostOf = (o: Org) => new URL(o.website).hostname.replace(/^www\./, "");
  const names = new Map<string, Set<string>>();
  for (const o of all) names.set(hostOf(o), (names.get(hostOf(o)) ?? new Set()).add(o.name));
  const seen = new Set<string>();
  return all
    .sort((a, b) => a.miles - b.miles)
    .filter((o) => {
      const host = hostOf(o);
      if (SHARED_HOSTS.test(host) || (names.get(host)?.size ?? 0) > 3 || seen.has(host)) return false;
      seen.add(host);
      return true;
    })
    .slice(0, limit)
    .map((o, i) => ({ ...o, key: `w${i + 1}` }));
}

/**
 * The page sends the places it found, so this function fetches addresses it
 * was handed: only public web hosts, never this machine or a private network.
 */
function publicHost(url: URL): boolean {
  if (!/^https?:$/.test(url.protocol) || url.port && !["80", "443"].includes(url.port)) return false;
  const h = url.hostname.toLowerCase();
  if (!h.includes(".") || /^(localhost|.*\.local|.*\.internal|.*\.localhost)$/.test(h)) return false;
  if (/^\[|^(0|10|127)\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return false;
  return /[a-z]/.test(h.split(".").pop() ?? "");
}

/**
 * Overpass from here, for when the page could not look itself: the
 * organisations and the towns inside the circle.
 */
export async function findOrgs(lat: number, lon: number, miles: number, { limit = 18, ms = 20000 } = {}) {
  const over = await fromOverpass(lat, lon, miles, ms);
  const raw: RawOrg[] = (over.orgs ?? []).map((e) => {
    const t = e.tags ?? {};
    return {
      name: t.name,
      lat: e.lat ?? e.center?.lat,
      lon: e.lon ?? e.center?.lon,
      website: t.website || t["contact:website"],
      kind: t.social_facility ? t.social_facility.replace(/_/g, " ") : "church",
      town: t["addr:city"],
      address: [t["addr:housenumber"], t["addr:street"], t["addr:city"]].filter(Boolean).join(" "),
      denomination: t.denomination?.replace(/_/g, " "),
      email: t.email || t["contact:email"],
      phone: t.phone || t["contact:phone"],
    };
  });
  return { orgs: pickOrgs(raw, lat, lon, miles, limit), places: over.places };
}

/* ---------------------------------------------------------- web search */

/**
 * Most churches on the map list no website (in Manila, about one in twenty),
 * and plenty of ministries are not on the map at all. So the agent also
 * searches the web for the area, the way a person would: volunteer roles at
 * churches, outreach asking for help, feeding programmes and shelters. Each
 * result is then read like any other website (readSite), so what the visitor
 * is shown is what the page says, not what the search engine summarised.
 *
 * Tavily, a search API made for agents; off unless TAVILY_API_KEY is set.
 */
const SEARCH = "https://api.tavily.com/search";

/** Listing and social sites whose pages say nothing a visitor could act on. */
const NOT_A_SOURCE = /(^|\.)(facebook|instagram|twitter|x|youtube|tiktok|linkedin|pinterest|reddit|wikipedia|tripadvisor|yelp|indeed|glassdoor|jobstreet|scribd|issuu)\.[a-z.]+$/i;

export function searchQueries(area: string): string[] {
  return [
    `church volunteer opportunities in ${area}`,
    `Christian ministry outreach volunteers needed ${area}`,
    `feeding program, shelter or food bank volunteer ${area}`,
  ];
}

export async function searchWeb(
  area: string,
  { key, limit = 10, ms = 9000 }: { key: string; limit?: number; ms?: number },
): Promise<Org[]> {
  const ask = (query: string) =>
    fetchWithin(SEARCH, ms, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, search_depth: "basic", max_results: 8, include_answer: false }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) =>
        ((body?.results ?? []) as { title?: string; url?: string; content?: string }[]).map((x) => ({ ...x, query })),
      )
      .catch(() => []);
  const lists = await Promise.all(searchQueries(area).map(ask));
  const results = [];
  for (let i = 0; i < 8; i++) for (const list of lists) if (list[i]) results.push(list[i]);

  // One per website, in the order the searches ranked them, round-robin
  // across the searches so one kind of opportunity cannot crowd out the rest.
  const seen = new Set<string>();
  const out: Org[] = [];
  for (const r of results) {
    let url: URL;
    try {
      url = new URL(String(r.url ?? ""));
    } catch {
      continue;
    }
    const host = url.hostname.replace(/^www\./, "");
    if (!publicHost(url) || SHARED_HOSTS.test(host) || NOT_A_SOURCE.test(host) || seen.has(host)) continue;
    if (/\.(pdf|docx?|xlsx?|pptx?)$/i.test(url.pathname)) continue;
    seen.add(host);
    out.push({
      key: "",
      name: str(r.title, 120) || host,
      kind: "ministry",
      lat: NaN,
      lon: NaN,
      miles: NaN,
      website: url.href,
      town: area,
      found: "web",
      query: r.query,
      snippet: str(r.content, 300),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/* ------------------------------------------------------------- reading */

const robotsCache = new Map<string, Promise<string[]>>();

/** The Disallow rules that apply to every bot, for one origin. */
function disallowed(origin: string): Promise<string[]> {
  let p = robotsCache.get(origin);
  if (!p) {
    p = fetchWithin(`${origin}/robots.txt`, 2500)
      .then((r) => (r.ok ? r.text() : ""))
      .then((txt) => {
        const rules: string[] = [];
        let applies = false;
        for (const raw of txt.split(/\r?\n/)) {
          const line = raw.replace(/#.*/, "").trim();
          const [k, ...rest] = line.split(":");
          const v = rest.join(":").trim();
          if (/^user-agent$/i.test(k)) applies = v === "*" || /terrabot/i.test(v);
          else if (applies && /^disallow$/i.test(k) && v) rules.push(v);
        }
        return rules;
      })
      .catch(() => []);
    robotsCache.set(origin, p);
  }
  return p;
}

async function allowed(url: URL): Promise<boolean> {
  const rules = await disallowed(url.origin);
  return !rules.some((r) => url.pathname.startsWith(r));
}

async function getHtml(url: URL, ms = 5000, cap = 600_000): Promise<string | null> {
  if (!(await allowed(url))) return null;
  try {
    const res = await fetchWithin(url.href, ms, { redirect: "follow", headers: { Accept: "text/html" } });
    if (!res.ok || !/html/i.test(res.headers.get("content-type") ?? "html")) return null;
    const reader = res.body?.getReader();
    if (!reader) return null;
    const dec = new TextDecoder();
    let html = "";
    while (html.length < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      html += dec.decode(value, { stream: true });
    }
    reader.cancel().catch(() => {});
    return html;
  } catch {
    return null;
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…" };

function decode(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** The readable words of a page, roughly as they would be read. */
export function pageText(html: string): string {
  return decode(
    html
      .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(br|\/p|\/li|\/h[1-6]|\/div|\/section|\/tr)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Cloudflare's address obfuscation: a hex key byte, then the address XORed with it. */
function cfDecode(hex: string): string {
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
const IS_EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i;
const NOT_EMAIL = /\.(png|jpe?g|gif|webp|svg|css|js)$|@(example|sentry|wixpress|domain|email|yourdomain|sentry-next)\./i;

export function emailsIn(html: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/data-cfemail="([0-9a-f]+)"/gi)) found.add(cfDecode(m[1]).toLowerCase());
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) found.add(decodeURIComponent(m[1]).toLowerCase());
  for (const m of decode(html).matchAll(EMAIL)) found.add(m[0].toLowerCase());
  return [...found].filter((e) => IS_EMAIL.test(e) && !NOT_EMAIL.test(e));
}

export function phonesIn(html: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/href=["']tel:([^"']+)["']/gi)) {
    const p = decodeURIComponent(m[1]).replace(/[^\d+()\-. ]/g, "").trim();
    if (p.replace(/\D/g, "").length >= 7) found.add(p);
  }
  return [...found];
}

/** How much a link sounds like a way to serve; contact pages score separately. */
const SERVE = [
  [/volunteer/i, 6],
  [/serve|serving/i, 5],
  [/get[-_ ]?involved|involve/i, 5],
  [/outreach/i, 5],
  [/mission/i, 4],
  [/food|pantry|meal|shelter|homeless|clothing/i, 4],
  [/need|help|opportunit/i, 3],
  [/ministr/i, 3],
  [/community|care|local/i, 2],
  [/connect|next[-_ ]?step/i, 1],
] as const;

function linksOf(html: string, base: URL): { url: URL; serve: number; contact: boolean }[] {
  const out = new Map<string, { url: URL; serve: number; contact: boolean }>();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url: URL;
    try {
      url = new URL(decode(m[1]), base);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol) || url.hostname.replace(/^www\./, "") !== base.hostname.replace(/^www\./, "")) continue;
    if (/\.(pdf|jpe?g|png|gif|zip|mp3|mp4|docx?)$/i.test(url.pathname) || url.pathname === base.pathname) continue;
    const label = `${url.pathname} ${pageText(m[2])}`.slice(0, 200);
    let serve = 0;
    for (const [re, w] of SERVE) if (re.test(label)) serve += w;
    if (/give|donat|sermon|podcast|watch|livestream|blog|news|event|calendar|login|staff|beliefs?|history/i.test(url.pathname)) serve -= 3;
    const contact = /contact|about[-_ ]?us|reach[-_ ]?us/i.test(label);
    url.hash = "";
    const prev = out.get(url.href);
    if (!prev || serve > prev.serve) out.set(url.href, { url, serve, contact: contact || !!prev?.contact });
  }
  return [...out.values()];
}

/**
 * One organisation's website, read for ways to serve: the home page and up to
 * two serving pages, plus its contact page when the others show no email.
 */
export async function readSite(org: Org): Promise<Site> {
  const home = new URL(org.website);
  const html = await getHtml(home);
  if (!html) return { pages: [], emails: org.email ? [org.email.toLowerCase()] : [], phones: org.phone ? [org.phone] : [] };

  const links = linksOf(html, home);
  const serve = links.filter((l) => l.serve >= 3).sort((a, b) => b.serve - a.serve).slice(0, 2);
  const emails = new Set(emailsIn(html));
  if (org.email) emails.add(org.email.toLowerCase());
  const contact = !emails.size ? links.find((l) => l.contact && !serve.includes(l)) : undefined;

  const more = await Promise.all(
    [...serve, ...(contact ? [contact] : [])].map(async (l) => ({ url: l.url, html: await getHtml(l.url, 4500) })),
  );

  // A web find's first page is the opportunity itself, not a home page, so
  // more of it is kept.
  const pages: Page[] = [{ url: home.href, text: pageText(html).slice(0, org.found === "web" ? 2600 : 900) }];
  const phones = new Set(phonesIn(html));
  if (org.phone) phones.add(org.phone);
  for (const p of more) {
    if (!p.html) continue;
    for (const e of emailsIn(p.html)) emails.add(e);
    for (const t of phonesIn(p.html)) phones.add(t);
    pages.push({ url: p.url.href, text: pageText(p.html).slice(0, 2000) });
  }

  // The organisation's own addresses first: an office@ on its own domain is
  // a better first contact than the web designer's in the footer.
  const own = home.hostname.replace(/^www\./, "");
  const ranked = [...emails].sort((a, b) => Number(b.endsWith(own)) - Number(a.endsWith(own)));
  return { pages, emails: ranked.slice(0, 6), phones: [...phones].slice(0, 3) };
}
