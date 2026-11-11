<!--
  What:    Task list of work package B3 (Step SLA performance tests), ticked as each task is done.
  How:     Work top to bottom; "[P]" tasks of one phase touch different files and can run in parallel.
  Needs:   spec.md and plan.md (same folder); specs/000-performance-testing-setup/plan.md.
  Outputs: Progress record of B3; the unticked "DEFERRED (owner)" task needs a live stack (D14).
-->

# Tasks: Step SLA performance tests

**Input**: `spec.md`, `plan.md` (this folder) · **Contract**: `specs/000-performance-testing-setup/plan.md`
**Format**: `- [ ] T### [P] Description with exact file path`

## Phase 1: Setup

- [x] T001 Write `cce-step-sla-service/specs/001-step-sla-performance-tests/spec.md`, `plan.md`, `tasks.md`
- [x] T002 `cce-step-sla-service/shared.mjs` (the only file importing `../tools/core/…`)
- [x] T003 [P] `cce-step-sla-service/unit-tests/helpers.mjs` (fake pg client/pool, fake scrape, fake clock, ctx)

## Phase 2: Foundational

- [x] T004 `cce-step-sla-service/tests/step-sla-test-definition.mjs` (`defineStepSlaTest`, describe from the phase plan)
- [x] T005 [P] `cce-step-sla-service/tests/step-sla-{smoke,load,stress,breakpoint}.test.mjs`

## Phase 3: User Story 1 - steady alarm rate (P1)

- [x] T006 `cce-step-sla-service/seeding/seed-alarms.mjs` (`buildSeedPairs`, `buildSeedStatements`, `seedAlarms`, seed.json)
- [x] T007 `cce-step-sla-service/watchers/alarm-watcher.mjs` (samples, done/give-up, aborts, cap hits, drain rate;
      stall clock runs only while > 10 alarms are due — plan.md deviation 12)
- [x] T008 `cce-step-sla-service/data-checks/step-sla-data-checks.mjs` (SQL with selector + UUIDv7 floor, judge, started breaking)
- [x] T009 `cce-step-sla-service/service-module.mjs` (expectation, idle, prepare, watchers, sampled metrics, evaluate, baselineMetrics)

## Phase 4: User Story 2 - storm (P1) and User Story 3 - plan-definition set (P2)

- [x] T010 Storm specifics: rate 0, drain rate for breakpoint only, storm catch-up check, `rateAtBreak: null` (files of T006–T009)
- [x] T011 Seed mode `set` over (plan definition × mandatory step) pairs and `single-action` refusal (file of T006)
- [x] T026 Warn about per-run overrides Step SLA ignores (`WARM_UP_*`, `DATASET`, `EVENT_ACTION_ID`, `EVENT_SOURCE`,
      `FACILITY_ID`): `SETTINGS_NOT_USED` + `unusedSettingWarnings()` in `prepare()` → console and result.json
      `warnings`; docs/test-plan.md §3; unit test in service-module.spec.mjs (review round 2). The shared printout
      and banner still list them: restricting `WARM_UP_*` appliesTo in config/settings/defaults.json and the
      banner's `dataset:` line for seeded subjects are shared-tooling changes outside this folder.
- [x] T025 Seed the history rows the matcher writes with each enrolment and step (`protocol_instance_history`
      `ACTIVE`, `step_instance_history` `NOT_STARTED`); document the deliberate MISSED-row difference (files of
      T006, T013, T019, T020; review round 1)

## Phase 5: Unit tests

- [x] T012 [P] `cce-step-sla-service/unit-tests/test-definitions.spec.mjs`
- [x] T013 [P] `cce-step-sla-service/unit-tests/seed-alarms.spec.mjs`
- [x] T014 [P] `cce-step-sla-service/unit-tests/alarm-watcher.spec.mjs`
- [x] T015 [P] `cce-step-sla-service/unit-tests/data-checks.spec.mjs`
- [x] T016 [P] `cce-step-sla-service/unit-tests/service-module.spec.mjs`
- [x] T017 [P] `cce-step-sla-service/unit-tests/import-boundary.spec.mjs`

## Phase 6: Polish (documentation)

- [x] T018 [P] `cce-step-sla-service/README.md` (facts bar, Quick Start, Documentation incl. "Depends on")
- [x] T019 [P] `cce-step-sla-service/docs/test-plan.md` (10 sections of plan §10.2)
- [x] T020 [P] `cce-step-sla-service/docs/test-strategy.md`

## Phase 7: Verification (static only, D14)

- [x] T021 `node --check` on every `.mjs` of the folder; `npm test`
- [x] T022 ESLint and Prettier on `cce-step-sla-service/`; `node tools/cli.mjs lint-headers --paths cce-step-sla-service`
- [x] T023 `node tools/cli.mjs run local step-sla <smoke|load|stress|breakpoint> --dry-run` (no connection)
- [ ] T024 DEFERRED (owner): first live smoke on the laptop, report shown (`scripts/run-test.sh local step-sla smoke`
      after `scripts/manage-plan-definitions.sh load local --set single`; then cleanup by run id)
