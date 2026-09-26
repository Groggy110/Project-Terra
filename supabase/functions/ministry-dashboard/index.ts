/**
 * Everything a ministry needs to follow up on its posts: each need (in any
 * status), the people who put their hand up for it with their questionnaire
 * answers and email, and the calls booked about it.
 *
 * Server-side because volunteers' emails live in auth.users, which the browser
 * cannot read, and because a ministry should see only the people who chose to
 * respond to *its* needs — scoped here by ownership, not by trust.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { json, preflight } from "../_shared/http.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();

  const authHeader = req.headers.get("Authorization") ?? "";
  const asCaller = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: auth } = await asCaller.auth.getUser();
  if (!auth?.user) return json({ error: "sign in first" }, 401);

  const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: ministry } = await service.from("ministries").select("id, name").eq("owner_id", auth.user.id).maybeSingle();
  if (!ministry) return json({ ministry: null, needs: [] });

  const { data: needs } = await service
    .from("needs")
    .select("id, title, type, urgency, status, commitment, posted, people, moderation")
    .eq("ministry_id", ministry.id)
    .order("created_at", { ascending: false });
  const ids = (needs ?? []).map((n) => n.id);
  if (!ids.length) return json({ ministry, needs: [] });

  const [{ data: interests }, { data: meetings }] = await Promise.all([
    service.from("interests").select("user_id, need_id, created_at").in("need_id", ids),
    service.from("meetings").select("id, need_id, requester_id, starts_at, duration_min, meet_url, note, status").in("need_id", ids).eq("status", "scheduled"),
  ]);

  const people = [...new Set([...(interests ?? []).map((i) => i.user_id), ...(meetings ?? []).map((m) => m.requester_id)])];
  const [{ data: profiles }, { data: answers }] = await Promise.all([
    people.length ? service.from("profiles").select("id, full_name").in("id", people) : { data: [] },
    people.length ? service.from("volunteer_profiles").select("user_id, skills, availability, experience, languages, portfolio").in("user_id", people) : { data: [] },
  ]);
  const emails = new Map<string, string>();
  await Promise.all(people.map(async (id) => {
    const { data } = await service.auth.admin.getUserById(id);
    if (data?.user?.email) emails.set(id, data.user.email);
  }));
  const person = (id: string) => {
    const p = (profiles ?? []).find((x) => x.id === id);
    const a = (answers ?? []).find((x) => x.user_id === id);
    return {
      id,
      name: p?.full_name || emails.get(id)?.split("@")[0] || "A volunteer",
      email: emails.get(id) ?? null,
      skills: a?.skills ?? [],
      availability: a?.availability ?? null,
      experience: a?.experience ?? null,
      languages: a?.languages ?? [],
      portfolio: a?.portfolio ?? null,
    };
  };

  return json({
    ministry,
    needs: (needs ?? []).map((n) => ({
      ...n,
      reason: n.status === "pending_review" ? (n.moderation as { verdict?: { reason?: string } })?.verdict?.reason ?? null : null,
      moderation: undefined,
      applicants: (interests ?? []).filter((i) => i.need_id === n.id).map((i) => ({ ...person(i.user_id), at: i.created_at })),
      calls: (meetings ?? []).filter((m) => m.need_id === n.id).map((m) => ({
        id: m.id, startsAt: m.starts_at, minutes: m.duration_min, meetUrl: m.meet_url, note: m.note, person: person(m.requester_id),
      })),
    })),
  });
});
