#!/usr/bin/env bash
# build-report.sh — render a run report, or a series summary over several runs, from result.json files.
#
# What:    Thin entry point for `node tools/cli.mjs report`. One folder → report.md of that run; --series,
#          --latest or --since → summary.json + summary.md per service and for the whole flow.
# How:     scripts/build-report.sh results/collector-load-20261105-142233
#          scripts/build-report.sh --latest 6
#          scripts/build-report.sh --series results/<dir1> results/<dir2> [--out <dir>]
# Needs:   Node.js 22; result folders written by run-test.sh.
# Outputs: report.md or summary.json + summary.md; the Markdown on screen; exit 0, or 2 when refused.
set -euo pipefail

CLI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/tools/cli.mjs"
exec node "$CLI" report "$@"
