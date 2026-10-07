/**
 * The world-wide sample: a few hundred fictional ministries in real cities on
 * every inhabited continent, and enough open needs between them that the
 * network holds about a thousand.
 *
 *   import { WORLD_MINISTRIES, WORLD_NEEDS } from "./world_sample.mjs";
 *
 * Generated, not written: the cities come from public/vectors/places.json
 * (Natural Earth, with populations), and every name, blurb and need is put
 * together from the templates below by a seeded random generator — so the set
 * is the same every run, and changing a template changes every row it made.
 *
 * Like the hand-written set in src/data, ALL OF THIS IS FICTIONAL. Contacts
 * are on example.org. Every ministry's slug starts "w-", which is how the
 * seed finds its own rows to replace (tools/build_world_seed.mjs).
 *
 * Most ministries are in the big cities, where the globe shows them from the
 * whole-planet view; a smaller share are in towns, which the globe only
 * letters as you zoom in (labels.js, pin tiers).
 */
import { readFileSync } from "node:fs";
import { MINISTRIES } from "../src/data/ministries.js";
import { NEEDS } from "../src/data/needs.js";

/** Needs across the whole network, hand-written set included. */
const TARGET_NEEDS = 1000;
// Kept few on purpose: each is a pin, and the globe should read as a map
// of where help is needed, not a rash of dots. The needs are shared out
// among them, so a ministry carries several.
const MAJOR_MINISTRIES = 115; // cities of a million or more
const TOWN_MINISTRIES = 35; // cities of 150,000 to a million

/* ---------------------------------------------------------------- random */

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261006);
const pick = (list) => list[Math.floor(rand() * list.length)];
const between = (a, b) => a + Math.floor(rand() * (b - a + 1));
const shuffle = (list) => {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};
const slugify = (s) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/* ------------------------------------------------------------- geography */

const MENA = new Set(["Algeria", "Bahrain", "Egypt", "Iran", "Iraq", "Israel", "Jordan", "Kuwait", "Lebanon", "Libya", "Morocco", "Oman", "Palestine", "Qatar", "Saudi Arabia", "Syria", "Tunisia", "Turkey", "United Arab Emirates", "Yemen", "Western Sahara"]);
const EUROPE = new Set(["Albania", "Andorra", "Austria", "Belarus", "Belgium", "Bosnia and Herzegovina", "Bulgaria", "Croatia", "Cyprus", "Czechia", "Denmark", "Estonia", "Finland", "France", "Germany", "Greece", "Hungary", "Iceland", "Ireland", "Italy", "Kosovo", "Latvia", "Lithuania", "Luxembourg", "Malta", "Moldova", "Montenegro", "Netherlands", "North Macedonia", "Norway", "Poland", "Portugal", "Romania", "Russia", "Serbia", "Slovakia", "Slovenia", "Spain", "Sweden", "Switzerland", "Ukraine", "United Kingdom", "Georgia", "Armenia"]);
const AFRICA = new Set(["Angola", "Benin", "Botswana", "Burkina Faso", "Burundi", "Cameroon", "Cape Verde", "Central African Republic", "Chad", "Comoros", "Congo (Brazzaville)", "Congo (Kinshasa)", "Djibouti", "Equatorial Guinea", "Eritrea", "Ethiopia", "Gabon", "Ghana", "Guinea", "Guinea Bissau", "Ivory Coast", "Kenya", "Lesotho", "Liberia", "Madagascar", "Malawi", "Mali", "Mauritania", "Mauritius", "Mozambique", "Namibia", "Niger", "Nigeria", "Rwanda", "Senegal", "Sierra Leone", "Somalia", "Somaliland", "South Africa", "South Sudan", "Sudan", "Tanzania", "The Gambia", "Togo", "Uganda", "Zambia", "Zimbabwe", "eSwatini"]);
const NORTHAM = new Set(["United States of America", "Canada"]);
const OCEANIA = new Set(["Australia", "New Zealand", "Papua New Guinea", "Fiji", "Solomon Islands", "Vanuatu", "Samoa", "Tonga", "New Caledonia"]);
const LATAM = new Set(["Argentina", "Belize", "Bolivia", "Brazil", "Chile", "Colombia", "Costa Rica", "Cuba", "Dominican Republic", "Ecuador", "El Salvador", "Guatemala", "Guyana", "Haiti", "Honduras", "Jamaica", "Mexico", "Nicaragua", "Panama", "Paraguay", "Peru", "Puerto Rico", "Suriname", "Trinidad and Tobago", "Uruguay", "Venezuela"]);
const SKIP = new Set(["Antarctica", "North Korea", "Greenland", "Svalbard and Jan Mayen Islands", "Falkland Islands", "South Georgia and the Islands"]);

function regionOf(country) {
  if (MENA.has(country)) return "mena";
  if (EUROPE.has(country)) return "europe";
  if (AFRICA.has(country)) return "africa";
  if (NORTHAM.has(country)) return "northam";
  if (OCEANIA.has(country)) return "oceania";
  if (LATAM.has(country)) return "latam";
  return "asia";
}

/** The languages a ministry there would work in; English as the bridge. */
const LANGS = {
  "United States of America": ["English", "Spanish"], Canada: ["English", "French"], Mexico: ["Spanish"], Brazil: ["Portuguese"],
  Argentina: ["Spanish"], Colombia: ["Spanish"], Peru: ["Spanish", "Quechua"], Chile: ["Spanish"], Venezuela: ["Spanish"],
  Ecuador: ["Spanish"], Bolivia: ["Spanish", "Aymara"], Guatemala: ["Spanish", "K'iche'"], Haiti: ["Haitian Creole", "French"],
  "Dominican Republic": ["Spanish"], Cuba: ["Spanish"], Honduras: ["Spanish"], Nicaragua: ["Spanish"], Paraguay: ["Spanish", "Guarani"],
  Uruguay: ["Spanish"], "El Salvador": ["Spanish"], Panama: ["Spanish"], "Costa Rica": ["Spanish"], Jamaica: ["English"],
  "United Kingdom": ["English"], France: ["French"], Germany: ["German"], Italy: ["Italian"], Spain: ["Spanish"], Portugal: ["Portuguese"],
  Netherlands: ["Dutch"], Belgium: ["French", "Dutch"], Poland: ["Polish"], Ukraine: ["Ukrainian", "Russian"], Russia: ["Russian"],
  Romania: ["Romanian"], Greece: ["Greek"], Hungary: ["Hungarian"], Czechia: ["Czech"], Serbia: ["Serbian"], Bulgaria: ["Bulgarian"],
  Sweden: ["Swedish"], Norway: ["Norwegian"], Finland: ["Finnish"], Denmark: ["Danish"], Austria: ["German"], Switzerland: ["German", "French"],
  Ireland: ["English"], Moldova: ["Romanian", "Russian"], Belarus: ["Belarusian", "Russian"], Albania: ["Albanian"], Georgia: ["Georgian"], Armenia: ["Armenian"],
  Egypt: ["Arabic"], Morocco: ["Arabic", "French"], Algeria: ["Arabic", "French"], Tunisia: ["Arabic", "French"], Turkey: ["Turkish"],
  Iraq: ["Arabic", "Kurdish"], Iran: ["Persian"], Jordan: ["Arabic"], Lebanon: ["Arabic", "French"], Syria: ["Arabic"], Yemen: ["Arabic"],
  "Saudi Arabia": ["Arabic"], Israel: ["Hebrew", "Arabic"], Palestine: ["Arabic"], Libya: ["Arabic"], Oman: ["Arabic"],
  Nigeria: ["Hausa", "Yoruba", "Igbo"], Kenya: ["Swahili"], Tanzania: ["Swahili"], Uganda: ["Luganda", "Swahili"], Ethiopia: ["Amharic"],
  "South Africa": ["Zulu", "Xhosa", "Afrikaans"], Ghana: ["Twi"], "Congo (Kinshasa)": ["French", "Lingala"], "Congo (Brazzaville)": ["French", "Lingala"],
  Cameroon: ["French"], "Ivory Coast": ["French"], Senegal: ["French", "Wolof"], Mali: ["French", "Bambara"], Niger: ["French", "Hausa"],
  "Burkina Faso": ["French", "Mooré"], Angola: ["Portuguese"], Mozambique: ["Portuguese"], Zambia: ["Bemba"], Zimbabwe: ["Shona"],
  Malawi: ["Chichewa"], Rwanda: ["Kinyarwanda", "French"], Burundi: ["Kirundi", "French"], Madagascar: ["Malagasy", "French"],
  Sudan: ["Arabic"], "South Sudan": ["Arabic"], Somalia: ["Somali"], Guinea: ["French"], "Sierra Leone": ["Krio"], Liberia: ["English"],
  Benin: ["French"], Togo: ["French"], Chad: ["French", "Arabic"], Namibia: ["Afrikaans"], Botswana: ["Setswana"],
  India: ["Hindi"], Pakistan: ["Urdu"], Bangladesh: ["Bengali"], China: ["Mandarin"], Japan: ["Japanese"], "South Korea": ["Korean"],
  Indonesia: ["Indonesian"], Philippines: ["Filipino"], Vietnam: ["Vietnamese"], Thailand: ["Thai"], Myanmar: ["Burmese"],
  Malaysia: ["Malay"], Cambodia: ["Khmer"], Laos: ["Lao"], Nepal: ["Nepali"], "Sri Lanka": ["Sinhala", "Tamil"], Afghanistan: ["Dari", "Pashto"],
  Kazakhstan: ["Kazakh", "Russian"], Uzbekistan: ["Uzbek"], Kyrgyzstan: ["Kyrgyz", "Russian"], Tajikistan: ["Tajik"], Mongolia: ["Mongolian"],
  Taiwan: ["Mandarin"], "Hong Kong S.A.R.": ["Cantonese"], Singapore: ["Mandarin", "Malay"], Australia: ["English"], "New Zealand": ["English", "Māori"],
  "Papua New Guinea": ["Tok Pisin"], Fiji: ["Fijian"], Azerbaijan: ["Azerbaijani"], Turkmenistan: ["Turkmen"],
};
const langsOf = (country) => {
  const own = LANGS[country] ?? [];
  return own.includes("English") ? own : [...own, "English"];
};

/* -------------------------------------------------------------- the cities */

const PLACES = JSON.parse(readFileSync(new URL("../public/vectors/places.json", import.meta.url)));
const taken = new Set(MINISTRIES.map((m) => `${m.city}|${m.country}`));

/**
 * The largest cities first, a few to a country so the network is spread over
 * the world rather than piled into the five most populous countries.
 */
function chooseCities(min, max, count, perCountry) {
  const candidates = PLACES.filter(
    (p) => p[4] >= min && p[4] < max && !SKIP.has(p[5]) && !taken.has(`${p[0]}|${p[5]}`),
  ).sort((a, b) => b[4] - a[4]);
  const used = new Map();
  const out = [];
  for (const p of candidates) {
    const cap = perCountry(p[5]);
    const n = used.get(p[5]) ?? 0;
    if (n >= cap) continue;
    used.set(p[5], n + 1);
    taken.add(`${p[0]}|${p[5]}`);
    out.push({ city: p[0], lon: p[1], lat: p[2], pop: p[4], country: p[5] });
    if (out.length === count) break;
  }
  return out;
}

const BIG = new Set(["China", "India", "United States of America", "Brazil", "Indonesia", "Nigeria", "Russia", "Mexico", "Pakistan"]);
const majors = chooseCities(1_000_000, Infinity, MAJOR_MINISTRIES, (c) => (BIG.has(c) ? 4 : 2));
// Towns are taken in a shuffled order, so the smaller share is spread round
// the world rather than every one of them landing in the two biggest towns of
// each country.
const towns = shuffle(chooseCities(150_000, 1_000_000, 600, (c) => (BIG.has(c) ? 2 : 1))).slice(0, TOWN_MINISTRIES);

/* ------------------------------------------------------------ the ministries */

const FOCI = ["children", "refugees", "health", "education", "shelter", "food", "water", "trauma", "translation", "discipleship", "work", "prison"];

const NAMES = {
  children: ["Kids' Club", "Youth Network", "Children's Home", "Young Lives Trust", "After-School Project"],
  refugees: ["Refugee Welcome", "Newcomers Network", "Welcome House", "Open Door Collective"],
  health: ["Community Clinic", "Health Outreach", "Care Clinic", "Mobile Health Team"],
  education: ["Learning Centre", "Literacy Project", "Study House", "Reading Trust"],
  shelter: ["Housing Trust", "Rebuild Network", "Safe Roof Project", "Shelter Partners"],
  food: ["Food Bank", "Community Kitchen", "Daily Bread Project", "Harvest Table"],
  water: ["Clean Water Project", "Living Water Trust", "Wells & Taps Network"],
  trauma: ["Counselling Centre", "Care Network", "Healing Hearts", "Listening House"],
  translation: ["Bible Translation Team", "Scripture Project", "Word in Every Tongue"],
  discipleship: ["Church Network", "Discipleship Fellowship", "Mission Fellowship", "House Church Network"],
  work: ["Skills Centre", "Livelihoods Co-op", "Workshop Trust", "Fair Work Project"],
  prison: ["Prison Fellowship", "Aftercare House", "Second Chance Network"],
};
const PREFIX = ["Hope", "Grace", "New Day", "Light", "Bridge", "Harvest", "Shalom", "Mercy", "Lighthouse", "Cornerstone", "Good Shepherd", "Open Hands"];

const WORK = {
  children: "after-school clubs, homework help and a safe place to be for children whose parents work long shifts",
  refugees: "first-month accompaniment for newly arrived families: paperwork, language help and someone to call",
  health: "a small clinic and home visits for the families furthest from a hospital",
  education: "literacy classes, school-fee support and evening study for young people who left school early",
  shelter: "repairs and rebuilding for households living in unsafe homes, one street at a time",
  food: "a weekly food distribution and a community kitchen run by the people who use it",
  water: "tanks, taps and hygiene training in neighbourhoods the water network never reached",
  trauma: "trauma-informed counselling and support groups for people living with what they have seen",
  translation: "translating Scripture and study material into the languages spoken in the neighbourhoods around it",
  discipleship: "small groups, leadership training and support for pastors serving without pay",
  work: "skills training, small business coaching and savings groups for families without steady income",
  prison: "visits, family support and a place to land for people leaving prison",
};

/** Where piped water is a given, a ministry would not be digging wells. */
const WELL_SERVED = new Set(["europe", "northam", "oceania"]);
const RICH_ASIA = new Set(["Japan", "South Korea", "Taiwan", "Singapore", "Hong Kong S.A.R.", "Israel", "United Arab Emirates", "Qatar", "Kuwait", "Saudi Arabia"]);

function ministryFor(c, i, tier) {
  const region = regionOf(c.country);
  const foci = WELL_SERVED.has(region) || RICH_ASIA.has(c.country) ? FOCI.filter((f) => f !== "water") : FOCI;
  const focus = [pick(foci)];
  if (rand() < 0.55) {
    const second = pick(foci.filter((f) => f !== focus[0]));
    focus.push(second);
  }
  const kind = pick(NAMES[focus[0]]);
  const name = rand() < 0.55 ? `${c.city} ${kind}` : `${pick(PREFIX)} ${kind}`;
  const slug = `w-${slugify(c.city)}-${slugify(kind)}`.slice(0, 60);
  const since = between(1985, 2024);
  const host = slugify(name.includes(c.city) ? name : `${name} ${c.city}`).slice(0, 40).replace(/-+$/, "");
  return {
    id: slug,
    name,
    city: c.city,
    country: c.country,
    lat: +c.lat.toFixed(4),
    lon: +c.lon.toFixed(4),
    region,
    focus,
    since,
    staff: tier === "major" ? between(6, 40) : between(2, 12),
    languages: langsOf(c.country),
    contact: `${pick(["hello", "office", "info", "team", "contact"])}@${host}.example.org`,
    blurb: `Based in ${c.city}, ${c.country} since ${since}: ${WORK[focus[0]]}.`,
    tier,
  };
}

const slugs = new Set(MINISTRIES.map((m) => m.id));
export const WORLD_MINISTRIES = [];
for (const [list, tier] of [[majors, "major"], [towns, "town"]]) {
  list.forEach((c, i) => {
    const m = ministryFor(c, i, tier);
    let slug = m.id;
    for (let k = 2; slugs.has(slug); k++) slug = `${m.id}-${k}`;
    m.id = slug;
    slugs.add(slug);
    WORLD_MINISTRIES.push(m);
  });
}

/* ------------------------------------------------------------------ needs */

/**
 * What a ministry might ask the internet for. Every one can be done from
 * anywhere — Terra is for help given online — and `{…}` slots are filled in
 * from the ministry: {city}, {country}, {lang}, {work} (what it does).
 */
const KINDS = [
  { title: "Website refresh", type: "expertise", focusOverride: "technology", skills: ["Web design", "WordPress or Squarespace"], commitment: ["20 hrs total · 6 weeks", "15 hrs total · 1 month"], detail: "Our website is years old and does not work on a phone, which is where every family and donor in {city} sees it. A few pages, our words, and a donate button that works." },
  { title: "Social media volunteer", type: "volunteers", focusOverride: "media", skills: ["Instagram", "Facebook", "Copywriting"], commitment: ["2 hrs/week · 3 months", "3 hrs/week · ongoing"], detail: "Turn the photos and stories our team sends from {city} into two or three posts a week, and keep the replies answered." },
  { title: "Grant application writer", type: "expertise", focusOverride: "fundraising", skills: ["Grant writing", "English"], commitment: ["15 hrs · one application", "20 hrs · two applications"], detail: "We have the budget and the reports from our work in {city}; we need someone who has written foundation applications before to make the case clearly." },
  { title: "Bookkeeping set-up", type: "expertise", focusOverride: "admin", skills: ["Bookkeeping", "Spreadsheets"], commitment: ["8 hrs total", "10 hrs total · 1 month"], detail: "A simple, honest set of books: a spreadsheet template, a monthly routine, and one video call to walk our treasurer through it." },
  { title: "Online English conversation partners", type: "volunteers", people: [2, 6], focusOverride: "education", skills: ["Native or fluent English", "Patience"], commitment: ["1 hr/week · 3 months", "1 hr/week · 6 months"], detail: "Weekly video conversations with young adults in {city} who are learning English for work. No teaching qualification needed, just time and kindness." },
  { title: "Video editor for our story", type: "expertise", focusOverride: "media", skills: ["Video editing", "Premiere or DaVinci"], commitment: ["12 hrs total", "10 hrs total · 3 weeks"], detail: "We have hours of phone footage of our work in {city} and want a three-minute film that tells it honestly, with {lang} and English subtitles." },
  { title: "Translation of training material into {lang}", type: "volunteers", people: [1, 3], focusOverride: "translation", skills: ["{lang}", "English"], commitment: ["4 hrs/week · 2 months", "20 hrs total"], detail: "Our volunteer handbook and safeguarding guide exist only in English. We need them in {lang} for the people who actually use them in {city}." },
  { title: "Remote IT support", type: "expertise", focusOverride: "technology", skills: ["IT support", "Google Workspace or Microsoft 365"], commitment: ["2 hrs/week · ongoing", "3 hrs/week · 3 months"], detail: "Someone our staff in {city} can message when the laptops, email or shared drive stop working, and who can set things up so they stop breaking." },
  { title: "Logo and visual identity", type: "expertise", focusOverride: "design", skills: ["Logo design", "Branding"], commitment: ["10 hrs total", "8 hrs total · 3 weeks"], detail: "We have outgrown a logo made in a word processor. A simple mark, two colours and a one-page guide we can hand to a print shop in {city}." },
  { title: "Online maths tutors", type: "volunteers", people: [2, 5], focusOverride: "education", skills: ["Secondary maths", "Tutoring"], commitment: ["1 hr/week · term", "2 hrs/week · 3 months"], detail: "Teenagers in our study programme in {city} are preparing for exams with no one at home who can help. One student, one hour a week, by video." },
  { title: "Telehealth doctor adviser", type: "expertise", focusOverride: "health", skills: ["Medicine", "Telehealth"], commitment: ["2 hrs/week · 3 months", "1 hr/week · 6 months"], detail: "A doctor our nurses in {city} can consult by video on the cases they are unsure of, so fewer families make the long trip to hospital for nothing." },
  { title: "Trauma-informed care training", type: "expertise", focusOverride: "trauma", skills: ["Counselling", "Training design"], commitment: ["6 sessions · 2 months", "10 hrs total"], detail: "Our volunteers in {city} hear hard stories every week. We want a short video course on listening well and looking after themselves." },
  { title: "HR policy review", type: "expertise", focusOverride: "legal", skills: ["HR", "Employment policy"], commitment: ["8 hrs total", "6 hrs total · 1 month"], detail: "We have grown to {staff} staff without a proper handbook. A review of what we have and a plain set of policies that fit {country}." },
  { title: "Legal advice on registration", type: "expertise", focusOverride: "legal", skills: ["Non-profit law", "{country} law helpful"], commitment: ["4 hrs total", "6 hrs total"], detail: "We are registering as a charity in {country} and want someone to check our constitution and governance before we file." },
  { title: "Donor newsletter writer", type: "volunteers", focusOverride: "fundraising", skills: ["Writing", "Mailchimp"], commitment: ["4 hrs/month · ongoing", "3 hrs/month · 6 months"], detail: "A short monthly email to our supporters: what happened in {city}, one story, one ask. We send notes and photos; you make them read well." },
  { title: "Strategic plan facilitator", type: "expertise", focusOverride: "leadership", skills: ["Strategy", "Facilitation"], commitment: ["4 sessions · 1 month", "12 hrs total"], detail: "Our board wants a three-year plan that the team in {city} actually believes in. Four video workshops and a written plan at the end." },
  { title: "Worship team mentor", type: "volunteers", focusOverride: "worship", skills: ["Music", "Worship leading"], commitment: ["1 hr/week · 3 months"], detail: "Our young worship team in {city} is keen and untrained. A weekly video call on arranging, rehearsing and leading well." },
  { title: "Laptops for a computer class", type: "supplies", people: 0, focusOverride: "technology", skills: ["Donated laptops", "Shipping help"], commitment: ["One-off"], detail: "Ten working laptops for a basic computer class in {city}. Refurbished is fine; we can arrange collection from a partner office." },
  { title: "Funding for a water tank", type: "funding", people: 0, focusOverride: "water", skills: ["Giving", "Fundraising"], commitment: ["One-off · by year end"], detail: "One 10,000-litre tank and the guttering to fill it, for a neighbourhood in {city} that buys water by the jerrycan." },
  { title: "School fees sponsorship", type: "funding", people: 0, focusOverride: "education", skills: ["Monthly giving"], commitment: ["Monthly · school year"], detail: "Monthly sponsors to keep twenty students in {city} in school this year. Every gift is reported back with a term report." },
  { title: "Partner church for prayer and support", type: "partners", people: 0, focusOverride: "discipleship", skills: ["A church or small group"], commitment: ["Ongoing"], detail: "A church elsewhere in the world to pray with our team in {city}, meet by video each quarter and walk with us for the long term." },
  { title: "Medical supplies drive", type: "supplies", people: 0, focusOverride: "health", skills: ["Medical supplies", "Logistics"], commitment: ["One-off · this season"], detail: "Dressings, gloves and basic diagnostics for our clinic in {city}. We have a list and a supplier; we need someone to organise the drive." },
  { title: "Photo editor", type: "volunteers", focusOverride: "media", skills: ["Photo editing", "Lightroom"], commitment: ["2 hrs/week · 2 months"], detail: "We take hundreds of photos of our work in {city} and use none of them. Help us choose, edit and caption a library we can use for a year." },
  { title: "Database clean-up", type: "volunteers", focusOverride: "admin", skills: ["Spreadsheets", "Attention to detail"], commitment: ["10 hrs total", "2 hrs/week · 1 month"], detail: "Our list of families and donors lives in four spreadsheets that disagree. Merge them into one we can trust." },
  { title: "Curriculum writer for {focusLabel}", type: "expertise", skills: ["Curriculum design", "Teaching"], commitment: ["15 hrs total", "3 hrs/week · 2 months"], detail: "We run {work}. We want a twelve-week programme our volunteers can lead without us, written simply enough to translate into {lang}." },
  { title: "Volunteer coordinator (remote)", type: "volunteers", focusOverride: "admin", skills: ["Scheduling", "WhatsApp", "Google Sheets"], commitment: ["3 hrs/week · 6 months", "2 hrs/week · ongoing"], detail: "Keep our volunteer rota in {city} running from home: scheduling, reminders and a monthly thank-you." },
  { title: "Small business mentors", type: "volunteers", people: [2, 4], focusOverride: "work", skills: ["Small business", "Mentoring"], commitment: ["1 hr/fortnight · 6 months"], detail: "Women in our savings groups in {city} are starting small businesses. Each needs one mentor, by video, every other week." },
  { title: "Fundraising campaign plan", type: "expertise", focusOverride: "fundraising", skills: ["Fundraising strategy", "Digital campaigns"], commitment: ["10 hrs total · 1 month"], detail: "We want to raise a year's running costs online. Help us plan the campaign: the story, the timeline, the asks and the follow-up." },
  { title: "Child safeguarding policy", type: "expertise", focusOverride: "legal", skills: ["Safeguarding", "Policy writing"], commitment: ["8 hrs total"], detail: "A safeguarding policy and short training for everyone who works with children in our programmes in {city}, fit for {country}." },
  { title: "Podcast producer", type: "volunteers", focusOverride: "media", skills: ["Audio editing", "Podcasting"], commitment: ["3 hrs/episode · 6 episodes"], detail: "Our pastors in {city} record short teaching episodes on their phones. Clean up the audio and publish them each fortnight." },
];

const FOCUS_LABEL = {
  children: "children's clubs", refugees: "newcomer families", health: "community health", education: "literacy", shelter: "safe housing",
  food: "food security", water: "clean water", trauma: "trauma care", translation: "Scripture engagement", discipleship: "discipleship",
  work: "livelihoods", prison: "prison aftercare",
};

const fill = (s, m) =>
  s
    .replaceAll("{city}", m.city)
    .replaceAll("{country}", m.country)
    .replaceAll("{lang}", m.languages[0])
    .replaceAll("{staff}", String(m.staff))
    .replaceAll("{work}", WORK[m.focus[0]])
    .replaceAll("{focusLabel}", FOCUS_LABEL[m.focus[0]]);

const TODAY = Date.UTC(2026, 9, 6);
const day = (n) => new Date(TODAY - n * 86_400_000).toISOString().slice(0, 10);

const target = TARGET_NEEDS - NEEDS.length;
// Big-city ministries carry more of the load; every ministry has at least one.
const weights = WORLD_MINISTRIES.map((m) => (m.tier === "major" ? 3 + rand() * 2 : 1 + rand()));
const total = weights.reduce((a, b) => a + b, 0);
const counts = weights.map((w) => Math.max(1, Math.floor((w / total) * target)));
let left = target - counts.reduce((a, b) => a + b, 0);
for (let i = 0; left > 0; i = (i + 1) % counts.length, left--) counts[i]++;
for (let i = 0; left < 0; i = (i + 1) % counts.length) if (counts[i] > 1) counts[i]--, left++;

export const WORLD_NEEDS = [];
WORLD_MINISTRIES.forEach((m, i) => {
  const kinds = shuffle(KINDS).slice(0, counts[i]);
  for (const k of kinds) {
    const people = k.people === 0 ? 0 : Array.isArray(k.people) ? between(k.people[0], k.people[1]) : 1;
    const roll = rand();
    WORLD_NEEDS.push({
      ministry: m.id,
      title: fill(k.title, m),
      type: k.type,
      urgency: roll < 0.24 ? "urgent" : roll < 0.74 ? "soon" : "ongoing",
      people,
      focus: k.focusOverride ?? pick(m.focus),
      remote: true,
      commitment: pick(k.commitment),
      skills: k.skills.map((s) => fill(s, m)),
      detail: fill(k.detail, m),
      posted: day(between(1, 150)),
    });
  }
});
