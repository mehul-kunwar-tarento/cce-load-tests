#!/usr/bin/env bash
# print-settings.sh — print the settings and phase plan a test would use, without running anything.
#
# What:    Thin entry point for `node tools/cli.mjs settings`. Shows each setting's value, where it came
#          from (default, environment file, env var, --set, derived) and whether it is still to be
#          confirmed, then the phase plan. Opens no connection.
# How:     scripts/print-settings.sh <env> [<subject> <test-type>] [--set NAME=value]… [--json]
#          e.g. scripts/print-settings.sh local collector load --set LOAD_EVENTS=1000
# Needs:   Node.js 22, config/environments/<env>.json.
# Outputs: The settings table (or JSON) on screen; exit 0, or 2 for a bad setting.
set -euo pipefail

CLI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/tools/cli.mjs"
exec node "$CLI" settings "$@"
