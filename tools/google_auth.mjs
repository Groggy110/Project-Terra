/**
 * Connects Terra to the Google account that will own its video calls.
 *
 *   node tools/google_auth.mjs <client-id> <client-secret>
 *
 * Opens Google's consent screen in your browser, waits for you to allow
 * access to Google Calendar, trades the answer for a refresh token, and stores
 * all three values as Supabase function secrets (GOOGLE_CLIENT_ID,
 * GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN). Nothing is printed.
 *
 * The client must be an OAuth client of type "Desktop app" in Google Cloud
 * (APIs & Services → Credentials), in a project with the Google Calendar API
 * enabled. Desktop clients accept any loopback redirect, which is what this
 * listens on.
 */
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error("usage: node tools/google_auth.mjs <client-id> <client-secret>");
  process.exit(1);
}

const PORT = 8765;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const consent =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/calendar.events",
    access_type: "offline",
    prompt: "consent",
  });

const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, REDIRECT);
    if (url.pathname !== "/callback") return res.end();
    const got = url.searchParams.get("code");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      got
        ? "<h2 style='font-family:system-ui'>Terra is connected to Google. You can close this tab.</h2>"
        : `<h2 style='font-family:system-ui'>Google said: ${url.searchParams.get("error") ?? "no code"}</h2>`,
    );
    server.close();
    got ? resolve(got) : reject(new Error(url.searchParams.get("error") ?? "no code"));
  });
  server.listen(PORT, "127.0.0.1", () => {
    console.log("Opening Google in your browser. Choose the account that should own Terra's calls.");
    spawn("open", [consent], { stdio: "ignore", detached: true });
  });
});

const res = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT,
    grant_type: "authorization_code",
  }),
});
const token = await res.json();
if (!token.refresh_token) {
  console.error("Google did not return a refresh token:", token.error_description ?? token.error ?? "unknown");
  process.exit(1);
}

execFileSync(
  "npx",
  [
    "supabase@latest",
    "secrets",
    "set",
    `GOOGLE_CLIENT_ID=${clientId}`,
    `GOOGLE_CLIENT_SECRET=${clientSecret}`,
    `GOOGLE_REFRESH_TOKEN=${token.refresh_token}`,
  ],
  { stdio: ["ignore", "ignore", "inherit"] },
);
console.log("Done. Terra can now create Google Meet calls.");
