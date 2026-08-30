#!/usr/bin/env bash
#
# Create and attach the Vercel Connect Google connector this app authenticates
# users through, then report what is left to do on the Google side.
#
#   scripts/setup-google-connector.sh <google-client-secret.json> [environment ...]
#
# Environments default to production and preview; a production attachment does
# not enable preview or local development. The downloaded client secret is
# reshaped into a private temporary file, handed to Vercel, and deleted on exit.
# Neither file is ever written into the repository.
#
# Re-running is safe: an existing connector is reused, an existing attachment is
# reported rather than duplicated, and an existing GOOGLE_CONNECTOR_UID is left
# alone.
set -euo pipefail

connector_name="${CONNECTOR_NAME:-open-instinct}"
connector_uid="google/${connector_name}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scopes_file="${repo_root}/lib/google-workspace/config.ts"

fail() {
  echo "error: $*" >&2
  exit 1
}

credentials_json="${1:-}"
[ -n "$credentials_json" ] ||
  fail "usage: $0 <google-client-secret.json> [environment ...]"
[ -f "$credentials_json" ] || fail "no such file: $credentials_json"
shift

environments=("$@")
[ "${#environments[@]}" -gt 0 ] || environments=(production preview)

command -v vercel >/dev/null || fail "vercel CLI not found: npm i -g vercel"
command -v jq >/dev/null || fail "jq not found: brew install jq"

# Vercel wants top-level clientId and clientSecret, not Google's nested
# web.client_id and web.client_secret download.
client_id="$(jq -r '.web.client_id // .installed.client_id // empty' "$credentials_json")"
client_secret="$(jq -r '.web.client_secret // .installed.client_secret // empty' "$credentials_json")"
[ -n "$client_id" ] && [ -n "$client_secret" ] ||
  fail "$credentials_json has no web.client_id/web.client_secret. Download the OAuth *web* client JSON from Google Cloud."

if [ ! -f "${repo_root}/.vercel/project.json" ]; then
  echo "==> Linking this directory to a Vercel project"
  (cd "$repo_root" && vercel link)
fi

connector_data="$(umask 077 && mktemp)"
trap 'rm -f "$connector_data"' EXIT
jq -n --arg id "$client_id" --arg secret "$client_secret" \
  '{clientId: $id, clientSecret: $secret}' >"$connector_data"

cd "$repo_root"

# Match the uid, not the bare name. Connector names are unique per team across
# services, so a name alone can belong to another service's connector entirely
# (linq/<name> is not google/<name>).
if vercel connect list 2>/dev/null | grep -q "$connector_uid"; then
  echo "==> Connector ${connector_uid} already exists, reusing it"
else
  echo "==> Creating connector ${connector_uid}"
  create_status=0
  create_output="$(vercel connect create google \
    --connection-method oauth \
    --name "$connector_name" \
    --data @"$connector_data" 2>&1)" || create_status=$?
  echo "$create_output"
  if [ "$create_status" -ne 0 ]; then
    # The listing above already established that $connector_uid is absent, so a
    # 409 here means the *name* is taken by a connector for some other service.
    # Reusing that one would attach the wrong provider, so stop with the fix.
    if echo "$create_output" | grep -qE "already exists|\(409\)"; then
      fail "the name '${connector_name}' is already taken by another connector on this team.
Connector names are unique across services, so '${connector_uid}' cannot be created
while it is. Re-run with a free name, for example:

  CONNECTOR_NAME=${connector_name}-google $0 '${credentials_json}'

GOOGLE_CONNECTOR_UID is then set to google/${connector_name}-google to match."
    fi
    fail "vercel connect create failed with exit code ${create_status}"
  fi
fi

# One attach naming every environment. `connect attach` defines the authorized
# environment list rather than adding to it, so attaching in a loop leaves only
# the last environment enabled and the earlier ones fail at runtime with
# "Connector is not enabled for this environment".
echo "==> Attaching ${connector_uid} to ${environments[*]}"
attach_args=(connect attach "$connector_uid")
for environment in "${environments[@]}"; do
  attach_args+=(--environment "$environment")
done
attach_args+=(--yes)
attach_status=0
attach_output="$(vercel "${attach_args[@]}" 2>&1)" || attach_status=$?
echo "$attach_output"
if [ "$attach_status" -ne 0 ]; then
  if echo "$attach_output" | grep -qE "already attached|already linked"; then
    echo "    (already attached)"
  else
    fail "attaching ${connector_uid} failed with exit code ${attach_status}"
  fi
fi
# The CLI echoes the environments it enabled; surface any that did not take.
for environment in "${environments[@]}"; do
  if ! echo "$attach_output" | grep -qi "$environment"; then
    echo "    WARNING: ${environment} was not named in the attach result."
    echo "      Re-run: vercel connect attach ${connector_uid} --environment ${environment} --yes"
    echo "      Note that a later single-environment attach replaces earlier ones."
  fi
done

# The app falls back to google/open-instinct, so the variable only has to be set
# when the connector carries another name. Setting it anyway keeps the deployed
# value explicit rather than implied.
existing_uid_environments="$(vercel env ls 2>/dev/null | grep -c "GOOGLE_CONNECTOR_UID" || true)"
if [ "$existing_uid_environments" -gt 0 ]; then
  echo "==> GOOGLE_CONNECTOR_UID is already set; leaving it alone."
  echo "    It must equal ${connector_uid}. If it does not:"
  echo "      vercel env rm GOOGLE_CONNECTOR_UID <environment>"
  echo "      then re-run this script."
else
  for environment in "${environments[@]}"; do
    echo "==> Setting GOOGLE_CONNECTOR_UID for ${environment}"
    printf '%s' "$connector_uid" | vercel env add GOOGLE_CONNECTOR_UID "$environment"
  done
fi

# `vercel env add <name> preview` prompts for a git branch, and a piped value
# leaves nothing on stdin to answer it, so the write can be silently skipped.
# Show what actually landed rather than assuming both environments took.
echo
echo "==> GOOGLE_CONNECTOR_UID is now set for"
verify="$(vercel env ls 2>/dev/null | grep "GOOGLE_CONNECTOR_UID" || true)"
if [ -n "$verify" ]; then
  echo "$verify"
else
  echo "    nothing. Set it with: vercel env add GOOGLE_CONNECTOR_UID production"
fi
for environment in "${environments[@]}"; do
  if ! echo "$verify" | grep -qi "$environment"; then
    echo "    WARNING: ${environment} has no GOOGLE_CONNECTOR_UID. Run:"
    echo "      vercel env add GOOGLE_CONNECTOR_UID ${environment}"
    echo "      (press Enter at the git-branch prompt to cover all branches)"
  fi
done

echo
echo "==> Connectors now on this project"
final_list="$(vercel connect list 2>&1 || true)"
echo "$final_list"
if ! echo "$final_list" | grep -q "$connector_uid"; then
  fail "${connector_uid} is still not linked to this project. Nothing below would be true, so stopping here."
fi

cat <<EOF

Connector ${connector_uid} is set up. Two things finish the job:

1. Redeploy so the deployment picks up GOOGLE_CONNECTOR_UID:

     vercel deploy --prod

2. On the Google Cloud OAuth consent screen, the app's own scope list must be
   declared, and while publishing status is Testing your Google account must be
   listed under Test users. Until it is, the Connect button appears and Google
   then blocks consent. The scopes this app requests:

$(sed -n '/^export const GOOGLE_WORKSPACE_SCOPES = \[/,/^\] as const;/p' "$scopes_file" |
  sed -n 's/^  "\(.*\)",$/     \1/p')

   The OAuth client also needs https://connect.vercel.com/callback as an
   authorized redirect URI, and the Gmail, Calendar, and People APIs enabled.

Then hard-refresh Workspace. It should read Connect, not Setup required. If it
still reads Setup required, the deployment's runtime logs now name the reason:

     vercel logs --prod | grep google-workspace
EOF
