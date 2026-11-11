<!--
  What:    Index of every spec folder in this repository (root and per-service), with owner, status and the
           headings rule every spec folder follows.
  How:     Read to find the spec behind a part of the suite, or before starting new work (copy the headings).
  Needs:   Nothing. Rules: specs/000-performance-testing-setup/plan.md §1.2; docs/conventions.md §5.
  Outputs: Documentation only.
-->

# Specs

Every piece of work in this repository is specified before it is built, in the GitHub Spec Kit style used by
CCE development: `spec.md` (what and why) → `plan.md` (how: files, interfaces) → `tasks.md` (checkbox
sub-tasks, ticked when done) → code. Root specs cover the shared parts; each service folder carries its own
specs so they travel with it when the folder is copied into its service repository.

## Index

| Spec folder | What it covers | Owner (work package) | Status |
|---|---|---|---|
| [000-performance-testing-setup](000-performance-testing-setup/spec.md) | The blueprint: requirements R1–R15, owner decisions, the build contract (folder tree, settings, APIs, JSON shapes) | blueprint | Done: T001–T032 ticked, integration checks T014/T023/T032 re-run on 2026-11-06 (see its tasks.md "Status"); first live smoke T040 `DEFERRED (owner)` |
| [001-shared-k6-library-and-test-data](001-shared-k6-library-and-test-data/spec.md) | `lib/` (phase plan, scenarios, thresholds, test-data builders, k6 helpers), `docker/k6/`, `test-data/` | A1 | Implemented, static verification passed |
| [002-node-tooling-core](002-node-tooling-core/spec.md) | `tools/cli.mjs`, `tools/core/`, reports, baselines, `config/`, root config files, `run`/`settings`/`report`/`baseline`/`check-data`/`lint-headers` | A2 | Implemented; first live run `DEFERRED (owner)` |
| [003-preflight-cleanup-and-plan-definition-sets](003-preflight-cleanup-and-plan-definition-sets/spec.md) | `preflight`, `cleanup`, `plan-definitions` commands and modules | A3 | Implemented; first live preflight/cleanup `DEFERRED (owner)` |
| [004-monitoring-and-grafana](004-monitoring-and-grafana/spec.md) | `monitoring/`: laptop Prometheus + Grafana, five dashboards, CCE Grafana import guide | A4 | Implemented; first `up` `DEFERRED (owner)` |
| [005-documentation-and-runbook](005-documentation-and-runbook/spec.md) | Root `README.md`, `CONTRIBUTING.md`, `docs/`, this index, spec 007 | C1 | Implemented (static verification only) |
| 006-archive-finalisation | `archive/`: frozen OpenHIM adaptor test and end-to-end flow, pruning of ported v1 files | C2 | Not shipped: `archive/` is not part of the repository since 2026-11-11 (the first version is on the `ebuzima-flow-tests` branch) |
| [007-uat-dev-traffic-analysis](007-uat-dev-traffic-analysis/spec.md) | How to extract the real event flow from UAT/Dev and turn it into a workload profile and a baseline | C1 | **Future work**: spec, plan and tasks written; every task open |
| [cce-collector-service/specs/001-collector-performance-tests](../cce-collector-service/specs/001-collector-performance-tests/spec.md) | Collector smoke/load/stress/breakpoint (HTTP staircase), data checks, service module | B1 | Implemented; first live smoke `DEFERRED (owner)` |
| [cce-matcher-service/specs/001-matcher-performance-tests](../cce-matcher-service/specs/001-matcher-performance-tests/spec.md) | Matcher smoke/load/stress/breakpoint (flood), backlog watcher, data checks | B2 | Implemented; first live smoke `DEFERRED (owner)` |
| [cce-step-sla-service/specs/001-step-sla-performance-tests](../cce-step-sla-service/specs/001-step-sla-performance-tests/spec.md) | Step SLA seeded smoke/load/stress/breakpoint (storm), alarm watcher, data checks | B3 | Implemented; first live smoke `DEFERRED (owner)` |

"Implemented" means built and verified **statically** (unit tests with fakes, `k6 inspect`, linters, dry
runs): the build never connected to a live stack. Tasks marked `DEFERRED (owner)` need a running CCE stack
and are collected in [docs/open-questions.md](../docs/open-questions.md) §3.

## Headings every spec folder carries

| File | Mandatory headings |
|---|---|
| `spec.md` | `**Feature Branch**: n/a (folder only; suggested branch feature/<kebab-name>)`, `**Created**`, `**Status**`, `**Input**`; `## Goal`, `## Scope` with `### In scope` and `### Out of scope`, `## Inputs`, `## Outputs`, `## Acceptance criteria`, `## User Scenarios & Testing`, `## Requirements`, `## Success Criteria` |
| `plan.md` | `## Approach`, `## Files`, `## Interfaces`, `## Technical Context`, `## Deviations / requests` |
| `tasks.md` | `- [ ] T001 [P] Description with exact file path` lines, phases Setup → Foundational → stories → Polish → Verification; `- [ ] T0xx DEFERRED (owner): …` for live-only tasks |

A leading section number (`## 3. Inputs`) is fine. The blueprint's `plan.md` is organised by numbered
contract sections instead; its mapping is Approach = §0, Files = §1, Interfaces = §3–§9, Deviations = n/a.

**Branch names are never the spec number.** A spec folder is `NNN-kebab-name`; work on it happens on a
generic branch such as `feature/<kebab-name>` or `chore/restructure-performance-tests`
([docs/conventions.md](../docs/conventions.md) §6).

## Starting a new spec

1. Pick the next free number (root: `008-…`; inside a service folder: `002-…`).
2. Copy the headings above; fill `## Goal` to `## Acceptance criteria` first and get them reviewed.
3. Write `plan.md`, then `tasks.md`; code task by task and tick each box when it is done.
4. Record anything that differs from the contract, or needs a change in a folder you do not own, under
   `## Deviations / requests` in your own `plan.md`.
5. Add a row to the index above.
