# CCE load tests

k6 load tests for the CCE services. Each service is tested on its own; an end-to-end test comes last.

## How to run

Only Docker is needed: `run.sh` runs k6 from our own image (`docker/Dockerfile`: k6 2.3.0 plus the
xk6-kafka 2.2.0 extension, which the matcher test uses to write to Kafka). The first run on a machine
builds it (about a minute, needs internet); later runs reuse it.

```bash
./run.sh <env> <test>                    # e.g. ./run.sh local adaptor/openhim.js  (smoke, then load)
./run.sh <env> <test> -e PROFILE=smoke   # smoke only (30 s)
./run.sh <env> <test> -e PROFILE=stress  # smoke, then stress
```

The rates come from the expected traffic: 600,000 events a day, about 7/s on average and 50/s in
10-minute peaks (cce-data-pipeline docs §7.1).

| Profile | Rate | Duration | Passing means |
|---|---|---|---|
| smoke | 1/s | 30 s | the script and setup work; if it fails, k6 stops at once |
| load (default) | 50/s, the expected peak | 10 min | the service handles a normal busy period |
| stress | 200/s, 4× the peak | 10 min | the service handled 120,000 events in 10 minutes |

Load and stress use the same pass/fail rules. A stress run stops early if errors pass 10%. It
leaves a lot of data; wait for the matcher's Kafka lag to reach 0 before running `cleanup.sh`.

| Test | What it tests |
|---|---|
| `adaptor/openhim.js` | OpenHIM emitter adaptor `POST /inbound` (with the real collector behind it) |
| `collector/collector.js` | Collector `POST /v1/events` on its own, with the CloudEvent the adaptor sends |
| `matcher/matcher.js` | Matcher: writes the CloudEvent straight to Kafka; a watcher reads `cce_events_processed_total` every 5 s for backlog and throughput. Stops if nothing is processed for 30 s. The counter counts all traffic, so on a shared server other events make the matcher look faster |

| `step-sla/step-sla.js` | Step SLA: the work is seeded straight into the database (see below); this only watches it being handled |

**Step SLA** reads only the database, so its test seeds deadline alarms there instead of sending events:

```bash
DB_PASSWORD=<password> ./seed-sla.sh <env> <smoke|load|stress|storm>   # alarms ring from 60 s later
./run.sh <env> step-sla/step-sla.js                                     # watch them being handled
DB_PASSWORD=<password> ./report-sla.sh <env>                            # PASS/FAIL from each alarm's wait
```

`seed-sla.sh` copies the rows the matcher writes for an Encounter (enrolment, deadline step, its DUE
and MISSED alarms). The ring times set the load: smoke 30 at 1/s, load 30,000 at 50/s, stress 120,000
at 200/s, storm 100,000 all at once. `report-sla.sh` passes when every alarm was handled and the
longest wait after ringing is under 2 check intervals (`stepSla.pollIntervalSeconds`; storm: 300 s).
Run it before `cleanup.sh`, and run `cleanup.sh` only once Step SLA has nothing due, or the two collide.

The smoke, load and stress settings and their pass/fail rules live in `lib/` (`smoke.js`, `load.js`,
`stress.js`), and `lib/options.js` picks one by `PROFILE`, so every test uses the same rules.

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
- **Missing index in the matcher:** `step_instance.matched_event_id` has a foreign key to
  `matcher_event_log` but no index, so deleting matcher events scans all of `step_instance` per row.
  `cleanup.sh` works around it with an index that exists only during its transaction (writes to
  `step_instance` wait meanwhile). The real fix is a migration in `cce-matcher-service`; raise with the team.
- **Grafana/Prometheus (later):** send k6's own metrics to Prometheus (`-o experimental-prometheus-rw`)
  and add the k6 dashboard to Grafana. Needs `--web.enable-remote-write-receiver` on Prometheus in
  `deploy-scripts`. Until then, watch the service's existing Grafana dashboard during a run.
