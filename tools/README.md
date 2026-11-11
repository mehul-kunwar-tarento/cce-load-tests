<!--
  What:    Guide to the Node.js tooling: the one CLI and its commands, every module under tools/, the k6 clock
           contract, the result files, and how a service (or later an adaptor) module plugs into the runner.
  How:     Read before running or changing the tooling. Every command has --help: node tools/cli.mjs <command> --help
  Needs:   Node.js 22 (npm install once in the repository root); Docker for real k6 runs.
  Outputs: Documentation only.
-->

# Node tooling (`tools/`)

All logic around the load generator lives here, in Node.js 22 (ESM, `.mjs`), with two runtime dependencies (`pg`,
`kafkajs`). Shell scripts in `scripts/` are only thin entry points. k6 itself runs in Docker
(`cce-load-tests/k6:2.3.0-kafka2.2.0`); the shared k6 library is in `lib/`.

## The CLI

```bash
node tools/cli.mjs --help                 # every command with one line each
node tools/cli.mjs <command> --help       # options of one command
npm run perf -- <command> …               # the same through npm
```

| Command | Synopsis | Script | What it does |
|---|---|---|---|
| `run` | `run <env> <subject> <test-type> [--set NAME=value]… [--refine-from <dir>] [--dry-run] [--all-settings] [--modules-root <dir>]` | `scripts/run-test.sh` | The whole lifecycle below; `--dry-run` prints settings, phase plan and docker command and stops (no connection, nothing written) |
| `settings` | `settings <env> [<subject> <test-type>] [--set …] [--json] [--all-settings] [--modules-root <dir>]` | `scripts/print-settings.sh` | Resolved settings with source and "to be confirmed" flag, plus the phase plan; without a subject: values only |
| `report` | `report <resultDir>` · `report --series <dir>… \| --latest <n> \| --since <yyyy-mm-dd> [--out <dir>]` | `scripts/build-report.sh` | `report.md` of one run, or `summary.json` + `summary.md` over several runs |
| `baseline` | `baseline save <name> <dir>… [--note] [--force] [--allow-fewer]` · `compare <name> <dir>…` · `list` · `show <name>` | `scripts/manage-baselines.sh` | Baselines (`baselines/README.md`) |
| `check-data` | `check-data <env> <resultDir>` | — | Re-runs a finished run's data checks; rewrites data-checks.json, result.json, report.md |
| `lint-headers` | `lint-headers [--paths <file or folder>…] [--json]` | `npm run lint` | Header comment (What/How/Needs/Outputs) on every file in scope |
| `preflight` | `preflight <env> [--subject <s>]… [--set …] [--json] [--out <file>] [--modules-root <dir>]` | `scripts/check-services.sh` | Built by package A3 (`tools/preflight/`) |
| `cleanup` | `cleanup <env> (--run-id <id> \| --all) [--dry-run] [--print-sql] …` | `scripts/cleanup-test-data.sh` | Built by package A3 (`tools/cleanup/`) |
| `plan-definitions` | `validate \| generate \| status \| load \| retire \| delete \| list-active … [--plan-definition-set <name>] [--set NAME=value]…` (a bare `--set <name>` also names the set) | `scripts/manage-plan-definitions.sh` | Built by package A3 (`tools/plan-definitions/`) |

A command whose file is not installed yet prints a clear message (exit 3) instead of a stack trace.

**Exit codes** (every command): `0` passed / done · `1` a test or data check failed (also: run aborted) ·
`2` refused (prod, preflight failed, guard, idle timeout, bad settings or arguments) · `3` tool error.
k6's own exit code (0, 99 thresholds failed, 108 aborted by script) is recorded in `result.artifacts.k6ExitCode`;
the verdict is `result.status`.

**Command module contract** (`tools/commands/<command>.mjs`, plan §6.1): `export const description`,
`export const usage`, `export async function main(argv, { stdout, stderr, cwd }, deps?) → exit code`. `deps`
(optional) injects fakes in unit tests. Arguments are parsed with `node:util` `parseArgs` via
`core/command-args.mjs` (a typo in an option is refused, exit 2).

## What one run does (`run`, plan §6.2)

1. Load `config/environments/<env>.json` (prod refused) and the subject's `service-module.mjs`.
2. Resolve the settings (`core/run-setup.mjs` → `core/settings.mjs`), create
   `results/<subject>-<test-type>-<yyyymmdd-hhmmss>/`, write `run-context.json`, print settings, phase plan and the
   docker command (secrets masked). `--dry-run` stops before writing anything.
3. Preflight (A3) → `preflight.json`; a required failure stops the run (exit 2). `SKIP_PREFLIGHT=true` is recorded.
4. Conditions (`core/conditions.mjs`): host, git commit (read-only), data volume, plan-definition snapshot.
5. `module.waitForIdle(ctx)`; 6. `module.prepare(ctx)` (Step SLA seeding returns its ring times).
7. Metrics sampler (`service-metrics.json`), watchers (`watch-*.json`), Grafana annotation "run started".
8. k6 in Docker (`core/k6-runner.mjs`) with the k6 clock (`core/k6-clock.mjs`); seeded tests wait for the last alarm.
   Ctrl-C or `ctx.abortLoad(reason)` → `docker kill --signal SIGINT k6-<runId>` (k6 still writes its summary).
9. Watchers until caught up / limit / stall. 10. `module.dataChecks(ctx)` → `data-checks.json`.
11. `core/result-builder.mjs` → `result.json` (validated) → `report/run-report.mjs` → `report.md` (printed).
12. `BASELINE=<name>` → `baseline-comparison.json` and a report section (informational).

## k6 clock contract (plan §4.7)

k6's scenario start times count from the **end of `setup()`**, not from `docker run`: creating thousands of VUs
(one Kafka producer each) can take long. So:

- every test's `setup()` returns `markK6Start()` = `{ k6StartedAtMs }` ("time 0"); phase *i* starts at
  `k6StartedAt + phases[i].startSeconds`;
- **live**, `startK6Clock` polls `GET http://127.0.0.1:<port>/v1/status` every 250 ms; when k6 reports running
  (`running: true`, status `"running"` or `7`), it sets `ctx.times.k6StartedAt`, `measureStart` (= start + measured
  phase `startSeconds`, warm-up excluded) and `sendEnd` (= `measureStart` + measured duration) and resolves
  `ctx.times.ready` — watchers await it before they compute "seconds into the measured phase";
- if the API never answers within 60 s, times are **estimated** from the container start (`timing.source:
  'estimated'`, a warning in the result);
- **afterwards**, the result builder re-bases every time on `context.k6StartedAt` from `k6-summary.json`
  (authoritative, `timing.source: 'k6-setup'`); if k6 stopped early, `sendEnd` = k6's exit time and
  `sendEndedEarly: true`;
- seeded runs (Step SLA) take `measureStart`/`sendEnd` from the seed (`timing.source: 'seed'`).

The REST API port is a free local port picked per run; on the host network k6 listens on `127.0.0.1:<port>`,
on any other Docker network on `0.0.0.0:<port>` published as `-p 127.0.0.1:<port>:<port>`.

## Module map

| Module | Purpose |
|---|---|
| `cli.mjs` | Dispatcher (lists A2 and A3 commands) |
| `commands/run-test.mjs`, `settings.mjs`, `report.mjs`, `baseline.mjs`, `check-data.mjs`, `lint-headers.mjs` | A2 commands (above) |
| `core/paths.mjs`, `errors.mjs`, `command-args.mjs`, `json-file.mjs`, `format.mjs`, `logger.mjs` | Repository paths, exit-code errors (`RefusedError` → 2), strict argument parsing, JSON loading without `$comment`, number/time formatting, timestamped logging |
| `core/lib-bridge.mjs` | Loads the PURE `lib/` modules (duration, phase plan, thresholds) into Node — the same code k6 runs |
| `core/environment.mjs` | `loadEnvironment` (merges `<env>.local.json`, refuses prod), `serviceConfig(env, subject)` (`step-sla` → `stepSla`; falls back to `adaptors.<key>` for a later adaptor module) |
| `core/settings.mjs` | `resolveSettings` (precedence, pinned types, ratios checked 0 … 1, `*_EVENTS` → exact duration = events / rate, auto values, RUN_ID checks; `--refine-from` values with source `refine-from`), `printSettings`, `settingsForResult` |
| `core/run-setup.mjs` | Settings + dataset + plan-definition set in the right order (an `EVENT_ACTION_ID` without a dataset template is refused); `buildRunContext` (run-context.json) |
| `core/run-id.mjs` | `createRunId`, `validateRunId`, `runSelectors` (`LOADTEST-<runId>-<idCode>-`), `uuidV7Floor`, `UUID_V7_SQL`, `runIdEarliestStart` (cleanup's bound without run-context.json: the id's clock read as UTC minus 14 h, valid for a run made in any time zone) |
| `core/results.mjs` | Results folders, JSON read/write, `findResultDirs` (only folders with `result.json`) |
| `core/k6-runner.mjs` | `buildDockerArgs` (name, uid:gid, run context, remote write + tags, `--address`), `runK6`, `stopK6` |
| `core/k6-clock.mjs` | `startK6Clock`, `createTimes` (the shared `ctx.times`) |
| `core/k6-summary.mjs` | `normaliseK6Summary` (both threshold shapes), `subMetric`, `failedThresholds`, `thresholdsFromK6`, `k6Timing` |
| `core/breaking-analysis.mjs` | Windows, staircase levels, backlog series, k6 limit, diagnostics near the break |
| `core/staircase.mjs` | `computeFineLevels`, `refineFromResult` (`--refine-from`) |
| `core/result-builder.mjs` | `buildResult` (result.json v1.0.0) and `computeStatus` |
| `core/events-through.mjs` | "Went through" (R1) = what the service took: HTTP accepted (2xx), Kafka processed (warm-up off, catch-up included), seeded alarms handled; `sent` only when the service's count is missing. `averageRate` = that ÷ `throughSeconds`. Used by the builder and both reports (`throughOf` also derives it for older result.json files) |
| `core/result-schema.mjs` | `validateResult`, `validatePreflight`, `validateCleanup` (hand-written) |
| `core/sampled-metrics.mjs`, `metrics-sampler.mjs` | Sampled service metrics (Hikari, heap, GC, CPU, module extras), `PEAK_SIGNALS`, `computePeaks` |
| `core/watchers.mjs`, `idle.mjs` | Watcher runner and helpers (sample log, counter reset, stall); matcher / Step SLA idle and backlog |
| `core/run-sql.mjs`, `conditions.mjs` | Index-friendly run selection SQL (candidate ids with `candidatePhasePlan`'s 1 % + 10 margin, UUIDv7 bounds), conditions capture |
| `core/run-clients.mjs` | The live clients of a real run (Postgres pool, Kafka admin, scrapes, protocol API) |
| `core/service-registry.mjs` | Finds `<root>/*/service-module.mjs` (one level deep) |
| `core/header-check.mjs`, `inspect-k6.mjs`, `run-shellcheck.mjs` | Header lint (§2.4), `npm run check:k6` (k6 inspect, `--network none`; `--dry-run` prints the commands and writes nothing), `npm run lint:shell` |
| `core/clients/*.mjs` | `postgres` (pool, `queryRows` with statement timeout, `withDedicatedClient`), `kafka-admin` (lag, offsets, group), `prometheus-text` (parse, `sumMetric`/`maxMetric` → null when absent), `http-json`, `grafana` (annotations; token, else admin password, else skipped with one warning) |
| `report/run-report.mjs`, `series-report.mjs` | Run report and series summary, from `result.json` only |
| `baseline/baseline-store.mjs`, `baseline-compare.mjs`, `baseline-metrics.mjs` | Save/load/list, compare (tolerance, unit floors, condition warnings), metric choice per module |
| `results/result.schema.json` | JSON Schema (documentation) of `result.json`; `preflight.schema.json`, `cleanup.schema.json` (A3) |
| `preflight/`, `cleanup/`, `plan-definitions/` | Package A3 (see their headers) |

Unit tests live next to the code in `*/unit-tests/*.spec.mjs` with `fixtures/`; run them all with `npm test`.
They use fakes for Docker, Postgres, Kafka and HTTP: nothing connects anywhere.

## Result files (one folder per run)

`run-context.json` (Node → k6, plan §3.5), `preflight.json`, `seed.json` (Step SLA), `k6-summary.json`, `k6.log`,
`watch-<name>.json`, `service-metrics.json`, `data-checks.json`, **`result.json`** (the only input of reports and
baselines, schema in `results/result.schema.json`), `report.md`, `baseline-comparison.json`, cleanup JSON.

Two result rules worth knowing:

- **Staircase breakpoints** end when a level breaks; their per-level k6 rules are marked `informational` (they find
  the breaking point) and the verdict is the capacity rule `breakpoint.held-up-to` (held ≥ the expected rate).
- **k6 limit** (D9): when only sending failed (dropped iterations / windows short of the plan) while the service
  answered fast (p95 < `K6_LIMIT_P95_MS`), the result says "at least X/s (k6 limit)" — the load generator, not the
  service, was the limit.

## How a service module plugs in (plan §6.4)

Each service folder (named after its repository, e.g. `cce-matcher-service/`) has a `service-module.mjs`:

```js
export default {
  service: 'cce-matcher-service', subject: 'matcher', idCode: 'mat', displayName: 'Matcher',
  kind: 'k6',                       // or 'seeded' (no k6; prepare() writes the load into the database)
  breakpointKind: 'flood',          // 'staircase' (HTTP) | 'flood' (Kafka) | 'none' (seeded)
  testTypes: ['smoke', 'load', 'stress', 'breakpoint'],
  requires: { services: ['matcher'], postgres: true, kafka: true, protocol: true },   // drives preflight
  testFile: (testType) => new URL(`./tests/matcher-${testType}.test.js`, import.meta.url),
  expectation({ testType, settings, environment, planDefinitionSet }) { return { summary, targetRate, peakRate, multipleOfPeak, unit, toBeConfirmed }; },
  waitForIdle: (ctx) => waitForMatcherIdle(ctx),           // optional (core/idle.mjs through shared.mjs)
  prepare: async (ctx) => undefined,                        // optional; seeded: return { measureStart, sendEnd, plannedEvents, manifestFile }
  watchers: [(ctx) => createBacklogWatcher(ctx)],           // optional; contract in core/watchers.mjs (plan §6.5)
  sampledMetrics: [ { key: 'processingSecondsSum', name: 'cce_events_processing_duration_seconds_sum', agg: 'sum', unit: 'seconds' } ],
  async dataChecks(ctx) { return [ /* { id, description, expected, actual, comparison, passed, severity, sql? } */ ]; },
  evaluate(ctx, partial) { return { thresholds: [], breaking: {}, load: {}, notes: [] }; },   // module-specific rules only
  baselineMetrics(result) { return [ { key: 'matcher.load.maxBacklog', label: '…', unit: 'events', better: 'lower', value: 0 } ]; },
};
```

- **`ctx`** (built by `run`): `environment`, `settings` (typed values), `resolved`, `phasePlan`, `runId`, `prefix`
  (`LOADTEST-<runId>-`), `selector` (`LOADTEST-<runId>-<idCode>-`), `resultsDir`, `context` (run-context.json),
  `pgPool`, `kafkaAdmin`, `scrape(subject)`, `logger`, `times` (k6 clock; `await ctx.times.ready`),
  `planDefinitionSet` (loaded set + snapshot incl. `effectiveFanOut`, `expectedRows`), `writeJson(name, value)`,
  `abortLoad(reason)`.
- **`evaluate(ctx, partial)`**: `partial = { k6Summary, watcherOutcomes, dataChecks, times, phasePlan }`. The
  result builder already adds the k6 rules (`thresholdsFromK6`) and watcher rules; return only rules specific to the
  module. Rules with the same `id` replace earlier ones (k6 < watcher < module).
- **Self-contained folders**: inside a service folder only `shared.mjs` imports `../tools/*` (`core/`, and for the
  matcher also `plan-definitions/`) and `../lib/*`, and only `tests/shared-lib.js` imports `../../lib/*`; every other
  file imports those two shims. Copying the folder into
  its repository as `performance-tests/` then means rewriting the two shims only. Modules never import each other.
- **Discovery**: the registry finds the folder automatically (`--modules-root <dir>` points it elsewhere; the wave-A
  stub lives in `core/unit-tests/fixtures/stub-service/`). An adaptor or the end-to-end flow plugs in the same way
  later, as its own folder.
