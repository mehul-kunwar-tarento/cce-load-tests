<!--
  What:    Landing page of the collector performance tests: what they measure, how to run them in one
           command, and where everything else is documented.
  How:     Read first. Commands are run from the repository root (cce-load-tests/).
  Needs:   Node.js 22, Docker with the image cce-load-tests/k6:2.3.0-kafka2.2.0, a running CCE stack
           (openphc-repos/local-stack on a laptop), DB_PASSWORD exported.
  Outputs: Nothing; a guide to this folder.
-->

# CCE Collector Service — Performance Tests

Measures how much event traffic the **collector** — the HTTP front door of CCE — takes on its own. k6
posts CloudEvents to `POST /v1/events` at a rate you choose (an *open* load model: k6 keeps sending at that
rate even when the collector slows down), and every run answers in a short report:

- how many events went through in the measured interval, and at what latency (p95);
- whether every event the collector accepted was really stored in Postgres;
- for stress and breakpoint: when it started breaking, at what rate, and what broke;
- what we expected it to withstand (1 × peak for load, 4 × peak for stress — *to be confirmed from
  UAT/Dev data*) against what it did.

Each accepted event is also published to Kafka and processed by the matcher. Collector and matcher share
one Postgres, so a run first **waits until the matcher is idle** and reports the matcher backlog the run
left behind.

**Port** `8093` on local-stack (container `8080`) · **Fed by** HTTP `POST /v1/events` (CloudEvent JSON, no
auth) · **Test types** smoke / load / stress / breakpoint

## Quick Start

From the repository root, with the CCE stack running and `DB_PASSWORD` exported:

```bash
# 1. Is everything up? (actuator health, Postgres, Kafka, plan definitions — no load sent)
scripts/check-services.sh local --subject collector

# 2. Smoke: 1 event/s for 30 s — proves the path works end to end
scripts/run-test.sh local collector smoke

# 3. Load (1 × peak: 50/s for 10 min after a 1-min warm-up), then stress (4 × peak: 200/s)
scripts/run-test.sh local collector load
scripts/run-test.sh local collector stress

# 4. Breakpoint: staircase 200 → 6400/s; then narrow it down between "held" and "broke"
scripts/run-test.sh local collector breakpoint
scripts/run-test.sh local collector breakpoint --refine-from results/collector-breakpoint-<yyyymmdd-hhmmss>

# 5. Remove this run's test data (dry run first)
scripts/cleanup-test-data.sh local --run-id <runId> --dry-run
```

Change the amount of load without editing code — every setting is an option:

```bash
scripts/run-test.sh local collector load --set LOAD_RATE=80 --set LOAD_DURATION=5m
scripts/run-test.sh local collector load --set LOAD_EVENTS=1000          # duration derived: 1000 / 50 = 20 s
scripts/run-test.sh local collector stress --set PLAN_DEFINITION_SET=kenya-sha-emr-service
scripts/print-settings.sh local collector load --set LOAD_EVENTS=1000   # see the plan without running
scripts/run-test.sh local collector load --dry-run                      # print settings, phases, k6 command
```

Results land in `results/collector-<test-type>-<yyyymmdd-hhmmss>/` (`report.md` to read, `result.json`
for tools). Watch it live in Grafana: dashboard **CCE Collector Service — Performance**.

## Documentation

| Document | Contents |
|---|---|
| [Test Plan](docs/test-plan.md) | What is tested, how it is fed and measured, test types and defaults, thresholds and expectations, data checks, Grafana panels, plan-definition variations, conditions, risks, commands |
| [Test Strategy](docs/test-strategy.md) | Why these four test types, why an open load model, what "breaking" means for the collector, how to read a k6 limit, how results become baselines |
| [Spec](specs/001-collector-performance-tests/spec.md) · [Plan](specs/001-collector-performance-tests/plan.md) · [Tasks](specs/001-collector-performance-tests/tasks.md) | The spec-driven record of how this folder was built (goal, interfaces, deviations, tasks) |
| **Depends on** | Two shims are the only doors to shared code: [`shared.mjs`](shared.mjs) (Node) → `../tools/core/` (idle, run-sql, k6-summary, breaking-analysis, results, format, settings, run-setup, service-registry, result-builder, result-schema) and `../lib/` pure modules (phase-plan, duration); [`tests/shared-lib.js`](tests/shared-lib.js) (k6) → `../../lib/` (run-context, scenarios, tagging, test-data, http-client, event-metrics, summary). At run time also `config/`, `test-data/` and the runner `tools/cli.mjs`. Copying this folder into the collector repository means rewriting those two files only |

Suite-wide context lives at the repository root and is not restated here:

| For | See |
|---|---|
| Onboarding: prerequisites, image, monitoring, environments, preflight, cleanup, troubleshooting | [docs/runbook.md](../docs/runbook.md) |
| Every term (arrival rate, VU, dropped iteration, p95, backlog, plan-definition set, …) | [docs/glossary.md](../docs/glossary.md) |
| Settings (names, defaults, "to be confirmed" flags) | [config/settings/defaults.json](../config/settings/defaults.json) · [config/README.md](../config/README.md) |
| Grafana and Prometheus for a laptop; importing into CCE's Grafana | [monitoring/README.md](../monitoring/README.md) |
| The runner and its commands | [tools/README.md](../tools/README.md) |

## Folder layout

| Path | What it is |
|---|---|
| `service-module.mjs` | Tells the shared runner what is special about the collector (scripts, expectation, idle wait, sampled metrics, data checks, pass rules, baseline numbers) |
| `shared.mjs` | Node shim: the only Node file importing shared code |
| `tests/collector-<type>.test.js` | The four k6 scripts (thin: options, setup, iteration, summary) |
| `tests/collector-scenario.js` | One iteration = build one new CloudEvent and `POST /v1/events` |
| `tests/shared-lib.js` | k6 shim: the only k6 file importing `../../lib/` |
| `data-checks/collector-data-checks.mjs` | After the run: stored = accepted, no rejections, matcher logged, matcher backlog left |
| `unit-tests/` | `node --test` specs with fake Postgres / Kafka / metrics and fixture k6 summaries (`npm test`) |
