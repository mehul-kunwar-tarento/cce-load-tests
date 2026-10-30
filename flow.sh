#!/usr/bin/env bash
# eBUZIMA flow test: adaptor → collector → Kafka → matcher → Step SLA, against the eBUZIMA protocol
# (protocol/emr-service-protocol.json), with one report at the end.
#
#   1. Pre-flight: every service healthy; the eBUZIMA protocol ACTIVE in the protocol service; lists
#      other ACTIVE protocols (they may enrol the same patients: see protocol-setup.sh).
#   2. Contract: one eBUZIMA visit Encounter through the adaptor; checks the CloudEvent it forwards
#      and the collector's answer.
#   3. Load: flow/ebuzima-flow.js sends patient journeys (smoke, full = smoke + load, or stress)
#      while monitor.sh samples every service's resources.
#   4. Downstream, from the database, for this run's patients only:
#      collector  every event the adaptor accepted is stored
#      matcher    every stored event processed, patients enrolled in the eBUZIMA protocol, and each
#                 step completed once per event sent for it; how long events waited and took
#      Step SLA   live: the MET verdicts the matcher scheduled are applied
#                 pulled: the protocol's deadlines are 1–2 days out, so the run's open DUE alarms are
#                 brought forward to now; every one must be applied, and an OVERDUE deviation recorded
#                 for each step still not done
#   5. Report: results/flow-<profile>-<run>/report.md, also printed. Exits 1 if anything failed.
#
# Run: DB_PASSWORD=<password> ./flow.sh <env> [smoke|full|stress]      (default smoke)
# Needs: docker, curl, jq. Run it on the services' server (monitor.sh reads docker stats there).
# All data is LOADTEST-<run>- data: DB_PASSWORD=<password> ./cleanup.sh <env> deletes it.
set -euo pipefail

ENV_NAME=${1:-}
PROFILE=${2:-smoke}
cd "$(dirname "$0")"
source lib/db.sh
db_init "$ENV_NAME" "DB_PASSWORD=<password> $0 <env> [smoke|full|stress]"
if [[ ! "$PROFILE" =~ ^(smoke|full|stress)$ ]]; then
  echo "Profile must be smoke, full or stress, not $PROFILE" >&2
  exit 1
fi

cfg() { jq -r "$1" "$CONFIG"; }
ADAPTOR_URL=$(cfg .openhimAdaptor.baseUrl)
CLIENT_ID=$(cfg .openhimAdaptor.clientId)
FACILITY=$(cfg .openhimAdaptor.facilityId)
COLLECTOR_URL=$(cfg .collector.baseUrl)
MATCHER_URL=$(cfg .matcher.metricsUrl); MATCHER_URL=${MATCHER_URL%/actuator/prometheus}
STEP_SLA_URL=$(cfg .stepSla.metricsUrl); STEP_SLA_URL=${STEP_SLA_URL%/actuator/prometheus}
POLL=$(cfg .stepSla.pollIntervalSeconds)
PROTOCOL_API="$(cfg .protocol.baseUrl)/v1/protocol/protocol-definitions"
PROTOCOL=$(cfg .protocol.url)
PROTOCOL_VERSION=$(cfg .protocol.version)

RUN_ID=$(date +%m%d%H%M%S)
PREFIX="LOADTEST-${RUN_ID}-"
OUT="results/flow-${PROFILE}-${RUN_ID}"
mkdir -p "$OUT"
FAILED=0
ROWS=""      # report rows: | result | check | detail |
WARNINGS=""

ok()   { ROWS+="| ✅ | $1 | $2 |"$'\n'; echo "  ✅ $1: $2"; }
fail() { ROWS+="| ❌ | $1 | $2 |"$'\n'; echo "  ❌ $1: $2"; FAILED=1; }
check() { if [[ "$2" == true ]]; then ok "$1" "$3"; else fail "$1" "$3"; fi; }
section() { ROWS+="| | **$1** | |"$'\n'; echo; echo "== $1"; }
# sql -c "<query>": one query, rows as a|b|c. The query goes in on stdin, because psql fills in
# :'prefix' and :'url' only there, not in -c.
sql() { run_psql -tA -F'|' -v prefix="${PREFIX}%" -v url="$PROTOCOL" <<<"$2"; }

echo "eBUZIMA flow test   env: $ENV_NAME   profile: $PROFILE   run: $RUN_ID   output: $OUT"

# ---------------------------------------------------------------------------------------------
# 1. Pre-flight
# ---------------------------------------------------------------------------------------------
section "1. Pre-flight"
for svc in "adaptor $ADAPTOR_URL" "collector $COLLECTOR_URL" "matcher $MATCHER_URL" \
           "step-sla $STEP_SLA_URL" "protocol $(cfg .protocol.baseUrl)"; do
  read -r name url <<<"$svc"
  health=$(curl -s -m 5 "$url/actuator/health" | jq -r .status 2>/dev/null || true)
  check "$name healthy" "$([[ "$health" == UP ]] && echo true || echo false)" "$url → ${health:-no answer}"
done
STATUS=$(curl -s -m 5 "$PROTOCOL_API/by-url-version?url=$PROTOCOL&version=$PROTOCOL_VERSION" | jq -r '.status // "missing"' 2>/dev/null || echo missing)
check "eBUZIMA protocol ACTIVE" "$([[ $STATUS == ACTIVE ]] && echo true || echo false)" \
  "$PROTOCOL|$PROTOCOL_VERSION is $STATUS$([[ $STATUS == ACTIVE ]] || echo ': run ./protocol-setup.sh')"
OTHERS=$(curl -s -m 5 "$PROTOCOL_API?size=200" | jq -r --arg url "$PROTOCOL" \
  '[.content[] | select(.status == "ACTIVE" and .url != $url) | .canonical] | join(", ")' 2>/dev/null || true)
if [[ -n "$OTHERS" ]]; then
  WARNINGS+="- Other ACTIVE protocols may also enrol these patients, adding matcher and Step SLA work eBUZIMA wouldn't cause: $OTHERS. Retire them with \`./protocol-setup.sh $ENV_NAME --retire-others\`."$'\n'
  echo "  ⚠️  other ACTIVE protocols: $OTHERS"
fi
if [[ $FAILED == 1 ]]; then
  echo "Pre-flight failed; nothing sent." >&2
fi

# ---------------------------------------------------------------------------------------------
# 2. Contract: one eBUZIMA visit through the adaptor
# ---------------------------------------------------------------------------------------------
if [[ $FAILED == 0 ]]; then
  section "2. Contract (one eBUZIMA visit Encounter)"
  PATIENT="${PREFIX}contract-0"
  NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  ENCOUNTER=$(jq -n --arg p "$PATIENT" --arg now "$NOW" --arg f "$FACILITY" '{
    resourceType: "Encounter", id: "\($p)-visit-encounter", status: "finished",
    class: {system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB", display: "ambulatory"},
    type: [{coding: [{display: "VISIT_ENCOUNTER"}]}],
    subject: {reference: "Patient/\($p)"}, period: {start: $now, end: $now},
    hospitalization: {origin: {reference: "Location/\($f)"}}}')
  R="$OUT/contract-response.json"
  HTTP=$(curl -s -m 30 -o "$R" -w '%{http_code} %{time_total}' -X POST "$ADAPTOR_URL/inbound" \
    -H 'Content-Type: application/json' -H "X-OpenHIM-ClientID: $CLIENT_ID" -H "X-Facility-Id: $FACILITY" \
    -H "X-Source-Event-Id: $PATIENT-visit-encounter" -d "$ENCOUNTER" || echo "000 0")
  check "Adaptor answers 202" "$([[ ${HTTP% *} == 202 ]] && echo true || echo false)" "HTTP ${HTTP% *} in ${HTTP#* }s"
  if [[ ${HTTP% *} == 202 ]]; then
    RESULT=$(jq -r .response.body "$R"); SENT=$(jq -r '.orchestrations[0].request.body' "$R")
    REPLY=$(jq -r '.orchestrations[0].response.body' "$R")
    jq -n --argjson e "$SENT" '$e' > "$OUT/contract-cloudevent.json"
    v() { jq -r "$1" <<<"$2"; }
    is() { [[ "$1" == "$2" ]] && echo true || echo false; }
    check "Collector accepted it" "$(is "$(v '.events[0].collectorStatus' "$RESULT")" accepted)" "collectorStatus=$(v '.events[0].collectorStatus' "$RESULT")"
    check "CloudEvent specversion 1.0, source ebuzima" "$(is "$(v '"\(.specversion) \(.source)"' "$SENT")" "1.0 ebuzima")" "$(v '"\(.specversion) \(.source)"' "$SENT")"
    check "type = Encounter, subject = the UPID" "$(is "$(v '"\(.type) \(.subject)"' "$SENT")" "Encounter $PATIENT")" "$(v '"\(.type) \(.subject)"' "$SENT")"
    check "facilityid from X-Facility-Id" "$(is "$(v .facilityid "$SENT")" "$FACILITY")" "$(v .facilityid "$SENT")"
    check "Encounter type display kept (the matcher needs it)" "$(is "$(v '.data.type[0].coding[0].display' "$SENT")" VISIT_ENCOUNTER)" "$(v '.data.type[0].coding[0].display' "$SENT")"
    check "hospitalization.origin kept (facility attribution)" "$(is "$(v '.data.hospitalization.origin.reference' "$SENT")" "Location/$FACILITY")" "$(v '.data.hospitalization.origin.reference' "$SENT")"
    check "Correlation ID reaches the collector" \
      "$(is "$(v .correlationid "$SENT")" "$(v .data.correlationId "$REPLY")")" "$(v .correlationid "$SENT")"
  fi
fi

# ---------------------------------------------------------------------------------------------
# 3. Load, with resource sampling alongside
# ---------------------------------------------------------------------------------------------
K6_EXIT=""
if [[ $FAILED == 0 ]]; then
  section "3. Load: flow/ebuzima-flow.js ($PROFILE)"
  ./monitor.sh "$ENV_NAME" "$OUT/resources.tsv" 5 2>/dev/null &
  MONITOR=$!
  trap 'kill $MONITOR 2>/dev/null || true' EXIT
  set +e
  ./run.sh "$ENV_NAME" flow/ebuzima-flow.js -e RUN_ID="$RUN_ID" -e PROFILE="$PROFILE" --no-color --quiet \
    --summary-export "$OUT/k6.json" 2>&1 | tee "$OUT/k6.log" | grep -E '^\s+[✓✗]|http_req_duration\.\.|http_reqs\.|level=(error|warn)'
  K6_EXIT=${PIPESTATUS[0]}
  set -e
  LOAD_END=$(date +%s)
  k6m() { jq -r "$1 // 0" "$OUT/k6.json" 2>/dev/null || echo 0; }
  SENT_OK=$(( $(k6m .metrics.http_reqs.count) - $(k6m .metrics.http_req_failed.passes) ))
  check "k6 thresholds (p95 < 500 ms, < 1% errors, > 99% checks, none dropped)" \
    "$([[ $K6_EXIT == 0 ]] && echo true || echo false)" "k6 exit $K6_EXIT; $(k6m .metrics.http_reqs.count) events, p95 $(k6m '.metrics.http_req_duration["p(95)"]' | xargs printf '%.1f') ms"
fi

# ---------------------------------------------------------------------------------------------
# 4. Downstream, from the database
# ---------------------------------------------------------------------------------------------
if [[ -n "$K6_EXIT" ]]; then
  section "4a. Collector and matcher"
  # Every event the adaptor accepted, plus the contract event.
  EXPECTED=$(( SENT_OK + 1 ))
  STORED=$(sql -c "SELECT count(*) FROM inbound_event_log WHERE raw_payload->>'subject' LIKE :'prefix' AND status = 'ACCEPTED'")
  check "Collector stored every accepted event" "$([[ $STORED == "$EXPECTED" ]] && echo true || echo false)" "$STORED of $EXPECTED"

  # Wait for the matcher to process them all: stop when done, or after 60 s without progress.
  echo "  waiting for the matcher..."
  LAST=-1; IDLE=0
  while true; do
    DONE=$(sql -c "SELECT count(*) FROM matcher_event_log m JOIN inbound_event_log i USING (cloudevents_id, source)
                   WHERE i.raw_payload->>'subject' LIKE :'prefix' AND m.processing_status <> 'RECEIVED'")
    (( DONE >= STORED )) && break
    if (( DONE == LAST )); then IDLE=$(( IDLE + 5 )); else IDLE=0; fi
    (( IDLE >= 60 )) && break
    LAST=$DONE; sleep 5
  done
  CATCH_UP=$(( $(date +%s) - LOAD_END ))
  check "Matcher processed every event" "$([[ $DONE == "$STORED" ]] && echo true || echo false)" \
    "$DONE of $STORED; $(sql -c "SELECT string_agg(processing_status || ' ' || n, ', ') FROM (SELECT m.processing_status, count(*) n
      FROM matcher_event_log m JOIN inbound_event_log i USING (cloudevents_id, source)
      WHERE i.raw_payload->>'subject' LIKE :'prefix' GROUP BY 1) s")"
  check "Matcher caught up within 30 s of the load ending" "$([[ $CATCH_UP -le 30 ]] && echo true || echo false)" "${CATCH_UP} s"

  # Patients, enrolments, and each step completed once per event sent for it (resource id = <patient>-<step>).
  read -r PATIENTS ENROLLED OTHER_ENROL <<<"$(sql -c "
    SELECT (SELECT count(DISTINCT raw_payload->>'subject') FROM inbound_event_log WHERE raw_payload->>'subject' LIKE :'prefix'),
           count(*) FILTER (WHERE d.url = :'url'), count(*) FILTER (WHERE d.url <> :'url')
    FROM protocol_instance p JOIN protocol_definition d ON d.id = p.protocol_definition_id
    WHERE p.patient_id LIKE :'prefix'" | tr '|' ' ')"
  check "Every patient enrolled in the eBUZIMA protocol" "$([[ $ENROLLED == "$PATIENTS" ]] && echo true || echo false)" "$ENROLLED of $PATIENTS"
  if (( OTHER_ENROL > 0 )); then
    WARNINGS+="- The same patients also got $OTHER_ENROL enrolments in other protocols (see pre-flight)."$'\n'
  fi
  STEP_TABLE=$(sql -c "
    WITH sent AS (
      SELECT substr(raw_payload->'data'->>'id', length(raw_payload->>'subject') + 2) AS step, count(*) AS n
      FROM inbound_event_log WHERE raw_payload->>'subject' LIKE :'prefix' GROUP BY 1),
    done AS (
      SELECT s.action_id AS step, count(*) FILTER (WHERE s.step_status = 'COMPLETED') AS n,
             count(*) FILTER (WHERE s.step_status <> 'COMPLETED') AS open
      FROM step_instance s JOIN protocol_instance p ON p.id = s.protocol_instance_id
      JOIN protocol_definition d ON d.id = p.protocol_definition_id
      WHERE p.patient_id LIKE :'prefix' AND d.url = :'url' GROUP BY 1)
    SELECT coalesce(sent.step, done.step), coalesce(sent.n, 0), coalesce(done.n, 0), coalesce(done.open, 0)
    FROM sent FULL JOIN done USING (step) ORDER BY 1")
  echo "$STEP_TABLE" > "$OUT/steps.txt"
  MISMATCH=$(awk -F'|' '$2 != $3 { printf "%s%s sent %s, completed %s", sep, $1, $2, $3; sep = "; " }' <<<"$STEP_TABLE")
  check "Each step completed once per event sent for it" "$([[ -z "$MISMATCH" ]] && echo true || echo false)" \
    "${MISMATCH:-$(awk -F'|' '{ s += $3 } END { print s " steps completed across " NR " step types" }' <<<"$STEP_TABLE")}"

  # How long events waited in Kafka and took in the matcher, in ms: p50 / p95 / p99 / max.
  pct() { sql -c "SELECT concat_ws(' / ', round(percentile_cont(0.5) WITHIN GROUP (ORDER BY x)::numeric, 1),
      round(percentile_cont(0.95) WITHIN GROUP (ORDER BY x)::numeric, 1), round(percentile_cont(0.99) WITHIN GROUP (ORDER BY x)::numeric, 1),
      round(max(x)::numeric, 1)) FROM ($1) t"; }
  JOIN_RUN="FROM matcher_event_log m JOIN inbound_event_log i USING (cloudevents_id, source) WHERE i.raw_payload->>'subject' LIKE :'prefix'"
  KAFKA_WAIT=$(pct "SELECT extract(epoch FROM m.received_at - i.received_at) * 1000 AS x $JOIN_RUN")
  MATCH_TIME=$(pct "SELECT extract(epoch FROM m.updated_at - m.received_at) * 1000 AS x $JOIN_RUN")
  COLLECTOR_TO_MATCHED=$(pct "SELECT extract(epoch FROM m.updated_at - i.received_at) * 1000 AS x $JOIN_RUN")

  section "4b. Step SLA"
  RUN_ROWS="FROM step_sla_state_transition t JOIN step_instance s ON s.id = t.step_instance_id
            JOIN protocol_instance p ON p.id = s.protocol_instance_id JOIN protocol_definition d ON d.id = p.protocol_definition_id
            WHERE p.patient_id LIKE :'prefix' AND d.url = :'url'"
  # Live: the MET verdicts the matcher scheduled for steps done on time are due at once.
  for _ in $(seq 1 24); do
    MET_OPEN=$(sql -c "SELECT count(*) $RUN_ROWS AND t.transition_type = 'MET_CONDITION_REACHED' AND NOT t.is_processed")
    (( MET_OPEN == 0 )) && break; sleep 5
  done
  read -r MET_DONE MET_STEPS <<<"$(sql -c "SELECT count(*) FILTER (WHERE t.is_processed), count(*) FILTER (WHERE t.is_processed AND s.sla_status = 'MET')
    $RUN_ROWS AND t.transition_type = 'MET_CONDITION_REACHED'" | tr '|' ' ')"
  check "Step SLA applied every MET verdict the matcher scheduled" "$([[ $MET_OPEN == 0 ]] && echo true || echo false)" \
    "$MET_DONE applied ($MET_STEPS steps now MET), $MET_OPEN waiting"
  MET_DELAY=$(pct "SELECT extract(epoch FROM t.processed_at - t.created_at) * 1000 AS x $RUN_ROWS AND t.transition_type = 'MET_CONDITION_REACHED' AND t.is_processed")

  # Pulled: bring the run's open DUE alarms forward to now, so Step SLA judges them during the test.
  # Step SLA fetches a row once both next_attempt_at and process_by have passed, so both move. The
  # verdict doesn't change: a step not done is OVERDUE whatever the deadline, and a step done was done
  # before now, so it still counts as on time.
  read -r PULLED EXPECT_OVERDUE PULL_AT <<<"$(sql -c "
    WITH pulled AS (
      UPDATE step_sla_state_transition t SET next_attempt_at = now(), process_by = now()
      FROM step_instance s, protocol_instance p, protocol_definition d
      WHERE s.id = t.step_instance_id AND p.id = s.protocol_instance_id AND d.id = p.protocol_definition_id
        AND p.patient_id LIKE :'prefix' AND d.url = :'url'
        AND t.transition_type = 'DUE_DATE_REACHED' AND NOT t.is_processed
      RETURNING s.step_status)
    SELECT count(*), count(*) FILTER (WHERE step_status <> 'COMPLETED'), extract(epoch FROM now()) FROM pulled" | tr '|' ' ')"
  echo "  brought $PULLED DUE alarms forward ($EXPECT_OVERDUE on steps not done); waiting for Step SLA..."
  for _ in $(seq 1 60); do
    DUE_OPEN=$(sql -c "SELECT count(*) $RUN_ROWS AND t.transition_type = 'DUE_DATE_REACHED' AND NOT t.is_processed")
    (( DUE_OPEN == 0 )) && break; sleep 2
  done
  DUE_DONE_IN=$(sql -c "SELECT coalesce(round(extract(epoch FROM max(t.processed_at)) - $PULL_AT, 1)::text, 'never')
    $RUN_ROWS AND t.transition_type = 'DUE_DATE_REACHED' AND t.is_processed AND t.processed_at >= to_timestamp($PULL_AT)")
  OVERDUE=$(sql -c "SELECT count(*) FROM deviation v JOIN step_instance s ON s.id = v.step_instance_id
    JOIN protocol_instance p ON p.id = s.protocol_instance_id JOIN protocol_definition d ON d.id = p.protocol_definition_id
    WHERE p.patient_id LIKE :'prefix' AND d.url = :'url' AND v.deviation_type = 'OVERDUE'")
  LIMIT=$(( POLL * 2 + 5 ))
  check "Step SLA applied every DUE alarm brought forward" "$([[ $DUE_OPEN == 0 ]] && echo true || echo false)" \
    "$(( PULLED - DUE_OPEN )) of $PULLED"
  check "All applied within $LIMIT s (2 poll intervals + 5 s)" \
    "$(awk -v t="$DUE_DONE_IN" -v l="$LIMIT" -v open="$DUE_OPEN" 'BEGIN { print (open == 0 && t != "never" && t <= l) ? "true" : "false" }')" "${DUE_DONE_IN} s"
  check "An OVERDUE deviation for each step not done" "$([[ $OVERDUE == "$EXPECT_OVERDUE" ]] && echo true || echo false)" \
    "$OVERDUE deviations, $EXPECT_OVERDUE expected"
fi

# ---------------------------------------------------------------------------------------------
# 5. Report
# ---------------------------------------------------------------------------------------------
kill "${MONITOR:-}" 2>/dev/null || true
k6t() { jq -r --arg m "$1" --arg s "$2" '.metrics[$m][$s] // empty | . * 10 | round / 10' "$OUT/k6.json" 2>/dev/null; }
{
  echo "# eBUZIMA flow report"
  echo
  echo "- **When:** $(date '+%Y-%m-%d %H:%M %Z')   **Run:** \`$RUN_ID\` (patients \`${PREFIX}*\`)"
  echo "- **Environment:** \`$ENV_NAME\`   **Profile:** \`$PROFILE\`"
  echo "- **Protocol:** $PROTOCOL|$PROTOCOL_VERSION"
  echo "- **Overall:** $([[ $FAILED == 0 ]] && echo '✅ PASS' || echo '❌ FAIL')"
  if [[ -n "$WARNINGS" ]]; then echo; echo "**Warnings**"; echo; echo -n "$WARNINGS"; fi
  echo
  echo "## Checks"
  echo
  echo "| | Check | Detail |"
  echo "|---|---|---|"
  echo -n "$ROWS"
  if [[ -f "$OUT/k6.json" ]]; then
    echo
    echo "## Timings"
    echo
    echo "| Stage | p50 | p95 | p99 | max |"
    echo "|---|---|---|---|---|"
    echo "| Adaptor + collector (HTTP reply, ms) | $(k6t http_req_duration med) | $(k6t http_req_duration 'p(95)') | $(k6t http_req_duration 'p(99)') | $(k6t http_req_duration max) |"
    for row in "Waiting in Kafka (collector stored → matcher picked up, ms)|$KAFKA_WAIT" \
               "Matcher processing (ms)|$MATCH_TIME" \
               "Collector stored → matcher done (ms)|$COLLECTOR_TO_MATCHED" \
               "Matcher scheduled MET → Step SLA applied (ms)|$MET_DELAY"; do
      echo "| ${row%%|*} | $(sed 's| / | \| |g' <<<"${row#*|}") |"
    done
    echo
    echo "Matcher caught up ${CATCH_UP} s after the load ended. Step SLA applied $PULLED brought-forward DUE alarms within ${DUE_DONE_IN} s (it polls every ${POLL} s)."
    echo
    echo "### Adaptor + collector by step (ms)"
    echo
    echo "| Step | Sent | Completed | Still open | p95 |"
    echo "|---|---|---|---|---|"
    while IFS='|' read -r step sent done open; do
      echo "| $step | $sent | $done | $open | $(jq -r --arg k "http_req_duration{step:$step}" '.metrics[$k]["p(95)"] // empty | . * 10 | round / 10' "$OUT/k6.json") |"
    done < "$OUT/steps.txt"
  fi
  if [[ -s "$OUT/resources.tsv" ]]; then
    echo
    echo "## Resources (sampled every 5 s)"
    echo
    ./monitor.sh --summary "$OUT/resources.tsv" | grep -E '^\|( Source|---|.*(heap_after_gc|gc_pause_max|threads_live|db_pool_active|db_pool_pending|db_timeouts|kafka_errors|consumer_errors|event_max|transitions_due|batches_failed|container_cpu|container_mem|disk_write|connections_active))'
    echo
    echo "All samples: \`resources.tsv\`; full table: \`./monitor.sh --summary $OUT/resources.tsv\`."
  fi
  echo
  echo "## Files"
  echo
  echo "In \`$OUT/\`: k6 log and JSON summary, the contract exchange, per-step counts, resource samples."
  echo "This run's data is \`${PREFIX}\` data: \`DB_PASSWORD=<password> ./cleanup.sh $ENV_NAME\` deletes it."
} > "$OUT/report.md"

echo; echo "================================================================"
cat "$OUT/report.md"
exit $FAILED
