/**
 * Links two Terra accounts that belong to the same person — typically a
 * ministry account and a personal serving account — so either can switch to
 * the other in one click.
 *
 * Proof of both is required: the caller's own session (Authorization) and an
 * access token for the other account (other_token). Without the second, anyone
 * could attach themselves to any account.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { json, preflight } from "../_shared/http.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const service = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const mine = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const body = await req.json().catch(() => ({}));
  const theirs = String(body.other_token ?? "");
  if (!mine || !theirs) return json({ error: "both sign-ins are needed to link accounts" }, 400);

  const [{ data: a }, { data: b }] = await Promise.all([service.auth.getUser(mine), service.auth.getUser(theirs)]);
  if (!a?.user || !b?.user) return json({ error: "one of the sign-ins has expired; sign in again" }, 401);
  if (a.user.id === b.user.id) return json({ error: "that is the same account" }, 400);

  const { error } = await service.from("account_links").upsert([
    { user_id: a.user.id, linked_id: b.user.id },
    { user_id: b.user.id, linked_id: a.user.id },
  ], { onConflict: "user_id,linked_id", ignoreDuplicates: true });
  if (error) return json({ error: error.message }, 500);

  return json({ linked: true });
});
