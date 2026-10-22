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
CREATE TEMP TABLE lt_event AS
  SELECT cloudevents_id FROM inbound_event_log WHERE raw_payload->>'subject' LIKE 'LOADTEST-%';
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
UNION ALL SELECT 'inbound_event_log', count(*) FROM lt_event;
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
DELETE FROM matcher_event_log WHERE cloudevents_id IN (SELECT cloudevents_id FROM lt_event);
DELETE FROM inbound_event_log WHERE cloudevents_id IN (SELECT cloudevents_id FROM lt_event);
COMMIT;
SQL
echo "Done."
