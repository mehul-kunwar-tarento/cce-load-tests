#!/usr/bin/env bash
# Seeds work for the Step SLA test straight into the database: test patients, each with one step whose
# deadline alarm (DUE_DATE_REACHED) rings at a time we choose. Step SLA picks each alarm up when it rings,
# so the ring times alone set the load. The rows copy what the matcher writes for an Encounter
# (protocol_instance, the deadline step, its DUE and MISSED transitions), minus the completed visit
# step and the history rows, which Step SLA never reads.
#
#   smoke   30 alarms, ringing 1 per second for 30 seconds (proves the setup works)
#   load    30,000 alarms, ringing 50 per second for 10 minutes
#   stress  120,000 alarms, ringing 200 per second for 10 minutes
#   storm   100,000 alarms, all ringing at the same moment
# The first alarm rings 60 s after the insert, so start the k6 watcher straight after this script.
#
# Run: DB_PASSWORD=<password> ./scripts/step-sla-seed.sh <env> <smoke|load|stress|storm>
# Writes step-sla/last-seed.json (run id, count and ring times), which step-sla/step-sla.js and
# scripts/step-sla-report.sh read.
set -euo pipefail

ENV_NAME=${1:-}
PROFILE=${2:-}
cd "$(dirname "$0")/.."   # the repo root: env/, results/, step-sla/ are relative to it
source scripts/postgres-connection.sh
db_init "$ENV_NAME" "DB_PASSWORD=<password> $0 <env> <smoke|load|stress|storm>"

case "$PROFILE" in
  smoke)  COUNT=30;     RATE=1 ;;
  load)   COUNT=30000;  RATE=50 ;;
  stress) COUNT=120000; RATE=200 ;;
  storm)  COUNT=100000; RATE=0 ;;   # 0 = all at once
  *) echo "Usage: DB_PASSWORD=<password> $0 <env> <smoke|load|stress|storm>" >&2; exit 1 ;;
esac

PROTOCOL_URL=$(jq -r .stepSla.protocolUrl "$CONFIG")
ACTION_ID=$(jq -r .stepSla.actionId "$CONFIG")
RUN_ID=$(date +%s)

# The protocol the test patients are enrolled in: the ACTIVE version of protocolUrl.
PROTOCOL_ID=$(run_psql -tA -v url="$PROTOCOL_URL" <<'SQL'
SELECT id FROM protocol_definition WHERE url = :'url' AND status = 'ACTIVE' LIMIT 1;
SQL
)
if [[ -z "$PROTOCOL_ID" ]]; then
  echo "No ACTIVE protocol with url $PROTOCOL_URL in the $ENV_NAME database." >&2
  exit 1
fi

echo "Seeding $COUNT alarms ($PROFILE) for protocol $PROTOCOL_URL, step $ACTION_ID..."

# One transaction: all rows or none. The visit is dated 14 days before the alarm, as the matcher would
# date it; the MISSED alarm rings 3 days later, after the test, and scripts/cleanup-test-data.sh deletes it.
RESULT=$(run_psql -tA -v count="$COUNT" -v rate="$RATE" -v run="$RUN_ID" \
  -v protocol_id="$PROTOCOL_ID" -v action="$ACTION_ID" <<'SQL'
BEGIN;
CREATE TEMP TABLE seed AS
  SELECT n,
         gen_random_uuid() AS protocol_instance_id,
         gen_random_uuid() AS step_instance_id,
         now() + interval '60 seconds'
           + CASE WHEN :rate > 0 THEN (n - 1) * interval '1 second' / :rate ELSE interval '0' END AS ring
  FROM generate_series(1, :count) AS n;

INSERT INTO protocol_instance (id, patient_id, protocol_definition_id, enrolled_at, status, created_at, updated_at)
  SELECT protocol_instance_id, 'LOADTEST-SLA-' || :'run' || '-' || n, :'protocol_id',
         ring - interval '14 days', 'ACTIVE', now(), now()
  FROM seed;

INSERT INTO step_instance (id, protocol_instance_id, action_id, repeat_index, step_status, due_date,
                           required_behavior, created_at, updated_at)
  SELECT step_instance_id, protocol_instance_id, :'action', 0, 'NOT_STARTED', ring, 'must', now(), now()
  FROM seed;

INSERT INTO step_sla_state_transition (id, step_instance_id, transition_type, process_by, is_processed,
                                       attempts, next_attempt_at, created_at)
  SELECT gen_random_uuid(), step_instance_id, 'DUE_DATE_REACHED', ring, false, 0, ring, now() FROM seed
  UNION ALL
  SELECT gen_random_uuid(), step_instance_id, 'MISSED_DATE_REACHED', ring + interval '3 days', false, 0,
         ring + interval '3 days', now() FROM seed;

-- count | first ring | last ring, in epoch milliseconds
SELECT count(*), (extract(epoch FROM min(ring)) * 1000)::bigint, (extract(epoch FROM max(ring)) * 1000)::bigint
FROM seed;
COMMIT;
SQL
)

IFS='|' read -r SEEDED RING_START RING_END <<< "$RESULT"
jq -n --arg env "$ENV_NAME" --arg profile "$PROFILE" --arg runId "$RUN_ID" --argjson count "$SEEDED" \
  --argjson ringStart "$RING_START" --argjson ringEnd "$RING_END" \
  '{env: $env, profile: $profile, runId: $runId, count: $count, ringStart: $ringStart, ringEnd: $ringEnd}' \
  > step-sla/last-seed.json

NOW_MS=$(( $(date +%s%N) / 1000000 ))
echo "Seeded $SEEDED alarms: first rings in $(( (RING_START - NOW_MS) / 1000 )) s, last in $(( (RING_END - NOW_MS) / 1000 )) s."
echo "Start the watcher now: ./run.sh $ENV_NAME step-sla/step-sla.js"
echo "When it ends:          DB_PASSWORD=... ./scripts/step-sla-report.sh $ENV_NAME"
