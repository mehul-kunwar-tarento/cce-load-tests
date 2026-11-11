<!--
  What:    Task list for the restructure: one task per work package (plan.md §13) plus integration tasks.
  How:     The orchestrator ticks a task ("- [x]") when its package's own tasks.md is fully ticked and its
           static verification (plan.md §12) passed. Work packages never edit this file. The "Status"
           section below records when and with what results the integration checks were last run.
  Needs:   spec.md (requirements R1..R15, decisions D1..D20) and plan.md (the contract) in this folder.
  Outputs: Progress record of the restructure.
-->

# Tasks: CCE performance testing setup (restructure)

**Input**: `spec.md`, `plan.md` (this folder)
**Prerequisites**: discovery done (v1 inventory, collector, matcher, Step SLA + cleanup, Grafana + specs)
**Format**: `- [ ] T### [P] [Rn…] Description (package, spec folder; plan sections)` — `[P]` = can run in
parallel with the other `[P]` tasks of the same phase (disjoint files, plan.md §13).

## Status (2026-11-06, after review round 2)

T001–T032 are **done**. Only T040 stays open: it is `DEFERRED (owner)` because it needs a live stack (D14).
The integration checks were re-run on 2026-11-06 on the tree after the round-1 and round-2 review fixes,
statically only (no connection to any service, database, broker, Prometheus or Grafana):

| Check | Command | Result |
|---|---|---|
| Unit tests (T014, T023, T032) | `npm test` | 669 pass / 0 fail |
| Lint (T014, T032) | `npm run lint` | exit 0: `eslint .` clean; `prettier --check .` "All matched files use Prettier code style!"; `lint-headers` "All 289 file(s) have their header"; `lint:shell` SKIPPED (shellcheck not installed on this machine, see note) |
| k6 scripts (T023) | `npm run check:k6` | `ok` for all 8 k6 tests (k6 inspect, network none) |
| Dry runs (T014, T023) | `node tools/cli.mjs run local <subject> <test-type> --dry-run` | exit 0 for all 12 subject × test-type pairs and for the `stub` fixture module; nothing written |
| R9 acceptance (T014, T023) | `node tools/cli.mjs settings local collector load --set LOAD_EVENTS=1000` (and the `stub` variant) | `LOAD_DURATION 20s derived` |
| Generic names (T032, spec R2.4) | the two commands of plan.md §2.1 | both print nothing |
| Secrets (T032, SC-006) | grep for `cce_pass`, `cceadmin`, `password"` with a value, outside `archive/` | only the rule text in `spec.md` and the check list inside `monitoring/unit-tests/dashboards.spec.mjs` |
| Links (T032) | every relative Markdown link outside `archive/`, plus `archive/README.md` (74 files) | 0 broken |
| Spec headings (T032) | the §1.2 headings in all 11 spec folders | present (the blueprint's `plan.md` uses the numbered mapping given in `specs/README.md`) |
| Requirements map (T032, SC-004) | `docs/requirements-checklist.md` | R1–R15 each have a row |
| Package tasks (T032) | every package and service `tasks.md` | all ticked except one `DEFERRED (owner)` task each in 002, 003, 004 and the three service specs; spec 007 is future work (every task open by design) |

Note on `lint:shell`: `tools/core/run-shellcheck.mjs` skips (exit 0) when neither `shellcheck` nor the
`koalaman/shellcheck:v0.10.0` image is available; instead `bash -n` was run on all 9 shell scripts outside
`archive/` (all pass). Run `npm run lint` again on a machine with shellcheck before the first commit
(recorded in `docs/open-questions.md`). Test and header counts grow or shrink as later review fixes add or
remove files; what must hold is 0 failures and a clean lint.

"Implemented" in [specs/README.md](../README.md) therefore means built and verified statically; the first
live run of each part is T040.

## Phase 1: Blueprint

- [x] T001 [R13] Write `specs/000-performance-testing-setup/spec.md` (goal, scope, R1–R15 with acceptance
      criteria, owner decisions D1–D20, user stories, success criteria)
- [x] T002 [R13] Write `specs/000-performance-testing-setup/plan.md` (contract §0–§14)
- [x] T003 [R13] Write this `tasks.md` with the work packages (plan.md §13)
- [x] T004 [R13] Revise spec/plan/tasks after the blueprint review (2026-11-06): k6 clock contract, pinned
      settings types, one-client cleanup with snapshot verification, plan-definition write safety, seeded
      lifecycle, run selectors, Kafka VUs, index-friendly SQL, shims, owner's spec headings, deferred tasks

**Checkpoint**: every package can start from plan.md alone.

## Phase 2: Shared foundations (wave A — parallel)

- [x] T010 [P] [R2 R3 R9 R11 R13] **A1** Shared k6 library (`lib/`), Docker image (`docker/k6/`), test data
      (dataset `ebuzima-emr`, plan-definition fixtures + overrides, sets `single`/`overlapping-2`/`overlapping-4`),
      `scripts/build-k6-image.sh`, k6 summary fixtures (`lib/unit-tests/fixtures/`) —
      `specs/001-shared-k6-library-and-test-data/`; plan §0, §1, §2, §3.5, §4, §5.3, §7.3, §12
- [x] T011 [P] [R1 R5 R9 R11 R13] **A2** Node tooling core: `package.json`, `package-lock.json`, `.npmrc`,
      lint/format/editor config (`.editorconfig`, `prettier.config.mjs`, `.prettierignore`, `eslint.config.mjs`),
      `.gitignore`, `config/` (environments + settings defaults), `tools/cli.mjs`, `tools/core/` (settings,
      environment, results, k6 runner, k6 clock, summary normaliser, result builder, breaking analysis, staircase,
      conditions, sampler + sampled metrics, watchers, idle helpers, run SQL, registry + stub service, clients),
      `tools/report/`, `tools/baseline/`, result schema,
      `tools/commands/{run-test,settings,report,baseline,check-data,lint-headers}.mjs` and their command tests, `baselines/`,
      `scripts/{run-test,print-settings,build-report,manage-baselines}.sh` —
      `specs/002-node-tooling-core/`; plan §0–§6, §8, §12, §13
- [x] T012 [P] [R2 R11 R13 R14 R15] **A3** Preflight checks, batched verified cleanup, plan-definition sets
      tooling (validate, generate variants, expected rows, protocol API, load/retire/delete/status) and their
      commands (`tools/commands/{preflight,cleanup,plan-definitions}.mjs`), schemas
      (`tools/results/{preflight,cleanup}.schema.json`) and scripts
      (`scripts/{check-services,cleanup-test-data,manage-plan-definitions}.sh`) —
      `specs/003-preflight-cleanup-and-plan-definition-sets/`; plan §2.3, §3.1, §3.2, §5.5–§5.7, §6.1, §6.3,
      §7.1–§7.3, §12, §13
- [x] T013 [P] [R8 R11 R13] **A4** `monitoring/`: compose (Prometheus remote-write receiver, Grafana,
      exporters), scrape config, provisioning, five dashboards, CCE-Grafana import guide and example scrape
      jobs, dashboard unit test — `specs/004-monitoring-and-grafana/`; plan §1 (monitoring rows), §2.4,
      §3.1, §9.1–§9.5, §12, §14 (Q2, Q7)
- [x] T014 Integration check of wave A: `npm install`, `npm run format` (whole tree, plan §2.4), `npm test`,
      `npm run lint`, `node tools/cli.mjs run local stub load --dry-run --modules-root tools/core/unit-tests/fixtures`,
      `node tools/cli.mjs settings local stub load --set LOAD_EVENTS=1000 --modules-root tools/core/unit-tests/fixtures`
      (LOAD_DURATION 20s derived), A2 tests that import A1's `lib/` pure modules and the A1 k6 summary fixture
      now pass, A3's overrides equality test passes on A1's overrides, interface deviations recorded in each
      package's plan.md resolved (orchestrator)

**Checkpoint**: shared foundations verified statically; service packages can plug in.

## Phase 3: Service folders (wave B — parallel)

- [x] T020 [P] [R3 R7 R11 R13] **B1** `cce-collector-service/` — README, test plan + strategy, spec,
      service module, smoke/load/stress/breakpoint k6 tests, data checks, unit tests —
      `cce-collector-service/specs/001-collector-performance-tests/`; plan §2, §3.2, §4, §5.2, §6.2, §6.4,
      §6.8, §6.9, §8.3, §10.1–§10.3, §12
- [x] T021 [P] [R3 R7 R11 R13] **B2** `cce-matcher-service/` — Kafka k6 tests (flood = breakpoint), backlog
      watcher (Kafka lag), data checks, unit tests, docs — `cce-matcher-service/specs/001-matcher-performance-tests/`;
      plan §2, §3.2, §4, §5.2, §6.2, §6.4–§6.6, §6.8, §6.9, §7.3, §8.3, §10, §12
- [x] T022 [P] [R3 R7 R11 R13] **B3** `cce-step-sla-service/` — Node test definitions, alarm seeder, alarm
      watcher, DB data checks, unit tests, docs — `cce-step-sla-service/specs/001-step-sla-performance-tests/`;
      plan §2, §3.2, §4.1, §5.1–§5.2, §6.2, §6.4, §6.5, §6.7, §6.9, §8.3, §10, §12
- [x] T023 [R9] Integration check of wave B: `npm run check:k6` (k6 inspect, network none) for every k6 test;
      `run --dry-run` for every subject × test type; `npm test`; the R9 acceptance command
      `node tools/cli.mjs settings local collector load --set LOAD_EVENTS=1000` prints LOAD_DURATION 20s
      (source derived) (orchestrator)

**Checkpoint**: every in-scope v1 test exists in the new tree and passes static checks (SC-001).

## Phase 4: Documentation and archive (wave C — parallel)

- [x] T030 [P] [R1 R4 R5 R6 R9 R12 R13] **C1** Root `README.md`, `CONTRIBUTING.md`, `docs/` (plan §1.1),
      `specs/README.md`, `specs/007-uat-dev-traffic-analysis/` — `specs/005-documentation-and-runbook/`;
      plan §0, §1, §1.1, §1.2, §2, §3, §5, §6.1, §7, §8, §9, §10, §12, §14
- [x] T031 [P] [R4 R13] **C2** `archive/README.md`, prune ported v1 files, keep adaptor + flow runnable —
      `specs/006-archive-finalisation/`; plan §10.4, §11, §12
- [x] T032 Final integration: `npm test`, `npm run lint`; `docs/requirements-checklist.md` maps R1–R15 to
      files; the two generic-name commands of plan §2.1 print nothing (spec R2.4); no secrets (SC-006);
      every relative link in docs resolves (incl. C1 → `archive/README.md`); every spec folder carries the
      §1.2 headings; every package task is ticked except `DEFERRED (owner)` ones (orchestrator)

## Phase 5: Deferred to the owner (not part of "finished"; D14 forbids live runs during the build)

- [ ] T040 DEFERRED (owner): first live smoke of each service on the laptop (`scripts/check-services.sh local`,
      then `scripts/run-test.sh local <subject> smoke`, report shown), following `docs/runbook.md`; confirm the
      "verify at first scrape" metric names (plan §9.4) and the expected rows per event (plan §7.3)

**Checkpoint**: restructure complete; the owner reviews and commits by hand on a generic branch
(e.g. `chore/restructure-performance-tests`). First live smoke on the laptop follows `docs/runbook.md`.

## Dependencies & execution order

- Phase 2 tasks T010–T013 run in parallel; each codes against plan.md interfaces, not against the others'
  files. Cross-package contracts: lib pure modules (§4.1–§4.6) used by A2; core clients and command module
  contract (§6.1, §6.3) used by A3; k6 summary fixture (§5.3) produced by A1 and consumed by A2;
  `tools/plan-definitions/active.mjs` (§7.3) produced by A3 and imported lazily by A2's `conditions.mjs`;
  plan-definition overrides (§7.3) produced by A1 and checked by A3 against its copied v1 variant fixtures.
- Phase 3 needs Phase 2 (T014). B1, B2, B3 are independent of each other.
- Phase 4 needs Phase 3 (docs describe what exists; archive pruning only after ports are verified). C1 and C2
  run in parallel: C2 copies the v1 baseline numbers into `archive/README.md` itself; C1 collects the
  "Deviations / requests" of every package's plan.md into `docs/open-questions.md`.
- `.cache/` is owned by no package: each tool writes only its own subfolder; build-time probes live outside
  the repository (session scratchpad).

## Implementation strategy

MVP = A1 + A2 + A3 + B1 (collector smoke runnable end to end once a stack is available), then B2, B3,
monitoring and docs. No git operations at any point (D1); verification static only (D14).
