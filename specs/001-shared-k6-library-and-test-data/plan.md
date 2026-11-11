<!--
  What:    Implementation plan of work package A1 (shared k6 library, k6 image, test data): approach, every
           file, the exported interfaces and the deviations from the 000 contract.
  How:     Read after spec.md (same folder). tasks.md lists the work in order.
  Needs:   specs/000-performance-testing-setup/plan.md §2–§4, §5.3, §7.3, §12, §13.
  Outputs: The A1 build plan; "Deviations / requests" is collected by C1 into docs/open-questions.md.
-->

# Implementation Plan: Shared k6 library, k6 Docker image and test data

**Branch**: n/a (folder only) · **Date**: 2026-11-06 · **Spec**: [spec.md](spec.md) · **Tasks**: [tasks.md](tasks.md)

## Approach

1. **Pure first.** The six pure modules hold all the arithmetic (phase plan, thresholds, scenarios, windows,
   durations, ids and templates). They are plain ES modules with no k6 imports, so Node (A2's settings
   printout, result builder, breaking analysis) imports the same code k6 runs, and `node --test` covers them.
2. **Typed settings in, no parsing.** Pure modules receive `ResolvedSettings.values` (§3.3). A small guard
   (`requireNumber`) throws when a duration arrives as a string, so a wiring mistake fails loudly instead of
   silently becoming 0 (v1 bug).
3. **Thin k6 layer.** `run-context.js` (open the JSON once), `tagging.js` (phase/level/window VU tags, the v1
   `tagLevel` idea generalised), `http-client.js`, `kafka-client.js` (xk6-kafka 2.2.0 exactly as v1 used it),
   `event-metrics.js` (counters), `summary.js` (handleSummary JSON + short text; it imports nothing from k6,
   so it is unit-tested in Node too).
4. **Ported logic and fixed lessons.** From v1: staircase stages and per-level abort rules
   (`archive/v1/lib/breakpoint.js`), smoke abort and stress safety stop (`smoke.js`, `stress.js`), the eBUZIMA
   resource builders and journeys (`ebuzima.js` → `dataset.json` templates), the Kafka producer
   (`matcher/matcher.js`). Fixed: `dropped_iterations count==0` → `<= allowedDropped` (D9); v1's
   `seconds()` silently returning 0 → `parseDuration` throws; hard-coded `source: 'ebuzima'` → dataset
   `source`; random UUID event ids → enumerable `<patientId>-<step>`; staircase VUs from a fixed 200/1500 →
   formula; per-window sub-metrics for "when it started breaking".
5. **Test data as data.** The dataset is JSON templates with `{{placeholders}}`; plan-definition variants are
   override files applied to one base fixture (A3 applies them); sets list base + overrides.
6. **Scripted derivations, recorded.** Two throwaway scripts in the session scratchpad (outside the repo):
   - `derive/derive-overrides.mjs`: reads the base and each `archive/v1/protocol/variants/<v>.json`, checks
     top-level `id`/`url`/`name` start with the base value and records the suffix, copies `title` and
     `description`, walks every action (any depth) by `id` and records each action whose `requiredBehavior` or
     tolerance-days extension differs (`{requiredBehavior, toleranceDays|null}`), writes
     `test-data/plan-definitions/variants/<v>.overrides.json`, then **self-checks**: applies the overrides with
     the §7.3 rule (tolerance-days appended as last `extension` entry or replaced in place; `null` removes;
     empty `extension` removed) and compares with the v1 file deep-equal after recursively sorting object keys
     and keeping array order. **Result (run 2026-11-06): strict 4 actions overridden, light 2, lab-focus 6; mandatory steps 7, 1, 5;
     3/3 deep-equal** (recorded at T021).
   - `derive/check-dataset.mjs`: loads `archive/v1/lib/ebuzima.js` with its `k6/execution` import stubbed,
     builds each of the 10 v1 step resources and compares them with `fillTemplate` of the dataset templates.
     **Result (run 2026-11-06): 10/10 templates deep-equal, journeys equal** (recorded at T019).
7. **k6 summary fixture.** A probe (`probe/probe.js` + `probe/run-context.json` in the scratchpad, mounted
   as `/probe`) imports every lib module, runs a tiny staircase with warm-up against `http://127.0.0.1:1`
   under `--network none`, and its handleSummary output is saved as `lib/unit-tests/fixtures/k6-summary-sample.json`.
   The two synthetic fixtures are generated in the same shape (`probe/make-synthetic.mjs`, threshold keys from
   the real `buildThresholds`, metric names from a second offline probe `probe/probe-kafka.js` against the dead
   broker `127.0.0.1:1`, and empty sub-metrics reported as k6 does: zeros with `ok: true`, seen in a third probe).

## Files

| File | Purpose |
|---|---|
| `lib/README.md` | Module list (pure vs k6), test-file skeleton, k6 clock contract, summary/threshold shape |
| `lib/duration.js` | PURE `parseDuration`, `formatDuration`, `toK6Duration` |
| `lib/settings-guard.js` | PURE `requireNumber`, `requireInteger`, `requireRate`, `requireRateList` (typed-settings guards shared by the pure modules) |
| `lib/phase-plan.js` | PURE `buildPhasePlan`, `phaseAt`, `plannedSentBy`, `measuredPhaseOf` |
| `lib/windows.js` | PURE `windowIndexAt`, `levelAt`, `windowBounds`, `windowCoverSeconds` |
| `lib/thresholds.js` | PURE `allowedDropped`, `buildThresholds`, `describeThreshold`, `isDummyRule`, `DUMMY_RULES` |
| `lib/scenarios.js` | PURE `buildScenarios`, `buildOptions`, `vusFor`, `SUMMARY_TREND_STATS` |
| `lib/test-data.js` | PURE ids, `fillTemplate`, `buildFhirResource`, `buildCloudEvent`, `eventDefaults`, `buildIterationEvent` |
| `lib/run-context.js` | K6 `getRunContext`, `assertRunContextFor` |
| `lib/tagging.js` | K6 `tagIteration` |
| `lib/http-client.js` | K6 `postJson`, `checkResponse`, `statusIs`, `jsonFieldEquals` |
| `lib/kafka-client.js` | K6 `createProducer`, `produceEvent` |
| `lib/event-metrics.js` | K6 `eventsSent`, `eventsAccepted`, `recordSend` |
| `lib/summary.js` | K6 (no k6 imports) `markK6Start`, `writeSummary`, `summaryText` |
| `lib/unit-tests/{duration,phase-plan,windows,thresholds,scenarios,test-data,summary,test-data-files,purity}.spec.mjs` | node --test |
| `lib/unit-tests/fixtures/k6-summary-{sample,breakpoint,kafka}.json` | Summary fixtures (§5.3), described in lib/README.md |
| `docker/k6/Dockerfile`, `docker/k6/README.md` | Image source (copied from archive/v1/docker) and how to build/check it |
| `scripts/build-k6-image.sh` | Thin `docker build` of `docker/k6` |
| `test-data/README.md` | Datasets vs plan definitions vs sets, adding each, LOADTEST tagging, `$comment` rules |
| `test-data/datasets/ebuzima-emr/dataset.json` | First dataset (templates per action id, journeys) |
| `test-data/plan-definitions/emr-service-protocol.json` | Verbatim base PlanDefinition |
| `test-data/plan-definitions/variants/{strict,light,lab-focus}.overrides.json` | Overrides (§7.3), scripted diff |
| `test-data/plan-definition-sets/{single,overlapping-2,overlapping-4}/set.json` | Sets (§7.3) |
| `specs/001-shared-k6-library-and-test-data/{spec,plan,tasks}.md` | This spec |

## Interfaces

```js
// lib/duration.js (§4.5)
parseDuration(text: string|number) → seconds            // throws Error('Invalid duration "x": use e.g. 30s, 10m, 1h30m')
formatDuration(seconds) → '10m 0s' | '30s' | '1h 30m 0s' | '200ms'
toK6Duration(seconds) → '600s' | '200ms'                 // what k6 options accept
// lib/phase-plan.js (§4.1)
buildPhasePlan({ testType, settings, breakpointKind = 'staircase' }) → PhasePlan
phaseAt(phasePlan, elapsedSeconds) → { phase: Phase|null, phaseIndex: number /* -1 when none */, level: Level|null }
plannedSentBy(phasePlan, elapsedSeconds) → number         // events the schedule should have started by t (all phases)
measuredPhaseOf(phasePlan) → Phase
// Phase.startSeconds and Level.startSeconds are seconds since k6 start (end of setup()).
// Staircase measure phase: rate = top level; levels[i].plannedEvents = rate × LEVEL_DURATION.
// lib/windows.js (§4.4)
windowIndexAt(phasePlan, elapsedSeconds) → number|null   // null outside the measured phase / window cover
levelAt(phasePlan, elapsedSeconds) → number|null         // the level's rate; null outside a staircase
windowBounds(phasePlan, index) → { startSeconds, endSeconds, absoluteStartSeconds, absoluteEndSeconds }
                                                          // startSeconds/endSeconds: since measured-phase start
windowCoverSeconds(phasePlan) → number                    // measured duration, or windowCount × windowSeconds (storm)
// lib/thresholds.js (§4.2)
allowedDropped(plannedEvents, maxDroppedRate) → floor(planned × rate)
buildThresholds({ phasePlan, settings, kind: 'http'|'kafka' }) → { [metricKey]: Array<string|{threshold, abortOnFail, delayAbortEval?}> }
describeThreshold(metricKey, rule) → { metric, rule, description, unit }
isDummyRule(rule) → boolean                               // 'count>=0' | 'p(95)>=0' | 'rate>=0'
// lib/scenarios.js (§4.3)
vusFor(rate, { kind, maxVus, kafkaPreAllocatedVus, kafkaMaxVus }) → { preAllocatedVUs, maxVUs }
buildScenarios(phasePlan, { exec = 'default', kind = 'http', maxVus, kafkaPreAllocatedVus, kafkaMaxVus }) → options.scenarios
buildOptions({ context, kind }) → { scenarios, thresholds, summaryTrendStats, tags, noConnectionReuse: false }
// lib/test-data.js (§4.6, §2.3)
MAX_CLOUD_EVENT_ID_LENGTH = 50
testDataPrefix(runId); buildPatientId({ runId, idCode, phaseIndex, n }); buildEventId(patientId, stepNumber)
buildCorrelationId(runId, n) → 'LOADTEST-<runId>-corr-<n>'
fillTemplate(template, values) → object
buildFhirResource({ dataset, actionId, patientId, eventId, facilityId, time, endTime = time }) → object
buildCloudEvent({ dataset, resource, patientId, eventId, facilityId, correlationId, source, time }) → CloudEvent
eventDefaults({ dataset, settings }) → { source, facilityId, actionId }
buildIterationEvent({ context, phaseIndex, n, stepNumber = 1, now = new Date() }) → { patientId, eventId, cloudEvent }
// K6 modules (§4.7)
getRunContext() → RunContext;  assertRunContextFor(context, { subject, testType }) → void
tagIteration(context) → { phaseIndex, phase, level, window }
postJson(url, body, { name, tags, headers, timeout }) → Response;  checkResponse(response, checksByName, tags) → boolean
statusIs(code) → (r) => boolean;  jsonFieldEquals(path, value) → (r) => boolean
createProducer({ brokers, topic }) → Producer;  produceEvent(producer, { key, value }) → void (throws on error)
eventsSent, eventsAccepted (Counter);  recordSend(accepted) → void
markK6Start() → { k6StartedAtMs };  writeSummary(data, context) → { '<dir>/k6-summary.json': string, stdout: string }
```

k6 summary shape (captured from k6 2.3.0, recorded in `lib/README.md`): `metrics.<key>.thresholds` is
`{ "<rule>": { "ok": boolean } }`; sub-metric keys look like `http_req_duration{level:400}`.

## Technical Context

| Item | Value |
|---|---|
| Language | JavaScript ES modules (`.js` for lib, `.mjs` for unit tests) |
| Runtimes | k6 2.3.0 (goja/sobek, ES modules) and Node.js 22 (pure modules + tests) |
| Dependencies | none (node:test, node:assert); k6 built-ins + `k6/x/kafka` in the K6 modules |
| Testing | `node --test lib/unit-tests/`, `k6 inspect` / one probe `k6 run` with `--network none` |
| Constraints | Static only (D14); no secrets; no state-changing git; owned paths only |

## Deviations / requests

1. **Extra exports** (additive, no contract change): `toK6Duration`, `measuredPhaseOf`, `windowCoverSeconds`,
   `DUMMY_RULES`, `vusFor`, `SUMMARY_TREND_STATS`, `buildCorrelationId`, `eventDefaults`,
   `buildIterationEvent`, `assertRunContextFor`, `statusIs`, `jsonFieldEquals`, `summaryText`, and the helper
   module `lib/settings-guard.js` (pure).
2. **`buildScenarios` options**: besides `{ exec, maxVus }` it takes `kind`, `kafkaPreAllocatedVus`,
   `kafkaMaxVus` (the Kafka VU formula of §4.3 needs them). `buildOptions` fills them from settings.
3. **Per-window `checks{window:i}` `rate>=0`** dummy rule added for every k6 test (http and kafka), because
   §6.9 breaks a window on "checks < MIN_CHECKS_RATE", which needs the per-window checks rate in the summary.
4. **Smoke abort**: for a smoke test the measured-scenario rule `checks{scenario:smoke}` carries
   `abortOnFail: true` (the "warm-up/smoke sanity" rule of §4.2 and v1's smoke behaviour); a separate
   duplicate rule is not added because k6 keys rules by expression.
5. **Storm windows**: the storm phase has no duration, so its windows cover `BREAKPOINT_CATCH_UP_LIMIT`;
   `windowSeconds = max(REPORT_WINDOW, ceil(BREAKPOINT_CATCH_UP_LIMIT / 200))` (= `REPORT_WINDOW` at
   defaults), so the ≤ 200-windows rule also holds there.
6. **Level start times** are absolute (seconds since k6 start, like `Phase.startSeconds`);
   `windowBounds` returns both measure-relative and absolute seconds.
7. **`events_accepted`** gets `add(0)` for a rejected send so the measured-scenario sub-metric always exists
   (count 0 instead of a missing key).
8. **Request to A2**: `package.json` should have `"type": "module"` (lib `.js` files are ES modules; Node 22
   detects the syntax meanwhile) and `npm test` should include `lib/unit-tests/`.
9. **Formatting**: A2's `prettier.config.mjs` and `prettier@3.9.10` were already installed when A1 formatted,
   so A1 used them (`node_modules/.bin/prettier --write lib test-data docker`) instead of `npx prettier@<x>`.
10. **Request to A2 (`.prettierignore`)**: add `test-data/plan-definitions/*.json`. The base PlanDefinition is a
    **verbatim** copy of the v1 file (byte-equal, checked with `cmp`); `prettier --write .` (000 T014) would
    reflow it and `prettier --check .` would flag it. A1 restored the verbatim copy after its own formatting run.
11. **For A3**: the overrides list only actions whose `requiredBehavior` or tolerance-days differ from the base;
    every listed action has both keys. Variant `version` equals the base `1.0.0` (v1 did the same).
12. **Findings for A2 (k6 runner, k6-summary normaliser)** from the offline probes (details in `lib/README.md`):
    (a) `docker run -e RUN_CONTEXT=…` reaches `__ENV` in `k6 run` (system env vars are included), but `k6 inspect`
    does not include them: `inspect` needs k6's own `-e RUN_CONTEXT=…` after the subcommand (relevant for
    `tools/core/inspect-k6.mjs`); (b) sub-metrics that never got a sample (a staircase level not reached) are
    listed with zeros and every threshold `ok: true`, so "not reached" must be read from
    `iterations{level:R}.values.count === 0`; (c) for `http_req_failed` a failed request is a "pass" in
    `values.passes`.
13. **Finding for B2 / open question**: xk6-kafka 2.2.0 `produce()` returns once librdkafka has the message; against
    an unreachable broker it returned in ~30 ms without an error, counted the message in
    `kafka_writer_message_count` and left `kafka_writer_error_count` at 0. "Accepted" for Kafka therefore means
    "handed to the producer"; delivery must be proven by the Node backlog watcher (topic end offsets / consumer
    lag) and stall detection, and the `kafka_writer_error_count` rule alone cannot catch a dead broker.
14. **Shellcheck** was not available locally; `scripts/build-k6-image.sh` passed `bash -n` only (A2's
    `npm run lint:shell` covers ShellCheck).
