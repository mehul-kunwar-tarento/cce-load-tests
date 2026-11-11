<!--
  What:    Task list of work package B1 (collector performance tests), ticked as each task is done.
  How:     Work top to bottom; "[P]" tasks of one phase touch different files and can run in parallel.
  Needs:   spec.md and plan.md (same folder); specs/000-performance-testing-setup/plan.md.
  Outputs: Progress record of B1; unticked "DEFERRED (owner)" tasks need a live stack (D14).
-->

# Tasks: Collector performance tests

**Input**: `spec.md`, `plan.md` (this folder) · **Contract**: `specs/000-performance-testing-setup/plan.md`
**Format**: `- [ ] T### [P] Description with exact file path`

## Phase 1: Setup

- [x] T001 Write `cce-collector-service/specs/001-collector-performance-tests/spec.md`, `plan.md`, `tasks.md`
- [x] T002 Read the wave-A interfaces actually built (`lib/README.md`, `tools/README.md`, specs 001–004 deviations) and the v1 reference (`archive/v1/collector/collector.js`, `lib/breakpoint.js`, `flow.sh` SQL)

## Phase 2: Foundational (shims)

- [x] T010 [P] `cce-collector-service/shared.mjs` — the only Node file importing `../tools/core/*` and `../lib/*`
- [x] T011 [P] `cce-collector-service/tests/shared-lib.js` — the only k6 file importing `../../lib/*`

## Phase 3: User Story 1 — run a collector test and read the verdict (P1)

- [x] T020 `cce-collector-service/tests/collector-scenario.js` — `createCollectorIteration(context)` (tag, ids, FHIR resource, CloudEvent, POST, checks, recordSend)
- [x] T021 [P] `cce-collector-service/tests/collector-smoke.test.js`
- [x] T022 [P] `cce-collector-service/tests/collector-load.test.js`
- [x] T023 [P] `cce-collector-service/tests/collector-stress.test.js`
- [x] T024 `cce-collector-service/data-checks/collector-data-checks.mjs` — stored-equals-accepted, no-rejections, downstream-logged (info), downstream-backlog-left (info)
- [x] T025 `cce-collector-service/service-module.mjs` — identity, requires, testFile, expectation, waitForIdle, sampledMetrics, dataChecks, evaluate (throughput rule, k6 limit, notes), baselineMetrics

## Phase 4: User Story 2 — find where it breaks (P1)

- [x] T030 `cce-collector-service/tests/collector-breakpoint.test.js` (staircase, `--refine-from` works through the runner)
- [x] T031 Staircase facts and refine note in `evaluate` (`heldUpTo`, `brokeAtRate`, `k6Limited`) in `cce-collector-service/service-module.mjs`

## Phase 5: User Story 3/4 — configurable load, copyable folder (P2/P3)

- [x] T040 [P] `cce-collector-service/README.md` (facts bar, Quick Start, Documentation table with "Depends on")
- [x] T041 [P] `cce-collector-service/docs/test-plan.md` (10 sections of §10.2, defaults from defaults.json)
- [x] T042 [P] `cce-collector-service/docs/test-strategy.md`

## Phase 6: Unit tests

- [x] T050 Generate fixtures in the scratchpad with the real `lib/` builders: `cce-collector-service/unit-tests/fixtures/k6-summary-{load-passed,load-k6-limited,breakpoint-broke,breakpoint-k6-limited}.json`, `settings-overrides.json`, `README.md`
- [x] T051 [P] `cce-collector-service/unit-tests/service-module.spec.mjs` (shape, testFile URLs inside the folder, expectation, sampled metrics, waitForIdle with a fake matcher)
- [x] T052 [P] `cce-collector-service/unit-tests/import-boundary.spec.mjs`
- [x] T053 [P] `cce-collector-service/unit-tests/collector-data-checks.spec.mjs` (SQL binds, comparisons, downstream-backlog-left)
- [x] T054 [P] `cce-collector-service/unit-tests/evaluate.spec.mjs` (passing load, k6-limited load, breakpoint held/broke and k6-limited, baselineMetrics)

## Phase 7: Verification (static only, D14)

- [x] T060 `node --check` on every `.mjs`/`.js` of the folder; `node --test "cce-collector-service/**/*.spec.mjs"`
- [x] T061 `k6 inspect` of the four tests in Docker with `--network none` and a fixture run context (`node tools/core/inspect-k6.mjs --files …`)
- [x] T062 `node tools/cli.mjs run local collector <smoke|load|stress|breakpoint> --dry-run`
- [x] T063 R9 acceptance: `node tools/cli.mjs settings local collector load --set LOAD_EVENTS=1000` → `LOAD_DURATION` 20 s, source `derived`
- [x] T064 ESLint + Prettier on the folder; `node tools/cli.mjs lint-headers --paths cce-collector-service`; generic-name grep (no "ebuzima" identifiers)
- [x] T066 Review round 1: `collector.stored-equals-accepted` with comparison `between` stores `expected` as `[accepted, sent]` (matcher shape); unit test updated; report rendering of the array requested from A2 (plan.md Deviations 5)
- [ ] T065 DEFERRED (owner): first live smoke on the laptop (scripts/run-test.sh local collector smoke), report shown

## Verification record (2026-11-06, static only)

- `node --check`: every `.mjs`/`.js` of the folder — OK.
- `node --test "cce-collector-service/**/*.spec.mjs"`: 55 tests, 55 pass; `npm test` (whole repository): 584 pass.
- `node tools/core/inspect-k6.mjs --files` the four tests (`--network none`, fixture run context): all `ok`;
  breakpoint options: `warm-up` constant 10/s (5 / 50 VUs), `measure` ramping 200 → 6400/s (100 / 2000 VUs),
  per-level thresholds, tags testid / service / test_type / plan_definition_set / environment.
- `run local collector <smoke|load|stress|breakpoint> --dry-run`: exit 0 each; planned 30 / 30,600 / 120,600 / 756,600 events.
- `settings local collector load --set LOAD_EVENTS=1000`: `LOAD_DURATION 20s`, source `derived`, 1,000 measured events.
- `eslint cce-collector-service`, `prettier --check cce-collector-service`, `lint-headers --paths cce-collector-service` (20 files): OK.
- Generic-name check (§2.1, both commands restricted to the folder): no output. All JSON files parse.
