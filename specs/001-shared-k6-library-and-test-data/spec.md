<!--
  What:    Feature specification of work package A1: the shared k6 library (lib/), the k6 Docker image
           source (docker/k6/, scripts/build-k6-image.sh) and the test data (datasets, plan-definition
           fixtures, plan-definition sets).
  How:     Read it before plan.md and tasks.md in this folder. The contract it implements is
           specs/000-performance-testing-setup/plan.md (cited as §N).
  Needs:   specs/000-performance-testing-setup/{spec,plan}.md; archive/v1/ (logic and fixtures to port).
  Outputs: Goal, scope, inputs, outputs and acceptance criteria that A1's files are checked against.
-->

# Feature Specification: Shared k6 library, k6 Docker image and test data

**Feature Branch**: n/a (folder only; suggested branch feature/shared-k6-library-and-test-data)
**Created**: 2026-11-06
**Status**: Implemented; static verification passed 2026-11-06 (D14)
**Input**: Work package A1 of `specs/000-performance-testing-setup/tasks.md` (T010); team lead's points
R2, R3, R9, R11, R13; owner decisions D4, D8, D9, D11, D12, D14.

## Goal

Give every service test one shared, well-commented k6 library so that a collector, matcher or later
adaptor test is a thin file: the run context (settings resolved by Node), the phase plan (warm-up,
measure, staircase), scenarios with an open load model, thresholds including the dropped-iterations rule,
report-window tags, generic CloudEvent/FHIR builders with `LOADTEST-<runId>-…` ids and a JSON summary
writer. Ship the k6 image source and generic test data (eBUZIMA only as the first dataset) with
selectable plan-definition sets.

## Scope

### In scope
- `lib/` PURE modules (importable by Node and k6): `duration.js`, `phase-plan.js`, `thresholds.js`,
  `scenarios.js`, `windows.js`, `test-data.js` (§4.1–§4.6).
- `lib/` K6 modules: `run-context.js`, `tagging.js`, `http-client.js`, `kafka-client.js`,
  `event-metrics.js`, `summary.js` (§4.7); `lib/README.md` (module list, clock contract, summary shape).
- `lib/unit-tests/*.spec.mjs` (node --test) and `lib/unit-tests/fixtures/k6-summary-{sample,breakpoint,kafka}.json`
  (§5.3): one captured from a real `k6 run` of a probe with `--network none`, two synthetic.
- `docker/k6/Dockerfile` (copied from `archive/v1/docker/Dockerfile`), `docker/k6/README.md`,
  `scripts/build-k6-image.sh`.
- `test-data/README.md`; dataset `test-data/datasets/ebuzima-emr/dataset.json`; plan-definition fixture
  `test-data/plan-definitions/emr-service-protocol.json` (verbatim) and overrides
  `test-data/plan-definitions/variants/{strict,light,lab-focus}.overrides.json` (derived by a scripted
  diff); sets `test-data/plan-definition-sets/{single,overlapping-2,overlapping-4}/set.json` (§7.3).

### Out of scope
- Resolving settings, deriving `*_EVENTS`, writing `run-context.json`, running k6 (A2).
- Applying overrides, validating plan definitions, loading them into the protocol service (A3).
- Service test files (`<service>/tests/*.test.js`, B1/B2) and the Step SLA seeding (B3).
- Building the Docker image (the image exists; only `bash -n` on the build script).
- `EVENT_MODE=journey` and `WORKLOAD_PROFILE` (reserved, later work, §3.2); adaptor modules.

## Inputs

- `ResolvedSettings.values` (§3.3): durations as numbers of seconds, `LEVELS` as `number[]`, unset = `null`,
  `*_EVENTS` already turned into durations by `tools/core/settings.mjs` (A2).
- `run-context.json` (§3.5), path in env var `RUN_CONTEXT` (absolute, inside the container).
- `archive/v1/lib/{ebuzima,breakpoint,options,settings,smoke,load,stress}.js`, `archive/v1/matcher/matcher.js`,
  `archive/v1/collector/collector.js`, `archive/v1/docker/Dockerfile`,
  `archive/v1/protocol/emr-service-protocol.json`, `archive/v1/protocol/variants/*.json` (read only).
- Docker image `cce-load-tests/k6:2.3.0-kafka2.2.0` (k6 2.3.0 + xk6-kafka 2.2.0).

## Outputs

- The modules and exports of §4 (signatures in plan.md "Interfaces" of this folder).
- k6 options: scenarios `smoke` / `warm-up` / `measure` (arrival-rate executors), thresholds, tags
  `testid`, `service`, `test_type`, `plan_definition_set`, `environment`; VU tags `phase`, `level`, `window`.
- Custom k6 counters `events_sent`, `events_accepted`.
- `<resultsDirInContainer>/k6-summary.json`: raw handleSummary data + `context` block
  `{runId, subject, testType, phasePlan, k6StartedAt, testRunDurationMs}`; short stdout text.
- Test data files and the k6 summary fixtures listed under "In scope".

## Acceptance criteria

1. `node --check` passes on every `lib/*.js` and `lib/unit-tests/*.spec.mjs`; `node --test lib/unit-tests/`
   passes.
2. PURE modules import nothing from `k6*` and never call `open()` (checked by a unit test that reads the sources).
3. Unit tests cover: phase plans for smoke/load/stress/breakpoint (staircase, flood, none) incl. Step SLA rows
   and warm-up 0; staircase stages; VU numbers (staircase 200..6400 → 100/2000; Kafka flood 2000/s → 100/500;
   Kafka smoke 1/s → 2/4); thresholds incl. `allowedDropped(30000, 0.001) = 30` and `isDummyRule`; the 50-char
   id guard; template filling without `$comment`; CloudEvent shape.
4. `lib/unit-tests/fixtures/k6-summary-sample.json` is the handleSummary output of a real `k6 run` (network none)
   and contains `setup_data.k6StartedAtMs` and `state.testRunDurationMs`; the synthetic fixtures contain
   `{level:…}` / `{window:…}` keys and the same `context` block.
5. `k6 inspect` (network none) of a RUN_CONTEXT-based probe importing every `lib/` module succeeds.
6. Every JSON file parses; our JSON files start with a `"$comment"` holding What/How/Needs/Outputs.
7. The three overrides files, applied with the §7.3 rule, reproduce `archive/v1/protocol/variants/*.json`
   deep-equal after sorting object keys (self-check recorded in plan.md).
8. `bash -n scripts/build-k6-image.sh` passes; the script is ≤ 30 lines.
9. The two generic-name commands of §2.1, restricted to A1's paths, print nothing.

## User Scenarios & Testing

### User Story 1 - Write a service test in a few lines (Priority: P1)
**Given** the shared library and a run context, **when** a B-package author writes
`collector-load.test.js`, **then** it only exports `options = buildOptions({context, kind:'http'})`,
`setup = markK6Start`, a default function (tagIteration → build event → post → check → recordSend) and
`handleSummary = (data) => writeSummary(data, context)`.
**Independent test**: the probe in the scratchpad does exactly this and passes `k6 inspect`.

### User Story 2 - Node and k6 agree on the schedule (Priority: P1)
**Given** resolved settings, **when** Node prints the phase plan and k6 builds its scenarios, **then** both
come from `buildPhasePlan` (same file), so planned events, start times and windows match.
**Independent test**: unit tests on `phase-plan.js` and `scenarios.js`.

### User Story 3 - Choose test data and plan definitions without code changes (Priority: P1)
**Given** `DATASET=ebuzima-emr` and `PLAN_DEFINITION_SET=overlapping-4`, **when** a test runs, **then** the
events come from the dataset templates and the four plan definitions are described by the set file.
**Independent test**: unit tests load every set and dataset file and check references and mandatory steps.

### User Story 4 - Read the k6 result as JSON (Priority: P2)
**Given** a finished k6 run, **when** handleSummary runs, **then** `k6-summary.json` holds the raw metrics
plus the context block A2 needs to re-base time.
**Independent test**: the captured fixture.

### Edge Cases
- `WARM_UP_DURATION = 0`: no warm-up phase, scenario or warm-up abort rule.
- A duration given as a string (`'10m'`) to a pure module: error "must be a number of seconds" (Node resolves it).
- Event id longer than 50 characters (long `RUN_ID`): `buildEventId` throws.
- Template with an unknown placeholder or a `$comment`: placeholder → error; `$comment` dropped.
- `RUN_CONTEXT` missing or relative: k6 init fails with "RUN_CONTEXT missing: run tests through scripts/run-test.sh".
- Step SLA storm: rate 0, duration 0 phase; no k6 scenarios can be built from it (error).

## Requirements

- **FR-001**: Pure modules MUST NOT import `k6*` or call `open()`, so Node imports them unchanged.
- **FR-002**: `parseDuration` MUST throw on garbage including the empty string and accept `500ms`, `90s`,
  `10m`, `1h30m`, `1m30s` and integer seconds.
- **FR-003**: `buildPhasePlan` MUST implement every row of §4.1 and MUST NOT derive `*_EVENTS`.
- **FR-004**: `buildThresholds` MUST implement every rule of §4.2; the dropped rule MUST use `MAX_DROPPED_RATE`.
- **FR-005**: `buildScenarios` MUST use arrival-rate executors only (open model, D4) and the VU formulas of §4.3;
  Kafka VUs MUST NOT depend on `MAX_VUS`.
- **FR-006**: Test-data ids MUST follow §2.3 and event ids MUST NOT exceed 50 characters.
- **FR-007**: `fillTemplate` MUST deep-copy, replace `{{name}}` and drop `$comment` at any level.
- **FR-008**: CloudEvent `source` and `facilityid` MUST come from the dataset or settings, never hard-coded.
- **FR-009**: `writeSummary` MUST write the raw summary plus the context block, without remote jslib imports.
- **FR-010**: Every file MUST carry the §2.4 header; every function a "why" comment.
- **FR-011**: "ebuzima" MUST appear only as the dataset name/value or in fixture content (R2.4).

## Success Criteria

- **SC-001**: `node --test lib/unit-tests/` passes with zero failures.
- **SC-002**: The probe `k6 inspect` and `k6 run` (network none) succeed; the sample fixture is captured.
- **SC-003**: The overrides self-check reproduces all three v1 variants (3/3 deep-equal).
- **SC-004**: The dataset templates reproduce the v1 eBUZIMA builders for all 10 action ids (self-check).
