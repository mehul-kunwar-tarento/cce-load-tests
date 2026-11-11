<!--
  What:    Task list of work package A1 (shared k6 library, k6 image, test data), ticked as the work is done.
  How:     Work top to bottom; tick "- [x]" when a task is done and its check passed.
  Needs:   spec.md and plan.md in this folder; specs/000-performance-testing-setup/plan.md.
  Outputs: Progress record of A1. The orchestrator ticks 000 T010 when every task here is ticked.
-->

# Tasks: Shared k6 library, k6 Docker image and test data

**Input**: `spec.md`, `plan.md` (this folder) · **Format**: `- [ ] T### [P] Description with exact file path`
(`[P]` = can run in parallel with other `[P]` tasks of the same phase).

## Phase 1: Setup

- [x] T001 Write `specs/001-shared-k6-library-and-test-data/spec.md`, `plan.md`, `tasks.md`
- [x] T002 Create folders `lib/unit-tests/fixtures/`, `docker/k6/`, `test-data/{datasets,plan-definitions/variants,plan-definition-sets}/`, `scripts/`

## Phase 2: Foundational (pure modules)

- [x] T003 [P] `lib/duration.js`: `parseDuration` (throws on garbage incl. ''), `formatDuration`, `toK6Duration`
- [x] T004 [P] `lib/settings-guard.js`: typed-settings guards (numbers of seconds, rates, level lists)
- [x] T005 `lib/phase-plan.js`: `buildPhasePlan` (every §4.1 row incl. Step SLA `none`, warm-up only when > 0, staircase levels, flood, windows), `phaseAt`, `plannedSentBy`
- [x] T006 `lib/windows.js`: `windowIndexAt`, `levelAt`, `windowBounds`, `windowCoverSeconds`
- [x] T007 `lib/thresholds.js`: `allowedDropped`, `buildThresholds` (every §4.2 rule), `describeThreshold`, `isDummyRule`
- [x] T008 `lib/scenarios.js`: `vusFor`, `buildScenarios` (HTTP and Kafka VU formulas, staircase stages), `buildOptions`
- [x] T009 [P] `lib/test-data.js`: ids (§2.3, 50-char guard), `fillTemplate` (drops `$comment`), `buildFhirResource`, `buildCloudEvent`, `eventDefaults`, `buildIterationEvent`

## Phase 3: User Story 1 — k6 modules (P1)

- [x] T010 [P] `lib/run-context.js`: `getRunContext` (absolute `RUN_CONTEXT`, clear error), `assertRunContextFor`
- [x] T011 [P] `lib/tagging.js`: `tagIteration` (phase/level/window VU tags; v1 `tagLevel` generalised)
- [x] T012 [P] `lib/http-client.js`: `postJson`, `checkResponse`, `statusIs`, `jsonFieldEquals`
- [x] T013 [P] `lib/kafka-client.js`: `createProducer`, `produceEvent` (xk6-kafka 2.2.0 as in archive/v1/matcher/matcher.js)
- [x] T014 [P] `lib/event-metrics.js`: counters `events_sent`, `events_accepted`, `recordSend`
- [x] T015 [P] `lib/summary.js`: `markK6Start`, `writeSummary` (raw data + context block), `summaryText`
- [x] T016 `lib/README.md`: modules (pure vs k6), test-file skeleton, k6 clock contract, summary and threshold shape

## Phase 4: User Story 2 — unit tests (P1)

- [x] T017 [P] `lib/unit-tests/duration.spec.mjs`, `phase-plan.spec.mjs`, `windows.spec.mjs`
- [x] T018 [P] `lib/unit-tests/thresholds.spec.mjs`, `scenarios.spec.mjs`, `test-data.spec.mjs`, `summary.spec.mjs`, `purity.spec.mjs`

## Phase 5: User Story 3 — test data (P1)

- [x] T019 `test-data/datasets/ebuzima-emr/dataset.json` ported from archive/v1/lib/ebuzima.js; self-check `derive/check-dataset.mjs` (scratchpad) 10/10 equal
- [x] T020 [P] `test-data/plan-definitions/emr-service-protocol.json` verbatim copy of archive/v1/protocol/emr-service-protocol.json
- [x] T021 `test-data/plan-definitions/variants/{strict,light,lab-focus}.overrides.json` by scripted diff `derive/derive-overrides.mjs` (scratchpad) with §7.3 self-check 3/3
- [x] T022 [P] `test-data/plan-definition-sets/{single,overlapping-2,overlapping-4}/set.json`
- [x] T023 [P] `test-data/README.md`
- [x] T024 `lib/unit-tests/test-data-files.spec.mjs`: datasets, overrides and sets (references, mandatory steps 3/7/1/5)

## Phase 6: User Story 4 — k6 summary fixtures and image (P2)

- [x] T025 Probe in the scratchpad (`probe/probe.js`, `probe/run-context.json`), `k6 run` with `--network none` → `lib/unit-tests/fixtures/k6-summary-sample.json`; record the threshold shape in `lib/README.md`
- [x] T026 Synthetic `lib/unit-tests/fixtures/k6-summary-breakpoint.json` and `k6-summary-kafka.json` (level/window keys, context block); fixture tests in `lib/unit-tests/summary.spec.mjs`
- [x] T027 [P] `docker/k6/Dockerfile` (copy with comments + header), `docker/k6/README.md`
- [x] T028 [P] `scripts/build-k6-image.sh` (≤ 30 lines, verb-first)

## Phase 7: Polish

- [x] T029 Prettier (A2's installed `prettier@3.9.10` + `prettier.config.mjs`: printWidth 100, singleQuote, trailingComma all) on A1's JS/MJS/JSON; verbatim base PlanDefinition restored afterwards
- [x] T030 Header and "why"-comment review of every A1 file (§2.4)

## Phase 8: Verification (static only, §12)

- [x] T031 `node --check` on every lib file; `node --test lib/unit-tests/`
- [x] T032 JSON parse of every A1 JSON file; `bash -n scripts/build-k6-image.sh`
- [x] T033 `k6 inspect` (network none) of the RUN_CONTEXT-based probe importing every lib module
- [x] T034 §2.1 generic-name commands restricted to A1's paths print nothing
