#!/usr/bin/env node
/**
 * Terra's auth emails: one layout, six messages.
 *
 *   node tools/email-templates.mjs           writes supabase/templates/*.html
 *   SUPABASE_ACCESS_TOKEN=sbp_… node tools/email-templates.mjs --push
 *                                            …and sets them, with their subject
 *                                            lines, on the hosted project
 *
 * The token is a personal access token from
 * https://supabase.com/dashboard/account/tokens. It is read from the
 * environment only and never written anywhere.
 *
 * Email clients are a decade behind browsers, so the markup is tables and
 * inline styles throughout, the logo is a hosted PNG (no SVG, no data URIs),
 * and nothing depends on a web font. The header is the night sky the app is
 * drawn on, because the logo is a glow meant for a dark ground.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_REF = "krtsbubnqgahkofbewry";
const SITE = "https://eclectic-semifreddo-6dc804.netlify.app";
const LOGO = `${SITE}/brand/terra-logo-480.png`;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "supabase", "templates");

const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Inter,Helvetica,Arial,sans-serif";
const INK = "#0e1726";
const BODY = "#47566b";
const MUTED = "#8494a9";
const ACCENT = "#2f6fd0";

function layout({ title, preheader, heading, paragraphs, button, code, note }) {
  const p = (text, last = false) =>
    `<tr><td style="font-size:16px;line-height:1.65;color:${BODY};padding:0 0 ${last ? 26 : 14}px;">${text}</td></tr>`;
  const action = button
    ? `<tr><td style="padding:0 0 26px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="${ACCENT}" style="border-radius:999px;background:${ACCENT};">
<a href="{{ .ConfirmationURL }}" style="display:inline-block;padding:15px 30px;font-family:${FONT};font-size:15.5px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;border-radius:999px;">${button}</a>
</td></tr></table>
</td></tr>`
    : "";
  const codeBlock = code
    ? `<tr><td style="padding:0 0 26px;">
<div style="display:inline-block;padding:16px 26px;border-radius:14px;background:#f1f5fa;border:1px solid #e1e8f1;font-family:'SF Mono',SFMono-Regular,Menlo,Consolas,monospace;font-size:30px;font-weight:600;letter-spacing:0.28em;color:${INK};">{{ .Token }}</div>
</td></tr>`
    : "";
  const fallback = button
    ? `<tr><td style="border-top:1px solid #edf1f6;padding:20px 0 0;font-size:13px;line-height:1.6;color:${MUTED};">Button not working? Copy this link into your browser:<br><a href="{{ .ConfirmationURL }}" style="color:${ACCENT};word-break:break-all;text-decoration:none;">{{ .ConfirmationURL }}</a></td></tr>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#eef2f7;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#eef2f7" style="background:#eef2f7;">
<tr><td align="center" style="padding:32px 14px 40px;font-family:${FONT};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">

<tr><td align="center" bgcolor="#020814" style="background:#020814;background-image:linear-gradient(180deg,#001a38 0%,#020814 100%);border-radius:22px 22px 0 0;padding:34px 24px 28px;">
<a href="${SITE}" style="text-decoration:none;"><img src="${LOGO}" width="184" height="95" alt="Terra" style="display:block;width:184px;height:auto;border:0;outline:none;color:#ffffff;font-size:22px;letter-spacing:0.3em;"></a>
</td></tr>

<tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:0 0 22px 22px;padding:38px 38px 30px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td style="font-size:26px;line-height:1.25;font-weight:700;letter-spacing:-0.02em;color:${INK};padding:0 0 16px;">${heading}</td></tr>
${paragraphs.map((t, i) => p(t, i === paragraphs.length - 1)).join("\n")}
${action}
${codeBlock}
${fallback}
</table>
</td></tr>

<tr><td align="center" style="padding:24px 18px 0;font-size:12.5px;line-height:1.7;color:${MUTED};">
${note}<br>
<span style="color:#a3b0c2;">Terra · Serve ministries from anywhere</span><br>
<a href="${SITE}" style="color:#a3b0c2;text-decoration:underline;">${SITE.replace("https://", "")}</a>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>
`;
}

const ONE_HOUR = "The link works once and expires in one hour.";

const EMAILS = {
  confirmation: {
    subject: "Welcome to Terra — confirm your email",
    title: "Welcome to Terra",
    preheader: "Confirm your email to finish creating your Terra account.",
    heading: "Welcome to Terra",
    paragraphs: [
      "Thanks for signing up. Terra is where ministries around the world share what they need help with, and people like you offer their skills to meet it.",
      `Confirm your email address to finish creating your account. ${ONE_HOUR}`,
    ],
    button: "Confirm my email",
    note: "You're receiving this because this address was used to sign up for Terra. If that wasn't you, you can ignore this email.",
  },
  magic_link: {
    subject: "Your Terra sign-in link",
    title: "Sign in to Terra",
    preheader: "Tap to sign in to Terra. The link works once and expires in one hour.",
    heading: "Sign in to Terra",
    paragraphs: ["Welcome back. Tap the button below to sign in to your Terra account.", ONE_HOUR],
    button: "Sign in to Terra",
    note: "If you didn't ask to sign in, you can ignore this email — no one can sign in without this link.",
  },
  invite: {
    subject: "You're invited to join Terra",
    title: "You're invited to Terra",
    preheader: "Accept your invitation to Terra.",
    heading: "You're invited to Terra",
    paragraphs: [
      "You've been invited to join Terra, where ministries around the world share what they need help with and volunteers offer their skills to meet it.",
      "Accept the invitation to set up your account.",
    ],
    button: "Accept the invitation",
    note: "If you weren't expecting this invitation, you can ignore this email.",
  },
  recovery: {
    subject: "Reset your Terra password",
    title: "Reset your password",
    preheader: "Choose a new password for your Terra account.",
    heading: "Reset your password",
    paragraphs: [
      "We received a request to reset the password for your Terra account. Choose a new one with the button below.",
      ONE_HOUR,
    ],
    button: "Choose a new password",
    note: "If you didn't ask for this, you can ignore this email — your password stays the same.",
  },
  email_change: {
    subject: "Confirm your new email for Terra",
    title: "Confirm your new email",
    preheader: "Confirm the new email address for your Terra account.",
    heading: "Confirm your new email",
    paragraphs: [
      "Confirm that you want to change the email on your Terra account from <strong style=\"color:#0e1726;\">{{ .Email }}</strong> to <strong style=\"color:#0e1726;\">{{ .NewEmail }}</strong>.",
      ONE_HOUR,
    ],
    button: "Confirm new email",
    note: "If you didn't ask to change your email, you can ignore this message and nothing will change.",
  },
  reauthentication: {
    subject: "{{ .Token }} is your Terra verification code",
    title: "Your verification code",
    preheader: "Your Terra verification code.",
    heading: "Your verification code",
    paragraphs: ["Enter this code in Terra to confirm it's you. It expires shortly."],
    code: true,
    note: "If you didn't ask for a code, you can ignore this email.",
  },
};

mkdirSync(OUT, { recursive: true });
for (const [name, email] of Object.entries(EMAILS)) {
  writeFileSync(join(OUT, `${name}.html`), layout(email));
}
console.log(`Wrote ${Object.keys(EMAILS).length} templates to supabase/templates/`);

if (process.argv.includes("--push")) {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    console.error("Set SUPABASE_ACCESS_TOKEN (https://supabase.com/dashboard/account/tokens) to push.");
    process.exit(1);
  }
  const body = {};
  for (const [name, email] of Object.entries(EMAILS)) {
    body[`mailer_subjects_${name}`] = email.subject;
    body[`mailer_templates_${name}_content`] = layout(email);
  }
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`Supabase said ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  console.log("Pushed subjects and templates to the Terra project.");
}
