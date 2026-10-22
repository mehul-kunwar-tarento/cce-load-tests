# CCE load tests

k6 load tests for the CCE services. Each service is tested on its own; an end-to-end test comes last.

## How to run

Only Docker is needed: `run.sh` runs k6 from the `grafana/k6` image, at a fixed version.

```bash
./run.sh <env> <test>                    # e.g. ./run.sh local adaptor/openhim.js
./run.sh <env> <test> -e PROFILE=smoke   # smoke only (30 s)
```

Each test has two parts. The **smoke** run (1 request/s for 30 s) checks the script and setup; if it
fails, k6 stops at once. The **load** run (the target rate for 5 minutes) starts right after it.

| Test | What it tests |
|---|---|
| `adaptor/openhim.js` | OpenHIM emitter adaptor `POST /inbound` (with the real collector behind it) |

At the end k6 prints a summary; each threshold shows ✓ or ✗, and the run exits non-zero if any fails.

## Environments

Each environment has one file in `env/` with the URLs and IDs the tests use. The scripts contain
no URLs. The repo is cloned onto each environment's own server and run there, so the tests call the
services directly, not through the gateway (the gateway rate-limits `/v1/events`).

| File | Environment |
|---|---|
| `env/local.json` | The local stack (`extras/cce-local-setup`) |

Pick one with `-e ENV=<name>`. Passwords are never stored here; they come from environment variables.

## Test data

Every patient ID a test creates starts with `LOADTEST-`, so load-test data can be found and deleted
in shared environments. To delete it (the script shows the row counts and asks before deleting):

```bash
DB_PASSWORD=<password> ./cleanup.sh <env>
```

It deletes every Postgres row linked to a `LOADTEST-` patient, in one transaction. ClickHouse's main
tables follow on their own (Debezium carries the deletes); its summary tables do not, see Open items.
Locally, `extras/cce-local-setup/scripts/reset-data.sh` clears everything instead.

## Open items

- **Prod:** not decided yet whether load tests ever run against Prod. Needs a discussion first.
  Until then, do not run these tests on Prod. `cleanup.sh` refuses `prod`.
- **ClickHouse summary tables:** after `cleanup.sh`, the `mv_*` and `rollup_*` tables in
  `cce_analytics` still hold rows for `LOADTEST-` patients. Not yet checked whether the Insights
  dashboards show them.
- **Grafana/Prometheus (later):** send k6's own metrics to Prometheus (`-o experimental-prometheus-rw`)
  and add the k6 dashboard to Grafana. Needs `--web.enable-remote-write-receiver` on Prometheus in
  `deploy-scripts`. Until then, watch the service's existing Grafana dashboard during a run.
