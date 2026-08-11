#!/bin/bash
# ============================================================================
# push-secrets.sh
# ----------------------------------------------------------------------------
# Reads functions/.env.secrets and uploads every key found in it to
# Firebase's Secret Manager, one at a time, using the Firebase CLI. This is
# what makes functions/.env.secrets "the one document" — you fill that file
# in once, then run this script instead of typing out six separate
# `firebase functions:secrets:set` commands by hand.
#
# Safe to re-run any time you change a key — it just creates a new version
# of that secret. Skips any line that's still blank, so you don't have to
# fill in every key at once (e.g. leave RILLA_WEBHOOK_SECRET blank until
# Rilla confirms their side).
#
# Usage:
#   ./scripts/push-secrets.sh
# ============================================================================

set -e

ENV_FILE="functions/.env.secrets"

if [ ! -f "$ENV_FILE" ]; then
  echo "Couldn't find $ENV_FILE — run this script from the project root (the folder containing 'functions/')."
  exit 1
fi

if ! command -v firebase &> /dev/null; then
  echo "Firebase CLI not found. Install it first: npm install -g firebase-tools"
  exit 1
fi

echo "Reading $ENV_FILE ..."
echo ""

count_set=0
count_skipped=0

while IFS='=' read -r key value; do
  # Skip blank lines and comments
  [[ -z "$key" || "$key" == \#* ]] && continue

  # Trim whitespace
  key=$(echo "$key" | xargs)
  value=$(echo "$value" | xargs)

  if [ -z "$value" ]; then
    echo "  ⏭  $key — blank, skipping (fill it in later and re-run this script)"
    count_skipped=$((count_skipped+1))
    continue
  fi

  echo "  → Setting $key ..."
  printf '%s' "$value" | firebase functions:secrets:set "$key" --data-file=-
  count_set=$((count_set+1))
done < "$ENV_FILE"

echo ""
echo "Done. $count_set secret(s) set, $count_skipped left blank."
echo ""
echo "IMPORTANT: secrets don't take effect until you deploy. Run:"
echo "  firebase deploy --only functions"
