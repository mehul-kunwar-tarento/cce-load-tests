#!/usr/bin/env bash
# check-services.sh — preflight: are the services, Postgres, Kafka, plan definitions, disk and monitoring ready?
#
# What:    Thin entry point for `node tools/cli.mjs preflight`. Checks the stack before a test without sending
#          any test traffic (separate from the smoke test) and prints one line per check: ✔ pass, ✖ fail,
#          ! warning, – skipped. A failed required check means: do not start the test.
# How:     scripts/check-services.sh local                       (stack check of every service)
#          scripts/check-services.sh local --subject matcher     (what a matcher test needs)
#          scripts/check-services.sh local --subject matcher --set PLAN_DEFINITION_SET=kenya-sha-emr-service --json
# Needs:   Node.js 22, npm install done; config/environments/<env>.json; DB_PASSWORD (or the variable named by
#          database.passwordEnvVar) exported for the database checks; the CCE stack running.
# Outputs: The check table (or JSON with --json / --out <file>); exit 0 passed, 2 failed/refused, 3 tool error.
set -euo pipefail

# The repository root, so the script works from any folder.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "${ROOT}/tools/cli.mjs" preflight "$@"
