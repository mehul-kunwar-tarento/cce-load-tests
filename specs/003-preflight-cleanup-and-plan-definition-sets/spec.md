<!--
  What:    Feature specification for work package A3: preflight checks before every run, verified batched
           cleanup of load-test data, and the plan-definition set tooling (validate, generate, status, load,
           retire, delete, list-active).
  How:     Read top to bottom. plan.md (same folder) says how it is built; tasks.md lists the sub-tasks.
  Needs:   specs/000-performance-testing-setup/spec.md (R2, R14, R15, D12) and plan.md (§2.1, §2.3, §3.1,
           §3.2, §3.3, §5.5–§5.7, §6.1, §6.3, §6.8, §7.1–§7.3, §12, §13).
  Outputs: The requirements and acceptance criteria A3 is checked against.
-->

# Feature Specification: Preflight checks, verified cleanup and plan-definition sets

**Feature Branch**: n/a (folder only; suggested branch feature/preflight-cleanup-and-plan-definition-sets)
**Created**: 2026-11-06
**Status**: Implemented (static verification only, D14)
**Input**: Team lead's review points R2 (multiple plan definitions as a test parameter), R14 (cleanup verified
before and after), R15 (preflight before every run); owner decision D12; blueprint
`specs/000-performance-testing-setup/plan.md` §7.

## Goal

Make every performance run **safe and repeatable**: before a run, a preflight proves the services, Postgres,
Kafka, the plan-definition set, disk/WAL headroom and monitoring are ready (and says plainly what is not);
after a run, a cleanup removes exactly that run's test data in small batches, checks disk and replication
slots while it goes, and proves with before/after counts per table that nothing was left. The ACTIVE plan
definitions become a test parameter: named sets can be validated offline, generated, checked, loaded and
retired without ever touching plan definitions that do not belong to the set.

## Scope

### In scope
- `tools/preflight/`: `runPreflight()` and one module per check id of plan §7.1, printed table, `preflight.json` shape (§5.5).
- `tools/cleanup/`: table list and SQL builders, guards, `runCleanup()` on one dedicated Postgres client, three
  modes (`--print-sql`, `--dry-run`, delete), snapshot + predicate verification, cleanup JSON (§5.6).
- `tools/plan-definitions/`: set loading (with version suffix), variant generation from overrides, offline
  validation (copy of the protocol-service load rules), expected rows per event, protocol API client, ACTIVE
  plan definitions (API with DB fallback), write safety and the load-test marker.
- Commands `preflight`, `cleanup`, `plan-definitions` (plan §6.1 synopses) and their thin shell scripts.
- JSON Schemas `tools/results/preflight.schema.json` and `tools/results/cleanup.schema.json`.
- Unit tests with fake Postgres/Kafka/HTTP clients for all of the above.

### Out of scope
- Running any of this against a live stack (D14): first live use is the owner's (`DEFERRED (owner)` task).
- The `run` command, settings resolution, environment loading, clients, run ids, result validation (A2).
- Plan-definition fixtures, overrides and set files (A1); service modules and their `requires` (B1–B3).
- Adaptor plan definitions, adaptor preflight items (R4: adaptor modules add their own later).
- Retiring "other" ACTIVE plan definitions (v1 `--retire-others` is deliberately not carried over).

## Inputs

- Environment (`config/environments/<env>.json`) loaded by A2 `loadEnvironment`; service URLs only through
  `serviceConfig(environment, subject)`.
- Resolved settings (A2 `resolveSettings`; cleanup and plan-definitions resolve with `{ environment }` only):
  `PLAN_DEFINITION_SET`, `DATASET`, `EVENT_SOURCE`, `ALLOW_OTHER_ACTIVE_PLAN_DEFINITIONS`, `MONITORING_REQUIRED`,
  `MIN_FREE_DISK_GB` (or `safety.minFreeDiskGb`), `CLEANUP_*`, `IDLE_FLAT_DURATION`, `IDLE_TIMEOUT`,
  `PROTOCOL_REFRESH_WAIT`, `PLAN_DEFINITION_VERSION_SUFFIX`.
- Env vars: `DB_PASSWORD` (name from `database.passwordEnvVar`), `GRAFANA_API_TOKEN`, `GRAFANA_ADMIN_PASSWORD`
  (presence only, never printed).
- Service modules' `requires` (plan §6.4), through A2's service registry or passed in by the caller.
- `test-data/plan-definition-sets/<name>/set.json`, `test-data/plan-definitions/**`, `test-data/datasets/<name>/dataset.json` (A1).
- `results/*/run-context.json` (run start, phase plan, event source) for bounded cleanup.

## Outputs

- `preflight.json` (plan §5.5), printed table ✔/✖/!/–; status `passed | passed-with-warnings | failed`.
- Cleanup JSON (plan §5.6) in the run folder as `cleanup-<yyyymmdd-hhmmss>.json` or in
  `results/cleanup-<runId|all>-<yyyymmdd-hhmmss>/cleanup.json`; printed table `order · table · before · deleted · after`.
- `plan-definitions generate` → `.cache/plan-definitions/generated/<set>/<plan-definition id>.json` (or `--out`);
  ledger `.cache/plan-definitions/<env>-ledger.json` for every write.
- Exit codes (plan §5.7): 0 done/passed, 1 a check or verification failed, 2 refused, 3 tool error.

## Acceptance criteria

1. `node tools/cli.mjs cleanup local --run-id 20261105-142233 --print-sql` prints schema detection, guard,
   stage, count, batched delete and verify SQL covering all 13 tables of plan §7.2 without connecting.
2. `node tools/cli.mjs cleanup local --run-id 1103172520 --print-sql` additionally shows the legacy v1 JSONB branch.
3. `node tools/cli.mjs plan-definitions validate --set overlapping-4` passes offline.
4. Unit tests with fake clients cover every check id of plan §7.1 with pass and fail outcomes, and warn
   wherever the check has a warning level or a warning outcome (always-required checks are tested to never be
   downgraded); the plan-definition overlap fails for the matcher and warns for the collector;
   `disk.data-stores` behaves per kind (local: Docker data root; dev/uat: sizes, warning).
5. Unit tests show cleanup `refused` when a guard fails (incl. run-id prefix of another run and dev/uat
   scoped idle), every statement on ONE fake client in order, `BEGIN`/`SET LOCAL`/`COMMIT` per batch,
   `incomplete` when a slot turns `lost` mid-way, `verified` only when every `after` is 0, an orphan written
   mid-cleanup caught by `afterByPredicate`, an INVALID leftover index dropped before create, the temp index
   dropped in `finally`, the legacy branch present only when expected.
6. Unit tests show plan-definition validation incl. negative cases, set loading, expected rows
   (single 1,1,1,2,3,2 / 1 due alarm; overlapping-4 1,4,4,7,11,6 / 3 due alarms) and write safety.
7. Variants generated from A1's overrides deep-equal the archived v1 variants (copied as fixtures).
8. Every file carries the header comment of plan §2.4; `node --check` and `bash -n` pass; scripts ≤ 30 lines.

## User Scenarios & Testing

### User Story 1 - Check the stack before a run (Priority: P1)
**Given** a laptop stack, **when** the tester runs `scripts/check-services.sh local --subject matcher`,
**then** each check prints ✔/✖/!/– with a one-line detail, required failures make the exit code 2, and
warnings (e.g. autovacuum running, leftover test alarms) are listed but do not stop the run.
**Independent test**: `runPreflight` with fake clients returns `failed` when the matcher health is `DOWN`.

### User Story 2 - Clean up one run safely (Priority: P1)
**Given** a finished run `20261105-142233`, **when** the tester runs `cleanup local --run-id 20261105-142233
--dry-run`, then without `--dry-run`, **then** the 13 tables are listed with before counts, rows are deleted
in batches with lock timeouts and WAL/disk checks, every `after` is 0 and the JSON lands next to the run.
**Independent test**: `runCleanup` with a fake client ends `verified` and its statements are in plan order.

### User Story 3 - Choose and manage a plan-definition set (Priority: P1)
**Given** `PLAN_DEFINITION_SET=overlapping-4`, **when** the tester runs `plan-definitions validate --set
overlapping-4`, `status local --set overlapping-4` and `load local --set overlapping-4`, **then** the four
definitions validate offline, status shows each ACTIVE/RETIRED/missing with the marker, load posts the
missing ones with the load-test marker and waits for the matcher refresh.
**Independent test**: validation and generation run with no network.

### User Story 4 - Never harm shared data (Priority: P2)
**Given** a Dev environment with `safety.allowPlanDefinitionChanges: false` or no version suffix, **when**
anyone runs `load`, `retire` or `delete`, **then** it is refused with the reason; a definition without the
load-test marker is never retired or deleted.

### Edge Cases
- Collector `/actuator/health` opens a Kafka AdminClient: health is called once per service, never polled.
- A preflight query times out on a big table: "not measured" warning, never a hang (statement timeout 5 s).
- Another ACTIVE plan definition shares the dataset's triggers: matcher preflight fails (fan-out would be
  wrong) unless `ALLOW_OTHER_ACTIVE_PLAN_DEFINITIONS=true`; `effectiveFanOut` is recorded either way.
- Cleanup interrupted earlier left an INVALID `loadtest_cleanup_matched_event` index: dropped before creating.
- A history row is written for a test step while cleanup runs: found by the orphan predicate and deleted in one extra round.
- A replication slot turns `lost` mid-cleanup: stop with `incomplete`, counts saved.
- Run id `20261105` while `results/` holds `20261105-142233`: refused (prefix of another run id).
- v1 run ids (`1103172520`): legacy JSONB branch, no time bound, printed as a full scan.

## Requirements

### Functional Requirements
- **FR-001**: Preflight MUST run one module per check id of plan §7.1, each `{id, title, appliesTo, severity, run}`.
- **FR-002**: Preflight MUST call each service's `/actuator/health` at most once per run.
- **FR-003**: Required vs warning MUST follow the service modules' `requires` and the settings
  `MONITORING_REQUIRED`, `MIN_FREE_DISK_GB`, `CLEANUP_MIN_SAFE_WAL_GB`, `ALLOW_OTHER_ACTIVE_PLAN_DEFINITIONS`.
- **FR-004**: The plan-definition-set check MUST return `otherActivePlanDefinitions` and `effectiveFanOut` in `data`.
- **FR-005**: Cleanup MUST run on ONE dedicated client, never `pool.query`, with no other DB connection open.
- **FR-006**: Cleanup MUST delete in explicit per-batch transactions with `SET LOCAL lock_timeout`, retry a
  lock timeout at most 5 times, and stop `incomplete` when a slot is lost or disk/WAL headroom runs out.
- **FR-007**: Cleanup MUST verify every table by snapshot and by direct predicate/orphans and report
  `verified` only when every `after` is 0.
- **FR-008**: Cleanup MUST never touch `protocol_definition`, `trigger_index`, `action_definition`,
  `receiver_adaptor`, `destination_adaptor_mapping`, `notification_tracker`; `facility` only with `--all`.
- **FR-009**: Cleanup MUST refuse on prod, `safety.allowCleanup: false`, a wrong database, a run id that is a
  prefix of another run id in `results/`, unprocessed due transitions of the run, a busy matcher (local: lag;
  dev/uat: new rows of this run), low disk, unhealthy slots, or a missing typed `yes`.
- **FR-010**: Plan-definition writes MUST be gated by `safety.allowPlanDefinitionChanges`, refused on dev/uat
  without a version suffix or `/loadtest/` url, marked with the load-test `meta.tag`, and retire/delete MUST
  refuse definitions without the marker or outside the named set.
- **FR-011**: Offline validation MUST implement the protocol-service load rules listed in plan §7.3.
- **FR-012**: Unit tests MUST never connect anywhere and never read `archive/`.

## Success Criteria

- **SC-001**: `npm test` passes for `tools/preflight`, `tools/cleanup`, `tools/plan-definitions` and the three command specs.
- **SC-002**: The three acceptance commands (two `--print-sql`, one `validate`) run offline and exit 0.
- **SC-003**: Every check id of plan §7.1 has pass and fail coverage in unit tests, plus warn coverage
  wherever the check can warn.
- **SC-004**: No secret value in any file; passwords only named, never printed.
