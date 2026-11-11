<!--
  What:    What CCE is, its write path and analytics path, what each service does and how this suite feeds it
           on its own, how the suite is built, what happens in one run (including the k6 clock), and the
           feasibility of service-level testing with its known gaps.
  How:     Read after the root README.md and before your first run. Terms in italics are in glossary.md.
  Needs:   Nothing. Sources: specs/000-performance-testing-setup/plan.md §0, §6, §10; the CCE repositories on
           release-2.0.0 (read-only).
  Outputs: Documentation only.
-->

# CCE Performance Tests — Architecture Overview

> The services are tested one at a time, each fed directly at its own entry point, so a slow result
> points at one service instead of a whole chain.

---

## 1. What CCE is

CCE (Clinical Compliance Engine) checks whether patients receive the care a protocol prescribes, on time.
An EMR (a clinic's electronic medical record system, e.g. eBUZIMA, the first EMR whose data this suite uses)
sends clinical events — a visit, vital signs, a consultation, a lab order — as FHIR resources. CCE matches
each event against the ACTIVE *plan definitions* (care protocols written as FHIR PlanDefinitions), enrols the
patient, creates the protocol's *steps*, and for every *mandatory step* schedules a deadline *alarm*. When a
deadline passes without the step being done, CCE records a *deviation*. Dashboards then show compliance per
facility.

## 2. Write path and analytics path

CCE has two paths. **This suite tests the write path.** The analytics path is context only, tested later.

```
 WRITE PATH (tested now, one service at a time)

 EMR ──► adaptor ──► collector ──► Kafka ─────────────► matcher ──► Postgres ◄── Step SLA
        (OpenHIM,    HTTP           topic                (matches      protocol_instance   (polls due alarms,
         Tiberbu;    POST /v1/events cce.events.inbound   events to     step_instance       writes OVERDUE /
         later)      stores in                            ACTIVE plan   step_sla_state_     MISSED + deviation)
                     inbound_event_log                    definitions)  transition (alarms)
                                                             ▲
                                          protocol service ──┘ plan definitions (refreshed every 60 s)

 ANALYTICS PATH (context; tested later)

 Postgres WAL ──► Debezium (replication slot) ──► Kafka ──► ClickHouse ──► insights service ──► dashboard UI
```

Why the analytics path still matters for this suite: every row a test writes or deletes is copied through it.
A cleanup that deleted 27 million rows in one transaction lost the Debezium replication slot in the first
test round, and ClickHouse then kept tens of millions of stale test rows. That is why cleanup works in
batches and watches the WAL ([known-results-and-lessons.md](known-results-and-lessons.md) §4).

## 3. Each service and how it is fed on its own

| Service | What it does | How this suite feeds it | How it is measured | Folder |
|---|---|---|---|---|
| **Collector** (`cce-collector-service`, local port 8093) | CCE's HTTP front door: `POST /v1/events` takes a CloudEvent, replies `202`, stores it in `inbound_event_log`, publishes it to Kafka | k6 posts CloudEvents over HTTP at a fixed arrival rate (no auth, `facilityid` in the body) | k6 latency (p95), failed requests, checks (`status is 202`), dropped iterations; Postgres: stored = accepted | [cce-collector-service/](../cce-collector-service/README.md) |
| **Matcher** (`cce-matcher-service`, metrics on 8097) | Consumes `cce.events.inbound`, matches each event against every ACTIVE plan definition, writes enrolments, steps and alarms; failures go to the dead-letter topic | k6 with the Kafka extension writes CloudEvents straight into the topic (key = patient id) | Node *backlog watcher*: consumer-group lag, processed per second, catch-up after sending stops; Postgres: logged = sent, all matched, enrolments = fan-out × patients | [cce-matcher-service/](../cce-matcher-service/README.md) |
| **Step SLA** (`cce-step-sla-service`, metrics on 8099) | Nobody calls it: every poll interval (5 s locally, 15 s in prod) it picks up alarms whose time has passed (at most 100 batches × 100 rows per cycle), marks the step `OVERDUE`/`MISSED` and writes a deviation | Node seeds enrolments, steps and alarms straight into Postgres with chosen ring times; **no k6** | Node *alarm watcher* (due gauge, counters); Postgres: per-alarm wait `processed_at − process_by`, every alarm handled, one deviation each | [cce-step-sla-service/](../cce-step-sla-service/README.md) |
| Protocol service (`cce-protocol-service`, 8096) | Stores plan definitions | Not tested; used to load the *plan-definition set* of a run | – | – |
| Adaptors (OpenHIM, Tiberbu) | Wrap the EMR's FHIR data in CloudEvents and forward them to the collector | **Later**, as independent modules (§7) | – | – (v1 OpenHIM test on the `ebuzima-flow-tests` branch) |

Feeding each service directly means: a collector test does not depend on an adaptor, a matcher test does not
depend on the collector's HTTP limits, and a Step SLA test can produce 100,000 alarms ringing at once without
waiting days for real deadlines.

**What the plan-definition set changes.** One event enrols a patient in every ACTIVE plan definition whose
triggers match it (the *fan-out*). With 4 overlapping plan definitions the first round's matcher did roughly
4 × the work per event, and Step SLA gets an alarm for every mandatory step with a deadline. The set is
therefore a test parameter: `PLAN_DEFINITION_SET` = `emr-service` (the protocol of the `ebuzima-emr` dataset)
or `kenya-sha-emr-service` (the Kenya SHA protocol of the `tiberbu-emr` dataset), one plan definition each.
The run sends the set's own dataset, and every result records the set together with any *other* ACTIVE plan
definitions that also match (*effective fan-out*).

## 4. How this suite is built

```
                  config/environments/<env>.json      config/settings/defaults.json      test-data/
                  (where the services are)            (every setting + default)          (datasets, plan-definition sets)
                                 \                              |                              /
 scripts/*.sh ──► node tools/cli.mjs <command> ──────────────────┴──────────────────────────────┘
 (thin entry       run · settings · preflight · cleanup · report · baseline · check-data ·
  points)          plan-definitions · lint-headers
                                 │
            ┌────────────────────┼─────────────────────────┐
            ▼                    ▼                         ▼
   cce-collector-service/  cce-matcher-service/   cce-step-sla-service/      ← one "service module" each:
   tests/*.test.js (k6)    tests/*.test.js (k6)   tests/*.test.mjs (Node)      test files, expectation,
   data-checks/            watchers/, data-checks/ seeding/, watchers/,         idle wait, watchers,
                                                   data-checks/                 data checks, extra rules
            │                    │
            └──── lib/ (shared k6 library: phase plan, scenarios, thresholds, test-data builders)
                                 │
                       Docker image cce-load-tests/k6:2.3.0-kafka2.2.0
```

- **One CLI, many small modules.** All logic is Node.js 22 (`tools/`); shell scripts only start it. The CLI
  finds each service folder through its `service-module.mjs`, so adding a service or an adaptor needs no
  change to shared code ([conventions.md](conventions.md) §7).
- **The same code in k6 and Node.** The phase plan, thresholds and test-data ids are *pure* modules in `lib/`
  that k6 runs and Node imports, so what the runner prints is exactly what k6 does.
- **JSON in, JSON out.** Settings come from `defaults.json`; k6 receives them in `run-context.json`; every
  step writes JSON; the report and baselines read only `result.json`.
- **Self-contained service folders.** Inside a service folder only two *shims* import shared code
  (`shared.mjs` for Node, `tests/shared-lib.js` for k6), so each folder can later be copied into its service
  repository as `performance-tests/` by rewriting those two files.

## 5. One run, step by step

`scripts/run-test.sh <env> <subject> <test-type>` (= `node tools/cli.mjs run …`; plan §0, §6.2):

| # | Step | Output in `results/<subject>-<test-type>-<yyyymmdd-hhmmss>/` |
|---|---|---|
| 1 | Load the environment (prod refused) and the service module; resolve settings (defaults → environment → env vars → `--set`); print settings, phase plan and the docker command. `--dry-run` stops here and writes nothing. | `run-context.json` |
| 2 | Preflight: health, metrics, Postgres (the right database), Kafka, consumer group, plan-definition set ACTIVE and not overlapped, disk, WAL/replication slots, autovacuum, leftovers, monitoring. A required failure stops the run (exit 2). | `preflight.json` |
| 3 | Conditions: machine, suite commit (read-only git), data volume, the ACTIVE plan definitions | (in `result.json`) |
| 4 | Wait until the service is idle (counters are global: a draining backlog from an earlier run would be counted) | |
| 5 | Prepare: Step SLA seeds its alarms and returns their ring times | `seed.json` |
| 6 | Start the metrics sampler (Hikari pool, heap, GC, CPU, service counters) and the watchers; Grafana annotation "run started" | `service-metrics.json`, `watch-*.json` |
| 7 | k6 in Docker sends the load and pushes its metrics to Prometheus (tags `testid`, `service`, `test_type`, `plan_definition_set`, `environment`). Seeded runs wait until the last alarm rang. | `k6-summary.json`, `k6.log` |
| 8 | Watchers wait for the backlog to clear (or give up at the limit, or abort on a stall) | |
| 9 | Data checks: SQL counts in Postgres prove nothing was lost or doubled | `data-checks.json` |
| 10 | Build the result (verdict, expectation vs result, when it started breaking, what broke) and render the report | `result.json`, `report.md` |
| 11 | Optional: compare with a baseline | `baseline-comparison.json` |

### 5.1 The k6 clock

k6 starts its scenarios only after it has created all its virtual users and run `setup()`. With thousands
of VUs — and one Kafka producer per VU in the matcher tests — that can take many seconds. If the runner
counted from `docker run`, "started breaking 31 s into the measured phase" would be wrong by that much. So:

```
 docker run ──► VU init (seconds; not measured) ──► setup() returns markK6Start()  = "time 0"
                                                     │
                       warm-up phase  [0 s, 60 s) ───┤
                       measured phase [60 s, 660 s) ─┘  measureStart = time 0 + 60 s, sendEnd = measureStart + 600 s

 live:       the runner polls the k6 REST API (GET /v1/status) every 250 ms → learns "time 0" → watchers start
             counting "seconds into the measured phase" (timing.source: k6-rest-api)
 afterwards: every time is re-based on the stamp k6 wrote into k6-summary.json (timing.source: k6-setup)
 fallback:   API silent for 60 s → times estimated from the container start (timing.source: estimated, warning)
 seeded:     Step SLA takes measureStart / sendEnd from the seed (first and last alarm ring; timing.source: seed)
```

If k6 stops early (abort rule, stall, Ctrl-C), `sendEnd` becomes the time k6 exited and the result says
`sendEndedEarly: true`. Ctrl-C or a watcher abort stops k6 with SIGINT, so k6 still writes its summary.

## 6. Feasibility and gaps

Testing collector, matcher and Step SLA on their own is **feasible and built** (requirement R12): HTTP for the
collector, Kafka for the matcher, seeded alarms for Step SLA. Adaptors come later as independent modules. The
gaps found, and what the suite does about each:

| Gap | Consequence | What the suite does |
|---|---|---|
| Matcher and Step SLA counters are **global** (not per test) | Two tests at once, or a backlog left from the last run, mix into the numbers | Run one test at a time; every run waits for idle first (`IDLE_FLAT_DURATION`, `IDLE_TIMEOUT`) |
| The matcher's consumer lag is **not in its actuator** | No metric says how many events wait | The backlog watcher reads the lag through the Kafka admin API (kafkajs); the laptop stack adds kafka-exporter for Grafana |
| No **server-side latency histograms** | No p95 from the services themselves | Percentiles come from k6 only (HTTP); matcher time per event = average from its duration sum/count |
| A collector test also **feeds the matcher** (events go to Kafka), and both share Postgres | A draining matcher slows the collector; collector tests leave matcher work behind | The collector run waits for matcher idle first, reports the matcher backlog it left (`collector.downstream-backlog-left`), and cleanup removes both services' rows |
| Step SLA and the matcher need the Matcher V8 objects (`step_group_instance` table, `step_instance.step_group_instance_id`), which no matcher migration creates yet | Without them Step SLA does not start (Hibernate `ddl-auto: validate` fails) and the matcher fails on its first `step_instance` insert; the suite's seeding itself does not touch them | Preflight check `schema-step-groups`; on the laptop, local-stack patch `01-step-group-instance.sql` provides the objects |
| Step SLA's readiness does not cover the database | "UP" while it cannot work | Preflight also checks that its evaluator cycle counter increases (`step-sla-scheduler`) |
| Shared Dev/UAT have real traffic | Lag never exactly 0; test plan definitions also match real events | Open questions (team decisions) in [open-questions.md](open-questions.md) |

## 7. Later modules

- **Adaptors** (OpenHIM, Tiberbu): an independent folder per adaptor repository with the same
  service-module interface, fed over HTTP like the collector; the v1 OpenHIM test on the `ebuzima-flow-tests` branch is
  the reference. Steps: [conventions.md](conventions.md) §7.3.
- **End-to-end flow** (EMR → … → Step SLA, event → enrolment p95 < 10 s): an `end-to-end-flow/` module using
  dataset journeys; until it exists the series report's "whole flow" section shows the weakest link
  (lowest of collector capacity and matcher drain rate). The v1 flow is on the `ebuzima-flow-tests` branch.
- **Analytics path**, soak, spike/backfill, recovery and matcher-scaling tests: not built yet
  ([test-strategy.md](test-strategy.md) §13).
