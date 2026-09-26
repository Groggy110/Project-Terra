/**
 * Google Calendar, for creating first calls with a Meet link.
 *
 * One Google account owns every meeting Terra creates (the organiser), and
 * invites both the volunteer and the ministry. It is authorised once with
 * tools/google_auth.mjs, which stores a refresh token; each call trades that
 * for a short-lived access token. Three secrets:
 *
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 *   (GOOGLE_CALENDAR_ID optional, "primary" by default)
 */

export const googleConfigured = () =>
  !!(Deno.env.get("GOOGLE_CLIENT_ID") && Deno.env.get("GOOGLE_CLIENT_SECRET") && Deno.env.get("GOOGLE_REFRESH_TOKEN"));

async function accessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: Deno.env.get("GOOGLE_REFRESH_TOKEN")!,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) throw new Error(`google token: ${body.error ?? res.status}`);
  return body.access_token;
}

export interface MeetEvent {
  id: string;
  meetUrl: string | null;
  htmlLink: string;
}

/** Creates the event, asks Google for a Meet room, and emails the invites. */
export async function createMeetEvent(opts: {
  summary: string;
  description: string;
  start: Date;
  minutes: number;
  attendees: string[];
  requestId: string;
}): Promise<MeetEvent> {
  const token = await accessToken();
  const calendar = encodeURIComponent(Deno.env.get("GOOGLE_CALENDAR_ID") || "primary");
  const end = new Date(opts.start.getTime() + opts.minutes * 60_000);
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendar}/events?conferenceDataVersion=1&sendUpdates=all`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: opts.summary,
        description: opts.description,
        start: { dateTime: opts.start.toISOString() },
        end: { dateTime: end.toISOString() },
        attendees: opts.attendees.map((email) => ({ email })),
        guestsCanModify: false,
        reminders: { useDefault: true },
        conferenceData: {
          createRequest: { requestId: opts.requestId, conferenceSolutionKey: { type: "hangoutsMeet" } },
        },
      }),
    },
  );
  const ev = await res.json();
  if (!res.ok) throw new Error(`google calendar: ${ev?.error?.message ?? res.status}`);
  const meet = ev.hangoutLink ??
    ev.conferenceData?.entryPoints?.find((e: { entryPointType: string }) => e.entryPointType === "video")?.uri ??
    null;
  return { id: ev.id, meetUrl: meet, htmlLink: ev.htmlLink };
}
