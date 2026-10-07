/**
 * Everything the browser asks the backend for.
 *
 * One rule holds the shape of this file: the UI above it never learns that
 * Supabase exists. Rows come back already translated into the shapes the globe,
 * the panel and the board have always used — a need carries `ministry`, not
 * `ministry_id`, because that is what Network has always read. Renaming the UI
 * to match the database would have been the larger change, and the wrong one.
 */
import { supabase, isConfigured, requireSupabase } from "./supabase.js";

export { isConfigured };

/* --------------------------------------------------------------- shaping */

const shapeMinistry = (row) => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  city: row.city,
  country: row.country,
  lat: row.lat,
  lon: row.lon,
  region: row.region ?? "",
  focus: row.focus ?? [],
  since: row.since ?? null,
  staff: row.staff ?? null,
  languages: row.languages ?? [],
  contact: row.contact ?? "",
  blurb: row.blurb ?? "",
  logo: row.logo_url ?? null,
  ownerId: row.owner_id,
});

const shapeNeed = (row) => ({
  id: row.id,
  ministry: row.ministry_id,
  title: row.title,
  type: row.type,
  urgency: row.urgency,
  people: row.people ?? 0,
  focus: row.focus ?? "",
  remote: !!row.remote,
  commitment: row.commitment ?? "",
  skills: row.skills ?? [],
  // AI-written search tags, most specific first (moderate-need / tag-needs).
  tags: row.tags ?? [],
  detail: row.detail ?? "",
  posted: row.posted ?? row.created_at?.slice(0, 10) ?? "",
  status: row.status,
  moderation: row.moderation ?? null,
});

/* ------------------------------------------------------------------ data */

/**
 * The whole public network in two queries.
 *
 * Two rather than one join: a ministry with no live needs still has to appear
 * on the globe — it is a pin with nothing open, not an absence — and an inner
 * join would silently drop it.
 */
/**
 * Every row of a query, a page at a time: the API returns at most 1,000 rows
 * to a request, and the network is past that. `build` makes a fresh query
 * each time, since a builder can only be ranged once.
 */
async function allRows(build, page = 1000) {
  const rows = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await build().range(from, from + page - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < page) return rows;
  }
}

export async function loadNetwork() {
  if (!supabase) return { ministries: [], needs: [] };
  // Ordered on a unique column as well, so the pages never overlap or skip.
  const [ministries, needs] = await Promise.all([
    allRows(() => supabase.from("ministries").select("*").order("name").order("id")),
    allRows(() => supabase.from("needs").select("*").eq("status", "live").order("posted", { ascending: false }).order("id")),
  ]);
  return {
    ministries: ministries.map(shapeMinistry),
    needs: needs.map(shapeNeed),
  };
}

/** A ministry's own needs, including the ones still under review. */
export async function loadMyNeeds(ministryId) {
  const sb = requireSupabase();
  const { data, error } = await sb
    .from("needs")
    .select("*")
    .eq("ministry_id", ministryId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map(shapeNeed);
}

/* ------------------------------------------------------------------ auth */

export async function currentSession() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data?.session ?? null;
}

export function onAuthChange(fn) {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_event, session) => fn(session));
  return () => data?.subscription?.unsubscribe();
}

export async function signUp({ email, password, fullName, role }) {
  const sb = requireSupabase();
  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName, role } },
  });
  if (error) throw error;
  // No session means the project requires a confirmation click. The caller
  // shows "check your email" rather than pretending the person is signed in.
  return { user: data.user, session: data.session, needsConfirmation: !data.session };
}

export async function signIn({ email, password }) {
  const sb = requireSupabase();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session;
}

export async function sendMagicLink({ email, fullName, role }) {
  const sb = requireSupabase();
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: window.location.origin,
      data: fullName || role ? { full_name: fullName, role } : undefined,
    },
  });
  if (error) throw error;
}

export async function signOut() {
  forgetAccounts();
  if (supabase) await supabase.auth.signOut();
}

export async function myProfile() {
  if (!supabase) return null;
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return null;
  const { data } = await supabase.from("profiles").select("*").eq("id", auth.user.id).maybeSingle();
  return data ? { ...data, email: auth.user.email } : null;
}

export async function setRole(role) {
  const sb = requireSupabase();
  const { data: auth } = await sb.auth.getUser();
  if (!auth?.user) throw new Error("not signed in");
  const { error } = await sb.from("profiles").update({ role }).eq("id", auth.user.id);
  if (error) throw error;
}

/* ---------------------------------------------------------------- avatar */

const AVATAR_BUCKET = "avatars";

/**
 * The picture on the account chip: the ministry's logo for a ministry
 * account, the person's photo otherwise. Each upload gets a fresh name, so
 * the public URL changes and no cache shows the old one; the previous file
 * is removed after the row points at the new one.
 */
export async function setAvatar(file, { ministryId = null } = {}) {
  const sb = requireSupabase();
  const { data: auth } = await sb.auth.getUser();
  if (!auth?.user) throw new Error("sign in first");
  if (!/^image\//.test(file.type)) throw new Error("Choose an image — PNG, JPG, WebP, GIF or SVG.");
  if (file.size > 2 * 1024 * 1024) throw new Error("Use an image under 2 MB.");

  const ext = (file.name.match(/\.(\w+)$/)?.[1] ?? "png").toLowerCase();
  const path = `${auth.user.id}/${ministryId ? "logo" : "photo"}-${Date.now().toString(36)}.${ext}`;
  const { error: upErr } = await sb.storage.from(AVATAR_BUCKET).upload(path, file, { contentType: file.type });
  if (upErr) throw upErr;
  const url = sb.storage.from(AVATAR_BUCKET).getPublicUrl(path).data.publicUrl;
  return writeAvatar(sb, auth.user.id, ministryId, url);
}

export async function removeAvatar({ ministryId = null } = {}) {
  const sb = requireSupabase();
  const { data: auth } = await sb.auth.getUser();
  if (!auth?.user) throw new Error("sign in first");
  return writeAvatar(sb, auth.user.id, ministryId, null);
}

async function writeAvatar(sb, userId, ministryId, url) {
  const table = ministryId ? "ministries" : "profiles";
  const column = ministryId ? "logo_url" : "avatar_url";
  const id = ministryId ?? userId;
  const { data: before } = await sb.from(table).select(column).eq("id", id).maybeSingle();
  const { error } = await sb.from(table).update({ [column]: url }).eq("id", id);
  if (error) throw error;
  const old = before?.[column]?.split(`/${AVATAR_BUCKET}/`)[1];
  if (old) await sb.storage.from(AVATAR_BUCKET).remove([decodeURIComponent(old)]);
  return url;
}

/* -------------------------------------------------------------- ministry */

export async function myMinistry() {
  if (!supabase) return null;
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return null;
  const { data } = await supabase
    .from("ministries")
    .select("*")
    .eq("owner_id", auth.user.id)
    .maybeSingle();
  return data ? shapeMinistry(data) : null;
}

export async function createMinistry(fields) {
  const sb = requireSupabase();
  const { data: auth } = await sb.auth.getUser();
  if (!auth?.user) throw new Error("not signed in");
  const slug =
    `${fields.name} ${fields.city}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) + `-${Math.random().toString(36).slice(2, 6)}`;
  const { data, error } = await sb
    .from("ministries")
    .insert({ ...fields, slug, owner_id: auth.user.id })
    .select()
    .single();
  if (error) throw error;
  return shapeMinistry(data);
}

/* ----------------------------------------------------------------- needs */

/**
 * Posting goes through the edge function, never straight to the table.
 *
 * This is not a stylistic preference: `needs` has no insert policy for any
 * browser role, so a direct insert fails with 42501. The function is where the
 * plausibility check lives, and routing through it is the only way in.
 */
export async function postNeed(fields) {
  const sb = requireSupabase();
  const { data, error } = await sb.functions.invoke("moderate-need", { body: fields });
  if (error) {
    // A non-2xx from an edge function arrives as FunctionsHttpError with the
    // body unread; the message inside it is the useful part.
    const detail = await error.context?.json?.().catch(() => null);
    throw new Error(detail?.error ?? error.message);
  }
  return { need: shapeNeed(data.need), status: data.status, message: data.message, reason: data.reason };
}

/**
 * Saves changes to one of the ministry's own needs. Through the same edge
 * function as a new post, for the same reason: the new text is checked
 * before it goes back on the globe, and the table refuses content edits from
 * the browser (guard_need_content).
 */
export async function updateNeed(needId, fields) {
  return postNeed({ ...fields, need_id: needId });
}

/* --------------------------------------------------------- questionnaire */

export async function loadQuestionnaire() {
  if (!supabase) return null;
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return null;
  const { data } = await supabase
    .from("volunteer_profiles")
    .select("*")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  return data ?? null;
}

export async function saveQuestionnaire(answers) {
  const sb = requireSupabase();
  const { data: auth } = await sb.auth.getUser();
  if (!auth?.user) throw new Error("not signed in");
  const { error } = await sb
    .from("volunteer_profiles")
    .upsert({ ...answers, user_id: auth.user.id, updated_at: new Date().toISOString() });
  if (error) throw error;
}

/* ----------------------------------------------------------- suggestions */

/**
 * Ranked suggestions, cached for the session.
 *
 * Every call is a model call and a model call costs money, so the result is
 * held against the questionnaire's own updated_at: re-opening the panel is
 * free, and changing an answer is what earns a fresh ranking.
 */
const recCache = new Map();

export async function recommendations({ force = false } = {}) {
  const sb = requireSupabase();
  const profile = await loadQuestionnaire();
  if (!profile) return { matches: [], message: "Answer the five questions and we can suggest needs that fit." };

  const key = profile.updated_at ?? "none";
  if (!force && recCache.has(key)) return recCache.get(key);

  const { data, error } = await sb.functions.invoke("recommend-needs", { body: {} });
  if (error) {
    const detail = await error.context?.json?.().catch(() => null);
    throw new Error(detail?.error ?? error.message);
  }
  const out = {
    matches: (data.matches ?? []).map((m) => ({ ...m, need: shapeNeed(m.need) })),
    message: data.message ?? null,
    considered: data.considered ?? 0,
  };
  recCache.set(key, out);
  return out;
}

export function clearRecommendationCache() {
  recCache.clear();
}

/* ------------------------------------------------------------- interests */

export async function myInterests() {
  if (!supabase) return new Set();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return new Set();
  const { data } = await supabase.from("interests").select("need_id").eq("user_id", auth.user.id);
  return new Set((data ?? []).map((r) => r.need_id));
}

const WORK_BUCKET = "work-samples";

/**
 * Picks up a need with an application: why, qualifications, links and files.
 * Files go to the private work-samples bucket under the volunteer's own id
 * first, so the row never points at an upload that failed.
 */
export async function expressInterest(needId, { why = "", qualifications = "", links = [], files = [] } = {}) {
  const sb = requireSupabase();
  const { data: auth } = await sb.auth.getUser();
  if (!auth?.user) throw new Error("sign in to pick up a need");

  const uploaded = [];
  for (const file of files) {
    const safe = file.name.replace(/[^\w.-]+/g, "_").slice(-80);
    const path = `${auth.user.id}/${needId}/${Date.now().toString(36)}-${safe}`;
    const { error } = await sb.storage.from(WORK_BUCKET).upload(path, file, { contentType: file.type || undefined });
    if (error) {
      if (uploaded.length) await sb.storage.from(WORK_BUCKET).remove(uploaded.map((f) => f.path));
      throw new Error(`Could not upload ${file.name}: ${error.message}`);
    }
    uploaded.push({ name: file.name, path, size: file.size, type: file.type });
  }

  const { error } = await sb.from("interests").upsert({
    user_id: auth.user.id,
    need_id: needId,
    why,
    qualifications,
    links,
    files: uploaded,
  });
  if (error) throw error;
}

/** Withdraws from a need, taking any uploaded work with it. */
export async function withdrawInterest(needId) {
  const sb = requireSupabase();
  const { data: auth } = await sb.auth.getUser();
  if (!auth?.user) throw new Error("sign in first");
  const { data: row } = await sb
    .from("interests")
    .select("files")
    .eq("user_id", auth.user.id)
    .eq("need_id", needId)
    .maybeSingle();
  const paths = (row?.files ?? []).map((f) => f.path).filter(Boolean);
  if (paths.length) await sb.storage.from(WORK_BUCKET).remove(paths);
  const { error } = await sb.from("interests").delete().eq("user_id", auth.user.id).eq("need_id", needId);
  if (error) throw error;
}

/* -------------------------------------------------------------- meetings */

/**
 * Books a first call about a need. The server creates the Google Calendar
 * event with its Meet link and emails both sides the invitation.
 */
export async function scheduleMeeting({ needId, startsAt, durationMin, note }) {
  const sb = requireSupabase();
  const { data, error } = await sb.functions.invoke("schedule-meeting", {
    body: { need_id: needId, starts_at: startsAt, duration_min: durationMin, note },
  });
  if (error) {
    const detail = await error.context?.json?.().catch(() => null);
    throw new Error(detail?.error ?? error.message);
  }
  return data;
}

/** Upcoming calls the signed-in person is part of, soonest first. */
export async function myMeetings() {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("meetings")
    .select("id, starts_at, duration_min, meet_url, status, need_id, needs(title), ministries(name)")
    .eq("status", "scheduled")
    .gte("starts_at", new Date(Date.now() - 60 * 60_000).toISOString())
    .order("starts_at");
  if (error) throw error;
  return (data ?? []).map((m) => ({
    id: m.id,
    startsAt: m.starts_at,
    minutes: m.duration_min,
    meetUrl: m.meet_url,
    needId: m.need_id,
    needTitle: m.needs?.title ?? "A need",
    ministryName: m.ministries?.name ?? "",
  }));
}

/* -------------------------------------------------------- linked accounts */

/**
 * A ministry leader can also serve personally, from a second account, and
 * switch between the two in one click. The link itself lives in
 * account_links; what makes the switch instant is that each account's
 * sign-in is remembered here, in this browser, so switching is setSession
 * rather than a password. On another device the link still shows, and a
 * single sign-in there makes it instant again.
 */
const ACCOUNTS_KEY = "terra.accounts";
const PENDING_KEY = "terra.pendingLink";

const readJson = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};
const writeJson = (key, value) => {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: switching simply asks for a sign-in */
  }
};

/** Keeps the current account's sign-in, so it can be switched back to. */
export function rememberAccount(session, profile) {
  if (!session?.user) return;
  const all = readJson(ACCOUNTS_KEY, {});
  all[session.user.id] = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    email: session.user.email,
    name: profile?.full_name ?? all[session.user.id]?.name ?? "",
    role: profile?.role ?? all[session.user.id]?.role ?? "volunteer",
  };
  writeJson(ACCOUNTS_KEY, all);
}

export function forgetAccounts() {
  writeJson(ACCOUNTS_KEY, null);
  writeJson(PENDING_KEY, null);
}

/** The accounts linked to the signed-in one, with what this browser knows. */
export async function linkedAccounts() {
  if (!supabase) return [];
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return [];
  const { data } = await supabase.from("account_links").select("linked_id").eq("user_id", auth.user.id);
  const known = readJson(ACCOUNTS_KEY, {});
  return (data ?? []).map((r) => ({ id: r.linked_id, ...(known[r.linked_id] ?? {}), ready: !!known[r.linked_id]?.refresh_token }));
}

/** Switches to a linked account; throws { needsSignIn } if this browser cannot. */
export async function switchAccount(id) {
  const sb = requireSupabase();
  const acc = readJson(ACCOUNTS_KEY, {})[id];
  if (!acc?.refresh_token) throw Object.assign(new Error("sign in to that account once on this device"), { needsSignIn: true, email: acc?.email });
  const { error } = await sb.auth.setSession({ access_token: acc.access_token, refresh_token: acc.refresh_token });
  if (error) {
    const all = readJson(ACCOUNTS_KEY, {});
    delete all[id];
    writeJson(ACCOUNTS_KEY, all);
    throw Object.assign(new Error("that sign-in has expired; sign in again"), { needsSignIn: true, email: acc.email });
  }
}

/** Marks that the next account to sign in should be linked to this one. */
export function beginLink(fromUserId, role) {
  writeJson(PENDING_KEY, { from: fromUserId, role, at: Date.now() });
}

export function pendingLink() {
  const p = readJson(PENDING_KEY, null);
  // A day is plenty to click a confirmation email; after that it is stale.
  return p && Date.now() - p.at < 86_400_000 ? p : null;
}

export function cancelLink() {
  writeJson(PENDING_KEY, null);
}

/**
 * Links the signed-in account with the remembered one it was started from.
 * The other account's sign-in is refreshed directly against the auth API (its
 * access token has usually expired by the time an email is confirmed), and the
 * rotated refresh token is kept.
 */
export async function completeLink() {
  const sb = requireSupabase();
  const pending = pendingLink();
  if (!pending) return false;
  const { data: auth } = await sb.auth.getSession();
  const me = auth?.session;
  if (!me || me.user.id === pending.from) return false;
  const all = readJson(ACCOUNTS_KEY, {});
  const other = all[pending.from];
  if (!other?.refresh_token) throw new Error("sign in to your other account again to link them");

  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: other.refresh_token }),
  });
  const fresh = await res.json();
  if (!res.ok || !fresh.access_token) throw new Error("your other account's sign-in has expired; sign in to it again");
  all[pending.from] = { ...other, access_token: fresh.access_token, refresh_token: fresh.refresh_token };
  writeJson(ACCOUNTS_KEY, all);

  const { error } = await sb.functions.invoke("link-account", { body: { other_token: fresh.access_token } });
  if (error) {
    const detail = await error.context?.json?.().catch(() => null);
    throw new Error(detail?.error ?? error.message);
  }
  writeJson(PENDING_KEY, null);
  return true;
}

/* -------------------------------------------------------------- dashboard */

/** The signed-in ministry's needs, applicants and booked calls. */
export async function ministryDashboard() {
  const sb = requireSupabase();
  const { data, error } = await sb.functions.invoke("ministry-dashboard", { body: {} });
  if (error) {
    const detail = await error.context?.json?.().catch(() => null);
    throw new Error(detail?.error ?? error.message);
  }
  return data;
}

/** How many applications to the ministry's needs it has not opened yet. */
export async function unseenApplications() {
  const sb = requireSupabase();
  const { data, error } = await sb.rpc("unseen_applications");
  if (error) throw error;
  return data ?? 0;
}

/** Marks one application opened; does nothing unless the need is ours. */
export async function markApplicationSeen(needId, userId) {
  const sb = requireSupabase();
  const { error } = await sb.rpc("mark_application_seen", { p_need: needId, p_user: userId });
  if (error) throw error;
}

/** Marks one of the ministry's own needs filled, or reopens it. */
export async function setNeedStatus(needId, status) {
  const sb = requireSupabase();
  const { error } = await sb.from("needs").update({ status }).eq("id", needId);
  if (error) throw error;
}

/**
 * Ask Terra (supabase/functions/ask-terra): a question in plain words, the
 * conversation so far, and the needs the page is showing, as short records.
 * Returns `{ reply, picks: [{ id, why }] }`; throws when the guide cannot be
 * reached, and the caller falls back to the keyword search.
 */
export async function askTerra({ question, history = [], needs = [] }) {
  const sb = requireSupabase();
  const records = needs.map((n) => ({
    id: n.id,
    title: n.title,
    type: n.type,
    urgency: n.urgency,
    people: n.people,
    focus: n.focus,
    remote: n.remote,
    commitment: n.commitment,
    skills: n.skills,
    tags: n.tags,
    detail: n.detail,
    ministry: n.ministryName,
    city: n.city,
    country: n.country,
    region: n.region,
  }));
  const { data, error } = await sb.functions.invoke("ask-terra", { body: { question, history, needs: records } });
  if (error) {
    const detail = await error.context?.json?.().catch(() => null);
    throw new Error(detail?.error ?? error.message);
  }
  if (!data || typeof data.reply !== "string") throw new Error("no answer");
  return { reply: data.reply, picks: Array.isArray(data.picks) ? data.picks : [] };
}

/**
 * Serve locally (supabase/functions/serve-local): the visitor's circle — its
 * centre, rounded to about a kilometre, and radius — with the Terra needs
 * inside it and the churches and ministries the page found there
 * (lib/places.js). The function reads their websites and chooses, against
 * the visitor's questionnaire when they are signed in. Returns
 * `{ reply, items, places, profile }`, items being `{ kind: "need", id, why }`
 * or `{ kind: "web", org, title, summary, why, email, phone, page, … }`;
 * throws when the guide cannot be reached.
 */
export async function serveLocal({ miles, lat, lon, area = "", needs = [], orgs = [], places = [] }) {
  const sb = requireSupabase();
  const records = needs.map(({ need: n, miles: d }) => ({
    id: n.id,
    title: n.title,
    miles: Math.round(d * 10) / 10,
    type: n.type,
    urgency: n.urgency,
    people: n.people,
    focus: n.focus,
    remote: n.remote,
    commitment: n.commitment,
    skills: n.skills,
    tags: n.tags,
    detail: n.detail,
    ministry: n.ministryName,
    city: n.city,
    country: n.country,
  }));
  const round = (v) => Math.round(v * 100) / 100;
  const { data, error } = await sb.functions.invoke("serve-local", {
    body: { miles, lat: round(lat), lon: round(lon), area, needs: records, orgs, places },
  });
  if (error) {
    const detail = await error.context?.json?.().catch(() => null);
    throw new Error(detail?.error ?? error.message);
  }
  if (!data || typeof data.reply !== "string") throw new Error("no answer");
  return {
    reply: data.reply,
    items: Array.isArray(data.items) ? data.items : [],
    places: Array.isArray(data.places) ? data.places : [],
    profile: !!data.profile,
  };
}
