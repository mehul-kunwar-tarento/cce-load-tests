<!--
  What:    Feature specification for restructuring cce-load-tests into a general CCE performance
           testing setup (the blueprint every other spec in this repository builds on).
  How:     Read it top to bottom. plan.md (same folder) says HOW; tasks.md lists the work packages.
  Needs:   Nothing. Background: archive/v1/README.md, archive/v1/docs/TEST-PLAN.md (signed off 30 Oct).
  Outputs: The requirements R1..R15, the owner decisions D1..D20 and the acceptance criteria that the
           work packages are checked against.
-->

# Feature Specification: CCE performance testing setup (restructure)

**Feature Branch**: n/a (folder only; no git operations are done by the build: the owner commits by hand,
on a generic branch such as `chore/restructure-performance-tests`)
**Created**: 2026-11-05
**Status**: Approved for build (owner decisions recorded 2026-11-05; revised 2026-11-06 after blueprint review)
**Input**: Team lead's review of the first version (`archive/v1`, 15 points) plus the owner's decisions.
**Contract**: `plan.md` in this folder. Section references (plan.md §N) below point to it.

## 1. Goal

Turn the first, laptop-grown load-test folder (about 2,000 lines of shell around 770 lines of k6, reports
built by grepping Markdown) into a **general, maintainable performance testing setup for CCE**
(Clinical Compliance Engine) that:

- tests the **collector, matcher and Step SLA services on their own**, each fed directly (HTTP, Kafka,
  seeded alarms), with one folder per service named after its repository so each folder can later be
  copied into that repository as `performance-tests/`;
- is **not tied to one EMR or one plan definition**: eBUZIMA is only the first test-data set, and the set
  of ACTIVE plan definitions is a test parameter recorded with every result;
- produces a **concise, JSON-backed report** after every run that someone who was not there can read;
- shows the run in **Grafana** next to the services' own metrics;
- is **safe**: preflight before every run, test data tagged by run ID, verified batched cleanup, never prod;
- is **documented for newcomers** (runbook, glossary, strategy, per-service test plans) and built
  **spec-first** like CCE itself.

## 2. Scope

### 2.1 In scope (this restructure)

| Area | What is delivered |
|---|---|
| Shared k6 library | run context, settings/phase plan, scenario builders (smoke, load, stress, breakpoint with warm-up), thresholds, HTTP and Kafka helpers, generic CloudEvent/FHIR test-data builders, run-ID tagging, `handleSummary` JSON writer |
| Docker image | `cce-load-tests/k6:2.3.0-kafka2.2.0` Dockerfile moved to `docker/k6/` |
| Node.js 22 tooling | one CLI: run a test (preflight first), preflight, cleanup, data checks, report, baselines, plan-definition sets, settings printout |
| Configuration | `config/environments/<env>.json` (no secrets), `config/settings/defaults.json` (single source of all setting definitions and defaults) |
| Test data | event datasets (first: `ebuzima-emr`, built from the archived eBUZIMA EMR builders), plan-definition fixtures and selectable plan-definition sets (`single`, `overlapping-2`, `overlapping-4`) |
| Per-service folders | `cce-collector-service/`, `cce-matcher-service/`, `cce-step-sla-service/`, each with README, test plan, test strategy, specs, tests, data checks (and watchers / seeding where needed) |
| Monitoring | `monitoring/` compose (Prometheus with remote-write receiver + Grafana, provisioned) and dashboards importable into CCE's own Grafana |
| Docs | runbook, overview with both paths, strategy, glossary, workload model, UAT/Dev traffic-analysis spec, conventions, known results and lessons, requirements checklist, open questions |
| Archive | non-scope code (OpenHIM adaptor test, eBUZIMA end-to-end flow) frozen and runnable under `archive/`, in-scope v1 code removed once ported |

### 2.2 Out of scope (later, design kept ready)

- Adaptor modules (OpenHIM, Tiberbu). Nothing built; docs say how an independent module plugs in.
- End-to-end flow automation (event → enrolment p95 < 10 s). The v1 flow stays runnable in `archive/`.
- Soak, spike/backfill and recovery tests; analytics path (Debezium → ClickHouse → insights); matcher
  scaling; CI or scheduled runs.
- Any change to a CCE repository, to `deploy-scripts`, or to the shared stack's configuration.
- Running anything against prod (always refused).

## 3. Inputs

- Owner's prompt set `performance_testing/cce-performance-testing-prompts/` (working rules, naming, background
  and lessons, scope, folder structure, phases, requirements checklist) and the owner decisions D1–D20 (§8).
- The team lead's review points (R1–R15, §7).
- `archive/v1/` (logic to port), `results/` (old run outputs, evidence only), NOTES.md and journal.md.
- CCE source on `release-2.0.0` (read-only): collector, matcher, Step SLA, protocol, common-util, local-stack,
  deploy-scripts (Grafana/Prometheus reference).
- The existing k6 image `cce-load-tests/k6:2.3.0-kafka2.2.0`.

## 4. Outputs

- The new tree of plan.md §1: shared k6 library, Docker image source, test data, Node CLI and tooling,
  configuration, three per-service folders, monitoring stack and dashboards, docs, specs, pruned archive.
- Per run (later, at test time): `results/<subject>-<test-type>-<yyyymmdd-hhmmss>/` with `run-context.json`,
  `preflight.json`, `k6-summary.json`, watcher and sampler JSON, `data-checks.json`, `result.json`, `report.md`
  (plan.md §5); cleanup JSON (§5.6); series `summary.json`/`summary.md`; baselines (§8.3).
- Exit codes of plan.md §5.7.

## 5. Acceptance criteria

1. Every requirement R1–R15 (§7) meets its own **Acceptance** line, checked statically (plan.md §12).
2. Success criteria SC-001–SC-006 (§10) hold.
3. Every spec folder of plan.md §1.2 exists with spec/plan/tasks carrying the mandatory headings; every task
   of every package is ticked except tasks marked `DEFERRED (owner)` (live runs, D14).
4. No state-changing git command was run (D1); nothing connected to a live system (D14).

## 6. Users

| Who | Needs |
|---|---|
| Tester new to performance testing | A runbook to set up and run each test, plain-language reports, a glossary |
| CCE developer | Service-level tests per repository, specs in the CCE style, Grafana panels to diagnose |
| Team lead | One concise report per run and per set of runs: expectation vs result, per service then whole flow |

## 7. Requirements (team lead's review points)

The numbering follows the lead's review, which has no point 10 (R10 is kept free so the numbers match).

### R1 Concise report after each test
- **R1.1** After every run the tool prints and saves (`report.md`, rendered from `result.json`) a concise
  report: service, test type, the configured interval, how many events went through and at what average
  rate (warm-up excluded), pass/fail per threshold (plan.md §8.1).
- **R1.2** Stress and breakpoint reports add how many events went through, **the clock time and seconds
  into the run when the service started breaking**, **what broke** (latency, errors, backlog, k6 limit),
  and the level held / level broken for staircases.
- **R1.3** Every report states the **expectation** (what the service was expected to withstand, e.g.
  1× peak for load, 4× peak for stress) next to the result.
- **R1.4** A series report over several runs gives the same per service, then a **whole-flow** section
  (weakest link today; end-to-end once that module exists).
- **R1.5** Every interval in the report (phase rates, durations or event totals, warm-up, staircase levels,
  watcher interval `WATCH_INTERVAL`, catch-up limits) comes from settings saved with the run (plan.md §3.2, §3.4).
- **Acceptance**: given fixture result JSON files, `report` produces the sections of plan.md §8.1/§8.2 with
  numbers matching the fixtures; no report code reads Markdown, text logs or TSV.

### R2 Multiple plan definitions as a test parameter; generic naming
- **R2.1** `PLAN_DEFINITION_SET=<name>` selects a set from `test-data/plan-definition-sets/`; at least
  `single`, `overlapping-2`, `overlapping-4` exist (overlapping, differing mandatory steps).
- **R2.2** The set name, each plan definition's url/version/canonical/status/id/mandatory steps, and any
  other ACTIVE plan definitions found are saved in every result's `conditions` (plan.md §5.2).
- **R2.3** Tools can validate offline, describe, check status, load and retire the plan definitions of a set
  (delete only the set's own plan definitions once no instance references them; plans outside the set are
  never touched) — plan.md §7.3.
- **R2.4** No generic name (folder, file, setting, branch suggestion, metric label) contains "ebuzima";
  only the dataset and fixture names do.
- **Acceptance**: `plan-definitions validate --set overlapping-4` passes offline; a result fixture shows
  the set recorded; the two generic-name commands of plan.md §2.1 print nothing (only the dataset folder
  `test-data/datasets/ebuzima-emr` and the value `ebuzima-emr` may carry the word outside `test-data/`,
  `specs/`, fixtures, Markdown prose and `archive/`).

### R3 Service-level performance test scripts per repository
- **R3.1** `cce-collector-service/`, `cce-matcher-service/`, `cce-step-sla-service/` each contain the
  smoke, load, stress and breakpoint tests for that service, its data checks and its service module
  (layout: plan.md §10.1).
- **Acceptance**: each folder's tests pass `k6 inspect` (k6 ones) or `node --check` (Node ones) and the
  service module passes its unit tests.

### R4 Adaptors independent and later
- **R4.1** Nothing in the three service folders or the shared code imports or requires an adaptor.
- **R4.2** Docs describe how an adaptor module (OpenHIM, Tiberbu) plugs in later as its own folder with the
  same service-module interface (plan.md §6.4, §10.4).
- **Acceptance**: no in-scope module, environment-file field or preflight item requires an adaptor
  (adaptor modules later add their own `services.<key>` entry); conventions doc has the "add an adaptor" section.

### R5 Folder structure mirroring CCE development repos
- **R5.1** Root and per-service folders follow the CCE repo layout (README with facts bar and
  Documentation table, `docs/` with numbered-section documents, kebab-case names).
- **Acceptance**: the tree matches plan.md §1; names follow plan.md §2.

### R6 Performance-testing docs and onboarding runbook
- **R6.1** `docs/runbook.md` covers prerequisites, Docker image, configuring an environment, running each
  test, reading results and Grafana, cleanup, troubleshooting (built from the lessons).
- **R6.2** `docs/glossary.md`, `docs/architecture-overview.md`, `docs/test-strategy.md`,
  `docs/workload-model.md`, `docs/conventions.md`, `docs/known-results-and-lessons.md`,
  `docs/requirements-checklist.md`, `docs/open-questions.md` exist.
- **Acceptance**: every command in the runbook exists in the CLI (checked against `node tools/cli.mjs --help`).

### R7 Test plan and strategy per service, inside the service folder
- **R7.1** `<service>/docs/test-plan.md` and `<service>/docs/test-strategy.md` per service, covering what is
  tested, how it is fed and measured, test types with defaults, thresholds and expectations (marked "to be
  confirmed from UAT/Dev data" where unknown), data checks, Grafana panels, plan-definition variations, risks
  (section list: plan.md §10.2).
- **Acceptance**: each of the three service folders has both documents with every section of plan.md §10.2,
  and every default quoted in them matches `config/settings/defaults.json`.

### R8 Grafana integration
- **R8.1** k6 sends metrics by Prometheus remote write, tagged `testid`, `service`, `test_type`,
  `plan_definition_set`, `environment`.
- **R8.2** `monitoring/` brings up Prometheus (remote-write receiver, scraping the services' actuator) and
  Grafana with provisioned datasource and dashboards on a laptop.
- **R8.3** The same dashboard JSON imports into CCE's existing Grafana (`${DS_PROMETHEUS}` variable);
  prerequisites (remote-write receiver, scrape jobs for matcher/Step SLA) are documented, not applied.
- **Acceptance**: dashboard JSON validates (unit test), compose file passes `docker compose config`
  (no `up`), every panel query uses only metric names in the allow-list of plan.md §9.4.

### R9 Events per interval set by the tester; baseline from UAT/Dev
- **R9.1** Rate + duration, or rate + total events (`<TYPE>_EVENTS`), per test type, without editing code.
- **R9.2** `specs/007-uat-dev-traffic-analysis/` specifies how to extract events/s, peak, burst shape,
  event-type mix and events per patient from UAT/Dev and turn them into a workload profile.
- **Acceptance**: `node tools/cli.mjs settings local collector load --set LOAD_EVENTS=1000` prints
  `LOAD_DURATION` = 20s (source `derived`) at 50/s (plan.md §3.3). Checked by B1 and the wave-B integration
  task T023 (the collector module exists only then); in wave A, A2 proves the same with the stub module
  (`--modules-root tools/core/unit-tests/fixtures`, subject `stub`) and a unit test.

### R10 (no point 10 in the review)

### R11 Header comments and code comments
- **R11.1** Every file starts with a header comment (what it does, how to run it, what it needs, what it
  outputs); every function and every non-obvious line has a short "why" comment; written for newcomers.
- **R11.2** JSON files we author carry the header as a first `"$comment"` key (ignored by readers, never
  sent to a CCE service); Grafana dashboards use their `description` field; `package.json` its
  `description`; verbatim fixtures (plan definitions, captured k6 samples) are described in their folder
  README instead (plan.md §2.4).
- **Acceptance**: `node tools/cli.mjs lint-headers` (`tools/core/header-check.mjs`, plan.md §2.4) finds a header in
  every file in the scope listed in plan.md §2.4 (outside `archive/`, `node_modules/`, `results/`, `.cache/`).

### R12 Collector, matcher, Step SLA now; adaptors later
- **R12.1** Feasibility is confirmed in docs: collector fed by HTTP, matcher by Kafka (xk6-kafka), Step SLA
  by seeded alarms in Postgres. Gaps recorded: shared global counters (run one test at a time), matcher
  consumer-lag metrics not exported (Kafka admin used instead), no server-side latency histograms (plan.md §10.3).
- **Acceptance**: `docs/architecture-overview.md` and each service test plan state how the service is fed and the
  gaps above; no service test needs an adaptor running.

### R13 Spec-driven sub-tasks like CCE development
- **R13.1** Every work package starts with its own `specs/NNN-name/{spec,plan,tasks}.md` (Spec Kit style;
  tasks `- [ ] T001 …` ticked `- [x]` when done) before code. Service packages keep their specs inside the
  service folder.
- **R13.2** spec.md carries the owner's sections Goal, Scope (in/out), Inputs, Outputs, Acceptance criteria
  before the Spec Kit sections; plan.md carries Approach, Files, Interfaces (plan.md §1.2). Branch names follow
  `02-naming-conventions.md` (`feature/…`, `chore/…`), never `NNN-name`.
- **Acceptance**: every spec folder listed in plan.md §1.2 exists with the three files and the mandatory
  headings; every `tasks.md` task of a finished package is ticked except `DEFERRED (owner)` tasks (live runs
  that the static-only build cannot do, listed in `docs/open-questions.md`); `specs/README.md` indexes them.

### R14 Cleanup verified before and after
- **R14.1** Cleanup by run ID or all test data, batched, with a dry-run, a disk/WAL/replication-slot check,
  and a refusal while services are still processing; it lists **every table** cleaned with before and
  after counts (after must be 0) and saves them as JSON with the results (plan.md §5.6, §7.2).
- **Acceptance**: `cleanup local --run-id 20261105-142233 --print-sql` prints the stage, count, batched delete
  and verify SQL for all 13 tables of plan.md §7.2 without connecting; unit tests with a fake pg client show
  `refused` when the guards fail, `incomplete` when a slot turns `lost` mid-way, and `verified` only when every
  `after` is 0.

### R15 Preflight before every run
- **R15.1** Before every run: services healthy (actuator health), Postgres and Kafka reachable, topic and
  consumer group present, expected database, plan-definition set ACTIVE, disk and WAL headroom, monitoring
  reachable; pass/fail/warn per item; a required failure stops the run. Separate from the smoke test
  (plan.md §5.5, §7.1).
- **Acceptance**: unit tests with injected fake clients cover every check id of plan.md §7.1 (pass, fail, warn),
  `run` exits 2 on a required failure, and `preflight.json` validates against `validatePreflight`.

## 8. Owner decisions (binding)

| ID | Decision |
|---|---|
| D1 | Restructure **in place** in `cce-load-tests`. **No state-changing git commands** (no add/commit/checkout/branch/stash/mv/rm). Read-only git (log/show/diff/rev-parse/status) is fine. |
| D2 | Spec format: GitHub Spec Kit style, `specs/NNN-kebab-name/{spec.md,plan.md,tasks.md}`; spec.md has goal, scope, inputs, outputs, acceptance criteria (then Spec Kit user stories/FR/SC); plan.md has approach, files, interfaces; tasks.md checkbox sub-tasks; spec → tasks → code (plan.md §1.2). |
| D3 | Helper language Node.js 22 (ESM), minimal dependencies (`pg`, `kafkajs`); shell only as thin entry points. Reports, baselines, comparisons from JSON only. |
| D4 | Load generation with k6 only, image `cce-load-tests/k6:2.3.0-kafka2.2.0` (k6 2.3.0 + xk6-kafka 2.2.0); open load model (arrival-rate executors). |
| D5 | Per-service folders named after the service repository, self-contained; shared parts at the root. |
| D6 | Grafana: both a laptop `monitoring/` compose and dashboards importable into CCE's Grafana; never modify `deploy-scripts` or any CCE repo. |
| D7 | Non-scope code (OpenHIM adaptor test, eBUZIMA end-to-end flow and their runtime dependencies) frozen in `archive/` with a README. Tiberbu: docs only. |
| D8 | Generic, not eBUZIMA-specific; selectable plan-definition sets recorded with every result. |
| D9 | Dropped iterations: pass while the dropped share is < 0.1 % (`MAX_DROPPED_RATE=0.001`, configurable, "to be confirmed by team"); report the exact count; dropped with low latency → "at least X/s (k6 limit)". |
| D10 | Every setting overridable per run without editing code; printed at start and saved with results; rates as rate + duration or total events. |
| D11 | Defaults from the signed-off plan: PEAK 50/s; smoke 1/s 30 s; load 50/s 10 min; stress 200/s 10 min (expect 4× peak); HTTP breakpoint staircase 200→6400/s with warm-up at the last good level; matcher flood 2000/s 1 min; Step SLA storm 100,000 alarms. Unknown expectations marked "to be confirmed from UAT/Dev data". |
| D12 | Test data tagged `LOADTEST-<runId>-…`; cleanup by run ID or all, batched, dry-run, disk/WAL check, before/after per-table counts as JSON, refuses while services are processing; prod always refused. |
| D13 | Naming per the prompt set's `02-naming-conventions.md`; `.editorconfig`, ESLint and Prettier config. |
| D14 | Verification of this build is **static only** (no traffic, no connections, no `docker compose up`). |
| D15 | No secrets in files; passwords and tokens from environment variables only (`DB_PASSWORD`, `GRAFANA_API_TOKEN`, `GRAFANA_ADMIN_PASSWORD`); never printed or saved in results. |
| D16 | The prompt set's "stop after each phase" rule is overridden for this build: all phases in one go, open questions recorded in `docs/open-questions.md`. |
| D17 | One source of truth for settings: `config/settings/defaults.json`, resolved by Node (`tools/core/settings.mjs`), handed to k6 as `run-context.json` (plan.md §3.3–§3.5). |
| D18 | Results in `results/<service>-<test-type>-<yyyymmdd-hhmmss>/` (git-ignored); old v1 run outputs in `results/` are evidence and are never modified. |
| D19 | Matcher backlog is measured with Kafka admin (consumer-group lag) by a Node watcher, not inferred from a schedule; "not caught up" is recorded as such, never as a catch-up time. |
| D20 | Step SLA seed state goes to the run's results folder, never into the source tree. |

## 9. User Scenarios & Testing

### User Story 1 – Run a service load test and read the result (P1)
A tester runs `scripts/run-test.sh local collector load`. **Given** a healthy local stack, **when** the run
starts, **then** the settings in force are printed, preflight passes, k6 runs warm-up then 10 min at 50/s,
and a concise report says how many events went through, at what average rate, each threshold's result and
the data check "accepted = stored". **Independent test**: `--dry-run` prints settings, phase plan and the
docker command without connecting.

### User Story 2 – Find a breaking point with a chosen plan-definition set (P1)
**Given** `PLAN_DEFINITION_SET=overlapping-4`, **when** the tester runs the matcher breakpoint (flood),
**then** the report shows the drain rate, the time the backlog first exceeded 1,000, whether it caught up
(or the remaining backlog), and the four ACTIVE plan definitions under Conditions.

### User Story 3 – Clean up safely (P1)
**Given** a finished run, **when** the tester runs `scripts/cleanup-test-data.sh local --run-id <id> --dry-run`
then without `--dry-run`, **then** every table is listed with before counts, deletes run in batches with
WAL checks, after counts are all 0 and both are saved as JSON next to the run's results.

### User Story 4 – Compare with a baseline (P2)
**Given** three load runs with the same conditions, **when** `node tools/cli.mjs baseline save local-overlapping-4 <dirs>` and later
`node tools/cli.mjs baseline compare local-overlapping-4 <dir>`, **then** each metric is marked better / worse / same within
tolerance, with warnings for differing conditions.

### User Story 5 – Watch in Grafana (P2)
**Given** `monitoring/` is up, **when** a test runs, **then** the overview dashboard shows k6 rate and
latency next to the service metrics, Kafka lag, DB pool, CPU/memory and disk, with the run marked.

### Edge cases
- Kafka unreachable during a matcher test: k6 produce blocks; the watcher's stall detection aborts and the
  report says "stalled: no progress for 30 s".
- Backlog never clears: result records `caughtUp: false`, `remainingBacklog` and `gaveUpAfterSeconds`, never a fake catch-up time.
- k6 cannot keep up (dropped iterations, p95 under 100 ms): reported as "at least X/s (k6 limit)".
- A breakpoint run aborted mid-flight: data check uses "stored ≥ accepted and ≤ sent".
- Leftover test alarms will ring soon, or autovacuum is running: preflight warns.
- `RUN_ID` too long for the 50-character CloudEvent id: refused at settings time.
- Environment named or marked prod: every command refuses.

## 10. Success Criteria

- **SC-001** Every in-scope test of v1 (collector smoke/load/stress/breakpoint, matcher smoke/load/stress/
  flood, Step SLA smoke/load/stress/storm) exists in the new tree and passes static checks.
- **SC-002** Zero lines of report/baseline code parse Markdown, text or TSV.
- **SC-003** `npm test` (node --test with fixtures/mocks) passes; `npm run lint` passes.
- **SC-004** Every requirement R1..R15 is mapped to files in `docs/requirements-checklist.md`.
- **SC-005** `archive/` holds only the non-scope code and what it needs, with a README; it stays runnable.
- **SC-006** No secret, password or token value in any file (a grep for `cce_pass`, `password":` with a
  value, `cceadmin` returns nothing outside `archive/`).

## 11. Assumptions

- Laptop target is the `openphc-repos/local-stack` compose (ports verified: collector 8093, matcher 8097,
  Step SLA 8099, protocol 8096, Postgres 15433, Kafka 29092 from the host, network `cce-net`).
- Numbers from v1 are laptop numbers, relative only; Dev/UAT give real numbers with k6 on a separate host.
- The 50/s peak is a design figure (cce-data-pipeline docs §7.1), to be replaced from UAT/Dev analysis.

## Clarifications

### Session 2026-11-05
- Q: Where does the restructure happen? → A: in place; v1 moved to `archive/v1` first (D1).
- Q: Helper language? → A: Node.js 22 (D3).
- Q: Grafana: CCE's or our own? → A: both (D6).
- Q: Dropped-iterations rule? → A: < 0.1 %, to be confirmed by the team (D9).
- Q: Stop after each phase? → A: not for this build (D16).

### Session 2026-11-06 (blueprint review)
- Q: How does Node know when k6 started measuring? → A: k6 `setup()` stamps the start; the runner polls the
  k6 REST API live and re-bases on the summary afterwards (plan.md §4.7, §6.3 `k6-clock.mjs`).
- Q: Value types of resolved settings? → A: pinned in plan.md §3.3 (durations in seconds, lists as arrays,
  unset = null); only `tools/core/settings.mjs` derives `*_EVENTS`.
- Q: Can cleanup or plan-definition tooling harm shared data? → A: cleanup uses one dedicated connection,
  run selectors ending in the id code, snapshot + predicate verification; plan-definition writes are gated and
  touch only definitions carrying the load-test marker (plan.md §7.2, §7.3).
- Q: Does the plan-definition set matter for Step SLA? → A: yes, `STEP_SLA_SEED_MODE=set` spreads alarms over
  the set's plan definitions × mandatory steps; Step SLA peaks are in alarms/s (plan.md §3.2, §6.7).
- Q: Live smoke runs (prompt set phases 4–6)? → A: deferred to the owner (`DEFERRED (owner)` tasks), D14.
