<!--
  What:    Feature specification of work package C1: the root landing page (README.md), the contributor
           guide (CONTRIBUTING.md), the suite documentation under docs/ (runbook, overview, strategy,
           glossary, workload model, conventions, known results and lessons, requirements checklist,
           open questions), the spec index (specs/README.md) and the future-work spec
           specs/007-uat-dev-traffic-analysis/.
  How:     Read top to bottom. plan.md (same folder) says how and lists every file; tasks.md is the
           checklist. Contract: specs/000-performance-testing-setup/plan.md §0, §1, §1.1, §1.2, §2, §3,
           §5–§10, §12, §14.
  Needs:   specs/000-performance-testing-setup/{spec,plan}.md (R1–R15, D1–D20) and everything built in
           waves A and B (the docs describe what IS built).
  Outputs: Requirements FR-001..FR-020 and the acceptance criteria for C1's files.
-->

# Feature Specification: Documentation and runbook

**Feature Branch**: n/a (folder only; suggested branch feature/documentation-and-runbook)
**Created**: 2026-11-06
**Status**: Implemented (static verification only, D14)
**Input**: Team lead's review points 6 (docs and an onboarding runbook), 9 (baseline from UAT/Dev
analysis, with a spec for how to extract it), 12 (feasibility confirmed), 13 (spec-driven, index of specs)
and the prompt set's phase 1 (`07-phase-1-docs.md`) and requirement checklist (`11-requirements-checklist.md`).

## Goal

Someone who was not part of the first test round, and who may be new to performance testing, must be able
to understand what this suite is, set it up, run every test of every service, read the result, clean up
safely and know what is still undecided, from the documents alone. The documents describe what **is**
built in waves A and B (commands, settings, files), never what was only planned, and every command they
quote exists in the CLI.

## Scope

### In scope
- `README.md` (root landing page in the CCE style: purpose, facts bar, Quick Start, Documentation table,
  How it works diagram, Testing).
- `CONTRIBUTING.md` (spec-first workflow with the mandatory headings and `DEFERRED (owner)` tasks,
  naming, Conventional Commits and generic branch names, how to add a test type / service / adaptor /
  end-to-end module including the two shims and the module-relative `testFile`, lint and test commands).
- `docs/architecture-overview.md`, `docs/test-strategy.md`, `docs/glossary.md`, `docs/runbook.md`,
  `docs/workload-model.md`, `docs/conventions.md`, `docs/known-results-and-lessons.md`,
  `docs/requirements-checklist.md`, `docs/open-questions.md` (plan §1.1).
- `specs/README.md`: index of every spec folder (root and per-service) with its status.
- `specs/007-uat-dev-traffic-analysis/{spec,plan,tasks}.md`: future-work spec (tasks left unticked) for
  extracting the real event flow from UAT/Dev and turning it into a workload profile and a baseline.
- This spec folder.

### Out of scope
- Any code, configuration, test, dashboard or service-folder document (owned by A1–A4, B1–B3).
- `archive/README.md` (C2); C1 only links to it.
- Building the workload profile or the traffic-analysis queries (spec 007 is future work).
- Running anything against a live stack (D14); the first live smoke is the owner's (`DEFERRED (owner)`).

## Inputs

- Contract: `specs/000-performance-testing-setup/plan.md` (§0 run lifecycle and k6 clock, §1 tree, §1.1 docs
  list, §1.2 spec headings, §2 naming and generic-name check, §3 configuration, §5 results, §6.1 CLI,
  §6.4 shims, §7 preflight/cleanup/plan definitions, §8 reports and baselines, §9 Grafana, §10 service
  folders and later modules, §12 verification, §14 open questions) and `spec.md` (R1–R15, D1–D20).
- What is built: `node tools/cli.mjs --help` and every command's `--help`, `tools/README.md`,
  `config/README.md`, `config/settings/defaults.json`, `test-data/README.md`, `baselines/README.md`,
  `docker/k6/README.md`, `lib/README.md`, `monitoring/README.md`, the three service READMEs, test plans and
  test strategies, and the `## Deviations / requests` section of every package plan.md.
- Prompt set: `02-naming-conventions.md`, `03-cce-background-and-lessons.md` (§2.1 paths, §2.2 results,
  §2.3 lessons), `07-phase-1-docs.md`, `11-requirements-checklist.md`.
- History (read-only): `performance_testing/NOTES.md`, `journal.md`, `results/STRESS-REPORT-2026-11-03.md`,
  `results/SUMMARY-*.md`, `results/round-local-machine-20261103-0038/SUMMARY.md`,
  `archive/v1/docs/TEST-PLAN.md`, `archive/v1/baselines/local-4plans.json`.
- CCE style reference: `openphc-repos/cce-step-sla-service` (release-2.0.0) README and `docs/`.

## Outputs

- The 13 Markdown files listed in plan.md `## Files`, each starting with the HTML-comment header
  (What / How / Needs / Outputs, plan §2.4).
- No code, no JSON, no command. Verification scripts run from the session scratchpad and are not
  committed (plan §12: C1 checks are links, CLI commands, spec headings).

## Acceptance criteria

1. Every file of plan §1.1 exists, plus `README.md`, `CONTRIBUTING.md`, `specs/README.md` and the three
   files of `specs/007-uat-dev-traffic-analysis/`.
2. Every relative link in C1's files resolves to an existing file or folder (the link to
   `archive/README.md` may be pending while C2 runs; recorded and re-checked by 000 T032).
3. Every `node tools/cli.mjs <command> [<sub-command>]` and every `scripts/*.sh` quoted in C1's files
   exists (`node tools/cli.mjs --help`, the command's `--help`, `scripts/`), and every option quoted for a
   command appears in that command's `--help`.
4. Every setting name quoted in C1's files (an `UPPER_SNAKE_CASE` word that looks like a setting) is a key of
   `config/settings/defaults.json` or one of the secrets `DB_PASSWORD`, `GRAFANA_API_TOKEN`,
   `GRAFANA_ADMIN_PASSWORD` or another documented environment variable (`K6_PROMETHEUS_RW_*`, …).
5. Every spec folder of plan §1.2 that exists carries the mandatory headings (spec.md: Goal, Scope, In
   scope, Out of scope, Inputs, Outputs, Acceptance criteria, User Scenarios & Testing, Requirements,
   Success Criteria; plan.md: Approach, Files, Interfaces, Technical Context, Deviations / requests;
   tasks.md: checkbox tasks), presence only, numbering ignored, 000 plan.md mapping accepted.
6. The two generic-name commands of plan §2.1 print nothing; in C1's Markdown "eBUZIMA"/"ebuzima" appears
   only as the dataset name `ebuzima-emr`, the first EMR's name in history, or v1 history.
7. `node tools/cli.mjs lint-headers --paths <C1 files>` reports no problem.
8. No secret value in C1's files (the 000 spec SC-006 secrets grep finds nothing).
9. `docs/requirements-checklist.md` maps R1..R15 (noting there is no R10) to files, commands and status.
10. `docs/open-questions.md` contains plan §14 Q1–Q20, every item of every package's
    `## Deviations / requests`, and every `DEFERRED (owner)` task.
11. Every task in tasks.md is ticked.

## User Scenarios & Testing

### User Story 1 - A newcomer runs a first smoke test (Priority: P1)

A tester who has never run a load test opens the repository.

**Why this priority**: the lead's point 6; without it nobody but the authors can run the suite.

**Independent Test**: follow `README.md` → `docs/runbook.md` with a laptop stack; every command exists.

**Acceptance Scenarios**:
1. **Given** a laptop with Docker and Node 22, **When** the tester follows the runbook's prerequisites,
   image, `npm install`, monitoring and environment steps, **Then** `scripts/check-services.sh local`
   and `scripts/run-test.sh local collector smoke` are the next commands, and the runbook says what each
   prints and what to do when a check fails.
2. **Given** a finished run, **When** the tester opens `report.md` and Grafana, **Then** the runbook and
   glossary explain every section and term (expectation, thresholds, started breaking, dropped iterations,
   data checks, conditions, `testid`).

### User Story 2 - The lead sees what is done and what needs a decision (Priority: P1)

**Why this priority**: the restructure exists because of the lead's review.

**Independent Test**: read `docs/requirements-checklist.md` and `docs/open-questions.md`.

**Acceptance Scenarios**:
1. **Given** the lead's 15 points, **When** the lead reads the checklist, **Then** each point (R10 noted
   as absent) names the files and commands that meet it and its status.
2. **Given** decisions still open, **When** the lead reads the open questions, **Then** each item says
   who decides, what the current default is and where it is recorded.

### User Story 3 - A developer adds a service, an adaptor or a test type (Priority: P2)

**Independent Test**: follow `CONTRIBUTING.md` / `docs/conventions.md` on paper for an adaptor folder.

**Acceptance Scenarios**:
1. **Given** a new adaptor, **When** the developer follows the "add an adaptor" steps, **Then** they create
   a folder named after its repository with a `service-module.mjs`, the two shims, a module-relative
   `testFile`, a spec folder, and no change to the three service folders.

### User Story 4 - Someone turns UAT/Dev traffic into a workload profile (Priority: P2)

**Independent Test**: read `specs/007-uat-dev-traffic-analysis/`; the queries are read-only and aggregate.

**Acceptance Scenarios**:
1. **Given** read access to UAT, **When** the analyst follows spec 007, **Then** they know which tables and
   columns to read, how to bucket time, what may leave the environment (aggregates only), and the JSON
   shape of the workload profile that later feeds `WORKLOAD_PROFILE`, `EVENT_MODE=journey`, `PEAK_RATE`,
   `EXPECTED_HEADROOM` and `STEP_SLA_PEAK_ALARM_RATE`.

### Edge Cases
- `archive/README.md` does not exist yet while C2 runs: the link is recorded as pending, not removed.
- A command quoted in a doc is renamed later: the scratchpad check (re-run by 000 T032) fails.
- A setting default changes in `defaults.json`: docs quote names and point to `defaults.json` /
  `node tools/cli.mjs settings` for values; the few values quoted are the signed-off defaults (D11).
- v1 numbers are mistaken for real capacity: every v1 number is labelled "laptop, relative only".

## Requirements

### Functional Requirements

- **FR-001**: `README.md` MUST follow the CCE README style: purpose paragraph, facts bar, Quick Start,
  Documentation table, How it works diagram, Testing.
- **FR-002**: Every doc title MUST read `# CCE Performance Tests — <Doc>` and use numbered sections.
- **FR-003**: `docs/architecture-overview.md` MUST show the write path and the analytics path (diagram),
  each service and how it is fed on its own, the run lifecycle of plan §0 with the k6 clock, and the
  feasibility and gaps of plan §10.3.
- **FR-004**: `docs/test-strategy.md` MUST cover test types and when to use each, the open load model,
  threshold vs capacity vs breaking point vs baseline, warm-up, staircase refinement with warm-up at the
  last good level, the dropped-iterations rule (< 0.1 %, TBC) and "at least X/s (k6 limit)", diagnostics vs
  verdict, environments (laptop vs Dev/UAT with k6 on its own host) and repeat runs (≥ 3).
- **FR-005**: `docs/glossary.md` MUST define every term of plan §1.1 plus k6 clock, effective fan-out,
  load-test marker, run selector, snapshot verification and seed mode.
- **FR-006**: `docs/runbook.md` MUST cover prerequisites, image build, `npm install`, monitoring up/down,
  configuring an environment (secrets, `<env>.local.json`), plan-definition sets and their write safety,
  preflight, running each test of each service, reading results and Grafana, series reports, baselines,
  cleanup (print-sql, dry-run, delete, legacy v1, why batching/WAL matter) and troubleshooting built from
  the lessons.
- **FR-007**: `docs/workload-model.md` MUST explain rate + duration vs total events (measured phase only),
  warm-up, staircase, flood, storm, Step SLA seed modes and the alarms/s peak, Kafka VU limits, the
  settings with their defaults, the reserved `EVENT_MODE`/`WORKLOAD_PROFILE`, and how the UAT/Dev analysis
  becomes a workload profile and a baseline.
- **FR-008**: `docs/conventions.md` MUST state the naming rules (plan §2, `02-naming-conventions.md`),
  header comments, the spec-first workflow and how to add a test type, a service, an adaptor module and
  the end-to-end module.
- **FR-009**: `docs/known-results-and-lessons.md` MUST give the v1 numbers marked "laptop, relative only",
  correct the matcher stress "catch-up" (121.4 s was the give-up time), and link each lesson to the design
  element that addresses it.
- **FR-010**: `docs/requirements-checklist.md` MUST map R1..R15 (no R10) to concrete files, commands and status.
- **FR-011**: `docs/open-questions.md` MUST hold plan §14 Q1–Q20, every package deviation/request and
  every `DEFERRED (owner)` task, each with an owner and a status.
- **FR-012**: `specs/README.md` MUST index every spec folder of plan §1.2 with its status.
- **FR-013**: `specs/007-uat-dev-traffic-analysis/` MUST specify the read-only extraction (events/s, peak,
  burst shape, event-type mix, events per patient), the privacy rule (aggregates only) and the workload
  profile JSON schema, with the §1.2 headings and tasks left unticked.
- **FR-014**: `CONTRIBUTING.md` MUST describe the spec-first workflow with the §1.2 headings and
  `DEFERRED (owner)` tasks, Conventional Commits, generic branch names (never `NNN-name`), how to add a
  test type / service / adaptor / end-to-end module including the shims and module-relative `testFile`,
  and the lint and test commands.
- **FR-015**: Every C1 file MUST start with the What/How/Needs/Outputs HTML-comment header.
- **FR-016**: Every command quoted MUST exist in the CLI or `scripts/`; every setting quoted MUST exist in
  `defaults.json`.
- **FR-017**: Docs MUST NOT contain secrets; passwords are shown only as `export DB_PASSWORD=…`.
- **FR-018**: "eBUZIMA" MUST appear only as the first dataset's name or in history.
- **FR-019**: Plain language for newcomers: each doc explains a term on first use or links the glossary.
- **FR-020**: Docs MUST describe the built behaviour where it differs from the 000 plan (package
  deviations), e.g. `--dry-run` writes nothing, staircase verdict is the capacity rule, Kafka tests never
  report a k6 limit, `plan-definitions` uses `--setting` for overrides.

## Success Criteria

### Measurable Outcomes

- **SC-001**: 0 broken relative links in C1's files (except `archive/README.md` while pending).
- **SC-002**: 0 CLI commands or options quoted that the CLI does not offer.
- **SC-003**: 0 setting names quoted that `defaults.json` does not define (secrets and k6/Docker env vars excepted).
- **SC-004**: Every spec folder that exists has the mandatory headings (0 missing).
- **SC-005**: `lint-headers` reports 0 problems for C1's files; the generic-name commands print nothing.
- **SC-006**: R1..R15 all appear in the checklist; Q1–Q20 and every deviation/request and DEFERRED task appear
  in the open questions.
