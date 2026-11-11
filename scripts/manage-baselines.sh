#!/usr/bin/env bash
# manage-baselines.sh — save, compare, list or show performance baselines.
#
# What:    Thin entry point for `node tools/cli.mjs baseline`. A baseline is the mean of key metrics
#          over at least 3 runs under the same conditions; later runs are compared with it.
# How:     scripts/manage-baselines.sh save <name> <resultDir>… [--note "…"] [--allow-fewer] [--force]
#          scripts/manage-baselines.sh compare <name> <resultDir>…
#          scripts/manage-baselines.sh list | show <name>
# Needs:   Node.js 22; result folders written by run-test.sh.
# Outputs: baselines/<name>.json, baseline-comparison.json in run folders; tables on screen.
set -euo pipefail

CLI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/tools/cli.mjs"
exec node "$CLI" baseline "$@"
