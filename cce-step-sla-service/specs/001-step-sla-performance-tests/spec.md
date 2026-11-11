<!--
  What:    Feature specification of work package B3: the performance tests of cce-step-sla-service
           (seeded alarms, alarm watcher, per-alarm wait data checks, service module for the shared runner).
  How:     Read before plan.md and tasks.md (same folder). The contract it implements is
           specs/000-performance-testing-setup/plan.md (sections cited as §N).
  Needs:   specs/000-performance-testing-setup/{spec,plan}.md; wave-A code (tools/core, tools/plan-definitions).
  Outputs: Goal, scope, inputs, outputs and acceptance criteria that B3's code is checked against.
-->

# Feature Specification: Step SLA performance tests

**Feature Branch**: n/a (folder only; suggested branch feature/step-sla-performance-tests)
**Created**: 2026-11-06
**Status**: Implemented (static verification only, D14); first live smoke deferred to the owner
**Input**: Work package B3 of `specs/000-performance-testing-setup/tasks.md`; plan §2, §3.2, §4.1, §5, §6.2–§6.9,
§7.3, §8.3, §10, §12.

## Goal

Measure how fast cce-step-sla-service turns deadline alarms that have rung into `OVERDUE` verdicts and deviations,
at a steady rate (smoke, load, stress) and when a large backlog rings at once (breakpoint = "storm"). Step SLA has
no API and reads no Kafka, so the load is **seeded straight into Postgres** as alarms with chosen ring times; a Node
watcher follows the service's own counters and the database gives each alarm's exact wait (ringing → handled).
The tests plug into the shared runner (`node tools/cli.mjs run <env> step-sla <type>`) so the result, report,
baseline and Grafana annotations work like those of every other service (R1, R3, R12).

## Scope

### In scope
- `cce-step-sla-service/` folder (plan §10.1): `README.md`, `service-module.mjs`, `shared.mjs` (the only file that
  imports shared code), `docs/test-plan.md`, `docs/test-strategy.md`, this spec folder.
- Test definitions `tests/step-sla-{smoke,load,stress,breakpoint}.test.mjs` (Node, no k6).
- Seeding `seeding/seed-alarms.mjs`: alarms spread over the plan-definition set (`STEP_SLA_SEED_MODE=set`) or the
  v1 single action (`single-action`), DUE rows only by default, `seed.json` in the results folder (D20).
- Alarm watcher `watchers/alarm-watcher.mjs` (plan §6.5, §6.7): due gauge, handled counters, scheduler alive,
  counter reset, stall, catch-up (never faked, D19), drain rate (storm only), 10,000-rows-per-cycle cap hits.
- Data checks `data-checks/step-sla-data-checks.mjs`: handled, OVERDUE, deviations, wait avg/p95/max, max-wait
  rule, storm catch-up, "started breaking" from the database (port of v1 `report-sla.sh`, JSON only).
- Unit tests with fake Postgres and fake scrapes (`unit-tests/*.spec.mjs`).

### Out of scope
- Any change outside `cce-step-sla-service/` (shared runner, settings, preflight, cleanup: packages A2/A3).
- A k6 script: Step SLA is not driven by requests (no `tests/shared-lib.js` is needed).
- MISSED-alarm load (seeded only on request, `STEP_SLA_SEED_MISSED_ALARMS=true`), `MET_CONDITION_REACHED` rows,
  multi-replica Step SLA, the end-to-end flow (later module, plan §10.4).
- Running anything against a live stack during this build (D14); the first laptop smoke is a DEFERRED task.

## Inputs

- Settings (plan §3.2, resolved by `tools/core/settings.mjs`): `SMOKE_/LOAD_/STRESS_RATE`, `_DURATION`, `_EVENTS`
  (alarms), `STEP_SLA_STORM_ALARMS`, `STEP_SLA_FIRST_RING_DELAY`, `STEP_SLA_SEED_MODE`, `STEP_SLA_ACTION_ID`,
  `STEP_SLA_SEED_MISSED_ALARMS`, `STEP_SLA_PEAK_ALARM_RATE` (auto), `STEP_SLA_MAX_WAIT` (auto),
  `STEP_SLA_STORM_MAX_CATCH_UP`, `EXPECTED_HEADROOM`, `WATCH_INTERVAL`, `CATCH_UP_LIMIT`,
  `BREAKPOINT_CATCH_UP_LIMIT`, `STALL_TIMEOUT`, `IDLE_FLAT_DURATION`, `IDLE_TIMEOUT`, `PLAN_DEFINITION_SET`,
  `PLAN_DEFINITION_VERSION_SUFFIX` (already applied to the set's versions).
- The phase plan (`resolved.derived.phasePlan`, plan §4.1, breakpoint kind `none`): **the single source** of the
  alarm count (`plannedMeasuredEvents`) and ring rate (measured phase rate).
- Environment: `services.stepSla` (`baseUrl`, `metricsPath`, `pollIntervalSeconds`), `database`.
- Run `ctx` (plan §6.4): `pgPool`, `scrape('step-sla')`, `times` (seed times), `planDefinitionSet` (url, version,
  `mandatorySteps` per plan definition), `resultsDir`, `writeJson`, `abortLoad`, `logger`, `context`.
- Database (ccedb, release-2.0.0 schema): `protocol_definition` (ACTIVE by url + version), `protocol_instance`,
  `step_instance`, `step_sla_state_transition`, `deviation`. Step SLA metrics: `cce_sla_transitions_due`,
  `cce_sla_transitions_applied_total`, `cce_sla_transitions_skipped_total`, `cce_sla_evaluator_cycles_total`,
  `cce_sla_evaluator_batches_failed_total`.

## Outputs

- Service module (default export, plan §6.4): `kind: 'seeded'`, `breakpointKind: 'none'`, `requires:
  {services:['step-sla'], postgres:true, kafka:false, protocol:true}`, `expectation` (unit `alarms`, rates in
  alarms/s against `STEP_SLA_PEAK_ALARM_RATE`), `waitForIdle`, `prepare`, `watchers`, `sampledMetrics`,
  `dataChecks`, `evaluate`, `baselineMetrics` (plan §8.3 keys).
- `seed.json` (plan §6.7) and `watch-alarms.json` (plan §5.1) in the run's results folder; `PrepareResult`
  `{measureStart, sendEnd, plannedEvents, manifestFile:'seed.json'}`; DataCheck objects (plan §6.8).
- Through the shared runner: `result.json` with `load.unit: 'alarms'`, `breaking.caughtUp/catchUpSeconds/
  drainRate`, `serviceMetrics.peaks['step-sla'].slaCycleCapHits`, and `report.md`.
- Exit codes are the runner's (plan §5.7); seeding refusals are `RefusedError` (exit 2).

## Acceptance criteria

1. `cce-step-sla-service/` has the §10.1 layout; every file has the §2.4 header (`node tools/cli.mjs lint-headers
   --paths cce-step-sla-service` reports nothing).
2. Only `shared.mjs` imports `../tools/core/…` or `../lib/…`; no file imports another service folder (unit test).
3. Each `tests/step-sla-<type>.test.mjs` default-exports `{testType, describe(resolved)}`; `describe` returns
   `alarmCount = phasePlan.plannedMeasuredEvents`, `ratePerSecond` = measured phase rate, plus `maxWaitSeconds`,
   `catchUpLimitSeconds` only; importing it has no side effect (unit test, incl. a `LOAD_EVENTS` override).
4. Defaults give smoke 30 alarms at 1/s, load 30,000 at 50/s, stress 120,000 at 200/s, breakpoint 100,000 at once.
5. `seedAlarms` runs every statement on ONE dedicated client inside one transaction, with parameterised values;
   `set` mode spreads alarms round-robin over every (plan definition × mandatory step) pair (overlapping-4: 16
   pairs = 3 + 7 + 1 + 5); `single-action` uses the first plan definition and refuses a non-mandatory action;
   DUE rows only unless `STEP_SLA_SEED_MISSED_ALARMS`; the matcher's history rows too (`protocol_instance_history`
   `ACTIVE` at enrolment, `step_instance_history` `NOT_STARTED`); ids from `UUID_V7_SQL`; patients
   `LOADTEST-<runId>-sla-0-<n>`; writes `seed.json`; returns the ring times (unit tests with a fake client).
6. The alarm watcher writes `watch-alarms.json`, reports `caughtUp: true` with a catch-up time only when every
   alarm was handled, otherwise `caughtUp: false`, `catchUpSeconds: null`, the remaining alarms and the give-up
   time; aborts on a counter decrease, a stopped scheduler or a stall; reports the drain rate for breakpoint only;
   counts `slaCycleCapHits` (unit tests with fake scrapes and a fake clock).
7. Data checks query with the run selector, the UUIDv7 floor and a statement timeout; produce handled, OVERDUE,
   deviations, wait avg/p95/max, max-wait rule (smoke/load/stress), storm catch-up (breakpoint) and "started
   breaking"; PASS and FAIL cases incl. the v1 storm numbers (p95 68.8 s, max 69.8 s) are unit-tested.
8. `expectation()` states alarms/s and "× peak" against `STEP_SLA_PEAK_ALARM_RATE`, never `PEAK_RATE`.
9. `node tools/cli.mjs run local step-sla <type> --dry-run` succeeds for all four types without any connection.
10. `npm test`, `node --check`, ESLint and Prettier pass on the folder.

## User Scenarios & Testing

### User Story 1 - Load-test Step SLA at a steady alarm rate (Priority: P1)
**Given** a laptop running local-stack with the plan-definition set loaded, **When** the tester runs
`scripts/run-test.sh local step-sla load`, **Then** 30,000 alarms are seeded to ring 50/s from 60 s after seeding,
the watcher follows the service until all are handled, the database gives each alarm's wait, and the report says
how many alarms went through in the interval, the longest wait against the rule (`< 2 × poll interval`) and
whether every step became OVERDUE with one deviation.

### User Story 2 - Find out how fast Step SLA drains a storm (Priority: P1)
**Given** the same stack, **When** the tester runs the breakpoint test, **Then** 100,000 alarms ring at once, the
report gives the drain rate (alarms/s, × peak alarm rate), the catch-up time (or "not caught up: N alarms still
waiting after 15m"), when it started breaking (first alarm whose wait exceeded the storm limit) and whether the
10,000-rows-per-cycle cap was hit.

### User Story 3 - Choose the plan-definition set (Priority: P2)
**Given** `PLAN_DEFINITION_SET=overlapping-4`, **When** a test runs with the default `STEP_SLA_SEED_MODE=set`,
**Then** the alarms are spread over all 16 (plan definition × mandatory step) pairs, `seed.json` and the result
record the pairs and the mode, and the peak alarm rate becomes 150/s (`PEAK_RATE × 3 DUE alarms per event`).

### User Story 4 - Rerun data checks (Priority: P3)
**Given** a finished run folder, **When** the tester runs `node tools/cli.mjs check-data local <dir>`, **Then** the
same SQL runs again from `run-context.json` alone and `result.json` is updated.

### Edge Cases
- Seeding takes longer than `STEP_SLA_FIRST_RING_DELAY` → `seed.json` warns; the alarms' wait includes the delay.
- A plan definition of the set is not ACTIVE → refused before any insert (transaction rolled back).
- `single-action` with an action that is optional in the first plan definition → refused (Step SLA would only
  "skip" it: no verdict, no deviation).
- Step SLA restarted mid-run (counters go down) → watcher aborts, status `aborted`, partial data kept.
- Other traffic on Dev/UAT moves the global counters → the watcher may think it is done early; the database checks
  and `evaluate` override caught-up from the per-alarm data.
- `STEP_SLA_MAX_WAIT=auto` cannot be resolved (environment without `pollIntervalSeconds`) → refused with a hint.

## Requirements

- **FR-001**: The folder MUST be self-contained with one declared dependency (`shared.mjs`), named after the
  service repository (plan §10.1).
- **FR-002**: The alarm count and ring rate MUST come from the phase plan only (plan §4.1, §6.7).
- **FR-003**: Seeding MUST be one transaction on one client, parameterised, DUE rows only by default (MISSED rows,
  which the matcher writes for steps with tolerance-days, are left out on purpose), with the matcher's
  `protocol_instance_history` / `step_instance_history` rows, ids
  UUIDv7-shaped, patient ids `LOADTEST-<runId>-sla-0-<n>`, seed state in the results folder only (D20).
- **FR-004**: `STEP_SLA_SEED_MODE=set` MUST spread alarms round-robin over every (ACTIVE plan definition of the set ×
  its `must` actions) pair; `single-action` MUST refuse an action that is not `must` in the first plan definition.
- **FR-005**: The watcher MUST never report a catch-up time when not caught up (D19) and MUST report the drain
  rate for breakpoint only (lesson 6).
- **FR-006**: The watcher MUST abort on counter decrease (restart), scheduler stopped, or stall (plan §6.5).
- **FR-007**: Data checks MUST be authoritative for the verdict: handled = OVERDUE = deviations = alarms;
  max wait < `STEP_SLA_MAX_WAIT` (smoke/load/stress); storm catch-up < `STEP_SLA_STORM_MAX_CATCH_UP`.
- **FR-008**: Expectations MUST be in alarms/s against `STEP_SLA_PEAK_ALARM_RATE` and marked to be confirmed.
- **FR-009**: Every file MUST carry the §2.4 header and why-comments for a newcomer (R11).
- **FR-010**: The module MUST work under `check-data` (ctx without `resolved`).
- **FR-011**: Whether the Step SLA expectations are right is [NEEDS CLARIFICATION: team confirms
  `STEP_SLA_MAX_WAIT`, `STEP_SLA_STORM_MAX_CATCH_UP`, the seed-mode default and the peak alarm rate (open
  question 16)].

## Success Criteria

- **SC-001**: All four test types dry-run (`--dry-run`) with the right alarm counts and rates printed.
- **SC-002**: Unit tests cover seeding (both modes), watcher (done / not caught up / abort / cap hits), data checks
  (pass/fail incl. v1 storm numbers), describe, expectation and the import boundary; `npm test` passes.
- **SC-003**: After the first live smoke (deferred), a tester can read in `report.md` how many alarms went through,
  the longest wait vs the rule, and the verdict, without opening any other file.
