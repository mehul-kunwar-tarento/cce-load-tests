#!/usr/bin/env bash
# Full round: performance-tests every service on its own, then the whole eBUZIMA event journey, and
# writes one report. It only runs the existing tests in order; it adds no test of its own.
#
#   Part 1, each service on its own (feeds it directly, so a limit found is that service's):
#     adaptor    adaptor/openhim.js    smoke · load · stress · breakpoint (staircase, then a finer one: 3 levels in between)
#     collector  collector/collector.js  the same
#     matcher    matcher/matcher.js    smoke · load · stress · breakpoint (2,000/s flood → drain rate)
#     Step SLA   seed-sla.sh + step-sla/step-sla.js + report-sla.sh   smoke · load · stress · storm
#   Part 2, the whole journey: flow.sh (flow/ebuzima-flow.js)   smoke · full · stress
#   Report: report-round.sh → results/round-<env>-<time>/REPORT.md
#
# Between runs it waits until the matcher has nothing left to process, so one run's events don't
# spill into the next. On Linux it keeps the machine awake (systemd-inhibit); elsewhere, don't let it
# sleep: a sleeping machine freezes the services and spoils the numbers.
# Takes about 3–3.5 hours, depending on how fast the matcher drains. A test that fails doesn't stop the
# round; the report shows it.
#
# Run: DB_PASSWORD=<password> ./round.sh <env>            the full round
#      DB_PASSWORD=<password> ./round.sh <env> --quick    smoke tests only (~10 min): checks the stack and
#                                                         the round work before spending 3 hours
# Needs: docker, curl, jq, and the same access as the tests it runs (services, Kafka and the database).
# Afterwards: DB_PASSWORD=<password> ./cleanup.sh <env> deletes the test data. Run it before the next
# day: the tests' patients have deadlines 1–2 days out, and their alarms would all ring together.
set -uo pipefail

ENV_NAME=${1:-}
MODE=${2:-}
cd "$(dirname "$0")"
source lib/db.sh
db_init "$ENV_NAME" "DB_PASSWORD=<password> $0 <env> [--quick]"
if [[ -n "$MODE" && "$MODE" != --quick ]]; then
  echo "Usage: DB_PASSWORD=<password> $0 <env> [--quick]" >&2
  exit 1
fi
if [[ "$MODE" == --quick ]]; then
  HTTP_PROFILES="smoke"; MATCHER_PROFILES="smoke"; SLA_PROFILES="smoke"; FLOW_PROFILES="smoke"; BREAKPOINT=0
else
  HTTP_PROFILES="smoke full stress"; MATCHER_PROFILES="smoke full stress breakpoint"
  SLA_PROFILES="smoke load stress storm"; FLOW_PROFILES="smoke full stress"; BREAKPOINT=1
fi

# Keep the machine awake for the whole round (Linux with systemd; skipped elsewhere).
if [[ -z "${ROUND_AWAKE:-}" ]] && command -v systemd-inhibit >/dev/null &&
   systemd-inhibit --what=sleep:idle:handle-lid-switch true 2>/dev/null; then
  ROUND_AWAKE=1 exec systemd-inhibit --what=sleep:idle:handle-lid-switch --who=round.sh \
    --why="CCE performance round" "$0" "$@"
fi

cfg() { jq -r "$1" "$CONFIG"; }
MATCHER_METRICS=$(cfg .matcher.metricsUrl)
STEP_SLA_METRICS=$(cfg .stepSla.metricsUrl)
PROTOCOL_API="$(cfg .protocol.baseUrl)/v1/protocol/protocol-definitions"

OUT="results/round-${ENV_NAME}-$(date +%Y%m%d-%H%M)${MODE:+-quick}"
mkdir -p "$OUT"
START=$(date +%s)
RUNS="$OUT/runs.tsv" # one line per run, read by report-round.sh
printf 'name\tpart\ttest\tprofile\trun_id\tstart\tend\texit\tdetail\n' > "$RUNS"
say() { echo "$(date '+%F %T') $*" | tee -a "$OUT/progress.log"; }
record() { printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$@" >> "$RUNS"; }

# --- Pre-flight: every service answers, the database is reachable, eBUZIMA is ACTIVE --------------

FAILED=0
for svc in "adaptor $(cfg .openhimAdaptor.baseUrl)" "collector $(cfg .collector.baseUrl)" \
           "matcher ${MATCHER_METRICS%/actuator/prometheus}" "step-sla ${STEP_SLA_METRICS%/actuator/prometheus}" \
           "protocol $(cfg .protocol.baseUrl)"; do
  read -r name url <<<"$svc"
  health=$(curl -s -m 5 "$url/actuator/health" | jq -r .status 2>/dev/null || true)
  [[ "$health" == UP ]] || { say "Pre-flight: $name ($url) is ${health:-not answering}"; FAILED=1; }
done
run_psql -tA -c 'SELECT 1' >/dev/null 2>&1 || { say "Pre-flight: the $ENV_NAME database is not reachable"; FAILED=1; }
PROTOCOLS=$(curl -s -m 5 "$PROTOCOL_API?size=200" | jq -r '[.content[] | select(.status == "ACTIVE") | .canonical] | join(", ")' 2>/dev/null)
[[ "$PROTOCOLS" == *"$(cfg .protocol.url)|"* ]] || { say "Pre-flight: the eBUZIMA protocol is not ACTIVE: run ./protocol-setup.sh $ENV_NAME"; FAILED=1; }
if [[ $FAILED == 1 ]]; then
  say "Pre-flight failed; nothing sent."
  exit 1
fi

jq -n --arg env "$ENV_NAME" --arg host "$(hostname)" --arg cores "$(nproc 2>/dev/null || echo ?)" \
  --arg commit "$(git rev-parse --short HEAD 2>/dev/null)$(git diff --quiet 2>/dev/null || echo ' (with uncommitted changes)')" \
  --arg protocols "$PROTOCOLS" --argjson start "$START" \
  '{env: $env, host: $host, cores: $cores, commit: $commit, protocols: $protocols, start: $start}' > "$OUT/meta.json"
say "Round start: env $ENV_NAME, output $OUT"
say "ACTIVE protocols: $PROTOCOLS"

# --- Helpers ------------------------------------------------------------------------------------

# Waits until the matcher has processed nothing for 30 s: everything sent so far is done.
matcher_idle() {
  local t0 last now still=0
  t0=$(date +%s)
  last=$(curl -s "$MATCHER_METRICS" | awk '/^cce_events_processed_total/ {s += $2} END {print s + 0}')
  while (( still < 3 )); do
    sleep 10
    now=$(curl -s "$MATCHER_METRICS" | awk '/^cce_events_processed_total/ {s += $2} END {print s + 0}')
    if [[ "$now" == "$last" ]]; then still=$((still + 1)); else still=0; last=$now; fi
  done
  say "  matcher idle (waited $(( $(date +%s) - t0 )) s)"
}

# k6 <name> <part> <test> <profile> [k6 args]: one k6 run, with resource samples and a JSON summary.
k6() {
  local name=$1 part=$2 test=$3 profile=$4 run t0 rc mp
  shift 4
  run=$(date +%m%d%H%M%S); sleep 1 # one run id per second at most
  ./monitor.sh "$ENV_NAME" "$OUT/$name-resources.tsv" 5 >/dev/null 2>&1 & mp=$!
  t0=$(date +%s)
  ./run.sh "$ENV_NAME" "$test" -e PROFILE="$profile" -e RUN_ID="$run" "$@" --no-color \
    --summary-export "$OUT/$name.json" > "$OUT/$name.log" 2>&1
  rc=$?
  kill "$mp" 2>/dev/null; wait "$mp" 2>/dev/null
  record "$name" "$part" "$test" "$profile" "$run" "$t0" "$(date +%s)" "$rc" "$*"
  say "  $name: k6 exit $rc ($(( $(date +%s) - t0 )) s)"
}

# From a breakpoint run's JSON summary: "<highest level passed> <lowest level broken>" (0 = none).
# A level counts only if requests were sent at it. In the summary, a threshold's value true = failed.
# Dropped requests aren't tagged with a level: if they stopped the run, the level it was on broke.
levels() {
  jq -r '(.metrics.dropped_iterations.thresholds // {} | to_entries | map(.value) | any) as $dropped
    | .metrics | to_entries
    | map(select(.key | test("^\\w+\\{level:[0-9]+\\}$"))
          | {lvl: (.key | capture("level:(?<l>[0-9]+)").l | tonumber), name: (.key | split("{")[0]), v: .value})
    | group_by(.lvl)
    | map({lvl: .[0].lvl,
           n: ((map(select(.name == "iterations")) | .[0].v.count) // 0),
           broken: ([.[].v.thresholds // {} | to_entries[].value] | any)})
    | map(select(.n > 0))
    | (map(.lvl) | max) as $top
    | map(if $dropped and .lvl == $top then .broken = true else . end)
    | "\([.[] | select(.broken | not) | .lvl] | max // 0) \([.[] | select(.broken) | .lvl] | min // 0)"' "$1"
}

# Part 1 for an HTTP service: smoke, load, stress, then the staircase and a finer one in between.
http_service() {
  local svc=$1 test=$2 p good bad step fine
  say "== $svc"
  for p in $HTTP_PROFILES; do k6 "$svc-$p" services "$test" "$p"; matcher_idle; done
  (( BREAKPOINT )) || return 0
  k6 "$svc-breakpoint" services "$test" breakpoint; matcher_idle
  read -r good bad <<<"$(levels "$OUT/$svc-breakpoint.json")"
  say "  $svc staircase: passed $good/s, broke at $bad/s"
  if (( good > 0 && bad > good )); then
    # 3 levels in between (e.g. 1600 → 2000, 2400, 2800 → 3200): within ±200/s, at half the events of 7.
    step=$(( (bad - good) / 4 / 50 * 50 )); (( step < 50 )) && step=50
    fine=$(seq -s, $(( good + step )) "$step" $(( bad - step )))
    if [[ -n "$fine" ]]; then
      k6 "$svc-breakpoint-fine" services "$test" breakpoint -e LEVELS="$fine"; matcher_idle
      read -r good bad <<<"$(levels "$OUT/$svc-breakpoint-fine.json")"
      say "  $svc finer staircase ($fine): passed $good/s, broke at ${bad:-0}/s"
    fi
  fi
}

# --- Part 1: each service on its own ------------------------------------------------------------

matcher_idle
http_service adaptor adaptor/openhim.js
http_service collector collector/collector.js

say "== matcher"
for p in $MATCHER_PROFILES; do k6 "matcher-$p" services matcher/matcher.js "$p"; matcher_idle; done

say "== step-sla"
for p in $SLA_PROFILES; do
  if ! ./seed-sla.sh "$ENV_NAME" "$p" > "$OUT/step-sla-$p-seed.log" 2>&1; then
    say "  step-sla-$p: seeding failed (see step-sla-$p-seed.log)"
    record "step-sla-$p" services step-sla/step-sla.js "$p" - "$(date +%s)" "$(date +%s)" seed-failed ""
    continue
  fi
  cp step-sla/last-seed.json "$OUT/step-sla-$p-seed.json"
  k6 "step-sla-$p" services step-sla/step-sla.js "$p"
  ./report-sla.sh "$ENV_NAME" > "$OUT/step-sla-$p-report.txt" 2>&1
  say "  step-sla-$p report: $(tail -1 "$OUT/step-sla-$p-report.txt" | xargs)"
  # The next profile's alarms must not meet this one's: wait until Step SLA has none due.
  until [[ "$(curl -s "$STEP_SLA_METRICS" | awk '/^cce_sla_transitions_due/ {print int($2)}')" -le 0 ]]; do sleep 10; done
done

# --- Part 2: the whole eBUZIMA journey ----------------------------------------------------------

say "== flow"
for p in $FLOW_PROFILES; do
  t0=$(date +%s)
  ./flow.sh "$ENV_NAME" "$p" > "$OUT/flow-$p.log" 2>&1
  rc=$?
  report=$(grep -o "results/flow-$p-[0-9]*" "$OUT/flow-$p.log" | head -1)
  record "flow-$p" flow flow.sh "$p" "${report##*-}" "$t0" "$(date +%s)" "$rc" "$report"
  say "  flow-$p: exit $rc ($(( $(date +%s) - t0 )) s), report $report"
  matcher_idle
done

# --- Report -------------------------------------------------------------------------------------

SLEPT=$(journalctl -b --no-pager -q --since "@$START" 2>/dev/null | grep -c 'Performing sleep' || true)
jq --argjson end "$(date +%s)" --arg slept "${SLEPT:-unknown}" '. + {end: $end, slept: $slept}' \
  "$OUT/meta.json" > "$OUT/meta.tmp" && mv "$OUT/meta.tmp" "$OUT/meta.json"
say "Round done in $(( ($(date +%s) - START) / 60 )) min. Writing the report..."
./report-round.sh "$OUT"
say "Report: $OUT/REPORT.md"
say "Delete the test data before tomorrow: DB_PASSWORD=<password> ./cleanup.sh $ENV_NAME"
