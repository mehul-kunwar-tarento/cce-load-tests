<!--
  What:    Feature specification of work package B1: the performance tests of cce-collector-service
           (HTTP POST /v1/events) — smoke, load, stress and breakpoint, their data checks, report figures
           and baseline metrics.
  How:     Read before plan.md and tasks.md (same folder). The contract it implements is
           specs/000-performance-testing-setup/plan.md (sections cited as §N).
  Needs:   specs/000-performance-testing-setup/{spec,plan}.md; the wave-A interfaces described in
           lib/README.md and tools/README.md.
  Outputs: Goal, scope, inputs, outputs and acceptance criteria that this folder's code is checked against.
-->

# Feature Specification: Collector performance tests

**Feature Branch**: n/a (folder only; suggested branch feature/collector-performance-tests)
**Created**: 2026-11-06
**Status**: Implemented (static verification only, D14); first live smoke deferred to the owner
**Input**: Work package B1 of `specs/000-performance-testing-setup/tasks.md`; plan §1.2, §2, §3.2, §3.3, §4,
§5.2, §6.2–§6.4, §6.6, §6.8, §6.9, §8.3, §10.1–§10.3, §12. Team lead's points 1, 3, 7, 9, 11, 12, 14.

## Goal

Measure how much event traffic the CCE collector service (the HTTP front door of CCE) takes on its own:
k6 posts CloudEvents to `POST /v1/events` at a configured arrival rate, and every run answers "how many
events went through in the measured interval, at what latency, did every accepted event get stored, and —
for stress and breakpoint — when did it start breaking and what broke", against a stated expectation
(1 × peak for load, 4 × peak for stress and breakpoint, all to be confirmed from UAT/Dev data). The folder is
self-contained so it can later be copied into the collector repository as `performance-tests/`.

## Scope

### In scope
- `cce-collector-service/service-module.mjs`: the plug-in the shared runner uses (§6.4).
- Four k6 tests (`tests/collector-{smoke,load,stress,breakpoint}.test.js`) sharing one iteration function
  (`tests/collector-scenario.js`), open load model (arrival-rate executors built by `lib/scenarios.js`).
- Data checks against Postgres (`data-checks/collector-data-checks.mjs`): stored = accepted, no rejections,
  downstream logged (info), matcher backlog left (info).
- Module-specific evaluation (throughput rule, k6-limit and staircase facts, notes) and baseline metrics.
- Waiting for the matcher to be idle before every collector run (shared Postgres, lesson 10).
- Two shims (`shared.mjs`, `tests/shared-lib.js`) as the only doors to the shared code.
- Documentation: `README.md`, `docs/test-plan.md` (10 sections, §10.2), `docs/test-strategy.md`.
- Unit tests with mocks and fixture k6 summaries (`unit-tests/`).

### Out of scope
- Adaptors (OpenHIM, Tiberbu) and the end-to-end flow (later independent modules, §10.4).
- A Node watcher for the collector (it answers every request, so k6 measures it directly; §10.1 "collector: none").
- `EVENT_MODE=journey` and `WORKLOAD_PROFILE` (reserved settings, later work).
- Any live run: verification is static only (D14). The first live smoke is a DEFERRED owner task.
- Changes to shared code (`lib/`, `tools/`, `config/`) — requests are recorded in plan.md.

## Inputs

- Settings (`config/settings/defaults.json`, §3.2), typed by `tools/core/settings.mjs`: `PEAK_RATE`,
  `EXPECTED_HEADROOM`, `SMOKE_*`, `LOAD_*`, `STRESS_*` (rate + duration or `*_EVENTS`), `WARM_UP_RATE`,
  `WARM_UP_DURATION`, `LEVELS`, `LEVEL_DURATION`, `MAX_VUS`, `HTTP_P95_LIMIT_MS`, `HTTP_MAX_FAILED_RATE`,
  `MIN_CHECKS_RATE`, `MAX_DROPPED_RATE`, `BREAKPOINT_MAX_DROPPED`, `K6_LIMIT_P95_MS`,
  `RATE_SHORTFALL_TOLERANCE`, `REPORT_WINDOW`, `BREAK_CONSECUTIVE_WINDOWS`, `IDLE_FLAT_DURATION`,
  `IDLE_TIMEOUT`, `DATASET`, `EVENT_ACTION_ID`, `EVENT_SOURCE`, `FACILITY_ID`, `PLAN_DEFINITION_SET`.
- `run-context.json` (§3.5) for k6: environment services, settings values, phase plan, dataset.
- Shared k6 library (`lib/`, A1): `getRunContext`, `assertRunContextFor`, `buildOptions`, `tagIteration`,
  `buildPatientId`, `buildEventId`, `buildCorrelationId`, `eventDefaults`, `buildFhirResource`,
  `buildCloudEvent`, `postJson`, `checkResponse`, `statusIs`, `jsonFieldEquals`, `recordSend`,
  `markK6Start`, `writeSummary`.
- Node core (`tools/core/`, A2): `waitForMatcherIdle`, `readMatcherBacklog` (idle.mjs),
  `candidateEventIdsSql`, `runTimedQuery` (run-sql.mjs), `normaliseK6Summary`, `metricValue`
  (k6-summary.mjs), `analyseWindows`, `analyseLevels`, `measuredP95` (breaking-analysis.mjs),
  `readJsonIfExists` (results.mjs), formatting helpers; `lib/phase-plan.js`, `lib/duration.js` pure functions.
- The runner's `ctx` (§6.4): `settings`, `phasePlan`, `selector`, `resultsDir`, `context`, `pgPool`,
  `kafkaAdmin`, `scrape`, `times`, `logger`; `evaluate` also gets `partial = { k6Summary, watcherOutcomes,
  dataChecks, times, phasePlan }`.
- The collector (release-2.0.0): `POST /v1/events`, `Content-Type: application/json`, no auth, structured
  CloudEvent with lowercase fields and `facilityid`; `id` ≤ 50 characters; 202 `data.status = "accepted"`;
  table `inbound_event_log` (unique `(cloudevents_id, source)`, `status` RECEIVED/ACCEPTED/REJECTED);
  actuator metrics `cce_collector_events_{received,accepted,duplicate}_total`,
  `cce_collector_kafka_publish_failure_total`, `http_server_requests_seconds_{sum,count,max}`, Hikari pool
  `cce-collector-pool` (10 connections).

## Outputs

- `node tools/cli.mjs run <env> collector <smoke|load|stress|breakpoint>` (and `scripts/run-test.sh …`)
  runs these tests; results go to `results/collector-<test-type>-<yyyymmdd-hhmmss>/` (§5.1).
- k6 metrics: `http_req_*` with name tag `POST /v1/events`, checks `status is 202` and `event accepted`,
  counters `events_sent` / `events_accepted`, tagged `testid/service=collector/test_type/…` (§9.3).
- `data-checks.json` entries: `collector.stored-equals-accepted` (required), `collector.no-rejections`
  (required), `collector.downstream-logged` (info), `collector.downstream-backlog-left` (info); each with
  its SQL text and duration.
- `evaluate()` → `{ thresholds: [collector.throughput], breaking: { k6Limited, heldUpTo, brokeAtRate },
  load: { eventsProcessed }, notes: [...] }`.
- Baseline metric keys: `collector.load.p95Ms`, `collector.load.averageRate`, `collector.stress.p95Ms`,
  `collector.stress.averageRate`, `collector.breakpoint.heldUpTo`, `collector.breakpoint.brokeAtRate`.
- Exit codes as §5.7 (decided by the shared runner from result.json).

## Acceptance criteria

1. `cce-collector-service/` has the §10.1 layout: `README.md`, `service-module.mjs`, `shared.mjs`,
   `docs/test-plan.md`, `docs/test-strategy.md`, `specs/001-collector-performance-tests/{spec,plan,tasks}.md`,
   `tests/` (four test files, `collector-scenario.js`, `shared-lib.js`), `data-checks/collector-data-checks.mjs`,
   `unit-tests/`.
2. Only `shared.mjs` imports from `../tools/` or `../lib/`, and only `tests/shared-lib.js` imports from
   `../../lib/`; no file imports another service folder (checked by a unit test).
3. `service-module.mjs` passes `validateServiceModule`; `testFile(type)` returns a `URL` of an existing file
   inside the folder for each of the four test types; `kind 'k6'`, `breakpointKind 'staircase'`,
   `requires.services ['collector']`, `postgres true`, `protocol true`.
4. Each test file asserts its subject and test type, builds `options` with `buildOptions({ context, kind:
   'http' })`, uses `markK6Start` as `setup` and `writeSummary` as `handleSummary`; `k6 inspect` of each
   (network none, fixture run context) succeeds.
5. Data-check SQL binds the event source as a parameter, selects through generated candidate ids joined on
   `(cloudevents_id, source)` (no `LIKE`), and runs with a statement timeout; the comparisons follow §6.8
   (equals; `between accepted and sent` for breakpoint or a run that ended early).
6. `evaluate` on fixture summaries: a passing load → throughput rule passed and `k6Limited false`; a load
   failing only on dropped iterations at low p95 → `k6Limited true`; a breakpoint → `heldUpTo`/`brokeAtRate`
   as the levels say, including a k6-limited staircase.
7. `node tools/cli.mjs run local collector <type> --dry-run` succeeds for all four types and
   `node tools/cli.mjs settings local collector load --set LOAD_EVENTS=1000` shows `LOAD_DURATION` 20 s with
   source `derived`.
8. Every file in the folder has the What/How/Needs/Outputs header (`lint-headers` passes) and ESLint/Prettier pass.
9. "ebuzima" appears in no identifier or file name of the folder (prose about the dataset only).

## User Scenarios & Testing

### User Story 1 - Run a collector load test and read the verdict (Priority: P1)
A tester new to performance testing wants to know whether the collector handles the expected peak.
**Given** a laptop running local-stack and `DB_PASSWORD` set, **When** they run
`scripts/run-test.sh local collector load`, **Then** the runner waits for the matcher to be idle, runs the
warm-up and 10 minutes at 50 events/s, and prints a report saying how many events went through, the p95,
whether every accepted event was stored, and PASSED/FAILED against the stated expectation.

### User Story 2 - Find where the collector breaks (Priority: P1)
**Given** the same stack, **When** the tester runs `scripts/run-test.sh local collector breakpoint`,
**Then** the staircase climbs 200 → 6400 events/s, stops at the first level that breaks, and the report says
"held up to X/s, broke at Y/s (Z × peak)" and what broke (latency, errors, DB pool waiting as diagnostic) —
or "at least X/s (k6 limit)" when the load generator, not the collector, was the limit. A second run with
`--refine-from results/collector-breakpoint-…` narrows the range, warming up at the last good level.

### User Story 3 - Change the amount of load without editing code (Priority: P2)
**Given** a tester who wants 1,000 events at the load rate, **When** they run
`scripts/run-test.sh local collector load --set LOAD_EVENTS=1000` (or `LOAD_EVENTS=1000` as env var),
**Then** the duration is derived (20 s at 50/s), printed at start and saved with the result.

### User Story 4 - Copy the folder into the collector repository later (Priority: P3)
**Given** the folder copied as `performance-tests/` into cce-collector-service, **When** a developer
rewrites the two shims to point at the vendored shared code, **Then** nothing else needs changing.

### Edge Cases
- The matcher is still draining a previous run: the collector run waits (up to `IDLE_TIMEOUT`) and refuses
  with exit 2 when it never becomes idle.
- k6 cannot send on time (laptop limit) while the collector answers fast: the verdict says "k6 limit", not
  a service failure.
- k6 stopped early (abort rule, Ctrl-C): stored rows are compared as "between accepted and sent", since a
  request cut off on the client may still have been stored.
- `DB_PASSWORD` missing: data checks cannot run; the runner records a failed `collector.data-checks-ran`.
- The matcher lag cannot be read (Kafka down): `collector.downstream-backlog-left` is "noted" with
  "not measured"; it never fails the run.
- k6 starts an iteration or two more than rate × duration at the edges: candidate ids include a margin.

## Requirements

- **FR-001**: The module MUST follow the §6.4 interface and be discovered by `tools/core/service-registry.mjs`.
- **FR-002**: Every test MUST send one new CloudEvent per iteration with ids `LOADTEST-<runId>-col-<phaseIndex>-<n>`
  (patient) and `<patient>-1` (event), ≤ 50 characters, built from the run-context dataset and `EVENT_ACTION_ID`.
- **FR-003**: Each request MUST carry the name tag `POST /v1/events` and two checks (`status is 202`,
  `event accepted`); `events_accepted` MUST count only requests where both passed.
- **FR-004**: Load MUST be generated with arrival-rate executors from the phase plan (open model); test
  files MUST NOT read env vars for settings.
- **FR-005**: Before each run the module MUST wait until the matcher is idle (`waitForMatcherIdle`).
- **FR-006**: Data checks MUST select the run's rows through generated candidate ids joined on
  `(cloudevents_id, source)` with the source bound as `$1`, with a statement timeout, and record SQL and duration.
- **FR-007**: `evaluate` MUST return only module-specific thresholds (k6 rules come from the result builder).
- **FR-008**: The module MUST sample `http_server_requests_seconds_{sum,count,max}{uri="/v1/events"}`,
  `cce_collector_events_{received,accepted,duplicate}_total` and `cce_collector_kafka_publish_failure_total`
  with exact labels (no wildcards).
- **FR-009**: Documentation MUST quote defaults from `config/settings/defaults.json` and mark unknown limits
  "to be confirmed from UAT/Dev data" / "by team".
- **FR-010**: The expected collector peak MUST come from `PEAK_RATE` (50/s design figure)
  [NEEDS CLARIFICATION: real peak from the UAT/Dev event-flow analysis, spec 007].

## Success Criteria

- **SC-001**: All four test types pass `run --dry-run` and `k6 inspect` with no network.
- **SC-002**: The folder's unit tests pass under `npm test` without any connection.
- **SC-003**: A report of a collector run answers the lead's questions (events through in the interval,
  expectation vs result, when it started breaking and what broke) from `result.json` alone.
- **SC-004**: Rewriting two files (`shared.mjs`, `tests/shared-lib.js`) is enough to relocate the folder.
