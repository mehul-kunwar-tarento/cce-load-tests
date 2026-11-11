<!--
  What:    Every open question for the owner and the team: the blueprint's questions Q1–Q20, every item the
           work packages recorded under "Deviations / requests" in their plan.md (with what is still open),
           and every task deferred to the owner because it needs a live stack.
  How:     Read before a team review or the first live run. When a question is decided, record the decision
           in the row (and change the setting/file it names); do not delete the row.
  Needs:   Nothing. Sources: specs/000-performance-testing-setup/plan.md §14, the "## Deviations / requests"
           section of every spec folder's plan.md, every "DEFERRED (owner)" task in a tasks.md, and the
           owner's branch action before committing (§3).
  Outputs: Documentation only.
-->

# CCE Performance Tests — Open Questions

> Defaults are in place for every question below, so the suite runs today; each answer changes a setting,
> a file or a procedure named in its row.

Who decides: **Team** = CCE team lead and developers · **Owner** = owner of this suite · **Ops** = whoever runs
the shared environments and CCE's Grafana/Prometheus.

---

## 1. Blueprint questions (Q1–Q20)

| Q | Question | Decides | Current default / state | Where it is recorded |
|---|---|---|---|---|
| Q1 | Confirm `MAX_DROPPED_RATE = 0.001`, the HTTP / matcher / Step SLA thresholds, `WARM_UP_RATE`, `LEVEL_DURATION`, `EXPECTED_HEADROOM = 4` and the real peak (50/s is a design figure) | Team (peak: UAT/Dev data, spec 007) | Defaults in `config/settings/defaults.json`, every unconfirmed one flagged `toBeConfirmed` and printed "TBC" / "to be confirmed" in reports | `defaults.json`; service test plans §4 |
| Q2 | CCE Grafana: enable `--web.enable-remote-write-receiver` on CCE's Prometheus, or a separate perf Prometheus datasource? Add scrape jobs for matcher and Step SLA (deploy-scripts still has the 1.x compliance job)? | Ops + Team | Nothing changed in `deploy-scripts`; laptop stack works; example scrape jobs not applied | `monitoring/cce-grafana-import/README.md`, `prometheus-scrape-jobs.example.yml` |
| Q3 | Test plan-definition namespace on shared Dev/UAT (`PLAN_DEFINITION_VERSION_SUFFIX`, or a `/loadtest/` url) to avoid 400s and clashes with the real eBUZIMA protocol | Team | Writes on dev/uat refused without a suffix or `/loadtest/` url; `allowPlanDefinitionChanges: false` in the templates | [runbook.md](runbook.md) §6 |
| Q4 | Is a `LOADTEST-FACILITY-01` facility row acceptable (removed only by `cleanup --all`)? | Team | Dataset default facility `LOADTEST-FACILITY-01`; per-run cleanup leaves it | `test-data/datasets/ebuzima-emr/dataset.json`, cleanup table 13 |
| Q5 | Temporary `step_instance(matched_event_id)` index during cleanup on shared environments, or a permanent matcher index? | Team | `CLEANUP_TEMP_INDEX=auto`: only where `safety.allowTempIndex` (true locally, false in dev/uat templates); else small batches | `defaults.json`, `config/environments/*.example.json` |
| Q6 | May cleanup run while Debezium CDC is active on Dev/UAT; what is their `max_slot_wal_keep_size`? | Ops | Cleanup batches, checks slots before and every 10 batches, stops below `CLEANUP_MIN_SAFE_WAL_GB` (2 GB) | [runbook.md](runbook.md) §12 |
| Q7 | Enable percentile histograms on the services (deployment env var) so Grafana and the matcher show server-side p95/p99? | Team | Percentiles from k6 only; matcher reports average and max processing time (informational 500 ms candidate) | `cce-matcher-service/docs/test-plan.md` §4 |
| Q8 | Which plan definitions do UAT and production run? (moves the matcher limit most) | Team | Sets `emr-service`, `kenya-sha-emr-service` (one real protocol each; the overlapping sets were removed on 2026-11-11 — should a multi-protocol condition come back once UAT's ACTIVE set is known?) | [test-strategy.md](test-strategy.md) §10 |
| Q9 | Matcher V8 (step groups) timing | Team | Cleanup detects `step_group_instance` columns dynamically; preflight `schema-step-groups` | `tools/cleanup/` |
| Q10 | Step SLA's readiness probe does not cover the database | Team | Preflight uses `/actuator/health` plus the evaluator cycle counter (`step-sla-scheduler`) | [runbook.md](runbook.md) §7 |
| Q11 | The lead's list has no point 10: confirm nothing was dropped | Team lead | R10 left empty | [requirements-checklist.md](requirements-checklist.md) |
| Q12 | Are Kafka client lag metrics really absent from the matcher's actuator? | Team | Lag read through Kafka admin (kafkajs) and kafka-exporter | [architecture-overview.md](architecture-overview.md) §6 |
| Q13 | When a service folder is copied into its repository as `performance-tests/`: vendor the shared parts (`lib/`, `tools/`, `config/`, `test-data/`) or reference this repository as a git submodule? | Team | Folders self-contained except the two shims (`shared.mjs`, `tests/shared-lib.js`) | [conventions.md](conventions.md) §7.2 |
| Q14 | `config/environments/local.json` targets local-stack (v1 called it `local-machine`); v1's native-ports layout is not carried over. Does anyone still run the services natively? | Owner | `local` = local-stack ports; personal `local.local.json` for other ports | `config/README.md` |
| Q15 | Loading test plan definitions on shared Dev/UAT: even with a version suffix, an ACTIVE test definition has the real triggers and matches real events too. Allowed at all, and under which url namespace? | Team | Refused without team agreement (templates: `allowPlanDefinitionChanges: false`) | [runbook.md](runbook.md) §6 |
| Q16 | Is `STEP_SLA_SEED_MODE=set` the right default, and `STEP_SLA_PEAK_ALARM_RATE = PEAK_RATE × DUE alarms per event` the right alarms peak? | Team | `set`; `auto` (1 DUE alarm per event for both sets → 50/s) | [workload-model.md](workload-model.md) §6 |
| Q17 | Kafka producer VU limits (`KAFKA_PRE_ALLOCATED_VUS` 100 / `KAFKA_MAX_VUS` 500, v1 values): enough for the 2,000/s flood on a separate k6 host? | Owner (first Dev/UAT flood) | v1 values, flagged TBC | [workload-model.md](workload-model.md) §7 |
| Q18 | Disk limits on Dev/UAT: Postgres and Kafka are remote, so `disk.data-stores` only reports DB/WAL/topic sizes there. Who watches their free space, and what thresholds apply? | Ops | Warning only on dev/uat | [runbook.md](runbook.md) §7 |
| Q19 | The first live smoke of each service on the laptop (prompt set phases 4–6) | Owner | `DEFERRED (owner)` tasks (§3) | §3 below |
| Q20 | Workload realism: build `EVENT_MODE=journey` and `WORKLOAD_PROFILE` once the UAT/Dev analysis defines the profile JSON | Team + Owner | Both reserved and refused today | [spec 007](../specs/007-uat-dev-traffic-analysis/spec.md), [workload-model.md](workload-model.md) §9 |

## 2. Package deviations and requests

Every item of every package's `## Deviations / requests`. **Info** = a deliberate difference from the
blueprint, already in the docs (nothing to decide). **Request** = a change asked of another package.
**Question** = needs a decision. Items marked **open** need action.

### 2.1 Shared k6 library and test data (A1, [plan](../specs/001-shared-k6-library-and-test-data/plan.md))

| # | Item | Type | Status |
|---|---|---|---|
| 1 | Extra exports (`toK6Duration`, `vusFor`, `buildIterationEvent`, `assertRunContextFor`, … and `lib/settings-guard.js`) | Info | – |
| 2 | `buildScenarios` also takes `kind`, `kafkaPreAllocatedVus`, `kafkaMaxVus` | Info | – |
| 3 | Per-window `checks{window:i}` summary rule for every k6 test | Info | – |
| 4 | Smoke: the measured-scenario checks rule aborts on failure | Info | – |
| 5 | Storm windows cover `BREAKPOINT_CATCH_UP_LIMIT` | Info | – |
| 6 | Level start times are absolute (since k6 start) | Info | – |
| 7 | `events_accepted` gets `add(0)` on a rejected send | Info | – |
| 8 | Request to A2: `"type": "module"` and `lib/` unit tests in `npm test` | Request | Met |
| 9 | Formatting with A2's Prettier | Info | – |
| 10 | Request to A2: ignore the verbatim `test-data/plan-definitions/` in Prettier | Request | Met (`.prettierignore`) |
| 11 | Overrides list only differing actions; variant version = base `1.0.0` (variants removed on 2026-11-11) | Info | – |
| 12 | Probe findings for the k6 runner/normaliser: `inspect` needs k6's own `-e`; unreached levels report zeros (read `iterations{level}` count 0); failed requests count in `http_req_failed` passes | Info | Applied by A2 |
| 13 | xk6-kafka `produce()` returns without error against a dead broker: "accepted" for Kafka = handed to the producer; delivery proven by the backlog watcher | Question | Design answer in place (watcher + stall detection); confirm at the first live matcher smoke |
| 14 | ShellCheck not available; `bash -n` only | Info | ShellCheck still to run once (`npm run lint:shell` with `shellcheck` or its image) — **open** |

### 2.2 Node tooling core (A2, [plan](../specs/002-node-tooling-core/plan.md))

| # | Item | Type | Status |
|---|---|---|---|
| 1 | Helper modules added (`paths`, `errors`, `command-args`, `lib-bridge`, `run-setup`, `run-clients`, `baseline-metrics`) | Info | – |
| 2 | Command `main` takes optional `deps` for tests | Info | – |
| 3 | `defaults.json` entries may carry `allowAuto`; dataset-derived defaults for `EVENT_ACTION_ID`, `EVENT_SOURCE`, `FACILITY_ID` | Info | – |
| 4 | `load` also records `measuredEventsSent` / `measuredEventsAccepted` | Info | – |
| 5 | Thresholds may be `informational` (never fail a run) | Info | Described in [test-strategy.md](test-strategy.md) §8 |
| 6 | Level offsets computed from cumulative durations | Info | – |
| 7 | **Kafka tests never report a k6 limit** (no latency to prove the service was fast) | Question | Accepted as design; documented in [test-strategy.md](test-strategy.md) §7 — team to confirm |
| 8 | `lint-headers --paths` | Info | – |
| 9 | ShellCheck skipped when neither `shellcheck` nor its image exists locally | Info | **Open**: run ShellCheck once on a machine that has it |
| 10 | Request to A1 (phase fields) | Request | Met |
| 11 | Request to A3 (preflight call shape, conditions from `plan-definition-set` check) | Request | Met |
| 12 | **Staircase verdict = capacity rule** `breakpoint.held-up-to`; per-level rules informational | Info | Described in [test-strategy.md](test-strategy.md) §6 |
| 13 | **`--dry-run` writes nothing** (no results folder, placeholder port 6565) | Info | Described in [runbook.md](runbook.md) §8 |
| 14 | `.prettierignore` also ignores verbatim FHIR fixtures | Info | – |
| 15 | `baseline compare` writes `baseline-comparison.json` into each run folder, never rewrites `result.json` | Info | – |
| 16 | Series reports default to `results/summary-<stamp>/` | Info | – |
| 17 | Aborted run exits 1 | Info | – |
| 18 | `check-data` refuses another environment; keeps `aborted`/`error` status | Info | – |
| 19 | Extra result fields (`refinedFrom`, `artifacts.serviceMetrics`, …) | Info | – |
| 20 | Request to B1–B3 (`testFile`, `requires.services`, `evaluate` partial) | Request | Met |
| 21 | Whole-tree `npm test` / `npm run lint` passed at A2's time | Info | Re-checked by 000 T032 |

### 2.3 Preflight, cleanup, plan-definition sets (A3, [plan](../specs/003-preflight-cleanup-and-plan-definition-sets/plan.md))

| # | Item | Type | Status |
|---|---|---|---|
| 1 | Check file names in kebab-case (ids unchanged) | Info | – |
| 2 | `preflight <env>` without `--subject` = stack check (subject-specific checks as warnings) | Info | Described in [runbook.md](runbook.md) §7 |
| 3 | Cleanup finds the run folder via `run-context.json` (aborted runs have no `result.json`) | Info | – |
| 4 | Candidate event ids built locally; could be unified with A2's helper | Info | Possible later cleanup of code |
| 5 | Batch statement shape | Info | – |
| 6 | `step_group_instance` deleted in one statement (self-referencing parent key) | Info | – |
| 7 | Dry run = `BEGIN … ROLLBACK`; delete ends with `DISCARD TEMP` | Info | – |
| 8 | `--print-sql` writes no cleanup JSON | Info | Described in [runbook.md](runbook.md) §12 |
| 9 | **Expected-rows rule** per event (both sets 1,1,1,2,3,2 with 1 due alarm: `emr-service` / `visit-encounter`, `kenya-sha-emr-service` / `consent-request`) | Question | **Open**: verify at the first live smoke (§3) |
| 10 | Exclusive sets fail the overlap rule for every subject | Info | – |
| 11 | Kafka partition count from the group lag; `describeLogDirs` only if available | Info | – |
| 12 | Preflight client bundle; request to A2 for the `runPreflight` call | Request | Met |
| 13 | **`plan-definitions` uses `--setting NAME=value`** for overrides (`--set` names the set) | Info | Described in [runbook.md](runbook.md) §6 |
| 14 | retire/delete leave unmarked definitions untouched (exit 2); a retired url+version blocks `load` | Info | Described in [runbook.md](runbook.md) §6, §14 |
| 15 | Cleanup JSON also saves the cleanup settings | Info | – |
| 16 | Verification still runs after an `incomplete` stop | Info | – |
| 17 | Temp index dropped whenever its creation was attempted | Info | – |
| 18 | Cleanup exit codes 0/1/2/3 | Info | – |
| 19 | `leftover-test-data` DUE probe capped at 10,000 rows | Info | – |
| 20 | Always-required checks have no warn outcome | Info | – |
| 21 | Request to A2: ignore the verbatim v1 variant fixtures in Prettier | Request | Met (fixtures removed with the variants, 2026-11-11) |
| 22 | ShellCheck not run | Info | **Open** (same as 2.1 #14) |

### 2.4 Monitoring and Grafana (A4, [plan](../specs/004-monitoring-and-grafana/plan.md))

| # | Item | Type | Status |
|---|---|---|---|
| 1 | `testid` list filtered by `$service` and `$test_type` | Info | – |
| 2 | **Typed run ids on Grafana 10.4**: the picker may not accept free text; fallback `&var-testid=<runId>` in the URL | Question | **Open**: confirm at the first `up` (A4 T040); documented in [runbook.md](runbook.md) §10 |
| 3 | Two runner-annotation queries (selected run / every run) | Info | – |
| 4 | **Step SLA's due gauge runs a SQL count on every 5 s scrape** on a pool of 3 connections | Question | **Open**: scrape the `cce-step-sla-service` job every 15 s during storms? (observer effect, `monitoring/README.md` §8) |
| 5 | Service panels filtered by job | Info | – |
| 6 | No host-CPU panel (node-exporter CPU not in the allow-list) | Question | Add later if wanted |
| 7 | Formatting with A2's Prettier | Info | – |
| 8 | Monitoring test command uses a glob | Info | – |
| 9 | Extra offline checks with `promtool` | Info | – |
| 10 | Requests: A2 `.gitignore` has `monitoring/.env` (met); A3 `monitoring` check uses `/-/ready` and `/api/health` (met); C1 links `monitoring/README.md` from the runbook and copies items 2 and 4 here | Request | Met |

### 2.5 Documentation (C1, [plan](../specs/005-documentation-and-runbook/plan.md))

| # | Item | Type | Status |
|---|---|---|---|
| 1 | No `docs/README.md`: the root README's Documentation table is the index | Info | – |
| 2 | Links to the archive written while C2 ran in parallel | Info | Resolved: the archive is not shipped (2026-11-11), the links were removed |
| 3 | Workload-profile settings not added to `defaults.json`; spec 007 lists them as `[NEEDS CLARIFICATION]` | Question | Open with Q20 |
| 4 | Per-service thresholds, data checks and panels are linked, not repeated | Info | – |
| 5 | **Adaptor plug-in point `preflightMetric` (plan §10.4) is not implemented**: preflight's `KEY_METRICS` table (`tools/preflight/checks/service-metrics.mjs`) is fixed | Request to A3 | **Open**: until done, a new adaptor adds its entry there ([conventions.md](conventions.md) §7.3) |
| 6 | Cross-package requests found still open in the code: 2.8 #2, 2.9 #12, 2.7 #5, ShellCheck never run | Info | Tracked in those rows |
| 7 | Secret patterns are not spelled out in C1's spec, so the secrets grep over C1's files prints nothing | Info | – |
| 8 | Spec 007 proposes `test-data/workload-profiles/` and a possible `traffic-profile` sub-command; nothing created | Info | With Q20 |

### 2.6 Archive (C2; not shipped since 2026-11-11)

| # | Item | Type | Status |
|---|---|---|---|
| 1 | The archive (`archive/`) is not part of this branch (decision 2026-11-11): the first version lives on the `ebuzima-flow-tests` branch, but a few v1 files were never committed there (`lib/settings.js`, `lib/settings.sh`, `baseline.sh`, `report-summary.sh`, `lib/report.sh`, `baselines/local-4plans.json`, `step-sla/last-seed.json`) | Question | **Open (owner)**: add them to that branch, or let them go |
| 2 | "Ported from the first version" provenance comments in other packages | Info | Kept as history; the files are on the `ebuzima-flow-tests` branch |
| 3 | `docker/Dockerfile` in the archive is 18 lines, not 6 | Info | – |
| 4 | `step-sla/last-seed.json` deleted with its folder (superseded by `seed.json` per run) | Info | – |
| 5 | No kept file needed a deleted one | Info | – |

### 2.7 Collector tests (B1, [plan](../cce-collector-service/specs/001-collector-performance-tests/plan.md))

| # | Item | Type | Status |
|---|---|---|---|
| 1 | `requires.kafka: true` (needed to read the matcher lag before a run); Kafka checks stay warnings for the collector | Info | – |
| 2 | `evaluate().breaking` carries facts only (no duplicate `whatBroke`) | Info | – |
| 3 | Data checks read `k6-summary.json` themselves | Info | – |
| 4 | "Ended early" detection for the `between` comparison | Info | – |
| 5 | Request to A2: show `between` checks as a range in the report | Request | **Open** (the description carries the upper bound meanwhile) |
| 6 | Candidate-id margin (+1 % + 10 per phase) | Info | – |
| 7 | **On Dev/UAT the matcher lag rarely reaches 0** (real traffic), so the idle wait before collector and matcher runs would time out; a "lag below N" idle rule for shared environments | Question | **Open (team)** |
| 8 | Fixtures generated with the real `lib/` code, checked by a unit test | Info | – |
| 9 | Links to root docs pending until C1 | Info | Resolved |
| 10 | Staging/production profiles use Hikari pools of 15/20 (local 10): laptop pool diagnostics do not transfer one-to-one | Info | Risk in the collector test plan §9 |

### 2.8 Matcher tests (B2, [plan](../cce-matcher-service/specs/001-matcher-performance-tests/plan.md))

| # | Item | Type | Status |
|---|---|---|---|
| 1 | Backlog rule `max <= 1000` ("never above 1,000") | Info | – |
| 2 | Request to A2: failed watcher rules appear twice in "what broke" (the de-duplication skips only `source: 'k6'`) | Request | **Open** (cosmetic: a failed matcher rule is listed twice) |
| 3 | Extra rules `matcher.backlog-watcher` and informational `matcher.processing-time` (500 ms candidate) | Info | Q7 |
| 4 | Still-draining at data-check time downgrades two checks to info, with a hint to re-run `check-data` | Info | – |
| 5 | `matcher.no-dead-letters` reads the DLQ growth measured by the watcher | Info | – |
| 6 | Steps check becomes `at-least` with extra ACTIVE definitions | Info | – |
| 7 | Kafka never reports `k6Limited` | Info | See 2.2 #7 |
| 8 | Own unit-test fixtures | Info | – |
| 9 | `inspect-k6.mjs` writes to `.cache/inspect/` | Info | – |
| 10 | Scenario uses `buildIterationEvent` | Info | – |
| 11 | `waitForIdle` is `waitForMatcherIdle` itself | Info | – |
| 12 | `shared.mjs` re-exports more than the minimum (for unit tests) | Info | – |
| 13 | Empty `EVENT_SOURCE` / `EVENT_ACTION_ID` fall back to the dataset in data checks | Info | – |
| 14 | Links to root docs pending until C1 | Info | Resolved |
| 15 | Watcher `stop()` unit-test correction | Info | – |

### 2.9 Step SLA tests (B3, [plan](../cce-step-sla-service/specs/001-step-sla-performance-tests/plan.md))

| # | Item | Type | Status |
|---|---|---|---|
| 1 | Patient number `n` is 0-based (same schedule) | Info | – |
| 2 | `seed.json` carries extra fields | Info | – |
| 3 | Protocol definition ids looked up inside the seed transaction | Info | – |
| 4 | DataCheck `details` for max-wait / storm checks; `check-data` does not re-run `evaluate` | Info | – |
| 5 | `evaluate` replaces the watcher's `step-sla.caught-up` rule with the database truth | Info | – |
| 6 | Storm `rateAtBreak` is `null` (all at once) | Info | – |
| 7 | `slaCycleCapHits` is an estimate from counters (± one sample); the service log line is exact | Info | – |
| 8 | Storm drain-rate rule informational; verdict = catch-up | Info | [test-strategy.md](test-strategy.md) §6 |
| 9 | Scheduler-alive window = max(`STALL_TIMEOUT`, 3 × poll interval) | Info | – |
| 10 | No k6 shim (no k6 script) | Info | – |
| 11 | Request to C1: say in the runbook that Step SLA runs need the set loaded | Request | Met ([runbook.md](runbook.md) §6) |
| 12 | Request to A2: `createStallDetector` counts quiet time before the load as stalled time (B3 works around it; B2's watcher may be exposed when the first sample after idle already shows lag) | Request | **Open**: suggested fix — reset `lastChangeMs` while backlog ≤ `minBacklog` (`tools/core/watchers.mjs`) |
| 13 | `shared.mjs` re-exports test-only helpers | Info | – |
| 14 | `STALL_MIN_DUE` = 10 exported from the watcher | Info | – |

## 3. Deferred tasks (need a live stack)

The build was verified statically only: nothing connected to a CCE service, Postgres, Kafka, Prometheus or
Grafana. These tasks stay open for the owner; following [runbook.md](runbook.md) on the laptop covers them.

| Task | What to do | What it confirms |
|---|---|---|
| [000](../specs/000-performance-testing-setup/tasks.md) T040 | First live smoke of each service (`scripts/check-services.sh local`, then `scripts/run-test.sh local <subject> smoke`, report shown) | The whole chain; the "verify at first scrape" metric names; the expected rows per event |
| [002](../specs/002-node-tooling-core/tasks.md) T066 | First live run `scripts/run-test.sh local collector smoke` | Runner, k6 clock, result builder on a real run |
| [003](../specs/003-preflight-cleanup-and-plan-definition-sets/tasks.md) T030 | First live `preflight local`, `cleanup local --run-id <id> --dry-run`, `plan-definitions status local --set emr-service`; confirm the expected-rows rule at the first smoke | Preflight checks, cleanup staging, plan-definition status (2.3 #9) |
| [004](../specs/004-monitoring-and-grafana/tasks.md) T040 | First `docker compose -f monitoring/docker-compose.yml up -d`; confirm Tomcat threads, `k6_kafka_writer_*`, `spring_kafka_listener_seconds_*`, `pg_replication_slot_*`, `pg_wal_size_bytes`, cAdvisor `name` labels, a typed `testid` on Grafana 10.4, and one smoke run end to end on the Overview | Dashboards (2.4 #2) |
| [collector](../cce-collector-service/specs/001-collector-performance-tests/tasks.md) T065 | First live smoke `scripts/run-test.sh local collector smoke`, report shown | Collector module |
| [matcher](../cce-matcher-service/specs/001-matcher-performance-tests/tasks.md) T021 | `scripts/check-services.sh local --subject matcher`, `scripts/run-test.sh local matcher smoke`; confirm the expected-rows rule and the processed counter, then make `matcher.steps-created` required | Matcher module, xk6-kafka delivery (2.1 #13) |
| [Step SLA](../cce-step-sla-service/specs/001-step-sla-performance-tests/tasks.md) T024 | `scripts/manage-plan-definitions.sh load local --set emr-service`, then `scripts/run-test.sh local step-sla smoke`, report shown; then cleanup by run id | Step SLA seeding and watcher |

### Owner action before committing the restructure

| Action | Why | How |
|---|---|---|
| **Commit the restructure on a new, generic branch — not on the branch currently checked out.** The working tree is on `ebuzima-flow-tests` (also on `origin`), a name the team lead's point 2 rules out (no EMR name in branch names, [conventions.md](conventions.md) §6). | Generic suite, generic branch names (requirement R2) | By hand (the build ran no git command that changes state): create a branch such as `chore/restructure-performance-tests` from `main`, commit the restructure there, then retire or rename `ebuzima-flow-tests` locally and on `origin` once nothing else needs it |

Future work with every task open (not deferred, not started): [spec 007](../specs/007-uat-dev-traffic-analysis/tasks.md),
the UAT/Dev traffic analysis.
