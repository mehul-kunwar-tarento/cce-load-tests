<!--
  What:    Every term a newcomer meets in the CCE performance tests, in plain language: performance-testing
           words (arrival rate, VU, p95, dropped iteration …), CCE words (CloudEvent, plan definition,
           alarm …) and words this suite invented (k6 clock, run selector, effective fan-out …).
  How:     Look a word up when a report, a doc or a command uses it. Other docs link here.
  Needs:   Nothing.
  Outputs: Documentation only.
-->

# CCE Performance Tests — Glossary

Terms are grouped; inside a group they are alphabetical. *Italic* words are defined elsewhere on this page.
Where a term maps to a setting or a file, it is named in `code`.

## 1. Performance testing

**Arrival rate** — How many new *iterations* k6 starts per second (here: one event, or one request, per
iteration). This suite uses arrival-rate executors only (*open load model*), so the rate is what you set,
e.g. `LOAD_RATE=50` = 50 events per second.

**Average rate** — Events sent in the *measured phase* ÷ its length. The report's "went through … at an
average of X/s" excludes *warm-up*.

**Backlog** — Work that has arrived but is not done yet. Matcher: events waiting in Kafka (*consumer lag*).
Step SLA: alarms that have rung and are not handled yet (*due alarms*).

**Baseline** — "The numbers we normally get" for some tests under known *conditions*: the mean of at least
3 runs (`BASELINE_MIN_RUNS`), saved under a name in `baselines/<name>.json`. Later runs are compared with it
(better / worse / same within `BASELINE_TOLERANCE`). See [baselines/README.md](../baselines/README.md).

**Breaking point** — The load at which a service starts failing its *thresholds*. A measurement, not a rule:
it moves with the machine, data volume, warm-up and the number of ACTIVE *plan definitions*. For queue
services it equals their *capacity* (*drain rate*).

**Breakpoint test** — The test type that looks for the breaking point. HTTP (collector): a *staircase*.
Matcher: a *flood*. Step SLA: a *storm*.

**Capacity** — The most work per second a service gets through while still meeting its rules. HTTP: the
highest staircase level that held (`heldUpTo`). Queue services: the *drain rate*.

**Catch-up** — After sending stops (or the last alarm rang), the time until the backlog is back to (almost)
zero. If it does not get there within the limit (`CATCH_UP_LIMIT`, `BREAKPOINT_CATCH_UP_LIMIT`), the result
says "not caught up: N still waiting after S s" — never a catch-up time (lesson: v1 reported its give-up
time as a catch-up).

**Check** — A k6 `check()`: a named true/false test on one response (e.g. `status is 202`). The share of
passed checks has a threshold (`MIN_CHECKS_RATE`, > 99 %).

**Closed load model** — Each virtual user sends, waits for the answer, then sends again. When the service
slows, the load drops by itself, hiding the problem. This suite does **not** use it.

**Conditions** — Everything that can change a result besides the code: environment, machine, k6 image, data
volume, ACTIVE plan definitions, *dataset*, settings, preflight warnings. Saved in `result.json`
`conditions`; baselines warn when they differ.

**Data check** — After a run, SQL counts in Postgres that prove nothing was lost or doubled (e.g. "stored =
accepted", "enrolments = fan-out × patients"). `required` checks decide the verdict; `info` ones only
inform. Re-run them with `node tools/cli.mjs check-data <env> <resultDir>`.

**Diagnostic** — A service metric (DB pool waiting, heap, GC pause, Step SLA cycle cap) that started
misbehaving near the moment the run started breaking. Shown under "what broke" with source
`service-metrics`; it **explains** but never decides the verdict.

**Drain rate** — Events (or alarms) a queue service handles per second while a big backlog exists: its real
capacity. Reported for the matcher *flood* and the Step SLA *storm*.

**Dropped iteration** — An iteration k6 was supposed to start (open model) but could not, because every
*VU* was busy. A few are allowed (`MAX_DROPPED_RATE`, < 0.1 %, to be confirmed by the team); the report
gives the exact count. Dropped iterations with low service latency mean the *k6 limit*, not the service.

**Expectation** — What the service was expected to withstand, printed next to the result: load = 1 × *peak*,
stress = `EXPECTED_HEADROOM` × peak (4 ×), breakpoint = held at least that. Marked "to be confirmed" until
UAT/Dev data exists.

**Flood** — The matcher's breakpoint: far more events than it can handle (2,000/s for 1 min,
`MATCHER_FLOOD_RATE`, `MATCHER_FLOOD_DURATION`), then the watcher measures the drain rate.

**Iteration** — One run of a k6 test's default function. Here: build one CloudEvent and send it once.

**k6** — The load generator (Grafana k6), run in Docker with the Kafka extension (image
`cce-load-tests/k6:2.3.0-kafka2.2.0`). Only k6 generates load in this suite.

**k6 limit** — When k6 itself could not keep the rate (dropped iterations, or a window that sent less than
planned) while the service still answered fast (p95 < `K6_LIMIT_P95_MS`, 100 ms). Reported as "at least
X/s (k6 limit)": the load generator ran out, not the service. Only HTTP tests can show it (Kafka tests have
no latency to prove the service was fast).

**Load test** — 1 × peak for a normal busy period (default 50/s for 10 min after a 1-min warm-up).

**Measured phase** — The part of a run that counts: `measure` (or `smoke` for a smoke test). Warm-up is not
measured; `*_EVENTS` settings count measured events only.

**Open load model** — Arrival-rate executors keep sending at the set rate even when the service slows down,
so overload shows up as latency, errors, dropped iterations or backlog instead of silently lower load.

**p95 / p99** — The 95th / 99th percentile: 95 % (99 %) of requests were faster than this. Robust against a
few slow outliers, unlike the maximum; more honest than the average. CCE services export no latency
histograms, so percentiles come from k6 only.

**Peak** — The expected busiest rate: `PEAK_RATE` = 50 events/s (a design figure from the data-pipeline docs,
to be replaced by UAT/Dev data). "× peak" = a rate ÷ peak. Step SLA uses its own peak in alarms/s
(`STEP_SLA_PEAK_ALARM_RATE`).

**Phase / phase plan** — The schedule of a run: `smoke`, or `warm-up` then `measure` (constant rate or
staircase levels), each with rate, start, duration and *planned events*. Printed at the start of every run and
by `node tools/cli.mjs settings`.

**Planned events** — How many events the phase plan should send (rate × duration). Dropped and sent counts
are compared with it.

**Report window** — A slice of the measured phase (`REPORT_WINDOW`, 10 s, widened to keep ≤ 200 windows).
Windows find **when** a run started breaking: the first of `BREAK_CONSECUTIVE_WINDOWS` (2) broken windows
in a row.

**Shortfall** — A window or level that sent less than (1 − `RATE_SHORTFALL_TOLERANCE`) × planned: "k6 could
not send on time".

**Smoke test** — 1 event/s for 30 s: proves the path works end to end before anything heavier. Not a
performance measurement.

**Soak / spike test** — Not built yet: hours at peak (leaks, growth) / a sudden burst such as a clinic
uploading a day of events. Reserved test-type names.

**Staircase** — The HTTP breakpoint: rising levels (`LEVELS`, 200 → 6400/s), each held `LEVEL_DURATION`; the
run stops at the first broken level. *Held up to* = last good level, *broke at* = first bad one. Refine
between them with `--refine-from`.

**Storm** — The Step SLA breakpoint: 100,000 alarms (`STEP_SLA_STORM_ALARMS`) ringing at the same moment.

**Stress test** — `EXPECTED_HEADROOM` × peak (4 × = 200/s) for 10 min: the service should still pass.

**Threshold** — A fixed pass/fail rule (e.g. p95 < 500 ms). Thresholds decide the verdict; *breaking points*
are measurements. Rules marked "to be confirmed" (`toBeConfirmed`) wait for team or UAT/Dev data.

**VU (virtual user)** — A k6 worker that runs iterations. With arrival-rate executors k6 starts as many VUs
as needed up to `maxVUs`; when all are busy, iterations are dropped. Kafka tests: one VU = one Kafka
producer (`KAFKA_PRE_ALLOCATED_VUS`, `KAFKA_MAX_VUS`).

**Warm-up** — A short phase at a low rate (`WARM_UP_RATE` 10/s for `WARM_UP_DURATION` 1 min) before
measuring, so JVM start-up slowness (first request ~4 s, an 884 ms spike in v1) is not measured. `0s`
disables it.

## 2. CCE

**Adaptor** — Turns an EMR's data into CloudEvents and forwards them to the collector (OpenHIM, Tiberbu).
Out of scope for now; later an independent module.

**Alarm** — A row in `step_sla_state_transition`: "check this step at this time". `DUE_DATE_REACHED` alarms
ring when a mandatory step's deadline passes; `MISSED_DATE_REACHED` ring days later. Step SLA picks up rung
alarms (`next_attempt_at` and `process_by` passed), marks the step `OVERDUE`/`MISSED` and writes a
*deviation*.

**CloudEvent** — The standard envelope every event travels in (spec 1.0): `id`, `source`, `type`, `subject`
(the patient), `time`, `facilityid`, `correlationid`, `data` (the FHIR resource). `(id, source)` must be
unique: the collector rejects duplicates.

**Collector** (`cce-collector-service`) — CCE's HTTP front door: `POST /v1/events`, replies 202, stores the
event in `inbound_event_log`, publishes it to Kafka `cce.events.inbound`.

**Consumer group / consumer lag** — Kafka consumers sharing a topic form a group (`cce-matcher-service`).
Lag = messages written to the topic but not yet read by the group: the matcher's backlog.

**Dead-letter topic (DLQ)** — `cce.events.inbound.dlq`: where the matcher puts events it could not process.
New DLQ records during a run fail `MATCHER_MAX_DEAD_LETTERS` (0).

**Deviation** — The record Step SLA writes when a mandatory step was not done on time.

**Enrolment** — A `protocol_instance` row: a patient following one plan definition. One event can enrol a
patient in several plan definitions (*fan-out*).

**FHIR** — The healthcare data standard of the events (Encounter, Observation, …) and of plan definitions
(PlanDefinition).

**Mandatory step** — A plan-definition action with `requiredBehavior: "must"` and a `tolerance-days`
deadline. Only mandatory steps create alarms, so more mandatory steps = more Step SLA work.

**Matcher** (`cce-matcher-service`) — Reads `cce.events.inbound`, matches each event against every ACTIVE
plan definition, writes enrolments, steps and their alarms. No HTTP API.

**Plan definition** — A care protocol as a FHIR PlanDefinition ("check-in, then vitals within 1 day, …").
ACTIVE ones are what the matcher matches against. Held by the protocol service.

**Protocol service** (`cce-protocol-service`) — Stores plan definitions. Not on the event path; the matcher
refreshes its cache from the database every 60 s (`PROTOCOL_REFRESH_WAIT` waits 65 s after a change).

**Step** — A `step_instance` row: one action of an enrolment, `NOT_STARTED` or `COMPLETED`, with an SLA
status for mandatory steps.

**Step SLA** (`cce-step-sla-service`) — The deadline service: every poll interval (5 s locally, 15 s in prod)
handles rung alarms, at most 100 batches × 100 rows per cycle (10,000; the *cycle cap*). No API, no Kafka.

**Trigger** — The part of a plan definition that says which event starts an enrolment or completes a step
(resource type + code). Plan definitions with the same triggers *overlap*.

## 3. This suite

**Conditions snapshot** — See *conditions*; captured before the load starts.

**Dataset** — What the events look like: templates per action id, source, facility, journeys
(`test-data/datasets/<name>/dataset.json`, chosen with `DATASET`). The first one is `ebuzima-emr`.

**DEFERRED (owner)** — A task the static-only build could not do (a live run); left unticked for the owner.
Listed in [open-questions.md](open-questions.md).

**Effective fan-out** — Enrolments one event creates in practice: the set's fan-out plus other ACTIVE plan
definitions whose triggers also match the dataset's events (found by preflight). Data checks use it.

**Fan-out** — Plan definitions of the set that one event matches (1 for both shipped sets, `emr-service` and
`kenya-sha-emr-service`). The matcher does roughly fan-out × the work per event; other ACTIVE plan definitions
raise it (*effective fan-out*).

**Idle** — No work in progress: matcher lag 0 with counters flat for `IDLE_FLAT_DURATION`; Step SLA no alarm
due for that long. Every run waits for idle first (`IDLE_TIMEOUT`, then refused) because counters are global.

**k6 clock** — How Node knows when measuring really started. k6 starts its scenarios only after creating all
VUs and running `setup()`, which can take long (one Kafka producer per VU). Every test's `setup()` stamps
"time 0" (`markK6Start`); while k6 runs, the runner polls the k6 REST API (`GET /v1/status`) to learn the
same moment live; afterwards it re-bases all times on the stamp saved in `k6-summary.json`
(`timing.source` says which was used). Seeded Step SLA runs take their times from the seed instead.

**Load-test marker** — A FHIR `meta.tag` (`system http://openphc.org/fhir/CodeSystem/cce-performance-tests`,
code `loadtest`) that `plan-definitions load` adds. `retire` and `delete` refuse any plan definition without
it, so the tool never touches one it did not load.

**Plan-definition set** — Which plan definitions are ACTIVE together during a run
(`test-data/plan-definition-sets/<name>/set.json`, chosen with `PLAN_DEFINITION_SET`): `emr-service`
(default) or `kenya-sha-emr-service`. Named after the protocol; choosing it also chooses the dataset when
`DATASET` is empty. A test parameter, saved with every result.

**Preflight** — Checks before every run, separate from the smoke test: services healthy, Postgres/Kafka
reachable and the right ones, plan-definition set ACTIVE, disk and WAL headroom, monitoring. A failed
required check stops the run (exit 2). `scripts/check-services.sh`.

**Result folder** — `results/<subject>-<test-type>-<yyyymmdd-hhmmss>/` with `result.json` (the only input of
reports and baselines), `report.md` and the raw files.

**Run context** — `run-context.json`: the resolved settings, phase plan and environment Node hands to k6
(k6 never reads settings from environment variables).

**Run ID** — `yyyymmdd-hhmmss` of the run start (or a custom `RUN_ID` of 1–20 letters/digits). Tags the
results folder, the Grafana `testid` label and every test-data id.

**Run selector** — The id prefix that picks exactly one run's rows: `LOADTEST-<runId>-<idCode>-` with
`idCode` `col`, `mat` or `sla`. Because it ends with the id code, run `test` never matches run `test2`.

**Seed mode** — How Step SLA alarms are spread (`STEP_SLA_SEED_MODE`): `set` (default) round-robin over every
(plan definition of the set × its mandatory step with a deadline), so the set matters; `single-action` = v1's
behaviour (first plan definition, `STEP_SLA_ACTION_ID` only).

**Seeded test** — A test with no k6: Step SLA alarms are written straight into Postgres with chosen ring
times (`seed.json` records them).

**Service module** — `<service-folder>/service-module.mjs`: tells the shared runner what is special about a
service (test files, expectation, idle wait, seeding, watchers, data checks, extra rules, baseline metrics).

**Shim** — The one file per service folder that imports shared code: `shared.mjs` (Node) and
`tests/shared-lib.js` (k6). Copying the folder into its service repository means rewriting only these.

**Snapshot verification** — How cleanup proves it deleted everything: before deleting, it copies the ids it
will delete (`lt_<x>_all`); afterwards it counts rows still matching that snapshot **and** rows matching the
selectors directly (orphans written meanwhile). `verified` only when both are 0 for every table.

**Subject** — The short service name used in commands, results and Grafana: `collector`, `matcher`,
`step-sla`.

**Test-data tag** — Every id a run creates starts `LOADTEST-<runId>-` (patients
`LOADTEST-<runId>-<idCode>-<phase>-<n>`, events `<patientId>-<step>`, ≤ 50 characters), so cleanup and data
checks find exactly that run's rows.

**Watcher** — A Node loop that samples a service while the load runs (every `WATCH_INTERVAL`, 5 s): matcher
backlog watcher (Kafka lag, counters), Step SLA alarm watcher (due gauge, counters). It decides caught up / not
caught up and stops the load on a stall (`STALL_TIMEOUT`) or a service restart.

## 4. Monitoring

**Annotation** — A marker on a Grafana graph. k6 runs get a shaded region (from `k6_vus`); the runner posts
markers for every run (start/end, phases, started breaking, caught up), tagged `cce-performance` and the run id.

**cAdvisor / node-exporter / kafka-exporter / postgres-exporter** — Helpers in `monitoring/` that publish
container CPU/memory, host disk, Kafka lag and Postgres (connections, WAL, replication slots) to Prometheus.

**Hikari pool** — A service's database connection pool (collector 10 locally, Step SLA 3). "Pending" =
requests waiting for a connection: an early sign of database pressure.

**Prometheus remote write** — k6 pushes its metrics to Prometheus (`-o experimental-prometheus-rw`) instead
of being scraped. Labels: `testid`, `service`, `test_type`, `plan_definition_set`, `environment`.

**`testid`** — The Grafana variable / label holding the run ID. Step SLA runs have no k6 series: type the run
id, or add `&var-testid=<runId>` to the dashboard URL.

## 5. Database and operations

**Autovacuum** — Postgres's background clean-up of deleted rows. After a big cleanup it competes with the
next test (v1: collector p95 18 ms → 666 ms). Preflight warns while it runs.

**Debezium / CDC** — Change data capture: reads the Postgres *WAL* through a *replication slot* and copies
every change to Kafka → ClickHouse (the analytics path).

**Replication slot** — Postgres keeps WAL until the slot's reader (Debezium) has consumed it, up to
`max_slot_wal_keep_size`. One huge delete exceeded it in v1 and the slot was **lost**. Cleanup batches its
deletes and stops when a slot's safe WAL size falls below `CLEANUP_MIN_SAFE_WAL_GB`.

**UUIDv7** — Time-ordered ids CCE gives its rows; queries bound primary-key scans with the run's start
(`uuidV7Floor`) to stay fast on big tables.

**WAL (write-ahead log)** — Postgres's change journal. Every insert and delete writes WAL; a large cleanup
writes a lot of it (and, through Debezium, a Kafka message per deleted row).
