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
