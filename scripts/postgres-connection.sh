# A safe connection to an environment's Postgres, shared by the scripts that read or write the database:
# scripts/cleanup-test-data.sh, scripts/step-sla-seed.sh, scripts/step-sla-report.sh, scripts/matcher-report.sh.
#
# Use:   source scripts/postgres-connection.sh
#        db_init <env> "<usage line>"     checks first: not prod, env/<env>.json exists, DB_PASSWORD set
#        run_psql <<SQL ... SQL           runs SQL on that environment's database
# Needs: docker (psql runs from the postgres image, nothing to install) and jq.

# Checks the environment and the password, and sets CONFIG to env/<env>.json.
db_init() {
  local env_name=$1 usage=$2
  CONFIG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/env/${env_name}.json"

  if [[ "$env_name" == "prod" ]]; then
    echo "Prod is not allowed yet (see README, Open items)." >&2
    exit 1
  fi
  if [[ -z "$env_name" || ! -f "$CONFIG" ]]; then
    echo "Usage: $usage   (env = a file name in env/, e.g. local)" >&2
    exit 1
  fi
  if [[ -z "${DB_PASSWORD:-}" ]]; then
    echo "Set DB_PASSWORD for the $env_name database." >&2
    exit 1
  fi
}

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
