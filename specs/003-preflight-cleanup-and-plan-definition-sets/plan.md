<!--
  What:    Implementation plan for work package A3 (preflight, verified cleanup, plan-definition sets).
  How:     Read after spec.md. Files lists every file A3 creates; Interfaces lists the exported functions
           other packages (A2 run, B service modules, C1 docs) rely on.
  Needs:   specs/000-performance-testing-setup/plan.md §2.3, §3.1–§3.3, §5.5–§5.7, §6.1, §6.3, §6.8, §7.
  Outputs: The build plan; "Deviations / requests" collects every difference from the 000 plan.
-->

# Implementation Plan: Preflight checks, verified cleanup and plan-definition sets

**Branch**: n/a (folder only) · **Date**: 2026-11-06 · **Spec**: [spec.md](spec.md) · **Tasks**: [tasks.md](tasks.md)

## Approach

1. **Everything injectable.** Every module that talks to Postgres, Kafka, HTTP, Docker or the file system
   receives its clients as parameters. The real clients come from A2's `tools/core/clients/*`, imported
   lazily (dynamic `import()`), so unit tests and the offline modes (`--print-sql`, `validate`, `generate`)
   never open a connection.
2. **Preflight** = a fixed, ordered list of check modules (`tools/preflight/checks/index.mjs`). `runPreflight`
   completes the client bundle (`tools/preflight/clients.mjs`: a key the caller passes is used as given, a
   key left out is built from the environment and closed afterwards), builds one context (environment,
   settings, subjects with their `requires`, a per-run memo so `/actuator/health` is called once), expands
   the per-subject checks (`service-health.<subject>`, `service-metrics.<subject>`), runs each with a timer,
   turns a failure of a *warning* check into `warn`, and derives the status. Without `--subject` it is a
   "stack check": generic checks required, subject-specific checks as warnings for every service defined.
3. **Shared probes** (`tools/preflight/probes.mjs`): replication slots, free disk of the results volume and of
   Docker's data root, DB/WAL/Kafka sizes, and the one minimum-free-disk rule (`MIN_FREE_DISK_GB` vs
   `safety.minFreeDiskGb`). Used by the `disk.*`/`wal-and-slots` checks **and** by the cleanup guards and the
   every-10-batches check, so both apply the same rule.
4. **Cleanup** follows plan §7.2: pure SQL builders in `cleanup-tables.mjs` (values validated and inlined, so
   `--print-sql` output runs as printed), guards in `cleanup-guards.mjs`, orchestration in `cleanup.mjs` on ONE
   dedicated client. A batch statement deletes from the staged list and from the base table in one
   data-modifying CTE and returns both counts; the loop ends when the staged list is empty.
5. **Plan definitions**: pure helpers (`variants`, `validate`, `triggers`, `expected-rows`), set loading and
   the write-safety gate in `sets.mjs`, a small protocol API client, `active.mjs`, an informational ledger.
6. **Overlap check** (preflight `plan-definition-set`): the dataset's event code triples are computed like the
   matcher's `EventCodesExtractor` (top-level fields; coding/code/display/identifier), unioned with the set's
   own trigger rows and the `''` resource-type-only row; one read-only `trigger_index ⋈ protocol_definition`
   query (statement timeout 5 s) finds other ACTIVE definitions with a matching row.

## Files

| File | Purpose |
|---|---|
| `specs/003-preflight-cleanup-and-plan-definition-sets/{spec,plan,tasks}.md` | This spec |
| `tools/preflight/preflight.mjs` | `runPreflight`, `formatPreflightTable`, `preflightStatus` |
| `tools/preflight/clients.mjs` | `completeClients`, `adaptHttp`, `dbFromPool`, `execProgram` (client bundle) |
| `tools/preflight/check-helpers.mjs` | outcome builders, `requires` helpers, memo, DB/Kafka accessors |
| `tools/preflight/probes.mjs` | slots, disk, min-free-disk rule, Docker root dir (shared with cleanup) |
| `tools/preflight/checks/index.mjs` | ordered list of check modules, `CHECK_IDS` |
| `tools/preflight/checks/environment.mjs` | `environment` |
| `tools/preflight/checks/docker.mjs` | `docker` |
| `tools/preflight/checks/service-health.mjs` | `service-health.<subject>` (factory per subject) |
| `tools/preflight/checks/service-metrics.mjs` | `service-metrics.<subject>` (factory per subject) |
| `tools/preflight/checks/postgres.mjs` | `postgres` |
| `tools/preflight/checks/postgres-target.mjs` | `postgres-target` |
| `tools/preflight/checks/schema-step-groups.mjs` | `schema-step-groups` |
| `tools/preflight/checks/kafka.mjs` | `kafka` |
| `tools/preflight/checks/matcher-consumer-group.mjs` | `matcher-consumer-group` |
| `tools/preflight/checks/plan-definition-set.mjs` | `plan-definition-set` incl. overlap query |
| `tools/preflight/checks/disk-results.mjs` | `disk.results` |
| `tools/preflight/checks/disk-data-stores.mjs` | `disk.data-stores` |
| `tools/preflight/checks/wal-and-slots.mjs` | `wal-and-slots` |
| `tools/preflight/checks/autovacuum.mjs` | `autovacuum` |
| `tools/preflight/checks/leftover-test-data.mjs` | `leftover-test-data` |
| `tools/preflight/checks/step-sla-scheduler.mjs` | `step-sla-scheduler` |
| `tools/preflight/checks/monitoring.mjs` | `monitoring` |
| `tools/preflight/unit-tests/{checks,preflight}.spec.mjs`, `fake-clients.mjs` | unit tests + fake stack |
| `tools/cleanup/cleanup-tables.mjs` | 13-table list, selectors, stage/count/batch/verify/restage/activity SQL |
| `tools/cleanup/cleanup-guards.mjs` | guards of §7.2 |
| `tools/cleanup/cleanup.mjs` | `runCleanup`, `printCleanupSql`, `formatCleanupTable`, `findRunFolder`, `planScope`, `cleanupSettingsSnapshot` |
| `tools/cleanup/unit-tests/{cleanup-tables,cleanup-guards,cleanup}.spec.mjs`, `fake-pg.mjs` | unit tests + fake connection |
| `tools/plan-definitions/sets.mjs` | `loadPlanDefinitionSet`, `assertPlanDefinitionWriteAllowed`, `listPlanDefinitionSets`, marker helpers |
| `tools/plan-definitions/variants.mjs` | `applyOverrides` |
| `tools/plan-definitions/validate.mjs` | `validatePlanDefinition`, `validateSet`, `KNOWN_RESOURCE_TYPES` |
| `tools/plan-definitions/triggers.mjs` | `flattenSteps`, `triggerIndexRows`, `extractEventCodes`, `matchTuples`, `mandatorySteps` |
| `tools/plan-definitions/expected-rows.mjs` | `computeExpectedRows`, `directSuccessors` |
| `tools/plan-definitions/protocol-api.mjs` | `createProtocolApi`, `createFetchHttp`, `ProtocolApiError` |
| `tools/plan-definitions/active.mjs` | `getActivePlanDefinitions` |
| `tools/plan-definitions/ledger.mjs` | `.cache/plan-definitions/<env>-ledger.json` append/read |
| `tools/plan-definitions/unit-tests/{variants,validate,sets,expected-rows,protocol-api,triggers}.spec.mjs` | unit tests |
| `tools/plan-definitions/unit-tests/fixtures/v1-variants/{strict,light,lab-focus}.json`, `fixtures/README.md` | verbatim v1 variants |
| `tools/commands/{preflight,cleanup,plan-definitions}.mjs` | CLI commands (§6.1 contract) |
| `tools/commands/unit-tests/{preflight,cleanup,plan-definitions}.spec.mjs` | command tests |
| `tools/commands/unit-tests/fixtures/cleanup/` | README + an aborted run folder (`run-context.json` only) |
| `tools/commands/unit-tests/fixtures/plan-definitions/` | README + environments (local, locked, shared-dev) + a broken set |
| `tools/results/{preflight,cleanup}.schema.json` | JSON Schemas (documentation) of §5.5 / §5.6 |
| `scripts/{check-services,cleanup-test-data,manage-plan-definitions}.sh` | thin entry points (17–20 lines) |

## Interfaces

```js
// tools/preflight/preflight.mjs (§7.1)
export async function runPreflight({ environment, subjects = [], settings, planDefinitionSetName /* default PLAN_DEFINITION_SET */,
  clients = {}, modules = null, modulesRoot, resultsRoot, testDataRoot, now }) → PreflightResult   // §5.5
//   settings: ResolvedSettings (or its .values); modules: [{subject, kind, requires}] (else A2 service registry)
export function formatPreflightTable(result) → string
export function preflightStatus(checks) → 'passed' | 'passed-with-warnings' | 'failed'
// PreflightResult = { schemaVersion '1.0.0', kind 'cce-preflight', environment, subject, subjects, planDefinitionSet,
//   startedAt, endedAt, status, checks: [{id, title, severity, status, detail, durationMs, data}], warnings: ['<id>: <detail>'] }
// plan-definition-set data = { name, fanOut, effectiveFanOut, exclusive, loadTestMarker, planDefinitions[], otherActivePlanDefinitions[] }

// tools/preflight/clients.mjs — what `clients` may hold (a given key wins, null = not available; a missing key is built)
// { http: {request({method,url,body}) → {status, body}} | {getJson, postJson}, scrapeUrl(url) → Map, db: {query(sql, params, {statementTimeoutMs}) → rows},
//   pgPool (adapted to db, never closed here), kafkaAdmin (connected when needed, never disconnected if given),
//   protocolApi, exec(cmd, args) → {code, stdout, stderr}, statfs(path), sleep(ms), env }
export async function completeClients(environment, given, { env }) → { clients, close() }

// tools/cleanup/cleanup-tables.mjs (§7.2)
export const CLEANUP_TABLES, NEVER_TOUCHED, TEMP_INDEX_NAME, SCHEMA_SQL
export function buildSelectors({ runId, all, legacyV1 }) → string[]
export function buildStageSql({ selectors, all, legacyV1, bounds /* {floor, runStart, source, candidates}|null */, schema /* {tables, columns}|null */ }) → string[]
export function buildCountSql(entry) → string
export function buildBatchDeleteSql(entry, { batchSize, lockTimeoutSeconds }) → ['BEGIN', "SET LOCAL lock_timeout = '<ms>ms'", delete, 'COMMIT']
export function buildVerifySql(entry, options) → { snapshotSql, predicateSql }
export function buildRestageSql(entry, options) → string[]; export function buildActivitySql(options, { now, uuidFloorOfLastHour }) → string
// tools/cleanup/cleanup.mjs
export async function runCleanup({ environment, scope: { runId, all, legacyV1 }, mode: 'delete'|'dry-run'|'print-sql', settings,
  clients: { pgPool, withDedicatedClient?, kafkaAdmin?, statfs?, exec?, sleep? }, confirm, resultsRoot, wait, now }) → CleanupResult   // §5.6 + settings, savedTo
export function printCleanupSql({ environment, scope, settings, resultsRoot }) → string
export function formatCleanupTable(result) → string

// tools/plan-definitions (§7.3)
export async function loadPlanDefinitionSet(name, { versionSuffix = '', testDataRoot }) → { name, description, fanOut, exclusive,
  compatibleDatasets, versionSuffix, entries, planDefinitions: [{ file, variant, url, version, canonical, name, title, mandatorySteps, json }] }
export function assertPlanDefinitionWriteAllowed({ environment, set, action }) → void   // throws RefusedError
export function withLoadTestMarker(json) → json; export function hasLoadTestMarker(definition) → boolean
export function applyOverrides(base, overrides) → object
export function validatePlanDefinition(json) → string[]; export function validateSet(set, { dataset, fileExists }) → string[]
export function computeExpectedRows(set, actionId) → { matcher_event_log, protocol_instance, protocol_instance_history,
  step_instance, step_instance_history, step_sla_state_transition, dueAlarms }
export function createProtocolApi(environment, { http }) → { getByUrlVersion, list, get, load, retire, remove }
export async function getActivePlanDefinitions(environment, { protocolApi, pgPool }) → [{ id, url, version, canonical, status, updatedAt, source }]

// Commands (§6.1): export const description, usage; export async function main(argv, io) → exit code
//   preflight <env> [--subject <s>]… [--set NAME=value]… [--json] [--out <file>] [--modules-root <dir>]
//   cleanup <env> (--run-id <id> | --all) [--legacy-v1] [--dry-run] [--print-sql] [--yes] [--wait] [--set …] [--json]
//   plan-definitions validate [--set <name>] | generate --set <name> [--out <dir>] | status|load <env> --set <name>
//                    | retire|delete <env> --set <name> [--yes] | list-active <env>   [--setting NAME=value]…
```

## Technical Context

Node.js 22 ESM, no new dependency (A2's `pg`/`kafkajs` loaded only when real clients are built, lazily).
Tests: `node --test` with fakes (`tools/preflight/unit-tests/fake-clients.mjs`, `tools/cleanup/unit-tests/fake-pg.mjs`,
an in-test fake protocol API); 214 A3 tests. A2 modules used by their §6.3 signatures: `environment.mjs`
(`loadEnvironment`, `serviceConfig`), `errors.mjs`, `command-args.mjs` (`parseCommandArgs`), `settings.mjs`
(`resolveSettings`, `parseSetArgs`), `run-id.mjs` (`validateRunId`, `isDefaultRunId`, `runIdStart`,
`runSelectors`, `uuidV7Floor`), `json-file.mjs` (`readConfigJson`, `readJsonFile`), `format.mjs`
(`formatStamp`), `paths.mjs`, `result-schema.mjs` (`validatePreflight`, `validateCleanup`, tests),
`clients/postgres.mjs` (`createPool`, `queryRows`, `withDedicatedClient`), `clients/kafka-admin.mjs`,
`clients/prometheus-text.mjs` (`scrapeMetrics`), `service-registry.mjs` (preflight when no modules are passed).
Schemas checked against the release-2.0.0 sources: matcher migrations V1–V7 (tables, columns, FKs, partial
index `idx_sslt_due_order`), collector `inbound_event_log`, protocol-service controller and
`ProtocolDefinitionDto` (by-url-version, list Page, `/{id}/retire`, DELETE, `definition` field).

## Deviations / requests

1. **Check file names**: ids with a dot or a subject placeholder live in kebab-case files: `disk.results` →
   `checks/disk-results.mjs`, `disk.data-stores` → `checks/disk-data-stores.mjs`, `service-health.<subject>` /
   `service-metrics.<subject>` → one factory module each. The ids themselves are exactly those of §7.1.
2. **Stack check without `--subject`**: §7.1 does not say what `preflight <env>` checks with no subject. A3
   runs the generic checks as required and every subject-specific check as a warning, for each service the
   environment defines (collector, matcher, step-sla, protocol). An `exclusive` set only warns there.
3. **Run folder lookup for cleanup**: `findRunFolder` reads `results/*/run-context.json` (newest `startedAt`
   wins) instead of `findResultDirs`, because `findResultDirs` returns only folders with `result.json` and an
   aborted run may have none (A2's `findResultDirByRunId` uses the same idea).
4. **Candidate event ids in cleanup**: built locally (`candidateIdsSql`: `VALUES (phaseIndex, plannedEvents)` ×
   `generate_series`, inlined literals) from the run context's phase plan and `idCode`; same id shape as A2's
   `candidateEventIdsSql` (`<selector><phaseIndex>-<n>-1`). Can be unified later.
5. **Batch statement shape**: `WITH b AS (DELETE FROM lt_x … LIMIT n RETURNING id), d AS (DELETE FROM <table> t
   USING b … RETURNING 1) SELECT count(b), count(d)`; the loop ends when the staged list is empty (one cheap
   empty batch per table confirms it). Framing `BEGIN`, `SET LOCAL lock_timeout`, statement, `COMMIT` as §7.2.
6. **`step_group_instance`** is deleted in ONE statement (no `LIMIT`): its self-referencing parent key would fail
   if a parent and its child landed in different batches ("whole tree per statement", §7.2).
7. **Dry-run** wraps staging and counting in `BEGIN … ROLLBACK`; delete mode ends with `DISCARD TEMP` (pooled
   connections keep TEMP tables after release).
8. **`--print-sql`** writes no cleanup JSON (it would create a results folder from an offline preview); it
   prints the cleanup settings as `--` comment lines first, so the output stays runnable SQL.
9. **Expected-rows rule** (verify at the first smoke, plan §7.3): per plan definition containing the triggered
   action: 1 enrolment (+1 history), 1 step for the action (+2 history rows), +1 step and +1 history row per
   **mandatory** direct successor, +1 `DUE_DATE_REACHED` (+1 `MISSED_DATE_REACHED` with tolerance-days) per
   mandatory successor; `dueAlarms` = DUE rows. Matches the §7.3 numbers for single and overlapping-4.
10. **Exclusive sets**: a set with `exclusive: true` fails the overlap rule for every tested subject (not only
    the matcher), since the set itself declares that other ACTIVE definitions invalidate it.
11. **Kafka partition count** comes from `getGroupLag({groupId, topic}).partitions.length` (A2's admin client has
    no `describeTopic`); `describeLogDirs` is used only if the admin object exposes it (dev/uat topic size).
12. **Preflight client bundle** (`tools/preflight/clients.mjs`): the HTTP client shape is
    `request({method, url, body})` (A2's `getJson`/`postJson` object is adapted); the Prometheus scrape key is
    `scrapeUrl(url)`, deliberately not `scrape(subject)` of the §6.4 run ctx; a given `pgPool` is wrapped with
    `queryRows` (statement timeout) and never ended; a given `kafkaAdmin` is connected (idempotent) but never
    disconnected. **Request to A2 (`run-test.mjs`)**: call `runPreflight({ environment, subjects:[subject],
    settings, planDefinitionSetName, clients: { pgPool, kafkaAdmin } })` (or with no clients: preflight then
    builds and closes its own); take `otherActivePlanDefinitions`/`effectiveFanOut` for `captureConditions`
    `otherMatches` from the `plan-definition-set` check's `data`.
13. **`plan-definitions` options**: `--set <name>` is the set name (§6.1 synopsis), so setting overrides use
    `--setting NAME=value` (environment variables work as everywhere).
14. **retire/delete with unmarked definitions**: the set's marked definitions are processed, unmarked ones are
    listed "left untouched" with the manual way, and the exit code is 2. A retired url+version blocks `load`
    (exit 2, "use a new PLAN_DEFINITION_VERSION_SUFFIX"). `retire` also waits `PROTOCOL_REFRESH_WAIT`.
15. **Cleanup JSON additions**: `settings` (`{NAME: {value, source}}` of the CLEANUP_*, MIN_FREE_DISK_GB, IDLE_*,
    EVENT_SOURCE settings; owner rule "settings saved with results") and, on the returned object only,
    `savedTo`. `tools/results/cleanup.schema.json` documents both.
16. **Verification after a stop**: when the delete loop stops `incomplete` (slot, disk, lock timeouts), the
    read-only verification still runs, so the JSON shows exactly what is left.
17. **Temporary index**: `finally` drops it whenever its creation was *attempted* (a `CREATE INDEX
    CONCURRENTLY` failing half-way leaves an INVALID index); with `CLEANUP_TEMP_INDEX=never` or
    `safety.allowTempIndex: false`, `matcher_event_log` uses batches of 500.
18. **Exit codes of `cleanup`**: verified / dry-run / print-sql 0, incomplete 1, refused 2, error 3. Commands
    throw `UsageError`/`RefusedError` and `tools/cli.mjs` maps them to 2 (unit tests assert the error types).
19. **leftover-test-data** DUE probe: unprocessed LOADTEST transitions with `process_by <= now() + 24 h`
    (overdue ones included) through the partial index `idx_sslt_due_order`, joined to step/protocol instance,
    capped at 10,000 rows ("≥ 10,000").
20. **Warn coverage** (SC-003): always-required checks (`environment`, `service-health.*`, `postgres`,
    `postgres-target`, `disk.results`) have no warn outcome; their tests pin that a failure is never downgraded.
21. **Request to A2 (`.prettierignore`)**: add `tools/plan-definitions/unit-tests/fixtures/v1-variants/` (or
    `**/fixtures/**/*.json`): the three verbatim v1 copies must stay byte-identical to the archive, but
    `prettier --check .` flags them and `npm run format` would rewrite them. Every other A3 file is formatted.
22. **ShellCheck** was not run (no local `shellcheck`, the `koalaman/shellcheck` image is not pulled and the
    build pulls nothing); the scripts pass `bash -n`. A2's `npm run lint:shell` covers them later.
