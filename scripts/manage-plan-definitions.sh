#!/usr/bin/env bash
# manage-plan-definitions.sh — validate, generate, check, load, retire or delete a plan-definition set
#
# What:    Thin entry point for `node tools/cli.mjs plan-definitions`. Which plan definitions are ACTIVE is a test
#          parameter (PLAN_DEFINITION_SET); this script prepares and inspects them. Writes (load/retire/delete)
#          need safety.allowPlanDefinitionChanges=true and never touch definitions outside the named set or
#          without this tool's load-test marker.
# How:     scripts/manage-plan-definitions.sh validate --set kenya-sha-emr-service   (offline)
#          scripts/manage-plan-definitions.sh status local --set kenya-sha-emr-service
#          scripts/manage-plan-definitions.sh load local --set kenya-sha-emr-service
#          scripts/manage-plan-definitions.sh retire local --set kenya-sha-emr-service   (asks for "yes")
#          scripts/manage-plan-definitions.sh list-active local
# Needs:   Node.js 22, npm install done; test-data/; for env sub-commands config/environments/<env>.json and the
#          protocol service running.
# Outputs: Printed tables and messages; .cache/plan-definitions/ (generated JSON, ledger); exit 0/1/2/3.
set -euo pipefail

# The repository root, so the script works from any folder.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "${ROOT}/tools/cli.mjs" plan-definitions "$@"
