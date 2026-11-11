<!--
  What:    Task list for work package B2 (matcher performance tests).
  How:     Work top to bottom; tick a task ("- [x]") when its file exists and its checks pass. The DEFERRED
           (owner) task needs a live stack and stays open (D14).
  Needs:   spec.md and plan.md in this folder; specs/000-performance-testing-setup/plan.md §6.6, §10.
  Outputs: Progress record of B2.
-->

# Tasks: Matcher performance tests

**Input**: `spec.md`, `plan.md` (this folder) · **Format**: `- [ ] T### [P] Description (file)`

## Phase 1: Setup

- [x] T001 Write spec.md, plan.md, tasks.md (`cce-matcher-service/specs/001-matcher-performance-tests/`)
- [x] T002 [P] Node shim `cce-matcher-service/shared.mjs` (only file importing `../tools/…`, `../lib/…`)
- [x] T003 [P] k6 shim `cce-matcher-service/tests/shared-lib.js` (only file importing `../../lib/…`)

## Phase 2: Foundational

- [x] T004 Backlog watcher `cce-matcher-service/watchers/backlog-watcher.mjs` (plan §6.5/§6.6: sampling from its own start, ready/re-basing, done rules, stall/restart abort, DLQ delta, drain rate, thresholds, started-breaking)
- [x] T005 Data checks `cce-matcher-service/data-checks/matcher-data-checks.mjs` (plan §6.8; candidate ids with the 1 % + 10 edge margin via `candidatePhasePlan`)
- [x] T006 Service module `cce-matcher-service/service-module.mjs` (metadata, expectation, idle, watchers, sampled metrics, evaluate, baselineMetrics)

## Phase 3: User Stories 1–3 - k6 tests (P1)

- [x] T007 Shared scenario `cce-matcher-service/tests/matcher-scenario.js`
- [x] T008 [P] Thin tests `cce-matcher-service/tests/matcher-{smoke,load,stress,breakpoint}.test.js`

## Phase 4: User Stories 4–5 - unit tests (P2)

- [x] T009 Fakes and fixtures `cce-matcher-service/unit-tests/fakes.mjs`, `unit-tests/fixtures/` (README + `k6-summary-matcher-load.json`)
- [x] T010 [P] `cce-matcher-service/unit-tests/backlog-watcher.spec.mjs` (catches up; v1 stress case not caught up; late ready; stall; restart; missing metrics; early send end; flood drain rate)
- [x] T011 [P] `cce-matcher-service/unit-tests/data-checks.spec.mjs` (single; overlapping-4; extra ACTIVE definition effectiveFanOut 5; draining; DLQ; k6 sends plannedEvents + 1: the extra id is a candidate and logged = sent passes)
- [x] T012 [P] `cce-matcher-service/unit-tests/service-module.spec.mjs` (shape, expectation, idle wait, evaluate, baselineMetrics, flood VUs 100/500, naming) and `unit-tests/import-boundary.spec.mjs`

## Phase 5: Polish (documentation)

- [x] T013 [P] `cce-matcher-service/README.md` (facts bar, Quick Start, Documentation table, Depends on)
- [x] T014 [P] `cce-matcher-service/docs/test-plan.md` (10 sections of plan §10.2)
- [x] T015 [P] `cce-matcher-service/docs/test-strategy.md`

## Phase 6: Verification (static only, D14)

- [x] T016 `node --check` on every `.mjs`/`.js` in the folder
- [x] T017 `npm test` (whole suite) and ESLint + Prettier on the folder (`prettier --write cce-matcher-service` applied once)
- [x] T018 `k6 inspect` of the four tests with `--network none` (flood shows 100 / 500 VUs)
- [x] T019 `node tools/cli.mjs run local matcher {smoke,load,stress,breakpoint} --dry-run`
- [x] T020 `node tools/cli.mjs lint-headers --paths cce-matcher-service` and the generic-name check
- [ ] T021 DEFERRED (owner): first live smoke on the laptop, report shown (`scripts/check-services.sh local --subject matcher`, `scripts/run-test.sh local matcher smoke`; confirm the expected-rows rule and the processed counter, then flip `matcher.steps-created` to required)
