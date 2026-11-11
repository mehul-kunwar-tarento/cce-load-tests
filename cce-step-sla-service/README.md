<!--
  What:    Landing page of the cce-step-sla-service performance tests: what they measure, how to run them, where
           the documentation is, and what this folder depends on outside itself.
  How:     Read first. Run a test with scripts/run-test.sh local step-sla <smoke|load|stress|breakpoint>.
  Needs:   The repository root (shared runner, config, test data), Node.js 22, a running local-stack with the
           plan-definition set loaded, DB_PASSWORD in the environment.
  Outputs: Documentation only.
-->

# CCE Step SLA Service — Performance Tests

Measures how fast **cce-step-sla-service** turns deadline alarms that have rung into `OVERDUE` verdicts and
deviations — at a steady alarm rate, and when a large backlog of alarms rings at the same moment (the "storm").

Step SLA has no API and reads no Kafka: every poll interval it picks up the SLA transitions ("alarms") whose
deadline has passed, at most 100 batches of 100 rows (10,000 rows) per cycle, oldest first. So these tests do not
send requests. They **seed alarms into Postgres** with chosen ring times, follow Step SLA's own metrics while it
works through them, and then read from the database how long each alarm waited between ringing and being handled.

**Port** `8099` local-stack · **Fed by** alarms seeded in Postgres · **Measured by** per-alarm wait
(`processed_at − process_by`) · **Test types** smoke, load, stress, breakpoint (= storm)

## Quick Start

From the repository root (`cce-load-tests/`), with local-stack running:

```bash
npm install                                                      # once
export DB_PASSWORD=…                                             # never written to a file
scripts/manage-plan-definitions.sh load local --set emr-service  # seeded enrolments need ACTIVE plan definitions
scripts/run-test.sh local step-sla smoke --dry-run               # settings and alarm schedule, nothing connects
scripts/run-test.sh local step-sla smoke                         # 30 alarms ringing 1/s; report printed at the end
scripts/cleanup-test-data.sh local --run-id <runId>              # remove the run's alarms, steps and enrolments
```

The other test types: `load` (30,000 alarms at 50/s), `stress` (120,000 at 200/s), `breakpoint` (100,000 alarms
ringing at once). Every number is a setting you can change per run without editing code, for example
`--set LOAD_EVENTS=5000`, `--set PLAN_DEFINITION_SET=kenya-sha-emr-service`, or the environment variable
`STEP_SLA_FIRST_RING_DELAY=90s`. Run one Step SLA test at a time: its counters are global.

The result folder `results/step-sla-<type>-<yyyymmdd-hhmmss>/` holds `seed.json` (what was seeded),
`watch-alarms.json` (the live watch), `service-metrics.json`, `data-checks.json`, `result.json` (the source of
every report) and `report.md`.

## Documentation

| Document | Contents |
|---|---|
| [Test plan](docs/test-plan.md) | What is tested, test types and defaults, thresholds and expectations, data checks, Grafana panels, plan-definition variations, risks, commands |
| [Test strategy](docs/test-strategy.md) | Why seeded alarms, why the database decides, what "breaking" means for Step SLA, the storm and the 10,000-rows-per-cycle cap |
| [Spec](specs/001-step-sla-performance-tests/spec.md) · [plan](specs/001-step-sla-performance-tests/plan.md) · [tasks](specs/001-step-sla-performance-tests/tasks.md) | How this folder was specified and built (Spec Kit style) |
| [Shared tooling](../tools/README.md) | The runner, result files, exit codes, how a service module plugs in |
| [Grafana dashboard](../monitoring/grafana/dashboards/cce-step-sla-service-performance.json) | Alarms due, applied/skipped per second, cycles, failed batches, Hikari, JVM ([monitoring](../monitoring/README.md)) |
| **Depends on** | **`shared.mjs`** is the only file that imports shared code: `../tools/core/` (settings, Postgres and Prometheus clients, watchers, idle check, run ids, run SQL, result builder) and `../lib/phase-plan.js`. It also needs `../config/` and `../test-data/` at run time through the runner. There is **no k6 shim** (`tests/shared-lib.js`): Step SLA has no k6 script. When this folder is copied into the cce-step-sla-service repository as `performance-tests/`, only `shared.mjs` changes. |

## Layout

| Path | What it is |
|---|---|
| `service-module.mjs` | The plug-in the shared runner loads: kind `seeded`, expectation in alarms/s, hooks below |
| `shared.mjs` | The one door to the shared tooling (see "Depends on") |
| `tests/step-sla-<type>.test.mjs` | Test definitions (Node, not k6): alarm count and ring rate from the phase plan, wait and catch-up limits |
| `seeding/seed-alarms.mjs` | Seeds the alarms in one transaction and writes `seed.json` |
| `watchers/alarm-watcher.mjs` | Follows `cce_sla_transitions_due` and the counters until every alarm is handled or the limit passes |
| `data-checks/step-sla-data-checks.mjs` | The verdict from the database: handled, `OVERDUE`, deviations, wait avg/p95/max, catch-up |
| `unit-tests/` | `node --test` specs with a fake Postgres, fake metric pages and a fake clock (`npm test`) |
