/**
 * Books a first call about a need: a Google Calendar event with a Meet link,
 * invitations to the volunteer and the ministry, and a row in meetings.
 *
 * The caller must be signed in. The ministry is invited at its contact
 * address and at its owner's account address, so the invite reaches a person
 * whichever of the two the ministry actually reads.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { json, preflight } from "../_shared/http.ts";
import { createMeetEvent, googleConfigured } from "../_shared/google.ts";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const asCaller = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: auth } = await asCaller.auth.getUser();
  const user = auth?.user;
  if (!user?.email) return json({ error: "sign in to schedule a call" }, 401);

  if (!googleConfigured()) {
    return json({ error: "Video calls are not switched on yet. Please try again soon." }, 503);
  }

  const body = await req.json().catch(() => ({}));
  const needId = String(body.need_id ?? "");
  const start = new Date(String(body.starts_at ?? ""));
  const minutes = Math.min(Math.max(Number(body.duration_min) || 30, 15), 60);
  const note = String(body.note ?? "").trim().slice(0, 600);
  if (!needId || isNaN(start.getTime())) return json({ error: "pick a need and a time" }, 400);
  if (start.getTime() < Date.now() + 10 * 60_000) return json({ error: "pick a time at least ten minutes from now" }, 400);
  if (start.getTime() > Date.now() + 90 * 86_400_000) return json({ error: "pick a time within the next three months" }, 400);

  const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: need } = await service
    .from("needs")
    .select("id, title, status, ministry_id, ministries(id, name, contact, owner_id)")
    .eq("id", needId)
    .single();
  if (!need || need.status !== "live") return json({ error: "that need is not open" }, 404);
  const ministry = need.ministries as unknown as { id: string; name: string; contact: string | null; owner_id: string };

  const { data: owner } = await service.auth.admin.getUserById(ministry.owner_id);
  const { data: profile } = await service.from("profiles").select("full_name").eq("id", user.id).maybeSingle();
  const volunteer = profile?.full_name || user.email;

  const attendees = [...new Set([user.email, ministry.contact, owner?.user?.email].filter((e): e is string => !!e && EMAIL.test(e)))];

  let event;
  try {
    event = await createMeetEvent({
      summary: `Terra: ${need.title} (${ministry.name} × ${volunteer})`,
      description: [
        `A first call about "${need.title}" for ${ministry.name}, booked on Terra.`,
        `Volunteer: ${volunteer} <${user.email}>`,
        note ? `\nMessage from ${volunteer}:\n${note}` : "",
      ].join("\n"),
      start,
      minutes,
      attendees,
      requestId: crypto.randomUUID(),
    });
  } catch (e) {
    return json({ error: "We could not create the video call. Please try again.", detail: String(e) }, 502);
  }

  const { data: meeting, error } = await service
    .from("meetings")
    .insert({
      need_id: need.id,
      ministry_id: ministry.id,
      requester_id: user.id,
      starts_at: start.toISOString(),
      duration_min: minutes,
      note: note || null,
      meet_url: event.meetUrl,
      calendar_event_id: event.id,
    })
    .select()
    .single();
  if (error) return json({ error: error.message }, 500);

  return json({ meeting, meetUrl: event.meetUrl, calendarUrl: event.htmlLink, invited: attendees.length });
});
