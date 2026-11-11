/**
 * cleanup.mjs — delete one run's test data (or all LOADTEST data) in small, verified batches
 *
 * What:    Lesson 8: one 27M-row delete lost the CDC replication slot and broke analytics for days. This
 *          cleanup therefore works on ONE dedicated Postgres connection (TEMP tables, SET LOCAL and
 *          CREATE INDEX CONCURRENTLY are all per session; no other tool connection is open):
 *            1. guards (not prod, allowed, database, disk, slots, run id unique, not still processing, typed yes);
 *            2. stage the ids to delete into TEMP tables lt_* (+ snapshots lt_*_all), count them ("before");
 *            3. delete child tables first, CLEANUP_BATCH_SIZE rows per explicit transaction with
 *               SET LOCAL lock_timeout (a lock timeout is retried up to 5 times), CLEANUP_PAUSE between
 *               batches, slots and disk re-checked every 10 batches (stop 'incomplete' when unsafe);
 *               a foreign-key violation (23503: a service wrote child rows after staging, e.g. Step SLA
 *               deviations for an alarm that rang mid-cleanup) re-stages and deletes the child tables,
 *               then retries the batch (at most 3 times per table, then 'incomplete');
 *               matcher_event_log uses a temporary index created CONCURRENTLY and always dropped;
 *            4. verify every table twice (staged rows still there; direct predicate / orphans), delete orphans
 *               in one extra round, verify again: status 'verified' only when every `after` is 0;
 *            5. ANALYZE, save the JSON (plan §5.6) next to the run, print the table.
 *          Modes: 'print-sql' (no connection), 'dry-run' (stage + count inside BEGIN … ROLLBACK), 'delete'.
 * How:     await runCleanup({ environment, scope: { runId: '20261105-142233' }, mode: 'dry-run', settings, clients, confirm })
 *          CLI: node tools/cli.mjs cleanup local --run-id 20261105-142233 [--dry-run|--print-sql] [--yes]
 * Needs:   clients.pgPool (+ withDedicatedClient from A2 clients/postgres.mjs), kafkaAdmin (local lag guard),
 *          statfs/exec/sleep; settings resolved with resolveSettings({ environment }) only.
 * Outputs: CleanupResult (plan §5.6) saved as results/<run>/cleanup-<stamp>.json or
 *          results/cleanup-<runId|all>-<stamp>/cleanup.json (not in print-sql mode).
 */
import fs from 'node:fs';
import path from 'node:path';
import { formatStamp } from '../core/format.mjs';
import { REPO_ROOT } from '../core/paths.mjs';
import { runIdEarliestStart, uuidV7Floor } from '../core/run-id.mjs';
import { candidatePhasePlan } from '../core/run-sql.mjs';
import {
  freeGbAt,
  measureDataStores,
  minFreeDiskGb,
  readSlots,
  settingValues,
  slotProblems,
} from '../preflight/probes.mjs';
import {
  dueTransitionsSql,
  guardAllowCleanup,
  guardDatabaseName,
  guardDisk,
  guardNotProd,
  guardProcessing,
  guardRunIdUnique,
  guardSlots,
} from './cleanup-guards.mjs';
import {
  CLEANUP_TABLES,
  NEVER_TOUCHED,
  SCHEMA_SQL,
  TEMP_INDEX_NAME,
  buildActivitySql,
  buildBatchDeleteSql,
  buildCountSql,
  buildRestageSql,
  buildSelectors,
  buildStageSql,
  buildVerifySql,
  scanNotes,
  schemaFromRows,
  tableInScope,
} from './cleanup-tables.mjs';

/** SQL of the temporary index steps (plan §7.2). */
export const INDEX_VALID_SQL = `SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('${TEMP_INDEX_NAME}')`;
export const CREATE_INDEX_SQL = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${TEMP_INDEX_NAME} ON step_instance (matched_event_id) WHERE matched_event_id IS NOT NULL`;
export const DROP_INDEX_SQL = `DROP INDEX CONCURRENTLY IF EXISTS ${TEMP_INDEX_NAME}`;
/** Batches of matcher_event_log rows when the temp index is not used (each row checks step_instance). */
export const NO_INDEX_BATCH_SIZE = 500;
/** Lock-timeout retries per batch before giving up with 'incomplete'. */
export const MAX_LOCK_RETRIES = 5;
/** Foreign-key recoveries (re-stage children, retry) per table before giving up with 'incomplete'. */
export const MAX_FK_RECOVERIES = 3;
/** Slots and disk are re-checked every this many batches. */
export const SAFETY_CHECK_EVERY = 10;

/** Settings that change what cleanup does; printed at start and saved in the cleanup JSON. */
export const CLEANUP_SETTING_NAMES = Object.freeze([
  'CLEANUP_LEGACY_V1',
  'CLEANUP_BATCH_SIZE',
  'CLEANUP_LOCK_TIMEOUT',
  'CLEANUP_PAUSE',
  'CLEANUP_MIN_SAFE_WAL_GB',
  'CLEANUP_TEMP_INDEX',
  'MIN_FREE_DISK_GB',
  'IDLE_FLAT_DURATION',
  'IDLE_TIMEOUT',
  'EVENT_SOURCE',
]);

/**
 * { NAME: { value, source } } of the cleanup settings.
 * Why: a cleanup JSON must say with which batch size, timeouts and limits it ran (owner rule: every
 * setting is printed at start and saved with the results).
 */
export function cleanupSettingsSnapshot(settings) {
  const values = settingValues(settings);
  const sources = settings?.sources ?? {};
  return Object.fromEntries(
    CLEANUP_SETTING_NAMES.map((name) => [
      name,
      { value: values[name] ?? null, source: sources[name] ?? 'default' },
    ]),
  );
}

/** Thrown inside the delete loop to stop with 'incomplete' (counts are kept). */
class StopCleanup extends Error {}

/**
 * Find a run's results folder by its run-context.json (newest when several).
 * Why: the folder holds the run start, event source and phase plan that make the scans index-friendly,
 * and it is where the cleanup JSON belongs. Aborted runs have no result.json, so run-context.json is used.
 */
export function findRunFolder(resultsRoot, runId) {
  if (!runId || !fs.existsSync(resultsRoot)) return null;
  const found = [];
  for (const entry of fs.readdirSync(resultsRoot, { withFileTypes: true })) {
    const file = path.join(resultsRoot, entry.name, 'run-context.json');
    if (!entry.isDirectory() || !fs.existsSync(file)) continue;
    try {
      const context = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (context.runId === runId)
        found.push({ dir: path.join(resultsRoot, entry.name), file, context });
    } catch {
      // unreadable context: not usable for bounds
    }
  }
  found.sort((a, b) => String(b.context.startedAt).localeCompare(String(a.context.startedAt)));
  return found[0] ?? null;
}

/**
 * Work out selectors, legacy mode and scan bounds of a cleanup scope.
 * Why: print-sql, dry-run and delete must use exactly the same plan.
 */
export function planScope({ scope, settings, resultsRoot, now = new Date() }) {
  const values = settingValues(settings);
  const all = scope.all === true;
  const runId = all ? null : scope.runId;
  const runFolder = all ? null : findRunFolder(resultsRoot, runId);
  const context = runFolder?.context ?? null;
  const legacySetting = String(values.CLEANUP_LEGACY_V1 ?? 'auto');
  // auto: v1 data has no id codes and random event ids. v1 run ids are exactly 10 digits (e.g.
  // 1103172520); a custom v2 id such as RUN_ID=baseline1 is NOT legacy. A 10-digit id whose run folder
  // has a v2 run-context.json (start time and id code) is a v2 run too, so it keeps its bounds.
  const v2Context = Boolean(context?.startedAt && context?.idCode);
  const legacyV1 =
    scope.legacyV1 === true ||
    legacySetting === 'true' ||
    (legacySetting === 'auto' && (all || (/^\d{10}$/.test(String(runId)) && !v2Context)));
  const selectors = buildSelectors({ runId, all, legacyV1 });
  // Without run-context.json (Dev/UAT: k6 ran on another host) the run id is the only clue, and it is
  // the run host's LOCAL clock in an unknown zone: take the earliest instant it can mean (wall clock as
  // UTC minus 14 h), so rows of a run made in a zone ahead of this machine are never below the floor.
  const contextStart = context?.startedAt ? new Date(context.startedAt) : null;
  const start = contextStart ?? (all ? null : runIdEarliestStart(runId));
  const startSource = contextStart ? 'run-context' : start ? 'run-id-earliest' : null;
  let bounds = null;
  if (start && !legacyV1 && !all) {
    const phases = context?.phasePlan?.phases;
    bounds = {
      floor: uuidV7Floor(new Date(start.getTime() - 5 * 60_000)),
      runStart: start.toISOString(),
      // 'run-context' = the run's own start; 'run-id-earliest' = guessed from the run id (see above).
      startSource,
      // The source the run really sent with: its own EVENT_SOURCE setting (it may have been overridden),
      // then the dataset's, then today's setting. Same order as the collector and matcher data checks.
      source:
        context?.settings?.EVENT_SOURCE || context?.dataset?.source || values.EVENT_SOURCE || null,
      // Candidate ids only when the run folder tells which subject and how many events per phase; with
      // the same margin as the data checks (k6 may start a few more iterations than planned).
      candidates:
        context?.idCode && Array.isArray(phases)
          ? {
              selector: `LOADTEST-${runId}-${context.idCode}-`,
              phases: candidatePhasePlan({
                phases: phases.map((p) => ({ plannedEvents: p.plannedEvents ?? 0 })),
              }).phases.map((p, i) => ({ phaseIndex: i, plannedEvents: p.plannedEvents })),
            }
          : null,
    };
  }
  return {
    runId,
    all,
    legacyV1,
    selectors,
    bounds,
    runFolder,
    activityFloor: all ? uuidV7Floor(new Date(now.getTime() - 3600_000)) : null,
    prefix: all ? 'LOADTEST-' : `LOADTEST-${runId}-`,
  };
}

/** Empty CleanupResult skeleton (plan §5.6). */
function newResult({ environment, mode, plan, startedAt, settings }) {
  return {
    schemaVersion: '1.0.0',
    kind: 'cce-cleanup',
    environment: environment?.name ?? null,
    mode,
    scope: {
      runId: plan.runId,
      all: plan.all,
      prefix: plan.prefix,
      selectors: plan.selectors,
      legacyV1: plan.legacyV1,
      runStartLowerBound: plan.bounds
        ? new Date(new Date(plan.bounds.runStart).getTime() - 5 * 60_000).toISOString()
        : null,
      // Where the lower bound came from: 'run-context' (exact) or 'run-id-earliest' (guessed from the
      // run id: its clock read as UTC minus 14 h, valid for a run made in any time zone); null = none.
      runStartSource: plan.bounds?.startSource ?? null,
      usedRunContext: plan.runFolder
        ? path.relative(REPO_ROOT, plan.runFolder.file).split(path.sep).join('/')
        : null,
    },
    startedAt: startedAt.toISOString(),
    endedAt: null,
    status: 'error',
    settings: cleanupSettingsSnapshot(settings),
    guards: [],
    disk: { before: null, after: null },
    wal: { before: null, after: null },
    tables: CLEANUP_TABLES.map((t) => ({
      order: t.order,
      table: t.table,
      selector: t.selector,
      exists: null,
      before: null,
      deleted: 0,
      after: null,
      afterBySnapshot: null,
      afterByPredicate: null,
      batches: 0,
      durationMs: 0,
      skippedReason: null,
    })),
    totals: { before: 0, deleted: 0, after: 0 },
    tempIndex: { used: false, created: false, dropped: false },
    analyzed: [],
    notes: [...scanNotes({ ...plan, schema: null }), `never touched: ${NEVER_TOUCHED.join(', ')}`],
  };
}

/** Write the JSON next to the run (or into its own folder). Why: before/after counts are evidence (R14). */
function saveResult(result, plan, resultsRoot, now) {
  const stamp = formatStamp(now);
  const file = plan.runFolder
    ? path.join(plan.runFolder.dir, `cleanup-${stamp}.json`)
    : path.join(resultsRoot, `cleanup-${plan.all ? 'all' : plan.runId}-${stamp}`, 'cleanup.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const doc = {
    $comment:
      'What: cleanup of load-test data with per-table before/deleted/after counts (plan §5.6). How: written by ' +
      'node tools/cli.mjs cleanup. Needs: nothing. Outputs: evidence that every staged row is gone (status verified).',
    ...result,
  };
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return file;
}

/** Totals over the tables. */
function computeTotals(result) {
  const sum = (key) => result.tables.reduce((n, t) => n + (Number(t[key]) || 0), 0);
  result.totals = { before: sum('before'), deleted: sum('deleted'), after: sum('after') };
}

/** Why: a statement-level helper that always returns rows (pg returns { rows }). */
function makeQuery(client) {
  return async (sql, params) => {
    const answer = await client.query(sql, params);
    return answer?.rows ?? [];
  };
}

/** Postgres lock_timeout error (SQLSTATE 55P03). */
const isLockTimeout = (error) =>
  error?.code === '55P03' || /lock timeout/i.test(String(error?.message));

/** Postgres foreign_key_violation (SQLSTATE 23503). */
const isForeignKeyViolation = (error) =>
  error?.code === '23503' || /violates foreign key constraint/i.test(String(error?.message));

/**
 * Run a cleanup.
 * @param {object} p
 * @param {object} p.environment loaded environment
 * @param {{runId?:string, all?:boolean, legacyV1?:boolean}} p.scope
 * @param {'delete'|'dry-run'|'print-sql'} p.mode
 * @param {object} p.settings resolveSettings({ environment }) result (or its values)
 * @param {object} p.clients { pgPool, withDedicatedClient?, kafkaAdmin?, statfs?, exec?, sleep? }
 * @param {(text:string) => Promise<boolean>} [p.confirm] typed-yes prompt (delete mode)
 */
export async function runCleanup({
  environment,
  scope,
  mode = 'delete',
  settings,
  clients = {},
  confirm = async () => false,
  resultsRoot = path.join(REPO_ROOT, 'results'),
  wait = false,
  now = () => new Date(),
}) {
  if (!['delete', 'dry-run', 'print-sql'].includes(mode))
    throw new Error(`Unknown cleanup mode ${mode}`);
  const values = settingValues(settings);
  const plan = planScope({ scope, settings, resultsRoot, now: now() });
  const result = newResult({ environment, mode, plan, startedAt: now(), settings });
  const sleep = clients.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const statfs = clients.statfs ?? ((p) => fs.promises.statfs(p));
  const exec = clients.exec ?? (await defaultExec());

  const finish = (status) => {
    result.status = status;
    result.endedAt = now().toISOString();
    computeTotals(result);
    if (mode !== 'print-sql') result.savedTo = saveResult(result, plan, resultsRoot, now());
    return result;
  };

  if (mode === 'print-sql') {
    result.notes.push('print-sql: nothing was executed');
    result.status = 'dry-run';
    result.endedAt = now().toISOString();
    return result;
  }

  // 1. Guards that need no connection.
  result.guards.push(
    guardNotProd(environment),
    guardAllowCleanup(environment),
    guardRunIdUnique(plan, resultsRoot),
  );
  if (result.guards.some((g) => g.status === 'fail')) return finish('refused');

  const withDedicatedClient =
    clients.withDedicatedClient ??
    (await import('../core/clients/postgres.mjs')).withDedicatedClient;
  try {
    return await withDedicatedClient(clients.pgPool, async (client) => {
      const query = makeQuery(client);
      const hardFail = () => result.guards.some((g) => g.status === 'fail');

      // 2. Guards on the database (same client: no second connection).
      result.guards.push(await guardDatabaseName(query, environment));
      // The wrong database is refused in every mode: not even a dry-run should stage there.
      if (result.guards.at(-1).status === 'fail') return finish('refused');
      const disk = await guardDisk({ environment, settings, resultsRoot, statfs, exec, query });
      result.guards.push(...disk.guards);
      result.disk.before = disk.disk;
      const slots = await guardSlots(query, settings);
      result.guards.push(slots.guard);
      result.wal.before = slots.wal;
      if (hardFail() && mode === 'delete') return finish('refused');

      // 3. Schema and staging. Dry-run stages inside a transaction it rolls back.
      const schema = schemaFromRows(await query(SCHEMA_SQL));
      const options = { ...plan, schema };
      result.notes = [...scanNotes(options), `never touched: ${NEVER_TOUCHED.join(', ')}`];
      let transactionOpen = false;
      if (mode === 'dry-run') {
        await query('BEGIN');
        transactionOpen = true;
      }
      try {
        for (const sql of buildStageSql(options)) await query(sql);

        // 4. "Still processing" guards, scoped to the staged rows of this run.
        result.guards.push(
          ...(await guardProcessing({
            query,
            environment,
            settings,
            options,
            kafkaAdmin: clients.kafkaAdmin,
            sleep,
            wait,
            now,
          })),
        );

        // 5. Before counts.
        const entries = CLEANUP_TABLES.map((entry, i) => ({
          entry,
          row: result.tables[i],
          ...tableInScope(entry, options),
        }));
        for (const e of entries) {
          e.row.exists = e.entry.optional ? schema.tables.has(e.entry.table) : true;
          if (!e.inScope) {
            e.row.skippedReason = e.reason;
            // Out of scope but present (facility without --all): nothing of it is ours to delete, so 0.
            if (e.row.exists)
              Object.assign(e.row, {
                before: 0,
                after: 0,
                afterBySnapshot: 0,
                afterByPredicate: 0,
              });
            continue;
          }
          e.row.before = Number((await query(buildCountSql(e.entry)))[0]?.n ?? 0);
        }
        computeTotals(result);

        if (mode === 'dry-run') {
          if (hardFail()) result.notes.push('a delete would be refused now: see the failed guards');
          await query('ROLLBACK');
          transactionOpen = false;
          return finish('dry-run');
        }
        if (hardFail()) return finish('refused');

        // 6. Typed confirmation.
        const yes = await confirm(
          `Delete ${result.totals.before.toLocaleString('en-US')} rows of ${plan.all ? 'ALL load-test data' : `run ${plan.runId}`} from ${environment.name}? Type yes: `,
        );
        result.guards.push(
          yes
            ? { id: 'confirmation', status: 'pass', detail: 'confirmed' }
            : {
                id: 'confirmation',
                status: 'fail',
                detail: 'not confirmed (type yes, or pass --yes)',
              },
        );
        if (!yes) return finish('refused');

        // 7. Delete, verify, one orphan round, verify again.
        const state = { batches: 0, stopped: null };
        const loop = {
          query,
          values,
          environment,
          settings,
          statfs,
          exec,
          sleep,
          resultsRoot,
          result,
          state,
          options,
          entries, // every table: the foreign-key recovery re-stages the children of the failing one
        };
        await deleteTables(
          entries.filter((e) => e.inScope),
          loop,
        );
        // Verification only reads, so it also runs after a stop: the JSON then shows what is left.
        await verifyTables(entries, options, query);
        if (!state.stopped) {
          const orphans = entries.filter((e) => e.inScope && Number(e.row.afterByPredicate) > 0);
          if (orphans.length) {
            result.notes.push(
              `orphan round: ${orphans.map((e) => `${e.entry.table} ${e.row.afterByPredicate}`).join(', ')} found after deleting; deleted once more`,
            );
            for (const e of orphans)
              for (const sql of buildRestageSql(e.entry, options)) await query(sql);
            await deleteTables(orphans, loop);
            await verifyTables(entries, options, query);
          }
        }

        // 8. ANALYZE what we touched; autovacuum follows.
        for (const e of entries) {
          if (e.inScope && e.row.deleted > 0) {
            await query(`ANALYZE ${e.entry.table}`);
            result.analyzed.push(e.entry.table);
          }
        }
        result.notes.push(
          'Expect autovacuum after a big delete; preflight warns until it finishes. Wait before the next test.',
        );
        const after = await guardDisk({ environment, settings, resultsRoot, statfs, exec, query });
        result.disk.after = after.disk;
        result.wal.after = await readSlots(query);
        if (state.stopped) {
          result.notes.push(state.stopped);
          return finish('incomplete');
        }
        const clean = entries.every((e) => !e.inScope || Number(e.row.after) === 0);
        return finish(clean ? 'verified' : 'incomplete');
      } finally {
        // Pooled connections keep TEMP tables after release: drop ours (delete mode; dry-run rolled back).
        if (transactionOpen) await query('ROLLBACK').catch(() => {});
        else if (mode === 'delete') await query('DISCARD TEMP').catch(() => {});
      }
    });
  } catch (error) {
    result.notes.push(`error: ${error.message}`);
    return finish('error');
  }
}

/** Default exec for `docker info` (disk of Docker's data root). */
async function defaultExec() {
  const { execFile } = await import('node:child_process');
  return (cmd, args) =>
    new Promise((resolve) => {
      execFile(cmd, args, { timeout: 15_000 }, (error, stdout, stderr) =>
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout,
          stderr,
        }),
      );
    });
}

/**
 * Every 10 batches: stop when a slot is unhealthy or the data-store disk runs low.
 * Why: lesson 8 — the slot was lost in the middle of one huge delete.
 */
async function safetyCheck(loop) {
  const { slots } = await readSlots(loop.query);
  const problems = slotProblems(slots, Number(loop.values.CLEANUP_MIN_SAFE_WAL_GB ?? 2));
  const limitGb = minFreeDiskGb(loop.settings, loop.environment);
  const stores = await measureDataStores({
    environment: loop.environment,
    exec: loop.exec,
    statfs: loop.statfs,
  });
  if (stores.dataStoresSource === 'docker-root' && stores.dataStoresFreeGb < limitGb) {
    problems.push(`only ${stores.dataStoresFreeGb} GB free at Docker root (limit ${limitGb} GB)`);
  }
  const results = await freeGbAt(loop.statfs, loop.resultsRoot);
  if (results.freeGb < limitGb)
    problems.push(`only ${results.freeGb} GB free for results (limit ${limitGb} GB)`);
  if (problems.length)
    throw new StopCleanup(`stopped after ${loop.state.batches} batches: ${problems.join('; ')}`);
}

/** One batch with lock-timeout retries. Returns { staged, deleted }. */
async function runBatch(statements, loop) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await loop.query(statements[0]); // BEGIN
      await loop.query(statements[1]); // SET LOCAL lock_timeout
      const [row] = await loop.query(statements[2]);
      await loop.query(statements[3]); // COMMIT
      return { staged: Number(row?.staged ?? 0), deleted: Number(row?.deleted ?? 0) };
    } catch (error) {
      await loop.query('ROLLBACK').catch(() => {});
      if (!isLockTimeout(error)) throw error;
      if (attempt >= MAX_LOCK_RETRIES)
        throw new StopCleanup(`lock timeout ${MAX_LOCK_RETRIES} times in a row: stopped`);
      await loop.sleep(Number(loop.values.CLEANUP_PAUSE ?? 0.2) * 1000);
    }
  }
}

/** Delete the staged rows of the given tables, in table order. */
async function deleteTables(entries, loop) {
  const { values, result, state } = loop;
  for (const e of entries) {
    if (state.stopped) return;
    const t0 = Date.now();
    let batchSize = Number(values.CLEANUP_BATCH_SIZE ?? 10000);
    // Set BEFORE trying to create: a CREATE INDEX CONCURRENTLY that fails half-way leaves an INVALID
    // index behind, and the finally below must drop that one too.
    let indexAttempted = false;
    try {
      if (
        e.entry.needsTempIndex &&
        Number(e.row.before) + Number(e.row.afterByPredicate ?? 0) > 0
      ) {
        indexAttempted = tempIndexAllowed(loop);
        const indexValid = indexAttempted ? await ensureTempIndex(loop) : false;
        if (!indexValid) batchSize = Math.min(batchSize, NO_INDEX_BATCH_SIZE);
      }
      for (;;) {
        let batch;
        try {
          batch = await runBatch(
            buildBatchDeleteSql(e.entry, {
              batchSize,
              lockTimeoutSeconds: Number(values.CLEANUP_LOCK_TIMEOUT ?? 5),
            }),
            loop,
          );
        } catch (error) {
          if (!isForeignKeyViolation(error)) throw error;
          await recoverForeignKey(e, error, loop); // throws StopCleanup when it keeps happening
          if (state.stopped) return;
          continue; // retry this table's batch
        }
        const { staged, deleted } = batch;
        if (staged === 0) break; // nothing staged any more for this table
        e.row.deleted += deleted;
        e.row.batches += 1;
        state.batches += 1;
        if (state.batches % SAFETY_CHECK_EVERY === 0) await safetyCheck(loop);
        await loop.sleep(Number(values.CLEANUP_PAUSE ?? 0.2) * 1000);
      }
    } catch (error) {
      if (!(error instanceof StopCleanup)) throw error;
      state.stopped = error.message;
    } finally {
      // The temporary index never outlives the matcher_event_log step (plan §7.2 step 3). No batch
      // transaction is open here (runBatch commits or rolls back), as CONCURRENTLY requires.
      if (indexAttempted) {
        await loop.query(DROP_INDEX_SQL);
        result.tempIndex.dropped = true;
      }
      e.row.durationMs += Date.now() - t0;
    }
  }
}

/**
 * A batch of table X failed with a foreign-key violation: rows referencing X's staged rows were written
 * AFTER staging (e.g. Step SLA judged an alarm that rang during the cleanup and recorded a deviation for a
 * step we are deleting; the deviation table was already done). Re-stage every in-scope table that comes
 * before X (its children) by its direct predicate — which reads the parents' snapshots, so new rows are
 * found — delete them, and let the caller retry X. At most MAX_FK_RECOVERIES times per table, then stop
 * with 'incomplete' (a service keeps writing: run cleanup again when it is idle).
 */
async function recoverForeignKey(e, error, loop) {
  e.fkRecoveries = (e.fkRecoveries ?? 0) + 1;
  const constraint = error?.constraint ? ` ${error.constraint}` : '';
  if (e.fkRecoveries > MAX_FK_RECOVERIES) {
    throw new StopCleanup(
      `${e.entry.table}: foreign-key violation${constraint} ${MAX_FK_RECOVERIES + 1} times: a service keeps ` +
        "writing rows that reference this run's data; stopped — run cleanup again when the services are idle",
    );
  }
  const children = loop.entries.filter((c) => c.inScope && c.entry.order < e.entry.order);
  loop.result.notes.push(
    `${e.entry.table}: foreign-key violation${constraint} — rows were written after staging (e.g. Step SLA ` +
      'deviations for alarms that rang during the cleanup); re-staged and deleted ' +
      `${children.map((c) => c.entry.table).join(', ') || 'no child table'}, then retried ` +
      `(${e.fkRecoveries}/${MAX_FK_RECOVERIES})`,
  );
  for (const c of children)
    for (const sql of buildRestageSql(c.entry, loop.options)) await loop.query(sql);
  await deleteTables(children, loop);
}

/**
 * Whether the temporary index may be used: CLEANUP_TEMP_INDEX (auto/always/never) and safety.allowTempIndex.
 * Why: creating an index on a shared database is a change a DBA must agree to (open question Q5).
 */
function tempIndexAllowed(loop) {
  const { values, environment, result } = loop;
  const setting = String(values.CLEANUP_TEMP_INDEX ?? 'auto');
  if (setting === 'never') return false;
  if (environment?.safety?.allowTempIndex !== true) {
    if (setting === 'always')
      result.notes.push(
        'CLEANUP_TEMP_INDEX=always but safety.allowTempIndex is false: small batches used instead',
      );
    return false;
  }
  return true;
}

/**
 * Create the temporary step_instance(matched_event_id) index (no transaction is open here).
 * Returns true when a VALID index is in place.
 */
async function ensureTempIndex(loop) {
  const { result, query } = loop;
  result.tempIndex.used = true;
  // An INVALID leftover (interrupted earlier run) would be kept by IF NOT EXISTS: drop it first.
  const before = await query(INDEX_VALID_SQL);
  if (before.length && before[0].indisvalid === false) {
    await query(DROP_INDEX_SQL);
    result.notes.push(`dropped an INVALID leftover index ${TEMP_INDEX_NAME}`);
  }
  await query(CREATE_INDEX_SQL);
  result.tempIndex.created = true;
  const after = await query(INDEX_VALID_SQL);
  if (!after.length || after[0].indisvalid !== true) {
    await query(DROP_INDEX_SQL);
    result.tempIndex.dropped = true;
    result.notes.push(
      `temporary index ${TEMP_INDEX_NAME} was not valid: dropped, using batches of ${NO_INDEX_BATCH_SIZE}`,
    );
    return false;
  }
  return true;
}

/** Verify every in-scope table by snapshot and by direct predicate. */
async function verifyTables(entries, options, query) {
  for (const e of entries) {
    if (!e.inScope) continue;
    const { snapshotSql, predicateSql } = buildVerifySql(e.entry, options);
    e.row.afterBySnapshot = Number((await query(snapshotSql))[0]?.n ?? 0);
    e.row.afterByPredicate = Number((await query(predicateSql))[0]?.n ?? 0);
    e.row.after = e.row.afterBySnapshot + e.row.afterByPredicate;
  }
}

/**
 * Every statement cleanup would run, as text, without connecting (mode print-sql).
 * Why: lets a DBA review the plan for a shared environment before anything runs (R14 acceptance).
 */
export function printCleanupSql({
  environment,
  scope,
  settings,
  resultsRoot = path.join(REPO_ROOT, 'results'),
  now = new Date(),
}) {
  const values = settingValues(settings);
  const plan = planScope({ scope, settings, resultsRoot, now });
  const options = { ...plan, schema: null }; // null schema: show optional statements, marked
  const lines = [];
  const section = (title) => lines.push('', `-- ===== ${title} =====`);
  const add = (sql) => lines.push(`${sql.trim()};`);
  lines.push(
    `-- Cleanup plan for ${environment?.name} (${environment?.kind}), ${plan.all ? 'ALL load-test data' : `run ${plan.runId}`}`,
    `-- Selectors: ${plan.selectors.join(', ')}${plan.legacyV1 ? '  (legacy v1 branch ON)' : ''}`,
    `-- Run start${plan.bounds?.startSource === 'run-id-earliest' ? ' (earliest the run id can mean in any time zone)' : ''}: ${plan.bounds?.runStart ?? 'unknown'}; run-context.json: ${plan.runFolder ? plan.runFolder.file : 'not found'}`,
    ...scanNotes(options).map((n) => `-- NOTE: ${n}`),
    `-- Never touched: ${NEVER_TOUCHED.join(', ')}`,
    '-- All statements run on ONE dedicated connection.',
  );
  section('Schema detection');
  add(SCHEMA_SQL);
  section('Guards');
  add('SELECT current_database() AS database');
  add(readSlotsSqlForPrint());
  section('Stage (TEMP tables with primary keys, snapshots, ANALYZE)');
  for (const sql of buildStageSql(options)) add(sql);
  section('Guard: still processing (scoped to the staged steps)');
  add(dueTransitionsSql(values.IDLE_TIMEOUT ?? 300));
  if (environment?.kind === 'local') {
    lines.push(
      '-- local: the matcher consumer-group lag must be 0 (read with the Kafka admin client, not SQL)',
    );
  } else {
    // dev/uat: real traffic keeps the lag above 0, so this run's own rows must stop growing instead.
    lines.push(
      `-- ${environment?.kind}: run twice, IDLE_FLAT_DURATION (${values.IDLE_FLAT_DURATION} s) apart; the counts must not grow`,
    );
    add(buildActivitySql(options, { now, uuidFloorOfLastHour: plan.activityFloor }));
  }
  section('Before counts');
  for (const entry of CLEANUP_TABLES) {
    const { inScope, reason } = tableInScope(entry, options);
    lines.push(`-- ${entry.order} ${entry.table}${inScope ? '' : `: skipped (${reason})`}`);
    if (inScope) add(buildCountSql(entry));
  }
  section(
    `Batched deletes (CLEANUP_BATCH_SIZE ${values.CLEANUP_BATCH_SIZE}, lock_timeout ${values.CLEANUP_LOCK_TIMEOUT} s, pause ${values.CLEANUP_PAUSE} s; slots + disk every ${SAFETY_CHECK_EVERY} batches)`,
  );
  for (const entry of CLEANUP_TABLES) {
    const { inScope, reason } = tableInScope(entry, options);
    lines.push(
      `-- ${entry.order} ${entry.table}${inScope ? ' (repeat until staged = 0)' : `: skipped (${reason})`}`,
    );
    if (!inScope) continue;
    if (entry.needsTempIndex) {
      lines.push(
        `-- temporary index (CLEANUP_TEMP_INDEX=${values.CLEANUP_TEMP_INDEX}, safety.allowTempIndex=${environment?.safety?.allowTempIndex === true}); no transaction open`,
      );
      add(INDEX_VALID_SQL);
      lines.push('-- if indisvalid = false (leftover of an interrupted run):');
      add(DROP_INDEX_SQL);
      add(CREATE_INDEX_SQL);
      add(INDEX_VALID_SQL);
    }
    for (const sql of buildBatchDeleteSql(entry, {
      batchSize: Number(values.CLEANUP_BATCH_SIZE ?? 10000),
      lockTimeoutSeconds: Number(values.CLEANUP_LOCK_TIMEOUT ?? 5),
    }))
      add(sql);
    if (entry.needsTempIndex) {
      lines.push('-- always, in finally:');
      add(DROP_INDEX_SQL);
    }
  }
  section(
    'Verify (after = afterBySnapshot + afterByPredicate; verified only when every after is 0)',
  );
  for (const entry of CLEANUP_TABLES) {
    const { inScope, reason } = tableInScope(entry, options);
    lines.push(`-- ${entry.order} ${entry.table}${inScope ? '' : `: skipped (${reason})`}`);
    if (!inScope) continue;
    const { snapshotSql, predicateSql } = buildVerifySql(entry, options);
    add(snapshotSql);
    add(predicateSql);
  }
  section('Orphan round (only for tables whose predicate still finds rows), then verify once more');
  lines.push(
    '-- per table: INSERT INTO lt_<x> … SELECT … WHERE <predicate> ON CONFLICT DO NOTHING; then the batched delete above',
  );
  section('Afterwards');
  lines.push('-- ANALYZE <each table with deleted rows>;', '-- DISCARD TEMP;');
  return `${lines.join('\n').trim()}\n`;
}

/** Why: the printed plan shows the slot query exactly as readSlots runs it. */
function readSlotsSqlForPrint() {
  return 'SELECT slot_name, active, wal_status, safe_wal_size, pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS lag_bytes FROM pg_replication_slots ORDER BY slot_name';
}

/** The printed table: order · table · before · deleted · after. */
export function formatCleanupTable(result) {
  const fmt = (v) => (v === null || v === undefined ? '–' : Number(v).toLocaleString('en-US'));
  const lines = [
    `Cleanup ${result.environment} ${result.scope.all ? 'ALL' : result.scope.runId} (${result.mode}): ${result.status}`,
  ];
  lines.push('  order  table                              before     deleted       after');
  for (const t of result.tables) {
    const after = t.skippedReason ? `skipped: ${t.skippedReason}` : fmt(t.after);
    lines.push(
      `  ${String(t.order).padStart(5)}  ${t.table.padEnd(32)} ${fmt(t.before).padStart(9)} ${fmt(t.deleted).padStart(11)} ${String(after).padStart(11)}`,
    );
  }
  lines.push(
    `  total  ${''.padEnd(32)} ${fmt(result.totals.before).padStart(9)} ${fmt(result.totals.deleted).padStart(11)} ${fmt(result.totals.after).padStart(11)}`,
  );
  for (const g of result.guards.filter((x) => x.status === 'fail'))
    lines.push(`  ✖ guard ${g.id}: ${g.detail}`);
  for (const n of result.notes) lines.push(`  note: ${n}`);
  return lines.join('\n');
}
