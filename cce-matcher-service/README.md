<!--
  What:    Landing page of the matcher performance tests: what they measure, how to run them, and where
           everything else is documented.
  How:     Read first. Commands are run from the repository root (cce-load-tests/).
  Needs:   Node.js 22, Docker with the image cce-load-tests/k6:2.3.0-kafka2.2.0, a running CCE stack
           (openphc-repos/local-stack on a laptop), DB_PASSWORD exported.
  Outputs: Nothing; a guide to this folder.
-->

# CCE Matcher Service — Performance Tests

These tests measure how many events per second the **matcher** can handle. The matcher reads clinical events
from Kafka, matches each one against the ACTIVE plan definitions, and enrols the patient. The matcher has no
HTTP endpoint, so **k6 writes CloudEvents straight into the Kafka topic** at a rate you choose. A Node
**backlog watcher** then follows how many events are still waiting (the consumer-group lag) until the matcher
catches up. Every run answers these questions in a short report:

- how many events went through in the measured interval, and how many the matcher processed per second;
- how far the backlog grew and whether (and how fast) it caught up after sending stopped. A run that did
  not catch up reports "N events still waiting after S s", never a catch-up time;
- for stress: when the backlog started growing past the limit and what broke; for the breakpoint (the
  *flood*): the **drain rate**, which is the matcher's real capacity;
- whether every event reached the database: logged, matched, and enrolled once per plan definition;
- what we expected it to withstand (1 × peak for load, 4 × peak for stress; *to be confirmed from
  UAT/Dev data*) and what it actually did.

The matcher's cost depends mostly on **how many plan definitions match each event** (the fan-out). The
plan-definition set is therefore a test parameter (`PLAN_DEFINITION_SET`), and it is recorded with every
result.

**Port** `8097` local-stack · **Fed by** Kafka `cce.events.inbound` · **Measured by** consumer-group lag ·
**Test types** smoke / load / stress / breakpoint (flood)

## Quick Start

From the repository root, with the CCE stack running and `DB_PASSWORD` exported:

```bash
# 1. Is everything up? (matcher health and metrics, Postgres, Kafka topic + consumer group,
#    plan-definition set ACTIVE and not overlapped by others; no load is sent)
scripts/check-services.sh local --subject matcher

# 2. Smoke: 1 event/s for 30 s. Proves the path works end to end.
scripts/run-test.sh local matcher smoke

# 3. Load (1 × peak: 50/s for 10 min after a 1-min warm-up), then stress (4 × peak: 200/s for 10 min)
scripts/run-test.sh local matcher load
scripts/run-test.sh local matcher stress

# 4. Breakpoint = flood: 2,000/s for 1 min, then the watcher measures how fast the matcher drains it
scripts/run-test.sh local matcher breakpoint

# 5. Remove this run's test data (dry run first)
scripts/cleanup-test-data.sh local --run-id <runId> --dry-run
```

You can change the amount of load without editing code. Every setting can be given as an option:

```bash
scripts/run-test.sh local matcher load --set LOAD_RATE=80 --set LOAD_DURATION=5m
scripts/run-test.sh local matcher load --set LOAD_EVENTS=3000             # duration derived: 3000 / 50 = 60 s
scripts/run-test.sh local matcher stress --set PLAN_DEFINITION_SET=kenya-sha-emr-service
scripts/run-test.sh local matcher breakpoint --set MATCHER_FLOOD_EVENTS=60000
scripts/print-settings.sh local matcher load                             # see the plan without running
scripts/run-test.sh local matcher load --dry-run                         # print settings, phases, k6 command
```

Results are written to `results/matcher-<test-type>-<yyyymmdd-hhmmss>/`: `report.md` is for people to read,
`result.json` is for tools, and `watch-backlog.json` holds every backlog sample. To watch a run live, open the
Grafana dashboard **CCE Matcher Service — Performance**.

> **One test at a time.** The matcher's counters are global, and every collector run also feeds the matcher.
> A run therefore waits until the matcher is idle (lag 0, counters flat) before it starts. If another run
> left a backlog behind, the run waits for it, or it is refused after `IDLE_TIMEOUT`.

## Documentation

| Document | Contents |
|---|---|
| [Test Plan](docs/test-plan.md) | What is tested, how it is fed and measured, test types and defaults, thresholds and expectations, data checks, Grafana panels, plan-definition variations, conditions, risks, commands |
| [Test Strategy](docs/test-strategy.md) | Why the matcher is tested on its own, why the flood replaces a staircase, what "breaking" means for a queue consumer, the k6 clock, safe stops, how results become baselines |
| [Spec](specs/001-matcher-performance-tests/spec.md) · [Plan](specs/001-matcher-performance-tests/plan.md) · [Tasks](specs/001-matcher-performance-tests/tasks.md) | The spec-driven record of how this folder was built (goal, interfaces, deviations, tasks) |
| **Depends on** | All shared code is reached through two shims. [`shared.mjs`](shared.mjs) (Node) imports from `../tools/core/` (idle, watchers, breaking-analysis, run-sql, clients/prometheus-text, k6-summary, format, results, result-builder, result-schema, sampled-metrics, service-registry), from `../tools/plan-definitions/` (expected-rows, sets) and from the pure `../lib/` modules (phase-plan, scenarios, duration). [`tests/shared-lib.js`](tests/shared-lib.js) (k6) imports from `../../lib/` (run-context, scenarios, tagging, test-data, kafka-client, event-metrics, summary). At run time the folder also uses `config/`, `test-data/` and the runner `tools/cli.mjs`. To copy this folder into the cce-matcher-service repository, only those two files need rewriting |

Suite-wide context lives at the repository root and is not repeated here:

| For | See |
|---|---|
| Onboarding: prerequisites, image, monitoring, environments, preflight, cleanup, troubleshooting | [docs/runbook.md](../docs/runbook.md) |
| Every term (arrival rate, VU, dropped iteration, backlog, consumer lag, drain rate, plan-definition set, …) | [docs/glossary.md](../docs/glossary.md) |
| Settings (names, defaults, "to be confirmed" flags) | [config/settings/defaults.json](../config/settings/defaults.json) · [config/README.md](../config/README.md) |
| Plan-definition sets (emr-service, kenya-sha-emr-service) | [test-data/README.md](../test-data/README.md) |
| Grafana and Prometheus for a laptop; importing into CCE's Grafana | [monitoring/README.md](../monitoring/README.md) |
| The runner and its commands | [tools/README.md](../tools/README.md) |

## Folder layout

| Path | What it is |
|---|---|
| `service-module.mjs` | Tells the shared runner what is special about the matcher: scripts, expectation, idle wait, backlog watcher, sampled metrics, data checks, pass rules, baseline numbers |
| `shared.mjs` | Node shim: the only Node file that imports shared code |
| `watchers/backlog-watcher.mjs` | Every `WATCH_INTERVAL` (5 s): consumer lag, processed counter, processing time, dead-letter topic. It decides caught up / not caught up, stops the load on a stall or a restart, and measures the flood's drain rate |
| `tests/matcher-<type>.test.js` | The four k6 scripts. They are thin: options, setup, iteration, summary |
| `tests/matcher-scenario.js` | One iteration builds one new patient's CloudEvent and writes it to `cce.events.inbound` with key = patient id |
| `tests/shared-lib.js` | k6 shim: the only k6 file that imports `../../lib/` |
| `data-checks/matcher-data-checks.mjs` | After the run: logged = sent, all matched, patients enrolled, enrolments = fan-out × patients, steps created, no dead letters |
| `unit-tests/` | `node --test` specs with a fake clock, fake Kafka admin, fake metrics page and fake Postgres (`npm test`) |
