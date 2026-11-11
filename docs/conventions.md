<!--
  What:    The rules every file, name, id, spec and commit in this repository follows, and the step lists
           for adding a test type, a service, an adaptor module or the end-to-end module.
  How:     Read before adding or renaming anything. CONTRIBUTING.md is the short version for contributors;
           this document holds the full rules.
  Needs:   Nothing. Sources: specs/000-performance-testing-setup/plan.md §1.2, §2, §6.4, §10 and the prompt
           set's 02-naming-conventions.md.
  Outputs: Documentation only.
-->

# CCE Performance Tests — Conventions

> One name per thing, the same everywhere, readable by someone in testing or in development who has
> never seen this repository.

The conventions mirror the CCE development repositories (for example `cce-step-sla-service` on
`release-2.0.0`: `README.md` with a facts bar, `docs/` with numbered-section documents, kebab-case names).
Where this document and the build contract
([specs/000-performance-testing-setup/plan.md](../specs/000-performance-testing-setup/plan.md) §2) differ,
the contract wins and this document is corrected.

---

## 1. Naming files and folders

| What | Rule | Examples |
|---|---|---|
| Folders | lowercase kebab-case, full words, no abbreviations | `test-data/`, `plan-definition-sets/`, `unit-tests/` |
| Service folders | exactly the service repository name | `cce-collector-service/`, `cce-matcher-service/`, `cce-step-sla-service/` |
| k6 test scripts | `<subject>-<test-type>.test.js` | `collector-load.test.js`, `matcher-breakpoint.test.js` |
| Node test definitions (Step SLA, no k6) | `<subject>-<test-type>.test.mjs` | `step-sla-load.test.mjs`, `step-sla-breakpoint.test.mjs` (the storm) |
| Shared k6 modules | kebab-case noun, `.js` | `lib/kafka-client.js`, `lib/thresholds.js` |
| Node modules | kebab-case noun, `.mjs` | `tools/core/result-builder.mjs` |
| Node unit tests | `<module>.spec.mjs` in a `unit-tests/` folder, fixtures in `unit-tests/fixtures/` | `tools/core/unit-tests/settings.spec.mjs` |
| Shell scripts | kebab-case, **verb first**, thin (all logic in Node) | `run-test.sh`, `check-services.sh`, `cleanup-test-data.sh` |
| Environment files | `config/environments/<env>.json`; personal overrides `<env>.local.json` (git-ignored) | `local.json`, `dev.json`, `uat.json` |
| Root docs | uppercase | `README.md`, `CONTRIBUTING.md` |
| Other docs | kebab-case | `docs/runbook.md`, `cce-matcher-service/docs/test-plan.md` |
| Specs | `specs/NNN-kebab-name/` (numbered folder; never a branch name) | `specs/003-preflight-cleanup-and-plan-definition-sets/` |
| Results | `results/<subject>-<test-type>-<yyyymmdd-hhmmss>/`, git-ignored | `results/matcher-stress-20261105-142233/` |
| Dashboards | `<service>-performance.json`, `cce-performance-overview.json` | `cce-matcher-service-performance.json` |

**Test types** are the standard names `smoke`, `load`, `stress`, `breakpoint` (later `soak`, `spike`).
Service-specific shapes map onto them: the matcher *flood* is the matcher `breakpoint`, the Step SLA
*storm* is the Step SLA `breakpoint`. See [test-strategy.md](test-strategy.md) §2.

**Subjects** are the short service names used in commands, results folders, k6 tags and check ids:

| Service folder | Subject | Id code in test data | Prometheus job | Key in environment JSON |
|---|---|---|---|---|
| `cce-collector-service` | `collector` | `col` | `cce-collector-service` | `services.collector` |
| `cce-matcher-service` | `matcher` | `mat` | `cce-matcher-service` | `services.matcher` |
| `cce-step-sla-service` | `step-sla` | `sla` | `cce-step-sla-service` | `services.stepSla` |
| (protocol, not a test subject) | `protocol` | – | `cce-protocol-service` | `services.protocol` |

Only `tools/core/environment.mjs` (`serviceConfig`) maps a subject to its environment key; nothing else
does it by hand.

## 2. Names in code

| What | Rule | Examples |
|---|---|---|
| Variables | `camelCase` | `plannedEvents`, `measureStart` |
| Functions | `camelCase`, verb first | `sendEvent`, `waitForMatcherIdle`, `buildPhasePlan` |
| Constants | `UPPER_SNAKE_CASE` | `MAX_CLOUD_EVENT_ID_LENGTH`, `PEAK_SIGNALS` |
| Settings and environment variables | `UPPER_SNAKE_CASE`, identical to the setting name | `LOAD_RATE`, `MAX_DROPPED_RATE` |
| JSON keys | `camelCase`, except setting names | `"plannedEvents"`, `"LOAD_RATE"` |
| k6 / Prometheus labels | the names of plan §9.3 | `testid`, `service`, `test_type`, `plan_definition_set`, `environment` |

**Settings are never hard-coded.** Every tunable number lives once in
[config/settings/defaults.json](../config/settings/defaults.json) and code reads it from the resolved
settings (`tools/core/settings.mjs`). k6 never reads settings from environment variables: the runner writes
them into `run-context.json` and k6 loads that file (plan §3.3). A new setting means a new entry in
`defaults.json` (default, type, unit, `appliesTo`, description, `toBeConfirmed`).

**Language rules.** Node.js 22, ES modules (`"type": "module"`), `.mjs` for Node files and `.js` for k6
files. Runtime dependencies are `pg` and `kafkajs` only. Shell scripts are entry points of at most ~30
lines. Reports, baselines and comparisons are built **from JSON only** (`result.json`), never by parsing
text, logs or Markdown.

## 3. Test-data identifiers

Every row a test creates in CCE can be traced to exactly one run (plan §2.3):

| Id | Shape | Example |
|---|---|---|
| Run id (`RUN_ID`) | `yyyymmdd-hhmmss` of the run start, or a custom 1–20 letters/digits (no hyphen, no underscore) | `20261105-142233`, `nightly1` |
| Test-data prefix | `LOADTEST-<runId>-` | `LOADTEST-20261105-142233-` |
| Run selector | `LOADTEST-<runId>-<idCode>-` (always ends with the id code) | `LOADTEST-20261105-142233-mat-` |
| Patient id (CloudEvent `subject`) | `<selector><phaseIndex>-<n>` | `LOADTEST-20261105-142233-mat-1-41` |
| Event id (CloudEvent `id`) | `<patientId>-<stepNumber>`, at most 50 characters (collector limit) | `LOADTEST-20261105-142233-mat-1-41-1` |
| Correlation id | `LOADTEST-<runId>-corr-<n>` | |
| Facility, source | dataset values, default `LOADTEST-FACILITY-01`, `loadtest-emr` | |
| Step SLA seeded patient | `LOADTEST-<runId>-sla-0-<n>` | |

Because the selector ends with the id code, run `test` never matches run `test2`, and cleanup or data checks
of one run can never touch another run's rows. Ids are enumerable from the phase plan, so queries look them
up through unique indexes instead of scanning (plan §6.8). Rows CCE creates itself (enrolments, steps,
alarms, deviations) have time-ordered UUIDv7 ids; queries bound them with the run's start time.

## 4. Header comments and code comments

Every file outside `results/`, `node_modules/` and `.cache/` starts with a header that answers
four questions for someone new to performance testing (plan §2.4, requirement R11):

| Label | Answers |
|---|---|
| `What:` | what the file does, in plain language |
| `How:` | how to run it, or who imports it |
| `Needs:` | settings, environment variables, services, files it depends on |
| `Outputs:` | files written, metrics emitted, return values |

| File type | Where the header goes |
|---|---|
| `.js`, `.mjs` | a `/** … */` block at the top |
| `.sh` | `#` lines right after the shebang |
| `.yml`, `.yaml` | `#` lines |
| `.md` | an HTML comment block `<!-- … -->` (as at the top of this file) |
| Our own `.json` | a first key `"$comment"` holding the four labels; every loader drops it, so it is never a setting and never sent to a CCE service |
| JSON Schema | its native `$comment` |
| `package.json` | the `description` field |
| Grafana dashboards | the dashboard `description` |
| Verbatim fixtures (FHIR plan definitions, captured k6 summaries) | none; their folder README describes them |

Every function gets a JSDoc line saying **why** it exists; every non-obvious line gets a short comment.
Check it with `node tools/cli.mjs lint-headers` (all files) or
`node tools/cli.mjs lint-headers --paths <file or folder>…` (some files); `npm run lint` runs it too.

## 5. Specs (spec-driven work)

Every piece of work starts with a spec folder in the GitHub Spec Kit style, like CCE development: first
`spec.md`, then `plan.md`, then `tasks.md`, then code. The full index is [specs/README.md](../specs/README.md).

| File | Mandatory sections (in this order) |
|---|---|
| `spec.md` | header lines `**Feature Branch**: n/a (folder only; suggested branch feature/<kebab-name>)`, `**Created**`, `**Status**`, `**Input**`; then `## Goal`, `## Scope` (`### In scope`, `### Out of scope`), `## Inputs`, `## Outputs`, `## Acceptance criteria`, `## User Scenarios & Testing`, `## Requirements` (`- **FR-001**: … MUST …`, unknowns as `[NEEDS CLARIFICATION: …]`), `## Success Criteria` (`- **SC-001**: …`) |
| `plan.md` | `## Approach`, `## Files`, `## Interfaces`, `## Technical Context`, `## Deviations / requests` ("none" if none) |
| `tasks.md` | phases Setup → Foundational → user stories → Polish → Verification; one line per task `- [ ] T001 [P] Description with exact file path`, ticked `- [x]` when done |

- A task that cannot be done without a live stack (the build is verified statically only) is written
  `- [ ] T0xx DEFERRED (owner): …`. It stays unticked, does not count against "every task ticked", and is
  listed in [open-questions.md](open-questions.md) §3.
- Anything that differs from the contract, or needs a change in a folder the work does not own, goes into
  **its own** plan.md under `## Deviations / requests` — never into another package's files.
- Numbering of headings (`## 3. Inputs`) is allowed; checks match the heading text.
- Spec folders of a service live inside that service folder (`cce-matcher-service/specs/001-…/`), so they
  travel with it when it is copied into its repository.

## 6. Git

| What | Rule | Examples |
|---|---|---|
| Branches | `feature/…`, `fix/…`, `docs/…`, `chore/…` + kebab-case, **generic** (never an EMR name, never the `NNN-` spec number) | `chore/restructure-performance-tests`, `feature/matcher-soak-test`, `docs/onboarding-runbook` |
| Commits | Conventional Commits `type(scope): summary` | `feat(collector): add breakpoint refine`, `docs(runbook): add cleanup steps`, `fix(cleanup): stop on low safe WAL` |
| Ignored | `results/`, `node_modules/`, `.cache/`, `config/environments/*.local.json`, `monitoring/.env` | |

Never commit a secret. Passwords and tokens (`DB_PASSWORD`, `GRAFANA_ADMIN_PASSWORD`, `GRAFANA_API_TOKEN`)
exist only as environment variables.

## 7. Adding things

### 7.1 A test type (e.g. `soak`)

1. Write a spec folder for it (in the service folder if only one service gets it).
2. Settings: add `<TYPE>_RATE`, `<TYPE>_DURATION` and `<TYPE>_EVENTS` entries for the new type to
   `config/settings/defaults.json` (with `toBeConfirmed` where the value is a guess) and the
   events → duration derivation to `tools/core/settings.mjs`.
3. Phases: teach `lib/phase-plan.js` the new type (warm-up? constant or ramping?) and add its thresholds in
   `lib/thresholds.js`; add unit tests in `lib/unit-tests/`.
4. Per service: add `tests/<subject>-soak.test.js` (k6) or `tests/<subject>-soak.test.mjs` (Step SLA),
   list `soak` in the module's `testTypes`, and describe it in the service's `docs/test-plan.md` §3.
5. Run `npm test`, `npm run lint`, `npm run check:k6` and `scripts/run-test.sh local <subject> soak --dry-run`.

### 7.2 A service

1. Create a folder named exactly after the service repository, with the layout of plan §10.1:
   `README.md`, `service-module.mjs`, `shared.mjs`, `docs/test-plan.md`, `docs/test-strategy.md`,
   `specs/001-<subject>-performance-tests/`, `tests/` (+ `tests/shared-lib.js` for k6),
   `data-checks/`, optional `watchers/` or `seeding/`, `unit-tests/`.
2. `service-module.mjs` exports the module contract of [tools/README.md](../tools/README.md)
   ("How a service module plugs in"): `service`, `subject`, `idCode`, `kind` (`k6` or `seeded`),
   `breakpointKind`, `testTypes`, `requires`, `testFile`, `expectation`, optional `waitForIdle`, `prepare`,
   `watchers`, then `sampledMetrics`, `dataChecks`, `evaluate`, `baselineMetrics`.
3. **The two shims.** Only `shared.mjs` may import `../tools/core/…` and `../lib/…`; only
   `tests/shared-lib.js` may import `../../lib/…`. Every other file in the folder imports those two. Copy an
   existing `unit-tests/import-boundary.spec.mjs` to enforce it. When the folder is copied into its
   repository as `performance-tests/`, only these two files change.
4. **Module-relative `testFile`.** Return `new URL('./tests/<subject>-<type>.test.js', import.meta.url)`, never
   a path built from the repository root, so the folder works wherever it is copied; the runner maps the URL
   to the container path `/tests/…`.
5. Add the environment key (`services.<key>` in `config/environments/*.json` and the schema), the service's
   health/key metric in preflight (`tools/preflight/checks/service-metrics.mjs` `KEY_METRICS`), a scrape job
   in `monitoring/prometheus/prometheus.yml` and a dashboard.
6. The registry (`tools/core/service-registry.mjs`) finds the folder by itself: no change to `tools/cli.mjs`.

### 7.3 An adaptor module (OpenHIM, Tiberbu — later, independent)

An adaptor is a service with an HTTP front door, so it plugs in like the collector:

1. Folder named after the adaptor repository (e.g. `openhim-cce-emitter-adaptor/`, `tiberbu-adaptor/`) with
   the layout of §7.2, `kind: 'k6'`, `breakpointKind: 'staircase'`, `requires.services: ['<adaptor key>']`.
2. Its address in an `adaptors.<key>` block of its environment files (the schema already allows it; no
   in-scope code reads it).
3. Its own dataset in `test-data/datasets/<name>/` when its EMR payload differs (the adaptor receives FHIR,
   not CloudEvents).
4. Today preflight's key-metric table is fixed (`KEY_METRICS`); add the adaptor's entry there until the
   plan's data-driven `preflightMetric` exists (open question in [open-questions.md](open-questions.md) §2).
5. Reference: the first version's OpenHIM test `adaptor/openhim.js` on the `ebuzima-flow-tests` branch of this repository.
   Nothing in the three service folders or the shared code may
   import or require an adaptor (requirement R4).

### 7.4 The end-to-end module (later)

1. Folder `end-to-end-flow/` with a `service-module.mjs` (`subject: 'end-to-end'`).
2. Journeys from the dataset (`EVENT_MODE=journey`, reserved today): events per patient come from the
   dataset journeys, not a constant.
3. Data checks ported from the archived `flow.sh` stage SQL; rule: event → enrolment p95 < 10 s.
4. The series report's "whole flow" section then uses its result instead of the weakest-link estimate.

### 7.5 A dataset, plan definition or plan-definition set

See [test-data/README.md](../test-data/README.md). Validate offline with
`node tools/cli.mjs plan-definitions validate --set <name>`. Name a set after its **protocol** (the plan
definition file without `-protocol`, e.g. `emr-service`, `kenya-sha-emr-service`), never after its EMR (§8);
the EMR name belongs to the dataset (`ebuzima-emr`, `tiberbu-emr`).

## 8. The generic-name check

"eBUZIMA" is the first EMR whose data the suite uses. It may appear **only** as the dataset name
`ebuzima-emr`, in prose about that dataset, and in history — never inside a generic identifier (folder,
file, setting, function, variable, metric label, CloudEvent `source`, client id, branch name, plan-definition
set name). The same applies to the second EMR, tibERbu: only as the dataset name `tiberbu-emr` and prose
about it. Two commands,
run from the repository root, must print nothing (plan §2.1):

```bash
# 1. names: only the dataset folder may carry the word
find . \( -path ./archive -o -path ./results -o -path ./node_modules -o -path ./.cache -o -path ./.git \) -prune \
  -o -iname '*ebuzima*' -print | grep -v '^./test-data/datasets/ebuzima-emr$'
# 2. content outside the allowed places, ignoring the dataset value itself
grep -rIn -i ebuzima . --exclude-dir={archive,results,node_modules,.cache,.git,test-data,specs} \
  --exclude='*.md' --exclude-dir=fixtures | grep -v 'ebuzima-emr'
```
