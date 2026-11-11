<!--
  What:    Test plan of the CCE matcher service performance tests: what is tested, how it is fed and
           measured, the four test types with their defaults, thresholds and expectations, data checks,
           Grafana panels, plan-definition variations, recorded conditions, risks and the commands.
  How:     Read before running or changing a matcher test; numbers marked TBC are "to be confirmed from
           UAT/Dev data" (or by the team) and are settings, so they change without code edits.
  Needs:   ../README.md (overview), config/settings/defaults.json (every default quoted here),
           specs/000-performance-testing-setup/plan.md §6.6, §6.8, §10.2.
  Outputs: Documentation only.
-->

# CCE Matcher Service Performance Tests — Test Plan

**Service** cce-matcher-service, release-2.0.0 · **Subject** `matcher` · **Test types** smoke, load,
stress, breakpoint (flood) · **Status of thresholds** to be confirmed from UAT/Dev data (spec 007)

## 1. What is tested

The matcher is CCE's matching engine. For every CloudEvent on Kafka `cce.events.inbound` it:

1. skips the event if `(id, source)` was seen before (counted as a duplicate);
2. writes one `matcher_event_log` row;
3. matches the event against the triggers of every **ACTIVE** plan definition (the set is refreshed every
   60 s for condition-only triggers);
4. for each plan definition that matches, enrols the patient (`protocol_instance`), creates the triggered
   step and the next mandatory steps (`step_instance`), their history rows and the SLA transitions Step SLA
   will act on later;
5. commits the Kafka offset **after** the database transaction. A consumer lag of 0 therefore means that
   every event is stored.

The tests measure **throughput and keeping up**: how many events per second the matcher processes, how far
its backlog grows at a given arrival rate, and how fast it drains a backlog. They also prove that every
event reached the database.

**Not tested here:** the collector's HTTP path (cce-collector-service tests), Step SLA's verdicts
(cce-step-sla-service tests), adaptors, the end-to-end flow (later modules), retries and dead-lettering
under injected faults, scaling to more consumers or partitions, and recovery from Kafka outages (later
work).

## 2. How it is fed and measured

**Fed by k6, straight into Kafka.** The collector is bypassed. k6 (image
`cce-load-tests/k6:2.3.0-kafka2.2.0` with xk6-kafka) writes one message per iteration:

| Part | Value |
|---|---|
| Topic | `cce.events.inbound` (25 partitions on local-stack); `environment.kafka.inboundTopic` |
| Key | the patient id, as the collector does: one patient's events stay on one partition, in order |
| Value | CloudEvent JSON with lowercase attribute names (`specversion`, `id`, `source`, `type`, `subject`, `time`, `facilityid`, `data`, …), built from the dataset template; no Kafka headers |
| Ids | patient `LOADTEST-<runId>-mat-<phaseIndex>-<n>`, event id `<patientId>-1` (one new patient per event) |
| Source | `EVENT_SOURCE` (default: the dataset's `loadtest-emr`) |
| Load model | open: arrival-rate executors start iterations on schedule, whether or not earlier ones finished |
| Producers | one xk6-kafka producer per virtual user (VU), created when k6 starts (`KAFKA_PRE_ALLOCATED_VUS` / `KAFKA_MAX_VUS`) |

xk6-kafka hands each message to its producer and returns. It does not wait for the broker, so k6's
"accepted" only means "handed over". Delivery is proven from outside.

**Measured by the backlog watcher** (`watchers/backlog-watcher.mjs`), every `WATCH_INTERVAL` (5 s):

| Signal | Source |
|---|---|
| Backlog | consumer-group lag of `cce-matcher-service` on the inbound topic (Kafka admin, kafkajs). The matcher does not export Kafka client lag metrics |
| Processed | `sum(cce_events_matched_total)` (both `status` series) + `cce_events_duplicate_total`. `cce_events_processed_total` is not used because it counts retries twice |
| Processed per second, drain rate | Δ processed / Δ time; the drain rate is that value while more than `MATCHER_MAX_BACKLOG` events wait |
| Processing time | Δ `cce_events_processing_duration_seconds_sum` / Δ `_count` (average) and `_max` (slowest) |
| Errors | `cce_consumer_inbound_errors_total` |
| Dead letters | sum of the end offsets of `cce.events.inbound.dlq` at the start and at the end |

The watcher starts sampling before k6 starts. It reads the measured-phase start and the send end from the
**k6 clock** (the end of k6's `setup()`), not from the Docker start. Creating hundreds of Kafka producers
can take many seconds, and those seconds must not count as matcher time.

**Also measured:** k6's own metrics (`kafka_writer_message_count`, `kafka_writer_error_count`,
`dropped_iterations`, `checks`), the shared service-metrics sampler (Hikari pool, heap, GC, CPU and the
matcher counters in `service-metrics.json`), and the data checks (§5).

## 3. Test types and defaults

Every number is a setting: override it per run with `--set NAME=value` or an environment variable of the
same name. You can give a rate and a duration, or a total number of events (`*_EVENTS`, from which the
duration is derived).

| Type | What it answers | Sending (defaults) | Events | Settings | k6 producers (ready / most) | Waits after sending |
|---|---|---|---|---|---|---|
| smoke | Does the path work end to end? | 1/s for 30 s, no warm-up | 30 | `SMOKE_RATE`, `SMOKE_DURATION` or `SMOKE_EVENTS` | 2 / 4 | `CATCH_UP_LIMIT` 2 min |
| load | Does it keep up at the expected peak? | warm-up 10/s for 1 min, then 50/s for 10 min | 600 + 30,000 | `WARM_UP_RATE`, `WARM_UP_DURATION`, `LOAD_RATE`, `LOAD_DURATION` or `LOAD_EVENTS` | 25 / 200 | `CATCH_UP_LIMIT` 2 min |
| stress | Does it withstand 4 × peak? If not, when does it fall behind? | warm-up, then 200/s for 10 min | 600 + 120,000 | `STRESS_RATE`, `STRESS_DURATION` or `STRESS_EVENTS` | 100 / 500 | `CATCH_UP_LIMIT` 2 min |
| breakpoint (flood) | What is its capacity (drain rate)? | warm-up, then 2,000/s for 1 min | 600 + 120,000 | `MATCHER_FLOOD_RATE`, `MATCHER_FLOOD_DURATION` or `MATCHER_FLOOD_EVENTS` | 100 / 500 | `BREAKPOINT_CATCH_UP_LIMIT` 15 min |

The peak is `PEAK_RATE` = 50 events/s (a design figure, TBC) and the headroom is `EXPECTED_HEADROOM` = 4
(TBC). The k6 producer limits `KAFKA_PRE_ALLOCATED_VUS` = 100 and `KAFKA_MAX_VUS` = 500 are the v1 values
(TBC: are they enough for the 2,000/s flood on a separate k6 host?). They apply to Kafka tests instead of
`MAX_VUS` because each VU owns a librdkafka producer. Watcher settings: `WATCH_INTERVAL` 5 s,
`STALL_TIMEOUT` 30 s, `IDLE_FLAT_DURATION` 30 s, `IDLE_TIMEOUT` 5 min, `BREAK_CONSECUTIVE_WINDOWS` 2.

The matcher has no HTTP latency to climb a staircase against. Its breakpoint is therefore a **flood**: far more
than it can take, sent in one minute, and then the speed at which the backlog drains. That speed is its
capacity, and it does not depend on k6 keeping up.

## 4. Thresholds and expectations

**Expectation** (printed next to every result): load: withstand 50 events/s (1 × peak) for 10 min.
Stress: withstand 200 events/s (4 × peak). Flood: drain at ≥ `EXPECTED_HEADROOM` × `PEAK_RATE` = 200
events/s. Each expectation names the plan-definition set and its fan-out. All are TBC.

| Rule (id) | Pass when | Tests | Setting | Status |
|---|---|---|---|---|
| `matcher.backlog` | the backlog is never above 1,000 events in a sample (rule `max <= 1000`) | smoke, load, stress | `MATCHER_MAX_BACKLOG` | TBC |
| `matcher.catch-up` | after sending ended, the backlog fell to ≤ 10 within 30 s. The watcher waits up to `CATCH_UP_LIMIT` (2 min). If the backlog has not cleared by then, the result is "not caught up: N events still waiting after S s", and no catch-up time is given | smoke, load, stress | `MATCHER_MAX_CATCH_UP`, `CATCH_UP_LIMIT` | TBC |
| `kafka_writer_error_count` | 0 Kafka write errors in k6 | all | `MATCHER_MAX_KAFKA_WRITE_ERRORS` | TBC |
| `matcher.dead-letters` | 0 new records on the dead-letter topic. If the topic cannot be read, the rule is shown as "not measured" and does not decide the verdict | all | `MATCHER_MAX_DEAD_LETTERS` | TBC |
| `dropped_iterations` | fewer than 0.1 % of the planned events dropped by k6. The exact count is reported | all | `MAX_DROPPED_RATE` = 0.001 | to be confirmed by the team |
| `checks` | > 99 % of sends handed to Kafka | all | `MIN_CHECKS_RATE` | TBC |
| `matcher.drain-rate` | informational: the median drain rate is > 0, and it is reported against the target of 200 events/s | breakpoint | `EXPECTED_HEADROOM`, `PEAK_RATE` | TBC |
| `matcher.processing-time` | informational: the slowest event took < 500 ms. This stands in for a p99 (see below) | all | — (CCE alert level) | candidate, TBC |
| `matcher.backlog-watcher` | the backlog watcher ran. Without it the run cannot pass | all | — | — |

**Why 500 ms is only a candidate:** CCE's alert rules (`deploy-scripts/prometheus/alert-rules.yml`,
`CceComplianceSlowProcessing`) alert when the p99 of `cce_events_processing_duration_seconds` is above 0.5 s
for the 1.x compliance service job. The 2.0 matcher exports no histogram buckets for that timer (only `_sum`,
`_count` and `_max`), so a p99 cannot be computed. The test reports the average and the maximum instead
(open question 7: enable percentile histograms).

**When it started breaking** (stress, flood, and any failed run): the first measured sample that starts
`BREAK_CONSECUTIVE_WINDOWS` (2) samples in a row with a backlog above `MATCHER_MAX_BACKLOG`. It is given as a
clock time and as seconds into the measured phase. **What broke** lists, in plain words, for example "up to
28,810 events waiting (rule ≤ 1,000)", "not caught up: 11,474 events still waiting after 120 s", and any
service signal that peaked near that moment (Hikari pool waiting, GC pause, heap).

## 5. Data checks

These run after the watcher finishes (`data-checks/matcher-data-checks.mjs`) and can be repeated later with
`node tools/cli.mjs check-data local <resultDir>`. "Sent" is k6's `kafka_writer_message_count` (fallbacks:
`events_accepted`, `events_sent`).

| Check | Expected | Severity |
|---|---|---|
| `matcher.logged-equals-sent` | `matcher_event_log` rows of the run = sent | required (info while the matcher is still draining) |
| `matcher.all-matched` | rows with `processing_status = 'MATCHED'` = logged rows (a ZERO_MATCH means the set is not ACTIVE or not refreshed) | required |
| `matcher.patients-enrolled` | distinct `protocol_instance.patient_id` of the run = sent (one new patient per event) | required (info while draining) |
| `matcher.enrolments-equal-fan-out` | `protocol_instance` rows = effective fan-out × enrolled patients | required |
| `matcher.steps-created` | `step_instance` rows = expected rows per event × logged events ("at least" when other ACTIVE definitions also match) | info until a live smoke confirms the formula |
| `matcher.no-dead-letters` | dead-letter growth measured by the watcher ≤ `MATCHER_MAX_DEAD_LETTERS` | required (info when not measured) |

The queries are index-friendly and safe on large tables. Candidate event ids are generated from the phase
plan, plus a margin of 1 % + 10 per phase (k6 may start an iteration or two more than planned at a phase
edge, and those events are sent and counted too; the same rule as the collector checks and cleanup), and
joined on the unique `(cloudevents_id, source)` index, instead of a `LIKE` scan.
`protocol_instance` and `step_instance` (UUIDv7 ids) are first bounded by `id >= ` the UUIDv7 floor of the
run start minus 5 min, and only then filtered with `patient_id LIKE 'LOADTEST-<runId>-mat-%'`. Every query
runs with `statement_timeout` (5 min), and its SQL and duration are kept in `data-checks.json`.

When a stress run did not catch up, the matcher is still working through the events when the checks run.
The counts that depend on draining are then `info`, with a hint to re-run `check-data` once the matcher is
idle. The ratio checks (all matched, enrolments per patient) stay required.

## 6. Grafana panels to watch

Dashboard **CCE Matcher Service — Performance** (`monitoring/grafana/dashboards/cce-matcher-service-performance.json`,
provisioned on the laptop stack and importable into CCE's Grafana):

| Row | Panels | What to look for |
|---|---|---|
| k6 → Kafka (filtered by run id and test type) | messages written / errors per second; dropped iterations per minute; VUs | writes at the planned rate, 0 errors, no drops; VUs near `KAFKA_MAX_VUS` means k6 is the limit |
| Backlog (not filtered by run) | arriving vs processed per second; consumer lag; dead-letter topic size | processed tracking arriving; lag flat near 0 under load, a straight drain line after a flood; DLQ flat |
| Matching (not filtered by run) | matched vs zero-match per second; duplicates; inbound errors; processing time (avg, max); trigger matching time; Kafka listener time; active protocol instances | zero-match and errors at 0; processing time rising with fan-out or data volume |
| Database pool, JVM and container | Hikari connections; heap; longest GC pause; container CPU and memory | pending connections > 0 or long GC pauses near the moment it started breaking |

Service panels are not filtered by run (the counters are global), which is one more reason to run one test
at a time. Grafana annotations mark the start and end of each run.

## 7. Plan-definition variations

The fan-out drives the matcher's cost. Each matching plan definition adds an enrolment, its steps, history
rows and SLA transitions in the same transaction. Choose the set with `PLAN_DEFINITION_SET`. The set,
its fan-out and the plan-definition snapshot are recorded with every result, and baselines refuse to mix
sets.

| Set | Plan definition | Events sent | Per enrolment event | What it shows |
|---|---|---|---|---|
| `emr-service` (default) | the EMR Service protocol (10 steps, triggers on display labels) | `ebuzima-emr`, `visit-encounter` | 1 enrolment, 2 step rows, 2 SLA transitions | the first EMR's protocol |
| `kenya-sha-emr-service` | the Kenya SHA protocol (15 steps, triggers on LOINC/SNOMED/HL7 codes) | `tiberbu-emr`, `consent-request` | 1 enrolment, 2 step rows, 2 SLA transitions | the second EMR's protocol: more trigger rows, coded matches |

The overlapping sets of the first round (`overlapping-2`, `overlapping-4`: generated variants of the EMR Service
protocol) were removed on 2026-11-11; the v1 numbers below that use four definitions are history.

Expected rows come from one shared formula (`tools/plan-definitions/expected-rows.mjs`). It is used by the
data checks, by Step SLA's peak and by these docs.

**Laptop evidence (v1, local-stack):** about **551 events/s** with the single definition (3.6 ms per event),
and about **156–179 events/s** with four (≈ 16 ms per event; the lower figure was measured on a bigger
database). With four overlapping definitions, stress at 200/s failed on a laptop: in v1 the backlog
reached 28,811, and 11,474 events were still waiting 120 s after sending. Which plan definitions UAT and
prod really run matters more than any code tweak (open question 8).

**Other ACTIVE plan definitions** that also match the dataset's events would silently raise the fan-out.
Preflight therefore fails for the matcher when such definitions exist, unless
`ALLOW_OTHER_ACTIVE_PLAN_DEFINITIONS=true`. In that case it only warns, the conditions record them, the
enrolment check expects the effective fan-out (set + others), and the steps check becomes "at least".

## 8. Conditions recorded

Every `result.json` records: the environment and host (name, CPUs), the k6 image, the suite's git commit
(read-only), the dataset, the plan-definition set (name, fan-out, effective fan-out, canonicals, other
ACTIVE definitions), every resolved setting with its source, the data volume (database size and live rows
of the main tables), the timing source (`k6-setup`, `k6-rest-api` or `estimated`) and the preflight
outcome. Results are only comparable when these match. The baseline tool warns when they differ.

## 9. Risks and known limits

- **Global counters.** The matcher's counters and its consumer group count every event, not just this
  run's. Run one test at a time. The runner waits for the matcher to be idle (lag 0, processed counter flat
  for `IDLE_FLAT_DURATION`) and refuses after `IDLE_TIMEOUT`.
- **Collector runs leave a backlog.** Every collector event is also matched. A collector stress run can
  leave the matcher draining for minutes. The collector report shows "matcher still draining N events",
  and the next matcher run waits for it.
- **Leftover test data.** Earlier runs' rows make the database bigger and the matcher slower (179 → 156/s
  above). Preflight warns about recent LOADTEST data. Clean up after each series
  (`scripts/cleanup-test-data.sh`), and compare results only at similar data volume.
- **Laptop numbers.** Laptop numbers are not production numbers: one matcher instance, local Postgres and
  Kafka, and k6 on the same machine competing for CPU. Treat them as relative (before/after a change, set
  vs set).
- **k6 as the limit.** At 2,000/s, k6 may not send the whole flood on time (dropped iterations). The drain
  rate stays valid, because it is measured on the matcher's side. Kafka tests never report a "k6 limit"
  verdict; dropped iterations are reported as dropped.
- **"Accepted" is not "stored".** xk6-kafka returns before the broker confirms. If the broker is
  unreachable, k6 reports success. The watcher catches this as a stall (events not processed for
  `STALL_TIMEOUT`) and stops the load.
- **Restarts.** A matcher restart mid-run resets its counters. The watcher detects the decrease, stops the
  load and marks the run aborted, because its numbers would no longer add up.
- **Protocol refresh.** Condition-only triggers are refreshed every 60 s. `scripts/manage-plan-definitions.sh
  load local --set <name>` waits `PROTOCOL_REFRESH_WAIT` after loading for that reason, and preflight checks
  that the set is ACTIVE. If you load definitions another way, wait one refresh yourself.
- **Warm-up.** One minute at 10/s keeps JVM start-up slowness out of the measurement (`WARM_UP_*`, TBC).
- **Cleanup side effects.** Cleanup deletes many rows. Watch WAL and replication slots on shared
  environments (cleanup checks disk and WAL first, and refuses while the matcher is still processing).
- **No server-side percentiles** (no histogram buckets): only average and maximum processing time.

## 10. How to run

```bash
# Before a series
scripts/check-services.sh local --subject matcher         # preflight only, no load
scripts/manage-plan-definitions.sh status local --set emr-service

# The tests
scripts/run-test.sh local matcher smoke
scripts/run-test.sh local matcher load
scripts/run-test.sh local matcher stress
scripts/run-test.sh local matcher breakpoint

# Change the load without editing code
scripts/run-test.sh local matcher load --set LOAD_RATE=80 --set LOAD_DURATION=5m
scripts/run-test.sh local matcher stress --set STRESS_EVENTS=60000
scripts/run-test.sh local matcher stress --set PLAN_DEFINITION_SET=kenya-sha-emr-service
scripts/run-test.sh local matcher load --dry-run           # settings, phase plan, k6 command; nothing runs

# Afterwards
scripts/build-report.sh results/matcher-stress-<yyyymmdd-hhmmss>
node tools/cli.mjs check-data local results/matcher-stress-<yyyymmdd-hhmmss>   # once the matcher is idle
scripts/manage-baselines.sh compare local-emr-service results/matcher-load-<yyyymmdd-hhmmss>
scripts/cleanup-test-data.sh local --run-id <runId> --dry-run
scripts/cleanup-test-data.sh local --run-id <runId>
```
