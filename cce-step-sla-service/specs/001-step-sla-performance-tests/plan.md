<!--
  What:    Implementation plan of work package B3 (Step SLA performance tests): approach, every file, the
           interfaces it implements from the 000 contract, and the deviations / requests for the orchestrator.
  How:     Read after spec.md; tasks.md (same folder) lists the work in order and is ticked as it is done.
  Needs:   spec.md; specs/000-performance-testing-setup/plan.md (§2, §3, §4.1, §5, §6, §7.3, §8.3, §10, §12);
           wave-A code: tools/core (A2), tools/plan-definitions (A3).
  Outputs: The file list and interfaces B3 builds; deviations / requests (C1 collects them).
-->

# Implementation Plan: Step SLA performance tests

**Branch**: n/a (folder only; suggested branch feature/step-sla-performance-tests) · **Date**: 2026-11-06 ·
**Spec**: [spec.md](spec.md) · **Tasks**: [tasks.md](tasks.md) · **Contract**: `specs/000-performance-testing-setup/plan.md`

## Approach

- **Fed by the database, measured twice.** Step SLA picks up `step_sla_state_transition` rows whose
  `next_attempt_at` and `process_by` have passed (every `CCE_SLA_POLL_INTERVAL_MS`: 5 s locally, 15 s on prod),
  100 rows per batch, at most 100 batches per cycle (so at most 10,000 rows per cycle), oldest `process_by` first,
  `FOR UPDATE SKIP LOCKED`. Seeding such rows with chosen ring times *is* the load. The Node watcher follows the
  service's counters live (progress, scheduler alive, restarts, stalls, drain rate); the data checks then read
  each alarm's exact wait (`processed_at − process_by`) from Postgres — the authoritative verdict (v1 D8).
- **Port of v1, lessons fixed.** `archive/v1/seed-sla.sh` → `seeding/seed-alarms.mjs` (parameterised, UUIDv7 ids,
  run-id patients with id code `sla`, DUE rows only by default, the set as a real parameter, manifest in the
  results folder instead of `step-sla/last-seed.json`); `archive/v1/step-sla/step-sla.js` → `watchers/
  alarm-watcher.mjs` (Node instead of a k6 VU; the give-up time is never reported as a catch-up); `archive/v1/
  report-sla.sh` → `data-checks/step-sla-data-checks.mjs` (JSON DataCheck objects, no text parsing, index-friendly
  run selection, statement timeout, "started breaking").
- **The phase plan is the single source** of the alarm count and the ring rate (plan §4.1, `breakpointKind:
  'none'`): `describe()` only reads it and adds the wait / catch-up limits; seeding, watcher and data checks all
  receive the same `plan` object from the service module.
- **One shim.** `shared.mjs` re-exports the `tools/core` functions the folder uses (no `lib/` import is needed:
  the phase plan arrives already built in the resolved settings). There is no k6 shim because there is no k6.
- **Fakes only.** Every function that touches Postgres, a scrape or the clock takes it from `ctx` or an options
  argument, so the unit tests use a recording fake client, fake scrapes and a fake clock (D14).

## Files

| File | Purpose |
|---|---|
| `cce-step-sla-service/README.md` | CCE-style landing page: facts bar, Quick Start, Documentation (incl. "Depends on") |
| `cce-step-sla-service/service-module.mjs` | §6.4 plug-in: kind `seeded`, breakpoint `none`, hooks wired to the modules below |
| `cce-step-sla-service/shared.mjs` | The only file importing `../tools/core/…` (re-exports) |
| `cce-step-sla-service/docs/test-plan.md` | "# CCE Step SLA Service Performance Tests — Test Plan", the 10 sections of §10.2 |
| `cce-step-sla-service/docs/test-strategy.md` | Why these tests, how fed and measured, what "breaking" means, risks |
| `cce-step-sla-service/specs/001-step-sla-performance-tests/{spec,plan,tasks}.md` | This spec |
| `cce-step-sla-service/tests/step-sla-test-definition.mjs` | `defineStepSlaTest(testType)`: the shared `describe()` |
| `cce-step-sla-service/tests/step-sla-{smoke,load,stress,breakpoint}.test.mjs` | One test definition per type |
| `cce-step-sla-service/seeding/seed-alarms.mjs` | `seedAlarms(ctx, plan)` → PrepareResult; `buildSeedPairs`, SQL builders |
| `cce-step-sla-service/watchers/alarm-watcher.mjs` | `createAlarmWatcher(ctx, {plan})` → Watcher (§6.5) |
| `cce-step-sla-service/data-checks/step-sla-data-checks.mjs` | `runStepSlaDataChecks(ctx, {plan})`, `judgeAlarmRow`, SQL |
| `cce-step-sla-service/unit-tests/helpers.mjs` | Fake pg client/pool, fake scrape, fake clock, ctx builder |
| `cce-step-sla-service/unit-tests/test-definitions.spec.mjs` | describe() counts, LOAD_EVENTS override, no side effects |
| `cce-step-sla-service/unit-tests/seed-alarms.spec.mjs` | Both seed modes, refusals, SQL parameters, manifest, times |
| `cce-step-sla-service/unit-tests/alarm-watcher.spec.mjs` | Done, not caught up, aborts, drain rate, cap hits |
| `cce-step-sla-service/unit-tests/data-checks.spec.mjs` | PASS/FAIL, v1 storm numbers, started breaking, SQL params |
| `cce-step-sla-service/unit-tests/service-module.spec.mjs` | Module shape, expectation, evaluate, baselineMetrics, a valid result.json |
| `cce-step-sla-service/unit-tests/import-boundary.spec.mjs` | Only `shared.mjs` imports shared code; no other service folder |

## Interfaces

| Export | Shape | Contract |
|---|---|---|
| `tests/step-sla-<type>.test.mjs` default | `{ testType, describe(resolved) → { alarmCount, ratePerSecond, maxWaitSeconds, catchUpLimitSeconds } }` | §6.7 |
| `seedAlarms(ctx, plan, {now}?)` | → `{ measureStart: ISO, sendEnd: ISO, plannedEvents, manifestFile: 'seed.json' }` (PrepareResult) | §6.4, §6.7 |
| `buildSeedPairs({planDefinitionSet, seedMode, actionId})` | → `[{ url, version, canonical, actionId }]` (pure) | §6.7 |
| `buildSeedStatements({...})` | → `[{ name, sql, params }]` (pure; the exact statements run) | §6.7 |
| `createAlarmWatcher(ctx, {plan, sleep?, now?, write?})` | → `{ name:'alarms', start(), stop(), whenDone() → WatcherOutcome }` | §6.5, §6.7 |
| `WatcherOutcome` (alarms) | `{ name, subject:'step-sla', file, samples, thresholds, breaking:{caughtUp, catchUpSeconds, remainingBacklog, gaveUpAfterSeconds, drainRate?}, load:{eventsProcessed}, peaks:{slaCycleCapHits:{value, firstAt}}, aborted?, warnings }` | §6.5, §6.3 |
| `runStepSlaDataChecks(ctx, {plan, timeoutMs?})` | → `DataCheck[]` (the max-wait / storm check carries `details: {startedBreakingAt, alarmsOverMaxWait, …}`) | §6.7, §6.8 |
| `judgeAlarmRow({row, plan, testType})` | → `DataCheck[]` (pure) | §6.7 |
| `service-module.mjs` default | §6.4 object (see spec Outputs) | §6.4 |
| `seed.json` | `{ $comment, runId, testType, alarmCount, ratePerSecond, ringStartMs, ringEndMs, seedMode, pairs:[{protocolDefinitionId, canonical, actionId, alarms}], missedSeeded, missedRingStartMs, seededAt, committedAt, planDefinitionSet, patientIdPrefix, firstRingDelaySeconds, warnings }` | §6.7 |
| `watch-alarms.json` | `{ schemaVersion, name:'alarms', intervalSeconds, samples:[{at, t, phase, due, applied, skipped, cycles, batchesFailed, handled, processedPerSecond}], outcome }` | §5.1 |
| `baselineMetrics(result)` | `step-sla.{load,stress}.maxWaitSeconds`, `.p95WaitSeconds`, `step-sla.breakpoint.drainRate`, `.catchUpSeconds` | §8.3 |

Sampled metrics (keys used by `PEAK_SIGNALS`): `slaDue` (`cce_sla_transitions_due`, max), `slaApplied`,
`slaSkipped`, `slaCycles`, `slaBatchesFailed` (`cce_sla_evaluator_batches_failed_total`, the key the
`slaBatchesFailed` peak reads).

## Technical Context

Node.js 22 ESM (`.mjs`), no new dependencies (`pg` is used through A2's `withDedicatedClient`/`queryRows`). Step SLA
release-2.0.0 facts used (read-only source): `SlaTransitionEvaluator` (`@Scheduled(fixedDelay = poll interval)`,
`MAX_BATCHES_PER_CYCLE = 100`, counter `cce.sla.evaluator.cycles` incremented at the start of each cycle,
`cce.sla.evaluator.batches.failed`), `SlaTransitionApplier` (batch 100, mandatory steps only, `OVERDUE` +
deviation per DUE row, counters `applied`/`skipped`), `SlaTransitionFetchRepository` (both `next_attempt_at` and
`process_by` ≤ now, `ORDER BY process_by`, gauge counts `next_attempt_at` only), Hikari pool 3, no Kafka; tables per
cce-matcher-service `V1__initial_schema.sql`…`V7` (step_instance needs `required_behavior = 'must'`;
`step_group_instance_id` stays null; the entity needs the `step_group_instance` table to exist, checked by preflight
`schema-step-groups`). Verification: `node --check`, `npm test`, ESLint, Prettier, `lint-headers`, `run … --dry-run`.

## Deviations / requests

1. **Patient number `n` is 0-based** (plan §2.3: `n` < plannedEvents), so ring = start + `n / rate` and alarm `n` →
   pair `n mod P`; §6.7's `(n − 1)/rate` is the same schedule written for a 1-based `n`.
2. **`seed.json` carries extra fields** next to the §6.7 ones: `$comment` (generated header, §2.4), `testType`,
   `planDefinitionSet`, `patientIdPrefix`, `firstRingDelaySeconds`, `committedAt`, `warnings` (e.g. "seeding took
   longer than STEP_SLA_FIRST_RING_DELAY").
3. **Protocol definition ids are looked up inside the seed transaction** (`protocol_definition` by url + version,
   status `ACTIVE`) rather than taken from the conditions snapshot, so a definition retired between preflight and
   seeding is refused, not seeded against.
4. **DataCheck `details`**: the `step-sla.max-wait` / `step-sla.storm-catch-up` checks carry an extra
   `details` object (started breaking, alarms over the limit, first/last ring, last handled). `evaluate` reads it
   (it is the "breaking info" of §6.7); `validateResult` accepts extra fields. `check-data` re-runs the SQL but does
   not call `evaluate` (A2), so `breaking` in result.json keeps the original run's analysis.
5. **`evaluate` replaces the watcher's `step-sla.caught-up` rule with the database truth** (same id, module wins,
   tools/README.md): Step SLA's counters are global, so on a shared environment the watcher may count other work.
6. **`breaking.rateAtBreak` is `null` for the storm** (ring rate 0 means "all at once", not 0/s): `evaluate` passes
   `rateAtBreak: null`, which A2's overlay keeps.
7. **`slaCycleCapHits` is an estimate** from the counters: between two increments of the cycles counter the handled
   rows of that segment are attributed to the cycle(s) that started it (± one sample interval). The service log
   line "stopped at the 100-batch cycle limit" is exact; the test plan says so. The cap (10,000) assumes the default
   `CCE_SLA_BATCH_SIZE=100`.
8. **Drain-rate rule is informational** (`step-sla.drain-rate`, target `EXPECTED_HEADROOM × STEP_SLA_PEAK_ALARM_RATE`),
   like B2's matcher drain rate (A2 deviation 5): the storm verdict is the catch-up rule.
9. **Scheduler-alive window** = max(`STALL_TIMEOUT`, 3 × `services.stepSla.pollIntervalSeconds`) with neither the
   cycles nor the handled counter moving (a long capped cycle does not increment the cycles counter).
10. **No k6 shim** (`tests/shared-lib.js`): Step SLA has no k6 script; the README "Depends on" row says so.
11. **Request to C1** (docs): mention in the runbook that a Step SLA run needs the plan-definition set loaded
    (`scripts/manage-plan-definitions.sh load <env> --set <name>`) even though no event is sent, because seeded
    enrolments reference ACTIVE `protocol_definition` rows (foreign key).
12. **Request to A2** (`tools/core/watchers.mjs` `createStallDetector`): the detector measures "no progress" from
    the last change of the progress counter even while the backlog was at or below `minBacklog`, so a quiet stretch
    before the load (Step SLA: the minute before the first ring; the storm then has 100,000 due at its first
    sample) is counted as stalled time and aborts the run at once. B3 works around it by recreating the detector
    whenever ≤ 10 alarms are due (`STALL_MIN_DUE`), so the stall clock only runs while alarms wait (unit-tested:
    the storm test failed without it). Suggested fix in A2: reset `lastChangeMs` while `backlog <= minBacklog`;
    B2's backlog watcher may have the same exposure when the first sample after an idle period already shows lag.
13. **`shared.mjs` also re-exports test-only helpers** (`prepareRunSettings`, `buildRunContext`, `createTimes`,
    `validateServiceModule`, `buildResult`, `validateResult`, `loadEnvironment`, `parsePrometheusText`) so the unit
    tests resolve settings and build a real `result.json` exactly like `run` does without importing `../tools`
    themselves (the import-boundary test allows only `shared.mjs` to leave the folder).
14. **`STALL_TIMEOUT` minimum backlog** is the plan §6.5 value (`> 10` due); exported as `STALL_MIN_DUE` from the
    watcher.
15. **Seed SQL adds the matcher's history rows** (review round 1): §6.7 says "SQL as archive/v1/seed-sla.sh", which
    skipped history. The seed now also inserts `protocol_instance_history` (`ACTIVE`, `changed_at = enrolled_at`,
    as `ProtocolInstanceService`) and `step_instance_history` (`NOT_STARTED`, `sla_status` null,
    `changed_at = now()` = the step's `created_at`, as `StepInstanceService`), ids from the column default (safe per
    matcher `V6__history_ids_by_sequence_block.sql`): 5 rows per alarm, a judged step ends with 2 history rows as in
    production. Step SLA's verdict is unchanged (it reads only the alarm and the step). The `MISSED_DATE_REACHED`
    row the matcher writes for steps with `tolerance-days` stays out by default on purpose (test plan §2, §9).
    Cleanup already deletes both history tables by run (tools/cleanup, plan §7.2). Request to C1: mention it in §6.7.
