#!/usr/bin/env bash
# run-test.sh — run one performance test (preflight, load, watchers, data checks, result and report).
#
# What:    Thin entry point for `node tools/cli.mjs run`. A run can last many minutes; when
#          systemd-inhibit exists (most Linux desktops) the laptop is kept from sleeping or idling
#          while it runs. All logic is in Node (tools/commands/run-test.mjs).
# How:     scripts/run-test.sh <env> <subject> <test-type> [--set NAME=value]… [--dry-run]
#          e.g. scripts/run-test.sh local collector smoke
#               scripts/run-test.sh local matcher stress --set PLAN_DEFINITION_SET=kenya-sha-emr-service
# Needs:   Node.js 22, Docker + the k6 image (scripts/build-k6-image.sh), config/environments/<env>.json,
#          DB_PASSWORD exported for database checks, a running CCE stack.
# Outputs: results/<subject>-<test-type>-<yyyymmdd-hhmmss>/ (result.json, report.md, …); the report on
#          screen; exit 0 passed, 1 failed/aborted, 2 refused, 3 tool error.
set -euo pipefail

# Absolute path of the CLI, so the script works from any folder (paths you pass stay relative to yours).
CLI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/tools/cli.mjs"

# Keep the machine awake during a real run; a dry run needs no inhibitor.
if command -v systemd-inhibit >/dev/null 2>&1 && [[ " $* " != *" --dry-run "* ]]; then
  exec systemd-inhibit --what=idle:sleep --who=cce-performance-tests --why="performance test running" \
    node "$CLI" run "$@"
fi
exec node "$CLI" run "$@"
