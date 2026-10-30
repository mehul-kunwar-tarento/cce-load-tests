#!/usr/bin/env bash
# Makes the eBUZIMA protocol the one the matcher matches against, through the protocol service's API:
#   1. loads protocol/emr-service-protocol.json (eBUZIMA "EMR Service Diabetes Screening & Management
#      Protocol", from cce-protocol-service release-2.0.0) if that url + version isn't ACTIVE yet;
#   2. with --retire-others, retires every other ACTIVE protocol, so eBUZIMA events don't also enrol
#      patients in test protocols (several start on any Encounter). Asks before retiring.
# The matcher picks changes up on its next refresh (CCE_PROTOCOL_REFRESH_INTERVAL_MS, default 60 s).
#
# Run: ./protocol-setup.sh <env> [--retire-others]
# Needs: curl and jq.
set -euo pipefail

ENV_NAME=${1:-}
RETIRE=${2:-}
cd "$(dirname "$0")"
CONFIG="env/${ENV_NAME}.json"

if [[ "$ENV_NAME" == "prod" ]]; then
  echo "Prod is not allowed yet (see README, Open items)." >&2
  exit 1
fi
if [[ -z "$ENV_NAME" || ! -f "$CONFIG" || ( -n "$RETIRE" && "$RETIRE" != "--retire-others" ) ]]; then
  echo "Usage: $0 <env> [--retire-others]   (env = a file name in env/, e.g. local)" >&2
  exit 1
fi

API="$(jq -r .protocol.baseUrl "$CONFIG")/v1/protocol/protocol-definitions"
URL=$(jq -r .protocol.url "$CONFIG")
VERSION=$(jq -r .protocol.version "$CONFIG")
FILE=protocol/emr-service-protocol.json

echo "Protocol service: $API"
STATUS=$(curl -sf "$API/by-url-version?url=$URL&version=$VERSION" | jq -r .status || echo missing)

if [[ "$STATUS" == ACTIVE ]]; then
  echo "eBUZIMA protocol $URL|$VERSION is already ACTIVE."
elif [[ "$STATUS" == missing ]]; then
  echo "Loading $FILE..."
  # The API takes the PlanDefinition as a JSON string inside {"planDefinitionJson": ...}.
  jq -c '{planDefinitionJson: tojson}' "$FILE" |
    curl -sf -X POST "$API" -H 'Content-Type: application/json' -d @- | jq -r '"Loaded: \(.canonical) \(.status)"'
else
  echo "$URL|$VERSION exists but is $STATUS. A retired version can't be re-activated; load a new version." >&2
  exit 1
fi

OTHERS=$(curl -sf "$API?size=200" | jq -r --arg url "$URL" \
  '.content[] | select(.status == "ACTIVE" and .url != $url) | "\(.id) \(.canonical)"')
if [[ -z "$OTHERS" ]]; then
  echo "No other ACTIVE protocols."
  exit 0
fi
echo "Other ACTIVE protocols:"
sed 's/^[^ ]* /  /' <<<"$OTHERS"
if [[ "$RETIRE" != "--retire-others" ]]; then
  echo "eBUZIMA events may also enrol patients in these. Retire them with: $0 $ENV_NAME --retire-others"
  exit 0
fi

read -r -p "Retire these $(wc -l <<<"$OTHERS") protocols in $ENV_NAME? Enrolled patients stay on them. Type yes: " ANSWER
[[ "$ANSWER" == yes ]] || { echo "Nothing retired."; exit 0; }
while read -r id canonical; do
  curl -sf -X POST "$API/$id/retire" >/dev/null && echo "Retired $canonical"
done <<<"$OTHERS"
echo "The matcher stops matching them on its next protocol refresh (up to 60 s)."
