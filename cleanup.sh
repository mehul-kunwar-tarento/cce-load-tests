#!/usr/bin/env bash
# Deletes every row the load tests created: everything linked to a LOADTEST- patient, in every CCE
# table. Shows the row counts first and deletes only after you type "yes".
#
# Run: DB_PASSWORD=<password> ./cleanup.sh <env>      e.g. DB_PASSWORD=cce_pass ./cleanup.sh local
# Needs: docker (psql runs from the postgres image) and jq.
# Don't run it while a load test is still sending events.
set -euo pipefail

ENV_NAME=${1:-}
CONFIG="$(dirname "$0")/env/${ENV_NAME}.json"

if [[ "$ENV_NAME" == "prod" ]]; then
  echo "Prod is not allowed yet (see README, Open items)." >&2
  exit 1
fi
if [[ -z "$ENV_NAME" || ! -f "$CONFIG" ]]; then
  echo "Usage: DB_PASSWORD=<password> $0 <env>   (env = a file name in env/, e.g. local)" >&2
  exit 1
fi
if [[ -z "${DB_PASSWORD:-}" ]]; then
  echo "Set DB_PASSWORD for the $ENV_NAME database." >&2
  exit 1
fi

# Runs psql against the environment's database, using the details in env/<env>.json.
run_psql() {
  docker run --rm -i --network host \
    -e PGHOST="$(jq -r .db.host "$CONFIG")" \
    -e PGPORT="$(jq -r .db.port "$CONFIG")" \
    -e PGDATABASE="$(jq -r .db.name "$CONFIG")" \
    -e PGUSER="$(jq -r .db.user "$CONFIG")" \
    -e PGPASSWORD="$DB_PASSWORD" \
    postgres:16-alpine psql -X -q -v ON_ERROR_STOP=1 "$@"
}

# The load-test rows: patients, their enrolments and steps, and the events they sent.
# Temp tables last only for one psql run.
FIND_TEST_ROWS="
CREATE TEMP TABLE lt_protocol_instance AS
  SELECT id FROM protocol_instance WHERE patient_id LIKE 'LOADTEST-%';
CREATE TEMP TABLE lt_step_instance AS
  SELECT id FROM step_instance WHERE protocol_instance_id IN (SELECT id FROM lt_protocol_instance);
-- Test events: those that came through the collector, plus those the matcher test wrote straight
-- to Kafka (no collector row, so found by the patient inside the FHIR resource).
CREATE TEMP TABLE lt_event AS
  SELECT cloudevents_id FROM inbound_event_log WHERE raw_payload->>'subject' LIKE 'LOADTEST-%'
  UNION
  SELECT cloudevents_id FROM matcher_event_log WHERE data->'subject'->>'reference' LIKE 'Patient/LOADTEST-%';
ANALYZE lt_protocol_instance;
ANALYZE lt_step_instance;
ANALYZE lt_event;
"

echo "Database: $(jq -r '.db | "\(.user)@\(.host):\(.port)/\(.name)"' "$CONFIG")  (env: $ENV_NAME)"
echo "Rows that will be deleted:"
run_psql <<SQL
$FIND_TEST_ROWS
SELECT 'deviation' AS table_name, count(*) AS rows FROM deviation
  WHERE step_instance_id IN (SELECT id FROM lt_step_instance)
UNION ALL SELECT 'step_sla_state_transition', count(*) FROM step_sla_state_transition
  WHERE step_instance_id IN (SELECT id FROM lt_step_instance)
UNION ALL SELECT 'step_instance_history', count(*) FROM step_instance_history
  WHERE step_instance_id IN (SELECT id FROM lt_step_instance)
UNION ALL SELECT 'intelligence_event_log', count(*) FROM intelligence_event_log
  WHERE protocol_instance_id IN (SELECT id FROM lt_protocol_instance) OR subject LIKE 'LOADTEST-%'
UNION ALL SELECT 'step_instance', count(*) FROM lt_step_instance
UNION ALL SELECT 'protocol_instance_history', count(*) FROM protocol_instance_history
  WHERE protocol_instance_id IN (SELECT id FROM lt_protocol_instance)
UNION ALL SELECT 'protocol_instance', count(*) FROM lt_protocol_instance
UNION ALL SELECT 'matcher_event_log', count(*) FROM matcher_event_log
  WHERE cloudevents_id IN (SELECT cloudevents_id FROM lt_event)
UNION ALL SELECT 'inbound_event_log', count(*) FROM inbound_event_log
  WHERE cloudevents_id IN (SELECT cloudevents_id FROM lt_event);
SQL

read -r -p "Delete these rows? Type yes: " answer
if [[ "$answer" != "yes" ]]; then
  echo "Nothing deleted."
  exit 0
fi

# One transaction: either every delete happens or none. Children first, so foreign keys don't block.
run_psql <<SQL
BEGIN;
$FIND_TEST_ROWS
DELETE FROM deviation WHERE step_instance_id IN (SELECT id FROM lt_step_instance);
DELETE FROM step_sla_state_transition WHERE step_instance_id IN (SELECT id FROM lt_step_instance);
DELETE FROM step_instance_history WHERE step_instance_id IN (SELECT id FROM lt_step_instance);
DELETE FROM intelligence_event_log
  WHERE protocol_instance_id IN (SELECT id FROM lt_protocol_instance) OR subject LIKE 'LOADTEST-%';
DELETE FROM step_instance WHERE id IN (SELECT id FROM lt_step_instance);
DELETE FROM protocol_instance_history WHERE protocol_instance_id IN (SELECT id FROM lt_protocol_instance);
DELETE FROM protocol_instance WHERE id IN (SELECT id FROM lt_protocol_instance);
-- step_instance.matched_event_id has a foreign key to matcher_event_log but no index, so without this
-- every deleted matcher_event_log row scans all of step_instance (hours for 100k+ events).
-- The index exists only inside this transaction; while it does, writes to step_instance wait.
CREATE INDEX loadtest_cleanup_matched_event ON step_instance (matched_event_id);
DELETE FROM matcher_event_log WHERE cloudevents_id IN (SELECT cloudevents_id FROM lt_event);
DROP INDEX loadtest_cleanup_matched_event;
DELETE FROM inbound_event_log WHERE cloudevents_id IN (SELECT cloudevents_id FROM lt_event);
COMMIT;
SQL
echo "Done."
