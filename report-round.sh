#!/usr/bin/env bash
# Writes the report for a round.sh run: <round folder>/REPORT.md, also printed.
#   Summary   each service's results and breaking point, the weakest link, the end-to-end verdict
#   Part 1    each service on its own: smoke, load, stress, breakpoint, and sent vs database rows
#   Part 2    the whole eBUZIMA journey (flow.sh): smoke, full, stress, and the time at each stage
# It only reads what round.sh saved (k6 JSON summaries, Step SLA and flow reports), so it can be run
# again on an old round, e.g. after changing this script. With DB_PASSWORD set it also counts each
# run's rows in the database (run it before cleanup.sh deletes them).
#
# Run: [DB_PASSWORD=<password>] ./report-round.sh results/round-<env>-<time>
# Needs: jq (and docker for the database counts).
set -uo pipefail

DIR=${1%/}
cd "$(dirname "$0")"
if [[ ! -f "$DIR/runs.tsv" || ! -f "$DIR/meta.json" ]]; then
  echo "Usage: $0 results/round-<env>-<time>   (a folder written by round.sh)" >&2
  exit 1
fi
ENV_NAME=$(jq -r .env "$DIR/meta.json")
PEAK=50 # the expected peak, events/s: lib/load.js
# Flow rates in events/s (patients/s × 7.3 events per patient): flow/ebuzima-flow.js
declare -A FLOW_RATE=([smoke]=7 [full]=51 [stress]=197)

DB=0
if [[ -n "${DB_PASSWORD:-}" ]]; then
  source lib/db.sh
  db_init "$ENV_NAME" "DB_PASSWORD=<password> $0 <round folder>"
  DB=1
fi

# --- Helpers ------------------------------------------------------------------------------------

# field <run name> <column>: a value from runs.tsv (columns: name part test profile run_id start end exit detail)
field() { awk -F'\t' -v n="$1" -v c="$2" 'NR > 1 && $1 == n {print $c}' "$DIR/runs.tsv" | tail -1; }
ran() { [[ -n "$(field "$1" 1)" ]]; }
# m <run name> <jq expression>: from the run's k6 JSON summary; "–" when missing
m() { jq -r "($2) // \"–\"" "$DIR/$1.json" 2>/dev/null || echo "–"; }
num() { jq -rn --arg v "$1" --argjson d "${2:-1}" '$v | tonumber? // null | if . == null then "–" else ((. * pow(10; $d) | round) / pow(10; $d) | tostring) end'; }
times_peak() { jq -rn --arg v "$1" --argjson p "$PEAK" '$v | tonumber? // null | if . == null then "–" else "\((. / $p * 10 | round) / 10)×" end'; }

verdict() {
  case "$(field "$1" 8)" in
    "") echo "— not run" ;;
    0) echo "✅ PASS" ;;
    99) echo "❌ FAIL" ;;
    seed-failed) echo "⚠️ seeding failed" ;;
    *) echo "⚠️ error (exit $(field "$1" 8))" ;;
  esac
}
# The rules a run broke, e.g. "http_req_duration p(95)<500". In the summary, true = failed.
broken() {
  jq -r '[.metrics | to_entries[] | .key as $k | (.value.thresholds // {}) | to_entries[]
          | select(.value == true) | "`\($k) \(.key)`"] | if length == 0 then "–" else join(", ") end' \
    "$DIR/$1.json" 2>/dev/null || echo "–"
}
# sql <query> with :'p' = the run's patient prefix (LOADTEST-<run>-%)
sql() { run_psql -tA -F'|' -v p="LOADTEST-$1-%" <<<"$2"; }

# Breakpoint levels: "level|sent|p95|errors%|broken" per level the run reached. Dropped requests
# aren't tagged with a level: if they stopped the run, the level it was on broke.
level_rows() {
  jq -r '(.metrics.dropped_iterations.thresholds // {} | to_entries | map(.value) | any) as $dropped
    | (.metrics.dropped_iterations.count // 0) as $ndrop
    | .metrics | to_entries
    | map(select(.key | test("^\\w+\\{level:[0-9]+\\}$"))
          | {lvl: (.key | capture("level:(?<l>[0-9]+)").l | tonumber), name: (.key | split("{")[0]), v: .value})
    | group_by(.lvl)
    | map({lvl: .[0].lvl,
       n: ((map(select(.name == "iterations")) | .[0].v.count) // 0),
       p95: (map(select(.name == "http_req_duration")) | .[0].v["p(95)"]),
       err: (map(select(.name == "http_req_failed")) | .[0].v.value),
       broken: [.[] | .name as $n | (.v.thresholds // {}) | to_entries[] | select(.value == true) | "\($n) \(.key)"]})
    | map(select(.n > 0))
    | (map(.lvl) | max) as $top
    | map(if $dropped and .lvl == $top then .broken += ["k6 dropped \($ndrop) requests"] else . end)[]
    | "\(.lvl)|\(.n)|\(.p95 // 0 | . * 10 | round / 10)|\((.err // 0) * 1000 | round / 10)|\(.broken | join(", "))"' "$DIR/$1.json" 2>/dev/null
}
# "<passed> <broken>" for a breakpoint run (0 = none)
passed_broken() {
  level_rows "$1" | awk -F'|' '$5 == "" {if ($1 > p) p = $1} $5 != "" {if (b == "" || $1 < b) b = $1} END {print p + 0, b + 0}'
}

# --- Part 1 pieces ------------------------------------------------------------------------------

http_table() {
  local svc=$1 p
  echo "| Profile | Load | Result | Requests | Errors | p50 | p95 | max | Dropped | Rules broken |"
  echo "|---|---|---|---|---|---|---|---|---|---|"
  for p in smoke full stress; do
    local n="$svc-$p" load
    case $p in smoke) load="1/s for 30 s" ;; full) load="smoke, then 50/s for 10 min" ;; stress) load="smoke, then 200/s for 10 min" ;; esac
    echo "| $p | $load | $(verdict "$n") | $(m "$n" '.metrics.http_reqs.count') | $(num "$(m "$n" '.metrics.http_req_failed.value * 100')" 2)% | $(num "$(m "$n" '.metrics.http_req_duration.med')") ms | $(num "$(m "$n" '.metrics.http_req_duration["p(95)"]')") ms | $(num "$(m "$n" '.metrics.http_req_duration.max')") ms | $(m "$n" '.metrics.dropped_iterations.count // 0') | $(broken "$n") |"
  done
}

# The staircase tables and the breaking point line for an HTTP service
breakpoint_section() {
  local svc=$1 run good bad
  for run in "$svc-breakpoint" "$svc-breakpoint-fine"; do
    ran "$run" || continue
    echo
    if [[ $run == *-fine ]]; then echo "Finer staircase (levels $(field "$run" 9 | sed 's/.*LEVELS=//')):"; else echo "Staircase (1 min per level):"; fi
    echo
    echo "| Level (req/s) | × peak | Sent | Target | p95 | Errors | Result |"
    echo "|---|---|---|---|---|---|---|"
    level_rows "$run" | sort -t'|' -k1,1n | while IFS='|' read -r lvl n p95 err brk; do
      echo "| $lvl | $(times_peak "$lvl") | $n | $(( lvl * 60 )) | $p95 ms | $err% | $([[ -z $brk ]] && echo ✅ || echo "❌ $brk") |"
    done
  done
  read -r good bad <<<"$(passed_broken "$svc-breakpoint")"
  if ran "$svc-breakpoint-fine"; then
    local g2 b2; read -r g2 b2 <<<"$(passed_broken "$svc-breakpoint-fine")"
    (( g2 > good )) && good=$g2
    (( b2 > 0 && b2 < bad )) && bad=$b2
  fi
  echo
  if (( bad > 0 )); then
    echo "**Breaking point: handled ${good}/s ($(times_peak "$good") peak), broke at ${bad}/s ($(times_peak "$bad") peak).**"
    # Broken only by dropped requests while replies were still fast: the sender ran out, not the service.
    local row; row=$(level_rows "$svc-breakpoint"; ran "$svc-breakpoint-fine" && level_rows "$svc-breakpoint-fine")
    row=$(grep "^$bad|" <<<"$row" | head -1)
    IFS='|' read -r _ _ p95 _ why <<<"$row"
    if [[ "$why" == "k6 dropped"* && "$why" != *,* ]] && awk -v p="$p95" 'BEGIN {exit !(p < 100)}'; then
      echo "At ${bad}/s only dropped requests broke the rules, with p95 still ${p95} ms: k6 or the machine may"
      echo "have been the limit, not the service (test plan D4). Read it as \"at least ${good}/s\"."
    fi
  elif ran "$svc-breakpoint"; then
    echo "**Not broken: handled every level up to ${good}/s ($(times_peak "$good") peak).**"
  fi
}

http_db_check() {
  local svc=$1 p n run sent rows
  echo
  echo "Sent vs database (this run's patients only, \`LOADTEST-<run>-*\`):"
  echo
  echo "| Run | Sent (k6) | Stored by collector | Processed by matcher | Patients enrolled | Enrolments | Result |"
  echo "|---|---|---|---|---|---|---|"
  for p in smoke full stress breakpoint breakpoint-fine; do
    n="$svc-$p"; ran "$n" || continue
    run=$(field "$n" 5); sent=$(m "$n" '.metrics.http_reqs.count')
    rows=$(sql "$run" "SELECT (SELECT count(*) FROM inbound_event_log WHERE raw_payload->>'subject' LIKE :'p'),
                              (SELECT count(*) FROM matcher_event_log WHERE data->'subject'->>'reference' LIKE 'Patient/' || :'p'),
                              (SELECT count(DISTINCT patient_id) FROM protocol_instance WHERE patient_id LIKE :'p'),
                              (SELECT count(*) FROM protocol_instance WHERE patient_id LIKE :'p');")
    IFS='|' read -r stored matched patients enrol <<<"$rows"
    # A run the breakpoint stopped early may have had requests in flight: they can be stored but not counted.
    local ok=❌; [[ "$stored" -ge "$sent" && "$matched" == "$stored" && "$patients" == "$stored" ]] 2>/dev/null && ok=✅
    echo "| $n | $sent | $stored | $matched | $patients | $enrol | $ok |"
  done
  echo
  echo "A breakpoint run is stopped mid-flight: requests k6 cut off can still be stored, so there stored ≥ sent."
}

# --- Write the report ---------------------------------------------------------------------------

declare -A CAPACITY
REPORT="$DIR/REPORT.md"
{
cat <<EOF
# CCE performance round: $ENV_NAME, $(date -d "@$(jq -r .start "$DIR/meta.json")" '+%Y-%m-%d %H:%M %Z')

| | |
|---|---|
| **Environment** | \`$ENV_NAME\` on \`$(jq -r .host "$DIR/meta.json")\` ($(jq -r .cores "$DIR/meta.json") cores) |
| **Code** | cce-load-tests \`$(jq -r .commit "$DIR/meta.json")\` |
| **ACTIVE protocols** | $(jq -r .protocols "$DIR/meta.json" | sed 's/|/ v/g; s/, /<br>/g') |
| **Duration** | $(( ($(jq -r '.end // .start' "$DIR/meta.json") - $(jq -r .start "$DIR/meta.json")) / 60 )) min; machine slept during the round: $(jq -r '.slept // "unknown"' "$DIR/meta.json") times |
| **Expected peak** | $PEAK events/s ("× peak" = a rate ÷ $PEAK) |

**How to read this.** Thresholds are the fixed pass/fail rules in the tests (below); a run passes when it
breaks none. A breaking point is a measurement: the load at which a service stops meeting its rules on
this machine, with these protocols and this much data. It changes with the conditions; the rules don't.
HTTP services (adaptor, collector) break by getting slow or failing; queue services (matcher, Step SLA)
fall behind instead, so their breaking point is their drain rate: any steady load above it piles up.

EOF

# ---- Part 1 ----
P1=$( {
echo "## Part 1: each service on its own"
echo
echo "Each test feeds one service directly, so a limit found is that service's own. Load and stress runs"
echo "start with the 30-second smoke, so their numbers include it."
echo
echo "### 1.1 OpenHIM adaptor (\`adaptor/openhim.js\`: eBUZIMA visit Encounters → adaptor → collector)"
echo
http_table adaptor
breakpoint_section adaptor
(( DB )) && http_db_check adaptor
echo
echo "### 1.2 Collector (\`collector/collector.js\`: CloudEvents straight to the collector)"
echo
http_table collector
breakpoint_section collector
(( DB )) && http_db_check collector
echo
echo "### 1.3 Matcher (\`matcher/matcher.js\`: events written straight to Kafka)"
echo
echo "| Profile | Load | Result | Events sent | Max backlog | Catch-up | Drain rate (median) | Avg per event | Rules broken |"
echo "|---|---|---|---|---|---|---|---|---|"
for p in smoke full stress breakpoint; do
  n="matcher-$p"
  case $p in smoke) load="1/s for 30 s" ;; full) load="smoke, then 50/s for 10 min" ;; stress) load="smoke, then 200/s for 10 min" ;; breakpoint) load="smoke, then 2,000/s for 1 min" ;; esac
  echo "| $p | $load | $(verdict "$n") | $(m "$n" '.metrics.kafka_writer_message_count.count') | $(num "$(m "$n" '.metrics.matcher_backlog.max')" 0) | $(num "$(m "$n" '.metrics.matcher_catch_up_seconds.max')") s | $(num "$(m "$n" '.metrics.matcher_drain_rate.med')" 0)/s | $(num "$(m "$n" '.metrics.matcher_processing_ms.avg')") ms | $(broken "$n") |"
done
cap=$(num "$(m matcher-breakpoint '.metrics.matcher_drain_rate.med')" 0)
echo
if [[ "$cap" != "–" ]]; then
  echo "**Breaking point: ~${cap} events/s ($(times_peak "$cap") peak).** Above that, events pile up in Kafka."
fi
echo "CAPACITY_MATCHER=$cap" >&2
if (( DB )); then
  echo
  echo "Sent vs database:"
  echo
  echo "| Run | Sent to Kafka | Processed | MATCHED | Patients enrolled | Enrolments | Result |"
  echo "|---|---|---|---|---|---|---|"
  for p in smoke full stress breakpoint; do
    n="matcher-$p"; ran "$n" || continue
    sent=$(m "$n" '.metrics.kafka_writer_message_count.count')
    IFS='|' read -r rows matched patients enrol <<<"$(sql "$(field "$n" 5)" "SELECT count(*), count(*) FILTER (WHERE processing_status = 'MATCHED'),
        (SELECT count(DISTINCT patient_id) FROM protocol_instance WHERE patient_id LIKE :'p'),
        (SELECT count(*) FROM protocol_instance WHERE patient_id LIKE :'p')
      FROM matcher_event_log WHERE data->'subject'->>'reference' LIKE 'Patient/' || :'p';")"
    ok=❌; [[ "$rows" == "$sent" && "$matched" == "$sent" && "$patients" == "$sent" ]] && ok=✅
    echo "| $n | $sent | $rows | $matched | $patients | $enrol | $ok |"
  done
fi
echo
echo "### 1.4 Step SLA (\`seed-sla.sh\` + \`step-sla/step-sla.js\` + \`report-sla.sh\`: alarms seeded in the database)"
echo
echo "| Profile | Alarms | Result (wait rule) | Handled | OVERDUE / deviations | Wait avg / p95 / max | Drain rate (median) |"
echo "|---|---|---|---|---|---|---|"
for p in smoke load stress storm; do
  n="step-sla-$p"; r="$DIR/$n-report.txt"
  case $p in smoke) load="30 at 1/s" ;; load) load="30,000 at 50/s" ;; stress) load="120,000 at 200/s" ;; storm) load="100,000 at once" ;; esac
  if [[ -f "$r" ]]; then
    res=$(grep -E '^\s*(PASS|FAIL)' "$r" | xargs); rule=$(grep -o 'rule: [^)]*' "$r")
    handled=$(sed -n 's/^\s*handled\s*//p' "$r" | xargs)
    od=$(sed -n 's/^\s*OVERDUE steps\s*\([0-9]*\),\s*deviations\s*\([0-9]*\).*/\1 \/ \2/p' "$r")
    wait=$(sed -n 's/^\s*wait after ringing: avg \([^,]*\), p95 \([^,]*\), max \([^ ]* s\).*/\1 \/ \2 \/ \3/p' "$r")
    [[ $res == PASS ]] && res="✅ PASS ($rule)" || res="❌ ${res:-no verdict} ($rule)"
  else
    res=$(verdict "$n"); handled="–"; od="–"; wait="–"
  fi
  echo "| $p | $load | $res | $handled | $od | $wait | $(num "$(m "$n" '.metrics.step_sla_drain_rate.med')" 0)/s |"
done
cap=$(num "$(m step-sla-storm '.metrics.step_sla_drain_rate.med')" 0)
echo
[[ "$cap" != "–" ]] && echo "**Breaking point: ~${cap} alarms/s ($(times_peak "$cap") peak).** Above that rate of alarms ringing, Step SLA falls behind."
echo "CAPACITY_STEPSLA=$cap" >&2
} 2>"$DIR/.capacities" )
echo "$P1"
CAPACITY_MATCHER=$(sed -n 's/^CAPACITY_MATCHER=//p' "$DIR/.capacities"); CAPACITY_STEPSLA=$(sed -n 's/^CAPACITY_STEPSLA=//p' "$DIR/.capacities")
rm -f "$DIR/.capacities"
for svc in adaptor collector; do
  read -r good bad <<<"$(passed_broken "$svc-breakpoint")"
  if ran "$svc-breakpoint-fine"; then read -r g2 b2 <<<"$(passed_broken "$svc-breakpoint-fine")"; (( g2 > good )) && good=$g2; (( b2 > 0 && b2 < bad )) && bad=$b2; fi
  CAPACITY[$svc]="$good $bad"
done

# ---- Part 2 ----
echo
echo "## Part 2: the whole eBUZIMA journey (\`flow.sh\` → \`flow/ebuzima-flow.js\`)"
echo
echo "Patients walk the eBUZIMA protocol through the adaptor, as eBUZIMA would: adaptor → collector → Kafka →"
echo "matcher → Step SLA. Each run's own report has every check; the time at each stage is below."
echo
echo "| Profile | Load | Result | Checks passed | Load (k6) | Checks failed | Report |"
echo "|---|---|---|---|---|---|---|"
for p in smoke full stress; do
  n="flow-$p"; rep="$(field "$n" 9)/report.md"
  case $p in smoke) load="~7 events/s for 30 s" ;; full) load="smoke, then ~51 events/s for 10 min" ;; stress) load="smoke, then ~197 events/s for 10 min" ;; esac
  if [[ -f "$rep" ]]; then
    okc=$(grep -c '^| ✅ |' "$rep"); bad=$(grep -c '^| ❌ |' "$rep")
    k6line=$(grep '^| [✅❌] | k6 thresholds' "$rep" | awk -F'|' '{print $4}' | xargs)
    failed=$(grep '^| ❌ |' "$rep" | awk -F'|' '{print $3}' | xargs | sed 's/ *$//'); failed=${failed:-–}
    echo "| $p | $load | $(grep -o '\*\*Overall:\*\* .*' "$rep" | sed 's/\*\*Overall:\*\* //') | $okc of $((okc + bad)) | $k6line | $failed | \`$(field "$n" 9)/\` |"
  else
    echo "| $p | $load | $(verdict "$n") | – | – | – | – |"
  fi
done
echo
echo "Time at each stage, p95:"
echo
echo "| Stage | smoke | full | stress |"
echo "|---|---|---|---|"
for stage in "Adaptor + collector" "Waiting in Kafka" "Matcher processing" "Collector stored → matcher done" "Matcher scheduled MET"; do
  row="| $(grep -h "^| $stage" "$(field flow-smoke 9)/report.md" "$(field flow-full 9)/report.md" "$(field flow-stress 9)/report.md" 2>/dev/null | head -1 | awk -F'|' '{print $2}' | xargs) |"
  for p in smoke full stress; do
    row+=" $(grep -h "^| $stage" "$(field "flow-$p" 9)/report.md" 2>/dev/null | awk -F'|' '{print $4}' | xargs) |"
  done
  echo "$row"
done

# ---- Summary (written last, placed after the header) ----
} > "$REPORT.body"

{
sed -n '1,/^fall behind instead/p' "$REPORT.body"
echo
echo "## Summary"
echo
echo "| Service | Smoke | Load (50/s) | Stress (200/s) | Breaking point | × peak |"
echo "|---|---|---|---|---|---|"
for svc in adaptor collector; do
  read -r good bad <<<"${CAPACITY[$svc]}"
  bp="handled ${good}/s$( (( bad > 0 )) && echo ", broke at ${bad}/s" || echo ", not broken")"
  xp=$(times_peak "$good")
  ran "$svc-breakpoint" || { bp="– (not run)"; xp="–"; }
  echo "| ${svc^} | $(verdict "$svc-smoke") | $(verdict "$svc-full") | $(verdict "$svc-stress") | $bp | $xp |"
done
echo "| Matcher | $(verdict matcher-smoke) | $(verdict matcher-full) | $(verdict matcher-stress) | $([[ "$CAPACITY_MATCHER" =~ ^[0-9]+$ ]] && echo "~${CAPACITY_MATCHER} events/s" || echo "– (not run)") | $(times_peak "$CAPACITY_MATCHER") |"
sla() { [[ -f "$DIR/step-sla-$1-report.txt" ]] && { grep -qE '^\s*PASS' "$DIR/step-sla-$1-report.txt" && echo "✅ PASS" || echo "❌ FAIL"; } || verdict "step-sla-$1"; }
echo "| Step SLA | $(sla smoke) | $(sla load) | $(sla stress) | $([[ "$CAPACITY_STEPSLA" =~ ^[0-9]+$ ]] && echo "~${CAPACITY_STEPSLA} alarms/s (storm: $(sla storm))" || echo "– (not run)") | $(times_peak "$CAPACITY_STEPSLA") |"
echo "| **Whole journey** (flow) | $(verdict flow-smoke) | $(verdict flow-full) | $(verdict flow-stress) | the weakest service's | |"
# The weakest link among the services every event passes through (events/s).
weakest=""; wname=""
for svc in adaptor collector; do read -r good _ <<<"${CAPACITY[$svc]}"; [[ "$good" =~ ^[0-9]+$ ]] && (( good > 0 )) && { [[ -z $weakest ]] || (( good < weakest )); } && { weakest=$good; wname=$svc; }; done
if [[ "$CAPACITY_MATCHER" =~ ^[0-9]+$ ]] && { [[ -z $weakest ]] || (( CAPACITY_MATCHER < weakest )); }; then weakest=$CAPACITY_MATCHER; wname=matcher; fi
echo
if [[ -n $weakest ]]; then
  echo "**Weakest link: the $wname, ~${weakest} events/s ($(times_peak "$weakest") the peak).** The whole journey can't go faster"
  echo "than its slowest service. Flow stress sends ~${FLOW_RATE[stress]} events/s, so it is expected to"
  if (( weakest < FLOW_RATE[stress] )); then echo "**fall behind** (the $wname can't keep up) and"; else echo "keep up and"; fi
  echo "it $(case "$(field flow-stress 8)" in 0) echo "**passed**";; "") echo "was **not run**";; *) echo "**failed**";; esac)."
  echo
fi
echo "Step SLA is measured in alarms/s, not events/s: how many alarms an event creates depends on the"
echo "ACTIVE protocols' mandatory steps."
echo
sed -n '/^## Part 1/,$p' "$REPORT.body"
cat <<EOF

## Thresholds used (the fixed rules)

| Test | Rules |
|---|---|
| Adaptor, collector, flow (k6, \`lib/load.js\`) | p95 < 500 ms · < 1% errors · > 99% checks · 0 dropped; smoke stops the run if its checks fail |
| Breakpoint staircase (\`lib/breakpoint.js\`) | the same rules, judged per level; stops at the first broken level, or after 1,000 dropped |
| Matcher (\`matcher/matcher.js\`) | 0 Kafka errors · 0 dropped · backlog < 1,000 · catch-up < 30 s (load and stress; the flood is meant to pile up) |
| Step SLA (\`step-sla/step-sla.js\`, \`report-sla.sh\`) | every alarm handled · each wait < 2 polls (storm: < 300 s) · each step OVERDUE with one deviation |
| Flow (\`flow.sh\`) | the k6 rules, plus every event stored, matched and completed once, the matcher caught up within 30 s, Step SLA verdicts and deviations correct |

## Notes

- Raw files: \`$DIR/\` (per run: k6 log, JSON summary, resource samples; \`runs.tsv\`, \`progress.log\`).
- The test data is still in the database: \`DB_PASSWORD=<password> ./cleanup.sh $ENV_NAME\`. Run it before
  the next day: the test patients' deadlines are 1–2 days out, and their alarms would all ring together.
$( (( DB )) || echo "- No database counts: run with DB_PASSWORD set (before cleanup.sh) to add them.")
EOF
} > "$REPORT"
rm -f "$REPORT.body"
cat "$REPORT"
