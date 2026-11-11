<!--
  What:    Implementation plan of work package B2 (matcher performance tests): approach, every file, the
           interfaces it implements from the 000 blueprint, and the deviations / requests to other packages.
  How:     Read after spec.md; tasks.md breaks this into ticked sub-tasks.
  Needs:   specs/000-performance-testing-setup/plan.md (the contract), lib/README.md, tools/README.md and the
           A-package plans (their "Deviations / requests" describe the real interfaces).
  Outputs: The build plan of cce-matcher-service/.
-->

# Implementation Plan: Matcher performance tests

**Branch**: n/a (folder only; suggested branch feature/matcher-performance-tests) · **Date**: 2026-11-06 ·
**Spec**: [spec.md](spec.md) · **Tasks**: [tasks.md](tasks.md)

## Approach

1. **Feed directly, measure from outside.** k6 (image `cce-load-tests/k6:2.3.0-kafka2.2.0`, xk6-kafka) writes
   CloudEvents into `cce.events.inbound` with an open (arrival-rate) model; it cannot see the matcher, so it only
   proves the events were handed to Kafka. The Node backlog watcher measures the matcher: consumer-group lag
   (kafkajs admin, `readMatcherBacklog` semantics) and the matcher's own counters, every `WATCH_INTERVAL`.
2. **One scenario, four thin tests.** `tests/matcher-scenario.js` holds everything an iteration does
   (`createMatcherTest(testType)`: asserts the run context, builds options with `kind: 'kafka'`, creates one
   producer per VU in the init context, sends one event per iteration). Each `matcher-<type>.test.js` only wires
   `options`, `setup` (= `markK6Start`), `default` and `handleSummary` (= `writeSummary`).
3. **k6 clock contract.** The watcher never uses the docker start: it awaits `ctx.times.ready` before reading
   `measureStart`/`sendEnd`, re-bases earlier samples, and re-reads `sendEnd` on every sample (it moves when k6
   ends early). This fixes v1's `sentBy()` measured from the container start.
4. **Done rule (fixes D19).** After `sendEnd`: backlog ≤ 10 → `caughtUp: true, catchUpSeconds`; otherwise at
   `sendEnd + limit` → `caughtUp: false, remainingBacklog, gaveUpAfterSeconds`, and **no** catch-up number.
5. **Fail safe on data.** Missing metric → `null` + one warning; Kafka admin error → backlog `null`; stall
   detection pauses when the counter is unreadable (never aborts on missing data); DLQ unreadable → the
   dead-letter rule is informational "not measured". Counters are read with `sumMetric` over **every** series
   (fixes v1's first-series-only regex and its `TypeError` on a missing metric).
6. **Data checks from the database.** Candidate event ids from the phase plan with the 1 % + 10 edge margin
   (`candidateEventIdsSql` over `candidatePhasePlan(phasePlan)`, as in cleanup) joined on the unique
   `(cloudevents_id, source)`; protocol and step instances bounded by `uuidV7LowerBound(run start)` then
   `patient_id LIKE selector%`; each query with `statement_timeout` (5 min) and its duration recorded.
   "Sent" = `kafka_writer_message_count` from `k6-summary.json` (fallback `events_accepted`, `events_sent`).
7. **Verdict pieces.** k6 rules come from `thresholdsFromK6` (A2); the watcher adds its rules; `evaluate` adds
   only module rules (`matcher.backlog-watcher` when the watcher did not run, `matcher.processing-time`
   informational) and passes the watcher rules through unchanged; notes explain Kafka "accepted" semantics.

## Files

| File | Purpose |
|---|---|
| `README.md` | CCE-style landing page: facts bar, Quick Start, Documentation table with the "Depends on" row |
| `docs/test-plan.md` | "CCE Matcher Service Performance Tests — Test Plan", the 10 sections of plan §10.2 |
| `docs/test-strategy.md` | Why these test types, how fed/measured, what "breaking" means here, risks |
| `specs/001-matcher-performance-tests/{spec,plan,tasks}.md` | This spec folder |
| `shared.mjs` | Node shim: the ONLY Node file importing `../tools/…` and `../lib/…` |
| `service-module.mjs` | Plug-in for the runner (plan §6.4): metadata, expectation, idle, watchers, sampled metrics, data checks, evaluate, baselineMetrics |
| `watchers/backlog-watcher.mjs` | `createBacklogWatcher(ctx, deps)` (plan §6.5/§6.6) + pure helpers (`median`, `buildBacklogOutcome`) |
| `data-checks/matcher-data-checks.mjs` | `runMatcherDataChecks(ctx, deps)` and the SQL builders (plan §6.8) |
| `tests/shared-lib.js` | k6 shim: the ONLY k6 file importing `../../lib/…` |
| `tests/matcher-scenario.js` | `createMatcherTest(testType)`: options, producer per VU, one CloudEvent per iteration |
| `tests/matcher-{smoke,load,stress,breakpoint}.test.js` | Thin k6 entry points |
| `unit-tests/fakes.mjs` | Fake clock, fake ctx.times, fake Kafka admin, fake scrape, fake pg pool, settings at defaults |
| `unit-tests/backlog-watcher.spec.mjs` | Watcher: catch-up, no catch-up (v1 case), late ready, stall, restart, missing metrics, early send end, flood |
| `unit-tests/data-checks.spec.mjs` | Data checks: single, overlapping-4, extra ACTIVE definition, draining, DLQ, SQL shape |
| `unit-tests/service-module.spec.mjs` | Module shape, test files, expectation, sampled metrics, idle wait, evaluate, baselineMetrics, Kafka VU limits (flood 100 / 500), generic names |
| `unit-tests/import-boundary.spec.mjs` | Only the two shims leave the folder; no other service folder; bare imports only `node:*` / `k6*` |
| `unit-tests/fixtures/README.md` + `k6-summary-matcher-load.json` | Small synthetic k6 summary of a load run (30,600 events; shape of lib/README.md) |

## Interfaces

- **Service module** (000 §6.4): `default { service:'cce-matcher-service', subject:'matcher', idCode:'mat',
  displayName:'Matcher', kind:'k6', breakpointKind:'flood', testTypes, requires, testFile(testType) → URL,
  expectation({testType, settings, environment, planDefinitionSet}), waitForIdle(ctx), watchers:[ctx =>
  createBacklogWatcher(ctx)], sampledMetrics: SampledMetric[], dataChecks(ctx), evaluate(ctx, partial),
  baselineMetrics(result) }`.
- **SampledMetric[]** (000 §6.3): `matchedEvents` (`cce_events_matched_total{status="matched"}`),
  `zeroMatchEvents` (`{status="zero_match"}`), `duplicateEvents` (`cce_events_duplicate_total`),
  `inboundErrors` (`cce_consumer_inbound_errors_total`), `processingSecondsSum` / `processingSecondsCount`
  (keys required by `PEAK_SIGNALS.processingMsAvg`), `processingSecondsMax` (`…_max`, agg max).
- **Watcher** (000 §6.5): `createBacklogWatcher(ctx, { now, sleep, write }) → { name:'backlog', start(), stop(),
  whenDone() → WatcherOutcome }`; `WatcherOutcome = { name, subject:'matcher', file, samples, thresholds,
  breaking, load:{eventsProcessed}, aborted: string|null, summary:{…}, warnings }`.
- **Data checks** (000 §6.8): `runMatcherDataChecks(ctx, { readResultFile, now }) → DataCheck[]`;
  `buildEventCountsSql({selector, phasePlan})`, `buildEnrolmentCountsSql()`, `buildStepCountsSql()`
  (parameters `$1` = UUIDv7 floor, `$2` = selector).
- **k6** (000 §4.7): `createMatcherTest(testType) → { context, options, sendEvent(), writeSummary(data) }`.
- **Baseline metric keys** (000 §8.3): listed in spec.md Outputs.

## Technical Context

| Item | Value |
|---|---|
| Language | Node.js 22 ESM (`.mjs`) for module, watcher, data checks, unit tests; k6 JS (`.js`) for tests |
| Dependencies | none of its own (kafkajs and pg are used through the shared clients in the run ctx) |
| Testing | `node --test` with fakes (no network), `k6 inspect` with `--network none`, `run --dry-run` |
| Target | local-stack matcher on port 8097; Kafka `localhost:29092`; Postgres `ccedb` |
| Constraints | D14 static-only verification; no secrets; only `cce-matcher-service/` is written |

## Deviations / requests

1. **Backlog rule wording**: §6.6 says "max ≤ `MATCHER_MAX_BACKLOG`" while the A2 fixtures show `max < 1000`.
   The module follows §6.6 (`max <= 1000`, "never above 1,000").
2. **Request to A2 (`result-builder.mjs`)**: failed watcher thresholds are always appended to
   `breaking.whatBroke` as "<description> (actual N)", even when the watcher already explains them; the skip by
   `described.has(metric)` applies to `source: 'k6'` only. The watcher's own entries use the same `metric`
   names as its thresholds (`backlog`, `catchUpSeconds`, `deadLetters`), so extending that skip to every source
   removes the duplicate lines. Until then a failed matcher rule appears twice in "what broke".
3. **Extra module threshold** `matcher.backlog-watcher` (failed when the watcher did not run or errored: the
   matcher verdict depends on it) and informational `matcher.processing-time` (max processing time vs 500 ms,
   the CCE alert level, because p99 cannot be computed without histogram buckets).
4. **Draining at data-check time**: when the consumer group still has lag when the checks run (not caught up),
   `matcher.logged-equals-sent` and `matcher.patients-enrolled` are downgraded to `info` with a hint to re-run
   `check-data`; `matcher.all-matched` and `matcher.enrolments-equal-fan-out` (ratios over what was processed)
   stay required. Enrolments are compared with `effectiveFanOut × distinct enrolled patients`.
5. **`matcher.no-dead-letters`** reads the DLQ growth measured by the watcher (`watch-backlog.json`
   `outcome.summary.deadLetters`), because Kafka offsets before the run cannot be reconstructed afterwards; if
   it was not measured the check is `info` "not measured".
6. **Steps check with extra ACTIVE definitions**: their step counts are unknown, so the comparison becomes
   `at-least expectedRows.step_instance × events`.
7. **Kafka never reports `k6Limited`** (A2 deviation 7): dropped iterations during a flood are reported as
   dropped; the notes say so.
8. **Unit-test fixtures** are this folder's own (no test reads `lib/unit-tests/fixtures` or `archive/`).
9. **`tools/core/inspect-k6.mjs`** writes its fixture run contexts to `.cache/inspect/` (its own scratch) when
   used to inspect this folder's tests; nothing else outside the folder is written.
10. **Event building follows the real lib API**: the scenario calls `buildIterationEvent` (A1), which wraps
    `buildPatientId` / `buildEventId` / `buildCloudEvent`, instead of calling `buildCloudEvent` itself.
11. **`waitForIdle` is `waitForMatcherIdle` itself** (same function, not a wrapper), so the collector and
    matcher wait identically and unit tests can pass its optional fake clock (`{ now, sleep }`).
12. **`shared.mjs` re-exports more than the §6.4 minimum**: `validateServiceModule` (service-registry),
    `COMMON_SAMPLED_METRICS` / `PEAK_SIGNALS` (sampled-metrics), `buildResult` / `validateResult` and the
    plan-definition `loadPlanDefinitionSet` / `computeExpectedRows`, used by unit tests to prove the module
    fits the shared contracts. All still go through the one shim.
13. **Empty `EVENT_SOURCE` / `EVENT_ACTION_ID`** fall back to the dataset values in the data checks (`||`, not
    `??`): the resolver already derives them, but `check-data` may re-run an older result whose settings hold
    `''`.
14. **Root docs links**: the README links `../docs/runbook.md` and `../docs/glossary.md` (package C1, wave C);
    they may be pending until C1 finishes (same as the collector README).
15. **Unit-test correction**: the `stop()` watcher test expected 4 samples; the watcher correctly takes 3
    (0, 5, 10 s) because the stop arrives during the sleep after the third and the loop checks `stopped`
    before sampling again. The assertion now says 3.
