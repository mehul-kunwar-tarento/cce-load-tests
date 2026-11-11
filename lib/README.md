<!--
  What:    Guide to the shared k6 library: every module, which ones are pure (also used by Node) and which
           need k6, the skeleton of a test file, the k6 clock contract, and the shape of k6-summary.json
           (including the verbatim/synthetic fixtures in unit-tests/fixtures/, which cannot carry headers).
  How:     Read before writing or changing a k6 test. Unit tests: node --test 'lib/unit-tests/*.spec.mjs'.
  Needs:   specs/000-performance-testing-setup/plan.md §3.3, §3.5, §4, §5.3 (the contract);
           specs/001-shared-k6-library-and-test-data/ (this library's spec).
  Outputs: Documentation only.
-->

# Shared k6 library (`lib/`)

Every k6 performance test (collector, matcher, later adaptors) is a thin file on top of this library. The
library never reads settings from environment variables and never parses setting text: Node
(`tools/core/settings.mjs`) resolves every setting once, computes the phase plan with the same
`phase-plan.js`, and writes `results/<dir>/run-context.json`; k6 reads that file (`RUN_CONTEXT`).

## Modules

**PURE** = no `k6` imports, no `open()`, no `__ENV`: Node imports them too, and `lib/unit-tests/purity.spec.mjs`
enforces it. **K6** = runs only inside k6.

| Module | Kind | Exports | Purpose |
|---|---|---|---|
| `duration.js` | PURE | `parseDuration`, `formatDuration`, `toK6Duration` | `"90s"`, `"10m"`, `"1h30m"`, `"500ms"`, integer seconds → seconds; refuses garbage (v1 silently gave 0) |
| `settings-guard.js` | PURE | `requireNumber`, `requireInteger`, `requireRate`, `requireRateList` | Fails loudly when a setting is missing or still text (e.g. `'10m'` instead of `600`) |
| `phase-plan.js` | PURE | `buildPhasePlan`, `phaseAt`, `plannedSentBy`, `measuredPhaseOf`, `TEST_TYPES`, `BREAKPOINT_KINDS` | Test type + settings → phases (warm-up, measure, staircase levels, flood, Step SLA ring schedule) and report windows (plan §4.1) |
| `windows.js` | PURE | `windowIndexAt`, `levelAt`, `windowBounds`, `windowCoverSeconds` | Which report window / staircase level a moment belongs to (plan §4.4) |
| `thresholds.js` | PURE | `allowedDropped`, `buildThresholds`, `describeThreshold`, `isDummyRule`, `DUMMY_RULES` | Every pass/fail rule (plan §4.2) and its plain-words description |
| `scenarios.js` | PURE | `buildOptions`, `buildScenarios`, `vusFor`, `k6ConstantSeconds`, `SUMMARY_TREND_STATS` | Phase plan → k6 options: arrival-rate scenarios `smoke` / `warm-up` / `measure`, VUs, thresholds, tags (plan §4.3) |
| `test-data.js` | PURE | `testDataPrefix`, `buildPatientId`, `buildEventId`, `buildCorrelationId`, `fillTemplate`, `buildFhirResource`, `buildCloudEvent`, `eventDefaults`, `buildIterationEvent`, `MAX_CLOUD_EVENT_ID_LENGTH` | `LOADTEST-<runId>-…` ids (≤ 50 chars), dataset templates → FHIR resource → CloudEvent (plan §2.3, §4.6) |
| `run-context.js` | K6 | `getRunContext`, `assertRunContextFor` | Reads `run-context.json` (absolute `RUN_CONTEXT`) once; refuses a context for another test |
| `tagging.js` | K6 | `tagIteration` | Tags each iteration with `phase`, `level` (staircase), `window` (measured phase) |
| `http-client.js` | K6 | `postJson`, `checkResponse`, `statusIs`, `jsonFieldEquals` | JSON POST with a fixed `name` tag; named checks |
| `kafka-client.js` | K6 | `createProducer`, `produceEvent` | xk6-kafka 2.2.0 producer (one per VU), exactly as v1 used it |
| `event-metrics.js` | K6 | `eventsSent`, `eventsAccepted`, `recordSend` | Counters `events_sent` / `events_accepted` (names are part of the result contract) |
| `summary.js` | K6 (no k6 imports; unit-tested in Node) | `markK6Start`, `writeSummary`, `summaryText` | `setup()` time stamp; `handleSummary` → `k6-summary.json` + short text |

`settings` everywhere = `ResolvedSettings.values` (plan §3.3): durations are **numbers of seconds**, `LEVELS` is
`number[]`, unset settings are `null`. `*_EVENTS` are already turned into `*_DURATION` by Node; nothing here
derives them. A duration may be fractional (events / rate, e.g. 1,001 events at 50/s = 20.02 s): the phase plan
then plans exactly that many events and `k6ConstantSeconds` stops the k6 scenario half a gap before the next
event start (20.01 s), so k6 sends exactly the total. Phases k6 runs must last at least 1 s (k6's minimum):
`buildPhasePlan` refuses shorter ones (e.g. `MATCHER_FLOOD_EVENTS=1001` at 2,000/s = 0.5 s).

## Test-file skeleton

Every k6 test exports exactly `options`, `setup`, `default` and `handleSummary`:

```js
// <service-folder>/tests/collector-load.test.js (B packages; imports go through tests/shared-lib.js, plan §6.4)
import exec from 'k6/execution';
import { getRunContext, assertRunContextFor, buildOptions, tagIteration, buildIterationEvent,
         postJson, checkResponse, statusIs, jsonFieldEquals, recordSend, markK6Start, writeSummary } from './shared-lib.js';

const context = getRunContext();                                   // init context: reads RUN_CONTEXT
assertRunContextFor(context, { subject: 'collector', testType: 'load' });
export const options = buildOptions({ context, kind: 'http' });    // or kind: 'kafka'

export function setup() { return markK6Start(); }                  // "time 0" (k6 clock contract)

export default function () {
  const { phaseIndex } = tagIteration(context);                    // first: phase / level / window tags
  const { cloudEvent } = buildIterationEvent({ context, phaseIndex, n: exec.scenario.iterationInTest });
  const res = postJson(`${context.environment.services.collector.baseUrl}/v1/events`, cloudEvent, { name: 'POST /v1/events' });
  recordSend(checkResponse(res, { 'status is 202': statusIs(202), 'event accepted': jsonFieldEquals('data.status', 'accepted') }));
}

export function handleSummary(data) { return writeSummary(data, context); }
```

Kafka tests create the producer at the top level (`createProducer({ brokers: context.environment.kafka.brokers,
topic: context.environment.kafka.inboundTopic })`), call `produceEvent(producer, { key: patientId, value:
JSON.stringify(cloudEvent) })` inside `try`, check the outcome with k6's `check()` and `recordSend(ok)`.

## k6 clock contract (plan §4.7)

- Scenario `startTime`s count from the **end of `setup()`**. So `setup()` returns `markK6Start()` =
  `{ k6StartedAtMs: Date.now() }`, which is "time 0" of the phase plan: phase *i* really starts at
  `k6StartedAt + phases[i].startSeconds`.
- Init time (creating thousands of VUs, one Kafka producer per VU) happens before `setup()` and is excluded, so
  the docker start time is **not** time 0.
- Inside an iteration, `tagIteration` computes `elapsed = (Date.now() − exec.scenario.startTime) / 1000 +
  phase.startSeconds` (seconds since time 0), clamped into the phase, and maps it to a level and window with
  `windows.js`.
- Node learns the same instant live by polling the k6 REST API (`tools/core/k6-clock.mjs`) and afterwards,
  authoritatively, from `context.k6StartedAt` in `k6-summary.json`.

## `k6-summary.json` shape (captured from k6 2.3.0)

`writeSummary(data, context)` returns `{ '<resultsDirInContainer>/k6-summary.json': <JSON>, stdout: <text> }`.
The JSON is k6's raw handleSummary data plus our `context` block:

```json
{
  "metrics": {
    "http_req_duration{level:2}": { "type": "trend", "contains": "time",
      "values": { "avg": 0, "min": 0, "med": 0, "max": 0, "p(90)": 0, "p(95)": 0, "p(99)": 0 },
      "thresholds": { "p(95)<500": { "ok": true } } },
    "http_req_failed{level:2}": { "type": "rate", "contains": "default",
      "values": { "rate": 1, "passes": 5, "fails": 0 }, "thresholds": { "rate<0.01": { "ok": false } } },
    "iterations{window:0}": { "type": "counter", "contains": "default", "values": { "count": 3, "rate": 0.37 },
      "thresholds": { "count>=0": { "ok": true } } },
    "vus_max": { "type": "gauge", "contains": "default", "values": { "value": 4, "min": 4, "max": 4 } }
  },
  "setup_data": { "k6StartedAtMs": 1793911738799 },
  "root_group": { "name": "", "path": "", "id": "…", "groups": [], "checks": [ … ] },
  "options": { "summaryTrendStats": ["avg","min","med","max","p(90)","p(95)","p(99)"], "summaryTimeUnit": "", "noColor": false },
  "state": { "isStdOutTTY": false, "isStdErrTTY": false, "testRunDurationMs": 8002.342055 },
  "context": { "runId": "…", "subject": "…", "testType": "…", "phasePlan": { … },
               "k6StartedAt": "2026-11-05T20:48:58.799Z", "testRunDurationMs": 8002.342055 }
}
```

Facts observed in the captured run (relevant for `tools/core/k6-summary.mjs`, A2):

- **Threshold outcomes** are `metrics[key].thresholds[rule] = { "ok": boolean }` (handleSummary form);
  sub-metric keys are written exactly as in `options.thresholds`, e.g. `http_req_duration{level:400}`,
  `iterations{window:3}`, `events_sent{scenario:measure}`. Metrics without a threshold have no `thresholds` key.
- **Rate** metrics: `values.passes` counts *true* samples (for `http_req_failed`, a failed request is a "pass").
- **Sub-metrics that never got a sample** (e.g. a staircase level not reached before an abort) are still listed
  with all values 0 and every threshold `ok: true` — k6 does not judge empty sub-metrics. Use
  `iterations{level:R}.values.count === 0` to tell "not reached" from "held".
- Trend values are in **milliseconds** for `contains: "time"`.
- `context.testRunDurationMs` is `null` and `k6StartedAt` `null` when k6 did not report them.
- With `RUN_CONTEXT` passed as a **docker** env var (`docker run -e RUN_CONTEXT=…`), `k6 run` sees it in
  `__ENV`; `k6 inspect` does **not** include system env vars, so inspect needs k6's own flag:
  `k6 inspect -e RUN_CONTEXT=… <file>`.
- **xk6-kafka 2.2.0** registers `kafka_writer_message_count`, `kafka_writer_error_count`, `kafka_writer_write_count`,
  `kafka_writer_retries_count`, `kafka_writer_message_bytes`, `kafka_writer_write_seconds`,
  `kafka_writer_batch_seconds`, `kafka_writer_wait_seconds`, `kafka_writer_async`, … `produce()` returns as
  soon as librdkafka has the message: against an unreachable broker it returned without an error and the message
  was counted as written. Kafka delivery is therefore proven by the Node watcher (topic offsets, consumer lag),
  not by k6.

## Fixtures (`unit-tests/fixtures/`, verbatim, no header)

| File | Origin | Content |
|---|---|---|
| `k6-summary-sample.json` | **Captured**: `k6 run` of a probe (scratchpad, outside the repo) with `--network none` against `http://127.0.0.1:1`; staircase breakpoint with warm-up 2 s at 2/s, levels 2 and 4/s × 3 s, 2-s windows (22 requests, all connection-refused) | Real k6 2.3.0 shape: level/window/scenario sub-metrics, two failed rules (`http_req_failed{level:2}`, `{level:4}`), `setup_data.k6StartedAtMs`, `state.testRunDurationMs`, `context` |
| `k6-summary-breakpoint.json` | **Synthetic**, same shape, thresholds from the real `buildThresholds` | Collector staircase 200→6400/s (defaults): held up to 1,600/s, 3,200/s broke on p95 812.5 ms (aborted 25 s into the level), 6,400/s not reached (zeros, `ok: true`), 640 dropped, 36 windows (27 reached) |
| `k6-summary-kafka.json` | **Synthetic**, same shape, metric names from a real xk6-kafka 2.2.0 probe | Matcher flood 2,000/s × 60 s after warm-up: 35 dropped (allowed 120), no write errors, 6 windows, `kafka_writer_*` metrics |

The probe script, its run contexts and the generator of the synthetic fixtures are throwaway files in the
session scratchpad, described in `specs/001-shared-k6-library-and-test-data/plan.md`.

## Unit tests

```bash
node --test 'lib/unit-tests/*.spec.mjs'
```

`settings-fixture.mjs` holds typed settings at the plan §3.2 defaults (pre-derived numbers).
