<!--
  What:    Implementation plan of work package B1 (collector performance tests): approach, every file, the
           interfaces it exports and consumes, and where it deviates from the 000 blueprint.
  How:     Read after spec.md; tasks.md lists the work in order. Sections of the blueprint are cited as §N
           (specs/000-performance-testing-setup/plan.md).
  Needs:   spec.md (same folder); lib/README.md and tools/README.md for the real wave-A interfaces.
  Outputs: The build contract of cce-collector-service/.
-->

# Implementation Plan: Collector performance tests

**Spec**: [spec.md](spec.md) · **Tasks**: [tasks.md](tasks.md) · **Blueprint**: `specs/000-performance-testing-setup/plan.md`

## Approach

1. **Thin k6 tests, one iteration function.** The four `tests/collector-<type>.test.js` files differ only
   in the test type they assert. Each builds `options` from the run context (`buildOptions({ context, kind:
   'http' })` — arrival-rate scenarios `smoke` / `warm-up` / `measure`, thresholds, tags), marks "time 0"
   in `setup()` (k6 clock contract, §4.7), and delegates the iteration to `createCollectorIteration(context)`
   in `tests/collector-scenario.js`: `tagIteration` first, then patient id / event id (§2.3) from the phase
   index and `exec.scenario.iterationInTest`, `buildFhirResource` + `buildCloudEvent` from the run-context
   dataset and `EVENT_ACTION_ID`, `postJson` with name tag `POST /v1/events`, checks `status is 202` and
   `event accepted`, `recordSend(accepted)`. Ported from `archive/v1/collector/collector.js`, fixing:
   random UUID event ids (not enumerable, needed LIKE/JSONB cleanup) → enumerable `LOADTEST-…-col-…` ids;
   hard-coded source `ebuzima` → dataset/`EVENT_SOURCE`; profile chains in one script → one script per test
   type; `tagLevel()` against the docker start → `tagIteration` against the k6 clock.
2. **Service module = plain object (§6.4)** with `expectation`, `waitForIdle` (= `waitForMatcherIdle`, every
   collector event feeds the matcher and a draining matcher competes for Postgres, lesson 10),
   `sampledMetrics` (exact labels), `dataChecks`, `evaluate`, `baselineMetrics`. No watcher: the collector
   answers every request, so k6 measures it directly.
3. **Data checks (§6.8)** with index-friendly SQL: `candidateEventIdsSql` (A2) generates every id the run
   can have produced (all phases, with a small margin for edge iterations) and joins `inbound_event_log`
   / `matcher_event_log` on `(cloudevents_id, source = $1)`. One query per table, `runTimedQuery` with the
   default 5-minute `statement_timeout`, SQL and duration kept on each check. Expected values come from the
   run's `k6-summary.json` (read from `ctx.resultsDir`, because the runner calls `dataChecks(ctx)` before it
   loads the summary). Ported from `archive/v1/flow.sh` ("Collector stored every accepted event"), which
   used `raw_payload->>'subject' LIKE` (a full JSONB scan).
4. **Evaluation**: k6 rules come from `thresholdsFromK6` in the result builder; the module adds one rule,
   `collector.throughput` (accepted events/s in the measured phase ≥ (1 − `RATE_SHORTFALL_TOLERANCE`) ×
   target; informational when the k6 limit applies), plus breaking facts from the same `analyseWindows` /
   `analyseLevels` the builder uses (`k6Limited`, `heldUpTo`, `brokeAtRate`), `load.eventsProcessed` (= stored
   ACCEPTED rows) and plain-language notes (refine hint, matcher backlog left, server-side average time).
5. **Self-contained folder**: `shared.mjs` and `tests/shared-lib.js` are the only files importing shared
   code; a unit test enforces it by resolving every import specifier.
6. **Static verification only (D14)**: unit tests with fake pg / Kafka admin / scrape and fixture k6
   summaries generated with the real `lib/` phase plan and threshold builders; `k6 inspect` in Docker with
   `--network none`; `run --dry-run`; `settings`; ESLint, Prettier, `lint-headers`.

## Files

| File | Purpose |
|---|---|
| `README.md` | CCE-style landing page: purpose, facts bar, Quick Start, Documentation table incl. "Depends on" |
| `service-module.mjs` | §6.4 plug-in: identity, requires, testFile, expectation, waitForIdle, sampledMetrics, dataChecks, evaluate, baselineMetrics |
| `shared.mjs` | The only Node file importing `../tools/core/*` and `../lib/*` (re-exports) |
| `docs/test-plan.md` | "CCE Collector Service Performance Tests — Test Plan", the 10 sections of §10.2 |
| `docs/test-strategy.md` | Why these test types, how fed/measured, what "breaking" means for the collector, risks |
| `specs/001-collector-performance-tests/{spec,plan,tasks}.md` | This spec |
| `tests/shared-lib.js` | The only k6 file importing `../../lib/*` (re-exports) |
| `tests/collector-scenario.js` | `createCollectorIteration(context)`: the iteration every collector test runs |
| `tests/collector-smoke.test.js` | Smoke: 1/s × 30 s, no warm-up |
| `tests/collector-load.test.js` | Load: warm-up, then 50/s × 10 m (1 × peak) |
| `tests/collector-stress.test.js` | Stress: warm-up, then 200/s × 10 m (4 × peak) |
| `tests/collector-breakpoint.test.js` | Breakpoint: warm-up, then staircase 200 → 6400/s |
| `data-checks/collector-data-checks.mjs` | `runCollectorDataChecks(ctx)` + pure helpers (SQL builders, comparisons) |
| `unit-tests/service-module.spec.mjs` | Module shape, testFile URLs, expectation, sampled metrics, waitForIdle wiring |
| `unit-tests/import-boundary.spec.mjs` | Only the two shims import shared code; no other service folder |
| `unit-tests/collector-data-checks.spec.mjs` | SQL binds, comparisons, downstream-backlog-left with fake pg/Kafka |
| `unit-tests/evaluate.spec.mjs` | evaluate on passing load / k6-limited load / breakpoint fixtures; baselineMetrics |
| `unit-tests/fixtures/README.md` | What each fixture is and how it was generated (fixtures carry no header) |
| `unit-tests/fixtures/k6-summary-*.json` | Synthetic k6 summaries (real threshold/scenario keys from `lib/`) |
| `unit-tests/fixtures/settings-overrides.json` | The small settings the fixtures were generated with (`$comment` explains) |

## Interfaces

**Exported (service-module.mjs, §6.4):**
```js
export default {
  service: 'cce-collector-service', subject: 'collector', idCode: 'col', displayName: 'Collector',
  kind: 'k6', breakpointKind: 'staircase', testTypes: ['smoke', 'load', 'stress', 'breakpoint'],
  requires: { services: ['collector'], postgres: true, kafka: true, protocol: true },   // kafka: see Deviations 1
  testFile(testType) → URL,                         // new URL('./tests/collector-<type>.test.js', import.meta.url)
  expectation({ testType, settings }) → { summary, targetRate, peakRate, multipleOfPeak, unit: 'events', toBeConfirmed: true },
  waitForIdle(ctx) → Promise<{ waitedSeconds }>,    // waitForMatcherIdle(ctx, { flatSeconds: IDLE_FLAT_DURATION, timeoutSeconds: IDLE_TIMEOUT })
  sampledMetrics: SampledMetric[],                  // 7 entries, exact labels {uri: '/v1/events'} where needed
  dataChecks(ctx) → Promise<DataCheck[]>,           // runCollectorDataChecks
  evaluate(ctx, partial) → { thresholds, breaking, load, notes },
  baselineMetrics(result) → [{ key, label, unit, better, value }],
};
export const COLLECTOR_SAMPLED_METRICS;            // also exported for tests
export function evaluateCollector(ctx, partial, { readServiceMetrics }) // testable core of evaluate
export function collectorBaselineMetrics(result)
export function collectorExpectation({ testType, settings })
```
**data-checks/collector-data-checks.mjs (§6.8):**
```js
export const CANDIDATE_MARGIN = { share: 0.01, extra: 10 };
export function candidatePhasePlan(phasePlan) → { phases: [{ plannedEvents }] }       // with margin
export function buildInboundStatusSql(candidateSql) → string   // $1 = source; counts ACCEPTED/REJECTED/RECEIVED
export function buildDownstreamLoggedSql(candidateSql) → string // $1 = source; matcher_event_log rows
export function readK6Counts(k6Summary) → { sent, accepted } | null
export function storedEqualsAcceptedCheck({ storedAccepted, counts, ranToEnd }) → DataCheck
export async function runCollectorDataChecks(ctx, { readSummary, readBacklog, timeoutMs }) → DataCheck[]
```
**Consumed (real wave-A APIs):** `tools/core/idle.mjs` `waitForMatcherIdle(ctx, options)`,
`readMatcherBacklog(ctx) → { lag, processed }`; `tools/core/run-sql.mjs` `candidateEventIdsSql({ selector,
phasePlan, steps })`, `runTimedQuery(pgPool, { sql, params, timeoutMs }) → { rows, durationMs, sql }`,
`DEFAULT_STATEMENT_TIMEOUT_MS`; `tools/core/k6-summary.mjs` `normaliseK6Summary`, `metricValue`;
`tools/core/breaking-analysis.mjs` `analyseWindows`, `analyseLevels`, `measuredP95`;
`tools/core/results.mjs` `readJsonIfExists`; `tools/core/format.mjs` `formatNumber`, `formatPercent`;
`lib/phase-plan.js` `measuredPhaseOf`; `lib/duration.js` `formatDuration`; for unit tests
`tools/core/settings.mjs` `resolveSettings`, `lib/phase-plan.js` `buildPhasePlan`,
`tools/core/service-registry.mjs` `validateServiceModule`. k6 side: see spec Inputs.

**DataCheck shape** (§6.8, `tools/results/result.schema.json`): `{ id, description, expected, actual,
comparison, passed, severity, sql, durationMs }`. For `between`, `expected` is the array `[lower, upper]` =
`[k6 accepted, k6 sent]` (the same shape the matcher checks use); the description names both bounds too.

## Technical Context

| Item | Value |
|---|---|
| Language | k6 JavaScript (ES modules) for tests; Node.js 22 ESM `.mjs` for the module, checks, unit tests |
| Dependencies | None of its own; shared code through the two shims; `pg`/`kafkajs` only via `tools/core` clients |
| Testing | `node --test` (`npm test` includes `cce-*/**/*.spec.mjs`), `k6 inspect` (`npm run check:k6`), `run --dry-run` |
| Target | cce-collector-service release-2.0.0: port 8093 on local-stack (container 8080), `POST /v1/events` |
| Constraints | No live connection during the build (D14); no secrets; folder copyable as `performance-tests/` |
| Collector facts | No auth; `id` ≤ 50 chars, unique per `(id, source)` (repeat → 200 "duplicate", concurrent repeat → 500); 202 `data.status "accepted"`; 400 not stored, 422/500 stored REJECTED; latency = INSERT + UPDATE + synchronous Kafka publish (`acks=all`); Hikari `cce-collector-pool` max 10 (pending > 0 = first sign of breaking); no histogram buckets (p95 only from k6) |

## Deviations / requests

1. **`requires.kafka: true`** (the package brief said `kafka: false (warning only)`). In the real code
   (`tools/core/run-clients.mjs`) the run's Kafka admin client exists only when `requires.kafka` is true, and
   `waitForMatcherIdle` / `readMatcherBacklog` need it to read the matcher lag; with `false` every collector
   run would wait until `IDLE_TIMEOUT` and be refused. Preflight's `kafka` and `matcher-consumer-group`
   checks still treat Kafka as **warning only** for the collector (their severity is decided by subject,
   `tools/preflight/checks/kafka.mjs`), which is the intended behaviour.
2. **`evaluate().breaking` carries facts only** (`k6Limited`, and for the staircase `heldUpTo`,
   `brokeAtRate`), computed with the same `analyseWindows` / `analyseLevels` as the result builder. It does
   **not** return `whatBroke` or `startedBreakingAt`: the builder already merges its own analysis and appends a
   module's `whatBroke` entries, so returning them would list every reason twice, and the live
   `times.measureStart` could differ by milliseconds from the re-based one.
3. **Data checks read `k6-summary.json` themselves** (`ctx.resultsDir`): `run-test.mjs` calls
   `module.dataChecks(ctx)` before it loads the summary and `ctx` has no summary field.
4. **"Ended early" detection** for the `between` comparison: `ctx.times.sendEndedEarly` (run) or
   `ctx.result.status === 'aborted'` (`check-data`), plus every breakpoint run (it ends by design).
5. **Request to A2 (report + schema)**: for `between`, `expected` is now `[lower, upper]` (review round 1;
   was the lower bound only). `tools/report/run-report.mjs` `renderDataChecks` must print `between A and B`
   for an array (today `formatNumber([a, b])` renders `NaN`), with a report unit test, and
   `tools/results/result.schema.json` should document `expected` as a two-number array for `between`. The
   same `formatNumber(check.expected)` appears in `tools/core/result-builder.mjs` (lines ~283, ~516) and
   `tools/commands/check-data.mjs` (~58); one shared `formatExpected(check)` in `tools/core/format.mjs` would
   fix all three. The report fixture `collector-breakpoint-20261105-142233/result.json` still has the old
   scalar `expected: 100000`.
6. **Candidate-id margin**: candidate ids per phase are `plannedEvents + ceil(1 %) + 10`, in case k6 starts
   an iteration or two more than rate × duration at a phase edge; extra candidates are harmless index misses.
7. **Open question (C1)**: on Dev/UAT the matcher lag rarely reaches exactly 0 (real traffic), so
   `waitForMatcherIdle` before a collector run would time out there; a "lag below N" idle rule for shared
   environments needs a team decision (applies to the matcher module too).
8. **No unit-test fixture from `lib/` is read**: the folder's fixtures were generated in the session
   scratchpad with the real `lib/phase-plan.js` + `lib/thresholds.js` (keys) and hand-chosen values; the
   generator settings are in `unit-tests/fixtures/settings-overrides.json` and a unit test checks that the
   fixtures' phase plans still equal what `resolveSettings` produces from them.
9. **Links to root docs written later**: `README.md` links `../docs/runbook.md` and `../docs/glossary.md`,
   which C1 creates in wave C (plan §1.1); until then those two links are pending (C1's link check, T032).
10. **Facts found in the collector source worth a team note**: the staging and production profiles raise
    the Hikari pool to 15 and 20 connections (local 10), so laptop pool-pending diagnostics do not transfer
    one-to-one; recorded as a risk in `docs/test-plan.md` §9.
