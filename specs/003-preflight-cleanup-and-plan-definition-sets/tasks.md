<!--
  What:    Task list for work package A3 (preflight, verified cleanup, plan-definition sets).
  How:     Work top to bottom; tick a task ("- [x]") when its file exists and its checks pass.
  Needs:   spec.md and plan.md in this folder; specs/000-performance-testing-setup/plan.md §7.
  Outputs: Progress record of A3.
-->

# Tasks: Preflight checks, verified cleanup and plan-definition sets

**Input**: `spec.md`, `plan.md` (this folder) · **Format**: `- [ ] T### [P] Description (file)`

## Phase 1: Setup

- [x] T001 Write spec.md, plan.md, tasks.md (`specs/003-preflight-cleanup-and-plan-definition-sets/`)
- [x] T002 [P] Copy archive/v1/protocol/variants/{strict,light,lab-focus}.json verbatim into `tools/plan-definitions/unit-tests/fixtures/v1-variants/` with `fixtures/README.md` (byte-identical, checked with `cmp`)

## Phase 2: Foundational (plan-definition helpers)

- [x] T003 [P] `tools/plan-definitions/triggers.mjs` (flatten steps, trigger_index rows, event code triples, match tuples, mandatory steps)
- [x] T004 [P] `tools/plan-definitions/variants.mjs` applyOverrides per plan §7.3
- [x] T005 [P] `tools/plan-definitions/validate.mjs` offline protocol-service rules + validateSet
- [x] T006 [P] `tools/plan-definitions/expected-rows.mjs` computeExpectedRows incl. dueAlarms
- [x] T007 `tools/plan-definitions/sets.mjs` loadPlanDefinitionSet (version suffix, $comment stripped), write safety, marker
- [x] T008 [P] `tools/plan-definitions/protocol-api.mjs`, `active.mjs`, `ledger.mjs`

## Phase 3: User Story 1 - preflight (P1)

- [x] T009 `tools/preflight/probes.mjs` (slots, disk, min-free-disk rule) and `check-helpers.mjs`
- [x] T010 Check modules `tools/preflight/checks/*.mjs` (all 17 ids of plan §7.1) + `checks/index.mjs`
- [x] T011 `tools/preflight/clients.mjs` (client bundle: given keys used as is, missing ones built and closed)
- [x] T012 `tools/preflight/preflight.mjs` runPreflight, status, printed table
- [x] T013 `tools/results/preflight.schema.json`

## Phase 4: User Story 2 - cleanup (P1)

- [x] T014 `tools/cleanup/cleanup-tables.mjs` (13 tables, stage/count/batch/verify/restage/activity SQL, legacy branch)
- [x] T015 `tools/cleanup/cleanup-guards.mjs`
- [x] T016 `tools/cleanup/cleanup.mjs` runCleanup (one client, batches, temp index dropped in finally, verification after stops too, settings in JSON), printCleanupSql
- [x] T017 `tools/results/cleanup.schema.json` (incl. `settings`, `savedTo`)

## Phase 5: Commands and scripts (P1/P2)

- [x] T018 `tools/commands/preflight.mjs`
- [x] T019 `tools/commands/cleanup.mjs` (print-sql / dry-run / delete, settings printed, typed yes)
- [x] T020 `tools/commands/plan-definitions.mjs` (validate, generate, status, load, retire, delete, list-active)
- [x] T021 [P] `scripts/check-services.sh`, `scripts/cleanup-test-data.sh`, `scripts/manage-plan-definitions.sh` (≤ 30 lines)

## Phase 6: Tests

- [x] T022 [P] `tools/plan-definitions/unit-tests/{variants,validate,sets,expected-rows,protocol-api,triggers}.spec.mjs` (v1 variant equality from A1's overrides, validation negatives incl. tolerance-days on a could step, set loading, expected rows, write safety, marker)
- [x] T023 [P] `tools/preflight/unit-tests/{checks,preflight}.spec.mjs` + `fake-clients.mjs` (every check id pass/fail, warn where it exists; overlap fail matcher / warn collector; disk.data-stores local vs dev; health once)
- [x] T024 [P] `tools/cleanup/unit-tests/{cleanup-tables,cleanup-guards,cleanup}.spec.mjs` + `fake-pg.mjs` (guards incl. run-id prefix and dev/uat scoped idle, one client in order, BEGIN/SET LOCAL/COMMIT, slot lost → incomplete, verified, orphan round, invalid index dropped first, index dropped in finally, legacy branch, print-sql covers 13 tables)
- [x] T025 `tools/commands/unit-tests/{preflight,cleanup,plan-definitions}.spec.mjs` + `fixtures/{cleanup,plan-definitions}/`

## Phase 7: Polish and verification (static only)

- [x] T026 Prettier (A2 config) on every A3 file except the verbatim v1 variants; ESLint clean; generic-name grep clean
- [x] T027 `node --check` on every A3 `.mjs`; `bash -n` on the three scripts; JSON parse of schemas and fixtures; header labels (What/How/Needs/Outputs) on every A3 file outside fixtures
- [x] T028 `npm test` (330 tests, 214 of them A3) passes
- [x] T029 `node tools/cli.mjs cleanup local --run-id 20261105-142233 --print-sql`, `… --run-id 1103172520 --print-sql` (legacy branch shown), `node tools/cli.mjs plan-definitions validate --set overlapping-4` — all exit 0, offline
- [ ] T030 DEFERRED (owner): first live `preflight local`, `cleanup local --run-id <id> --dry-run`, `plan-definitions status local --set single` against the laptop stack; confirm the expected-rows rule at the first smoke (plan §7.3)
