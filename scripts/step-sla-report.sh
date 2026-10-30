#!/usr/bin/env bash
# Pass/fail for the Step SLA test, from the database: how long each seeded alarm waited between ringing
# (process_by) and Step SLA handling it (processed_at). That wait is what a patient's record feels,
# and it doesn't depend on when anyone looks, unlike a count of alarms waiting.
#
#   smoke/load/stress  pass: every alarm handled, longest wait < 2 check intervals
#                      (stepSla.pollIntervalSeconds: 5 s locally, 15 s on prod)
#   storm              pass: every alarm handled, longest wait < 300 s (all 100,000 due at once)
# Also checks each alarm's step became OVERDUE with one deviation.
#
# Run after step-sla/step-sla.js ends: DB_PASSWORD=<password> ./scripts/step-sla-report.sh <env>
# Exits 1 on FAIL. Run it before scripts/cleanup-test-data.sh, which deletes the rows it reads.
set -euo pipefail

ENV_NAME=${1:-}
cd "$(dirname "$0")/.."   # the repo root: env/, results/, step-sla/ are relative to it
source scripts/postgres-connection.sh
db_init "$ENV_NAME" "DB_PASSWORD=<password> $0 <env>"

SEED=step-sla/last-seed.json
if [[ ! -f "$SEED" || "$(jq -r .env "$SEED")" != "$ENV_NAME" ]]; then
  echo "No seed for $ENV_NAME in $SEED: run scripts/step-sla-seed.sh first." >&2
  exit 1
fi
PROFILE=$(jq -r .profile "$SEED")
COUNT=$(jq -r .count "$SEED")
RUN_ID=$(jq -r .runId "$SEED")
POLL=$(jq -r .stepSla.pollIntervalSeconds "$CONFIG")
if [[ "$PROFILE" == "storm" ]]; then MAX_WAIT=300; else MAX_WAIT=$(( 2 * POLL )); fi

# handled | OVERDUE steps | deviations | wait avg | p95 | max (seconds), for this run's patients only
RESULT=$(run_psql -tA -v prefix="LOADTEST-SLA-${RUN_ID}-%" <<'SQL'
WITH alarm AS (
  SELECT t.is_processed, s.sla_status, s.id AS step_id,
         extract(epoch FROM t.processed_at - t.process_by) AS wait
  FROM protocol_instance p
  JOIN step_instance s ON s.protocol_instance_id = p.id
  JOIN step_sla_state_transition t ON t.step_instance_id = s.id AND t.transition_type = 'DUE_DATE_REACHED'
  WHERE p.patient_id LIKE :'prefix'
)
SELECT count(*) FILTER (WHERE is_processed),
       count(*) FILTER (WHERE sla_status = 'OVERDUE'),
       (SELECT count(*) FROM deviation d WHERE d.step_instance_id IN (SELECT step_id FROM alarm)),
       round(avg(wait)::numeric, 1),
       round((percentile_cont(0.95) WITHIN GROUP (ORDER BY wait))::numeric, 1),
       round(max(wait)::numeric, 1)
FROM alarm;
SQL
)
IFS='|' read -r HANDLED OVERDUE DEVIATIONS AVG P95 MAX <<< "$RESULT"

echo "Step SLA report: $PROFILE, $COUNT alarms (run $RUN_ID, env $ENV_NAME)"
echo "  handled        $HANDLED / $COUNT"
echo "  OVERDUE steps  $OVERDUE,  deviations $DEVIATIONS"
echo "  wait after ringing: avg ${AVG:-?} s, p95 ${P95:-?} s, max ${MAX:-?} s   (rule: max < $MAX_WAIT s)"

PASS=true
[[ "$HANDLED" == "$COUNT" ]] || { echo "  FAIL: not every alarm was handled"; PASS=false; }
[[ "$OVERDUE" == "$COUNT" && "$DEVIATIONS" == "$COUNT" ]] || { echo "  FAIL: expected $COUNT OVERDUE steps and deviations"; PASS=false; }
if [[ -z "$MAX" ]] || awk -v m="$MAX" -v l="$MAX_WAIT" 'BEGIN { exit !(m >= l) }'; then
  echo "  FAIL: longest wait ${MAX:-unknown} s is not under $MAX_WAIT s"; PASS=false
fi
if $PASS; then echo "  PASS"; else exit 1; fi
