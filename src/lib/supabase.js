/**
 * The one Supabase client, and the guard that explains its absence.
 *
 * Terra runs without a backend: the globe, the filters and the board all work
 * against whatever data they are handed. So a missing configuration is not a
 * fatal error here — it degrades to a signed-out, read-only globe, and the
 * chrome asks for the two values rather than the page dying with a stack trace
 * in the console.
 */
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/** True when both values are present and look like what they claim to be. */
export const isConfigured = Boolean(
  url && anonKey && url.startsWith("https://") && !url.includes("YOUR-PROJECT"),
);

export const supabase = isConfigured
  ? createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // The magic-link and confirmation links come back as a URL fragment;
        // letting the client consume it is what turns that redirect into a
        // session without a page of our own to handle it.
        detectSessionInUrl: true,
      },
    })
  : null;

/** Throws with something actionable rather than "cannot read property of null". */
export function requireSupabase() {
  if (!supabase) {
    throw new Error(
      "Supabase is not configured. Copy .env.example to .env.local and fill in " +
        "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY from your project's API settings.",
    );
  }
  return supabase;
}
