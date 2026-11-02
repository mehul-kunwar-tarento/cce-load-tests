#!/usr/bin/env bash
# Loads or retires the 3 load-test variants of the eBUZIMA protocol (protocol/variants/*.json), through
# the protocol service's API. They have the same steps and triggers as eBUZIMA, so with them ACTIVE every
# eBUZIMA event enrols the patient in 4 protocols. Only which steps are mandatory differs:
#   strict     7 mandatory steps
#   light      1 mandatory step (vitals)
#   lab-focus  5 mandatory steps, vitals optional
# eBUZIMA itself has 3 (vitals, consultation, diagnosis). Mandatory steps get deadlines, so they also
# give Step SLA work; optional steps don't.
# The matcher picks changes up on its next refresh (CCE_PROTOCOL_REFRESH_INTERVAL_MS, default 60 s).
#
# Run: ./protocol-variants.sh <env> load      loads the variants that aren't ACTIVE yet
#      ./protocol-variants.sh <env> retire    retires them (asks first). A retired url + version can't be
#                                             re-activated: bump "version" in the file to load it again.
# Needs: curl and jq.
set -euo pipefail

ENV_NAME=${1:-}
ACTION=${2:-}
cd "$(dirname "$0")"
CONFIG="env/${ENV_NAME}.json"

if [[ "$ENV_NAME" == "prod" ]]; then
  echo "Prod is not allowed yet (see README, Open items)." >&2
  exit 1
fi
if [[ -z "$ENV_NAME" || ! -f "$CONFIG" || ! "$ACTION" =~ ^(load|retire)$ ]]; then
  echo "Usage: $0 <env> load|retire   (env = a file name in env/, e.g. local)" >&2
  exit 1
fi

API="$(jq -r .protocol.baseUrl "$CONFIG")/v1/protocol/protocol-definitions"
echo "Protocol service: $API"

for FILE in protocol/variants/*.json; do
  URL=$(jq -r .url "$FILE")
  VERSION=$(jq -r .version "$FILE")
  FOUND=$(curl -sf "$API/by-url-version?url=$URL&version=$VERSION" || echo '{}')
  STATUS=$(jq -r '.status // "missing"' <<<"$FOUND")

  if [[ "$ACTION" == load ]]; then
    if [[ "$STATUS" == ACTIVE ]]; then
      echo "Already ACTIVE: $URL|$VERSION"
    elif [[ "$STATUS" == missing ]]; then
      # The API takes the PlanDefinition as a JSON string inside {"planDefinitionJson": ...}.
      jq -c '{planDefinitionJson: tojson}' "$FILE" |
        curl -sf -X POST "$API" -H 'Content-Type: application/json' -d @- | jq -r '"Loaded: \(.canonical) \(.status)"'
    else
      echo "$URL|$VERSION exists but is $STATUS: bump \"version\" in $FILE to load it again." >&2
      exit 1
    fi
  elif [[ "$STATUS" == ACTIVE ]]; then
    read -r -p "Retire $URL|$VERSION in $ENV_NAME? Enrolled patients stay on it. Type yes: " ANSWER
    if [[ "$ANSWER" == yes ]]; then
      curl -sf -X POST "$API/$(jq -r .id <<<"$FOUND")/retire" >/dev/null && echo "Retired $URL|$VERSION"
    fi
  else
    echo "Not ACTIVE ($STATUS): $URL|$VERSION"
  fi
done
echo "The matcher picks this up on its next protocol refresh (up to 60 s)."
