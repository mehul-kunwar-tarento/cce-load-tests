#!/usr/bin/env bash
# Runs a k6 test in Docker, so k6 itself doesn't need installing.
#
# Run: ./run.sh <env> <test> [k6 options]      e.g. ./run.sh local matcher/matcher.js
# Needs: docker (and internet the first time, to build the image).
set -euo pipefail

# Our own k6 image: k6 2.3.0 plus Kafka support (k6-kafka-image/Dockerfile). Fixed versions, so every
# environment runs the same k6. The tag changes whenever the Dockerfile's versions change.
K6_IMAGE=cce-load-tests/k6:2.3.0-kafka2.2.0

ENV_NAME=${1:-}
TEST=${2:-}
cd "$(dirname "$0")"

if [[ "$ENV_NAME" == "prod" ]]; then
  echo "Prod is not allowed yet (see README, Open items)." >&2
  exit 1
fi
if [[ ! -f "env/${ENV_NAME}.json" || ! -f "$TEST" ]]; then
  echo "Usage: $0 <env> <test> [k6 options]   e.g. $0 local matcher/matcher.js" >&2
  exit 1
fi
shift 2

# Build the image once per server (about a minute); later runs reuse it.
if ! docker image inspect "$K6_IMAGE" >/dev/null 2>&1; then
  echo "Building $K6_IMAGE (first run on this machine)..."
  docker build -t "$K6_IMAGE" k6-kafka-image/
fi

# Every run gets an id (the start time in seconds). Tests put it in their test patient IDs, so an
# after-run report can find exactly this run's rows.
RUN_ID=$(date +%s)

echo "Environment: $ENV_NAME (env/${ENV_NAME}.json)"
echo "Test:        $TEST"
echo "Run id:      $RUN_ID"

# What the after-run reports read: which run this was, and k6's own end-of-run numbers.
mkdir -p results
jq -n --arg env "$ENV_NAME" --arg test "$TEST" --arg runId "$RUN_ID" \
  '{env: $env, test: $test, runId: $runId}' > results/last-run.json

# --network host: the container reaches the services the same way a program on this server would.
# -v: the repo is mounted at /tests, so the test can read env/<env>.json and write results/.
# --summary-export: the same numbers as the summary on screen, saved as JSON for the reports.
docker run --rm --network host -u "$(id -u):$(id -g)" \
  -v "$PWD:/tests" -w /tests \
  "$K6_IMAGE" run -e ENV="$ENV_NAME" -e RUN_ID="$RUN_ID" \
  --summary-export results/last-summary.json "$@" "$TEST"
