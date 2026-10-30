#!/usr/bin/env bash
# After-run check for the matcher test: did every event k6 sent create its records in the database?
# The test's own "every sent event processed" comes from the matcher's counter, which also goes up for a
# duplicate, a zero match or a half-done event; this counts the actual rows.
#
# For N events sent, expects (env/<env>.json, matcher.recordsPerEvent; the demo protocol):
#   matcher_event_log 1 × N, protocol_instance 1 × N, step_instance 2 × N, step_sla_state_transition 2 × N
# N = k6's own count of Kafka writes (results/last-summary.json). Only this run's test patients are
# counted: LOADTEST-MATCH-<run id>-… (run id from results/last-run.json, written by run.sh).
#
# Run right after the matcher test: DB_PASSWORD=<password> ./scripts/matcher-report.sh <env>
# Exits 1 on FAIL. Run it before scripts/cleanup-test-data.sh, which deletes the rows it counts.
set -euo pipefail

ENV_NAME=${1:-}
cd "$(dirname "$0")/.."   # the repo root: env/, results/, step-sla/ are relative to it
source scripts/postgres-connection.sh
db_init "$ENV_NAME" "DB_PASSWORD=<password> $0 <env>"

# Which run to check: the last one run.sh started, and it must have been the matcher test.
RUN=results/last-run.json
SUMMARY=results/last-summary.json
if [[ ! -f "$RUN" || ! -f "$SUMMARY" ]]; then
  echo "No results of a test run: run ./run.sh $ENV_NAME matcher/matcher.js first." >&2
  exit 1
fi
if [[ "$(jq -r .test "$RUN")" != "matcher/matcher.js" ]]; then
  echo "The last run was $(jq -r .test "$RUN"), not matcher/matcher.js." >&2
  exit 1
fi
if [[ "$(jq -r .env "$RUN")" != "$ENV_NAME" ]]; then
  echo "The last run was on $(jq -r .env "$RUN"), not $ENV_NAME." >&2
  exit 1
fi
RUN_ID=$(jq -r .runId "$RUN")
SENT=$(jq -r '.metrics.kafka_writer_message_count.count' "$SUMMARY")
PATIENTS="LOADTEST-MATCH-${RUN_ID}-%"

# Rows this run created: matcher events | enrolments | steps | alarms
COUNTS=$(run_psql -tA -v patients="$PATIENTS" <<'SQL'
WITH pi AS (SELECT id FROM protocol_instance WHERE patient_id LIKE :'patients'),
     si AS (SELECT id FROM step_instance WHERE protocol_instance_id IN (SELECT id FROM pi))
SELECT (SELECT count(*) FROM matcher_event_log WHERE data->'subject'->>'reference' LIKE 'Patient/' || :'patients'),
       (SELECT count(*) FROM pi),
       (SELECT count(*) FROM si),
       (SELECT count(*) FROM step_sla_state_transition WHERE step_instance_id IN (SELECT id FROM si));
SQL
)

echo "Matcher records report: $SENT events sent (run $RUN_ID, env $ENV_NAME)"
printf '  %-28s %10s %10s\n' table expected found
PASS=true
COLUMN=1
for TABLE in matcher_event_log protocol_instance step_instance step_sla_state_transition; do
  PER_EVENT=$(jq -r ".matcher.recordsPerEvent.${TABLE}" "$CONFIG")
  EXPECTED=$(( SENT * PER_EVENT ))
  FOUND=$(echo "$COUNTS" | cut -d'|' -f"$COLUMN")
  printf '  %-28s %10s %10s\n' "$TABLE" "$EXPECTED" "$FOUND"
  if [[ "$FOUND" != "$EXPECTED" ]]; then
    echo "  FAIL: $TABLE has $FOUND rows for this run, expected $EXPECTED ($PER_EVENT per event)"
    PASS=false
  fi
  COLUMN=$(( COLUMN + 1 ))
done

if $PASS; then
  echo "  PASS"
else
  exit 1
fi
