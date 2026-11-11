<!--
  What:    Task list of work package A2 (Node tooling core), ticked as each task is done.
  How:     Work top to bottom; "[P]" tasks of one phase touch different files and can run in parallel.
  Needs:   spec.md and plan.md (same folder); specs/000-performance-testing-setup/plan.md.
  Outputs: Progress record of A2; unticked "DEFERRED (owner)" tasks need a live stack (D14).
-->

# Tasks: Node tooling core

**Input**: `spec.md`, `plan.md` (this folder) · **Contract**: `specs/000-performance-testing-setup/plan.md`
**Format**: `- [ ] T### [P] Description with exact file path`

## Phase 1: Setup

- [x] T001 Write `specs/002-node-tooling-core/spec.md`, `plan.md`, `tasks.md`
- [x] T002 [P] Root config: `package.json` (§6.10), `.npmrc`, `.editorconfig`, `.gitignore` (drop `step-sla/last-seed.json`)
- [x] T003 [P] Lint/format config: `prettier.config.mjs`, `.prettierignore` (+ verbatim FHIR fixtures, deviation 14), `eslint.config.mjs`
- [x] T004 Run `npm install` (exact versions) → `package-lock.json`, `node_modules/`
- [x] T005 [P] `config/environments/environment.schema.json`, `local.json`, `dev.example.json`, `uat.example.json`
- [x] T006 [P] `config/settings/defaults.json` (every §3.2 setting) and `config/settings/settings.schema.json`
- [x] T007 [P] `config/README.md`

## Phase 2: Foundational (core modules)

- [x] T010 [P] `tools/core/paths.mjs`, `tools/core/errors.mjs`, `tools/core/command-args.mjs`, `tools/core/json-file.mjs`, `tools/core/format.mjs`, `tools/core/logger.mjs`
- [x] T011 [P] `tools/core/lib-bridge.mjs` (A1 pure modules)
- [x] T012 `tools/core/environment.mjs` (prod refusal, local overrides, `serviceConfig`)
- [x] T013 `tools/core/run-id.mjs` (run ids, selectors, UUIDv7 floor and SQL)
- [x] T014 `tools/core/settings.mjs` (precedence, value types, derivation, RUN_ID checks, print, save)
- [x] T015 [P] `tools/core/results.mjs`
- [x] T016 [P] `tools/core/clients/http-json.mjs`, `clients/prometheus-text.mjs`, `clients/postgres.mjs`, `clients/kafka-admin.mjs`, `clients/grafana.mjs`
- [x] T017 [P] `tools/core/service-registry.mjs` and stub module `tools/core/unit-tests/fixtures/stub-service/service-module.mjs` (+ `tests/stub-load.test.js`)
- [x] T018 [P] `tools/core/result-schema.mjs` and `tools/results/result.schema.json`
- [x] T019 [P] `tools/core/run-setup.mjs` (settings + dataset + set, `buildRunContext`) and `tools/core/run-clients.mjs` (live clients of a real run)

## Phase 3: User Story 1/2 - settings and run (P1)

- [x] T020 `tools/core/k6-runner.mjs` (docker args, run, stop, free port)
- [x] T021 `tools/core/k6-clock.mjs` (REST API clock, estimated fallback)
- [x] T022 [P] `tools/core/k6-summary.mjs`
- [x] T023 [P] `tools/core/sampled-metrics.mjs`, `tools/core/metrics-sampler.mjs`
- [x] T024 [P] `tools/core/watchers.mjs`, `tools/core/idle.mjs`
- [x] T025 [P] `tools/core/run-sql.mjs`, `tools/core/conditions.mjs`
- [x] T026 `tools/core/breaking-analysis.mjs`, `tools/core/staircase.mjs`
- [x] T027 `tools/core/result-builder.mjs` (incl. staircase capacity verdict, deviation 12; every conditions field present)
- [x] T028 `tools/cli.mjs` (dispatcher, lists A3 commands, clear message when a command file is absent)
- [x] T029 `tools/commands/settings.mjs`
- [x] T030 `tools/commands/run-test.mjs` (lifecycle §6.2, dry-run, Ctrl-C, refine-from, Grafana annotations)
- [x] T031 `tools/commands/check-data.mjs`

## Phase 4: User Story 3/4 - reports and baselines (P1/P2)

- [x] T040 `tools/report/run-report.mjs`
- [x] T041 `tools/report/series-report.mjs`
- [x] T042 `tools/commands/report.mjs`
- [x] T043 `tools/baseline/baseline-store.mjs`, `tools/baseline/baseline-compare.mjs`, `tools/baseline/baseline-metrics.mjs`, `baselines/README.md`
- [x] T044 `tools/commands/baseline.mjs`

## Phase 5: Polish

- [x] T050 [P] `tools/core/header-check.mjs`, `tools/commands/lint-headers.mjs`
- [x] T051 [P] `tools/core/inspect-k6.mjs`, `tools/core/run-shellcheck.mjs`
- [x] T052 [P] `scripts/run-test.sh`, `scripts/print-settings.sh`, `scripts/build-report.sh`, `scripts/manage-baselines.sh`
- [x] T053 [P] `tools/README.md` (module map, CLI reference, k6 clock contract, plugging in a service module)
- [x] T054 Unit tests `tools/core/unit-tests/*.spec.mjs` (+ `helpers.mjs`): settings precedence, R9 (LOAD_EVENTS=1000 → 20 s derived), MATCHER_FLOOD_EVENTS, value types, `$comment` never a setting, prod refusal, RUN_ID rules, runSelectors, uuidV7Floor, docker args (--address/--name/tags), k6 clock (running / unreachable → estimated), summary normalisation, thresholdsFromK6 without dummy rules, windows/levels/backlog incl. the k6-limit load case (11 of 30,020 at p95 20 ms) and the v1 give-up case, diagnosticsNear, fine levels 400/800 → 500,600,700, computePeaks firstAt, result validation, seeded PrepareResult, header check (git-ignored exclusion), withDedicatedClient release, Grafana auth choice
- [x] T055 Unit tests `tools/report/unit-tests/*.spec.mjs`, `tools/baseline/unit-tests/*.spec.mjs` (+ fixtures: §5.2 matcher stress example and generated breakpoint results)
- [x] T056 Unit tests `tools/commands/unit-tests/{run-test,settings,report,baseline,check-data,lint-headers}.spec.mjs` (+ `fixtures/{run-test,check-data,lint-headers}/`), incl. `run --dry-run` and a full faked run with the stub module
- [x] T057 Test reading A1's `lib/unit-tests/fixtures/k6-summary-sample.json` (present: runs, not pending)

## Phase 6: Verification (static only, D14)

- [x] T060 `node --check` on every A2 `.mjs`; `bash -n` on the four scripts; JSON parse of every A2 `.json`
- [x] T061 `npm test` passes (464 tests, all packages)
- [x] T062 ESLint + Prettier + `lint-headers --paths` on A2's files (and `npm run lint` on the whole tree passes); ShellCheck: not installed and image not present → wrapper reports SKIPPED (deviation 9)
- [x] T063 `node tools/cli.mjs settings local stub load --set LOAD_EVENTS=1000 --modules-root tools/core/unit-tests/fixtures` shows LOAD_DURATION 20s derived
- [x] T064 `node tools/cli.mjs settings local` prints values only
- [x] T065 `node tools/cli.mjs run local stub load --dry-run --modules-root tools/core/unit-tests/fixtures` exits 0
- [x] T067 `k6 inspect` of the stub script through `tools/core/inspect-k6.mjs` (Docker, `--network none`) passes
- [ ] T066 DEFERRED (owner): first live run through `scripts/run-test.sh local collector smoke` (needs a stack, B1)
