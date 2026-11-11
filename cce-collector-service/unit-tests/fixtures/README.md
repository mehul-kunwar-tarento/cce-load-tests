<!--
  What:    Describes the JSON fixtures of the collector unit tests (JSON fixtures carry no header comment,
           so they are documented here).
  How:     Read before changing a fixture or adding one; the unit tests in ../ load them through
           ../test-helpers.mjs readFixture(name).
  Needs:   ../../../lib/phase-plan.js and ../../../lib/thresholds.js (the shapes the fixtures follow);
           config/settings/defaults.json.
  Outputs: Nothing; documentation of synthetic test inputs (no live run produced them).
-->

# Collector unit-test fixtures

All files are **synthetic**: no CCE service, Postgres, Kafka or k6 run against a live stack produced them
(static verification only). They were generated once in the session scratchpad with the real
`lib/phase-plan.js` (`buildPhasePlan`) and the threshold / scenario keys of `lib/thresholds.js`, then given
hand-chosen metric values. Each has the shape of a k6 `handleSummary` file written by `lib/summary.js`
`writeSummary`: `metrics`, `setup_data` (`k6StartedAtMs`), `root_group`, `options`, `state`
(`testRunDurationMs`) and `context` (`runId`, `subject`, `testType`, `phasePlan`, `k6StartedAt`).

| File | Test type | Story it tells | Used by |
|---|---|---|---|
| `settings-overrides.json` | — | The small `--set` style overrides (common + per test type) the k6 summaries were generated with: `RUN_ID fixture01`, report window 10 s; load = warm-up 2/s × 10 s, then 10/s × 60 s (6 windows); breakpoint = warm-up 5/s × 10 s, then levels 20, 40, 80/s × 10 s. Its `$comment` explains it | `../test-helpers.mjs` `fixtureSettings()`; the "fixtures are still in step" test resolves these with `resolveSettings` and compares the plan with each summary's `context.phasePlan` |
| `k6-summary-load-passed.json` | load | Every rule passed: 620 sent = 620 accepted (20 warm-up + 600 measured), 0 dropped, p95 22 ms | `evaluate.spec.mjs` (passing load; whole result validates), `collector-data-checks.spec.mjs` |
| `k6-summary-load-k6-limited.json` | load | Only `dropped_iterations` failed (11 dropped; allowed floor(600 × 0.001) = 0) while p95 stayed 18 ms — a **k6 limit**, not a collector failure | `evaluate.spec.mjs` (k6Limited, informational throughput shortfall) |
| `k6-summary-breakpoint-broke.json` | breakpoint | Levels 20/s held, 40/s broke on p95 (above 500 ms), 80/s not reached → held up to 20/s, broke at 40/s | `evaluate.spec.mjs` (staircase facts, `--refine-from` note), `collector-data-checks.spec.mjs` ("between" comparison) |
| `k6-summary-breakpoint-k6-limited.json` | breakpoint | 40/s fell short (610 dropped) while p95 stayed ~15 ms → "at least 20/s (k6 limit)" | `evaluate.spec.mjs` (k6-limit staircase) |

To change a fixture: keep the keys produced by `lib/` (`http_req_duration{scenario:measure}`,
`iterations{window:3}`, `http_req_duration{level:40}`, `events_accepted{scenario:measure}`, …) and the
threshold rules as `{ "ok": true|false }`; if you change `settings-overrides.json`, regenerate the
summaries' `context.phasePlan` with `buildPhasePlan` or the in-step test fails (on purpose).
