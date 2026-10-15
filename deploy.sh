#!/usr/bin/env sh
# Push the code and refresh THE deployment, leaving the public URL untouched.
#
# Never run `clasp create-deployment` on this project: it mints a new
# deploymentId, therefore a new /exec URL, and every link already handed to the
# jurors stops working. This script only ever updates the one below.
set -eu

DEPLOYMENT_ID=AKfycbxep-qCF0bifQDZRNG2N560jGKrKEs5BsadRfziDG47SLI1Xrl_KVk56__KoFrhY7m0Uw
URL="https://script.google.com/macros/s/${DEPLOYMENT_ID}/exec"

[ -f config.gs ] || {
  echo "config.gs manquant. Le créer avec :" >&2
  echo "  const SHEET_ID = '<id du tableur>';" >&2
  exit 1
}

clasp push --force
clasp update-deployment "$DEPLOYMENT_ID"

# Google keeps serving a cached error page for a short while after a redeploy,
# so a check run immediately after a fix can report a failure that is gone.
# The cache-buster is what the page itself uses.
printf 'state : '
curl -sL -o /dev/null -w '%{http_code}\n' "${URL}?action=state&_=$(date +%s)"
echo "$URL"

# Exactly one versioned deployment must exist: each extra one is a second public
# URL serving an older copy of the app into the same spreadsheet. They do appear
# on their own, so check every time.
#
# `clasp list-deployments` lags behind both deployments and deletions, so the
# listing alone produces false alarms. Only a fetch is authoritative: a deleted
# deployment answers 404. So list, then probe.
LIVE=0
for ID in $(clasp list-deployments 2>/dev/null | sed -n 's/^- \([^ ]*\) @[0-9].*/\1/p'); do
  CODE=$(curl -sL -o /dev/null -w '%{http_code}' "https://script.google.com/macros/s/${ID}/exec?_=$(date +%s)")
  [ "$CODE" = "404" ] && continue
  LIVE=$((LIVE + 1))
  [ "$ID" = "$DEPLOYMENT_ID" ] || echo "INTRUS vivant ($CODE) : $ID" >&2
done
if [ "$LIVE" -gt 1 ]; then
  echo "ATTENTION : $LIVE deploiements publics vivants, il n'en faut qu'un." >&2
  echo "Supprimer chaque intrus : clasp delete-deployment <id>" >&2
  exit 1
fi
echo "deploiements publics vivants : $LIVE"
