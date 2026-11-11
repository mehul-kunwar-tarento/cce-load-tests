<!--
  What:    Implementation plan of work package C1 (documentation and runbook): approach, every file it
           writes, the "interfaces" a reader relies on (document titles, section lists, the facts each
           document must state), technical context and deviations.
  How:     Read after spec.md (same folder); tasks.md lists the steps in order.
  Needs:   specs/000-performance-testing-setup/plan.md (contract), the built tree of waves A and B.
  Outputs: The plan C1 is built and checked against.
-->

# Implementation Plan: Documentation and runbook

**Branch**: n/a (folder only; suggested branch feature/documentation-and-runbook) · **Date**: 2026-11-06 ·
**Spec**: [spec.md](spec.md) · **Tasks**: [tasks.md](tasks.md)

## Approach

1. **Describe what is built, not the plan.** Every command, option, setting and file name is taken from the
   built tree: `node tools/cli.mjs --help` and each command's `--help`, `config/settings/defaults.json`, the
   folder READMEs, the service test plans and the packages' `## Deviations / requests`. Where the build
   deviates from the 000 plan (e.g. `--dry-run` writes nothing, `plan-definitions --setting`), the docs
   follow the build.
2. **One place per topic, links elsewhere.** Root docs explain the suite; service details stay in the
   service folders (`<service>/docs/test-plan.md`), tooling details in `tools/README.md`, configuration in
   `config/README.md`, monitoring in `monitoring/README.md`. Root docs link to them instead of copying.
   Values that may change are named by setting (`LOAD_RATE`) and the printout command
   (`node tools/cli.mjs settings …`), with the signed-off defaults (D11) quoted once in
   `docs/workload-model.md`.
3. **CCE style.** The root README mirrors `cce-step-sla-service` (purpose, facts bar, Quick Start,
   Documentation table, How it works, Testing). Doc titles `# CCE Performance Tests — <Doc>`, numbered `##`
   sections, HTML-comment header first (plan §2.4).
4. **For newcomers.** Each doc defines its terms or links `docs/glossary.md`; lessons are told as "what
   happened → what the suite does about it".
5. **Spec-first.** spec → plan → tasks, then one task per document, ticked when written; verification last.
6. **Static verification from the scratchpad** (plan §12): a throwaway Node script (outside the repository)
   checks links, CLI commands/options, setting names and spec headings; plus the §2.1 generic-name commands,
   `lint-headers --paths`, a secrets grep. Nothing connects anywhere (D14).

## Files

| File | Purpose |
|---|---|
| `specs/005-documentation-and-runbook/spec.md` | This package's spec |
| `specs/005-documentation-and-runbook/plan.md` | This plan |
| `specs/005-documentation-and-runbook/tasks.md` | Task list, ticked |
| `README.md` | Root landing page (CCE style) |
| `CONTRIBUTING.md` | Spec-first workflow, naming, commits/branches, how to add a test type/service/adaptor/end-to-end module, checks |
| `docs/architecture-overview.md` | CCE, write and analytics paths, each service and how it is fed, run lifecycle and k6 clock, feasibility and gaps |
| `docs/test-strategy.md` | Test types, open model, threshold/capacity/breaking point/baseline, warm-up, staircase refine, dropped rule, diagnostics vs verdict, environments, repeats |
| `docs/glossary.md` | Every term a newcomer meets |
| `docs/runbook.md` | Onboarding: setup, run, read, clean up, troubleshoot |
| `docs/workload-model.md` | Events per interval, every load shape, settings and defaults, reserved settings, from UAT/Dev analysis to profile and baseline |
| `docs/conventions.md` | Naming, headers, spec-first, adding a test type / service / adaptor / end-to-end module |
| `docs/known-results-and-lessons.md` | v1 laptop numbers (relative only) and lessons linked to design elements |
| `docs/requirements-checklist.md` | R1..R15 → files, commands, status |
| `docs/open-questions.md` | §14 Q1–Q20, package deviations/requests, DEFERRED tasks |
| `specs/README.md` | Index of every spec folder with status |
| `specs/007-uat-dev-traffic-analysis/spec.md` | Future work: what to extract from UAT/Dev and why |
| `specs/007-uat-dev-traffic-analysis/plan.md` | Future work: queries, privacy, workload profile JSON schema, mapping to settings |
| `specs/007-uat-dev-traffic-analysis/tasks.md` | Future work: tasks, all unticked |

## Interfaces

Documents are the interface of this package. What each one guarantees (other packages and the lead link
to these anchors by file name, not by section number):

| Document | Title | Sections (numbered) | Implements |
|---|---|---|---|
| `README.md` | `# CCE Performance Tests` | purpose, facts bar, Quick Start, Documentation, How it works, Testing, Repository layout | 000 §1, R5, R6 |
| `docs/architecture-overview.md` | `# CCE Performance Tests — Architecture Overview` | 1 What CCE is · 2 Write path and analytics path · 3 Each service and how it is fed · 4 How this suite is built · 5 One run, step by step (k6 clock) · 6 Feasibility and gaps · 7 Later modules | 000 §0, §6.2–§6.4, §10.3, R12 |
| `docs/test-strategy.md` | `… — Test Strategy` | 1 Goals · 2 Test types · 3 Open load model · 4 Threshold, capacity, breaking point, baseline · 5 Warm-up · 6 Breakpoints · 7 Dropped iterations and the k6 limit · 8 Verdict vs diagnostics · 9 Data correctness · 10 Plan definitions · 11 Environments · 12 Repeat runs and baselines · 13 Not covered yet | 000 §4.2, §6.9, §8, D9, D11 |
| `docs/glossary.md` | `… — Glossary` | alphabetical groups | 000 §1.1 |
| `docs/runbook.md` | `… — Runbook` | 1 Prerequisites … 14 Troubleshooting | 000 §3, §5, §6.1, §7, §8, §9, R6 |
| `docs/workload-model.md` | `… — Workload Model` | 1 Events per interval … 9 From UAT/Dev traffic to profile and baseline | 000 §3.2, §3.3, §4.1, §4.3, R9 |
| `docs/conventions.md` | `… — Conventions` | 1 Naming · 2 In code · 3 Test-data ids · 4 Header comments · 5 Specs · 6 Git · 7 Adding things · 8 Generic-name check | 000 §2, §1.2, §10.4, R4, R5, R11, R13 |
| `docs/known-results-and-lessons.md` | `… — Known Results and Lessons` | 1 How to read · 2 v1 numbers · 3 Corrections · 4 Lessons → design | prompt set §2.2–§2.3 |
| `docs/requirements-checklist.md` | `… — Requirements Checklist` | one row per R | 000 spec §7 |
| `docs/open-questions.md` | `… — Open Questions` | 1 Blueprint Q1–Q20 · 2 Package deviations/requests · 3 Deferred tasks | 000 §14, §1.2 |
| `specs/README.md` | `# Specs` | index table, headings rule | 000 §1.2 |

Facts every document states the same way (single wording to avoid contradictions):
- Exit codes: `0` passed/done · `1` failed or aborted · `2` refused · `3` tool error (`tools/README.md`).
- Results folder: `results/<subject>-<test-type>-<yyyymmdd-hhmmss>/`; `result.json` is the only input of
  reports and baselines.
- Subjects `collector`, `matcher`, `step-sla`; test types `smoke`, `load`, `stress`, `breakpoint`
  (matcher flood and Step SLA storm are their breakpoints).
- Dropped rule `MAX_DROPPED_RATE=0.001` (< 0.1 %, to be confirmed by the team).

## Technical Context

| Item | Value |
|---|---|
| Format | Markdown (not reformatted by Prettier: `.prettierignore` has `**/*.md`), HTML-comment header |
| Diagrams | ASCII (renders everywhere, as in CCE's READMEs) |
| Checks | Scratchpad Node script (links, CLI commands/options, settings, spec headings), plan §2.1 generic-name commands, `node tools/cli.mjs lint-headers --paths …`, secrets grep |
| Constraints | Owned paths only; no state-changing git (D1); no connections (D14); no secrets (D15) |

## Deviations / requests

1. **`docs/README.md` not added**: plan §1.1 does not list one; the root README's Documentation table is
   the docs index.
2. **`archive/README.md` link**: C2 wrote it in parallel; the root README, runbook, lessons, conventions and
   open questions link to it. It existed when C1's link check ran (0 broken links); 000 T032 re-checks.
3. **Workload-profile settings are not added** to `defaults.json` (A2's file): spec 007 names the settings a
   later implementation would need (e.g. a time-compression factor) as `[NEEDS CLARIFICATION]` instead.
4. **Per-service docs are linked, not repeated**: per-test thresholds, data checks and Grafana panels stay
   in `<service>/docs/test-plan.md` (plan §10.2); the runbook links them.
5. **Open requests found while writing** (recorded in `docs/open-questions.md` §2, no change made by C1):
   the adaptor plug-in point `preflightMetric` of plan §10.4 is not implemented (preflight's
   `KEY_METRICS` table is fixed, `tools/preflight/checks/service-metrics.mjs`); a new adaptor needs an entry
   there (A3) until it is.
6. **Cross-package requests still open when C1 checked the code** (read-only, no change made; listed in
   `docs/open-questions.md` §2): B2 #2 duplicate watcher entries in "what broke"
   (`tools/core/result-builder.mjs` skips only `source: 'k6'`); B3 #12 stall detector counts quiet time before
   the load (`tools/core/watchers.mjs` `createStallDetector`); B1 #5 `between` data checks shown with one
   number; ShellCheck never ran (`npm run lint:shell` printed SKIPPED on this machine).
7. **Secret patterns not spelled out** in C1's spec/tasks (they refer to the 000 spec SC-006 grep), so the
   secrets grep over C1's files prints nothing, not even its own description.
8. **Spec 007 proposes, does not create**, `test-data/workload-profiles/` (A1's folder) and a possible
   `traffic-profile` CLI sub-command (A2); both are recorded in spec 007's own `## Deviations / requests`.
