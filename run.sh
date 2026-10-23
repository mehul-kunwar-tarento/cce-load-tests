#!/usr/bin/env bash
# Runs a k6 test in Docker, so k6 itself doesn't need installing.
#
# Run: ./run.sh <env> <test> [k6 options]      e.g. ./run.sh local adaptor/openhim.js
# Needs: docker (and internet the first time, to build the image).
set -euo pipefail

# Our own k6 image: k6 2.3.0 plus Kafka support (docker/Dockerfile). Fixed versions, so every
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
  echo "Usage: $0 <env> <test> [k6 options]   e.g. $0 local adaptor/openhim.js" >&2
  exit 1
fi
shift 2

# Build the image once per server (about a minute); later runs reuse it.
if ! docker image inspect "$K6_IMAGE" >/dev/null 2>&1; then
  echo "Building $K6_IMAGE (first run on this machine)..."
  docker build -t "$K6_IMAGE" docker/
fi

echo "Environment: $ENV_NAME (env/${ENV_NAME}.json)"
echo "Test:        $TEST"

# --network host: the container reaches the services the same way a program on this server would.
# -v: the repo is mounted at /tests, so the test can read env/<env>.json.
docker run --rm --network host -u "$(id -u):$(id -g)" \
  -v "$PWD:/tests" -w /tests \
  "$K6_IMAGE" run -e ENV="$ENV_NAME" "$@" "$TEST"
