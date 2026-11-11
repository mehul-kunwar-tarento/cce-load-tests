<!--
  What:    Task list of work package C1 (documentation and runbook), in build order.
  How:     Work top to bottom; tick a task ("- [x]") when its file is written and, for verification tasks,
           when the check passed. [P] = can be done in parallel with other [P] tasks of the same phase.
  Needs:   spec.md and plan.md (same folder); the built tree of waves A and B.
  Outputs: Progress record of C1.
-->

# Tasks: Documentation and runbook

**Input**: `spec.md`, `plan.md` (this folder) · **Contract**: `specs/000-performance-testing-setup/plan.md`
**Format**: `- [ ] T### [P] [USn] Description with exact file path`

## Phase 1: Setup

- [x] T001 Inventory what is built: `node tools/cli.mjs --help` and every command's `--help`, `scripts/`,
      `config/settings/defaults.json` names and defaults, folder READMEs, service test plans, every package
      plan.md `## Deviations / requests`, every `DEFERRED (owner)` task
- [x] T002 Write `specs/005-documentation-and-runbook/spec.md`, `plan.md` and this `tasks.md`

## Phase 2: Foundational (terms and rules other docs link to)

- [x] T003 [P] `docs/glossary.md` (every term of plan §1.1 plus k6 clock, effective fan-out, load-test marker,
      run selector, snapshot verification, seed mode)
- [x] T004 [P] `docs/conventions.md` (naming, in code, test-data ids, headers, specs, git, adding things,
      generic-name check)
- [x] T005 [P] `specs/README.md` (index of every spec folder with status, headings rule)

## Phase 3: User Story 1 - A newcomer runs a first smoke test (P1)

- [x] T006 [US1] `README.md` (purpose, facts bar, Quick Start, Documentation, How it works, Testing, layout)
- [x] T007 [US1] `docs/architecture-overview.md` (CCE, both paths, each service and how it is fed, run
      lifecycle and k6 clock, feasibility and gaps, later modules)
- [x] T008 [US1] `docs/runbook.md` (prerequisites → troubleshooting)
- [x] T009 [P] [US1] `docs/test-strategy.md`
- [x] T010 [P] [US1] `docs/workload-model.md`

## Phase 4: User Story 2 - The lead sees what is done and what needs a decision (P1)

- [x] T011 [US2] `docs/known-results-and-lessons.md` (v1 laptop numbers, corrections, lessons → design)
- [x] T012 [US2] `docs/requirements-checklist.md` (R1..R15, no R10)
- [x] T013 [US2] `docs/open-questions.md` (Q1–Q20, every package deviation/request, every DEFERRED task)

## Phase 5: User Story 3 - A developer adds a service, an adaptor or a test type (P2)

- [x] T014 [US3] `CONTRIBUTING.md` (workflow, headings, DEFERRED tasks, naming, commits/branches, how to add
      a test type / service / adaptor / end-to-end module, shims, module-relative `testFile`, checks)

## Phase 6: User Story 4 - UAT/Dev traffic into a workload profile (P2)

- [x] T015 [US4] `specs/007-uat-dev-traffic-analysis/spec.md` (§1.2 headings)
- [x] T016 [US4] `specs/007-uat-dev-traffic-analysis/plan.md` (queries, privacy, profile JSON schema, mapping)
- [x] T017 [US4] `specs/007-uat-dev-traffic-analysis/tasks.md` (all tasks unticked: future work)

## Phase 7: Polish

- [x] T018 Hand review of C1's Markdown: "eBUZIMA" only as the dataset name or history; v1 numbers marked
      "laptop, relative only"; no secret values; every doc title `# CCE Performance Tests — <Doc>`

## Phase 8: Verification (static only, D14)

- [x] T019 Relative links in C1's files resolve (scratchpad script); `archive/README.md` recorded if pending
- [x] T020 Every `node tools/cli.mjs …` / `npm run perf -- …` command, sub-command and option and every
      `scripts/*.sh` quoted in C1's files exists (scratchpad script against the `--help` texts)
- [x] T021 Every setting name quoted in C1's files exists in `config/settings/defaults.json` (secrets and
      documented env vars excepted)
- [x] T022 Every spec folder of plan §1.2 that exists has the mandatory headings (scratchpad script)
- [x] T023 The two generic-name commands of plan §2.1 print nothing
- [x] T024 `node tools/cli.mjs lint-headers --paths README.md CONTRIBUTING.md docs specs/README.md
      specs/005-documentation-and-runbook specs/007-uat-dev-traffic-analysis` reports no problem
- [x] T025 Secrets grep over C1's files (the 000 spec SC-006 patterns) prints nothing;
      `npm test` still passes (C1 adds no code)
