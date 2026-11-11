<!--
  What:    Feature specification for work package B2: performance tests of the CCE matcher service, fed
           straight into Kafka by k6 and measured by a Node backlog watcher (consumer-group lag + counters)
           and SQL data checks.
  How:     Read top to bottom. plan.md (same folder) says how it is built; tasks.md lists the sub-tasks.
  Needs:   specs/000-performance-testing-setup/spec.md (R1, R2, R3, R7, R9, R11, R12, R13, D9, D12, D19) and
           plan.md (§1.2, §2, §3.2, §3.3, §4, §5.2, §6.2–§6.6, §6.8, §6.9, §7.1, §7.3, §8.3, §10, §12).
  Outputs: The requirements and acceptance criteria B2 is checked against.
-->

# Feature Specification: Matcher performance tests

**Feature Branch**: n/a (folder only; suggested branch feature/matcher-performance-tests)
**Created**: 2026-11-06
**Status**: Implemented (static verification only, D14); first live smoke deferred to the owner
**Input**: Team lead's review points R1 (concise report: load through, when it broke, what broke, expectation vs
result), R2 (plan-definition sets as a parameter), R3 (service-level tests per repository), R7 (test plan and
strategy per service), R9 (events per interval configurable), R11 (header comments), R12 (matcher fed directly
over Kafka), R13 (spec-driven); blueprint `specs/000-performance-testing-setup/plan.md` §6.6 and §10.

## Goal

Measure how many events per second the CCE matcher service can take from Kafka (`cce.events.inbound`) while
keeping up, for any plan-definition set. k6 writes CloudEvents straight into the topic at a chosen rate; a Node
watcher follows the matcher's consumer-group lag (the backlog) and its counters until it catches up or a limit
passes; SQL data checks prove every event was logged, matched and enrolled with the expected fan-out. The
result says how much load went through, when the backlog started to grow past the limit, whether and how fast it
caught up, and (flood) the drain rate — the matcher's real capacity.

## Scope

### In scope
- `cce-matcher-service/` as a self-contained folder (plan §10.1): `README.md`, `docs/test-plan.md`,
  `docs/test-strategy.md`, this spec folder, `service-module.mjs`, the two shims `shared.mjs` and
  `tests/shared-lib.js`, k6 tests `tests/matcher-{smoke,load,stress,breakpoint}.test.js` with the shared
  `tests/matcher-scenario.js`, `watchers/backlog-watcher.mjs`, `data-checks/matcher-data-checks.mjs`,
  `unit-tests/` with fakes and fixtures.
- Test types smoke, load, stress, breakpoint (= the matcher "flood", `breakpointKind: 'flood'`).
- Backlog watcher of plan §6.5/§6.6 (sampling, catch-up, give-up, stall and restart aborts, DLQ delta, drain
  rate, started-breaking from the backlog series).
- Data checks of plan §6.8 (logged = sent, all matched, patients enrolled, enrolments = effective fan-out ×
  patients, steps created (info), no dead letters), index-friendly, with `statement_timeout`.
- Module-specific evaluation and the baseline metrics of plan §8.3.

### Out of scope
- Running anything against a live stack (D14): the first live smoke is a `DEFERRED (owner)` task.
- The collector path (B1), Step SLA (B3), adaptors (R4), the end-to-end flow (§10.4).
- `EVENT_MODE=journey` and `WORKLOAD_PROFILE` (reserved settings, later work).
- Changing shared code (`lib/`, `tools/`, `config/`, `test-data/`): requests are recorded in plan.md.
- Matcher scaling and recovery tests (more consumers/partitions, Kafka down): listed as later work.

## Inputs

- Resolved settings (A2 `resolveSettings`, plan §3.2/§3.3): `PEAK_RATE`, `EXPECTED_HEADROOM`, `SMOKE_*`,
  `LOAD_*`, `STRESS_*`, `WARM_UP_*`, `MATCHER_FLOOD_RATE`, `MATCHER_FLOOD_DURATION`, `MATCHER_FLOOD_EVENTS`,
  `KAFKA_PRE_ALLOCATED_VUS`, `KAFKA_MAX_VUS`, `MIN_CHECKS_RATE`, `MAX_DROPPED_RATE`, `MATCHER_MAX_BACKLOG`,
  `MATCHER_MAX_CATCH_UP`, `MATCHER_MAX_KAFKA_WRITE_ERRORS`, `MATCHER_MAX_DEAD_LETTERS`, `WATCH_INTERVAL`,
  `CATCH_UP_LIMIT`, `BREAKPOINT_CATCH_UP_LIMIT`, `STALL_TIMEOUT`, `IDLE_FLAT_DURATION`, `IDLE_TIMEOUT`,
  `BREAK_CONSECUTIVE_WINDOWS`, `ALLOW_OTHER_ACTIVE_PLAN_DEFINITIONS` (preflight), `PLAN_DEFINITION_SET`,
  `DATASET`, `EVENT_SOURCE`, `EVENT_ACTION_ID`, `FACILITY_ID`.
- Environment: `services.matcher` (metrics URL), `kafka.brokers`, `kafka.inboundTopic`, `kafka.deadLetterTopic`,
  `kafka.matcherConsumerGroup`, `database` (data checks).
- Run ctx (plan §6.4, A2 `run-test.mjs`): `times` (k6 clock), `kafkaAdmin`, `scrape(subject)`, `pgPool`,
  `planDefinitionSet` (with `effectiveFanOut`, `expectedRows`), `abortLoad`, `selector`, `resultsDir`.
- Shared code through the two shims only: `lib/` (run context, options, tagging, event builders, Kafka
  producer, counters, summary) and `tools/core/` (idle, watchers helpers, breaking analysis, run SQL,
  Prometheus parsing, formatting, results), `tools/plan-definitions/` (expected rows, set loading).
- Matcher facts (discovery, release-2.0.0): topic `cce.events.inbound` (25 partitions), DLQ
  `cce.events.inbound.dlq`, consumer group `cce-matcher-service`, key = patient id, value = CloudEvent JSON with
  lowercase attribute names, no headers; duplicate `(id, source)` skipped; offsets committed after the database
  transaction (lag 0 = all committed); counters `cce_events_matched_total{status}`, `cce_events_duplicate_total`,
  `cce_events_processed_total` (overcounts retries), `cce_consumer_inbound_errors_total`,
  `cce_events_processing_duration_seconds_{sum,count,max}` (no histogram buckets); protocol refresh 60 s.

## Outputs

- `results/matcher-<test-type>-<yyyymmdd-hhmmss>/` files written through the shared runner, plus
  `watch-backlog.json` `{schemaVersion, name:'backlog', intervalSeconds, samples:[{at, t, backlog, processed,
  processedPerSecond, drainRate, processingMsAvg, processingMaxMs, inboundErrors, sending}], outcome}`.
- `WatcherOutcome` (plan §6.5) with thresholds `matcher.backlog`, `matcher.catch-up`, `matcher.dead-letters`,
  `matcher.drain-rate` (breakpoint, informational), `breaking` (`startedBreakingAt`, `caughtUp`,
  `catchUpSeconds` | `remainingBacklog` + `gaveUpAfterSeconds`, `drainRate`, `whatBroke`), `load.eventsProcessed`,
  `aborted` (stall / restart).
- `DataCheck[]` (plan §6.8): `matcher.logged-equals-sent`, `matcher.all-matched`, `matcher.patients-enrolled`,
  `matcher.enrolments-equal-fan-out`, `matcher.steps-created` (info), `matcher.no-dead-letters`, each with `sql`
  and `durationMs`.
- Baseline metrics (plan §8.3): `matcher.load.maxBacklog`, `matcher.load.catchUpSeconds`,
  `matcher.stress.processedPerSecond`, `matcher.stress.maxBacklog`, `matcher.stress.secondsToBreak`,
  `matcher.{load,stress}.processingMsAvg`, `matcher.breakpoint.drainRate`.
- Exit codes are those of the shared runner (plan §5.7).

## Acceptance criteria

1. `node --check` passes for every `.mjs`/`.js` file in `cce-matcher-service/`.
2. `npm test` passes, including `cce-matcher-service/unit-tests/*.spec.mjs`, which cover: watcher catches up;
   watcher does not catch up (v1 stress case: 11,474 waiting 120 s after sending → `caughtUp: false`, no
   catch-up number); times re-based when `ctx.times.ready` resolves late; stall abort; restart (counter
   decrease) abort; missing metrics never throw; data checks with overlapping-4 fan-out and with one extra
   overlapping ACTIVE definition (`effectiveFanOut` 5); import boundary; evaluate; baselineMetrics; flood VUs.
3. `k6 inspect` (image `cce-load-tests/k6:2.3.0-kafka2.2.0`, `--network none`) succeeds for all four test files;
   the flood (breakpoint) `measure` scenario has `preAllocatedVUs` 100 and `maxVUs` 500.
4. `node tools/cli.mjs run local matcher <type> --dry-run` exits 0 for smoke, load, stress, breakpoint.
5. `node tools/cli.mjs lint-headers --paths cce-matcher-service` reports no problems; ESLint and Prettier pass on
   the folder.
6. Only `shared.mjs` imports `../tools/…` or `../lib/…` and only `tests/shared-lib.js` imports `../../lib/…`
   (checked by a unit test); no file imports another service folder.
7. No identifier, file or folder name in the folder contains "ebuzima" (dataset name only in prose).
8. Every task in tasks.md is ticked except the `DEFERRED (owner)` one.

## User Scenarios & Testing

### User Story 1 - Load test the matcher at peak (Priority: P1)

A tester wants to know whether the matcher keeps up with the expected peak of 50 events/s.

**Given** the local stack is up, the plan-definition set is loaded and preflight passes, **When** the tester runs
`scripts/run-test.sh local matcher load`, **Then** k6 writes 50 events/s for 10 minutes after a 1-minute warm-up,
the watcher reports the highest backlog and the catch-up time after sending stopped, the data checks prove every
event was logged, matched and enrolled once per plan definition, and the report says PASSED or FAILED with the
reason.

### User Story 2 - Stress: when does it start falling behind? (Priority: P1)

**Given** a stress run at 200 events/s (4 × peak), **When** the backlog grows past 1,000 and does not clear within
`CATCH_UP_LIMIT`, **Then** the result says when it started breaking (clock time and seconds into the measured
phase, from the backlog series), what broke ("up to N events waiting", "not caught up: N events still waiting
after 120 s") and never reports the give-up time as a catch-up time (v1 bug, D19).

### User Story 3 - Flood: measure the drain rate (Priority: P1)

**Given** a flood of 2,000 events/s for 1 minute, **When** the matcher works through the backlog, **Then** the
result reports the drain rate (median events/s while more than `MATCHER_MAX_BACKLOG` wait) against the target
`EXPECTED_HEADROOM × PEAK_RATE`, and whether it caught up within `BREAKPOINT_CATCH_UP_LIMIT`.

### User Story 4 - Compare plan-definition sets (Priority: P2)

**Given** `PLAN_DEFINITION_SET=overlapping-4`, **When** the run finishes, **Then** the data checks expect four
enrolments per patient (plus any other ACTIVE definition that matches the dataset, when allowed), and the set is
recorded with the result so runs with different sets are never compared silently.

### User Story 5 - Safe stops (Priority: P2)

**Given** the matcher stops consuming (Kafka unreachable, service down) or restarts mid-test, **When** nothing is
processed for `STALL_TIMEOUT` with more than 10 events waiting, or a counter goes down, **Then** the watcher stops
k6 through `ctx.abortLoad` and the run ends `aborted` with the reason and the data so far.

### Edge Cases

- k6 takes long to initialise its VUs (one Kafka producer each): the watcher samples from its own start but uses
  `measureStart`/`sendEnd` only after `ctx.times.ready`; earlier samples are re-based then.
- k6 stops early (abort rule, Ctrl-C): `ctx.times.sendEnd` moves to the k6 exit time; the watcher reads it on
  every sample and records `sendEndedEarly`.
- A metric is missing (matcher just restarted, scrape timeout): the sample holds `null`, a warning is recorded,
  stall detection pauses; nothing throws.
- The DLQ topic cannot be read: the dead-letter rule is "not measured" (informational), never a false pass.
- The matcher is still draining when the data checks run (stress not caught up): count checks that depend on
  draining become `info` with a hint to re-run `check-data` later; ratio checks stay required.
- Other ACTIVE plan definitions match the dataset: preflight fails unless `ALLOW_OTHER_ACTIVE_PLAN_DEFINITIONS`
  is true; then the expected enrolments use `effectiveFanOut` and the steps check becomes "at least".

## Requirements

- **FR-001**: The folder MUST contain the §10.1 layout and be self-contained: shared code only through
  `shared.mjs` (Node) and `tests/shared-lib.js` (k6).
- **FR-002**: The service module MUST declare `kind: 'k6'`, `breakpointKind: 'flood'`, test types smoke, load,
  stress, breakpoint, `requires: {services:['matcher'], postgres:true, kafka:true, protocol:true}`, a
  module-relative `testFile`, `waitForIdle` = `waitForMatcherIdle`, the backlog watcher, `SampledMetric`
  entries for the matcher counters, data checks, `evaluate` and `baselineMetrics`.
- **FR-003**: Each k6 test MUST be thin: options from `buildOptions({context, kind:'kafka'})`, `setup()` =
  `markK6Start()`, `handleSummary` = `writeSummary`, and the shared scenario writing one CloudEvent per iteration
  with key = patient id, ids `LOADTEST-<runId>-mat-<phaseIndex>-<n>(-1)`, recording `events_sent` /
  `events_accepted` and a check per send.
- **FR-004**: The watcher MUST sample every `WATCH_INTERVAL` from its own start with absolute times, append to
  `watch-backlog.json` after each sample, never throw on missing metrics, and finish with either
  `caughtUp: true, catchUpSeconds` or `caughtUp: false, remainingBacklog, gaveUpAfterSeconds`.
- **FR-005**: The watcher MUST abort the load (`ctx.abortLoad`) on a stall (backlog > 10, no progress for
  `STALL_TIMEOUT`) or a counter decrease, and report `aborted` with the reason.
- **FR-006**: Backlog = consumer-group lag from the Kafka admin; processed = `sum(cce_events_matched_total)` +
  `cce_events_duplicate_total` (not `cce_events_processed_total`, which counts retries).
- **FR-007**: Data checks MUST select the run's rows index-friendly (candidate ids joined on
  `(cloudevents_id, source)`; `protocol_instance` bounded by the UUIDv7 floor then the patient selector) and run
  with `statement_timeout`.
- **FR-008**: Enrolments MUST be compared with `effectiveFanOut × patients`; steps with
  `expectedRows.step_instance × events` (severity info until confirmed by a smoke run).
- **FR-009**: Thresholds and expectations MUST read every limit from the resolved settings and be marked "to be
  confirmed" where the settings are; no limit is hard-coded.
- **FR-010**: `baselineMetrics(result)` MUST read `result.json` only and never return a catch-up number when the
  run did not catch up.
- **FR-011**: Every file MUST carry the §2.4 header and why-comments for someone new to performance testing.
- **FR-012**: p99 processing time cannot be measured server-side (no histogram buckets)
  [NEEDS CLARIFICATION: enable percentile histograms on the matcher (open question 7)]; the module reports the
  average and the maximum processing time and an informational rule against the CCE alert level (500 ms).

## Success Criteria

- **SC-001**: All four test types inspect cleanly in k6 and dry-run cleanly through the CLI.
- **SC-002**: The v1 stress case (11,474 events still waiting after 120 s) yields `caughtUp: false`,
  `catchUpSeconds: null`, `gaveUpAfterSeconds: 120` and a failed `matcher.catch-up` rule.
- **SC-003**: A late k6 start (ready after 47 s of init) gives the same catch-up seconds as an immediate start.
- **SC-004**: The overlapping-4 set yields expected enrolments 4 × patients and expected steps 7 × events; one
  extra matching ACTIVE definition yields 5 × patients.
- **SC-005**: Someone new to the suite can run a matcher smoke test from the README Quick Start alone.
