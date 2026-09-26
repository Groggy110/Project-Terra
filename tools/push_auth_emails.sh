#!/usr/bin/env bash
# Pushes the Terra-styled auth emails in supabase/templates/ to the linked
# Supabase project, with their subjects.
#
# Supabase only accepts custom templates once the project sends mail through
# its own SMTP provider (Dashboard → Authentication → Emails → SMTP Settings);
# on the free tier's built-in sender the API refuses them. Set SMTP up first,
# then run:
#
#   ./tools/push_auth_emails.sh
#
# Uses the Supabase CLI's saved login (macOS keychain) or $SUPABASE_ACCESS_TOKEN.
set -euo pipefail
cd "$(dirname "$0")/.."
REF=$(cat supabase/.temp/project-ref)
TOKEN=${SUPABASE_ACCESS_TOKEN:-}
if [ -z "$TOKEN" ]; then
  TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
  TOKEN=${TOKEN#go-keyring-base64:}
  case "$TOKEN" in sbp_*) ;; *) TOKEN=$(echo "$TOKEN" | base64 -d);; esac
fi
python3 - "$REF" <<'PY' > /tmp/terra-auth-emails.json
import json, sys
subjects = {
  "magic_link": "Your Terra sign-in link",
  "confirmation": "Confirm your Terra account",
  "recovery": "Reset your Terra password",
  "email_change": "Confirm your new email for Terra",
  "invite": "You have been invited to Terra",
  "reauthentication": "Your Terra verification code",
}
body = {}
for key, subject in subjects.items():
    body[f"mailer_subjects_{key}"] = subject
    body[f"mailer_templates_{key}_content"] = open(f"supabase/templates/{key}.html").read()
print(json.dumps(body))
PY
curl -sf -X PATCH "https://api.supabase.com/v1/projects/$REF/config/auth" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data @/tmp/terra-auth-emails.json > /dev/null && echo "Auth emails updated."
rm -f /tmp/terra-auth-emails.json
