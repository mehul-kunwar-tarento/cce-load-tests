#!/usr/bin/env bash
# Runs a k6 test with the k6 Docker image, so k6 itself doesn't need installing.
#
# Run: ./run.sh <env> <test> [k6 options]      e.g. ./run.sh local adaptor/openhim.js
# Needs: docker.
set -euo pipefail

K6_IMAGE=grafana/k6:2.3.0   # fixed version, so every environment runs the same k6

ENV_NAME=${1:-}
TEST=${2:-}
cd "$(dirname "$0")"

if [[ "$ENV_NAME" == "prod" ]]; then
  echo "Prod is not allowed yet (see README, Open items)." >&2
  exit 1
fi
if [[ ! -f "env/${ENV_NAME}.json" || ! -f "$TEST" ]]; then
  echo "Usage: $0 <env> <test> [k6 options]   e.g. $0 local adaptor/openhim.js" >&2
  exit 1
fi
shift 2

echo "Environment: $ENV_NAME (env/${ENV_NAME}.json)"
echo "Test:        $TEST"

# --network host: the container reaches the services the same way a program on this server would.
# -v: the repo is mounted at /tests, so the test can read env/<env>.json.
docker run --rm --network host -u "$(id -u):$(id -g)" \
  -v "$PWD:/tests" -w /tests \
  "$K6_IMAGE" run -e ENV="$ENV_NAME" "$@" "$TEST"
