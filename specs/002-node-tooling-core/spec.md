<!--
  What:    Feature specification of work package A2: the Node.js tooling core of the CCE performance tests
           (configuration, settings, k6 runner and clock, run lifecycle, results, reports, baselines, lint).
  How:     Read before plan.md and tasks.md (same folder). The contract it implements is
           specs/000-performance-testing-setup/plan.md (sections cited as §N).
  Needs:   specs/000-performance-testing-setup/{spec,plan}.md.
  Outputs: Goal, scope, inputs, outputs and acceptance criteria that A2's code is checked against.
-->

# Feature Specification: Node tooling core

**Feature Branch**: n/a (folder only; suggested branch feature/node-tooling-core)
**Created**: 2026-11-06
**Status**: Implemented (static verification only, D14)
**Input**: Work package A2 of `specs/000-performance-testing-setup/tasks.md` (T011); plan §0–§6, §8, §12, §13.

## Goal

Give every performance test one Node.js 22 command line (`node tools/cli.mjs …`) that resolves the settings
from a single source of truth, runs k6 in Docker with a reliable clock, builds a `result.json` for every
run, renders a concise report from that JSON only, compares runs with saved baselines and keeps the
repository consistent (lint, format, header comments). Service folders (wave B) plug into it through the
service-module interface; preflight, cleanup and plan-definition tooling (A3) plug into its CLI.

## Scope

### In scope
- Root project files: `package.json`, `package-lock.json`, `.npmrc`, `.editorconfig`, `.gitignore`,
  `prettier.config.mjs`, `.prettierignore`, `eslint.config.mjs`.
- `config/`: environment files (`local.json`, `dev.example.json`, `uat.example.json`) with their JSON Schema,
  `settings/defaults.json` (every setting of plan §3.2) with its JSON Schema, README.
- `tools/core/` (every module of plan §6.3 plus small helpers), `tools/core/clients/`, the stub service
  module for wave-A tests.
- `tools/cli.mjs` and the commands `run`, `settings`, `report`, `baseline`, `check-data`, `lint-headers`.
- `tools/report/` (run report, series report), `tools/baseline/` (store, compare), `baselines/README.md`,
  `tools/results/result.schema.json`, `tools/README.md`.
- `scripts/{run-test,print-settings,build-report,manage-baselines}.sh`.
- Unit tests (`node --test`) with fixtures and mocks for all of the above.

### Out of scope
- Shared k6 library, Docker image, test data (A1); preflight checks, cleanup, plan-definition sets (A3);
  monitoring stack and dashboards (A4); service modules, k6 tests, watchers, data checks (B1–B3); docs (C1).
- Any live run: no connection to Postgres, Kafka, a CCE service, Prometheus or Grafana during the build (D14).

## Inputs

- Settings: every name of plan §3.2 (defaults → environment `settings` → environment variables → `--set`).
- Secrets from environment variables only: `DB_PASSWORD` (named by `database.passwordEnvVar`),
  `GRAFANA_API_TOKEN`, `GRAFANA_ADMIN_PASSWORD`.
- A1 pure modules: `lib/duration.js` (`parseDuration`, `formatDuration`), `lib/phase-plan.js`
  (`buildPhasePlan`), `lib/thresholds.js` (`isDummyRule`, `describeThreshold`, `allowedDropped`); A1 fixture
  `lib/unit-tests/fixtures/k6-summary-sample.json`; datasets `test-data/datasets/<name>/dataset.json`.
- A3 modules, imported lazily (tolerated when absent): `tools/preflight/preflight.mjs` (`runPreflight`),
  `tools/plan-definitions/sets.mjs` (`loadPlanDefinitionSet`), `tools/plan-definitions/expected-rows.mjs`
  (`computeExpectedRows`), `tools/plan-definitions/active.mjs` (`getActivePlanDefinitions`).
- Service modules `<root>/*/service-module.mjs` (plan §6.4), discovered by `tools/core/service-registry.mjs`.
- k6 output: `k6-summary.json` written by `lib/summary.js`, the k6 REST API `GET /v1/status` while k6 runs.

## Outputs

- CLI `node tools/cli.mjs <command>` (plan §6.1) and the four shell entry points.
- Per run (plan §5.1): `run-context.json` (§3.5), `k6.log`, `service-metrics.json`, `data-checks.json`,
  `result.json` (§5.2, validated by `validateResult`), `report.md` (§8.1), `baseline-comparison.json` (§8.3).
- Series: `summary.json` + `summary.md` (§8.2). Baselines: `baselines/<name>.json` (§8.3).
- Exit codes (§5.7): 0 passed/done, 1 failed, 2 refused (`RefusedError`), 3 tool error.

## Acceptance criteria

1. `npm test` passes; `npm run lint` passes on A2's files (ESLint, Prettier, header check, ShellCheck when
   available).
2. `node tools/cli.mjs settings local stub load --set LOAD_EVENTS=1000 --modules-root tools/core/unit-tests/fixtures`
   prints `LOAD_DURATION` 20s with source `derived` (spec R9 with the stub module).
3. `node tools/cli.mjs settings local` prints values and sources only (no phase plan) without a subject.
4. `node tools/cli.mjs run local stub load --dry-run --modules-root tools/core/unit-tests/fixtures` prints
   the settings, the phase plan and the masked docker command and exits 0 without opening a connection.
5. `config/settings/defaults.json` has every setting of plan §3.2 with default, type, unit, appliesTo,
   description and toBeConfirmed; JSON loaders never see `$comment` as a setting.
6. Every environment named or marked prod is refused with exit code 2.
7. Reports and baselines read only JSON (`result.json`, `baselines/*.json`); no Markdown, text or TSV parsing.
8. Every file written by A2 carries the header of plan §2.4 (`node tools/cli.mjs lint-headers --paths …`).
9. A staircase breakpoint that climbs until a level breaks is judged on its capacity (`breakpoint.held-up-to`,
   held ≥ the expected rate), not marked "aborted" by its own per-level abort rules (plan.md deviation 12).
10. Unit tests cover the cases listed in `tasks.md` T054–T057 with fakes only (no Docker, Postgres, Kafka,
    HTTP or Grafana connection).

## User Scenarios & Testing

### User Story 1 - Print the settings of a run (Priority: P1)
**Given** the local environment, **when** the tester runs `scripts/print-settings.sh local stub load --set
LOAD_EVENTS=1000`, **then** a table shows each relevant setting with value, source and "to be confirmed"
flag, `LOAD_DURATION` is 20s (derived), and the phase plan lists warm-up and measure.

### User Story 2 - Dry-run a test (Priority: P1)
**Given** a service module, **when** `run … --dry-run` is used, **then** the run ID, the results folder it
would use, settings, phase plan and docker command (secrets masked) are printed, nothing is written (no results
folder, no `run-context.json`), no port is opened and nothing connects.

### User Story 3 - Read a concise report (Priority: P1)
**Given** a `result.json`, **when** `report <dir>` runs, **then** `report.md` shows expectation vs result,
thresholds, when it started breaking and what broke, data checks, dropped iterations and conditions.

### User Story 4 - Series report and baselines (Priority: P2)
**Given** several result folders, **when** `report --series` runs, **then** `summary.json`/`summary.md`
give per-service load/stress/breaking points and the whole-flow weakest link; **when** `baseline save` and
`baseline compare` run, **then** metrics are marked better/worse/same with condition warnings.

### Edge Cases
- `RUN_ID` with a hyphen or longer than 20 characters → refused; an event id longer than 50 characters → refused.
- Both `LOAD_EVENTS` and `LOAD_DURATION` given → events win, a warning is printed.
- `EVENT_MODE=journey` or a non-empty `WORKLOAD_PROFILE` → refused "not implemented yet".
- k6 REST API never reachable → times estimated from the container start, flagged in the result.
- A watcher gives up with a backlog → `caughtUp: false`, `remainingBacklog`, never a catch-up time.
- k6 dropped iterations at low latency → "at least X/s (k6 limit)".
- A3 modules not present yet → conditions and dry-run continue with a warning.
- A staircase reaches the top level without breaking → "never broke (raise LEVELS)"; held no level → "held no level".
- `check-data` on a run of another environment, or on a folder without `run-context.json` → refused.

## Requirements

- **FR-001**: The settings resolver MUST apply defaults → environment → env vars → `--set`, pin value types
  (plan §3.3) and derive `*_DURATION` from `*_EVENTS` only there.
- **FR-002**: Every command MUST refuse prod environments (exit 2).
- **FR-003**: The runner MUST build the docker command of plan §6.3/§9.3 and learn the k6 start from the k6
  REST API, re-basing on `k6-summary.json` afterwards.
- **FR-004**: The result builder MUST produce `result.json` v1.0.0 exactly per plan §5.2 with `null` for
  non-applicable fields and the status rules of §5.2.
- **FR-005**: Breaking analysis MUST cover windows, staircase levels, backlog series, the k6 limit (D9) and
  diagnostics near the break (plan §6.9).
- **FR-006**: Reports, series reports and baselines MUST be built from JSON only (plan §8).
- **FR-007**: Every file MUST carry the header comment of plan §2.4; `lint-headers` MUST check the exact scope.
- **FR-008**: Clients MUST be injectable so unit tests never connect to a live system.

## Success Criteria

- **SC-001**: All A2 unit tests pass with fixtures and mocks only.
- **SC-002**: The R9 example (`LOAD_EVENTS=1000` → `LOAD_DURATION` 20 s derived) holds with the stub module.
- **SC-003**: Zero lines of report/baseline code parse Markdown, text or TSV.
- **SC-004**: No secret value appears in any file written by A2.
