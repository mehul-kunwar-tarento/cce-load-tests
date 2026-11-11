#!/usr/bin/env bash
# cleanup-test-data.sh — delete the test data of one run (or all LOADTEST data), verified table by table
#
# What:    Thin entry point for `node tools/cli.mjs cleanup`. Removes the rows a load test left in CCE's database
#          (child tables first, small batches, disk and replication-slot checks while it goes) and proves with
#          before/after counts per table that nothing is left. Refuses on prod, while services still process
#          the run's data, or when disk/WAL headroom is low.
# How:     scripts/cleanup-test-data.sh local --run-id 20261105-142233 --print-sql   (show the SQL, connect to nothing)
#          scripts/cleanup-test-data.sh local --run-id 20261105-142233 --dry-run     (count only, delete nothing)
#          scripts/cleanup-test-data.sh local --run-id 20261105-142233               (delete; asks for "yes")
#          scripts/cleanup-test-data.sh local --all --yes                            (every LOADTEST row)
# Needs:   Node.js 22, npm install done; config/environments/<env>.json with safety.allowCleanup true;
#          DB_PASSWORD (or database.passwordEnvVar) exported, except for --print-sql.
# Outputs: The per-table table; cleanup JSON next to the run (results/<run>/cleanup-<stamp>.json) or in
#          results/cleanup-<runId|all>-<stamp>/; exit 0 verified/dry-run, 1 incomplete, 2 refused, 3 tool error.
set -euo pipefail

# The repository root, so the script works from any folder.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "${ROOT}/tools/cli.mjs" cleanup "$@"
