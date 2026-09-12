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
export async function loadNetwork() {
  if (!supabase) return { ministries: [], needs: [] };
  const [mRes, nRes] = await Promise.all([
    supabase.from("ministries").select("*").order("name"),
    supabase.from("needs").select("*").eq("status", "live").order("posted", { ascending: false }),
  ]);
  if (mRes.error) throw mRes.error;
  if (nRes.error) throw nRes.error;
  return {
    ministries: (mRes.data ?? []).map(shapeMinistry),
    needs: (nRes.data ?? []).map(shapeNeed),
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

export async function toggleInterest(needId, on) {
  const sb = requireSupabase();
  const { data: auth } = await sb.auth.getUser();
  if (!auth?.user) throw new Error("sign in to pick up a need");
  if (on) {
    const { error } = await sb.from("interests").insert({ user_id: auth.user.id, need_id: needId });
    if (error && error.code !== "23505") throw error; // 23505 = already there
  } else {
    const { error } = await sb.from("interests").delete().eq("user_id", auth.user.id).eq("need_id", needId);
    if (error) throw error;
  }
}
