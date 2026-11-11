<!--
  What:    Landing page of the CCE performance tests: what the suite is, the facts at a glance, the first
           commands to run, where every document is, how one test run works, and how the suite itself is tested.
  How:     Read first. Commands run from this folder (the repository root). New to performance testing?
           Continue with docs/runbook.md and keep docs/glossary.md open.
  Needs:   Nothing to read it. To run tests: Node.js 22, Docker, a running CCE stack (see docs/runbook.md).
  Outputs: Documentation only.
-->

# CCE Performance Tests

Performance tests for the **CCE (Clinical Compliance Engine)** services. Each service is tested **on its
own**, fed directly at its own entry point: the **collector** over HTTP, the **matcher** through Kafka, and
**Step SLA** with alarms seeded in Postgres. After every run you get a short report that answers: how much
load went through in the configured interval, what we expected the service to withstand and whether it did,
and — for stress and breakpoint tests — when it started breaking and what broke. Every run is visible in
Grafana next to the services' own metrics.

The suite is general, not tied to one EMR or one protocol: which protocol is ACTIVE is a test parameter
(`PLAN_DEFINITION_SET`: `emr-service`, the default, or `kenya-sha-emr-service`) recorded with every result,
and the event data comes from that protocol's dataset (`ebuzima-emr` for the eBUZIMA EMR, `tiberbu-emr` for
tibERbu; selectable with `DATASET`).

> **Never point it at production.** Every command refuses an environment named or marked `prod`. On shared
> Dev/UAT, read the write-safety rules in [docs/runbook.md](docs/runbook.md) §6 before loading plan
> definitions or cleaning up.

**Load generator** k6 2.3.0 + xk6-kafka 2.2.0 (Docker image `cce-load-tests/k6:2.3.0-kafka2.2.0`) ·
**Tooling** Node.js 22, one CLI (`node tools/cli.mjs`) · **Services** cce-collector-service,
cce-matcher-service, cce-step-sla-service (`release-2.0.0`) · **Test types** smoke, load, stress, breakpoint ·
**Results** `results/<subject>-<test-type>-<yyyymmdd-hhmmss>/` (`result.json` + `report.md`) ·
**Monitoring** Prometheus + Grafana (laptop stack or CCE's Grafana)

## Quick Start

On a laptop running CCE's `openphc-repos/local-stack`:

```bash
scripts/build-k6-image.sh                      # once per machine: the k6 image with Kafka support
npm install                                    # once: Node dependencies (pg, kafkajs, linters)
export DB_PASSWORD=…                           # the cce_user password; never written to a file

scripts/check-services.sh local                # preflight: services healthy, Postgres/Kafka reachable, disk, WAL
scripts/run-test.sh local collector smoke --dry-run   # what would run: settings, phases, k6 command (connects to nothing)
scripts/run-test.sh local collector smoke      # 1 event/s for 30 s; the report is printed at the end
scripts/cleanup-test-data.sh local --run-id <runId> --dry-run   # count this run's test data, delete nothing
scripts/cleanup-test-data.sh local --run-id <runId>             # delete it, verified table by table
```

Then the other services and test types (`<subject>` is `collector`, `matcher` or `step-sla`):

```bash
scripts/run-test.sh local <subject> load       # 1 × peak: 50/s for 10 min
scripts/run-test.sh local <subject> stress     # 4 × peak: 200/s for 10 min
scripts/run-test.sh local <subject> breakpoint # collector staircase · matcher flood (2,000/s for 1 min) · Step SLA storm
```

For collector and matcher, **every** load, stress and breakpoint run first sends a warm-up of 10/s for 1 min
(600 events, not measured), so a stress run sends 120,600 events in 11 min and the matcher flood 120,600
events in 2 min (`WARM_UP_RATE`, `WARM_UP_DURATION`). Step SLA has no warm-up (its alarms are seeded).
`--dry-run` prints the exact phase plan.

Every number is a setting you can change for one run without editing code, e.g.
`--set LOAD_RATE=80 --set LOAD_DURATION=5m`, `--set LOAD_EVENTS=1000` (total events instead of a duration) or
`--set PLAN_DEFINITION_SET=kenya-sha-emr-service`. See them with `scripts/print-settings.sh local collector load`.
The full walk-through, including monitoring and troubleshooting, is the [runbook](docs/runbook.md).

## Documentation

| Document | Contents |
|---|---|
| [Runbook](docs/runbook.md) | Onboarding: prerequisites, image, monitoring, environments, plan-definition sets, preflight, running every test, reading results and Grafana, baselines, cleanup, troubleshooting |
| [Architecture Overview](docs/architecture-overview.md) | What CCE is, the write and analytics paths, each service and how it is fed on its own, how one run works (k6 clock), feasibility and gaps |
| [Test Strategy](docs/test-strategy.md) | Test types and when to use each, open load model, threshold vs capacity vs breaking point vs baseline, warm-up, dropped iterations and the k6 limit, environments, repeat runs |
| [Workload Model](docs/workload-model.md) | How events per interval are set (rate + duration or total events), staircase, flood, storm, every setting and its default, from UAT/Dev traffic to a workload profile |
| [Glossary](docs/glossary.md) | Every term you will meet, in plain language |
| [Conventions](docs/conventions.md) | Naming, ids, header comments, specs, git; adding a test type, service, adaptor or the end-to-end module |
| [Known Results and Lessons](docs/known-results-and-lessons.md) | The first (laptop, relative only) numbers and the lessons, each linked to the part of the suite that addresses it |
| [Requirements Checklist](docs/requirements-checklist.md) | The team lead's review points R1–R15 → files, commands, status |
| [Open Questions](docs/open-questions.md) | Decisions still needed from the team, package deviations, tasks deferred to the first live run |
| [Contributing](CONTRIBUTING.md) | Spec-first workflow, commits and branches, checks to run |
| [Specs](specs/README.md) | Index of every spec (shared parts and per service) with status |

Per-service and per-part guides:

| For | See |
|---|---|
| Collector tests (HTTP) | [cce-collector-service/README.md](cce-collector-service/README.md) · [test plan](cce-collector-service/docs/test-plan.md) · [test strategy](cce-collector-service/docs/test-strategy.md) |
| Matcher tests (Kafka) | [cce-matcher-service/README.md](cce-matcher-service/README.md) · [test plan](cce-matcher-service/docs/test-plan.md) · [test strategy](cce-matcher-service/docs/test-strategy.md) |
| Step SLA tests (seeded alarms) | [cce-step-sla-service/README.md](cce-step-sla-service/README.md) · [test plan](cce-step-sla-service/docs/test-plan.md) · [test strategy](cce-step-sla-service/docs/test-strategy.md) |
| The CLI, result files, service-module contract | [tools/README.md](tools/README.md) |
| Environments and settings | [config/README.md](config/README.md) · [config/settings/defaults.json](config/settings/defaults.json) |
| Datasets and plan-definition sets | [test-data/README.md](test-data/README.md) |
| Prometheus, Grafana, dashboards | [monitoring/README.md](monitoring/README.md) |
| Baselines | [baselines/README.md](baselines/README.md) |
| Shared k6 library, k6 image | [lib/README.md](lib/README.md) · [docker/k6/README.md](docker/k6/README.md) |

## How it works

```
 scripts/run-test.sh local matcher stress
   └─ node tools/cli.mjs run local matcher stress
        1  settings: defaults.json → environment file → env vars → --set   ─► run-context.json (printed)
        2  preflight: health, Postgres, Kafka, plan-definition set, disk, WAL ─► preflight.json (fail = stop)
        3  conditions: machine, commit, data volume, ACTIVE plan definitions
        4  wait until the service is idle; prepare (Step SLA: seed alarms)    ─► seed.json
        5  start the metrics sampler and the watchers                         ─► service-metrics.json, watch-*.json
        6  k6 in Docker sends the load ──────────────────────────────────────► CCE service under test
              └─ k6 metrics ─► Prometheus (remote write, tag testid=<runId>) ─► Grafana
        7  watchers wait for catch-up; data checks count rows in Postgres     ─► data-checks.json
        8  result.json (the only source of truth)  ─►  report.md + printed summary
        9  optional: compare with a baseline                                  ─► baseline-comparison.json

   collector ◄── HTTP POST /v1/events (k6)
   matcher   ◄── Kafka cce.events.inbound (k6 + xk6-kafka)
   Step SLA  ◄── alarms seeded in Postgres (Node, no k6)
```

Every run is tagged with a run id (`yyyymmdd-hhmmss`): the results folder, the Grafana `testid` and every
row of test data (`LOADTEST-<runId>-…`) carry it, so a run can be found, compared and cleaned up exactly.
Details: [Architecture Overview](docs/architecture-overview.md) §4–§5.

## Testing

The suite is checked without touching any live system:

```bash
npm test             # every unit test (node --test, fakes for Docker, Postgres, Kafka and HTTP)
npm run lint         # ESLint + Prettier + header comments (lint-headers) + ShellCheck
npm run check:k6     # k6 inspect of every k6 test script, in the image, with --network none
scripts/run-test.sh local matcher stress --dry-run   # settings and phase plan of a run, no connection
```

Exit codes of every command: `0` passed / done · `1` failed (or aborted) · `2` refused (prod, preflight
failed, guard, bad setting) · `3` tool error.

## Repository layout

| Path | What it is |
|---|---|
| `cce-collector-service/`, `cce-matcher-service/`, `cce-step-sla-service/` | One folder per service, named after its repository: tests, test plan and strategy, specs, data checks; self-contained so it can later be copied into that repository as `performance-tests/` |
| `lib/` | Shared k6 library (phase plan, scenarios, thresholds, test-data builders) |
| `tools/` | Node.js CLI: run, settings, preflight, cleanup, report, baseline, check-data, plan-definitions, lint-headers |
| `scripts/` | Thin shell entry points (`run-test.sh`, `check-services.sh`, `cleanup-test-data.sh`, …) |
| `config/` | Environment files (no secrets) and `settings/defaults.json`, the one source of every setting |
| `test-data/` | Datasets, plan-definition fixtures, plan-definition sets |
| `monitoring/` | Laptop Prometheus + Grafana and the dashboards for CCE's Grafana |
| `baselines/` | Saved baselines (written by the tool) |
| `docs/` | The documents listed above |
| `specs/` | Specs of the shared parts and the index of all specs |
| `docker/k6/` | Dockerfile of the k6 image |
| `results/` | Run outputs, git-ignored |
